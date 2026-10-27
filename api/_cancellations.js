// /api/_cancellations.js — guest cancellations under the listing's refund
// policy, and helpers shared with host cancellations. Not an endpoint.
//
// REFUND POLICIES (days are counted to check-in day, on the property's own
// calendar; day 0 is check-in day):
//   Flexible: 30+ days 100% · 10–29 days 80% · 5–9 days 50% · 2–4 days 30%
//             · 0–1 days the host chooses 0–100%
//   Firm:     30+ days 100% · 5–29 days 50% · 0–4 days the host chooses 0–100%
//   Declining a "host chooses" request means 0% (no refund).
// Each booking keeps the policy it was paid under (orders.cancellation_policy);
// a host changing policy later never changes an existing booking.
//
// WHAT THE PERCENTAGE APPLIES TO, in every guest cancellation:
//   • booking price and its GST → refunded at the percentage. A part paid
//     by coupon comes back as a coupon at the same percentage;
//   • security deposit → always refunded in full (kept separate);
//   • Aerva's guest service fee → not refunded (an admin-only exception, see refundFee).
// The part of the booking price not refunded goes to the host, less Aerva's
// commission in the same proportion, on the normal payout day
// (orders.payout_on_cancel; see _payouts.js). Co-host shares shrink with it.
// Host cancellations are different: the guest always gets everything back
// (host-listings.js). An "Includes a Stay" experience and its stay are one
// purchase and are always cancelled together.

const crypto = require('crypto');
const { safeRefund, refundAcrossPayments, hasChangePayments } = require('./_refunds');
const { refundSubunitForInr } = require('./_currency');
const { logAudit } = require('./_audit-log');
const { paidByOrderRow, dateStr, daysBeforeCheckIn } = require('./_booking-rules');

const POLICIES = {
  flexible: { label: 'Flexible', tiers: [{ minDays: 30, pct: 100 }, { minDays: 10, pct: 80 }, { minDays: 5, pct: 50 }, { minDays: 2, pct: 30 }] },
  firm:     { label: 'Firm',     tiers: [{ minDays: 30, pct: 100 }, { minDays: 5, pct: 50 }] }
};
const HOST_DECISION_TIMEOUT_HOURS = 24;
const HOST_CANCELLATIONS_PER_YEAR = 3;

function policyKey(p) { return p === 'firm' ? 'firm' : 'flexible'; }

// → { pct } for a fixed tier, { hostDecides: true } inside the last window,
//   { started: true } once check-in day has passed.
function policyTier(policy, daysBefore) {
  const d = Number(daysBefore);
  if (!Number.isFinite(d) || d < 0) return { started: true };
  const tier = POLICIES[policyKey(policy)].tiers.find(t => d >= t.minDays);
  return tier ? { pct: tier.pct } : { hostDecides: true };
}

// Plain-language summary, for listing pages and emails.
function policySummary(policy) {
  return policyKey(policy) === 'firm'
    ? 'Firm: full refund 30+ days before check-in; 50% from 5 to 29 days; within 4 days the host decides. Aerva’s service fee is non-refundable; the deposit is always refunded.'
    : 'Flexible: full refund 30+ days before check-in; 80% from 10 to 29 days; 50% from 5 to 9 days; 30% from 2 to 4 days; in the last day the host decides. Aerva’s service fee is non-refundable; the deposit is always refunded.';
}

// One row's split at `pct`. couponAbsorbed: the part of its booking price
// paid by coupon (allocatePaid). All whole rupees.
// The deposit is refunded with a cancellation only while Aerva still holds
// it. Once it has been refunded (or is being refunded, or was settled in a
// dispute) it is never included again — no deposit is ever refunded twice.
function depositStillHeld(row) {
  return ['held', 'disputed'].includes(String(row.deposit_status || ''));
}

function splitRow(row, couponAbsorbed, pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0)) / 100;
  const subtotal = Math.max(0, Math.round(Number(row.subtotal) || 0));
  const absorbed = Math.max(0, Math.min(subtotal, Math.round(Number(couponAbsorbed) || 0)));
  const refundBooking = Math.round((subtotal - absorbed) * p);
  const couponBack = Math.round(absorbed * p);
  const refundGst = Math.round((Math.round(Number(row.gst) || 0)) * p);
  const deposit = depositStillHeld(row) ? Math.max(0, Math.round(Number(row.deposit_amount) || 0)) : 0;
  const retained = Math.max(0, subtotal - refundBooking - couponBack);
  const commission = subtotal > 0 ? Math.round((Number(row.commission_amount) || 0) * retained / subtotal) : 0;
  return {
    refundCash: refundBooking + refundGst + deposit, refundBooking, refundGst, couponBack, deposit,
    feeKept: Math.max(0, Math.round(Number(row.guest_service_fee) || 0)),
    retained, commission, hostPayout: retained - commission
  };
}

// The part of a booking paid by coupon comes back as a new coupon only when
// the HOST cancels (themselves, or Aerva cancelling for them). Any other
// cancellation or change: that part is not returned (couponLost). Changes s.
function dropCouponBack(s) {
  s.couponLost = (s.couponLost || 0) + (s.couponBack || 0);
  s.couponBack = 0;
  return s;
}

// Part of the booking paid with Aerva credit (_fee-credits.js): the refund
// goes to the payment first, and what the payment cannot take (it only paid
// `paid`, deposit aside) goes back onto the credit as s.creditBack. Changes s.
function creditPart(s, row, paidInfo, alreadyRefunded = 0) {
  const credit = Math.max(0, Math.round(Number((paidInfo || {}).creditUsed) || 0));
  s.creditBack = 0;
  if (!credit) return s;
  const card = Math.max(0, Math.round(Number((paidInfo || {}).paid) || 0) - Math.round(Number(row.deposit_amount) || 0) - Math.round(Number(alreadyRefunded) || 0));
  const booking = Math.max(0, s.refundCash - s.deposit);
  const back = Math.min(credit, Math.max(0, booking - card));
  s.refundCash -= back; s.creditBack = back;
  return s;
}

// The other half of an "Includes a Stay" purchase (see host-listings.js).
async function linkedSiblings(sql, orderId) {
  return await sql`
    SELECT o2.id FROM orders o1
    JOIN orders o2 ON o2.razorpay_order_id = o1.razorpay_order_id AND o2.id <> o1.id
                  AND o2.status = 'paid' AND o2.arrival = o1.arrival
    WHERE o1.id = ${orderId} AND (
      (COALESCE(o1.order_type, 'stay') = 'experience' AND COALESCE(o2.order_type, 'stay') = 'stay'
        AND EXISTS (SELECT 1 FROM listings e WHERE e.id = o1.listing_id AND e.experience_type = 'with_stay' AND e.hosting_listing_id = o2.listing_id))
      OR
      (COALESCE(o1.order_type, 'stay') = 'stay' AND o2.order_type = 'experience'
        AND EXISTS (SELECT 1 FROM listings e WHERE e.id = o2.listing_id AND e.experience_type = 'with_stay' AND e.hosting_listing_id = o1.listing_id))
    )
  `;
}

// Loads a booking (and its linked half) with everything a cancellation needs.
async function loadRows(sql, orderId) {
  const ids = [Number(orderId)].concat((await linkedSiblings(sql, orderId)).map(r => Number(r.id)));
  let rows;
  try {
    rows = await sql`
      SELECT o.*, l.host_id, l.property_name, l.timezone AS listing_timezone, l.check_in_time AS listing_check_in_time,
             COALESCE(o.cancellation_policy, l.cancellation_policy, 'flexible') AS policy,
             (o.arrival - (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date) AS days_before
      FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ANY(${ids}) ORDER BY o.id`;
  } catch (err) {
    // Before migration_cancellation_policy.sql: everything is Flexible.
    rows = await sql`
      SELECT o.*, l.host_id, l.property_name, l.timezone AS listing_timezone, l.check_in_time AS listing_check_in_time, 'flexible' AS policy,
             (o.arrival - (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date) AS days_before
      FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ANY(${ids}) ORDER BY o.id`;
  }
  // Days before check-in, counted to the check-in MOMENT on the property's
  // clock (e.g. tomorrow 1:00 PM), not to midnight (_booking-rules.js).
  rows.forEach(r => { r.days_before = daysBeforeCheckIn(r.arrival, r.listing_timezone, r.listing_check_in_time); });
  const main = rows.find(r => Number(r.id) === Number(orderId));
  return { main, rows };
}

// What a guest would get back if they cancelled now. Never changes anything.
async function cancellationQuote(sql, orderId, guestId) {
  const { main, rows } = await loadRows(sql, orderId);
  if (!main || (guestId != null && main.guest_id !== guestId)) return { error: 'Booking not found.', status: 404 };
  if (main.status !== 'paid') return { error: 'Only a confirmed booking can be cancelled.', status: 400 };
  const tier = policyTier(main.policy, main.days_before);
  const base = {
    orderId: main.id, policy: policyKey(main.policy), policyLabel: POLICIES[policyKey(main.policy)].label,
    policySummary: policySummary(main.policy), daysBefore: Number(main.days_before),
    items: rows.map(r => r.suite_name)
  };
  if (tier.started) return { ...base, allowed: false, started: true, error: 'This stay has already started, so it cannot be cancelled. To leave early, change your check-out date in My Bookings — possible until 10 AM on the day after check-in.' };
  const paid = await paidByOrderRow(sql, main.razorpay_order_id);
  const total = (pct) => rows.reduce((t, r) => {
    const s = dropCouponBack(creditPart(splitRow(r, (paid[r.id] || {}).couponAbsorbed, pct), r, paid[r.id]));
    t.couponLost += s.couponLost;
    t.refundCash += s.refundCash; t.couponBack += s.couponBack; t.deposit += s.deposit; t.feeKept += s.feeKept; t.creditBack += s.creditBack;
    t.refundBooking += s.refundBooking + s.refundGst;
    return t;
  }, { refundCash: 0, couponBack: 0, couponLost: 0, deposit: 0, feeKept: 0, refundBooking: 0, creditBack: 0 });
  if (tier.hostDecides) {
    return { ...base, allowed: true, hostDecides: true, pct: null, ifNoRefund: total(0), ifFullRefund: total(100) };
  }
  return { ...base, allowed: true, hostDecides: false, pct: tier.pct, ...total(tier.pct) };
}

// A returned coupon (the host cancelled) is a new coupon valid for 1 month
// from the day it is returned. Never throws.
async function returnCouponValue(sql, { razorpayOrderId, amount, sourceOrderId, guestEmail, suiteName }) {
  try {
    const value = Math.round(Number(amount) || 0);
    if (value <= 0) return null;
    const src = (await sql`
      SELECT c.id, c.guest_id, c.issuing_host_id, c.expires_at FROM orders o JOIN coupons c ON c.id = o.coupon_id
      WHERE o.razorpay_order_id = ${razorpayOrderId} AND o.coupon_id IS NOT NULL LIMIT 1
    `)[0];
    if (!src) return null;
    const code = 'AERVA-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const created = (await sql`
      INSERT INTO coupons (code, guest_id, amount, issuing_host_id, source_order_id, status, expires_at)
      VALUES (${code}, ${src.guest_id}, ${value}, ${src.issuing_host_id}, ${Number(sourceOrderId)}, 'active',
              now() + interval '1 month')
      RETURNING id, expires_at
    `)[0];
    await logAudit(sql, { action: 'coupon_value_restored', success: true, actorType: 'system', targetType: 'coupon', targetId: created.id,
      metadata: { fromCouponId: src.id, orderId: sourceOrderId, amount: value } });
    if (process.env.RESEND_API_KEY && guestEmail) {
      const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const until = new Date(created.expires_at).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
      await fetch('https://api.resend.com/emails', { method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to: guestEmail, subject: 'Your Aerva coupon has been returned',
          html: `<div style="font-family:sans-serif; max-width:480px;"><h2 style="font-family:Georgia,serif;">Your coupon has been returned</h2>
            <p>Part of your cancelled booking at <strong>${esc(suiteName)}</strong> was paid with an Aerva coupon. <strong>₹${value.toLocaleString('en-IN')}</strong> of it is back with you as a new coupon:</p>
            <p style="background:#f4eadc; padding:16px; text-align:center; font-size:20px; letter-spacing:0.05em; font-weight:600;">${code}</p>
            <p>Use it at checkout on any Aerva stay or experience until <strong>${esc(until)}</strong>.</p>
            <p style="font-size:12px; opacity:0.6; margin-top:24px;">Questions? Contact hello@aerva.in.</p></div>` }) });
    }
    return created;
  } catch (err) {
    console.error('coupon value not returned (needs manual follow-up):', sourceOrderId, err);
    await logAudit(sql, { action: 'coupon_value_restore_failed', success: false, actorType: 'system', targetType: 'order', targetId: Number(sourceOrderId) || null,
      metadata: { error: String(err.message || err).slice(0, 300) } });
    return null;
  }
}

// Aerva cancels for a host who has used their 3 cancellations (or cannot
// cancel themselves): the guest is refunded everything they paid, and gets
// the 10% Aerva coupon, which is deducted from the host's next payout
// (host_penalties). For an experience that includes a stay: on the stay's
// amount only, and none when it is the experience that is cancelled.
// Returns { amount } (0 when no coupon). Never throws.
async function issueCouponForHost(sql, { orderId, hostId }) {
  try {
    const o = (await sql`SELECT o.id, o.guest_id, o.total, COALESCE(o.deposit_amount, 0) AS deposit, COALESCE(o.order_type, 'stay') AS order_type, o.razorpay_order_id, o.arrival, o.listing_id
                         FROM orders o WHERE o.id = ${Number(orderId) || 0}`)[0];
    if (!o || !o.guest_id) return { amount: 0 };
    const sibs = await linkedSiblings(sql, o.id);
    if (sibs.length && o.order_type === 'experience') return { amount: 0 };
    const amount = Math.max(1, Math.round(Math.max(0, Number(o.total) - Number(o.deposit)) * 0.10));
    const { COUPON_RELEASE_DELAY_MINUTES } = require('./_coupons');
    const code = 'AERVA-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const coupon = (await sql`INSERT INTO coupons (code, guest_id, amount, issuing_host_id, source_order_id, status, release_at)
                              VALUES (${code}, ${o.guest_id}, ${amount}, ${hostId}, ${o.id}, 'scheduled', now() + make_interval(mins => ${COUPON_RELEASE_DELAY_MINUTES}))
                              RETURNING id`)[0];
    try {
      await sql`INSERT INTO host_penalties (host_id, order_id, coupon_id, amount) VALUES (${hostId}, ${o.id}, ${coupon.id}, ${amount})`;
    } catch (e) { console.error('coupon deduction not recorded (needs follow-up):', o.id, e.message); }
    await logAudit(sql, { action: 'cancellation_coupon_charged_to_payout', success: true, actorType: 'admin', targetType: 'order', targetId: o.id, metadata: { couponId: coupon.id, amount, hostId, byAerva: true } });
    return { amount };
  } catch (err) {
    console.error('coupon for the host not issued (needs follow-up):', orderId, err.message);
    return { amount: 0 };
  }
}

// Value to give back to a guest that no card payment can take: first onto
// the Aerva credit the booking used (_fee-credits.js), the rest as a coupon
// (returnCouponValue) — only with coupon: true (the host's fault). Without
// it the coupon part is not returned. Returns { credit, coupon, couponLost }.
async function returnValue(sql, { razorpayOrderId, amount, sourceOrderId, guestEmail, suiteName, coupon = false }) {
  const want = Math.max(0, Math.round(Number(amount) || 0));
  if (!want) return { credit: 0, coupon: 0, couponLost: 0 };
  const credit = await require('./_fee-credits').giveBack(sql, sourceOrderId, want);
  const rest = want - credit;
  if (rest > 0 && coupon) await returnCouponValue(sql, { razorpayOrderId, amount: rest, sourceOrderId, guestEmail, suiteName });
  return { credit, coupon: coupon ? rest : 0, couponLost: coupon ? 0 : rest };
}

async function email(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return;
  try {
    await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html }) });
  } catch (err) { console.error('email failed:', subject, err.message); }
}
const escH = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');

// ---------------------------------------------------------------------
// ONE CANCELLATION AT A TIME PER BOOKING
// Before any money moves, the booking (and its linked half) is claimed in
// one statement. A host and a guest request, two clicks, or the scheduler
// acting at the same moment: only one gets the claim; the others are told
// it is already being cancelled. A claim left behind by a crash can be taken
// over after 10 minutes, and the refund step (_refunds.js) then finds the
// refund that was already made instead of making another.
// Returns the claim token, or null if the columns do not exist yet
// (before migration_cancellation_policy.sql).
async function claimForCancellation(sql, ids) {
  const token = crypto.randomBytes(8).toString('hex');
  let got;
  try {
    got = await sql`UPDATE orders SET cancel_claim = ${token}, cancel_claimed_at = now()
                    WHERE id = ANY(${ids}) AND status = 'paid'
                      AND (cancel_claim IS NULL OR cancel_claimed_at < now() - interval '10 minutes')
                    RETURNING id`;
  } catch (err) {
    if (/cancel_claim/.test(err.message)) return null;
    throw err;
  }
  if (got.length !== ids.length) {
    if (got.length) await sql`UPDATE orders SET cancel_claim = NULL, cancel_claimed_at = NULL WHERE id = ANY(${got.map(r => r.id)}) AND cancel_claim = ${token}`;
    throw Object.assign(new Error('This booking is already being cancelled, or has been cancelled.'), { isUserFacing: true, status: 409 });
  }
  return token;
}
async function releaseClaim(sql, ids, token) {
  if (!token) return;
  try { await sql`UPDATE orders SET cancel_claim = NULL, cancel_claimed_at = NULL WHERE id = ANY(${ids}) AND cancel_claim = ${token}`; }
  catch (err) { console.error('releaseClaim failed:', err.message); }
}

// Payouts of these bookings not sent yet are removed (they are planned
// again from the booking's new amounts by _payouts.js). Payouts go the day
// after check-in, so a booking cancelled during the stay may already have
// been paid out: then nothing is removed, and once the amounts change
// _payouts.js settleAfterPayout deducts what the host and co-hosts are no
// longer owed from their next payout. A payout being sent at this moment
// is refused for a few minutes. A deposit-compensation payout
// (payouts.kind = 'deposit') is not the booking's payout and is kept.
async function clearUnsentPayouts(sql, ids) {
  let rows;
  try { rows = await sql`SELECT id, status FROM payouts WHERE order_id = ANY(${ids}) AND COALESCE(to_jsonb(payouts)->>'kind', 'booking') = 'booking'`; }
  catch (err) { return; } // before migration_payouts.sql
  const sent = () => Object.assign(new Error('The host payout for this booking is being sent right now. Please try again in a few minutes.'), { isUserFacing: true, status: 409 });
  if (rows.some(r => r.status === 'processing')) throw sent();
  if (rows.some(r => r.status === 'sent')) return;   // settled after the change (settleAfterPayout)
  if (!rows.length) return;
  await sql`DELETE FROM payouts WHERE order_id = ANY(${ids}) AND status IN ('due', 'failed') AND COALESCE(to_jsonb(payouts)->>'kind', 'booking') = 'booking'`;
  // One claimed for sending in the same moment is still there: refused.
  const left = await sql`SELECT 1 FROM payouts WHERE order_id = ANY(${ids}) AND COALESCE(to_jsonb(payouts)->>'kind', 'booking') = 'booking' LIMIT 1`;
  if (left.length) throw sent();
}

// Cancels a booking (and its linked half) at `pct`, refunding through
// _refunds.js. by: 'guest' (a fixed tier) | 'host_decision' | 'timeout'.
// Returns { ok, refundCash, couponBack } or throws a user-facing error.
// by 'admin': Aerva cancels from Admin → Lookup. note is the admin's reason
// (required by the endpoint); refundFee also returns Aerva's service fee;
// countAgainstHost records it as one of the host's cancellations (their
// 3-a-year limit), e.g. an Aerva cancellation done for a host in an emergency.
// preview: true works everything out and changes nothing.
// refundFee (Aerva cancels only) is the exception to "the service fee is
// never refunded": it needs feeReason, and a proposal with it can only be
// approved by an admin (_support-actions.js).
async function executePolicyCancellation(sql, razorpay, { orderId, pct, by, note = '', refundFee = false, feeReason = '', countAgainstHost = false, adminLabel = null, preview = false }) {
  const feeWhy = String(feeReason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (by === 'admin' && refundFee && !preview && feeWhy.length < 10) {
    throw Object.assign(new Error('Explain why Aerva’s service fee is being refunded (at least a sentence). It is an exception and is recorded.'), { isUserFacing: true, status: 400 });
  }
  const { main, rows } = await loadRows(sql, orderId);
  if (!main) throw Object.assign(new Error('Booking not found.'), { isUserFacing: true, status: 404 });
  if (main.status !== 'paid') throw Object.assign(new Error('This booking has already been cancelled.'), { isUserFacing: true, status: 409 });
  const percent = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  // The host's share can only be recorded once migration_cancellation_policy.sql
  // has run. Checked BEFORE any money moves, never after.
  try { await sql`SELECT refund_percent, payout_on_cancel, cancel_claim FROM orders LIMIT 0`; }
  catch (err) { throw Object.assign(new Error('Cancellations are being set up. Please try again later or contact hello@aerva.in.'), { isUserFacing: true, status: 503 }); }

  const reason = by === 'admin'
    ? `Cancelled by Aerva${note ? ' — ' + note : ''}`
    : by === 'timeout_no_refund'
    ? `Cancelled at the guest’s request — the host did not answer within ${HOST_DECISION_TIMEOUT_HOURS} hours, so no refund of the booking price`
    : by === 'timeout_policy'
      ? `Cancelled at the guest’s request — ${percent}% refund under the booking’s terms (the host did not answer within ${HOST_DECISION_TIMEOUT_HOURS} hours)`
      : by === 'emergency'
        ? 'Cancelled at the guest’s request (emergency) — booking price refunded in full'
      : by === 'host_declined'
        ? 'Cancelled at the guest’s request — no refund of the booking price'
      : by === 'host_chose'
        ? `Cancelled at the guest’s request — the host chose a ${percent}% refund${note ? ' (' + note + ')' : ''}`
        : `Cancelled at the guest’s request — ${percent}% refund under the booking’s terms`;

  // Worked out from the rows as they are BEFORE anything changes.
  const paid = await paidByOrderRow(sql, main.razorpay_order_id);
  // Refunds already made on these bookings without cancelling (Admin →
  // Lookup "goodwill" refunds) count toward this refund: the guest never
  // gets more back in total than the cancellation gives. If the host paid
  // for one of them, the part this refund does not cover stays theirs.
  const ids0 = rows.map(r => Number(r.id));
  const goodwill = {}, hostPaid = {};
  try {
    (await sql`SELECT order_id, COALESCE(sum(amount), 0)::bigint AS p FROM refunds
               WHERE order_id = ANY(${ids0}) AND kind LIKE 'goodwill-%' AND status <> 'failed' GROUP BY order_id`)
      .forEach(x => { goodwill[x.order_id] = Math.round(Number(x.p) / 100); });
    (await sql`SELECT target_id AS order_id, COALESCE(sum((metadata->>'amount')::numeric), 0) AS n FROM audit_log
               WHERE action = 'admin_partial_refund' AND success = true AND target_type = 'order' AND target_id = ANY(${ids0})
                 AND (metadata->>'hostPays')::boolean IS TRUE GROUP BY target_id`)
      .forEach(x => { hostPaid[x.order_id] = Math.round(Number(x.n) || 0); });
  } catch (e) { /* tables not there yet: nothing refunded this way */ }
  const splits = new Map(rows.map(r => {
    const s = splitRow(r, (paid[r.id] || {}).couponAbsorbed, percent);
    // Aerva's own fee, returned only when an admin chooses to.
    // Aerva's service fee is not refunded — except when an admin decides so,
    // case by case, with a recorded reason (refundFee + feeReason).
    if (by === 'admin' && refundFee && s.feeKept > 0) { s.refundCash += s.feeKept; s.feeRefunded = s.feeKept; s.feeKept = 0; }
    const already = goodwill[r.id] || 0;
    if (already > 0) {
      const covered = Math.min(already, s.refundCash);
      s.alreadyRefunded = already;
      s.refundCash -= covered;
      const notCovered = already - covered;              // given beyond what this cancellation refunds
      const hostPart = Math.min(notCovered, hostPaid[r.id] || 0);
      if (hostPart > 0) s.hostPayout = Math.max(0, s.hostPayout - hostPart);
    }
    creditPart(s, r, paid[r.id], already);
    if (!(by === 'admin' && countAgainstHost)) dropCouponBack(s);
    return [Number(r.id), s];
  }));
  const ids = rows.map(r => Number(r.id));
  if (preview) {
    const t = (k) => [...splits.values()].reduce((a, s) => a + (s[k] || 0), 0);
    return { preview: true, percent, items: rows.map(r => r.suite_name), refundCash: t('refundCash'), couponBack: t('couponBack'), couponLost: t('couponLost'), deposit: t('deposit'),
             feeKept: t('feeKept'), feeRefunded: t('feeRefunded'), alreadyRefunded: t('alreadyRefunded'), creditBack: t('creditBack'), hostPayout: t('hostPayout'), policy: policyKey(main.policy), daysBefore: Number(main.days_before) };
  }
  const claim = await claimForCancellation(sql, ids);
  let done = [];
  const refundIds = new Map();
  try {
    // The host is never paid for what the guest gets back: a payout already
    // sent (or being sent) stops the cancellation; one not sent yet is
    // removed and planned again from the new amounts (_payouts.js).
    await clearUnsentPayouts(sql, ids);
    // 1. Every refund first. A linked pair is only cancelled when BOTH
    // halves are refunded; a failure leaves both booked, with the failed
    // refund in Admin → Refunds, and a retry finds what was already
    // refunded instead of refunding it again (_refunds.js).
    try {
      for (const r of rows) {
        const s = splits.get(Number(r.id));
        const currency = r.charge_currency || 'INR';
        // One refund per booking, ever (_refunds.js: unique per booking and purpose).
        // A booking changed with an extra payment is refunded across all its payments.
        let refund;
        if (await hasChangePayments(sql, r.id)) {
          refund = { id: (await refundAcrossPayments(sql, razorpay, { orderId: r.id, amountInr: s.refundCash, kindBase: 'cancellation' })).firstRefundId };
        } else {
          // Foreign currency: the same share of what was captured, never today's rate.
          const amount = currency === 'INR' ? s.refundCash * 100 : await refundSubunitForInr(sql, { razorpayOrderId: r.razorpay_order_id, amountInr: s.refundCash, currency });
          if (!amount && s.refundCash > 0) throw Object.assign(new Error(`There is no record of the amount charged in ${currency} for this booking, so it cannot be refunded automatically. Please contact hello@aerva.in.`), { isUserFacing: true, status: 502 });
          refund = await safeRefund(sql, razorpay, { orderId: r.id, paymentId: r.razorpay_payment_id, amountSubunit: amount || 0, kind: 'cancellation' });
        }
        refundIds.set(Number(r.id), refund.id || null);
      }
    } catch (err) {
      if (refundIds.size) {
        await logAudit(sql, { action: 'guest_cancellation_refund_incomplete', success: false, actorType: 'system', targetType: 'order', targetId: main.id,
          metadata: { ids, refunded: [...refundIds.keys()], percent, by, error: String(err.message || err).slice(0, 300) } });
      }
      throw err;
    }
    // 2. Then every row flipped in ONE statement: both halves of a pair are
    // cancelled together or not at all. Only the holder of the claim can.
    const cols = rows.map(r => { const s = splits.get(Number(r.id)); return { id: Number(r.id), commission: s.commission, payout: s.hostPayout, refundId: refundIds.get(Number(r.id)) }; });
    done = await sql`
      UPDATE orders o SET status = 'cancelled', cancellation_reason = ${reason}, cancelled_at = now(),
        deposit_status = CASE WHEN o.deposit_status IN ('held', 'disputed') THEN 'refunded' ELSE o.deposit_status END,
        deposit_refund_id = v.refund_id,
        commission_amount = v.commission, payout_amount = v.payout,
        refund_percent = ${percent}, payout_on_cancel = (v.payout > 0),
        cancel_claim = NULL, cancel_claimed_at = NULL
      FROM unnest(${cols.map(c => c.id)}::int[], ${cols.map(c => c.commission)}::int[], ${cols.map(c => c.payout)}::int[], ${cols.map(c => c.refundId)}::text[])
           AS v(id, commission, payout, refund_id)
      WHERE o.id = v.id AND o.status = 'paid' AND o.cancel_claim IS NOT DISTINCT FROM ${claim}
        AND (SELECT count(*) FROM orders x WHERE x.id = ANY(${ids}) AND x.status = 'paid' AND x.cancel_claim IS NOT DISTINCT FROM ${claim}) = ${ids.length}
      RETURNING o.id`;
    done = rows.filter(r => done.some(d => Number(d.id) === Number(r.id)));
    if (!done.length) {
      if (refundIds.size) await logAudit(sql, { action: 'guest_cancellation_refund_incomplete', success: false, actorType: 'system', targetType: 'order', targetId: main.id,
        metadata: { ids, refunded: [...refundIds.keys()], percent, by, error: 'refunded, but the booking changed before it could be cancelled' } });
      throw Object.assign(new Error('This booking has already been cancelled.'), { isUserFacing: true, status: 409 });
    }
  } catch (err) {
    await releaseClaim(sql, ids, claim);
    throw err;
  }
  // A payout planned from the old amounts in the moment before the claim
  // took hold is removed too; it is planned again from the new ones.
  try { await clearUnsentPayouts(sql, ids); }
  catch (err) { await logAudit(sql, { action: 'payout_sent_for_cancelled_booking', success: false, actorType: 'system', targetType: 'order', targetId: main.id, metadata: { ids, error: err.message } }); }
  for (const r of done) {
    const s = splits.get(Number(r.id));
    try { await sql`UPDATE order_cohost_shares SET amount = round(${s.hostPayout}::numeric * percent / 100) WHERE order_id = ${r.id}`; }
    catch (err) { /* no co-host shares table */ }
    // Paid out already (the day after check-in): what is no longer owed
    // comes off the next payout.
    await require('./_payouts').settleAfterPayout(sql, r.id, { reason: 'Booking cancelled after its payout was sent' });
    if (by === 'admin') {
      await logAudit(sql, { action: 'booking_cancelled_by_admin', success: true, actorType: 'admin', actorIdentifier: adminLabel || 'admin',
        targetType: 'order', targetId: r.id, metadata: { percent, reason: note, refundCash: s.refundCash, couponBack: s.couponBack, couponLost: s.couponLost || 0, feeRefunded: s.feeRefunded || 0, feeReason: s.feeRefunded ? feeWhy : undefined, hostPayout: s.hostPayout, countAgainstHost: !!countAgainstHost } });
      // Counts toward the host's yearly limit (hostCancellationsLastYear) —
      // once per purchase, like a host's own cancellation.
      if (countAgainstHost && Number(r.id) === Number(main.id)) {
        await logAudit(sql, { action: 'booking_cancelled_by_host', success: true, actorType: 'admin', actorIdentifier: String(main.host_id || ''),
          targetType: 'order', targetId: r.id, metadata: { byAdmin: adminLabel || 'admin', reason: note } });
      }
      continue;
    }
    await logAudit(sql, { action: 'booking_cancelled_by_guest', success: true, actorType: 'system', actorIdentifier: String(main.guest_id || ''),
      targetType: 'order', targetId: r.id, metadata: { percent, by, refundCash: s.refundCash, couponBack: s.couponBack, couponLost: s.couponLost || 0, hostPayout: s.hostPayout, policy: policyKey(main.policy) } });
  }

  const sum = (k) => done.reduce((t, r) => t + (splits.get(Number(r.id))[k] || 0), 0);
  const refundCash = sum('refundCash'), couponBack = sum('couponBack'), hostShare = sum('hostPayout');
  if (couponBack > 0) await returnCouponValue(sql, { razorpayOrderId: main.razorpay_order_id, amount: couponBack, sourceOrderId: main.id, guestEmail: main.guest_email, suiteName: main.suite_name });
  // The part paid with Aerva credit that the payment cannot take: back onto the credit.
  let creditBack = 0;
  for (const r of done) {
    const want = splits.get(Number(r.id)).creditBack || 0;
    if (want > 0) creditBack += await require('./_fee-credits').giveBack(sql, r.id, want);
  }

  const when = `${dateStr(main.arrival)} → ${dateStr(main.departure)}`;
  await email(main.guest_email, `Your booking at ${main.suite_name} is cancelled`,
    `<div style="font-family:sans-serif; max-width:480px;"><h2 style="font-family:Georgia,serif;">Your booking is cancelled</h2>
      <p><strong>${escH(main.suite_name)}</strong> (${escH(when)})</p><p>${escH(reason)}.</p>
      <p>Refund to your original payment method: <strong>${inr(refundCash)}</strong>${couponBack > 0 ? `, plus ${inr(couponBack)} returned as a coupon (sent separately)` : ''}${creditBack > 0 ? `, plus ${inr(creditBack)} back on your Aerva credit (the part paid with it; see My Bookings)` : ''}. Refunds usually arrive in 5–7 working days.${sum('couponLost') > 0 ? ` The ${inr(sum('couponLost'))} paid by coupon is not returned: a coupon comes back only when the host cancels.` : ''}${sum('feeRefunded') > 0 ? ' This includes Aerva’s service fee.' : ' Aerva’s service fee is non-refundable.'}</p>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">Questions? Contact hello@aerva.in.</p></div>`);
  const host = (await sql`SELECT email FROM guests WHERE host_id = ${main.host_id} ORDER BY id LIMIT 1`)[0];
  await email(host && host.email, `Booking cancelled: ${main.suite_name}`,
    `<div style="font-family:sans-serif; max-width:480px;"><h2 style="font-family:Georgia,serif;">A booking was cancelled</h2>
      <p><strong>${escH(main.suite_name)}</strong> (${escH(when)}) — the dates are open again.</p>
      ${hostShare > 0 ? `<p>Your payout for this booking: <strong>${inr(hostShare)}</strong>, on the usual payout day.</p>` : ''}</div>`);
  await postThreadMessage(sql, main.id, by === 'admin' ? 'system' : 'host', `${by === 'admin' ? 'Aerva cancelled this booking' : 'Cancellation confirmed'}. Refund to the guest: ${inr(refundCash)}${couponBack > 0 ? ` plus ${inr(couponBack)} as a coupon` : ''}${creditBack > 0 ? ` plus ${inr(creditBack)} back on their Aerva credit` : ''}.`);
  return { ok: true, refundCash, couponBack, creditBack, percent };
}

// Host cancellations in the last 12 months (co-host cancellations count for
// the host). Linked "Includes a Stay" halves are logged separately and do
// not count twice.
async function hostCancellationsLastYear(sql, hostId) {
  try {
    const r = await sql`SELECT count(*)::int AS n FROM audit_log
                        WHERE action = 'booking_cancelled_by_host' AND actor_identifier = ${String(hostId)}
                          AND success = true AND created_at > now() - interval '12 months'`;
    return r[0].n;
  } catch (err) { return 0; }
}

// ---------------------------------------------------------------------
// CANCELLATION REQUESTS, THROUGH MESSAGES
// A guest never cancels on their own: they send a request, it appears in
// the booking's message thread (and in My Earnings), and the host answers.
// The host is shown ONLY the choice that applies to this booking's bracket,
// fixed when the request is sent — never the other brackets.
//   change_of_plans, fixed bracket  → Accept (refund P%) / Reject (booking stands)
//   change_of_plans, last window    → choose 0–100% / Reject (no refund)
//   emergency reasons               → Accept (full refund) / Reject (booking stands)
// Unanswered after 24 hours: a fixed bracket is accepted at its P%; the last
// window is settled with no refund of the booking price; an emergency stays
// open for Aerva to look at.
const EMERGENCY_REASONS = {
  environmental: 'Environmental hazard (flood, fire, landslide or similar)',
  life_threatening: 'Life-threatening situation',
  emergency: 'Medical or family emergency',
  travel_restriction: 'Government order or travel restriction'
};
const REQUEST_REASONS = Object.assign({ change_of_plans: 'Change of plans' }, EMERGENCY_REASONS);

// Posts a line into the booking's thread (creating the thread if needed).
// Never throws: messages are a courtesy, never a reason to fail.
async function postThreadMessage(sql, orderId, senderType, text) {
  try {
    const o = (await sql`SELECT o.id, o.listing_id, o.guest_id, o.guest_email, l.host_id FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${orderId}`)[0];
    if (!o) return;
    let conv = (await sql`SELECT id FROM conversations WHERE order_id = ${orderId}`)[0];
    if (!conv) conv = (await sql`INSERT INTO conversations (order_id, listing_id, guest_id, guest_email, host_id)
                                 VALUES (${o.id}, ${o.listing_id}, ${o.guest_id}, ${o.guest_email}, ${o.host_id}) RETURNING id`)[0];
    const t = String(text).slice(0, 1500);
    await sql`INSERT INTO messages (conversation_id, sender_type, original_text, display_text) VALUES (${conv.id}, ${senderType}, ${t}, ${t})`;
  } catch (err) { console.error('thread message not posted:', err.message); }
}

// What the host may do with one request row — only its own bracket.
function hostOption(rq) {
  if (EMERGENCY_REASONS[rq.reason_code]) return { type: 'emergency', percent: 100 };
  if (rq.reason_code === 'late_cancellation' || rq.policy_percent == null) return { type: 'choose' };
  return { type: 'fixed', percent: Number(rq.policy_percent) };
}

// The guest sends a request. Returns { request } or { error, status }.
async function createCancellationRequest(sql, { orderId, guestId, reasonCode, details }) {
  if (!REQUEST_REASONS[reasonCode]) return { error: 'Choose a reason.', status: 400 };
  const q = await cancellationQuote(sql, orderId, guestId);
  if (q.status) return { error: q.error, status: q.status };
  // Only before check-in, emergencies included. Once the stay has started
  // the guest changes the booking instead (shorter stay, _booking-changes.js).
  if (!q.allowed && (!EMERGENCY_REASONS[reasonCode] || q.started)) return { error: q.error, status: 400 };
  const o = (await sql`SELECT o.suite_name, o.arrival, o.departure, l.host_id,
                              (o.departure < (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date) AS ended
                       FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${orderId}`)[0];
  if (o.ended) return { error: 'This stay has already ended.', status: 400 };
  const policyPercent = reasonCode === 'change_of_plans' ? (q.hostDecides ? null : q.pct) : null;
  const clean = String(details || '').trim().slice(0, 800);
  let request;
  try {
    request = (await sql`INSERT INTO cancellation_requests (order_id, guest_id, reason_code, details, policy_percent, days_before)
                         VALUES (${orderId}, ${guestId}, ${reasonCode}, ${clean || null}, ${policyPercent}, ${Number.isFinite(q.daysBefore) ? q.daysBefore : null})
                         RETURNING *`)[0];
  } catch (err) {
    if (/idx_cancel_requests_open|duplicate key/.test(err.message)) return { error: 'You already have a request waiting for the host.', status: 409 };
    throw err;
  }
  await logAudit(sql, { action: 'guest_cancellation_requested', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'order', targetId: orderId,
    metadata: { reasonCode, policyPercent, daysBefore: q.daysBefore } });
  await postThreadMessage(sql, orderId, 'guest', `I’d like to cancel this booking. Reason: ${REQUEST_REASONS[reasonCode]}.${clean ? ' ' + clean : ''}`);
  const host = (await sql`SELECT email FROM guests WHERE host_id = ${o.host_id} ORDER BY id LIMIT 1`)[0];
  await email(host && host.email, `Cancellation request for ${o.suite_name}`,
    `<div style="font-family:sans-serif; max-width:480px;"><h2 style="font-family:Georgia,serif;">A guest has asked to cancel</h2>
      <p><strong>${escH(o.suite_name)}</strong> (${escH(dateStr(o.arrival))} → ${escH(dateStr(o.departure))})</p>
      <p>Please answer in Messages within ${HOST_DECISION_TIMEOUT_HOURS} hours.</p>
      <p><a href="https://aerva.in/index.html?view=messages" style="color:#8a6c39;">Open Messages</a></p></div>`);
  return { request };
}

// What the guest would get back at `percent` (cash, deposit included).
async function guestGetsBackFor(sql, orderId, percent) {
  const { rows } = await loadRows(sql, orderId);
  if (!rows.length) return 0;
  const paid = await paidByOrderRow(sql, rows[0].razorpay_order_id);
  return rows.reduce((t, r) => t + splitRow(r, (paid[r.id] || {}).couponAbsorbed, percent).refundCash, 0);
}

// The card shown at the top of a booking's thread.
//   host:  the pending request with ONLY its bracket's choice, plus what the
//          guest would get back for a fixed choice;
//   guest: whether a request is waiting, or a button to send one.
async function cancellationCard(sql, conversationId, role) {
  try {
    const o = (await sql`SELECT o.* FROM conversations c JOIN orders o ON o.id = c.order_id WHERE c.id = ${conversationId}`)[0];
    if (!o || o.status !== 'paid') return null;
    const rq = (await sql`SELECT * FROM cancellation_requests WHERE order_id = ${o.id} AND status = 'pending' ORDER BY id DESC LIMIT 1`)[0];
    if (role === 'host') {
      if (!rq) return null;
      const option = hostOption(rq);
      const card = { requestId: rq.id, orderId: o.id, reason: REQUEST_REASONS[rq.reason_code] || 'Cancellation', details: rq.details || '',
                     daysBefore: rq.days_before, option };
      if (option.type !== 'choose') card.guestGetsBack = await guestGetsBackFor(sql, o.id, option.percent);
      return card;
    }
    if (rq) return { orderId: o.id, pending: true };
    const q = await cancellationQuote(sql, o.id, null);
    return q.allowed ? { orderId: o.id, canRequest: true } : null;
  } catch (err) {
    console.error('cancellationCard skipped:', err.message);
    return null;
  }
}

// A request is answered once. Claimed by stamping decided_at while still
// pending: the host answering and the scheduler acting at the same moment
// can never both go ahead. Released again if the answer fails.
async function claimRequest(sql, requestId) {
  const r = await sql`UPDATE cancellation_requests SET decided_at = now()
                      WHERE id = ${requestId} AND status = 'pending' AND decided_at IS NULL RETURNING id`;
  return r.length > 0;
}
async function unclaimRequest(sql, requestId) {
  try { await sql`UPDATE cancellation_requests SET decided_at = NULL WHERE id = ${requestId} AND status = 'pending'`; }
  catch (err) { console.error('unclaimRequest failed:', err.message); }
}

// Scheduler: requests unanswered for 24 hours.
async function settleUnansweredRequests(sql, razorpay, { deadlineMs = 4000 } = {}) {
  const started = Date.now();
  const out = { accepted: 0, noRefund: 0, failed: 0 };
  if (!razorpay) return { ...out, skipped: 'Razorpay keys not set' };
  let rows = [];
  try {
    rows = await sql`SELECT r.* FROM cancellation_requests r JOIN orders o ON o.id = r.order_id
                     WHERE r.status = 'pending' AND r.decided_at IS NULL AND o.status = 'paid'
                       AND r.reason_code IN ('change_of_plans', 'late_cancellation')
                       AND r.created_at < now() - make_interval(hours => ${HOST_DECISION_TIMEOUT_HOURS}) LIMIT 20`;
  } catch (err) { return { ...out, skipped: 'table not ready' }; }
  for (const r of rows) {
    if (Date.now() - started > deadlineMs) break;
    const option = hostOption(r);
    try {
      // Claim the request first, so a host answering at this same moment
      // and the scheduler can never both act on it.
      if (!(await claimRequest(sql, r.id))) continue;
      const pct = option.type === 'fixed' ? option.percent : 0;
      try {
        await executePolicyCancellation(sql, razorpay, { orderId: r.order_id, pct, by: option.type === 'fixed' ? 'timeout_policy' : 'timeout_no_refund' });
      } catch (err) {
        await unclaimRequest(sql, r.id);
        throw err;
      }
      await sql`UPDATE cancellation_requests SET status = ${option.type === 'fixed' ? 'accepted' : 'declined'}, refund_percent = ${pct},
                  host_note = 'No answer from the host within 24 hours', decided_at = now() WHERE id = ${r.id}`;
      option.type === 'fixed' ? out.accepted++ : out.noRefund++;
    } catch (err) { out.failed++; console.error('unanswered request not settled:', r.id, err.message); }
  }
  return out;
}

module.exports = {
  POLICIES, HOST_DECISION_TIMEOUT_HOURS, HOST_CANCELLATIONS_PER_YEAR, EMERGENCY_REASONS, REQUEST_REASONS,
  policyKey, policyTier, policySummary, splitRow, depositStillHeld, linkedSiblings, loadRows,
  claimForCancellation, releaseClaim, guestGetsBackFor, claimRequest, unclaimRequest, postThreadMessage, hostOption, createCancellationRequest, cancellationCard,
  cancellationQuote, executePolicyCancellation, returnCouponValue, returnValue, issueCouponForHost, hostCancellationsLastYear, settleUnansweredRequests, clearUnsentPayouts
};
