// /api/_guest-id.js — phone number and ID proof for guests. Not an endpoint.
//
// RULES
//   • Booking needs an Aerva account with a phone number and an ID proof on
//     it (government photo ID: Aadhaar, passport, driving licence, voter ID
//     or PAN card; a passport for guests from outside India). The ID is of
//     the guest making the booking.
//   • Checkout does not open without both. The phone typed at checkout is
//     saved to the account if the account has none.
//
// EDGE CASES — a booking can end up PAID without a valid ID:
//   • the ID was removed or replaced while paying (another tab);
//   • Aerva rejects the ID after the booking (unreadable, expired, not the
//     guest's, or not a real ID);
//   • a payment recorded later by the background job, after either of those.
//   Such a booking is kept for a short time for the guest to upload a valid
//   ID: until 2 hours from now, and never later than check-in (a stay
//   starting sooner, or a late-night booking already past check-in time,
//   gets 1 hour). If no valid ID is on the account by then, the booking is
//   cancelled and EVERYTHING paid is refunded in full (booking, GST, service
//   fee and deposit). Uploading a valid ID in time clears it.
//
// PRIVACY: the document's address is stored encrypted and only admins can
// open it. Hosts see only that an ID is on file. Deleting the account
// erases it (_accounts.js).

const { encryptField, decryptField, encryptionReady } = require('./_secure-fields');
const { safeRefund, refundAcrossPayments, hasChangePayments } = require('./_refunds');
const { logAudit } = require('./_audit-log');
const { checkInMomentMs, dateStr, paidByOrderRow } = require('./_booking-rules');
const { normalizeToE164 } = require('./_phone-validation');

const ID_TYPES = { aadhaar: 'Aadhaar', passport: 'Passport', driving_licence: 'Driving licence', voter_id: 'Voter ID', pan: 'PAN card' };
const ID_GRACE_HOURS = 2;
const ID_MIN_GRACE_HOURS = 1;
const userError = (message, status = 400, extra = {}) => Object.assign(new Error(message), { isUserFacing: true, status }, extra);

async function email(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return;
  try {
    await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html: `<div style="font-family:sans-serif; max-width:480px;">${html}</div>` }) });
  } catch (err) { console.error('id email failed:', err.message); }
}
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function idValid(g) { return !!(g && g.id_document_url && ['uploaded', 'verified'].includes(g.id_status)); }

async function guestRow(sql, guestId) {
  try { return (await sql`SELECT id, email, name, phone, id_document_url, id_document_type, id_status, id_rejection_reason, deleted_at FROM guests WHERE id = ${guestId}`)[0] || null; }
  catch (err) { return (await sql`SELECT id, email, name, phone FROM guests WHERE id = ${guestId}`)[0] || null; } // before the migration
}

// What the account still needs before it can book: [] when ready.
async function bookingRequirements(sql, guestId) {
  if (!guestId) return ['login'];
  const g = await guestRow(sql, guestId);
  if (!g || g.deleted_at) return ['login'];
  const missing = [];
  if (!String(g.phone || '').trim()) missing.push('phone');
  if (!idValid(g)) missing.push('id');
  return missing;
}

// Checkout gate. Saves the phone typed at checkout when the account has
// none. Throws a user-facing error naming what is missing.
async function assertCanBook(sql, guestId, { phone } = {}) {
  if (!guestId) throw userError('Please log in or create an account to book. A phone number and ID proof are needed on every booking.', 401, { needs: ['login'] });
  const g = await guestRow(sql, guestId);
  if (!g || g.deleted_at) throw userError('Please log in again.', 401, { needs: ['login'] });
  if (!String(g.phone || '').trim() && phone) {
    const e164 = normalizeToE164(String(phone));
    if (e164) {
      try { await sql`UPDATE guests SET phone = ${e164} WHERE id = ${guestId} AND (phone IS NULL OR btrim(phone) = '')`; g.phone = e164; }
      catch (err) { if (/unique|duplicate/i.test(err.message)) throw userError('This phone number is already used by another Aerva account.', 409, { needs: ['phone'] }); throw err; }
    }
  }
  const needs = [];
  if (!String(g.phone || '').trim()) needs.push('phone');
  if (!idValid(g)) needs.push('id');
  if (needs.length) {
    const what = needs.map(n => n === 'phone' ? 'a phone number' : (g.id_status === 'rejected' ? 'a new ID proof (the last one was not accepted)' : 'your ID proof')).join(' and ');
    throw userError(`Please add ${what} to continue to payment.`, 400, { needs });
  }
  return g;
}

// The guest attaches (or replaces) their ID proof. url must be a file
// uploaded to Aerva's storage through /api/blob-upload.
async function saveIdDocument(sql, guestId, { url, type }) {
  const u = String(url || '');
  if (!/^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(u) || u.length > 600) throw userError('Please upload the ID again.');
  if (!ID_TYPES[type]) throw userError('Choose the type of ID.');
  if (!encryptionReady()) throw userError('ID uploads are being set up. Please try again shortly.', 503);
  await sql`UPDATE guests SET id_document_url = ${encryptField(u)}, id_document_type = ${type}, id_status = 'uploaded',
                              id_uploaded_at = now(), id_rejection_reason = NULL WHERE id = ${guestId}`;
  // A valid ID clears every booking waiting for one.
  let cleared = [];
  try { cleared = await sql`UPDATE orders SET id_required_by = NULL WHERE guest_id = ${guestId} AND status = 'paid' AND id_required_by IS NOT NULL RETURNING id`; }
  catch (err) { /* before the migration */ }
  await logAudit(sql, { action: 'guest_id_uploaded', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId,
    metadata: { type, clearedBookings: cleared.map(r => r.id) } });
  return { status: 'uploaded', type, clearedBookings: cleared.length };
}

// The deadline for a booking that is paid without a valid ID: 2 hours from
// now, never after check-in; at least 1 hour.
function idDeadline(order, listing) {
  const now = Date.now();
  let by = now + ID_GRACE_HOURS * 3600e3;
  const checkIn = checkInMomentMs(dateStr(order.arrival), listing.timezone, listing.check_in_time);
  if (Number.isFinite(checkIn) && checkIn < by) by = checkIn;
  if (by < now + ID_MIN_GRACE_HOURS * 3600e3) by = now + ID_MIN_GRACE_HOURS * 3600e3;
  return new Date(by);
}

// After a booking is confirmed: if its guest has no valid ID, start the
// clock. Never throws (the booking itself is already confirmed).
async function markIdDeadlineIfMissing(sql, orderIds, guestId) {
  try {
    const g = guestId ? await guestRow(sql, guestId) : null;
    if (g && idValid(g)) return;
    const rows = await sql`SELECT o.id, o.arrival, o.guest_email, o.suite_name, l.timezone, l.check_in_time
                           FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ANY(${orderIds}) AND o.status = 'paid'`;
    for (const r of rows) {
      const by = idDeadline(r, r);
      await sql`UPDATE orders SET id_required_by = ${by.toISOString()} WHERE id = ${r.id} AND id_required_by IS NULL`;
    }
    if (rows.length) {
      const by = idDeadline(rows[0], rows[0]);
      await email(rows[0].guest_email, 'Action needed: add your ID to keep your booking',
        `<h2 style="font-family:Georgia,serif;">Add your ID to keep your booking</h2><p>Your booking at <strong>${esc(rows[0].suite_name)}</strong> is paid, but there is no valid ID proof on your account.</p>
         <p>Please add it in My Bookings by <strong>${esc(by.toLocaleString('en-IN', { timeZone: rows[0].timezone || 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</strong>. If there is no valid ID by then, the booking is cancelled and everything you paid is refunded in full.</p>
         <p><a href="https://aerva.in/index.html?view=my-bookings" style="color:#8a6c39;">Add my ID</a></p>`);
    }
  } catch (err) { console.error('id deadline not set:', err.message); }
}

// Admin decision on a guest's ID. Rejecting starts the clock on every
// upcoming booking of that guest.
async function reviewIdDocument(sql, { guestId, approve, reason = '', adminLabel = 'admin' }) {
  const g = await guestRow(sql, guestId);
  if (!g || !g.id_document_url) throw userError('No ID on this account.', 404);
  if (approve) {
    await sql`UPDATE guests SET id_status = 'verified', id_rejection_reason = NULL WHERE id = ${guestId}`;
    return { status: 'verified' };
  }
  const why = String(reason || 'The ID could not be accepted.').slice(0, 300);
  await sql`UPDATE guests SET id_status = 'rejected', id_rejection_reason = ${why} WHERE id = ${guestId}`;
  const upcoming = await sql`SELECT o.id FROM orders o JOIN listings l ON l.id = o.listing_id
                             WHERE o.guest_id = ${guestId} AND o.status = 'paid'
                               AND o.departure > (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date`;
  await markIdDeadlineIfMissing(sql, upcoming.map(r => r.id), guestId);
  await email(g.email, 'Your ID proof was not accepted',
    `<h2 style="font-family:Georgia,serif;">Please upload a new ID proof</h2><p>${esc(why)}</p><p>Upload a clear photo or PDF of a valid government ID in My Bookings.${upcoming.length ? ' Your upcoming bookings are kept only if a valid ID is added in time.' : ''}</p>`);
  return { status: 'rejected', bookingsAffected: upcoming.length };
}

// Scheduler: bookings whose ID deadline has passed with still no valid ID
// are cancelled and refunded in full. Each booking is claimed first, so it
// is cancelled and refunded once.
async function enforceIdDeadlines(sql, razorpay, { deadlineMs = 4000 } = {}) {
  const started = Date.now();
  const out = { cancelled: 0, failed: 0 };
  if (!razorpay) return { ...out, skipped: 'Razorpay keys not set' };
  let due = [];
  try {
    due = await sql`SELECT o.*, g.id_status, g.id_document_url FROM orders o LEFT JOIN guests g ON g.id = o.guest_id
                    WHERE o.status = 'paid' AND o.id_required_by IS NOT NULL AND o.id_required_by <= now() ORDER BY o.id_required_by LIMIT 20`;
  } catch (err) { return { ...out, skipped: 'not ready' }; }
  for (const o of due) {
    if (Date.now() - started > deadlineMs) break;
    if (idValid(o)) { await sql`UPDATE orders SET id_required_by = NULL WHERE id = ${o.id}`; continue; }
    const token = 'id-' + o.id + '-' + Date.now();
    const got = await sql`UPDATE orders SET cancel_claim = ${token}, cancel_claimed_at = now()
                          WHERE id = ${o.id} AND status = 'paid' AND (cancel_claim IS NULL OR cancel_claimed_at < now() - interval '10 minutes') RETURNING id`;
    if (!got.length) continue;
    try {
      // Everything the guest paid for this booking comes back.
      const paid = (await paidByOrderRow(sql, o.razorpay_order_id))[o.id] || { paid: 0, couponAbsorbed: 0 };
      const cash = Math.max(0, paid.paid);
      const refund = await hasChangePayments(sql, o.id)
        ? { id: (await refundAcrossPayments(sql, razorpay, { orderId: o.id, amountInr: cash, kindBase: 'cancellation' })).firstRefundId }
        : await safeRefund(sql, razorpay, { orderId: o.id, paymentId: o.razorpay_payment_id, amountSubunit: cash * 100, kind: 'cancellation' });
      await sql`UPDATE orders SET status = 'cancelled', cancelled_at = now(), id_required_by = NULL,
                  cancellation_reason = 'Cancelled by Aerva — no valid ID proof was added in time. Refunded in full.',
                  deposit_status = CASE WHEN deposit_status IN ('held', 'disputed') THEN 'refunded' ELSE deposit_status END,
                  deposit_refund_id = ${refund.id}, payout_amount = 0, commission_amount = 0, refund_percent = 100,
                  cancel_claim = NULL, cancel_claimed_at = NULL
                WHERE id = ${o.id} AND cancel_claim = ${token}`;
      try { await sql`UPDATE payouts SET status = 'cancelled' WHERE order_id = ${o.id} AND status = 'due'`; } catch (e) { /* none */ }
      if (paid.couponAbsorbed > 0) {
        const { returnCouponValue } = require('./_cancellations');
        await returnCouponValue(sql, { razorpayOrderId: o.razorpay_order_id, amount: paid.couponAbsorbed, sourceOrderId: o.id, guestEmail: o.guest_email, suiteName: o.suite_name });
      }
      await logAudit(sql, { action: 'booking_cancelled_no_id', success: true, actorType: 'system', targetType: 'order', targetId: o.id, metadata: { refundedInr: cash } });
      await email(o.guest_email, `Your booking at ${o.suite_name} was cancelled`,
        `<h2 style="font-family:Georgia,serif;">Your booking was cancelled</h2><p>No valid ID proof was added in time, so your booking at <strong>${esc(o.suite_name)}</strong> was cancelled.</p>
         <p>Everything you paid — <strong>₹${cash.toLocaleString('en-IN')}</strong> — is being refunded in full to your original payment method.</p>`);
      out.cancelled++;
    } catch (err) {
      await sql`UPDATE orders SET cancel_claim = NULL, cancel_claimed_at = NULL WHERE id = ${o.id} AND cancel_claim = ${token}`;
      console.error('no-ID cancellation failed:', o.id, err.message);
      out.failed++;
    }
  }
  return out;
}

// For the account screen and hosts: status only, never the document.
async function idSummary(sql, guestId) {
  const g = await guestRow(sql, guestId);
  return { hasPhone: !!String((g && g.phone) || '').trim(), idStatus: (g && g.id_status) || null, idType: (g && g.id_document_type) || null,
           idRejectionReason: (g && g.id_status === 'rejected' && g.id_rejection_reason) || null };
}
// For admins only.
function idDocumentUrlForAdmin(stored) { return decryptField(stored); }

module.exports = {
  ID_TYPES, ID_GRACE_HOURS, idValid, bookingRequirements, assertCanBook, saveIdDocument, markIdDeadlineIfMissing,
  reviewIdDocument, enforceIdDeadlines, idSummary, idDocumentUrlForAdmin, idDeadline
};
