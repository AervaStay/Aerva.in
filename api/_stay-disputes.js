// /api/_stay-disputes.js — a guest is unhappy during a stay. Not an endpoint.
//
//   1. During the stay (from check-in day until the day before check-out)
//      the guest reports the problem with evidence — at least one photo or
//      document — in My Bookings. It appears in the booking's thread.
//   2. The host answers with their justification and any evidence.
//   3. Aerva decides. The host's account is given more weight: the guest is
//      refunded only when their evidence stands and the host cannot justify.
//   4. Refund decided → the nights from the day the dispute was raised to
//      check-out are refunded (their booking price, GST and service fee).
//      The host is paid for the nights already used, less Aerva's commission
//      on those nights. The security deposit is not part of this.
//   While a dispute is open, the host's payout for the booking is held
//   (_payouts.js), so nothing is paid out that may have to be refunded.
//   One open dispute per booking; every step moves the status forward with a
//   guarded update, so nothing is decided or refunded twice.

const { refundAcrossPayments } = require('./_refunds');
const { returnCouponValue, postThreadMessage } = require('./_cancellations');
const { logAudit } = require('./_audit-log');
const { dateStr, paidByOrderRow } = require('./_booking-rules');

const REASONS = {
  not_as_described: 'Not as described in the listing',
  unsafe: 'Unsafe or not working (water, power, locks, etc.)',
  not_clean: 'Not clean',
  no_access: 'Could not get in',
  host_conduct: 'Host behaviour',
  other: 'Something else'
};
const MAX_FILES = 8;
const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');

async function email(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return;
  try {
    await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html: `<div style="font-family:sans-serif; max-width:480px;">${html}</div>` }) });
  } catch (err) { console.error('dispute email failed:', err.message); }
}
function cleanFiles(list) {
  return (Array.isArray(list) ? list : []).map(String)
    .filter(u => /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(u) && u.length <= 600).slice(0, MAX_FILES);
}
async function loadOrder(sql, orderId) {
  return (await sql`
    SELECT o.*, l.host_id, l.property_name, l.timezone,
           (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date AS local_today
    FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${orderId}`)[0] || null;
}
async function hostEmail(sql, hostId) {
  const r = (await sql`SELECT email FROM guests WHERE host_id = ${hostId} ORDER BY id LIMIT 1`)[0];
  return r && r.email;
}

async function raiseDispute(sql, { orderId, guestId, reason, details, evidence }) {
  const o = await loadOrder(sql, orderId);
  if (!o || o.guest_id !== guestId) throw userError('Booking not found.', 404);
  if (o.status !== 'paid' || (o.order_type || 'stay') !== 'stay') throw userError('Only a confirmed stay can be reported.');
  const today = dateStr(o.local_today), arrival = dateStr(o.arrival), departure = dateStr(o.departure);
  if (today < arrival) throw userError('You can report a problem once your stay has started. Before check-in, message your host or request a cancellation.');
  if (today >= departure) throw userError('Problems can be reported during the stay, up to the day before check-out.');
  if (!REASONS[reason]) throw userError('Choose what the problem is.');
  const files = cleanFiles(evidence);
  if (!files.length) throw userError('Please add at least one photo or document as evidence.');
  const text = String(details || '').trim().slice(0, 2000);
  if (text.length < 10) throw userError('Please describe the problem in a few words.');
  let row;
  try {
    row = (await sql`INSERT INTO stay_disputes (order_id, guest_id, raised_date, reason, details, evidence)
                     VALUES (${orderId}, ${guestId}, ${today}, ${reason}, ${text}, ${JSON.stringify(files)}) RETURNING *`)[0];
  } catch (err) {
    if (/idx_stay_disputes_open|duplicate key/.test(err.message)) throw userError('You have already reported a problem on this stay. Aerva is looking into it.', 409);
    throw err;
  }
  await logAudit(sql, { action: 'stay_dispute_raised', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'order', targetId: orderId,
    metadata: { disputeId: row.id, reason, files: files.length } });
  await postThreadMessage(sql, orderId, 'guest', `I have reported a problem with this stay to Aerva: ${REASONS[reason]}. ${text}`);
  await email(await hostEmail(sql, o.host_id), `A guest reported a problem at ${o.property_name}`,
    `<h2 style="font-family:Georgia,serif;">A guest reported a problem</h2><p><strong>${esc(o.property_name)}</strong></p><p>${esc(REASONS[reason])}: ${esc(text)}</p>
     <p>Please reply in Messages with your side and any photos. Aerva decides; your payout for this booking is held until then.</p>
     <p><a href="https://aerva.in/index.html?view=messages" style="color:#8a6c39;">Open Messages</a></p>`);
  await email(process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in', `Stay dispute #${row.id}: ${o.property_name}`, `<p>${esc(REASONS[reason])}: ${esc(text)}</p><p>Review it in Admin → Stay disputes.</p>`);
  return row;
}

async function respondDispute(sql, { disputeId, hostId, response, evidence }) {
  const d = (await sql`SELECT d.*, l.host_id FROM stay_disputes d JOIN orders o ON o.id = d.order_id JOIN listings l ON l.id = o.listing_id WHERE d.id = ${disputeId}`)[0];
  if (!d || d.host_id !== hostId) throw userError('Not found.', 404);
  const text = String(response || '').trim().slice(0, 2000);
  if (text.length < 10) throw userError('Please explain your side in a few words.');
  const done = await sql`UPDATE stay_disputes SET host_response = ${text}, host_evidence = ${JSON.stringify(cleanFiles(evidence))}, host_responded_at = now(), status = 'host_responded'
                         WHERE id = ${disputeId} AND status IN ('open', 'host_responded') AND decided_at IS NULL RETURNING id`;
  if (!done.length) throw userError('Aerva has already decided this.', 409);
  await postThreadMessage(sql, d.order_id, 'host', `I have replied to the reported problem: ${text}`);
  return { ok: true };
}

// Aerva's decision. refund: true → the nights from the day it was raised to
// check-out come back; the host keeps the nights used.
async function decideDispute(sql, razorpay, { disputeId, refund, note = '', adminLabel = 'admin' }) {
  const claim = await sql`UPDATE stay_disputes SET decided_at = now(), decided_by = ${adminLabel}, decision_note = ${String(note).slice(0, 1000) || null}
                          WHERE id = ${disputeId} AND status IN ('open', 'host_responded') AND decided_at IS NULL RETURNING *`;
  if (!claim.length) throw userError('This dispute has already been decided.', 409);
  const d = claim[0];
  const o = await loadOrder(sql, d.order_id);
  const unclaim = async () => sql`UPDATE stay_disputes SET decided_at = NULL, decided_by = NULL WHERE id = ${disputeId} AND status IN ('open', 'host_responded')`;
  if (!refund) {
    await sql`UPDATE stay_disputes SET status = 'no_refund' WHERE id = ${disputeId}`;
    await logAudit(sql, { action: 'stay_dispute_decided', success: true, actorType: 'admin', actorIdentifier: adminLabel, targetType: 'order', targetId: d.order_id, metadata: { disputeId, refund: false } });
    await postThreadMessage(sql, d.order_id, 'host', 'Aerva has reviewed the reported problem and decided that no refund is due.');
    await email(o.guest_email, `Your report about ${o.property_name}`, `<h2 style="font-family:Georgia,serif;">Aerva has reviewed your report</h2><p>After reviewing both sides, no refund is due for this stay.</p>${note ? `<p>${esc(note)}</p>` : ''}`);
    return { refunded: false };
  }
  try {
    const nights = Math.max(1, Number(o.nights) || 1);
    const departure = new Date(dateStr(o.departure) + 'T00:00:00Z'), raised = new Date(dateStr(d.raised_date) + 'T00:00:00Z');
    const refundNights = Math.min(nights, Math.max(0, Math.round((departure - raised) / 86400000)));
    if (!refundNights) throw userError('There are no nights left to refund after the day this was raised.');
    const share = refundNights / nights;
    const bookingBack = Math.round(Number(o.subtotal) * share);
    const gstBack = Math.round(Number(o.gst) * share);
    const feeBack = Math.round(Number(o.guest_service_fee) * share);
    const total = bookingBack + gstBack + feeBack;
    const commissionKept = Math.round(Number(o.commission_amount) * (1 - share));
    const hostPayout = Number(o.subtotal) - bookingBack - commissionKept;
    // Cash as far as the booking's payments allow; a part paid by coupon comes back as a coupon.
    const r = await refundAcrossPayments(sql, razorpay, { orderId: o.id, amountInr: total, kindBase: `dispute-${disputeId}` });
    if (r.shortfallInr > 0) await returnCouponValue(sql, { razorpayOrderId: o.razorpay_order_id, amount: r.shortfallInr, sourceOrderId: o.id, guestEmail: o.guest_email, suiteName: o.suite_name });
    await sql`UPDATE orders SET commission_amount = ${commissionKept}, payout_amount = ${hostPayout} WHERE id = ${o.id}`;
    try { await sql`UPDATE order_cohost_shares SET amount = round(${hostPayout}::numeric * percent / 100) WHERE order_id = ${o.id}`; } catch (e) { /* none */ }
    await sql`UPDATE stay_disputes SET status = 'refunded', nights_refunded = ${refundNights}, refund_amount = ${total} WHERE id = ${disputeId}`;
    await logAudit(sql, { action: 'stay_dispute_decided', success: true, actorType: 'admin', actorIdentifier: adminLabel, targetType: 'order', targetId: o.id,
      metadata: { disputeId, refund: true, refundNights, total, hostPayout } });
    const nightsUsed = nights - refundNights;
    await postThreadMessage(sql, o.id, 'host', `Aerva has decided the reported problem in the guest’s favour: ${refundNights} night${refundNights === 1 ? '' : 's'} refunded (${inr(total)}). The host is paid for the ${nightsUsed} night${nightsUsed === 1 ? '' : 's'} used.`);
    await email(o.guest_email, `Refund for your stay at ${o.property_name}`,
      `<h2 style="font-family:Georgia,serif;">Your report was upheld</h2><p>${refundNights} night${refundNights === 1 ? '' : 's'}, from the day you reported the problem to check-out, are refunded: <strong>${inr(total)}</strong>${r.shortfallInr ? ` (${inr(r.shortfallInr)} of it as a coupon)` : ''}.</p>${note ? `<p>${esc(note)}</p>` : ''}`);
    await email(await hostEmail(sql, o.host_id), `Decision on the reported problem at ${o.property_name}`,
      `<h2 style="font-family:Georgia,serif;">Aerva’s decision</h2><p>The guest’s report was upheld. ${refundNights} night${refundNights === 1 ? '' : 's'} were refunded to the guest. You are paid for the ${nightsUsed} night${nightsUsed === 1 ? '' : 's'} used: ${inr(hostPayout)} after Aerva’s commission, on the usual payout day.</p>${note ? `<p>${esc(note)}</p>` : ''}`);
    return { refunded: true, refundNights, total, hostPayout };
  } catch (err) {
    await unclaim();
    throw err;
  }
}

// For the thread card and admin.
async function openDisputeFor(sql, orderId) {
  try { return (await sql`SELECT * FROM stay_disputes WHERE order_id = ${orderId} AND status IN ('open', 'host_responded') ORDER BY id DESC LIMIT 1`)[0] || null; }
  catch (e) { return null; }
}
async function disputesForAdmin(sql, { status = 'open' } = {}) {
  try {
    return await sql`
      SELECT d.*, o.suite_name, o.arrival, o.departure, o.nights, o.subtotal, o.gst, o.guest_service_fee, o.guest_email,
             g.name AS guest_name, h.name AS host_name
      FROM stay_disputes d JOIN orders o ON o.id = d.order_id JOIN listings l ON l.id = o.listing_id
      LEFT JOIN guests g ON g.id = d.guest_id LEFT JOIN hosts h ON h.id = l.host_id
      WHERE (${status} = 'all' OR (${status} = 'open' AND d.status IN ('open', 'host_responded')))
      ORDER BY d.raised_at DESC LIMIT 100`;
  } catch (e) { return []; }
}

module.exports = { REASONS, raiseDispute, respondDispute, decideDispute, openDisputeFor, disputesForAdmin };
