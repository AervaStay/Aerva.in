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
// (host-listings.js).
// FREE CANCELLATION ADD-ON (_pricing.js, owner 9 Nov 2026): while a booking
// with the add-on is more than 48 hours before its check-in moment, a
// guest's "change of plans" request is not a request: it cancels at once at
// 100% (booking price, GST, deposit). The add-on and its GST are never
// refunded on a guest's cancellation (any bracket): the host keeps the
// add-on less Aerva's commission (payout_on_cancel). Only when the host is
// at fault (Aerva cancelling for the host, the check-in promise) does the
// add-on go back to the guest with everything else. An "Includes a Stay" experience and its stay are one
// purchase and are always cancelled together.
// GROUP BOOKINGS (split payment, owner's final rules, 10 Nov 2026): once
// confirmed they are NON-REFUNDABLE. The organiser's cancellation for any
// reason but a natural disaster / government order goes through at once
// (no host answer) with no refund of the price, GST or fee, whatever the
// listing's policy; the deposit goes back to the payments as always, and the
// host is paid as for a normal stay (by 'group_no_refund'). A natural
// disaster approved by Aerva, a host cancellation or Aerva cancelling for the
// host gives EACH PAYER their own share as Aerva credit
// (_fee-credits.js creditForGroupPayers); the check-in promise refunds each
// payer in full to their own payment (_refunds.js spreads it).

const { helpLine } = require('./_help-link');
const crypto = require('crypto');
const { safeRefund, refundAcrossPayments, hasChangePayments } = require('./_refunds');
const { refundSubunitForInr } = require('./_currency');
const { logAudit } = require('./_audit-log');
const { paidByOrderRow, dateStr, daysBeforeCheckIn } = require('./_booking-rules');
const { addOnOf, freeCancelActive, freeCancelUntilMs, freeCancelLabel } = require('./_pricing');

const POLICIES = {
  flexible: { label: 'Flexible', tiers: [{ minDays: 30, pct: 100 }, { minDays: 10, pct: 80 }, { minDays: 5, pct: 50 }, { minDays: 2, pct: 30 }] },
  firm:     { label: 'Firm',     tiers: [{ minDays: 30, pct: 100 }, { minDays: 5, pct: 50 }] }
};
const HOST_DECISION_TIMEOUT_HOURS = 24;
// Free cancellation add-on: is Aerva's guest service fee refunded when a
// guest cancels inside the add-on's window? The owner's rule today (9 Nov
// 2026): no — the existing rule that the service fee is not refunded when a
// guest cancels applies. The owner may decide otherwise: set this to true
// and the fee (with its GST) is refunded with the booking price, GST and
// deposit on a free cancellation (quote, refund and emails follow).
const FREE_CANCEL_REFUNDS_SERVICE_FEE = false;
const HOST_CANCELLATIONS_PER_YEAR = 3;
const GROUP_NO_REFUND_SUMMARY = 'Non-refundable group booking: if plans change, nothing is refunded, whatever the listing’s policy (any deposit is refunded to each payer). A natural disaster or government order approved by Aerva, or a cancellation by the host, gives each payer their own share as Aerva credit; Aerva’s check-in promise refunds each payer in full.';

const TRANSFERRED_NO_CANCEL = 'This booking was transferred, so it cannot be cancelled — as agreed when the transfer was confirmed. If something is not working, raise a request in the Resolution Center (Help → Raise a request); Aerva will look at it and decide.';
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
    : 'Flexible: full refund 30+ days before check-in; 80% from 10 to 29 days; 50% from 5 to 9 days; 30% from 2 to 4 days; less than 2 days before, the host decides. Aerva’s service fee is non-refundable; the deposit is always refunded.';
}

// One row's split at `pct`. couponAbsorbed: the part of its booking price
// paid by coupon (allocatePaid). All whole rupees.
// The deposit is refunded with a cancellation only while Aerva still holds
// it. Once it has been refunded (or is being refunded, or was settled in a
// dispute) it is never included again — no deposit is ever refunded twice.
function depositStillHeld(row) {
  return ['held', 'disputed'].includes(String(row.deposit_status || ''));
}

// opts.refundAddOn: the free cancellation add-on (and its GST) goes back to
// the guest too — only when the host is at fault. Otherwise it stays with
// the host (less its commission, already inside commission_amount).
function splitRow(row, couponAbsorbed, pct, { refundAddOn = false } = {}) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0)) / 100;
  const subtotal = Math.max(0, Math.round(Number(row.subtotal) || 0));
  const absorbed = Math.max(0, Math.min(subtotal, Math.round(Number(couponAbsorbed) || 0)));
  const refundBooking = Math.round((subtotal - absorbed) * p);
  const couponBack = Math.round(absorbed * p);
  const refundGst = Math.round((Math.round(Number(row.gst) || 0)) * p);
  const deposit = depositStillHeld(row) ? Math.max(0, Math.round(Number(row.deposit_amount) || 0)) : 0;
  const retained = Math.max(0, subtotal - refundBooking - couponBack);
  const fc = addOnOf(row);
  const stayCommission = Math.max(0, Math.round(Number(row.commission_amount) || 0) - fc.commission);
  const addOnBack = refundAddOn ? fc.fee + fc.gst : 0;
  const addOnCommission = refundAddOn ? 0 : fc.commission;
  const commission = (subtotal > 0 ? Math.round(stayCommission * retained / subtotal) : 0) + addOnCommission;
  return {
    refundCash: refundBooking + refundGst + deposit + addOnBack, refundBooking, refundGst, couponBack, deposit,
    feeKept: Math.max(0, Math.round(Number(row.guest_service_fee) || 0)),
    addOnKept: refundAddOn ? 0 : fc.fee + fc.gst, addOnBack,
    retained, commission, hostPayout: retained + (refundAddOn ? 0 : fc.fee) - commission
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
  // A transferred booking: the guest cannot cancel any part of it (owner's
  // rule, 9 Nov 2026). Aerva Support can look at it; Aerva decides.
  if (guestId != null && main.transfer_change_id) {
    return { orderId: main.id, allowed: false, transferred: true, error: TRANSFERRED_NO_CANCEL };
  }
  // Free cancellation add-on still in its window: 100%, at once.
  const fcNow = freeCancelActive(main, main.listing_timezone, main.listing_check_in_time);
  // A group booking: non-refundable once confirmed — 0%, at once (no host answer).
  const groupNoRefund = !!main.group_booking_id;
  const t0 = policyTier(main.policy, main.days_before);
  const tier = groupNoRefund ? (t0.started ? t0 : { pct: 0 }) : fcNow ? { pct: 100 } : t0;
  const fcRow = addOnOf(main);
  const base = {
    orderId: main.id, policy: policyKey(main.policy), policyLabel: POLICIES[policyKey(main.policy)].label,
    policySummary: groupNoRefund ? GROUP_NO_REFUND_SUMMARY : policySummary(main.policy), daysBefore: Number(main.days_before),
    ...(groupNoRefund ? { groupNoRefund: true, policyLabel: 'Non-refundable group booking' } : {}),
    items: rows.map(r => r.suite_name),
    // The add-on on this booking (null without one): until when, what it cost.
    freeCancel: (fcRow.fee > 0 || fcRow.included) ? (() => { const ms = freeCancelUntilMs(main.arrival, main.listing_timezone, main.listing_check_in_time);
      return { active: fcNow, until: Number.isFinite(ms) ? new Date(ms).toISOString() : null, untilLabel: freeCancelLabel(ms, main.listing_timezone), fee: fcRow.fee, gst: fcRow.gst, included: fcRow.included }; })() : null
  };
  // What a natural disaster approved by Aerva would give (the guest's own quote only).
  if (!tier.started && guestId != null) base.naturalDisaster = await disasterOutcome(sql, main.id);
  if (tier.started) return { ...base, allowed: false, started: true, error: 'This stay has already started, so it cannot be cancelled. To leave early, change your check-out date in My Bookings — possible until 10 AM on the day after check-in.' };
  const paid = await paidByOrderRow(sql, main.razorpay_order_id);
  const total = (pct) => rows.reduce((t, r) => {
    const s = dropCouponBack(creditPart(splitRow(r, (paid[r.id] || {}).couponAbsorbed, pct), r, paid[r.id]));
    t.couponLost += s.couponLost;
    t.refundCash += s.refundCash; t.couponBack += s.couponBack; t.deposit += s.deposit; t.feeKept += s.feeKept; t.creditBack += s.creditBack;
    t.refundBooking += s.refundBooking + s.refundGst;
    t.addOnKept += s.addOnKept;
    return t;
  }, { refundCash: 0, couponBack: 0, couponLost: 0, deposit: 0, feeKept: 0, refundBooking: 0, creditBack: 0, addOnKept: 0 });
  if (tier.hostDecides) {
    return { ...base, allowed: true, hostDecides: true, pct: null, ifNoRefund: total(0), ifFullRefund: total(100) };
  }
  const t = total(tier.pct);
  if (fcNow && FREE_CANCEL_REFUNDS_SERVICE_FEE) { t.refundCash += t.feeKept; t.feeRefunded = t.feeKept; t.feeKept = 0; }
  return { ...base, allowed: true, hostDecides: false, pct: tier.pct, instant: fcNow || groupNoRefund, ...t };
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
            <p style="font-size:12px; opacity:0.6; margin-top:24px;">${helpLine({ order: sourceOrderId }, 'Questions?')}</p></div>` }) });
    }
    return created;
  } catch (err) {
    console.error('coupon value not returned (needs manual follow-up):', sourceOrderId, err);
    await logAudit(sql, { action: 'coupon_value_restore_failed', success: false, actorType: 'system', targetType: 'order', targetId: Number(sourceOrderId) || null,
      metadata: { error: String(err.message || err).slice(0, 300) } });
    return null;
  }
}

// The coupon a host must pay for first when Aerva cancels for them
// (_host-cancel-confirm.js): 10% of the booking (deposit aside), only within
// 48 hours of check-in (the same rule as a host's own cancellation), none
// for the experience half of a pair. ₹. Aerva never pays it on the host's
// behalf or deducts it from a payout (owner, 10 Nov 2026).
async function hostCouponAmount(sql, orderId) {
  const o = (await sql`SELECT o.id, o.guest_id, o.total, COALESCE(o.deposit_amount, 0) AS deposit, COALESCE(o.order_type, 'stay') AS order_type, o.arrival,
                              o.arrival::text AS arrival_day, o.created_at AS booked_at, l.timezone, l.check_in_time
                       FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${Number(orderId) || 0}`)[0];
  if (!o || !o.guest_id) return 0;
  const { hoursUntilCheckInTime } = require('./_booking-rules');
  if (!(hoursUntilCheckInTime(o.arrival, o.timezone, o.check_in_time) < 48)) return 0;
  if (require('./_booking-rules').sameDayGrace(o.arrival_day, o.booked_at, o.timezone)) return 0;
  const sibs = await linkedSiblings(sql, o.id);
  if (sibs.length && o.order_type === 'experience') return 0;
  return Math.max(1, Math.round(Math.max(0, Number(o.total) - Number(o.deposit)) * 0.10));
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
async function executePolicyCancellation(sql, razorpay, { orderId, pct, by, note = '', refundFee = false, feeReason = '', countAgainstHost = false, adminLabel = null, preview = false, asCredit = false }) {
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
  catch (err) { throw Object.assign(new Error('Cancellations are being set up. Please try again later, or raise a request in the Resolution Center (Help → Raise a request).'), { isUserFacing: true, status: 503 }); }

  const reason = by === 'group_no_refund'
    ? 'Cancelled by the organiser — a group booking is non-refundable: no refund of the price, GST or service fee (any deposit is refunded to each payer); the host is paid as for a normal stay'
    : by === 'free_cancel'
    ? `Cancelled by the guest with free cancellation — booking price, GST and any deposit refunded in full; ${FREE_CANCEL_REFUNDS_SERVICE_FEE ? 'the add-on is' : 'the add-on and Aerva’s service fee are'} not refunded`
    : by === 'admin'
    ? `Cancelled by Aerva${note ? ' — ' + note : ''}`
    : by === 'natural_disaster'
    ? 'Cancelled at the guest’s request (natural disaster) — approved by Aerva; everything paid is held as Aerva credit (usable for new dates, or refundable to the original payment at any time)'
    : by === 'aerva_emergency'
    ? `Cancelled at the guest’s request (emergency) — approved by Aerva, booking price refunded in full`
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
  // The free cancellation add-on goes back only when the host is at fault:
  // Aerva cancelling for the host (countAgainstHost) — the check-in promise
  // included. On a guest's cancellation, any bracket, the host keeps it.
  // A natural disaster approved by Aerva (owner, 10 Nov 2026): price, GST,
  // service fee and add-on become ordinary Aerva credit (refundable to the
  // original payment whenever the guest asks, owner 01:25); the security
  // deposit is ALWAYS refunded to the payment, never credit (owner, 01:29);
  // a coupon part comes back as a coupon; no host payout. A group booking (paid by several
  // people, _group-bookings.js) cannot be held as one person's credit: each
  // payer is refunded their share of everything instead.
  const disaster = by === 'natural_disaster';
  // A group booking: credit goes to each payer's own account (below).
  const groupBooking = rows.some(r => r.group_booking_id != null);
  const refundAddOn = (by === 'admin' && !!countAgainstHost) || disaster;
  const splits = new Map(rows.map(r => {
    const s = splitRow(r, (paid[r.id] || {}).couponAbsorbed, percent, { refundAddOn });
    // Aerva's own fee, returned only when an admin chooses to.
    // Aerva's service fee is not refunded — except when an admin decides so,
    // case by case, with a recorded reason (refundFee + feeReason).
    if (((by === 'admin' && refundFee) || (by === 'free_cancel' && FREE_CANCEL_REFUNDS_SERVICE_FEE) || disaster) && s.feeKept > 0) { s.refundCash += s.feeKept; s.feeRefunded = s.feeKept; s.feeKept = 0; }
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
    if (!(by === 'admin' && countAgainstHost) && !disaster) dropCouponBack(s);
    // asCredit (Aerva cancelling for a host): only the deposit goes back to
    // the payment; everything else the guest paid is held for them as Aerva
    // credit after the cancellation (_fee-credits.js creditForWholeBooking).
    if (asCredit && (r.charge_currency || 'INR') === 'INR') {
      s.heldAsCredit = Math.max(0, s.refundCash - s.deposit) + (s.creditBack || 0);
      s.refundCash = s.deposit; s.creditBack = 0;
    }
    // A natural disaster: everything but the deposit becomes credit, in any
    // currency (credit is in rupees); the deposit goes back to the payment.
    if (disaster) {
      s.heldAsCredit = Math.max(0, s.refundCash - s.deposit) + (s.creditBack || 0);
      s.refundCash = s.deposit; s.creditBack = 0;
    }
    return [Number(r.id), s];
  }));
  const ids = rows.map(r => Number(r.id));
  if (preview) {
    const t = (k) => [...splits.values()].reduce((a, s) => a + (s[k] || 0), 0);
    return { preview: true, percent, items: rows.map(r => r.suite_name), refundCash: t('refundCash'), couponBack: t('couponBack'), couponLost: t('couponLost'), heldAsCredit: t('heldAsCredit'), deposit: t('deposit'), addOnKept: t('addOnKept'), addOnBack: t('addOnBack'),
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
          if (!amount && s.refundCash > 0) throw Object.assign(new Error(`There is no record of the amount charged in ${currency} for this booking, so it cannot be refunded automatically. Please raise a request in the Resolution Center (Help → Raise a request).`), { isUserFacing: true, status: 502 });
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
  // The add-on refunded with everything else (host at fault): recorded, so
  // Accounts no longer counts its GST as payable.
  const addOnBackIds = done.filter(r => (splits.get(Number(r.id)).addOnBack || 0) > 0).map(r => Number(r.id));
  if (addOnBackIds.length) {
    try { await sql`UPDATE orders SET free_cancel_refunded = true WHERE id = ANY(${addOnBackIds})`; }
    catch (err) { console.error('free cancellation refund not recorded (needs follow-up):', addOnBackIds, err.message); }
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
        await markCancelledByHost(sql, r.id);
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
  let heldAsCredit = 0;
  const FC = require('./_fee-credits');
  // A group booking: each payer's own share, in their own account.
  const credit = (reasonCode) => groupBooking ? FC.creditForGroupPayers(sql, main.id, reasonCode) : FC.creditForWholeBooking(sql, done.map(r => Number(r.id)), reasonCode);
  if (disaster) {
    try { const h = await credit('natural_disaster'); heldAsCredit = (h.total || 0) + (h.back || 0); }
    catch (err) {
      console.error('Aerva credit for a natural disaster not made (needs follow-up):', main.id, err.message);
      await logAudit(sql, { action: 'disaster_credit_failed', success: false, actorType: 'system', targetType: 'order', targetId: main.id, metadata: { error: String(err.message || err).slice(0, 300) } });
    }
  }
  if (asCredit) {
    try { const h = await credit('host_cancelled_late'); heldAsCredit = (h.total || 0) + (h.back || 0); }
    catch (err) { console.error('Aerva credit for a cancellation by Aerva for the host not made (needs follow-up):', main.id, err.message); }
  }

  const when = `${require('./_booking-rules').niceDay(main.arrival)} → ${require('./_booking-rules').niceDay(main.departure)}`;
  await email(main.guest_email, `Your booking at ${main.suite_name} is cancelled`,
    `<div style="font-family:sans-serif; max-width:480px;"><h2 style="font-family:Georgia,serif;">Your booking is cancelled</h2>
      <p><strong>${escH(main.suite_name)}</strong> (${escH(when)})</p><p>${escH(reason)}.</p>
      ${by === 'group_no_refund' ? `<p>This group booking is non-refundable, so nothing is refunded for the stay, its GST or Aerva’s service fee.${refundCash > 0 ? ` The security deposit (${inr(refundCash)}) is refunded to the payments it came from.` : ''} Everyone in the group has been told.</p>`
        : disaster && groupBooking ? `<p>Each person who paid gets their own share as Aerva credit in their own account (emailed separately) — usable for new dates, or refunded to their own payment at any time from My Bookings.${refundCash > 0 ? ` The security deposit (${inr(refundCash)}) is refunded to the payments it came from.` : ''}</p>`
        : disaster ? `<p>What you paid${heldAsCredit > 0 ? ` — <strong>${inr(heldAsCredit)}</strong>, including GST and Aerva’s service fee —` : ''} is held for you as Aerva credit${couponBack > 0 ? `, and ${inr(couponBack)} paid by coupon comes back as a new coupon (sent separately)` : ''}. Use it for new dates on any stay or experience on Aerva (it comes off the price automatically), or have it refunded to your original payment method at any time from My Bookings.${refundCash > 0 ? ` Your security deposit of ${inr(refundCash)} is refunded to your original payment method now.` : ''}</p>`
        : asCredit && groupBooking ? `<p>Each person who paid gets their own share as Aerva credit in their own account (emailed separately): use it on another booking, or have it refunded to their own payment at any time from My Bookings.${refundCash > 0 ? ` The deposit (${inr(refundCash)}) is refunded to the payments it came from.` : ''}</p>`
        : asCredit ? `<p>Everything you paid${heldAsCredit > 0 ? ` — <strong>${inr(heldAsCredit)}</strong>` : ''} is held for you as Aerva credit (details in a separate email): use it on another booking, or have it refunded to your original payment method at any time from My Bookings.${refundCash > 0 ? ` Your deposit of ${inr(refundCash)} is refunded to your original payment method.` : ''}</p>` : `<p>Refund to your original payment method: <strong>${inr(refundCash)}</strong>${couponBack > 0 ? `, plus ${inr(couponBack)} returned as a coupon (sent separately)` : ''}${creditBack > 0 ? `, plus ${inr(creditBack)} back on your Aerva credit (the part paid with it; see My Bookings)` : ''}. Refunds usually arrive in 5–7 working days.${sum('couponLost') > 0 ? ` The ${inr(sum('couponLost'))} paid by coupon is not returned: a coupon comes back only when the host cancels.` : ''}${sum('feeRefunded') > 0 ? ' This includes Aerva’s service fee.' : ' Aerva’s service fee is non-refundable.'}${sum('addOnKept') > 0 ? ' The free cancellation add-on is not refunded.' : ''}</p>`}
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">${helpLine({ order: main.id }, 'Questions?')}</p></div>`);
  const host = (await sql`SELECT email FROM guests WHERE host_id = ${main.host_id} ORDER BY id LIMIT 1`)[0];
  await email(host && host.email, `Booking cancelled: ${main.suite_name}`,
    `<div style="font-family:sans-serif; max-width:480px;"><h2 style="font-family:Georgia,serif;">A booking was cancelled</h2>
      <p><strong>${escH(main.suite_name)}</strong> (${escH(when)}) — the dates are open again.</p>
      ${hostShare > 0 ? `<p>Your payout for this booking: <strong>${inr(hostShare)}</strong>, on the usual payout day.</p>` : ''}</div>`);
  if (by === 'group_no_refund') {
    await postThreadMessage(sql, main.id, 'system', `The organiser cancelled this group booking. It is non-refundable: nothing is refunded for the stay${refundCash > 0 ? ` (the deposit, ${inr(refundCash)}, goes back to the payers)` : ''}. The host is paid as for a normal stay.`);
  } else if (disaster) {
    await postThreadMessage(sql, main.id, 'system', `Natural disaster: Aerva approved the cancellation. What the ${groupBooking ? 'payers' : 'guest'} paid (${inr(heldAsCredit)}) is held as Aerva credit${groupBooking ? ', each payer’s own share in their own account' : ' for the guest'} (new dates, or a refund to their original payment at any time)${couponBack > 0 ? `, plus ${inr(couponBack)} back as a coupon` : ''}${refundCash > 0 ? `; the deposit (${inr(refundCash)}) is refunded to their payment` : ''}. There is no payout for this booking. Aerva’s decision is final.`);
  } else await postThreadMessage(sql, main.id, (by === 'admin' || by === 'aerva_emergency' || by === 'free_cancel' || by === 'group_no_refund' || disaster) ? 'system' : 'host', `${by === 'admin' ? 'Aerva cancelled this booking' : (by === 'aerva_emergency' || disaster) ? 'Cancellation approved by Aerva' : by === 'free_cancel' ? 'Cancelled with free cancellation (no host answer needed)' : 'Cancellation confirmed'}. Refund to the guest: ${inr(refundCash)}${couponBack > 0 ? ` plus ${inr(couponBack)} as a coupon` : ''}${creditBack > 0 ? ` plus ${inr(creditBack)} back on their Aerva credit` : ''}.`);
  // Everyone in a group is told what happens to their own share.
  if (groupBooking) {
    const G = require('./_group-bookings');
    await G.tellMembersAfterCancel(sql, main.id, by === 'group_no_refund'
      ? 'The organiser cancelled the group booking. It is non-refundable, so nothing is refunded for the stay; any deposit goes back to each payer’s own payment.'
      : disaster ? 'Aerva approved the cancellation (natural disaster or government order). Your own share is held as Aerva credit in your account — use it for new dates, or refund it to your own payment any time from My Bookings. Any deposit goes back to your payment.'
      : asCredit ? 'The booking was cancelled for the host. Your own share is held as Aerva credit in your account — use it on another booking, or refund it to your own payment any time from My Bookings.'
      : `The booking was cancelled. ${refundCash > 0 ? 'Each payer is refunded their share to their own payment.' : ''}`.trim());
  }
  return { ok: true, refundCash, couponBack, creditBack, heldAsCredit, percent, groupBooking };
}

// Host cancellations in the last 12 months (co-host cancellations count for
// the host). Linked "Includes a Stay" halves are logged separately and do
// not count twice.
// Marks a booking as cancelled by its host (or by Aerva for the host), for
// the property's host cancellation rate. Never throws.
async function markCancelledByHost(sql, orderId) {
  try { await sql`UPDATE orders SET cancelled_by_host_at = COALESCE(cancelled_by_host_at, now()) WHERE id = ${Number(orderId) || 0}`; }
  catch (e) { /* 2026-10-28-05-host-cancel-rate.sql not applied yet */ }
}

// Host cancellation rate per property: bookings made in the last 12 months
// that the host cancelled, out of all bookings made then. 0% with no
// cancellations (and with no bookings yet). { [listingId]: { rate, cancelled, bookings } }
async function listingCancelRates(sql, listingIds) {
  const ids = (listingIds || []).map(Number).filter(Boolean);
  const out = {};
  ids.forEach(id => { out[id] = { rate: 0, cancelled: 0, bookings: 0 }; });
  if (!ids.length) return out;
  try {
    const rows = await sql`SELECT listing_id, count(*)::int AS n, count(*) FILTER (WHERE cancelled_by_host_at IS NOT NULL)::int AS c
                           FROM orders WHERE listing_id = ANY(${ids}) AND razorpay_payment_id IS NOT NULL AND status IN ('paid', 'cancelled')
                             AND created_at > now() - interval '12 months'
                           GROUP BY listing_id`;
    rows.forEach(r => { out[r.listing_id] = { rate: r.n > 0 ? Math.round(r.c / r.n * 1000) / 10 : 0, cancelled: r.c, bookings: r.n }; });
  } catch (e) { /* column not there yet: every rate 0% */ }
  return out;
}
// The same for a host across all their properties (for badges).
async function hostCancelRates(sql, hostIds, asOf = null) {
  const ids = (hostIds || []).map(Number).filter(Boolean);
  const out = {};
  if (!ids.length) return out;
  try {
    const at = asOf ? new Date(asOf).toISOString() : new Date().toISOString();
    const rows = await sql`SELECT l.host_id, count(*)::int AS n, count(*) FILTER (WHERE o.cancelled_by_host_at IS NOT NULL)::int AS c
                           FROM orders o JOIN listings l ON l.id = o.listing_id
                           WHERE l.host_id = ANY(${ids}) AND o.razorpay_payment_id IS NOT NULL AND o.status IN ('paid', 'cancelled')
                             AND o.created_at > ${at}::timestamptz - interval '12 months' AND o.created_at <= ${at}::timestamptz
                           GROUP BY l.host_id`;
    rows.forEach(r => { out[r.host_id] = r.n > 0 ? Math.round(r.c / r.n * 1000) / 10 : 0; });
  } catch (e) { /* not there yet */ }
  return out;
}

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
//   change_of_plans, fixed bracket  → Accept (refund P%) / Reject (booking stands, no refund)
//   change_of_plans, last window    → choose 0–100% / Reject (no refund)
//   natural disaster                → nothing for the host: Aerva decides (below)
// Unanswered after 24 hours: a fixed bracket is accepted at its P%; the last
// window is settled with no refund of the booking price. Whatever is still
// open when the stay starts closes then: the booking stands
// (closeRequestsAtCheckin).
// Once the stay has started no one sees Accept / Reject any more.
//
// THE OWNER'S RULES OF 10 NOV 2026 (replacing the emergency rules of 4–9 Nov):
//   • Only natural-disaster reasons are left: a NATURAL DISASTER (code
//     'environmental') and a GOVERNMENT ORDER OR TRAVEL RESTRICTION (code
//     'travel_restriction', counted as a natural disaster — owner, 00:52),
//     any time before check-in, with proof. Aerva checks
//     the proof and decides; the host cannot decline it (they are told and
//     can add information in the thread). No reminders to the host.
//       approved → what the guest paid — booking price, GST, Aerva's
//         service fee and any free cancellation add-on — becomes
//         ordinary Aerva credit (_fee-credits.js reason 'natural_disaster',
//         owner 01:25): used for new dates, or refunded to the original
//         payment whenever the guest asks. A part paid by coupon comes back
//         as a coupon; a part paid with earlier Aerva credit goes back onto
//         that credit. The security deposit is refunded to the payment
//         (never credit, owner 01:29). The host gets no payout.
//       rejected → nothing changes, the booking stands.
//   • Change of plans: the listing's brackets as above. Host rejects → no
//     refund. Aerva's service fee is never refunded; the host keeps what is
//     not refunded, and Aerva's commission is on what the host receives.
//   • Removed: "Medical or family emergency", "Life-threatening situation"
//     (RETIRED_REASONS — old rows
//     still show and finish: host Accept = price, GST and deposit back;
//     unanswered ones go through _emergency-escalation.js as before), the
//     last-minute 25% / 50% host choices, the guest's "ask Aerva to review a
//     host's decline" (a review already asked for can still be decided), and
//     the emergency service-fee credit.
// Natural-disaster reasons (owner, 10 Nov 2026 00:52: a government order
// or travel restriction counts as a natural disaster too).
const EMERGENCY_REASONS = {
  environmental: 'Natural disaster (flood, cyclone, earthquake, landslide, fire)',
  travel_restriction: 'Government order or travel restriction (lockdown, road closed by authorities)'
};
const RETIRED_REASONS = {
  life_threatening: 'Life-threatening situation',
  emergency: 'Medical or family emergency'
};
// Offered for new requests.
const REQUEST_REASONS = Object.assign({ change_of_plans: 'Change of plans' }, EMERGENCY_REASONS);
// Every reason a request in the database may carry (for showing it).
const REASON_LABELS = Object.assign({}, REQUEST_REASONS, RETIRED_REASONS);
// Requests that come to Aerva: the natural disaster, and old emergency
// requests still open from before 10 Nov 2026.
const AERVA_REASONS = Object.assign({}, EMERGENCY_REASONS, RETIRED_REASONS);
const isDisaster = (rq) => !!rq && !!EMERGENCY_REASONS[rq.reason_code];
const isLegacyEmergency = (rq) => !!rq && !!RETIRED_REASONS[rq.reason_code];

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
//   disaster  → nothing to answer: Aerva decides (information only);
//   emergency → an old request with a removed reason: Accept (price, GST
//               and deposit back) / Reject (booking stands);
//   fixed     → Accept (refund P%) / Reject (booking stands, no refund);
//   choose    → the last window: 0–100% / Reject (no refund).
function hostOption(rq) {
  if (isDisaster(rq)) return { type: 'disaster' };
  if (isLegacyEmergency(rq)) return { type: 'emergency', percent: 100 };
  if (rq.reason_code === 'late_cancellation' || rq.policy_percent == null) return { type: 'choose' };
  return { type: 'fixed', percent: Number(rq.policy_percent) };
}

// What a natural disaster approved now would give: { credit, coupon,
// cash } — Aerva credit, a coupon for the part
// paid by coupon, and money only for a group booking (paid by several
// people, see executePolicyCancellation). Changes nothing.
async function disasterOutcome(sql, orderId) {
  try {
    const p = await executePolicyCancellation(sql, null, { orderId, pct: 100, by: 'natural_disaster', preview: true });
    return { credit: (p.heldAsCredit || 0), coupon: p.couponBack || 0, cash: p.refundCash || 0 };
  } catch (err) { return { credit: 0, coupon: 0, cash: 0 }; }
}

// The guest sends a request. Returns { request } or { error, status }.
async function createCancellationRequest(sql, { orderId, guestId, reasonCode, details, evidence, razorpay = null }) {
  // Only the reasons offered now (owner, 10 Nov 2026): change of plans, or a
  // natural disaster. The removed ones are refused for new requests.
  if (RETIRED_REASONS[reasonCode]) return { error: 'This reason is no longer offered. Choose “Change of plans”, or “Natural disaster” with proof.', status: 400 };
  if (!REQUEST_REASONS[reasonCode]) return { error: 'Choose a reason.', status: 400 };
  // A natural disaster comes with proof: a photo, a news report or an
  // official notice — Aerva's own uploads only (blob-upload.js purpose
  // 'cancellation-proof'), up to 5.
  const q = await cancellationQuote(sql, orderId, guestId);
  if (q.status) return { error: q.error, status: q.status };
  if (q.transferred) return { error: q.error, status: 400 };      // a natural disaster included: Aerva Support decides
  const disaster = !!EMERGENCY_REASONS[reasonCode];
  const proof = disaster ? require('./_listing-rules').aervaBlobUrlsOnly(Array.isArray(evidence) ? evidence : [], 5) : [];
  if (disaster && !proof.length) return { error: 'Please attach proof (for example a photo, a news report, or the official order or notice).', status: 400 };
  // Only before check-in, a natural disaster included. Once the stay has
  // started the guest changes the booking instead (_booking-changes.js).
  if (!q.allowed && (!disaster || q.started)) return { error: q.error, status: 400 };
  const o = (await sql`SELECT o.suite_name, o.arrival, o.departure, l.host_id,
                              (o.departure < (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date) AS ended
                       FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${orderId}`)[0];
  if (o.ended) return { error: 'This stay has already ended.', status: 400 };
  const policyPercent = reasonCode === 'change_of_plans' ? (q.hostDecides ? null : q.pct) : null;
  // Free cancellation add-on, inside its window: the guest's change of plans
  // cancels at once at 100% — nothing for the host to answer.
  // One request at a time (owner, 11 Nov 2026): while a change to this
  // booking is waiting (for the host, or for payment), it cannot be cancelled.
  try {
    const openChange = await sql`SELECT 1 FROM booking_changes WHERE order_id = ${orderId} AND status IN ('pending', 'awaiting_payment') LIMIT 1`;
    if (openChange.length) return { error: 'You have asked to change this booking. Wait for your host’s answer, or withdraw the change, before asking to cancel.', status: 409, reason: 'change_open' };
  } catch (e) { /* before the booking-changes update */ }
  const instant = reasonCode === 'change_of_plans' && q.instant === true && !!razorpay;
  const clean = String(details || '').trim().slice(0, 800);
  let request;
  try {
    request = (await sql`INSERT INTO cancellation_requests (order_id, guest_id, reason_code, details, policy_percent, days_before)
                         VALUES (${orderId}, ${guestId}, ${reasonCode}, ${clean || null}, ${policyPercent}, ${Number.isFinite(q.daysBefore) ? q.daysBefore : null})
                         RETURNING *`)[0];
  } catch (err) {
    if (/idx_cancel_requests_open|duplicate key/.test(err.message)) {
      // The open one may be with Aerva (a natural disaster or government order), not the host.
      let withAerva = false;
      try { const open = (await sql`SELECT * FROM cancellation_requests WHERE order_id = ${orderId} AND status = 'pending' ORDER BY id DESC LIMIT 1`)[0]; withAerva = !!(open && isDisaster(open)); } catch (e) { /* the host wording */ }
      return { error: withAerva ? 'You already have a cancellation request waiting for Aerva’s decision.' : 'You already have a request waiting for the host.', status: 409 };
    }
    throw err;
  }
  if (proof.length) {
    try { await sql`UPDATE cancellation_requests SET evidence = ${JSON.stringify(proof)}::jsonb WHERE id = ${request.id}`; }
    catch (err) { if (err && err.code === '42703') { await sql`DELETE FROM cancellation_requests WHERE id = ${request.id}`; return { error: 'Natural-disaster cancellations are being updated. Please try again shortly, or raise a request in the Resolution Center (Help → Raise a request).', status: 503 }; } throw err; }
  }
  if (disaster) {
    // Straight to Aerva: no host answer, no reminders. The host is told and
    // can add information in the booking's thread.
    await logAudit(sql, { action: 'guest_cancellation_requested', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'order', targetId: orderId,
      metadata: { reasonCode, natural_disaster: true, daysBefore: q.daysBefore, proof: proof.length } });
    await postThreadMessage(sql, orderId, 'guest', `I’d like to cancel this booking: ${EMERGENCY_REASONS[reasonCode]}. I have sent proof to Aerva.${clean ? ' ' + clean : ''}`);
    await postThreadMessage(sql, orderId, 'system', 'Natural disaster: Aerva checks the guest’s proof and decides. If Aerva approves, everything the guest paid becomes Aerva credit for the guest (for new dates, or refunded to their payment whenever they ask) and there is no payout for this booking; if not, the booking stands. Host: you can add anything Aerva should know here in Messages.');
    const host = (await sql`SELECT email FROM guests WHERE host_id = ${o.host_id} ORDER BY id LIMIT 1`)[0];
    const stay = `<strong>${escH(o.suite_name)}</strong> (${escH(require('./_booking-rules').niceDay(o.arrival))} → ${escH(require('./_booking-rules').niceDay(o.departure))})`;
    await email(host && host.email, `Natural disaster: your guest asked to cancel ${o.suite_name}`,
      `<div style="font-family:sans-serif; max-width:480px;"><p>Your guest asked to cancel ${stay} because of a natural disaster, with proof.</p>
        <p>Aerva checks the proof and decides; there is nothing for you to accept or decline. If Aerva approves, everything the guest paid becomes Aerva credit for the guest (for new dates, or refunded to their payment whenever they ask) and there is no payout for this booking. If not, the booking stands.</p>
        <p>You can add anything Aerva should know in the booking’s Messages.</p>
        <p><a href="https://aerva.in/index.html?view=messages" style="color:#8a6c39;">Open Messages</a></p></div>`);
    await email(process.env.SUPPORT_EMAIL || process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in', `DECIDE — natural disaster cancellation #${orderId}`,
      `<p>A guest asked to cancel ${stay} because of a natural disaster and attached ${proof.length} proof file${proof.length === 1 ? '' : 's'}. Check the proof and decide in Admin → Approvals → Natural disaster cancellations before check-in.</p>`);
    return { request };
  }
  if (instant) {
    if (!(await claimRequest(sql, request.id))) return { error: 'This booking is already being cancelled.', status: 409 };
    let out;
    try { out = await executePolicyCancellation(sql, razorpay, q.groupNoRefund ? { orderId, pct: 0, by: 'group_no_refund' } : { orderId, pct: 100, by: 'free_cancel' }); }
    catch (err) {
      // Not cancelled: the request is withdrawn (nothing for the host to answer).
      await sql`UPDATE cancellation_requests SET status = 'withdrawn', decided_at = now(), host_note = ${'Free cancellation could not be completed: ' + String(err.message || err).slice(0, 200)} WHERE id = ${request.id}`.catch(() => {});
      if (err.isUserFacing) return { error: err.message, status: err.status || 400 };
      throw err;
    }
    await sql`UPDATE cancellation_requests SET status = 'accepted', refund_percent = ${q.groupNoRefund ? 0 : 100}, decided_at = now(), host_note = ${q.groupNoRefund ? 'Group booking: non-refundable, cancelled at once' : 'Free cancellation: cancelled at once'} WHERE id = ${request.id}`;
    await logAudit(sql, { action: q.groupNoRefund ? 'group_booking_cancelled_no_refund' : 'guest_free_cancellation', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'order', targetId: orderId,
      metadata: { requestId: request.id, refundCash: out.refundCash, couponBack: out.couponBack || 0, creditBack: out.creditBack || 0 } });
    return { request, cancelled: out };
  }
  await logAudit(sql, { action: 'guest_cancellation_requested', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'order', targetId: orderId,
    metadata: { reasonCode, policyPercent, daysBefore: q.daysBefore } });
  await postThreadMessage(sql, orderId, 'guest', `I’d like to cancel this booking. Reason: ${REQUEST_REASONS[reasonCode]}.${clean ? ' ' + clean : ''}`);
  const host = (await sql`SELECT email FROM guests WHERE host_id = ${o.host_id} ORDER BY id LIMIT 1`)[0];
  await email(host && host.email, `Cancellation request for ${o.suite_name}`,
    `<div style="font-family:sans-serif; max-width:480px;"><h2 style="font-family:Georgia,serif;">A guest has asked to cancel</h2>
      <p><strong>${escH(o.suite_name)}</strong> (${escH(require('./_booking-rules').niceDay(o.arrival))} → ${escH(require('./_booking-rules').niceDay(o.departure))})</p>
      <p>Please answer in Messages within ${HOST_DECISION_TIMEOUT_HOURS} hours.</p>
      <p><a href="https://aerva.in/index.html?view=messages" style="color:#8a6c39;">Open Messages</a></p></div>`);
  return { request };
}

// What the guest would get back at `percent` (cash, deposit included).
async function guestGetsBackFor(sql, orderId, percent) {
  const { rows } = await loadRows(sql, orderId);
  // (The add-on is never part of a guest's refund: splitRow keeps it.)
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
    // From check-in on, a booking can no longer be cancelled: no buttons
    // (the request itself is closed by closeRequestsAtCheckin).
    if (rq) {
      const q = await cancellationQuote(sql, o.id, null);
      if (q.started) return null;
    }
    if (role === 'host') {
      if (!rq) return null;
      const option = hostOption(rq);
      const card = { requestId: rq.id, orderId: o.id, reason: REASON_LABELS[rq.reason_code] || 'Cancellation', details: rq.details || '',
                     daysBefore: rq.days_before, option, evidence: Array.isArray(rq.evidence) ? rq.evidence : [] };
      // A natural disaster: information only — Aerva decides.
      if (option.type === 'disaster') { card.aervaDecides = true; card.disaster = await disasterOutcome(sql, o.id); return card; }
      if (option.type !== 'choose') card.guestGetsBack = await guestGetsBackFor(sql, o.id, option.percent);
      return card;
    }
    if (rq) return { orderId: o.id, pending: true, aervaDecides: isDisaster(rq) || !!rq.escalated_at };
    // A transferred booking cannot be cancelled by the guest (cancellationQuote
    // checks this only when given the guest): no "Request cancellation" button.
    if (o.transfer_change_id) return null;
    const q = await cancellationQuote(sql, o.id, null);
    // freeCancel: inside the add-on's window the guest cancels at once.
    return q.allowed ? { orderId: o.id, canRequest: true, freeCancel: q.instant ? { untilLabel: (q.freeCancel || {}).untilLabel || '' } : null } : null;
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

// ---- Requests that come to Aerva (Admin → Approvals) ----
// • A natural disaster (EMERGENCY_REASONS): at once, from the moment it is
//   sent — the host cannot decline it. Aerva checks the proof and decides.
// • An old emergency request with a removed reason (RETIRED_REASONS), still
//   open from before 10 Nov 2026: once the host has not answered in 24 hours
//   and Aerva's reminders are done (_emergency-escalation.js).
// • A review of a host's decline that a guest asked for before 10 Nov 2026
//   and Aerva has not decided yet (the guest can no longer ask for one).
// Booking still confirmed and the stay not started.
async function legacyReviews(sql) {
  try {
    const rows = await sql`SELECT r.*, o.suite_name, o.arrival, o.departure, o.guest_email, o.guest_first_name, o.guest_last_name, o.status AS order_status, l.host_name
                           FROM cancellation_requests r JOIN orders o ON o.id = r.order_id JOIN listings l ON l.id = o.listing_id
                           WHERE r.review_requested_at IS NOT NULL AND r.review_decided_at IS NULL AND o.status = 'paid' ORDER BY o.arrival LIMIT 100`;
    const out = [];
    for (const r of rows) {
      const q = await cancellationQuote(sql, r.order_id, null);
      if (q.started) continue;
      out.push({ requestId: r.id, orderId: r.order_id, review: true, kind: 'legacy', reason: REASON_LABELS[r.reason_code] || r.reason_code, details: r.details || '', reviewNote: r.review_note || '',
        hostNote: r.host_note || '', evidence: Array.isArray(r.evidence) ? r.evidence : [], askedAt: r.review_requested_at, listing: r.suite_name, arrival: r.arrival, departure: r.departure, hostName: r.host_name,
        guest: [r.guest_first_name, r.guest_last_name].filter(Boolean).join(' ') || r.guest_email, canDecide: true,
        guestGetsBack: await guestGetsBackFor(sql, r.order_id, 100) });
    }
    return out;
  } catch (e) { return []; }
}
async function requestsForAerva(sql) {
  const rows = await sql`
    SELECT r.id FROM cancellation_requests r JOIN orders o ON o.id = r.order_id
    WHERE r.status = 'pending' AND r.decided_at IS NULL AND o.status = 'paid'
      AND (r.reason_code = ANY(${Object.keys(EMERGENCY_REASONS)})
           OR (r.reason_code = ANY(${Object.keys(RETIRED_REASONS)}) AND r.created_at < now() - make_interval(hours => ${HOST_DECISION_TIMEOUT_HOURS})))
    ORDER BY o.arrival, r.id LIMIT 200`;
  // Old emergency requests escalated earlier than 24 hours (check-in close).
  const E = require('./_emergency-escalation');
  const ready = await E.ready(sql);
  const escalatedIds = ready ? (await sql`SELECT id FROM cancellation_requests WHERE status = 'pending' AND decided_at IS NULL AND escalated_at IS NOT NULL`).map(x => Number(x.id)) : [];
  const ids = [...new Set(rows.map(r => Number(r.id)).concat(escalatedIds))];
  const out = [];
  for (const id of ids) {
    const r = (await sql`SELECT r.id, r.order_id, r.reason_code, r.details, r.created_at, r.days_before, to_jsonb(r)->'evidence' AS evidence,
                                o.suite_name, o.arrival, o.departure, o.guest_email, o.guest_first_name, o.guest_last_name, o.status AS order_status, l.host_name
                         FROM cancellation_requests r JOIN orders o ON o.id = r.order_id JOIN listings l ON l.id = o.listing_id WHERE r.id = ${id}`)[0];
    if (!r || r.order_status !== 'paid' || !AERVA_REASONS[r.reason_code]) continue;
    const q = await cancellationQuote(sql, r.order_id, null);
    if (q.started) continue;
    const disaster = isDisaster(r);
    const full = ready ? await E.load(sql, r.id) : null;
    const base = { requestId: r.id, orderId: r.order_id, reason: REASON_LABELS[r.reason_code] || r.reason_code, details: r.details || '',
      askedAt: r.created_at, listing: r.suite_name, arrival: r.arrival, departure: r.departure, hostName: r.host_name,
      guest: [r.guest_first_name, r.guest_last_name].filter(Boolean).join(' ') || r.guest_email,
      evidence: Array.isArray(r.evidence) ? r.evidence : [] };
    if (disaster) {
      const d = await disasterOutcome(sql, r.order_id);
      out.push(Object.assign(base, { kind: 'disaster', canDecide: true, credit: d.credit, coupon: d.coupon, cash: d.cash,
        hoursToCheckIn: full ? E.adminView(full).hoursToCheckIn : null, hostEmail: full ? full.host_email || null : null, hostPhone: full ? full.host_phone || null : null }));
    } else {
      out.push(Object.assign(base, { kind: 'legacy', guestGetsBack: await guestGetsBackFor(sql, r.order_id, 100), ...(full ? E.adminView(full) : { canDecide: true }) }));
    }
  }
  out.push(...(await legacyReviews(sql)));
  out.sort((a, b) => String(a.arrival).localeCompare(String(b.arrival)));
  return out;
}

async function decideByAerva(sql, razorpay, { requestId, accept, note = '', adminLabel = null }) {
  const err = (m, status = 400) => Object.assign(new Error(m), { isUserFacing: true, status });
  const rq = (await sql`SELECT * FROM cancellation_requests WHERE id = ${Number(requestId) || 0}`)[0];
  if (!rq) throw err('Request not found.', 404);
  if (!AERVA_REASONS[rq.reason_code]) throw err('Only natural-disaster requests come to Aerva.');
  const review = !!rq.review_requested_at && !rq.review_decided_at;
  if (!review && (rq.status !== 'pending' || rq.decided_at)) throw err('This request has already been answered.', 409);
  if (review && rq.review_decided_at) throw err('This review has already been decided.', 409);
  const q = await cancellationQuote(sql, rq.order_id, null);
  if (q.status) throw err(q.error, q.status);
  if (q.started) throw err('This stay has already started, so it can no longer be cancelled.');
  const disaster = isDisaster(rq) && !review;
  const E = require('./_emergency-escalation');
  // An old emergency request: Aerva decides only after the host's reminders.
  if (!disaster && !review && await E.ready(sql)) {
    const full = await E.load(sql, rq.id);
    if (!E.canAervaDecide(full)) throw err(`Not yet: Aerva contacts the host first. ${E.adminView(full).decideRule} Reminders sent: ${Number(full.host_reminders) || 0} of ${E.REMINDERS}.`, 409);
  }
  // Claimed once: the request (or the review) can never be decided twice.
  if (review) {
    const c = await sql`UPDATE cancellation_requests SET review_decided_at = now() WHERE id = ${rq.id} AND review_decided_at IS NULL RETURNING id`;
    if (!c.length) throw err('This review has already been decided.', 409);
  } else if (!(await claimRequest(sql, rq.id))) throw err('This request has already been answered.', 409);
  const why = String(note || '').trim().slice(0, 500);
  let out = null;
  try {
    if (accept === true) out = await executePolicyCancellation(sql, razorpay, { orderId: rq.order_id, pct: 100, by: disaster ? 'natural_disaster' : 'aerva_emergency', adminLabel, note: why });
  } catch (e) {
    if (review) await sql`UPDATE cancellation_requests SET review_decided_at = NULL WHERE id = ${rq.id}`;
    else await unclaimRequest(sql, rq.id);
    throw e;
  }
  if (review) {
    await sql`UPDATE cancellation_requests SET review_outcome = ${accept === true ? 'overturned' : 'upheld'}, status = ${accept === true ? 'accepted' : 'declined'},
                refund_percent = ${accept === true ? 100 : rq.refund_percent}, host_note = ${(rq.host_note ? rq.host_note + ' · ' : '') + 'Reviewed by Aerva' + (why ? ': ' + why : '')} WHERE id = ${rq.id}`;
  } else {
    await sql`UPDATE cancellation_requests SET status = ${accept === true ? 'accepted' : 'declined'}, refund_percent = ${accept === true ? 100 : 0},
                host_note = ${'Decided by Aerva' + (why ? ': ' + why : '')}, decided_at = now() WHERE id = ${rq.id}`;
  }
  await logAudit(sql, { action: review ? 'cancellation_review_decided' : 'cancellation_request_decided_by_aerva', success: true, actorType: 'admin', actorIdentifier: adminLabel,
    targetType: 'order', targetId: rq.order_id, metadata: { requestId: rq.id, accept: accept === true, note: why, natural_disaster: disaster, credit: out ? out.heldAsCredit || 0 : 0 } });
  const o = (await sql`SELECT o.suite_name, o.guest_email, o.arrival, o.departure, l.host_id FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${rq.order_id}`)[0];
  const host = (await sql`SELECT email FROM guests WHERE host_id = ${o.host_id} ORDER BY id LIMIT 1`)[0];
  const stay = `<strong>${escH(o.suite_name)}</strong> (${escH(require('./_booking-rules').niceDay(o.arrival))} → ${escH(require('./_booking-rules').niceDay(o.departure))})`;
  const binding = 'Aerva’s decision is final and binds both the guest and the host.';
  if (disaster) {
    // executePolicyCancellation has already told both sides and posted in
    // the thread when it was approved; a rejection is told here.
    if (accept !== true) {
      await postThreadMessage(sql, rq.order_id, 'system', `Aerva checked the proof and did not approve the cancellation${why ? ': ' + why : ''}. The booking stands. ${binding}`);
      await email(o.guest_email, `About your cancellation request for ${o.suite_name}`, `<div style="font-family:sans-serif; max-width:480px;"><p>Aerva has checked the proof you sent to cancel ${stay} and could not approve it${why ? ': ' + escH(why) : ''}. Nothing changes: your booking stands.</p><p>${binding}</p></div>`);
      await email(host && host.email, `Cancellation request closed: ${o.suite_name}`, `<div style="font-family:sans-serif; max-width:480px;"><p>Aerva did not approve your guest’s natural-disaster cancellation of ${stay}. The booking stands.</p><p>${binding}</p></div>`);
    } else {
      await email(host && host.email, `Booking cancelled by Aerva: ${o.suite_name}`, `<div style="font-family:sans-serif; max-width:480px;"><p>Aerva checked the proof and approved your guest’s natural-disaster cancellation of ${stay}. The guest’s payment is held as Aerva credit for the guest; there is no payout for this booking, and it does not count as your cancellation. The dates are open again.</p><p>${binding}</p></div>`);
    }
    await E.closeEscalation(sql, rq.id, {
      guestText: accept === true ? `Aerva approved your cancellation: everything you paid is held as Aerva credit — use it for new dates, or have it refunded to your original payment at any time from My Bookings. ${binding}` : `Aerva did not approve your request${why ? ' — ' + why : ''}. The booking stands. ${binding}`,
      hostText: accept === true ? `Aerva approved the cancellation. ${binding}` : `Aerva did not approve the request. The booking stands. ${binding}` });
    return { accepted: accept === true, refundPercent: accept === true ? 100 : 0, credit: out ? out.heldAsCredit || 0 : 0, review: false };
  }
  const outcome = accept === true
    ? `Aerva ${review ? 'reviewed the proof and approved' : 'decided and approved'} the cancellation: the booking price, GST and deposit are refunded in full; Aerva’s service fee is not refunded.`
    : `Aerva ${review ? 'reviewed the proof and the host’s decline stands' : 'decided and did not approve the request'}${why ? ': ' + why : ''}. The booking stands.`;
  await postThreadMessage(sql, rq.order_id, 'system', `${outcome} ${binding}`);
  await email(o.guest_email, accept === true ? `Your cancellation for ${o.suite_name} is approved` : `About your cancellation request for ${o.suite_name}`, `<div style="font-family:sans-serif; max-width:480px;"><p>${escH(outcome)} (${stay})</p><p>${binding}</p></div>`);
  await email(host && host.email, accept === true ? `Booking cancelled by Aerva: ${o.suite_name}` : `Cancellation request closed: ${o.suite_name}`, `<div style="font-family:sans-serif; max-width:480px;"><p>${escH(outcome)} (${stay})</p><p>${binding}</p></div>`);
  await E.closeEscalation(sql, rq.id, { guestText: `${outcome} ${binding}`, hostText: `${outcome} ${binding}` });
  return { accepted: accept === true, refundPercent: accept === true ? 100 : 0, review };
}
// Scheduler: requests still open when the stay starts close; the booking
// stands. Never throws.
async function closeRequestsAtCheckin(sql, { deadlineMs = 3000 } = {}) {
  const started = Date.now();
  const out = { closed: 0, affected: [] };
  let rows = [];
  try {
    rows = await sql`SELECT r.id, r.order_id FROM cancellation_requests r JOIN orders o ON o.id = r.order_id
                     WHERE r.status = 'pending' AND r.decided_at IS NULL AND o.status = 'paid'
                       AND o.arrival <= CURRENT_DATE + 1 LIMIT 50`;
  } catch (err) { return { ...out, skipped: 'table not ready' }; }
  for (const r of rows) {
    if (Date.now() - started > deadlineMs) break;
    try {
      const q = await cancellationQuote(sql, r.order_id, null);
      if (!q.started) continue;
      const done = await sql`UPDATE cancellation_requests SET status = 'declined', refund_percent = 0, decided_at = now(),
                               host_note = 'Closed at check-in: no decision before the stay started'
                             WHERE id = ${r.id} AND status = 'pending' AND decided_at IS NULL RETURNING id`;
      if (!done.length) continue;
      const o = (await sql`SELECT o.suite_name, o.guest_email, l.host_id FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${r.order_id}`)[0];
      await postThreadMessage(sql, r.order_id, 'system', 'The stay has started, so the cancellation request has closed. The booking stands.');
      await require('./_emergency-escalation').closeEscalation(sql, r.id, { guestText: 'The stay has started, so your cancellation request has closed and the booking stands. If you need help, reply here.', hostText: 'The stay has started, so the cancellation request has closed. The booking stands.' });
      const host = (await sql`SELECT email FROM guests WHERE host_id = ${o.host_id} ORDER BY id LIMIT 1`)[0];
      await email(o.guest_email, `Your cancellation request for ${o.suite_name} has closed`, `<div style="font-family:sans-serif; max-width:480px;"><p>Your stay at <strong>${escH(o.suite_name)}</strong> has started, so your cancellation request has closed and the booking stands. To leave early, change your check-out date in My Bookings.</p></div>`);
      await email(host && host.email, `Cancellation request closed: ${o.suite_name}`, `<div style="font-family:sans-serif; max-width:480px;"><p>The stay at <strong>${escH(o.suite_name)}</strong> has started, so your guest’s cancellation request has closed. The booking stands.</p></div>`);
      await logAudit(sql, { action: 'cancellation_request_closed_at_checkin', success: true, actorType: 'system', targetType: 'order', targetId: r.order_id, metadata: { requestId: r.id } });
      out.closed++; out.affected.push({ orderId: r.order_id, email: o.guest_email });
    } catch (err) { console.error('request not closed at check-in:', r.id, err.message); }
  }
  return out;
}

module.exports = {
  requestsForAerva, decideByAerva, closeRequestsAtCheckin,
  POLICIES, HOST_DECISION_TIMEOUT_HOURS, FREE_CANCEL_REFUNDS_SERVICE_FEE, HOST_CANCELLATIONS_PER_YEAR, EMERGENCY_REASONS, RETIRED_REASONS, REQUEST_REASONS, REASON_LABELS, AERVA_REASONS,
  isDisaster, isLegacyEmergency, disasterOutcome,
  TRANSFERRED_NO_CANCEL, policyKey, policyTier, policySummary, splitRow, depositStillHeld, linkedSiblings, loadRows,
  claimForCancellation, releaseClaim, guestGetsBackFor, claimRequest, unclaimRequest, postThreadMessage, hostOption, createCancellationRequest, cancellationCard,
  cancellationQuote, executePolicyCancellation, freeCancelActive, returnCouponValue, returnValue, hostCouponAmount, markCancelledByHost, listingCancelRates, hostCancelRates, hostCancellationsLastYear, settleUnansweredRequests, clearUnsentPayouts
};
