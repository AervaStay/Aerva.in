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
//   • Aerva's guest service fee → never refunded.
// The part of the booking price not refunded goes to the host, less Aerva's
// commission in the same proportion, on the normal payout day
// (orders.payout_on_cancel; see _payouts.js). Co-host shares shrink with it.
// Host cancellations are different: the guest always gets everything back
// (host-listings.js). An "Includes a Stay" experience and its stay are one
// purchase and are always cancelled together.

const crypto = require('crypto');
const { safeRefund, refundAcrossPayments, hasChangePayments } = require('./_refunds');
const { convertInrToForeignSubunit } = require('./_currency');
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
  if (tier.started) return { ...base, allowed: false, error: 'This stay has already started. For an emergency, use Request cancellation instead.' };
  const paid = await paidByOrderRow(sql, main.razorpay_order_id);
  const total = (pct) => rows.reduce((t, r) => {
    const s = splitRow(r, (paid[r.id] || {}).couponAbsorbed, pct);
    t.refundCash += s.refundCash; t.couponBack += s.couponBack; t.deposit += s.deposit; t.feeKept += s.feeKept;
    t.refundBooking += s.refundBooking + s.refundGst;
    return t;
  }, { refundCash: 0, couponBack: 0, deposit: 0, feeKept: 0, refundBooking: 0 });
  if (tier.hostDecides) {
    return { ...base, allowed: true, hostDecides: true, pct: null, ifNoRefund: total(0), ifFullRefund: total(100) };
  }
  return { ...base, allowed: true, hostDecides: false, pct: tier.pct, ...total(tier.pct) };
}

// A returned coupon keeps the original coupon's expiry, but always has at
// least 30 days left. Never throws.
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
              GREATEST(COALESCE(${src.expires_at}::timestamptz, now()), now() + interval '30 days'))
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

// Cancels a booking (and its linked half) at `pct`, refunding through
// _refunds.js. by: 'guest' (a fixed tier) | 'host_decision' | 'timeout'.
// Returns { ok, refundCash, couponBack } or throws a user-facing error.
async function executePolicyCancellation(sql, razorpay, { orderId, pct, by, note = '' }) {
  const { main, rows } = await loadRows(sql, orderId);
  if (!main) throw Object.assign(new Error('Booking not found.'), { isUserFacing: true, status: 404 });
  if (main.status !== 'paid') throw Object.assign(new Error('This booking has already been cancelled.'), { isUserFacing: true, status: 409 });
  const percent = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  // The host's share can only be recorded once migration_cancellation_policy.sql
  // has run. Checked BEFORE any money moves, never after.
  try { await sql`SELECT refund_percent, payout_on_cancel, cancel_claim FROM orders LIMIT 0`; }
  catch (err) { throw Object.assign(new Error('Cancellations are being set up. Please try again later or contact hello@aerva.in.'), { isUserFacing: true, status: 503 }); }

  const reason = by === 'timeout_no_refund'
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
  const splits = new Map(rows.map(r => [Number(r.id), splitRow(r, (paid[r.id] || {}).couponAbsorbed, percent)]));
  const ids = rows.map(r => Number(r.id));
  const claim = await claimForCancellation(sql, ids);
  const done = [];
  try {
    for (const r of rows) {
      const s = splits.get(Number(r.id));
      const currency = r.charge_currency || 'INR';
      const amount = currency === 'INR' ? s.refundCash * 100 : await convertInrToForeignSubunit(sql, s.refundCash, currency);
      if (!amount && s.refundCash > 0) throw Object.assign(new Error(`No exchange rate available to refund this ${currency} booking right now. Please try again shortly.`), { isUserFacing: true, status: 502 });
      // One refund per booking, ever (_refunds.js: unique per booking and purpose).
      // A booking changed with an extra payment is refunded across all its payments.
      const refund = await hasChangePayments(sql, r.id)
        ? { id: (await refundAcrossPayments(sql, razorpay, { orderId: r.id, amountInr: s.refundCash, kindBase: 'cancellation' })).firstRefundId }
        : await safeRefund(sql, razorpay, { orderId: r.id, paymentId: r.razorpay_payment_id, amountSubunit: amount || 0, kind: 'cancellation' });
      // Only the holder of the claim can cancel the booking.
      const flipped = await sql`
        UPDATE orders SET status = 'cancelled', cancellation_reason = ${reason}, cancelled_at = now(),
          deposit_status = CASE WHEN deposit_status IN ('held', 'disputed') THEN 'refunded' ELSE deposit_status END,
          deposit_refund_id = ${refund.id},
          commission_amount = ${s.commission}, payout_amount = ${s.hostPayout},
          refund_percent = ${percent}, payout_on_cancel = ${s.hostPayout > 0},
          cancel_claim = NULL, cancel_claimed_at = NULL
        WHERE id = ${r.id} AND status = 'paid' AND cancel_claim IS NOT DISTINCT FROM ${claim}
        RETURNING id`;
      if (!flipped.length) continue;
      done.push(r);
      try { await sql`UPDATE order_cohost_shares SET amount = round(${s.hostPayout}::numeric * percent / 100) WHERE order_id = ${r.id}`; }
      catch (err) { /* no co-host shares table */ }
      await logAudit(sql, { action: 'booking_cancelled_by_guest', success: true, actorType: 'system', actorIdentifier: String(main.guest_id || ''),
        targetType: 'order', targetId: r.id, metadata: { percent, by, refundCash: s.refundCash, couponBack: s.couponBack, hostPayout: s.hostPayout, policy: policyKey(main.policy) } });
    }
    if (!done.length) throw Object.assign(new Error('This booking has already been cancelled.'), { isUserFacing: true, status: 409 });
  } catch (err) {
    await releaseClaim(sql, ids, claim);
    throw err;
  }

  const sum = (k) => done.reduce((t, r) => t + splits.get(Number(r.id))[k], 0);
  const refundCash = sum('refundCash'), couponBack = sum('couponBack'), hostShare = sum('hostPayout');
  if (couponBack > 0) await returnCouponValue(sql, { razorpayOrderId: main.razorpay_order_id, amount: couponBack, sourceOrderId: main.id, guestEmail: main.guest_email, suiteName: main.suite_name });

  const when = `${dateStr(main.arrival)} → ${dateStr(main.departure)}`;
  await email(main.guest_email, `Your booking at ${main.suite_name} is cancelled`,
    `<div style="font-family:sans-serif; max-width:480px;"><h2 style="font-family:Georgia,serif;">Your booking is cancelled</h2>
      <p><strong>${escH(main.suite_name)}</strong> (${escH(when)})</p><p>${escH(reason)}.</p>
      <p>Refund to your original payment method: <strong>${inr(refundCash)}</strong>${couponBack > 0 ? `, plus ${inr(couponBack)} returned as a coupon (sent separately)` : ''}. Refunds usually arrive in 5–7 working days. Aerva’s service fee is non-refundable.</p>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">Questions? Contact hello@aerva.in.</p></div>`);
  const host = (await sql`SELECT email FROM guests WHERE host_id = ${main.host_id} ORDER BY id LIMIT 1`)[0];
  await email(host && host.email, `Booking cancelled: ${main.suite_name}`,
    `<div style="font-family:sans-serif; max-width:480px;"><h2 style="font-family:Georgia,serif;">A booking was cancelled</h2>
      <p><strong>${escH(main.suite_name)}</strong> (${escH(when)}) — the dates are open again.</p>
      ${hostShare > 0 ? `<p>Your payout for this booking: <strong>${inr(hostShare)}</strong>, on the usual payout day.</p>` : ''}</div>`);
  await postThreadMessage(sql, main.id, 'host', `Cancellation confirmed. Refund to the guest: ${inr(refundCash)}${couponBack > 0 ? ` plus ${inr(couponBack)} as a coupon` : ''}.`);
  return { ok: true, refundCash, couponBack, percent };
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
  if (!q.allowed && !EMERGENCY_REASONS[reasonCode]) return { error: q.error, status: 400 };
  // Emergencies may be sent until check-out; everything else only before check-in.
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
  cancellationQuote, executePolicyCancellation, returnCouponValue, hostCancellationsLastYear, settleUnansweredRequests
};
