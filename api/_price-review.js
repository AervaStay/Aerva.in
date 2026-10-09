// /api/_price-review.js — unusual price changes wait for Aerva's approval.
// Not an endpoint.
//
// A host (or co-host) changes prices on a live listing freely. Only an
// UNUSUAL change is held back: the old price stays what guests see and
// book at, the new one waits in Admin → Approvals → Price changes, and a
// reviewer or admin approves (it goes live at once) or rejects (the host
// is told why). Unusual means:
//   • the base price drops by more than RULES.maxDropPct of the live price,
//   • or falls below the floor (RULES.minStay a night / RULES.minExperience
//     for an experience),
//   • or a discount or promotion takes off more than RULES.maxDiscountPct
//     (a flat amount counts as its share of the base price).
// Raising a price, and any change that is not unusual, is never held.
// Resort room prices are not checked here: every change to a live room
// already waits for review (listing_rooms.pending_changes).
//
// Before the database update 2026-10-09-01-price-reviews.sql is applied,
// nothing is held (the table does not exist) and saves work as before.

const { logAudit } = require('./_audit-log');

const RULES = {
  maxDropPct: 50,        // a drop of more than half
  minStay: 500,          // ₹ a night
  minExperience: 100,    // ₹ per person (or flat)
  maxDiscountPct: 50     // a discount or promotion above half
};

const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Why a base price change is unusual, or null. Only drops are checked.
function rateReason({ oldRate, newRate, isExperience }) {
  const o = Number(oldRate) || 0, n = Number(newRate) || 0;
  if (!(n > 0) || !(o > 0) || n >= o) return null;
  const floor = isExperience ? RULES.minExperience : RULES.minStay;
  if (n < floor) return `${inr(n)} is below the ${inr(floor)} minimum${isExperience ? '' : ' a night'}`;
  const dropPct = Math.round((1 - n / o) * 100);
  if (dropPct > RULES.maxDropPct) return `a ${dropPct}% drop (from ${inr(o)})`;
  return null;
}

// Why a discount is unusual, or null. type 'percentage' | 'flat'.
function discountReason({ type, value, baseRate }) {
  const v = Number(value) || 0;
  if (!(v > 0)) return null;
  const pct = type === 'percentage' ? v : (Number(baseRate) > 0 ? Math.round(v / Number(baseRate) * 100) : 0);
  if (pct > RULES.maxDiscountPct) return type === 'percentage' ? `${v}% off` : `${inr(v)} off is ${pct}% of the ${inr(baseRate)} price`;
  return null;
}

function describe(kind, v) {
  if (!v) return '—';
  if (kind === 'rate') return inr(v.rate) + (v.unit === 'per_person' ? ' per person' : v.unit === 'flat' ? ' flat' : v.isExperience ? '' : ' a night');
  if (kind === 'discount') return v.type ? `${v.type === 'percentage' ? v.value + '%' : inr(v.value)} off${v.minNights ? ` for ${v.minNights}+ nights` : ''}` : 'No discount';
  if (kind === 'promotion') return `“${v.name}” — ${v.discountType === 'percentage' ? v.discountValue + '%' : inr(v.discountValue)} off, ${v.startDate} to ${v.endDate}`;
  return '';
}

async function sendMail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html })
    });
  } catch (err) { console.error('price review email failed:', err.message); }
}

const SITE = 'https://aerva.in';
const ADMIN_PAGE = `${SITE}/admin-e75a6e8cd0cf8f34bc57cf65.html`;

// Holds a change. Returns the review row, or null when it could not be held
// (table missing) — the caller then saves the change as before.
async function hold(sql, { listingId, listingName, kind, oldValue, newValue, reason, requestedBy, actorType, promotionId = null }) {
  try {
    // A newer request for the same thing replaces the waiting one.
    if (kind === 'rate' || kind === 'discount') {
      await sql`UPDATE price_reviews SET status = 'superseded', reviewed_at = now() WHERE listing_id = ${listingId} AND kind = ${kind} AND status = 'pending'`;
    } else if (promotionId) {
      await sql`UPDATE price_reviews SET status = 'superseded', reviewed_at = now() WHERE listing_id = ${listingId} AND kind = 'promotion' AND status = 'pending' AND (new_value->>'promotionId')::int = ${promotionId}`;
    }
    const row = (await sql`
      INSERT INTO price_reviews (listing_id, kind, old_value, new_value, reason, requested_by, requested_by_type)
      VALUES (${listingId}, ${kind}, ${oldValue ? JSON.stringify(oldValue) : null}::jsonb, ${JSON.stringify(newValue)}::jsonb, ${reason}, ${requestedBy || null}, ${actorType || 'host'})
      RETURNING *`)[0];
    await logAudit(sql, { action: 'price_change_held', success: true, actorType: actorType === 'cohost' ? 'host' : (actorType || 'host'), actorIdentifier: requestedBy || null,
      targetType: 'listing', targetId: listingId, metadata: { reviewId: row.id, kind, reason } });
    await sendMail(process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in', `Price change to approve: ${String(listingName || 'listing #' + listingId).slice(0, 80)}`,
      `<div style="font-family:sans-serif; max-width:560px;">
        <h2 style="font-family:Georgia,serif;">Price change waiting for approval</h2>
        <p><strong>${esc(listingName)}</strong> (listing #${Number(listingId)}) — changed by ${esc(actorType || 'host')} ${esc(requestedBy || '')}.</p>
        <p>Now: ${esc(describe(kind, oldValue))}<br>Asked for: <strong>${esc(describe(kind, newValue))}</strong></p>
        <p>Held because: ${esc(reason)}. Guests keep seeing the current price until it is approved.</p>
        <p><a href="${ADMIN_PAGE}" style="background:#1c1a17; color:#f4eadc; padding:10px 20px; text-decoration:none;">Review in Admin → Approvals</a></p>
      </div>`);
    return row;
  } catch (err) {
    console.error('price change not held (apply 2026-10-09-01-price-reviews.sql):', err.message);
    return null;
  }
}

// One line for the host after a save.
function heldMessage(kind, newValue, reason) {
  return `Your new ${kind === 'rate' ? 'price' : kind === 'discount' ? 'discount' : 'promotion'} (${describe(kind, newValue)}) is waiting for Aerva's approval because it is ${reason}. Guests see the current one until then — usually within a day.`;
}

async function pendingFor(sql, listingId) {
  try {
    const rows = await sql`SELECT id, kind, new_value, reason, requested_at FROM price_reviews WHERE listing_id = ${listingId} AND status = 'pending' ORDER BY id`;
    return rows.map(r => ({ id: r.id, kind: r.kind, reason: r.reason, requestedAt: r.requested_at, text: describe(r.kind, r.new_value) }));
  } catch (err) { return []; }
}

async function list(sql, { status = 'pending' } = {}) {
  const rows = status === 'all'
    ? await sql`SELECT p.*, l.property_name, l.host_email, l.listing_type, l.nightly_rate AS live_rate FROM price_reviews p JOIN listings l ON l.id = p.listing_id ORDER BY p.id DESC LIMIT 200`
    : status === 'done'
      ? await sql`SELECT p.*, l.property_name, l.host_email, l.listing_type, l.nightly_rate AS live_rate FROM price_reviews p JOIN listings l ON l.id = p.listing_id WHERE p.status IN ('approved', 'rejected') ORDER BY p.reviewed_at DESC NULLS LAST LIMIT 200`
      : await sql`SELECT p.*, l.property_name, l.host_email, l.listing_type, l.nightly_rate AS live_rate FROM price_reviews p JOIN listings l ON l.id = p.listing_id WHERE p.status = 'pending' ORDER BY p.id`;
  return rows.map(r => ({ ...r, oldText: describe(r.kind, r.old_value), newText: describe(r.kind, r.new_value),
    kindLabel: { rate: 'Price', discount: 'Discount', promotion: 'Promotion' }[r.kind] || r.kind }));
}

const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });

// Approve (goes live at once) or reject (note required; the host is told).
async function decide(sql, { id, approve, note, admin, audit }) {
  const why = String(note || '').trim().slice(0, 500);
  if (!approve && why.length < 5) throw userError('Say why it is rejected — the host is told.');
  const claim = await sql`UPDATE price_reviews SET status = ${approve ? 'approved' : 'rejected'}, reviewed_by = ${admin.email}, reviewed_at = now(), review_note = ${why || null}
                          WHERE id = ${Number(id) || 0} AND status = 'pending' RETURNING *`;
  if (!claim.length) throw userError('This change has already been decided, or the host replaced it.', 409);
  const r = claim[0];
  const v = r.new_value || {};
  const listing = (await sql`SELECT id, property_name, host_email FROM listings WHERE id = ${r.listing_id}`)[0] || {};
  if (approve) {
    try {
      if (r.kind === 'rate') {
        await sql`UPDATE listings SET nightly_rate = ${Number(v.rate)} WHERE id = ${r.listing_id}`;
        await sql`INSERT INTO price_history (listing_id, nightly_rate) VALUES (${r.listing_id}, ${Number(v.rate)})`;
      } else if (r.kind === 'discount') {
        await sql`UPDATE listings SET discount_type = ${v.type || null}, discount_value = ${v.value ? Number(v.value) : null}::numeric,
                    discount_min_nights = ${v.minNights ? Number(v.minNights) : null}::int, discount_description = ${v.description || null} WHERE id = ${r.listing_id}`;
      } else if (r.kind === 'promotion') {
        const upd = v.promotionId ? await sql`
          UPDATE listing_promotions SET name = ${v.name}, discount_type = ${v.discountType}, discount_value = ${Number(v.discountValue)},
            min_nights = ${v.minNights || null}, start_date = ${v.startDate}, end_date = ${v.endDate}, is_active = ${v.isActive !== false}
          WHERE id = ${Number(v.promotionId)} AND listing_id = ${r.listing_id} RETURNING id` : [];
        if (!upd.length) {
          await sql`INSERT INTO listing_promotions (listing_id, room_id, name, discount_type, discount_value, min_nights, start_date, end_date, is_active)
                    VALUES (${r.listing_id}, ${v.roomId || null}, ${v.name}, ${v.discountType}, ${Number(v.discountValue)}, ${v.minNights || null}, ${v.startDate}, ${v.endDate}, ${v.isActive !== false})`;
        }
      }
    } catch (err) {
      await sql`UPDATE price_reviews SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL WHERE id = ${r.id}`;
      throw err;
    }
  }
  await logAudit(sql, { action: approve ? 'price_change_approved' : 'price_change_rejected', success: true, actorType: 'admin', ...audit,
    targetType: 'listing', targetId: r.listing_id, metadata: { reviewId: r.id, kind: r.kind, note: why || null } });
  await sendMail(listing.host_email, approve ? `Your price change is live — ${String(listing.property_name || '').slice(0, 60)}` : `Your price change was not approved — ${String(listing.property_name || '').slice(0, 60)}`,
    `<div style="font-family:sans-serif; max-width:560px;">
      <p>${approve
        ? `Your change to <strong>${esc(listing.property_name)}</strong> is approved and live: ${esc(describe(r.kind, v))}.`
        : `Your change to <strong>${esc(listing.property_name)}</strong> (${esc(describe(r.kind, v))}) was not approved, so guests still see ${esc(describe(r.kind, r.old_value))}.`}</p>
      ${!approve ? `<p>Reason: ${esc(why)}</p><p>Reply to this email if you have questions.</p>` : ''}
    </div>`);
  return { status: approve ? 'approved' : 'rejected' };
}

async function pendingCount(sql) {
  try { return (await sql`SELECT count(*)::int AS n FROM price_reviews WHERE status = 'pending'`)[0].n; } catch (e) { return 0; }
}

module.exports = { RULES, rateReason, discountReason, describe, hold, heldMessage, pendingFor, list, decide, pendingCount };
