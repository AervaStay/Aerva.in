// /api/_host-cancel-confirm.js — Aerva cancelling a booking FOR a host,
// with the host's confirmation. Not an endpoint.
//
// A host over their 3 cancellations a year (or who cannot cancel
// themselves) asks Aerva to cancel. An admin starts it from Admin → Lookup
// ("Cancel for the host"): nothing is cancelled yet. A support request is
// raised on the host's account with the terms — the guest gets back
// everything they paid, it counts as the host's cancellation, and, within
// 48 hours of check-in, a 10% coupon for the guest is deducted from the
// host's next payout. The host confirms (or declines) in that request, in
// the Resolution Center. Only on their confirmation is the booking
// cancelled (_cancellations.js executePolicyCancellation). Within 48 hours
// of check-in, an admin then issues the guest's coupon (issueCoupon): Aerva
// pays for it, and it is deducted from the host's next payout
// (host_penalties, _payouts.js).

const { logAudit } = require('./_audit-log');
const { executePolicyCancellation, hostCouponAmount, issueCouponForHost } = require('./_cancellations');

const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });
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
  const coupon = await hostCouponAmount(sql, id);
  const terms = `Aerva will cancel booking #${id} (${o.suite_name}) for you, as you asked. Reason: ${reason}\n\n`
    + `If you confirm:\n• Everything the guest paid — ${inr(refund)} (the booking, GST and Aerva’s service fee) — is held for them as Aerva credit, which they can use or have refunded at any time; any deposit is refunded to them.\n`
    + `• It counts as one of your cancellations.\n`
    + (coupon > 0
      ? `• Check-in is within 48 hours, so the guest also gets an Aerva coupon of ${inr(coupon)} (10% of the booking). Aerva pays it for you, and it is deducted from your next payout.\n`
      : `• No coupon is needed: check-in is more than 48 hours away. (If you confirm within 48 hours of check-in, Aerva gives the guest a 10% coupon for you, deducted from your next payout.)\n`)
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
    const coupon = c.status === 'pending' ? await hostCouponAmount(sql, c.order_id) : c.coupon_amount;
    return { status: c.status, orderId: c.order_id, booking: c.suite_name, reason: c.reason, refund: c.refund_amount, couponAmount: coupon, decidedAt: c.decided_at,
             couponIssued: !!c.coupon_issued_at };
  } catch (e) { return null; }
}

// The host answers. accept: true cancels the booking now.
async function answer(sql, razorpay, { guestId, ref, accept }) {
  const t = (await sql`SELECT t.id, t.ref FROM support_tickets t WHERE t.ref = ${String(ref || '').trim().toUpperCase()} AND t.guest_id = ${guestId}`)[0];
  if (!t) throw userError('That request could not be found on your account.', 404);
  const me = (await sql`SELECT id, host_id FROM guests WHERE id = ${guestId}`)[0];
  const c = (await sql`SELECT * FROM host_cancel_confirmations WHERE ticket_id = ${t.id} AND status = 'pending' ORDER BY id DESC LIMIT 1`)[0];
  if (!c || !me || Number(me.host_id) !== Number(c.host_id)) throw userError('There is nothing to confirm on this request.', 409);
  // Claimed first, so two clicks never cancel twice.
  const claimed = await sql`UPDATE host_cancel_confirmations SET status = ${accept ? 'confirmed' : 'declined'}, decided_at = now(), decided_by = ${guestId}
                            WHERE id = ${c.id} AND status = 'pending' RETURNING id`;
  if (!claimed.length) throw userError('This has already been answered.', 409);
  if (!accept) {
    await systemMessage(sql, t.id, 'The host declined. The booking stays as it is.');
    await sql`UPDATE support_tickets SET status = 'in_progress', updated_at = now() WHERE id = ${t.id}`.catch(() => {});
    await logAudit(sql, { action: 'host_cancel_confirmation_declined', success: true, actorType: 'host', actorIdentifier: String(guestId), targetType: 'order', targetId: c.order_id });
    return { declined: true };
  }
  let out;
  // Worked out at the moment of confirming: within 48 hours of check-in, a coupon.
  const coupon = await hostCouponAmount(sql, c.order_id);
  try {
    out = await executePolicyCancellation(sql, razorpay, { orderId: c.order_id, pct: 100, by: 'admin', note: c.reason, refundFee: true, feeReason: FEE_REASON,
      countAgainstHost: true, adminLabel: `${c.requested_by || 'admin'} (confirmed by the host)`, asCredit: true });
  } catch (err) {
    // Nothing was cancelled: the confirmation stays open, to try again.
    await sql`UPDATE host_cancel_confirmations SET status = 'pending', decided_at = NULL, decided_by = NULL, note = ${String(err.message || err).slice(0, 300)} WHERE id = ${c.id}`;
    await logAudit(sql, { action: 'host_cancel_confirmation_failed', success: false, actorType: 'host', actorIdentifier: String(guestId), targetType: 'order', targetId: c.order_id, metadata: { error: String(err.message || err).slice(0, 300) } });
    await mailer().sendMail(process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in', `Host confirmed, but booking #${c.order_id} could not be cancelled`,
      `<p>The host confirmed Aerva cancelling booking #${Number(c.order_id)} (request ${esc(t.ref)}), but it could not be cancelled: ${esc(String(err.message || err).slice(0, 300))}</p><p>Nothing changed; the host can confirm again. Check Admin → Refunds.</p>`);
    throw userError('The booking could not be cancelled right now, so nothing has changed. Please try again in a few minutes; Aerva support has been told.', 503);
  }
  await sql`UPDATE host_cancel_confirmations SET coupon_amount = ${coupon} WHERE id = ${c.id}`;
  await systemMessage(sql, t.id, `The host confirmed. Booking #${c.order_id} is cancelled; everything the guest paid is held for them as Aerva credit (any deposit refunded).`
    + (coupon > 0 ? ` Aerva issues the guest a ${inr(coupon)} coupon for the host; it is deducted from the host’s next payout.` : ''));
  if (coupon > 0) {
    const { sendMail } = mailer();
    await sendMail(process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in', `Issue the coupon: host confirmed cancelling booking #${c.order_id}`,
      `<p>The host confirmed the cancellation of booking #${Number(c.order_id)} (request ${esc(t.ref)}). The booking is cancelled and the guest refunded.</p>
       <p>Check-in was within 48 hours, so issue the guest’s <strong>${inr(coupon)}</strong> coupon in Admin → Lookup (booking #${Number(c.order_id)}) → “Issue the coupon”. Aerva pays it; it is deducted from the host’s next payout.</p>`);
  }
  await sql`UPDATE support_tickets SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = ${t.id}`.catch(() => {});
  await logAudit(sql, { action: 'host_cancel_confirmation_confirmed', success: true, actorType: 'host', actorIdentifier: String(guestId), targetType: 'order', targetId: c.order_id, metadata: { coupon } });
  return { confirmed: true, couponAmount: coupon, refund: (out.refundCash || 0) + (out.heldAsCredit || 0) + (out.creditBack || 0) };
}

// The admin issues the guest's coupon once the host has confirmed (within
// 48 hours of check-in). Aerva pays for it; the host's next payout has it
// deducted (issueCouponForHost records host_penalties). Returns { amount }.
async function issueCoupon(sql, { orderId, adminLabel }) {
  const c = (await sql`SELECT * FROM host_cancel_confirmations WHERE order_id = ${Number(orderId) || 0} AND status = 'confirmed' ORDER BY id DESC LIMIT 1`)[0];
  if (!c) throw userError('The host has not confirmed a cancellation of this booking.', 409);
  if (c.coupon_issued_at) throw userError('The coupon has already been issued.', 409);
  if (!(Number(c.coupon_amount) > 0)) throw userError('No coupon is due: the host confirmed more than 48 hours before check-in.', 400);
  const claimed = await sql`UPDATE host_cancel_confirmations SET coupon_issued_at = now(), coupon_issued_by = ${adminLabel || 'admin'}
                            WHERE id = ${c.id} AND coupon_issued_at IS NULL RETURNING id`;
  if (!claimed.length) throw userError('The coupon has already been issued.', 409);
  const r = await issueCouponForHost(sql, { orderId: c.order_id, hostId: c.host_id });
  if (!r.amount) {
    await sql`UPDATE host_cancel_confirmations SET coupon_issued_at = NULL, coupon_issued_by = NULL WHERE id = ${c.id}`;
    throw userError('The coupon could not be issued. Try again.', 500);
  }
  const cp = (await sql`SELECT id FROM coupons WHERE source_order_id = ${c.order_id} AND issuing_host_id = ${c.host_id} ORDER BY id DESC LIMIT 1`)[0];
  if (cp) await sql`UPDATE host_cancel_confirmations SET coupon_id = ${cp.id} WHERE id = ${c.id}`;
  await systemMessage(sql, c.ticket_id, `Aerva has issued the guest’s ${inr(r.amount)} coupon for you. It will be deducted from your next payout.`);
  await logAudit(sql, { action: 'host_cancel_coupon_issued', success: true, actorType: 'admin', actorIdentifier: adminLabel || 'admin', targetType: 'order', targetId: c.order_id, metadata: { amount: r.amount, hostId: c.host_id } });
  return { amount: r.amount };
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

module.exports = { requestConfirmation, forTicket, answer, issueCoupon, pendingFor, FEE_REASON };
