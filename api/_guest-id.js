// /api/_guest-id.js — what an account needs before it can START a checkout.
// Not an endpoint.
//
// An Aerva account is ONE email address and ONE phone number
// (migration_email_otp.sql enforces both):
//
//   • the EMAIL is confirmed by a code sent to it (_email-otp.js);
//   • a PHONE number is on the account. It is what the host uses to reach
//     the guest about the stay, and it goes to them with the guest's name
//     and the number of guests once the booking is confirmed.
//
// These two, with the guest's first and last name (create-order.js), are
// all that is needed to PAY. What it takes for the booking to be CONFIRMED
// is decided in _guest-verify.js (owner, 10 Nov 2026):
//
//   A booking is only confirmed once the guest's details are submitted and
//   verified — a VERIFIED PROFILE: first and last name saved, the phone
//   confirmed with an SMS code (Twilio Verify; guests.phone_verified_at for
//   that number, cleared when the number changes), and a government photo
//   ID verified (Aadhaar, passport, driving licence or voter ID; read in
//   memory and never stored — only the type, the last 4 characters, the
//   name-match result, when, and the method are kept).
//
//   A guest who is already verified books exactly as before. One who is not
//   pays as before, but the payment is HELD: the dates are kept for them, and
//   there is no booking, code, host email or payout until the three steps
//   are done — by the deadline (24 hours, or 10 AM on the check-in day if
//   earlier; 1 hour for a same-day booking), or everything is refunded.
//
//   That applies only once migrations/2026-11-10-09-guest-verification.sql
//   has run AND the Vercel setting GUEST_VERIFICATION_REQUIRED=1 is on.
//   Before the update nothing changes; with the update but without the
//   switch, "Verify phone" and "Verify ID" are optional steps in the Profile.
//
// The host STILL checks a government photo ID at check-in, which is their
// duty under the law, and files Form III for foreign guests.

const userError = (message, status = 400, extra = {}) => Object.assign(new Error(message), { isUserFacing: true, status }, extra);

async function guestRow(sql, guestId) {
  try {
    return (await sql`SELECT id, email, name, phone, deleted_at, email_verified,
                             to_jsonb(guests)->>'email_verified_at' AS email_verified_at,
                             to_jsonb(guests)->>'first_name' AS first_name, to_jsonb(guests)->>'last_name' AS last_name
                      FROM guests WHERE id = ${guestId}`)[0] || null;
  } catch (err) {
    // Before migration_email_otp.sql: the columns are not there yet.
    return (await sql`SELECT id, email, name, phone, deleted_at, email_verified FROM guests WHERE id = ${guestId}`)[0] || null;
  }
}

// Confirmed by the code (email_verified_at), or earlier by the sign-up link
// or Google (email_verified) — either proves the inbox is theirs.
function emailConfirmed(g) { return !!(g && String(g.email || '').trim() && (g.email_verified_at || g.email_verified === true)); }
function hasPhone(g) { return !!(g && String(g.phone || '').trim()); }

// What the account still needs: [] when it is ready to book.
//   'login' — nobody is signed in, or the account is gone
//   'email' — no email on the account, or it has not been confirmed
//   'phone' — no phone number on the account
async function bookingRequirements(sql, guestId) {
  if (!guestId) return ['login'];
  const g = await guestRow(sql, guestId);
  if (!g || g.deleted_at) return ['login'];
  const missing = [];
  if (!emailConfirmed(g)) missing.push('email');
  if (!hasPhone(g)) missing.push('phone');
  return missing;
}

// The checkout gate. Throws a user-facing error naming what is missing, so
// the page can ask for exactly that and then carry on where it left off.
async function assertCanBook(sql, guestId) {
  if (!guestId) throw userError('Please log in or create an account to book.', 401, { needs: ['login'] });
  const g = await guestRow(sql, guestId);
  if (!g || g.deleted_at) throw userError('Please log in again.', 401, { needs: ['login'] });
  const needs = [];
  if (!emailConfirmed(g)) needs.push('email');
  if (!hasPhone(g)) needs.push('phone');
  if (needs.length) {
    const what = needs.length === 2
      ? 'Please confirm your email address and add your mobile number'
      : needs[0] === 'email' ? 'Please confirm your email address with the code we send you'
      : 'Please add your mobile number, so your host can reach you';
    throw userError(`${what} to continue to payment.`, 400, { needs });
  }
  return g;
}

// For the account screen and the checkout panel: what is on the account and
// what still has to be confirmed. Never more than the person's own.
async function idSummary(sql, guestId) {
  const g = await guestRow(sql, guestId);
  return {
    email: (g && g.email) || null,
    emailConfirmed: emailConfirmed(g),
    phone: (g && g.phone) || null,
    hasPhone: hasPhone(g)
  };
}

// Kept so that _confirm-booking.js, which does
//     const { markIdDeadlineIfMissing } = require('./_guest-id');
// and calls it at the very end of confirmBooking, keeps working.
//
// This file used to drive an older identity-document flow: a guest who
// paid without a valid ID on their account was given a short deadline to
// add one AFTER the booking was confirmed. That flow is gone; since 10 Nov
// 2026 an unverified guest's payment is held BEFORE any booking exists
// (_guest-verify.js holdIfUnverified, called earlier in confirmBooking), so
// by the time this runs there is nothing left to set and it does nothing.
//
// It is NOT removed, and must not be. Deleting the export does not fail
// at import: destructuring a missing name just yields undefined, and the
// call then throws "markIdDeadlineIfMissing is not a function" at the
// end of confirmBooking — AFTER the booking has been written and the
// guest charged. The booking would be saved and the guest told their
// payment failed. Anything calling into this module must keep resolving.
async function markIdDeadlineIfMissing() { /* nothing to do: see _guest-verify.js */ }

module.exports = { emailConfirmed, hasPhone, bookingRequirements, assertCanBook, idSummary, markIdDeadlineIfMissing };
