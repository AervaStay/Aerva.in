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

const COMPLIANCE_CHECKS = {
  max_guests_required: {
    message: 'Please set a valid "Max Guests" value for this listing from Manage Price & Offers — this is now required for every non-Resort stay.',
    deadlineDays: 14,
    // Finds every listing across the platform currently failing this
    // requirement — used by the admin-triggered scan.
    findAffectedListingIds: async (sql) => {
      const rows = await sql`
        SELECT id FROM listings
        WHERE status = 'approved' AND listing_type = 'stay' AND property_type != 'Resort'
          AND (max_guests IS NULL OR trim(max_guests::text) = '' OR trim(max_guests::text) !~ '^[0-9]+$' OR trim(max_guests::text)::int <= 0)
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
      return /^[0-9]+$/.test(trimmed) && Number(trimmed) > 0;
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

module.exports = { COMPLIANCE_CHECKS, resolveSatisfiedComplianceFlags };
