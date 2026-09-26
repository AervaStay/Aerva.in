// /api/_compliance.js
// Shared registry of compliance requirements — not an API endpoint
// itself (the leading underscore is what tells Vercel that, same
// convention as _audit-log.js, _rate-limit.js, etc.).
//
// Adding a FUTURE requirement (the whole point of building this as a
// registry instead of a one-off feature) means adding one new entry
// here — a message, a deadline, and a query for which listings don't
// meet it — not building a new bespoke flagging/blocking feature each
// time something is realized to be missing after listings already exist.
//
// Used by get-pending-listings.js (admin-triggered scan, and the cron-
// callable enforcement that blocks anything past its deadline) AND by
// update-listing-pricing.js (checks whether a host's save just resolved
// an outstanding flag on their own listing, restoring it if it was
// auto-blocked).

// 15 days from being flagged. Past that the listing is deactivated
// automatically by the daily job (see enforceComplianceDeadlines below),
// not by anybody remembering to press something.
const COMPLIANCE_DEADLINE_DAYS = 15;

const COMPLIANCE_CHECKS = {
  max_guests_required: {
    label: 'Max Guests is missing',
    message: 'Please set a valid "Max Guests" value for this listing from Manage listing — this is now required for every non-Resort stay.',
    deadlineDays: COMPLIANCE_DEADLINE_DAYS,
    // Finds every listing across the platform currently failing this
    // requirement — used by the admin-triggered scan.
    findAffectedListingIds: async (sql) => {
      const rows = await sql`
        SELECT id FROM listings
        WHERE status = 'approved' AND listing_type = 'stay' AND property_type != 'Resort'
          -- A CASE, so the ::int cast only ever sees digits ("12+" counts as 12).
          AND (CASE WHEN trim(COALESCE(max_guests::text, '')) ~ '^[0-9]{1,6}[+]?$'
                    THEN rtrim(trim(max_guests::text), '+')::int <= 0
                    ELSE true END)
      `;
      return rows.map(r => r.id);
    },
    // Checks whether ONE specific listing (already known, with its
    // current field values in hand) now satisfies the requirement — used
    // right after a host saves, to decide whether to auto-resolve their
    // own flag without a second database round-trip.
    isSatisfied: (listing) => {
      const raw = listing.max_guests;
      if (raw === null || raw === undefined) return false;
      const trimmed = String(raw).trim();
      // "12+" is the listing form's top option and counts as valid.
      return /^[0-9]+\+?$/.test(trimmed) && Number(trimmed.replace(/\+$/, '')) > 0;
    }
  }
};

// Called after a host's save succeeds — resolves any open flags on THIS
// listing whose requirement is now actually met, and restores the
// listing to its pre-block status if every flag that had caused an auto-
// block is now cleared. Never throws: a failure here shouldn't fail the
// save itself, since the save already genuinely succeeded.
async function resolveSatisfiedComplianceFlags(sql, listingId, updatedListingFields) {
  try {
    const openFlags = await sql`
      SELECT id, requirement_key FROM compliance_flags
      WHERE listing_id = ${listingId} AND resolved_at IS NULL
    `;
    if (!openFlags.length) return;

    let anyResolved = false;
    for (const flag of openFlags) {
      const check = COMPLIANCE_CHECKS[flag.requirement_key];
      if (check && check.isSatisfied(updatedListingFields)) {
        await sql`UPDATE compliance_flags SET resolved_at = now() WHERE id = ${flag.id}`;
        anyResolved = true;
      }
    }
    if (!anyResolved) return;

    // Only restores if EVERY open flag is now clear — a listing with two
    // separate outstanding requirements shouldn't come back live just
    // because one of them was fixed.
    const stillOpen = await sql`SELECT id FROM compliance_flags WHERE listing_id = ${listingId} AND resolved_at IS NULL`;
    if (stillOpen.length > 0) return;

    const rows = await sql`SELECT status, status_before_compliance_block FROM listings WHERE id = ${listingId}`;
    const listing = rows[0];
    if (listing && listing.status === 'blocked' && listing.status_before_compliance_block) {
      await sql`
        UPDATE listings SET status = ${listing.status_before_compliance_block}, status_before_compliance_block = NULL, admin_status_reason = NULL
        WHERE id = ${listingId}
      `;
    }
  } catch (err) {
    console.error('resolveSatisfiedComplianceFlags failed (non-fatal):', err);
  }
}

// Is this listing already carrying an unresolved flag for this
// requirement? Checked in code rather than relying on ON CONFLICT DO
// NOTHING, which quietly does nothing at all unless a matching unique
// index exists — and where it does not, re-running a scan flags the same
// listing again and again.
async function hasOpenFlag(sql, listingId, requirementKey) {
  const rows = await sql`
    SELECT id FROM compliance_flags
    WHERE listing_id = ${listingId} AND requirement_key = ${requirementKey} AND resolved_at IS NULL
    LIMIT 1
  `;
  return rows.length > 0;
}

// Every unresolved flag on a host's own listings, for the dashboard
// notice and the warning on their earnings page. Never throws: a notice
// failing to load must not take a page down with it.
async function openFlagsForHost(sql, hostId, makeManageLink) {
  try {
    const rows = await sql`
      SELECT cf.id, cf.listing_id, cf.requirement_key, cf.message, cf.deadline, cf.auto_blocked,
             l.property_name, l.status AS listing_status
      FROM compliance_flags cf
      JOIN listings l ON l.id = cf.listing_id
      WHERE l.host_id = ${hostId} AND cf.resolved_at IS NULL
      ORDER BY cf.deadline ASC
    `;
    return rows.map(r => ({
      id: r.id,
      listingId: r.listing_id,
      // manage-listing.html authenticates with a signed token, not a
      // listing id — a link built from the id opens a page that cannot do
      // anything, which is exactly what "Fix this now" did.
      manageLink: typeof makeManageLink === 'function' ? makeManageLink(r.listing_id) : null,
      propertyName: r.property_name,
      listingStatus: r.listing_status,
      requirementKey: r.requirement_key,
      label: (COMPLIANCE_CHECKS[r.requirement_key] || {}).label || 'Action needed',
      message: r.message,
      deadline: r.deadline,
      autoBlocked: !!r.auto_blocked,
      daysLeft: Math.ceil((new Date(r.deadline).getTime() - Date.now()) / 86400000)
    }));
  } catch (err) {
    console.error('openFlagsForHost failed (non-fatal):', err);
    return [];
  }
}

// One email per newly flagged listing, telling the host what to fix and
// by when. Never throws: the flag is already recorded, and an email
// failure must not undo it or fail the scan.
async function emailHostAboutFlag(listing, check, deadline) {
  try {
    if (!process.env.RESEND_API_KEY) {
      console.error('RESEND_API_KEY not set — host will not be told about this compliance flag.');
      return false;
    }
    if (!listing.host_email) return false;
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const due = new Date(deadline).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const html = `
      <div style="font-family:sans-serif; max-width:520px;">
        <h2 style="font-family:Georgia,serif;">Action needed on ${esc(listing.property_name)}</h2>
        <p>${esc(check.message)}</p>
        <p><strong>Please do this by ${esc(due)}.</strong> If it is still outstanding after that, the listing is taken off Aerva automatically until it is fixed. Bookings already confirmed are not affected.</p>
        <p><a href="https://aerva.in/host-dashboard.html" style="color:#8a6c39;">Open your dashboard</a></p>
        <p style="font-size:12px; opacity:0.6; margin-top:24px;">Questions? Reply to this email or write to hello@aerva.in.</p>
      </div>`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Aerva <hello@aerva.in>', to: listing.host_email,
        subject: `Action needed on ${listing.property_name} by ${due}`, html
      })
    });
    if (!res.ok) { console.error('compliance email failed:', res.status); return false; }
    return true;
  } catch (err) {
    console.error('compliance email failed (non-fatal):', err);
    return false;
  }
}

// Scans one requirement across every live listing and flags whatever
// fails it, emailing each host once. Shared by the daily job and the
// admin's own button, so a scan behaves identically however it starts.
// Returns { affected, flagged, emailed }.
async function runComplianceScan(sql, key) {
  const check = COMPLIANCE_CHECKS[key];
  if (!check) throw new Error(`Unknown compliance requirement: ${key}`);
  const result = { key, affected: 0, flagged: 0, emailed: 0 };
  const affectedIds = await check.findAffectedListingIds(sql);
  result.affected = affectedIds.length;
  for (const listingId of affectedIds) {
    // Already flagged and unresolved: leave it alone. This is what stops
    // a daily scan raising the same flag, and mailing the same host,
    // every morning until they fix it.
    if (await hasOpenFlag(sql, listingId, key)) continue;
    const inserted = await sql`
      INSERT INTO compliance_flags (listing_id, requirement_key, message, deadline)
      VALUES (${listingId}, ${key}, ${check.message}, now() + (${check.deadlineDays}::int || ' days')::interval)
      RETURNING id, deadline
    `;
    if (!inserted[0]) continue;
    result.flagged++;
    const lr = await sql`SELECT property_name, host_email FROM listings WHERE id = ${listingId}`;
    if (lr[0] && await emailHostAboutFlag(lr[0], check, inserted[0].deadline)) result.emailed++;
  }
  return result;
}

// Every requirement, scanned in turn. What the daily job runs.
async function runAllComplianceScans(sql) {
  const out = [];
  for (const key of Object.keys(COMPLIANCE_CHECKS)) {
    try {
      out.push(await runComplianceScan(sql, key));
    } catch (err) {
      console.error('compliance scan failed for', key, err);
      out.push({ key, error: true });
    }
  }
  return out;
}

// Deactivates every listing whose deadline has passed with the
// requirement still unmet. Shared by the daily job in get-listings.js and
// the admin's own button, so a deadline is enforced the same way however
// it is triggered. Only ever touches a listing that is still live, and
// records what it was so it can be restored when the host fixes it (see
// resolveSatisfiedComplianceFlags above).
async function enforceComplianceDeadlines(sql, logAudit) {
  const result = { checked: 0, blocked: 0 };
  const overdue = await sql`
    SELECT cf.id AS flag_id, cf.listing_id, cf.message, l.status AS current_status, l.property_name, l.host_email
    FROM compliance_flags cf
    JOIN listings l ON l.id = cf.listing_id
    WHERE cf.resolved_at IS NULL AND cf.deadline < now() AND cf.auto_blocked = FALSE
  `;
  result.checked = overdue.length;
  for (const row of overdue) {
    if (row.current_status === 'approved') {
      await sql`
        UPDATE listings SET status = 'blocked', admin_status_reason = ${row.message}, status_before_compliance_block = ${row.current_status}
        WHERE id = ${row.listing_id}
      `;
      result.blocked++;
    }
    await sql`UPDATE compliance_flags SET auto_blocked = TRUE WHERE id = ${row.flag_id}`;
    if (logAudit) {
      await logAudit(sql, {
        action: 'compliance_deadline_enforced', success: true, actorType: 'system', actorIdentifier: null,
        targetType: 'listing', targetId: row.listing_id,
        metadata: { flagId: row.flag_id, wasBlocked: row.current_status === 'approved' }
      });
    }
  }
  return result;
}

module.exports = {
  COMPLIANCE_CHECKS, COMPLIANCE_DEADLINE_DAYS, resolveSatisfiedComplianceFlags,
  hasOpenFlag, openFlagsForHost, emailHostAboutFlag, enforceComplianceDeadlines,
  runComplianceScan, runAllComplianceScans
};
