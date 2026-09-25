// /api/_guest-id.js — what an account needs before it can book.
// Not an endpoint.
//
// An Aerva account is ONE email address and ONE phone number
// (migration_email_otp.sql enforces both):
//
//   • the EMAIL is confirmed by a code sent to it (_email-otp.js). Email
//     costs nothing to send; every SMS or WhatsApp message is billed per
//     message, which is why the code goes there and not to the phone.
//   • the PHONE is recorded, not code-checked. It is what the host uses to
//     reach the guest about the stay, and it goes to them with the guest's
//     name and the number of guests.
//
// Aerva does NOT ask guests for an identity document. The host checks a
// government photo ID at check-in, which is their duty under the law, and
// files Form III for foreign guests. Asking twice only costs bookings.

const userError = (message, status = 400, extra = {}) => Object.assign(new Error(message), { isUserFacing: true, status }, extra);

async function guestRow(sql, guestId) {
  try {
    return (await sql`SELECT id, email, name, phone, deleted_at,
                             to_jsonb(guests)->>'email_verified_at' AS email_verified_at,
                             to_jsonb(guests)->>'first_name' AS first_name, to_jsonb(guests)->>'last_name' AS last_name
                      FROM guests WHERE id = ${guestId}`)[0] || null;
  } catch (err) {
    // Before migration_email_otp.sql: the columns are not there yet.
    return (await sql`SELECT id, email, name, phone, deleted_at FROM guests WHERE id = ${guestId}`)[0] || null;
  }
}

function emailConfirmed(g) { return !!(g && String(g.email || '').trim() && g.email_verified_at); }
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
// This file used to drive an identity-document flow: a guest who paid
// without a valid ID on their account was given a short deadline to add
// one. That whole feature is gone — the host checks a government photo
// ID at check-in, which is their duty under the law — so there is no
// deadline to set and this does nothing.
//
// It is NOT removed, and must not be. Deleting the export does not fail
// at import: destructuring a missing name just yields undefined, and the
// call then throws "markIdDeadlineIfMissing is not a function" at the
// end of confirmBooking — AFTER the booking has been written and the
// guest charged. The booking would be saved and the guest told their
// payment failed. Anything calling into this module must keep resolving.
async function markIdDeadlineIfMissing() { /* no identity document is asked for any more */ }

module.exports = { emailConfirmed, hasPhone, bookingRequirements, assertCanBook, idSummary, markIdDeadlineIfMissing };
