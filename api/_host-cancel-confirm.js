// The Aerva mark on every email (api/_email-shell.js, owner 14 Nov 2026):
// requiring it brands everything this process sends.
require('./_email-shell');
// /api/_host-cancel-confirm.js — Aerva cancelling a booking FOR a host,
// with the host's confirmation. Not an endpoint.
//
// A host over their 3 cancellations a year (or who cannot cancel
// themselves) asks Aerva to cancel. An admin starts it from Admin → Lookup
// ("Cancel for the host"): nothing is cancelled yet. A support request is
// raised on the host's account with the terms — the guest gets back
// everything they paid, it counts as the host's cancellation, and, within
// 48 hours of check-in, the host must first pay for an Aerva coupon worth
// 10% of the booking for the guest. The host confirms (or declines) in that
// request, in the Resolution Center. Only on their confirmation is the
// booking cancelled (_cancellations.js executePolicyCancellation).
//
// The coupon (owner, 10 Nov 2026): Aerva never pays it on the host's
// behalf and never deducts it from a later payout. Within 48 hours of
// check-in — measured at the moment the host confirms — the host pays it
// through Razorpay first, the same way as cancelling themselves
// (host-listings.js buyCouponOrder → verifyCouponPayment): startCouponPayment
// opens the payment, answer() verifies it, holds the coupon ('reserved'),
// cancels, and only then schedules the coupon for the guest (sent
// automatically after COUPON_RELEASE_DELAY_MINUTES, _coupons.js). Without
// the payment nothing is cancelled and the request stays waiting. No
// host_penalties row is ever created here; rows already recorded by the
// old flow are still deducted by _payouts.js.
// Only the host's own account confirms (guest-profile.js refuses co-hosts
// acting for the host), so the payer is always the host.

const { logAudit } = require('./_audit-log');
const crypto = require('crypto');
const { executePolicyCancellation, hostCouponAmount } = require('./_cancellations');
const { verifyRazorpaySignature } = require('./_razorpay-verify');

// extra: fields added to the JSON answer (guest-profile.js), e.g. needsCoupon.
const userError = (message, status = 400, extra) => Object.assign(new Error(message), { isUserFacing: true, status }, extra ? { extra } : {});
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FEE_REASON = 'Cancelled by Aerva for the host: the guest gets back everything they paid';

async function systemMessage(sql, ticketId, body) {
  if (!ticketId) return;
  try { await sql`INSERT INTO support_messages (ticket_id, sender, body) VALUES (${ticketId}, 'system', ${body})`; } catch (e) { /* best effort */ }
}

// The admin asks. Returns { ref, couponAmount, refund }.
async function requestConfirmation(sql, { orderId, reason, adminLabel, adminName }) {
  const id = Number(orderId) || 0;
  const o = (await sql`SELECT o.id, o.status, o.suite_name, o.arrival, l.host_id FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${id}`)[0];
  if (!o) throw userError('Booking not found.', 404);
  if (o.status !== 'paid') throw userError('This booking has already been cancelled.', 409);
  let open;
  try { open = (await sql`SELECT c.id, t.ref FROM host_cancel_confirmations c LEFT JOIN support_tickets t ON t.id = c.ticket_id WHERE c.order_id = ${id} AND c.status = 'pending'`)[0]; }
  catch (e) { throw userError('Apply the database update 2026-10-28-03-host-cancel-confirm.sql first.', 503); }
  if (open) throw userError(`The host has already been asked to confirm this cancellation (request ${open.ref || '#' + open.id}).`, 409);
  const account = (await sql`SELECT id FROM guests WHERE host_id = ${o.host_id} AND deleted_at IS NULL ORDER BY id LIMIT 1`)[0];
  if (!account) throw userError('The host has no Aerva account to confirm from.', 400);
  // What it will mean, worked out now (it is worked out again when the host confirms).
  const pv = await executePolicyCancellation(sql, null, { orderId: id, pct: 100, by: 'admin', note: reason, refundFee: true, feeReason: FEE_REASON, countAgainstHost: true, preview: true, asCredit: true });
  const refund = Math.round((pv.refundCash || 0) + (pv.heldAsCredit || 0) + (pv.creditBack || 0) + (pv.couponBack || 0));
  const cashBack = Math.round(pv.refundCash || 0);   // the deposit: back to the payment, never credit
  const coupon = await hostCouponAmount(sql, id);
  const terms = `Aerva will cancel booking #${id} (${o.suite_name}) for you, as you asked. Reason: ${reason}\n\n`
    + `If you confirm:\n• Everything the guest paid for the booking — ${inr(refund - cashBack)} (the booking, GST and Aerva’s service fee) — is held for them as Aerva credit, which they can use or have refunded at any time${cashBack > 0 ? `; their ${inr(cashBack)} deposit is refunded to them` : ''}.\n`
    + `• It counts as one of your cancellations.\n`
    + (coupon > 0
      ? `• Check-in is within 48 hours, so you must first pay for an Aerva coupon worth ${inr(coupon)} (10% of the booking) for the guest. You pay it when you confirm (“Pay ${inr(coupon)} and confirm”); it is sent to the guest automatically once the booking is cancelled. Aerva does not pay it or deduct it later, and what you pay is not refunded.\n`
      : `• No coupon is needed: check-in is more than 48 hours away. (If you confirm within 48 hours of check-in, you must first pay for an Aerva coupon worth 10% of the booking for the guest; Aerva does not pay it or deduct it later.)\n`)
    + `\nNothing is cancelled until you confirm. Use the Confirm button on this request.`;
  const support = require('./_support');
  const out = await support.createRequest(sql, { guestId: account.id, category: 'cancellation_refund', subject: `Confirm the cancellation of booking #${id}`,
    description: terms, orderId: id, listingId: null, attachments: [], callback: false, raisedBy: { email: adminLabel || 'admin', name: adminName || null } });
  const t = (await sql`SELECT id FROM support_tickets WHERE ref = ${out.ref}`)[0];
  await sql`UPDATE support_tickets SET status = 'waiting_on_you' WHERE id = ${t.id}`.catch(() => {});
  await sql`INSERT INTO host_cancel_confirmations (order_id, host_id, ticket_id, reason, refund_amount, coupon_amount, requested_by)
            VALUES (${id}, ${o.host_id}, ${t.id}, ${reason}, ${refund}, ${coupon}, ${adminLabel || 'admin'})`;
  await logAudit(sql, { action: 'host_cancel_confirmation_requested', success: true, actorType: 'admin', actorIdentifier: adminLabel || 'admin',
    targetType: 'order', targetId: id, metadata: { ref: out.ref, refund, coupon, reason } });
  return { ref: out.ref, refund, couponAmount: coupon };
}

// For the request view: the confirmation waiting on this host, if any.
async function forTicket(sql, ticketId, guestId) {
  try {
    const c = (await sql`SELECT c.*, o.suite_name FROM host_cancel_confirmations c JOIN orders o ON o.id = c.order_id
                         WHERE c.ticket_id = ${ticketId} ORDER BY c.id DESC LIMIT 1`)[0];
    if (!c) return null;
    const me = (await sql`SELECT host_id FROM guests WHERE id = ${guestId}`)[0];
    if (!me || Number(me.host_id) !== Number(c.host_id)) return null;
    // Within 48 hours of check-in (worked out now, as when confirming), the
    // host pays the coupon to confirm; one already paid is shown as paid.
    const held = c.status === 'pending' ? await heldCoupon(sql, c.order_id, c.host_id) : null;
    const coupon = c.status === 'pending' ? (held ? Number(held.amount) : await hostCouponAmount(sql, c.order_id)) : Number(c.coupon_amount) || 0;
    return { status: c.status, orderId: c.order_id, booking: c.suite_name, reason: c.reason, refund: c.refund_amount, couponAmount: coupon, decidedAt: c.decided_at,
             couponPaid: c.status === 'pending' ? !!held : !!c.coupon_id, needsPayment: c.status === 'pending' && coupon > 0 && !held,
             couponIssued: !!c.coupon_issued_at };
  } catch (e) { return null; }
}

// The coupon the host has already paid for this booking and that is held
// for the cancellation ('reserved'), if any.
async function heldCoupon(sql, orderId, hostId) {
  return (await sql`SELECT id, amount FROM coupons WHERE source_order_id = ${Number(orderId) || 0} AND issuing_host_id = ${Number(hostId) || 0}
                    AND status = 'reserved' ORDER BY id DESC LIMIT 1`)[0] || null;
}

// The pending confirmation behind this request, for the host's own account.
async function pendingOn(sql, guestId, ref) {
  const t = (await sql`SELECT t.id, t.ref FROM support_tickets t WHERE t.ref = ${String(ref || '').trim().toUpperCase()} AND t.guest_id = ${guestId}`)[0];
  if (!t) throw userError('That request could not be found on your account.', 404);
  const me = (await sql`SELECT id, host_id FROM guests WHERE id = ${guestId}`)[0];
  const c = (await sql`SELECT * FROM host_cancel_confirmations WHERE ticket_id = ${t.id} AND status = 'pending' ORDER BY id DESC LIMIT 1`)[0];
  if (!c || !me || Number(me.host_id) !== Number(c.host_id)) throw userError('There is nothing to confirm on this request.', 409);
  return { t, c, me };
}

// Step 1 of "Pay ₹X and confirm": a Razorpay order for the HOST to pay the
// guest's coupon (the same coupon payment as cancelling themselves,
// host-listings.js buyCouponOrder). The amount is worked out here; the page
// sends none. One unpaid order per booking: a second click or tab gets the
// same order back, so the coupon can never be paid twice.
async function startCouponPayment(sql, razorpay, { guestId, ref }) {
  const { c } = await pendingOn(sql, guestId, ref);
  const o = (await sql`SELECT id, status, guest_id FROM orders WHERE id = ${c.order_id}`)[0];
  if (!o || o.status !== 'paid') throw userError('This booking has already been cancelled.', 409);
  if (await heldCoupon(sql, c.order_id, c.host_id)) return { alreadyPaid: true };
  const amount = await hostCouponAmount(sql, c.order_id);
  if (!amount) throw userError('No coupon is needed: check-in is more than 48 hours away. Confirm without paying.', 400);
  const reuse = async () => (await sql`SELECT id, amount, razorpay_order_id FROM coupons
                                       WHERE source_order_id = ${c.order_id} AND status = 'pending_payment' ORDER BY id DESC LIMIT 1`)[0];
  const reply = (cp) => ({ couponId: cp.id, amount: Number(cp.amount), razorpayOrderId: cp.razorpay_order_id, keyId: process.env.RAZORPAY_KEY_ID, currency: 'INR' });
  const pending = await reuse();
  if (pending && Number(pending.amount) === Number(amount) && pending.razorpay_order_id) return reply(pending);
  // The amount has changed since: the old unpaid order is retired.
  if (pending) await sql`UPDATE coupons SET status = 'abandoned' WHERE id = ${pending.id} AND status = 'pending_payment'`;
  const rzOrder = await razorpay.orders.create({ amount: amount * 100, currency: 'INR', receipt: `aerva_coupon_${Date.now()}`,
    notes: { type: 'host_cancellation_coupon', hostId: String(c.host_id), bookingId: String(c.order_id), paidBy: 'host', via: 'aerva_cancels_for_host' } });
  try {
    const row = (await sql`INSERT INTO coupons (code, guest_id, amount, issuing_host_id, source_order_id, status, razorpay_order_id)
                           VALUES (${'PENDING-' + rzOrder.id}, ${o.guest_id}, ${amount}, ${c.host_id}, ${c.order_id}, 'pending_payment', ${rzOrder.id}) RETURNING id`)[0];
    return { couponId: row.id, amount, razorpayOrderId: rzOrder.id, keyId: process.env.RAZORPAY_KEY_ID, currency: 'INR' };
  } catch (err) {
    // Two tabs raced: the unique index lets one row in; this tab gets it.
    if (err && err.code === '23505') { const w = await reuse(); if (w) return reply(w); }
    throw err;
  }
}

// Step 2: the host's coupon payment, checked with Razorpay's signature
// (never the browser's word alone), then the coupon is held ('reserved')
// for the cancellation. A payment that is not needed (already paid from
// another tab, or a retired order) is refunded at once.
async function takeCouponPayment(sql, razorpay, c, payment, guestId) {
  const { couponId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = payment || {};
  if (!verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    throw userError('The coupon payment could not be verified, so nothing has been cancelled. Please try again.', 400);
  }
  const coupon = (await sql`SELECT id, status, razorpay_order_id FROM coupons WHERE id = ${Number(couponId) || 0}
                            AND issuing_host_id = ${c.host_id} AND source_order_id = ${c.order_id}`)[0];
  if (!coupon) throw userError('This payment does not match the coupon for this booking.', 400);
  if (coupon.razorpay_order_id !== razorpay_order_id) throw userError('This payment does not match the coupon being paid.', 400);
  if (coupon.status === 'reserved') return;
  const code = 'AERVA-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  let flipped = [];
  try {
    flipped = await sql`UPDATE coupons SET status = 'reserved', code = ${code}, razorpay_payment_id = ${razorpay_payment_id}
                        WHERE id = ${coupon.id} AND status = 'pending_payment'
                          AND NOT EXISTS (SELECT 1 FROM coupons c2 WHERE c2.source_order_id = coupons.source_order_id AND c2.status = 'reserved' AND c2.id <> coupons.id)
                        RETURNING id`;
  } catch (err) { if (!(err && err.code === '23505')) throw err; }
  if (!flipped.length) {
    let refunded = false;
    try { await razorpay.payments.refund(razorpay_payment_id, { notes: { reason: 'duplicate_host_coupon_payment', couponId: String(coupon.id) } }); refunded = true; }
    catch (err) { console.error('duplicate coupon payment refund failed (needs manual refund):', razorpay_payment_id, err && err.message); }
    await logAudit(sql, { action: 'coupon_payment_duplicate', success: refunded, actorType: 'host', actorIdentifier: String(c.host_id),
      targetType: 'coupon', targetId: coupon.id, metadata: { paymentId: razorpay_payment_id, refunded, via: 'aerva_cancels_for_host' } });
    // Another payment for this booking may already be held: then confirming goes on with it.
    if (await heldCoupon(sql, c.order_id, c.host_id)) return;
    throw userError(refunded ? 'This coupon payment was not needed, so it has been refunded to you. Nothing has been cancelled.'
      : 'This coupon payment was not needed. We will refund it — raise a request in the Resolution Center if it has not arrived in 7 days.', 409);
  }
  try { await sql`UPDATE coupons SET paid_by_guest_id = ${guestId} WHERE id = ${coupon.id}`; } catch (err) { /* column added by migration_coupon_release.sql */ }
  await logAudit(sql, { action: 'coupon_purchased', success: true, actorType: 'host', actorIdentifier: String(c.host_id), targetType: 'coupon', targetId: coupon.id,
    metadata: { paidBy: 'host', orderId: c.order_id, via: 'aerva_cancels_for_host' } });
}

// The host answers. accept: true cancels the booking now — within 48 hours
// of check-in only with the coupon paid (payment: the Razorpay checkout's
// answer, from startCouponPayment's order).
async function answer(sql, razorpay, { guestId, ref, accept, payment }) {
  const { t, c } = await pendingOn(sql, guestId, ref);
  let held = null;
  if (accept) {
    // Worked out at the moment of confirming: within 48 hours of check-in,
    // the host pays the guest's coupon first. Without it nothing changes.
    const due = await hostCouponAmount(sql, c.order_id);
    if (payment && payment.razorpay_payment_id) await takeCouponPayment(sql, razorpay, c, payment, guestId);
    held = await heldCoupon(sql, c.order_id, c.host_id);
    if (due > 0 && !held) {
      throw userError(`Check-in is within 48 hours: pay the guest’s ${inr(due)} coupon to confirm. Nothing has been cancelled.`, 402, { needsCoupon: true, amount: due });
    }
  }
  // Claimed first, so two clicks never cancel twice.
  const claimed = await sql`UPDATE host_cancel_confirmations SET status = ${accept ? 'confirmed' : 'declined'}, decided_at = now(), decided_by = ${guestId}
                            WHERE id = ${c.id} AND status = 'pending' RETURNING id`;
  if (!claimed.length) throw userError('This has already been answered.', 409);
  if (!accept) {
    await systemMessage(sql, t.id, 'The host declined. The booking stays as it is.');
    await sql`UPDATE support_tickets SET status = 'in_progress', updated_at = now() WHERE id = ${t.id}`.catch(() => {});
    // A coupon paid for this cancellation and not used is given back.
    const paid = (await sql`SELECT id, razorpay_payment_id FROM coupons WHERE source_order_id = ${c.order_id} AND issuing_host_id = ${c.host_id} AND status = 'reserved'`);
    for (const cp of paid) {
      let refunded = false;
      try { if (cp.razorpay_payment_id) { await razorpay.payments.refund(cp.razorpay_payment_id, { notes: { reason: 'host_declined_cancellation', couponId: String(cp.id) } }); refunded = true; } }
      catch (err) { console.error('coupon refund after decline failed (needs manual refund):', cp.razorpay_payment_id, err && err.message); }
      await sql`UPDATE coupons SET status = ${refunded ? 'refunded' : 'refund_due'} WHERE id = ${cp.id} AND status = 'reserved'`;
      await logAudit(sql, { action: 'coupon_refunded_host_declined', success: refunded, actorType: 'host', actorIdentifier: String(guestId), targetType: 'coupon', targetId: cp.id, metadata: { orderId: c.order_id } });
    }
    await sql`UPDATE coupons SET status = 'abandoned' WHERE source_order_id = ${c.order_id} AND issuing_host_id = ${c.host_id} AND status = 'pending_payment'`.catch(() => {});
    await logAudit(sql, { action: 'host_cancel_confirmation_declined', success: true, actorType: 'host', actorIdentifier: String(guestId), targetType: 'order', targetId: c.order_id });
    return { declined: true };
  }
  let out;
  try {
    out = await executePolicyCancellation(sql, razorpay, { orderId: c.order_id, pct: 100, by: 'admin', note: c.reason, refundFee: true, feeReason: FEE_REASON,
      countAgainstHost: true, adminLabel: `${c.requested_by || 'admin'} (confirmed by the host)`, asCredit: true });
  } catch (err) {
    // Nothing was cancelled: the confirmation stays open, to try again. A
    // coupon already paid stays held for that (no second payment).
    await sql`UPDATE host_cancel_confirmations SET status = 'pending', decided_at = NULL, decided_by = NULL, note = ${String(err.message || err).slice(0, 300)} WHERE id = ${c.id}`;
    await logAudit(sql, { action: 'host_cancel_confirmation_failed', success: false, actorType: 'host', actorIdentifier: String(guestId), targetType: 'order', targetId: c.order_id, metadata: { error: String(err.message || err).slice(0, 300), couponHeld: held ? held.id : null } });
    await mailer().sendMail(process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in', `Host confirmed, but booking #${c.order_id} could not be cancelled`,
      `<p>The host confirmed Aerva cancelling booking #${Number(c.order_id)} (request ${esc(t.ref)}), but it could not be cancelled: ${esc(String(err.message || err).slice(0, 300))}</p><p>Nothing changed; the host can confirm again${held ? ' (the coupon they paid stays held for it)' : ''}. Check Admin → Refunds.</p>`);
    throw userError('The booking could not be cancelled right now, so nothing has changed' + (held ? ' (your coupon payment is kept for when you confirm again)' : '') + '. Please try again in a few minutes; Aerva Support has been told.', 503);
  }
  // Cancelled: the coupon the host paid goes to the guest, released
  // automatically after the delay (_coupons.js) — never charged to a payout.
  const couponAmount = held ? Number(held.amount) : 0;
  if (held) {
    const { COUPON_RELEASE_DELAY_MINUTES } = require('./_coupons');
    try {
      await sql`UPDATE coupons SET status = 'scheduled', release_at = now() + make_interval(mins => ${COUPON_RELEASE_DELAY_MINUTES}) WHERE id = ${held.id} AND status = 'reserved'`;
      await logAudit(sql, { action: 'cancellation_coupon_scheduled', success: true, actorType: 'system', targetType: 'coupon', targetId: held.id, metadata: { orderId: c.order_id, releaseMinutes: COUPON_RELEASE_DELAY_MINUTES, via: 'aerva_cancels_for_host' } });
    } catch (err) {
      console.error('coupon not scheduled (needs follow-up):', held.id, err.message);
      await logAudit(sql, { action: 'cancellation_coupon_schedule_failed', success: false, actorType: 'system', targetType: 'coupon', targetId: held.id, metadata: { orderId: c.order_id, error: String(err.message).slice(0, 200) } });
    }
  }
  await sql`UPDATE host_cancel_confirmations SET coupon_amount = ${couponAmount}, coupon_id = ${held ? held.id : null},
            coupon_issued_at = ${held ? new Date() : null}, coupon_issued_by = ${held ? 'paid by the host' : null} WHERE id = ${c.id}`;
  await systemMessage(sql, t.id, `The host confirmed. Booking #${c.order_id} is cancelled; everything the guest paid is held for them as Aerva credit (any deposit refunded).`
    + (held ? ` The host paid the guest’s ${inr(couponAmount)} Aerva coupon; it is sent to the guest automatically.` : ''));
  await sql`UPDATE support_tickets SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = ${t.id}`.catch(() => {});
  await logAudit(sql, { action: 'host_cancel_confirmation_confirmed', success: true, actorType: 'host', actorIdentifier: String(guestId), targetType: 'order', targetId: c.order_id, metadata: { coupon: couponAmount, couponId: held ? held.id : null } });
  return { confirmed: true, couponAmount, refund: (out.refundCash || 0) + (out.heldAsCredit || 0) + (out.creditBack || 0) };
}

function mailer() {
  return { sendMail: async (to, subject, html) => {
    if (!process.env.RESEND_API_KEY || !to) return;
    try {
      await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html }) });
    } catch (e) { /* best effort */ }
  } };
}

// Admin view: what is waiting on hosts.
async function pendingFor(sql, orderId) {
  try {
    return await sql`SELECT c.id, c.status, c.created_at, c.decided_at, c.coupon_amount, c.coupon_issued_at, t.ref FROM host_cancel_confirmations c LEFT JOIN support_tickets t ON t.id = c.ticket_id
                     WHERE c.order_id = ${Number(orderId) || 0} ORDER BY c.id DESC LIMIT 5`;
  } catch (e) { return []; }
}

module.exports = { requestConfirmation, forTicket, answer, startCouponPayment, pendingFor, FEE_REASON };
