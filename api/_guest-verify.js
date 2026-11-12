// /api/_guest-verify.js — a booking is only confirmed once the guest's
// details are submitted and verified. Not an endpoint (leading underscore).
// The owner's rules of 10 Nov 2026; needs migrations/2026-11-10-09-guest-verification.sql.
//
// A VERIFIED PROFILE is all three of:
//   1. first and last name saved (guest-profile.js saveName);
//   2. the phone confirmed with an SMS code (Twilio Verify, as phone sign-in
//      does): guests.phone_verified_at for guests.phone_verified_number —
//      a different number on the account is not a confirmed number;
//   3. a government photo ID verified: Aadhaar, passport, driving licence or
//      voter ID (a PAN card is not accepted as a guest's photo ID).
//
// THE ID CHECK. A photo of the ID is read in memory (_id-verify.js
// readDocument, the Anthropic API) and dropped when the answer goes back: it
// is never uploaded, stored or logged. It must be a real ID of an accepted
// type, in the profile's name (the same tolerant matching as a PAN: order,
// initials, middle names), not expired where a date is printed, and 18 or
// over where a date of birth is printed. Kept on the account, and nothing
// else: the type, the last 4 characters of the number, how the name matched,
// when, and the method ('auto' | 'aerva'). 5 tries a day.
// "Send it to Aerva to check instead" (or a check that cannot decide): the
// image is uploaded with the private purpose 'guest-id' (never scanned as a
// photo), shown in Admin → Verifications as "Guest ID", and deleted from
// storage as soon as it is approved or rejected. The guest is emailed.
// Verified once, it stays verified; changing the profile name clears it and
// changing the phone clears the phone's (the database does both, whatever
// part of the site makes the change).
//
// A BOOKING BY AN UNVERIFIED GUEST (only while GUEST_VERIFICATION_REQUIRED
// is on). The payment is taken as always, but it is HELD (verification_holds):
//   • no booking row, confirmation code, host email or payout exists;
//   • the dates stay held for this guest (booking_holds), so nobody else can
//     book them, and the coupon / Aerva credit used stay claimed;
//   • the guest sees, and is emailed, "Your booking will be confirmed once
//     your details are submitted and verified." with the three steps and the
//     deadline; My Bookings shows "Waiting for your details" with a countdown;
//   • the host sees "Waiting for the guest's details" (dates blocked), with
//     no guest name or contact details.
// THE DEADLINE: 24 hours after payment, or 10:00 AM (the property's time) on
// the check-in day, whichever is earlier; when that is less than 1 hour away
// or already past (a same-day booking), 1 hour after payment. Reminders (email
// and bell) at half-time and 1 hour before, where they fit.
// VERIFIED IN TIME → the booking is written by _confirm-booking.js
// finishBooking exactly as a normal one (code, emails to guest and host,
// co-host shares; the payout follows check-in as for any booking).
// AN ID WITH AERVA AT THE DEADLINE → the deadline waits for Aerva's answer,
// to at most 10 AM on the check-in day; Admin lists those IDs first.
// NOT VERIFIED BY THE DEADLINE (or rejected with no time left) → the whole
// payment is refunded to its source, the dates released, the coupon and
// credit given back, no booking is made; the guest is emailed why and the
// host sees the hold go, with a short notice.
//
// GIFTS AND GROUPS (kept simple): a gift's buyer and a group's organiser
// must have a verified profile BEFORE paying (create-order.js); a gift's
// recipient accepts as before (name and phone) and friends in a group pay
// as before — neither needs an ID.
//
// Money: verification_holds.amount_paise / refund_amount are paise.
// Nothing here ever logs an ID number or an image.

const { helpLine } = require('./_help-link');
const { logAudit } = require('./_audit-log');
const { localMidnightMs, releaseHolds, dateStr } = require('./_booking-rules');
const { safeZone } = require('./_timezones');
const { countRecentAttempts } = require('./_rate-limit');
const { normalizeToE164, E164_PATTERN } = require('./_phone-validation');

const ID_TYPES = [
  { key: 'aadhaar', label: 'Aadhaar' },
  { key: 'passport', label: 'Passport' },
  { key: 'driving_licence', label: 'Driving licence' },
  { key: 'voter_id', label: 'Voter ID' }
];
const ID_KEYS = ID_TYPES.map(t => t.key);
const idLabel = (k) => (ID_TYPES.find(t => t.key === k) || {}).label || 'ID';
const ATTEMPTS_PER_DAY = 5;
const DEADLINE_HOURS = 24;
const CHECKIN_HOUR = 10;                 // 10:00 AM on the check-in day, property's time
const SAME_DAY_MINUTES = 60;
const HOLD_SLACK_HOURS = 6;              // booking_holds outlive the deadline by this much (the job releases them on time)
const RECLAIM_MINUTES = 10;
const HELD_TEXT = 'Your booking will be confirmed once your details are submitted and verified.';
const NOT_ON = 'This is not switched on yet. Please try again later.';

const userError = (message, status = 400, extra = {}) => Object.assign(new Error(message), { isUserFacing: true, status }, extra);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const ms = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v));

// The owner's switch. Off (the default): nothing is held — the Profile only
// offers the two checks as optional steps.
const required = () => /^(1|true|yes|on)$/i.test(String(process.env.GUEST_VERIFICATION_REQUIRED || '').trim());

// Has the database update run? Asked again every 30 seconds until it has.
let readyKnown = false, readyAskedAt = 0;
async function ready(sql) {
  if (readyKnown) return true;
  if (Date.now() - readyAskedAt < 30000) return false;
  readyAskedAt = Date.now();
  try {
    await sql`SELECT phone_verified_at, phone_verified_number, guest_id_type, guest_id_last4, guest_id_name_match, guest_id_verified_at, guest_id_method FROM guests LIMIT 0`;
    await sql`SELECT 1 FROM verification_holds LIMIT 0`;
    await sql`SELECT 1 FROM guest_id_reviews LIMIT 0`;
    readyKnown = true;
  } catch (err) { readyKnown = false; }
  return readyKnown;
}
const forgetReady = () => { readyKnown = false; readyAskedAt = 0; };   // for tests

// Razorpay, for the paths that have no client of their own (a phone proved
// at sign-in). null when the keys are not set.
let ownRazorpay = null;
function client(razorpay) {
  if (razorpay) return razorpay;
  if (ownRazorpay) return ownRazorpay;
  try {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
    const Razorpay = require('razorpay');
    ownRazorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  } catch (err) { ownRazorpay = null; }
  return ownRazorpay;
}

// ---------------------------------------------------------------- email
async function sendMail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html })
    });
    return !!(r && r.ok);
  } catch (err) { console.error('guest verification email failed:', err.message); return false; }
}
const frame = (title, body) => `<div style="font-family:sans-serif; max-width:520px;"><h2 style="font-family:Georgia,serif;">${title}</h2>${body}
  <p style="font-size:12px; opacity:0.6; margin-top:24px;">${helpLine({}, 'Questions?')}</p></div>`;
const button = (href, label) => `<p><a href="${href}" style="display:inline-block; background:#1C1B19; color:#fff; padding:12px 20px; border-radius:8px; text-decoration:none;">${label}</a></p>`;
const BOOKINGS_URL = 'https://aerva.in/index.html?view=my-bookings';
const PROFILE_URL = 'https://aerva.in/index.html?view=profile';
const niceDate = (d) => { const s = dateStr(d); return s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : ''; };
// A moment on the property's clock: "Wed, 11 Nov 2026, 10:00 am IST".
function localMoment(at, zone) {
  const z = safeZone(zone);
  const t = new Date(ms(at));
  if (isNaN(t.getTime())) return '';
  const text = t.toLocaleString('en-IN', { timeZone: z, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  return text + (z === 'Asia/Kolkata' ? ' IST' : ' (the property’s time)');
}

// ---------------------------------------------------------------- the account
async function loadAccount(sql, guestId) {
  if (!guestId) return null;
  return (await sql`
    SELECT g.id, g.email, g.name, g.phone, g.host_id, g.deleted_at,
           to_jsonb(g)->>'first_name' AS first_name, to_jsonb(g)->>'last_name' AS last_name,
           to_jsonb(g)->>'phone_verified_at' AS phone_verified_at, to_jsonb(g)->>'phone_verified_number' AS phone_verified_number,
           to_jsonb(g)->>'guest_id_type' AS guest_id_type, to_jsonb(g)->>'guest_id_last4' AS guest_id_last4,
           to_jsonb(g)->>'guest_id_name_match' AS guest_id_name_match, to_jsonb(g)->>'guest_id_verified_at' AS guest_id_verified_at,
           to_jsonb(g)->>'guest_id_method' AS guest_id_method
    FROM guests g WHERE g.id = ${guestId}`)[0] || null;
}
const fullName = (g) => [g && g.first_name, g && g.last_name].map(x => String(x || '').trim()).filter(Boolean).join(' ');
const nameDone = (g) => !!(g && String(g.first_name || '').trim() && String(g.last_name || '').trim());
const phoneDone = (g) => !!(g && String(g.phone || '').trim() && g.phone_verified_at && String(g.phone_verified_number || '') === String(g.phone || '').trim());
const idDone = (g) => !!(g && g.guest_id_verified_at && ID_KEYS.includes(g.guest_id_type));
const allDone = (g) => nameDone(g) && phoneDone(g) && idDone(g);
const maskPhone = (p) => { const s = String(p || '').trim(); return s.length > 4 ? s.slice(0, s.startsWith('+') ? 3 : 0) + '•••••' + s.slice(-3) : s; };

async function isVerified(sql, guestId) {
  if (!(await ready(sql))) return false;
  return allDone(await loadAccount(sql, guestId));
}

async function pendingReview(sql, guestId) {
  try { return (await sql`SELECT id, created_at FROM guest_id_reviews WHERE guest_id = ${guestId} AND status = 'pending' ORDER BY id DESC LIMIT 1`)[0] || null; }
  catch (err) { return null; }
}
async function lastRejection(sql, guestId) {
  try { return (await sql`SELECT id, reason, decided_at FROM guest_id_reviews WHERE guest_id = ${guestId} AND status = 'rejected' ORDER BY id DESC LIMIT 1`)[0] || null; }
  catch (err) { return null; }
}
async function attemptsToday(sql, guestId) {
  try {
    return Number((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'guest_id_check_attempt'
                             AND actor_identifier = ${String(guestId)} AND created_at > now() - interval '24 hours'`)[0].n) || 0;
  } catch (e) { return 0; }
}

// What the Profile, the "waiting for your details" screen and My Bookings
// Has this account's government ID been verified? (A gift's reminder for
// the guest staying, _gifts.js — never a reason to cancel a booking.)
async function idVerified(sql, guestId) {
  if (!guestId || !(await ready(sql))) return false;
  const g = await loadAccount(sql, guestId);
  return idDone(g);
}

// ---------------------------------------------------------------------
// One line for the host on EVERY booking: has Aerva checked the ID of
// the person arriving? (Owner, 12 Nov 2026, suggestion 5.) Before this
// only a gift carried it, so on an ordinary booking a host had no way
// of knowing whether the name on the booking had been checked at all.
//
// The name only — never the document, the number or the last four
// digits, exactly as the gift line does. Rows are mutated in place:
//   row.id_checked  true / false
//   row.id_note     what to do about it, in plain words
// A row that already carries a gift line is left alone: that line
// already says it, for the person who is actually arriving.
// Never throws: on a database without the verification columns every
// row simply goes without the line.
// ---------------------------------------------------------------------
async function idLineForHost(sql, rows, { idKey = 'id' } = {}) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const ids = [...new Set(rows.map(r => Number(r[idKey])).filter(Boolean))];
  if (!ids.length) return rows;
  try {
    const seen = await sql`SELECT o.id AS order_id,
                                  (to_jsonb(g)->>'guest_id_verified_at' IS NOT NULL) AS checked
                           FROM orders o LEFT JOIN guests g ON g.id = o.guest_id
                           WHERE o.id = ANY(${ids})`;
    const by = new Map(seen.map(r => [Number(r.order_id), r.checked === true]));
    rows.forEach(r => {
      if (r.gift) return;                         // the gift line already says it
      if (!by.has(Number(r[idKey]))) return;
      const checked = by.get(Number(r[idKey]));
      r.id_checked = checked;
      r.id_note = checked
        ? 'Aerva has checked their government ID in this name.'
        : 'Aerva has not checked their ID — please check a government ID at check-in, in this name.';
    });
  } catch (err) { /* before the guest-verification update: no line */ }
  return rows;
}

// show: the three steps and where each stands. Never the ID itself.
async function profileStatus(sql, guestId) {
  const on = await ready(sql);
  const g = await loadAccount(sql, guestId);
  if (!g) throw userError('Please log in again.', 401);
  const review = on ? await pendingReview(sql, guestId) : null;
  const rejected = on && !idDone(g) && !review ? await lastRejection(sql, guestId) : null;
  return {
    available: on,
    required: on && required(),
    verified: on && allDone(g),
    smsAvailable: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SERVICE_SID),
    name: { done: nameDone(g), firstName: g.first_name || '', lastName: g.last_name || '' },
    phone: { done: on && phoneDone(g), hasNumber: !!String(g.phone || '').trim(), number: g.phone || null, verifiedAt: on && phoneDone(g) ? g.phone_verified_at : null },
    id: {
      done: on && idDone(g),
      type: on && idDone(g) ? g.guest_id_type : null,
      label: on && idDone(g) ? idLabel(g.guest_id_type) : null,
      last4: on && idDone(g) ? g.guest_id_last4 : null,
      method: on && idDone(g) ? g.guest_id_method : null,
      verifiedAt: on && idDone(g) ? g.guest_id_verified_at : null,
      withAerva: !!review,
      rejectedReason: rejected ? (rejected.reason || 'Aerva could not accept this ID.') : null,
      attemptsLeft: on ? Math.max(0, ATTEMPTS_PER_DAY - await attemptsToday(sql, guestId)) : 0,
      digilocker: on && !idDone(g) && !review && require('./_digilocker').ready(),
      accepted: ID_TYPES.map(t => t.label)
    }
  };
}

// For the session check (guest-auth.js GET): what the "Complete your
// profile" pop-up needs to decide. Works before the database update too.
function profilePrompt(guest) {
  const g = guest || {};
  const parts = String(g.name || '').trim().split(/\s+/).filter(Boolean);
  const first = String(g.first_name || '').trim(), last = String(g.last_name || '').trim();
  const phone = String(g.phone || '').trim();
  const missing = [];
  if (!first) missing.push('firstName');
  if (!last) missing.push('lastName');
  if (!phone) missing.push('phone');
  return { needed: missing.length > 0, missing,
    // What is already known is filled in (a Google or older account has only the full name).
    firstName: first || (!last && parts.length ? parts[0] : ''),
    lastName: last || (!first && parts.length > 1 ? parts.slice(1).join(' ') : ''),
    phone, isHost: !!g.host_id };
}

// ---------------------------------------------------------------- 2. the phone
const twilioAuth = () => 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
const twilioReady = () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SERVICE_SID);
const SMS_OFF = 'Text-message codes are not available right now. Please try again later.';

// POST { mode: 'sendPhoneCode' } — a code to the number already on the account.
async function sendPhoneCode(sql, { guestId, ip = null }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  const g = await loadAccount(sql, guestId);
  if (!g || g.deleted_at) throw userError('Please log in again.', 401);
  const phone = normalizeToE164(String(g.phone || ''));
  if (!phone || !E164_PATTERN.test(phone)) throw userError('Add your mobile number first.', 400, { needs: ['phone'] });
  if (phoneDone(g)) return { alreadyVerified: true };
  if (!twilioReady()) throw userError(SMS_OFF, 503);
  // Every text message is billed: capped per account and per connection
  // before Twilio is asked (Twilio also limits each number itself).
  const byAccount = await countRecentAttempts(sql, { action: 'guest_phone_verify_requested', windowMinutes: 60, byActor: String(guestId) });
  const byIp = ip ? await countRecentAttempts(sql, { action: 'guest_phone_verify_requested', windowMinutes: 60, byIp: ip }) : 0;
  if (byAccount >= 5 || byIp >= 10) throw userError('Too many codes have been asked for. Please try again in an hour.', 429);
  let ok = false, status = 0;
  try {
    const r = await fetch(`https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/Verifications`, {
      method: 'POST', headers: { 'Authorization': twilioAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: phone, Channel: 'sms' })
    });
    ok = !!(r && r.ok); status = r ? r.status : 0;
  } catch (err) { console.error('Twilio Verify (start) not reached:', err.message); }
  await logAudit(sql, { action: 'guest_phone_verify_requested', success: ok, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId,
    metadata: { ip, ...(ok ? {} : { reason: 'twilio_error', status }) } });
  if (!ok) {
    // 401 / 403: Aerva's own SMS account. 429: the provider's limit. Neither is the guest's number.
    if (status === 429) throw userError('Too many codes have been sent to this number. Please try again in a little while.', 429);
    if (status >= 400 && status < 500 && status !== 401 && status !== 403) throw userError('That phone number could not be reached. Please check it in your profile.', 400);
    throw userError('Could not send the code right now. Please try again shortly.', 503);
  }
  return { sent: true, to: maskPhone(phone) };
}

// POST { mode: 'checkPhoneCode', code } — confirms the number on the account.
async function confirmPhoneCode(sql, razorpay, { guestId, code, ip = null }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  const g = await loadAccount(sql, guestId);
  if (!g || g.deleted_at) throw userError('Please log in again.', 401);
  const phone = normalizeToE164(String(g.phone || ''));
  if (!phone || !E164_PATTERN.test(phone)) throw userError('Add your mobile number first.', 400, { needs: ['phone'] });
  if (phoneDone(g)) return { verified: true, already: true, confirmed: [] };
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length < 4 || clean.length > 10) throw userError('Please enter the code you received.');
  if (!twilioReady()) throw userError(SMS_OFF, 503);
  const fails = await countRecentAttempts(sql, { action: 'guest_phone_verify_checked', windowMinutes: 60, byActor: String(guestId), onlyFailures: true });
  if (fails >= 10) throw userError('Too many incorrect codes. Please try again later.', 429);
  let approved = false;
  try {
    const r = await fetch(`https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`, {
      method: 'POST', headers: { 'Authorization': twilioAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: phone, Code: clean })
    });
    // The provider itself failing is not a wrong code, and is not counted as one.
    if (r && (r.status >= 500 || r.status === 429 || r.status === 401 || r.status === 403)) throw new Error('provider HTTP ' + r.status);
    const d = r ? await r.json().catch(() => null) : null;
    approved = !!(r && r.ok && d && d.status === 'approved');
  } catch (err) { console.error('Twilio Verify (check) not reached:', err.message); throw userError('Could not check that code right now. Please try again.', 503); }
  if (!approved) {
    await logAudit(sql, { action: 'guest_phone_verify_checked', success: false, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId, metadata: { ip, reason: 'code_rejected' } });
    throw userError('That code is incorrect or has expired. Please ask for a new one.', 400);
  }
  // Only if the number is still the one the code went to.
  const set = await sql`UPDATE guests SET phone_verified_at = now(), phone_verified_number = phone WHERE id = ${guestId} AND btrim(phone) = ${String(g.phone).trim()} RETURNING id`;
  if (!set.length) throw userError('Your phone number changed while the code was being checked. Please ask for a new code.', 409);
  try { await sql`UPDATE guests SET phone_verified = true WHERE id = ${guestId}`; } catch (e) { /* before migration_session_version.sql */ }
  await logAudit(sql, { action: 'guest_phone_verify_checked', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId, metadata: { ip } });
  return { verified: true, confirmed: await confirmHoldsFor(sql, razorpay, guestId) };
}

// A number proved by code elsewhere (phone sign-in, guest-phone-auth.js
// 'verify' / 'link'): the same proof. Never throws.
async function markPhoneProved(sql, razorpay, guestId) {
  try {
    if (!(await ready(sql))) return;
    await sql`UPDATE guests SET phone_verified_at = now(), phone_verified_number = phone WHERE id = ${guestId} AND phone IS NOT NULL AND btrim(phone) <> ''`;
    await confirmHoldsFor(sql, razorpay, guestId);
  } catch (err) { console.error('phone proof not recorded for booking verification:', err.message); }
}

// ---------------------------------------------------------------- 3. the ID
const words = (s) => String(s || '').toUpperCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(Boolean);
// The profile name against the name printed on the ID — the same tolerant
// matching as a PAN (_pan-verify.js): order and initials (namesMatch), and
// middle names printed on the ID but not in the profile.
function nameMatch(profileName, printed) {
  const { namesMatch } = require('./_id-verify');
  if (!printed) return null;
  if (namesMatch(profileName, printed)) return 'exact';
  const t = words(profileName), c = words(printed);
  if (t.length >= 2 && c.length > t.length && t[0] === c[0] && t[t.length - 1] === c[c.length - 1] && t.every(w => c.includes(w))) return 'middle_names';
  // Initials printed with the name ("RAVI KUMAR S", "S RAVI KUMAR"), as many
  // IDs do: the single letters are set aside and the rest must be the profile's name.
  const noInitials = c.filter(w => w.length > 1);
  if (t.length >= 2 && noInitials.length >= 2 && noInitials.length < c.length && namesMatch(profileName, noInitials.join(' '))) return 'middle_names';
  return null;
}
// Age in whole years on `today` for a date of birth 'YYYY-MM-DD' ('YYYY'
// alone → { min, max }: the year only says it within one year).
function ageRange(dob, today) {
  const t = String(dob || '').trim();
  const [ty, tm, td] = today.split('-').map(Number);
  let m;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    const age = ty - +m[1] - ((tm < +m[2] || (tm === +m[2] && td < +m[3])) ? 1 : 0);
    return { min: age, max: age };
  }
  if ((m = t.match(/^(\d{4})$/))) return { min: ty - +m[1] - 1, max: ty - +m[1] };
  return null;
}
// What was read against the profile. Returns
//   { ok: true, type, last4, nameMatch }
//   { ok: false, reason, decided }  decided: a clear refusal (wrong type, name,
//                                   expired, under 18); otherwise it could not decide.
// The reason is for the audit log and for choosing the message; never an ID number.
function judgeGuestId(read, { profileName, today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10) }) {
  const r = read || {};
  const no = (reason, decided = false) => ({ ok: false, reason, decided });
  const idv = require('./_id-verify');
  const type = idv.docTypeKey(r.document_type);
  if (type === 'pan') return no('pan_not_accepted', true);
  if (r.is_identity_document !== true || type === 'none' || !type) return no('not_an_id', true);
  if (!ID_KEYS.includes(type)) return no('wrong_type', true);
  if (r.readable === false) return no('unreadable');
  if (r.looks_genuine !== true) return no('not_genuine');
  if (r.has_holder_photo === false) return no('no_photo');
  if (idv.seriousConcerns(r.concerns).length) return no('concerns');
  if (r.expiry_date != null && r.expiry_date !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.expiry_date))) return no('expiry_unreadable');
    if (String(r.expiry_date) < today) return no('expired', true);
  }
  if (r.date_of_birth != null && r.date_of_birth !== '') {
    const age = ageRange(r.date_of_birth, today);
    if (!age || !idv.plausibleBirth(r.date_of_birth, today)) return no('dob_unreadable');   // a misread date is not a refusal
    if (age.max < 18) return no('under_18', true);
    if (age.min < 18) return no('age_unclear');            // only the year is printed, and it is the 18th year
  }
  const how = nameMatch(profileName, r.full_name);
  if (!r.full_name) return no('name_unreadable');
  if (!how) return no('name', true);
  const last4 = String(r.id_number || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-4);
  if (!idv.realLast4(last4)) return no('number_unreadable');     // fully masked ("XXXX") or too short
  return { ok: true, type, last4, nameMatch: how };
}
const REFUSALS = {
  pan_not_accepted: 'A PAN card is not accepted as a photo ID. Use your Aadhaar, passport, driving licence or voter ID.',
  not_an_id: 'This does not look like a government photo ID. Use your Aadhaar, passport, driving licence or voter ID.',
  wrong_type: 'This type of ID is not accepted. Use your Aadhaar, passport, driving licence or voter ID.',
  expired: 'This ID has expired. Use an ID that is still valid.',
  under_18: 'You must be 18 or over to book on Aerva.',
  name: 'The name on this ID does not match the name in your profile. Use an ID in your own name, or correct your name in your profile.'
};
const UNDECIDED = 'We could not verify this ID from the photo. Try a clear, straight photo of the whole ID, or send it to Aerva to check instead.';

async function saveVerifiedId(sql, guestId, { type, last4, nameMatch: how, method }) {
  const r = await sql`UPDATE guests SET guest_id_type = ${type}, guest_id_last4 = ${last4}, guest_id_name_match = ${how},
                                        guest_id_verified_at = now(), guest_id_method = ${method}
                      WHERE id = ${guestId} RETURNING id`;
  return r.length > 0;
}

// POST { mode: 'checkGuestId', files: [{ type, data(base64) }] } — the instant check.
async function checkGuestId(sql, razorpay, { guestId, files }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  const idv = require('./_id-verify');
  const g = await loadAccount(sql, guestId);
  if (!g || g.deleted_at) throw userError('Please log in again.', 401);
  if (idDone(g)) return { verified: true, already: true, id: { type: g.guest_id_type, label: idLabel(g.guest_id_type), last4: g.guest_id_last4 }, confirmed: [] };
  if (!nameDone(g)) throw userError('Add your first and last name first, as on your ID.', 400, { needs: ['name'] });
  if (await pendingReview(sql, guestId)) throw userError('Your ID is already with Aerva to check. We will email you as soon as it is done.', 409, { withAerva: true });
  if (await attemptsToday(sql, guestId) >= ATTEMPTS_PER_DAY) {
    throw userError('Too many tries today. Send it to Aerva to check instead, or try again tomorrow.', 429, { canSendForReview: true });
  }
  const decoded = idv.decodeFiles(files);
  const profileName = fullName(g);
  let read = null, readError = null;
  try { read = await idv.readDocument(decoded); }
  catch (err) { readError = err; }
  finally { decoded.forEach(f => f.bytes.fill(0)); }      // nothing of the ID outlives the request
  if (!read) {
    // The check itself could not run: not one of the day's tries.
    await logAudit(sql, { action: 'guest_id_check_unavailable', success: false, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId, metadata: { reason: String((readError && (readError.checkReason || readError.message)) || 'unknown').slice(0, 240), files: decoded.map(f => f.type) } });
    if (readError && !readError.isUserFacing) throw readError;
    throw userError(readError && readError.status === 400 ? readError.message : 'The check is not available right now. Try again in a minute, or send it to Aerva to check instead.',
      readError && readError.status === 400 ? 400 : 503, { canSendForReview: true, undecided: true });
  }
  const verdict = judgeGuestId(read, { profileName });
  const seen = String(read.document_type || '');
  await logAudit(sql, { action: 'guest_id_check_attempt', success: verdict.ok, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId,
    metadata: { reason: verdict.reason || null, docType: verdict.ok ? verdict.type : (ID_KEYS.concat(['pan', 'national_id', 'other', 'none']).includes(seen) ? seen : null) } });
  if (!verdict.ok) {
    throw userError(verdict.decided ? REFUSALS[verdict.reason] : UNDECIDED, 400, { canSendForReview: true, undecided: !verdict.decided, refusal: verdict.decided ? verdict.reason : null,
      attemptsLeft: Math.max(0, ATTEMPTS_PER_DAY - await attemptsToday(sql, guestId)) });
  }
  // The profile name must still be the one it was checked against.
  const now = await loadAccount(sql, guestId);
  if (!now || fullName(now).toLowerCase() !== profileName.toLowerCase()) throw userError('Your name changed while the ID was being checked. Please try again.', 409);
  await saveVerifiedId(sql, guestId, { type: verdict.type, last4: verdict.last4, nameMatch: verdict.nameMatch, method: 'auto' });
  await logAudit(sql, { action: 'guest_id_verified', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId,
    metadata: { method: 'auto', docType: verdict.type, nameMatch: verdict.nameMatch } });
  return { verified: true, id: { type: verdict.type, label: idLabel(verdict.type), last4: verdict.last4 }, confirmed: await confirmHoldsFor(sql, razorpay, guestId) };
}

// The older "Verify your ID" in Account Settings (_id-verify.js: the guest
// types the name, date of birth and last 4, all matched against the ID)
// counts too when it meets the same rules: an accepted type, in the profile's
// name, 18 or over. Never throws.
async function adoptFromIdVerify(sql, razorpay, guestId, { docType, dob, verification }) {
  try {
    if (!(await ready(sql)) || !verification || !ID_KEYS.includes(docType)) return false;
    const g = await loadAccount(sql, guestId);
    if (!g || idDone(g) || !nameDone(g)) return false;
    const how = nameMatch(fullName(g), verification.name);
    const last4 = String(verification.last4 || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-4);
    const age = ageRange(String(dob || '').slice(0, 10), new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10));
    if (!how || last4.length !== 4 || !age || age.min < 18) return false;
    await saveVerifiedId(sql, guestId, { type: docType, last4, nameMatch: how, method: 'auto' });
    await logAudit(sql, { action: 'guest_id_verified', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId,
      metadata: { method: 'auto', docType, nameMatch: how, from: 'account_settings' } });
    await confirmHoldsFor(sql, razorpay, guestId);
    return true;
  } catch (err) { console.error('ID verification not carried to booking verification:', err.message); return false; }
}

// ---------------------------------------------------------------- DigiLocker
// The easiest route for an Indian guest: they log in to their own
// DigiLocker and approve sharing their Aadhaar. Aerva reads the name, the
// date of birth and the masked number, checks the same three rules as the
// photo check (name, 18 or over, a readable last 4), and keeps nothing
// else. See api/_digilocker.js.

// POST { mode: 'startDigiLocker' } → { url } to send the guest to.
async function startDigiLocker(sql, { guestId }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  const DL = require('./_digilocker');
  if (!DL.ready()) throw userError('DigiLocker is not available right now. Use a photo of your ID instead.', 503);
  const g = await loadAccount(sql, guestId);
  if (!g || g.deleted_at) throw userError('Please log in again.', 401);
  if (idDone(g)) return { verified: true, already: true, id: { type: g.guest_id_type, label: idLabel(g.guest_id_type), last4: g.guest_id_last4 }, confirmed: [] };
  if (!nameDone(g)) throw userError('Add your first and last name first, as on your Aadhaar.', 400, { needs: ['name'] });
  if (await pendingReview(sql, guestId)) throw userError('Your ID is already with Aerva to check. We will email you as soon as it is done.', 409, { withAerva: true });
  if (!(await DL.table(sql))) throw userError('DigiLocker is not available right now. Use a photo of your ID instead.', 503);
  if (await DL.startsToday(sql, guestId) >= DL.STARTS_PER_DAY()) {
    throw userError('Too many tries today. Use a photo of your ID, send it to Aerva to check instead, or try again tomorrow.', 429, { canSendForReview: true });
  }
  const verificationId = DL.newVerificationId(guestId);
  const back = DL.RETURN_URL() + (DL.RETURN_URL().includes('?') ? '&' : '?') + 'digilocker=' + encodeURIComponent(verificationId);
  let started;
  try { started = await DL.provider().start(verificationId, back); }
  catch (err) {
    await logAudit(sql, { action: 'digilocker_unavailable', success: false, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId,
      metadata: { reason: String((err && err.reason) || (err && err.message) || 'unknown').slice(0, 240), provider: DL.PROVIDER() } });
    if (err && err.isUserFacing) throw userError(err.message, err.status || 503, { canSendForReview: true });
    throw userError('DigiLocker could not be opened right now. Use a photo of your ID instead.', 503, { canSendForReview: true });
  }
  await sql`INSERT INTO digilocker_checks (guest_id, verification_id, reference_id, provider, profile_name)
            VALUES (${guestId}, ${verificationId}, ${started.referenceId}, ${DL.PROVIDER()}, ${fullName(g)})`;
  await logAudit(sql, { action: 'digilocker_started', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId,
    metadata: { provider: DL.PROVIDER() } });
  return { url: started.url, verificationId, confirmed: [] };
}

// POST { mode: 'finishDigiLocker', verificationId } — after the guest comes back.
async function finishDigiLocker(sql, razorpay, { guestId, verificationId }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  const DL = require('./_digilocker');
  const idv = require('./_id-verify');
  const g = await loadAccount(sql, guestId);
  if (!g || g.deleted_at) throw userError('Please log in again.', 401);
  if (idDone(g)) return { verified: true, already: true, id: { type: g.guest_id_type, label: idLabel(g.guest_id_type), last4: g.guest_id_last4 }, confirmed: [] };
  const vid = String(verificationId || '').trim();
  if (!vid || vid.length > 60) throw userError('That DigiLocker check could not be found. Please start again.', 400);
  const row = (await sql`SELECT id, status, profile_name FROM digilocker_checks WHERE verification_id = ${vid} AND guest_id = ${guestId}`)[0];
  if (!row) throw userError('That DigiLocker check could not be found. Please start again.', 404);
  if (row.status !== 'pending') throw userError('That DigiLocker check is already finished. Please start again.', 409);

  const close = async (status, reason) => {
    await sql`UPDATE digilocker_checks SET status = ${status}, reason = ${reason || null}, finished_at = now() WHERE id = ${row.id}`;
  };
  let read;
  try { read = await DL.provider().read(vid); }
  catch (err) {
    await logAudit(sql, { action: 'digilocker_unavailable', success: false, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId,
      metadata: { reason: String((err && err.reason) || (err && err.message) || 'unknown').slice(0, 240), provider: DL.PROVIDER() } });
    throw userError((err && err.isUserFacing && err.message) || 'We could not reach DigiLocker just now. Please try again in a minute.', 503, { canSendForReview: true, undecided: true });
  }
  if (read.state === 'waiting') return { waiting: true, confirmed: [] };
  if (read.state !== 'ok') {
    const text = read.state === 'expired' ? 'That DigiLocker link expired. Please start again.'
      : read.state === 'denied' ? 'You did not approve sharing your Aadhaar, so nothing was checked. You can try again, or use a photo of your ID.'
      : 'Your Aadhaar is not linked in DigiLocker, so it could not be shared. Use a photo of your ID instead.';
    await close(read.state === 'expired' ? 'expired' : 'denied', read.state);
    await logAudit(sql, { action: 'digilocker_attempt', success: false, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId,
      metadata: { reason: read.state, provider: DL.PROVIDER() } });
    throw userError(text, 400, { canSendForReview: true, undecided: read.state !== 'denied' });
  }

  // Only the three things below are looked at; the rest of the answer is dropped.
  const profileName = fullName(g);
  const how = nameMatch(profileName, read.name);
  const dob = DL.normalizeDob(read.dob);
  const age = dob ? ageRange(dob, new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)) : null;
  const last4 = DL.last4Of(read.uid);
  let refusal = null;
  if (!how) refusal = 'name';
  else if (!age || !idv.plausibleBirth(dob, new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10))) refusal = 'dob_unreadable';
  else if (age.min < 18) refusal = 'under_18';
  else if (!idv.realLast4(last4)) refusal = 'number_unreadable';
  await logAudit(sql, { action: 'digilocker_attempt', success: !refusal, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId,
    metadata: { reason: refusal, nameMatch: refusal ? null : how, provider: DL.PROVIDER() } });
  if (refusal) {
    await close('refused', refusal);
    const text = REFUSALS[refusal] || 'We could not verify your Aadhaar through DigiLocker. Use a photo of your ID instead.';
    throw userError(text, 400, { canSendForReview: true, refusal: REFUSALS[refusal] ? refusal : null, undecided: !REFUSALS[refusal] });
  }
  // The profile name must still be the one it was checked against.
  const now = await loadAccount(sql, guestId);
  if (!now || fullName(now).toLowerCase() !== profileName.toLowerCase()) {
    await close('refused', 'name_changed');
    throw userError('Your name changed while DigiLocker was being checked. Please try again.', 409);
  }
  await saveVerifiedId(sql, guestId, { type: 'aadhaar', last4, nameMatch: how, method: 'digilocker' });
  await close('verified', null);
  await logAudit(sql, { action: 'guest_id_verified', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId,
    metadata: { method: 'digilocker', docType: 'aadhaar', nameMatch: how } });
  return { verified: true, id: { type: 'aadhaar', label: idLabel('aadhaar'), last4 }, confirmed: await confirmHoldsFor(sql, razorpay, guestId) };
}

// ---- "Send it to Aerva to check instead" ----
// POST { mode: 'sendGuestIdForReview', url } — url: the image just uploaded
// with blob-upload purpose 'guest-id'.
async function sendForReview(sql, { guestId, url }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  const { isAervaBlobUrl } = require('./_listing-rules');
  const g = await loadAccount(sql, guestId);
  if (!g || g.deleted_at) throw userError('Please log in again.', 401);
  const clean = String(url || '').trim();
  if (!isAervaBlobUrl(clean) || clean.length > 600) throw userError('Add a photo of your ID.');
  // Only a file this account uploaded as its ID just now (blob-upload.js,
  // purpose 'guest-id', named guest-id-<time>): this image is deleted from
  // storage below and after the decision, so any other Aerva file's address —
  // a listing's photos, someone else's upload — must never be accepted here.
  if (!(await ownIdUpload(sql, guestId, clean))) throw userError('Add a photo of your ID.');
  if (idDone(g)) { await eraseImage(clean); return { verified: true, already: true }; }
  if (!nameDone(g)) { await eraseImage(clean); throw userError('Add your first and last name first, as on your ID.', 400, { needs: ['name'] }); }
  let row;
  try {
    row = (await sql`INSERT INTO guest_id_reviews (guest_id, document_url) VALUES (${guestId}, ${clean}) RETURNING id, created_at`)[0];
  } catch (err) {
    if (/idx_guest_id_reviews_one_pending|duplicate key/i.test(String(err.message))) {
      await eraseImage(clean);     // the second copy is not needed
      throw userError('Your ID is already with Aerva to check. We will email you as soon as it is done.', 409, { withAerva: true });
    }
    throw err;
  }
  await logAudit(sql, { action: 'guest_id_sent_for_review', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId, metadata: { reviewId: row.id } });
  const holds = await openHolds(sql, guestId);
  // Aerva's team is told at once when a booking is waiting on it.
  if (holds.length && process.env.ADMIN_ALERT_EMAIL) {
    await sendMail(process.env.ADMIN_ALERT_EMAIL, 'Guest ID to check — a booking is waiting', frame('A guest ID is waiting to be checked',
      `<p>A guest sent their ID for Aerva to check, and has ${holds.length === 1 ? 'a paid booking' : holds.length + ' paid bookings'} waiting on it (deadline ${esc(localMoment(holds[0].deadline_at, holds[0].timezone))}).</p>
       <p>Open Admin → Verifications → Guest ID.</p>`));
  }
  return { withAerva: true, reviewId: row.id };
}

async function ownIdUpload(sql, guestId, url) {
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, ''); } catch (e) { return false; }
  const m = /^(guest-id-\d{10,16})(-[A-Za-z0-9]+)?\.(jpg|pdf)$/i.exec(name);
  if (!m) return false;
  try {
    const rows = await sql`SELECT 1 FROM audit_log WHERE action = 'blob_upload_token' AND actor_identifier = ${'guest:' + Number(guestId)}
                             AND metadata->>'purpose' = 'guest-id' AND metadata->>'pathname' LIKE ${m[1] + '.%'} AND created_at > now() - interval '2 days' LIMIT 1`;
    return rows.length > 0;
  } catch (err) { console.error('guest ID upload check failed (refusing):', err.message); return false; }
}
async function eraseImage(url) {
  if (!url) return true;
  try { const { del } = require('@vercel/blob'); await del(url); return true; }
  catch (err) { console.error('guest ID image not deleted yet (the job tries again):', err.message); return false; }
}

// Admin → Verifications → "Guest ID": waiting IDs, urgent ones first (a
// booking waiting on them), soonest deadline first.
async function adminList(sql) {
  if (!(await ready(sql))) return [];
  const rows = await sql`
    SELECT r.id, r.guest_id, r.document_url, r.created_at, g.email, g.phone,
           to_jsonb(g)->>'first_name' AS first_name, to_jsonb(g)->>'last_name' AS last_name,
           (SELECT min(COALESCE(h.extended_until, h.deadline_at)) FROM verification_holds h WHERE h.guest_id = r.guest_id AND h.status = 'waiting') AS deadline_at,
           (SELECT min(h.cap_at) FROM verification_holds h WHERE h.guest_id = r.guest_id AND h.status = 'waiting') AS cap_at,
           (SELECT count(*)::int FROM verification_holds h WHERE h.guest_id = r.guest_id AND h.status = 'waiting') AS holds,
           (SELECT (array_agg(h.timezone ORDER BY h.deadline_at))[1] FROM verification_holds h WHERE h.guest_id = r.guest_id AND h.status = 'waiting') AS timezone
    FROM guest_id_reviews r JOIN guests g ON g.id = r.guest_id
    WHERE r.status = 'pending'
    ORDER BY (SELECT min(h.deadline_at) FROM verification_holds h WHERE h.guest_id = r.guest_id AND h.status = 'waiting') ASC NULLS LAST, r.created_at ASC
    LIMIT 200`;
  return rows.map(r => {
    // Urgent: a paid booking is waiting on this ID. It lapses at its deadline —
    // or, the ID being with Aerva, at 10 AM on the check-in day at the latest.
    const latest = r.holds ? Math.max(ms(r.deadline_at), ms(r.cap_at)) : null;
    return {
      reviewId: r.id, guestId: r.guest_id, email: r.email || null,
      profileName: [r.first_name, r.last_name].filter(Boolean).join(' '),
      documentUrl: r.document_url, submittedAt: r.created_at,
      urgent: Number(r.holds) > 0, holds: Number(r.holds) || 0,
      deadlineAt: r.holds ? r.deadline_at : null,
      deadlineText: r.holds ? localMoment(r.deadline_at, r.timezone) : null,
      latestText: latest ? localMoment(latest, r.timezone) : null,
      accepted: ID_TYPES
    };
  });
}

// POST { guestIdDecision: { reviewId, action: 'approve' | 'reject', docType?, last4?, reason? } }
// Approve: the admin has seen a real, valid ID of an accepted type in the
// profile's name, 18 or over, and enters its type and last 4 characters.
async function adminDecide(sql, razorpay, { reviewId, action, docType, last4, reason, adminLabel }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  const id = Number(reviewId) || 0;
  if (action !== 'approve' && action !== 'reject') throw userError('Choose Approve or Reject.');
  const rev = (await sql`SELECT * FROM guest_id_reviews WHERE id = ${id}`)[0];
  if (!rev) throw userError('This ID is no longer in the list.', 404);
  if (rev.status !== 'pending') throw userError('This ID has already been decided.', 409);
  const g = await loadAccount(sql, rev.guest_id);
  let clean4 = null, cleanReason = null;
  if (action === 'approve') {
    if (!ID_KEYS.includes(String(docType))) throw userError('Choose which ID this is: Aadhaar, passport, driving licence or voter ID.');
    clean4 = String(last4 || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean4.length !== 4) throw userError('Enter the last 4 characters of the ID number.');
    if (!/\d/.test(clean4)) throw userError('Enter the last 4 characters of the ID number as printed — they include at least one digit.');
    if (!g || !nameDone(g)) throw userError('This account has no first and last name to check the ID against. Reject it and ask the guest to add their name.');
  } else {
    cleanReason = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!cleanReason) throw userError('Please give the reason for rejecting this ID — the guest is told.');
  }
  // An ID with Aerva at the deadline keeps its bookings waiting (to 10 AM on
  // the check-in day): worked out now, while it still counts as waiting.
  for (const h of await openHolds(sql, rev.guest_id)) await extendIfWithAerva(sql, h);
  const mine = await sql`UPDATE guest_id_reviews SET status = ${action === 'approve' ? 'approved' : 'rejected'}, reason = ${cleanReason}, decided_at = now(), decided_by = ${adminLabel || 'admin'}
                         WHERE id = ${id} AND status = 'pending' RETURNING id`;
  if (!mine.length) throw userError('This ID has already been decided.', 409);
  // The image is deleted now; kept only if storage refuses, for the job to retry.
  const erased = await eraseImage(rev.document_url);
  if (erased) await sql`UPDATE guest_id_reviews SET document_url = NULL, erased_at = now() WHERE id = ${id}`;
  await logAudit(sql, { action: action === 'approve' ? 'guest_id_approved' : 'guest_id_rejected', success: true, actorType: 'admin', actorIdentifier: adminLabel || 'admin',
    targetType: 'guest', targetId: rev.guest_id, metadata: { reviewId: id, docType: action === 'approve' ? docType : null, reason: cleanReason, documentErased: erased } });
  let confirmed = [], lapsed = [];
  if (action === 'approve') {
    await saveVerifiedId(sql, rev.guest_id, { type: String(docType), last4: clean4, nameMatch: 'checked_by_aerva', method: 'aerva' });
    await logAudit(sql, { action: 'guest_id_verified', success: true, actorType: 'admin', actorIdentifier: adminLabel || 'admin', targetType: 'guest', targetId: rev.guest_id,
      metadata: { method: 'aerva', docType, nameMatch: 'checked_by_aerva' } });
    confirmed = await confirmHoldsFor(sql, razorpay, rev.guest_id);
  }
  // Whatever is past its own deadline and was only waiting for this answer.
  for (const h of await openHolds(sql, rev.guest_id)) {
    const after = await tick(sql, razorpay, h, { lapseReason: action === 'reject' ? 'Aerva could not verify the ID you sent, and the time to verify your details had run out.' : null });
    if (after && after.status === 'refunded') lapsed.push(after.id);
  }
  const left = await openHolds(sql, rev.guest_id);
  if (g && g.email) {
    if (action === 'approve') {
      await sendMail(g.email, 'Your ID is verified', frame('Your ID is verified',
        `<p>Hello ${esc(g.first_name || '')},</p><p>Aerva has checked your ${esc(idLabel(docType))} and your ID is now verified. The image you sent has been deleted.</p>
         ${confirmed.length ? '<p>Your booking is confirmed — the confirmation is in a separate email.</p>' : left.length ? `<p>One thing is still needed to confirm your booking: ${esc(missingText(await loadAccount(sql, rev.guest_id)))}.</p>${button(BOOKINGS_URL, 'Complete your details')}` : ''}`));
    } else {
      await sendMail(g.email, 'We could not verify your ID', frame('We could not verify your ID',
        `<p>Hello ${esc(g.first_name || '')},</p><p>Aerva checked the ID you sent and could not accept it: <strong>${esc(cleanReason)}</strong></p><p>The image you sent has been deleted.</p>
         ${lapsed.length ? '<p>The time to verify your details for your booking had run out, so the booking was not made and your payment is being refunded in full — the details are in a separate email.</p>'
           : left.length ? `<p>You can try again with another photo or another ID until <strong>${esc(localMoment(effectiveDeadline(left[0]), left[0].timezone))}</strong>. After that the booking is not made and your payment is refunded in full.</p>${button(BOOKINGS_URL, 'Try again')}`
           : `<p>You can try again with another photo or another ID any time.</p>${button(PROFILE_URL, 'Open your profile')}`}`));
    }
  }
  return { success: true, documentErased: erased, confirmed, lapsed };
}

// Images of decided IDs that storage refused to delete: tried again.
async function purgeDecidedImages(sql) {
  let n = 0;
  try {
    const rows = await sql`SELECT id, document_url FROM guest_id_reviews WHERE status <> 'pending' AND document_url IS NOT NULL LIMIT 20`;
    for (const r of rows) {
      if (await eraseImage(r.document_url)) { await sql`UPDATE guest_id_reviews SET document_url = NULL, erased_at = now() WHERE id = ${r.id}`; n++; }
    }
  } catch (err) { /* table not there yet */ }
  return n;
}

// ---------------------------------------------------------------- the deadline
// paidAtMs: when the payment was confirmed. arrival: the check-in day
// ('YYYY-MM-DD'), on the property's calendar (zone).
function computeDeadline(paidAtMs, arrival, zone) {
  const capMs = localMidnightMs(arrival, safeZone(zone)) + CHECKIN_HOUR * 3600e3;
  const natural = Math.min(paidAtMs + DEADLINE_HOURS * 3600e3, capMs);
  if (!Number.isFinite(natural) || natural - paidAtMs < SAME_DAY_MINUTES * 60e3) {
    return { deadlineMs: paidAtMs + SAME_DAY_MINUTES * 60e3, rule: 'same_day_1h', capMs: Number.isFinite(capMs) ? capMs : paidAtMs };
  }
  return { deadlineMs: natural, rule: natural === capMs ? 'checkin_10am' : '24h', capMs };
}
// Until when a hold may still be confirmed: its deadline, or — an ID having
// been with Aerva at the deadline — the extension.
const effectiveDeadline = (h) => Math.max(ms(h.deadline_at), h.extended_until ? ms(h.extended_until) : 0);
// When the two reminders are due (null: it does not fit).
function reminderTimes(h) {
  const paid = ms(h.paid_at), dl = ms(h.deadline_at);
  const half = paid + (dl - paid) / 2;
  const hour = dl - 3600e3;
  return { half, hour: hour > half ? hour : null };
}

// ---------------------------------------------------------------- holds
const summaryOf = (ctx) => [
  ...(ctx.stays || []).map(s => ({ type: 'stay', listingId: Number(s.listingId) || null, roomId: s.roomId || null, name: s.suite, arrival: s.arrival, departure: s.departure, nights: Number(s.nights) || null, guests: Number(s.guests) || null })),
  ...(ctx.experiences || []).map(e => ({ type: 'experience', listingId: Number(e.listingId) || null, roomId: null, name: e.suite, arrival: e.date, departure: e.endDate || e.date, nights: null, guests: Number(e.guests) || null }))
];
const itemsOf = (h) => (typeof h.summary === 'string' ? JSON.parse(h.summary) : h.summary) || [];
// An experience's stored end is the day AFTER its last day (like a check-out):
// what the guest is shown is its real last day, so a one-day experience has one date.
const shownEnd = (i) => {
  if (!i || i.type !== 'experience' || !i.departure || String(i.departure) <= String(i.arrival)) return i ? i.departure : null;
  const d = new Date(String(i.departure).slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const ctxOf = (h) => (typeof h.ctx === 'string' ? JSON.parse(h.ctx) : h.ctx);
function missingText(g) {
  const m = [];
  if (!nameDone(g)) m.push('your first and last name');
  if (!phoneDone(g)) m.push('your phone number confirmed with a code');
  if (!idDone(g)) m.push('a government photo ID verified');
  return m.length ? m.join(', ').replace(/, ([^,]*)$/, ' and $1') : 'nothing more';
}

// What the page shows for one held payment (to the guest who paid only).
function view(h, g = null) {
  const items = itemsOf(h);
  const deadline = effectiveDeadline(h);
  return {
    id: h.id, status: h.status, message: HELD_TEXT,
    items: items.map(i => ({ name: i.name, type: i.type, arrival: i.arrival, departure: shownEnd(i), nights: i.nights, guests: i.guests, listingId: i.listingId })),
    paid: Math.round(Number(h.amount_paise) / 100), currency: h.charge_currency || 'INR',
    paidAt: new Date(ms(h.paid_at)).toISOString(),
    deadlineAt: new Date(deadline).toISOString(), deadlineText: localMoment(deadline, h.timezone),
    extended: !!h.extended_until,
    steps: g ? { name: nameDone(g), phone: phoneDone(g), id: idDone(g) } : null,
    outcome: h.outcome || null
  };
}
async function openHolds(sql, guestId) {
  try { return await sql`SELECT * FROM verification_holds WHERE guest_id = ${guestId} AND status = 'waiting' ORDER BY deadline_at`; }
  catch (err) { return []; }
}

const stepsHtml = (g) => `<ol style="padding-left:20px; line-height:1.7;">
  <li>${nameDone(g) ? '✓ ' : ''}Your first and last name, as on your ID</li>
  <li>${phoneDone(g) ? '✓ ' : ''}Your phone number, confirmed with a code we text you</li>
  <li>${idDone(g) ? '✓ ' : ''}A government photo ID: Aadhaar, passport, driving licence or voter ID</li></ol>`;
const itemsHtml = (h) => `<ul>${itemsOf(h).map(i => `<li><strong>${esc(i.name)}</strong> — ${esc(niceDate(i.arrival))}${shownEnd(i) && shownEnd(i) !== i.arrival ? ' → ' + esc(niceDate(shownEnd(i))) : ''}${i.guests ? `, ${Number(i.guests)} guest${Number(i.guests) === 1 ? '' : 's'}` : ''}</li>`).join('')}</ul>`;

// From _confirm-booking.js confirmBooking, once the payment is checked, the
// dates are free and the coupon / credit are claimed — and before any
// booking row is written. Returns
//   null                 not held: confirm as always
//   { view }             held (the page's "waiting for your details" screen)
//   { conflict: reason } the dates could not be kept: refund by the normal conflict rules
async function holdIfUnverified(sql, razorpay, ctx, { couponClaimed = false, creditClaimed = false, payment = null } = {}) {
  if (!required() || !ctx || !ctx.guestId) return null;
  if (!(await ready(sql))) return null;
  const g = await loadAccount(sql, ctx.guestId);
  if (!g || allDone(g)) return null;

  const items = summaryOf(ctx);
  if (!items.length) return null;
  const first = items.slice().sort((a, b) => (a.arrival < b.arrival ? -1 : a.arrival > b.arrival ? 1 : 0))[0];
  let zone = 'Asia/Kolkata';
  try { zone = safeZone(((await sql`SELECT timezone FROM listings WHERE id = ${first.listingId}`)[0] || {}).timezone); } catch (e) { /* India */ }
  const paidAtMs = Date.now();
  const d = computeDeadline(paidAtMs, first.arrival, zone);
  const holdUntil = new Date(Math.max(d.deadlineMs, d.capMs) + HOLD_SLACK_HOURS * 3600e3).toISOString();

  // The dates stay with this guest: the payment window's own hold is kept
  // on (never a gap in which someone else could take them).
  try {
    const kept = await sql`UPDATE booking_holds SET released = false, released_reason = NULL, expires_at = ${holdUntil}
                           WHERE razorpay_order_id = ${ctx.razorpayOrderId} RETURNING id`;
    if (!kept.length) {
      for (const s of (ctx.stays || [])) {
        await sql`INSERT INTO booking_holds (listing_id, room_id, arrival, departure, guest_key, ip, expires_at, razorpay_order_id)
                  VALUES (${s.listingId}, ${s.roomId || null}, ${s.arrival}::date, ${s.departure}::date, ${'g:' + ctx.guestId}, NULL, ${holdUntil}, ${ctx.razorpayOrderId})`;
      }
    }
  } catch (err) {
    await releaseHolds(sql, { razorpayOrderId: ctx.razorpayOrderId, reason: 'conflict' });
    if (err && err.code === '23P01') return { conflict: 'These dates were booked by someone else while your payment was being completed.' };
    throw err;
  }

  const amount = payment ? Math.max(0, Number(payment.amount) - Number(payment.amount_refunded || 0)) : Number(ctx.capturedSubunit) || 0;
  let h;
  try {
    h = (await sql`
      INSERT INTO verification_holds (guest_id, guest_email, razorpay_order_id, razorpay_payment_id, amount_paise, charge_currency, ctx, summary, listing_ids,
                                      arrival, timezone, coupon_claimed, credit_claimed, paid_at, deadline_at, deadline_rule, cap_at)
      VALUES (${ctx.guestId}, ${ctx.email || g.email || null}, ${ctx.razorpayOrderId}, ${ctx.razorpayPaymentId}, ${amount}, ${ctx.chargeCurrency || 'INR'},
              ${JSON.stringify(Object.assign({}, ctx, { source: 'verified' }))}::jsonb, ${JSON.stringify(items)}::jsonb, ${[...new Set(items.map(i => i.listingId).filter(Boolean))]},
              ${first.arrival}::date, ${zone}, ${!!couponClaimed}, ${!!creditClaimed}, ${new Date(paidAtMs).toISOString()}, ${new Date(d.deadlineMs).toISOString()}, ${d.rule}, ${new Date(d.capMs).toISOString()})
      ON CONFLICT (razorpay_order_id) DO NOTHING RETURNING *`)[0];
  } catch (err) {
    await releaseHolds(sql, { razorpayOrderId: ctx.razorpayOrderId, reason: 'error' });
    throw err;
  }
  if (!h) {
    // Already held (a repeat call): the same answer.
    h = (await sql`SELECT * FROM verification_holds WHERE razorpay_order_id = ${ctx.razorpayOrderId}`)[0];
    return h ? { view: view(h, g) } : null;
  }
  await logAudit(sql, { action: 'booking_held_for_verification', success: true, actorType: 'system', targetType: 'verification_hold', targetId: h.id,
    metadata: { razorpayOrderId: ctx.razorpayOrderId, guestId: ctx.guestId, email: h.guest_email, listingIds: h.listing_ids, arrival: first.arrival, amountPaise: amount,
      deadlineAt: h.deadline_at, rule: d.rule, missing: { name: !nameDone(g), phone: !phoneDone(g), id: !idDone(g) }, source: ctx.source } });
  await sendMail(h.guest_email, 'Your booking will be confirmed once your details are verified', frame('Payment received — one more step',
    `<p>Hello ${esc(g.first_name || ctx.firstName || '')},</p><p><strong>${esc(HELD_TEXT)}</strong></p>${itemsHtml(h)}
     <p>We received your payment of <strong>${inr(amount / 100)}</strong> and the dates are held for you. To confirm the booking we need:</p>${stepsHtml(g)}
     <p>Please complete these by <strong>${esc(localMoment(d.deadlineMs, zone))}</strong>. If they are not verified by then, the booking is not made and your payment is refunded in full to your original payment method.</p>
     ${button(BOOKINGS_URL, 'Complete your details')}
     <p style="font-size:13px; opacity:0.8;">Your ID is checked in a few seconds and the image is not kept. Your host still checks a photo ID at check-in.</p>`));
  return { view: view(h, g) };
}

// The guest's details are verified: every payment of theirs still waiting
// (and still in time) becomes a booking. Returns [{ holdId, status, codes }].
async function confirmHoldsFor(sql, razorpay, guestId) {
  const out = [];
  try {
    if (!(await ready(sql))) return out;
    const g = await loadAccount(sql, guestId);
    if (!allDone(g)) return out;
    for (const h of await openHolds(sql, guestId)) {
      if (Date.now() > effectiveDeadline(h)) continue;      // too late: the job refunds it
      const r = await confirmHold(sql, razorpay, h);
      if (r) out.push(r);
    }
  } catch (err) { console.error('held bookings not confirmed yet (the job tries again):', err.message); }
  return out;
}

async function confirmHold(sql, razorpay, hold) {
  const CB = require('./_confirm-booking');
  razorpay = client(razorpay);
  if (!razorpay) return null;
  const h = (await sql`UPDATE verification_holds SET status = 'confirming', claimed_at = now() WHERE id = ${hold.id} AND status = 'waiting' RETURNING *`)[0];
  if (!h) return null;
  const ctx = ctxOf(h);
  let result;
  try {
    const rows = CB.planRows(ctx);
    let conflictReason = null;
    // Blocked by the host or a linked calendar while it waited?
    const clashes = await CB.findDateConflicts(sql, ctx.stays || []);
    if (clashes.length) conflictReason = `The dates for ${clashes.map(c => c.suite).join(', ')} became unavailable before your details were verified.`;
    result = await CB.finishBooking(sql, razorpay, ctx, rows, { conflictReason, couponClaimed: !!h.coupon_claimed, creditClaimed: !!h.credit_claimed, fromHold: true });
  } catch (err) {
    console.error('held booking could not be confirmed (tried again by the job):', h.id, err);
    result = { status: 'error', message: String(err.message || err) };
  }
  if (result.status === 'confirmed' || result.status === 'conflict') {
    const ids = result.orderIds || [];
    await sql`UPDATE verification_holds SET status = ${result.status === 'confirmed' ? 'confirmed' : 'conflict'}, order_ids = ${ids}, decided_at = now(),
                outcome = ${result.status === 'confirmed' ? 'Details verified: booking confirmed.' : String(result.message || '').slice(0, 400)}
              WHERE id = ${h.id} AND status = 'confirming'`;
    // The booking dates from its payment, so the accounts show the money on
    // the day it was received, whenever the details were verified.
    if (ids.length) { try { await sql`UPDATE orders SET created_at = ${h.paid_at} WHERE id = ANY(${ids})`; } catch (err) { console.error('held booking: payment date not set on the booking:', err.message); } }
    await logAudit(sql, { action: result.status === 'confirmed' ? 'held_booking_confirmed' : 'held_booking_conflict', success: true, actorType: 'system', targetType: 'verification_hold', targetId: h.id,
      metadata: { razorpayOrderId: h.razorpay_order_id, guestId: h.guest_id, email: h.guest_email, orderIds: ids, listingIds: h.listing_ids } });
    return { holdId: h.id, status: result.status, codes: result.confirmationCodes || [], orderIds: ids };
  }
  if (result.partly) {
    await sql`UPDATE verification_holds SET status = 'attention', outcome = 'Only partly saved: for Aerva to finish.' WHERE id = ${h.id} AND status = 'confirming'`;
    await logAudit(sql, { action: 'held_booking_partly_recorded', success: false, actorType: 'system', targetType: 'verification_hold', targetId: h.id, metadata: { razorpayOrderId: h.razorpay_order_id } });
    return { holdId: h.id, status: 'attention' };
  }
  // Nothing was written: it waits again, and the job retries.
  await sql`UPDATE verification_holds SET status = 'waiting', claimed_at = NULL WHERE id = ${h.id} AND status = 'confirming'`;
  return { holdId: h.id, status: 'waiting' };
}

// ---- Refunds of a held payment (no booking exists): one per payment,
// claimed on the row, checked with Razorpay first (tagged
// aerva_refund_key = verify-hold-<id>), never beyond what the payment has left.
async function refundHold(sql, razorpay, holdId) {
  razorpay = client(razorpay);
  const c = (await sql`
    UPDATE verification_holds SET refund_status = 'creating', refund_claimed_at = now()
    WHERE id = ${holdId} AND status = 'refunded'
      AND (refund_status IS NULL OR refund_status = 'failed' OR (refund_status = 'creating' AND refund_claimed_at < now() - make_interval(mins => ${RECLAIM_MINUTES})))
    RETURNING *`)[0];
  if (!c) return { already: true };
  const key = `verify-hold-${c.id}`;
  try {
    if (!razorpay) throw new Error('Razorpay keys not set');
    let existing = null;
    try {
      const list = await razorpay.payments.fetchMultipleRefund(c.razorpay_payment_id, { count: 100 });
      existing = ((list && list.items) || []).find(r => r.notes && r.notes.aerva_refund_key === key && r.status !== 'failed') || null;
    } catch (e) { /* rely on the payment's refunded amount */ }
    let refund = existing;
    if (!refund) {
      const p = await razorpay.payments.fetch(c.razorpay_payment_id);
      const left = Number(p.amount) - Number(p.amount_refunded || 0);
      if (left <= 0) {
        await sql`UPDATE verification_holds SET refund_status = 'failed', refund_error = 'Nothing left to refund on this payment.' WHERE id = ${c.id}`;
        return { failed: true };
      }
      // The whole payment: everything Razorpay still holds of it.
      refund = await razorpay.payments.refund(c.razorpay_payment_id, { amount: left, speed: 'normal', notes: { aerva_refund_key: key } });
    }
    await sql`UPDATE verification_holds SET refund_status = ${refund.status === 'processed' ? 'processed' : 'pending'}, razorpay_refund_id = ${refund.id},
                                            refund_amount = ${Math.round(Number(refund.amount))}, refunded_at = now(), refund_error = NULL WHERE id = ${c.id}`;
    await logAudit(sql, { action: 'held_payment_refunded', success: true, actorType: 'system', targetType: 'verification_hold', targetId: c.id,
      metadata: { email: c.guest_email, guestId: c.guest_id, paymentId: c.razorpay_payment_id, refundId: refund.id, amountPaise: Math.round(Number(refund.amount)), adopted: !!existing } });
    return { id: refund.id, amount: Math.round(Number(refund.amount)) };
  } catch (err) {
    const why = (err && err.error && err.error.description) || String((err && err.message) || err);
    await sql`UPDATE verification_holds SET refund_status = 'failed', refund_error = ${why.slice(0, 300)} WHERE id = ${c.id} AND refund_status = 'creating'`;
    await logAudit(sql, { action: 'held_payment_refund_failed', success: false, actorType: 'system', targetType: 'verification_hold', targetId: c.id, metadata: { error: why.slice(0, 200) } });
    return { failed: true, error: why };
  }
}

// The deadline passed (or Aerva rejected the ID with no time left): no
// booking. Everything goes back: the money to its source, the dates, the
// coupon and the Aerva credit. Once only (waiting → refunding).
async function expireHold(sql, razorpay, hold, why) {
  const CB = require('./_confirm-booking');
  const h = (await sql`UPDATE verification_holds SET status = 'refunding', claimed_at = now() WHERE id = ${hold.id} AND status = 'waiting' RETURNING *`)[0];
  if (!h) return null;
  const ctx = ctxOf(h);
  await CB.giveBackClaims(sql, ctx, { couponClaimed: !!h.coupon_claimed, creditClaimed: !!h.credit_claimed });
  await releaseHolds(sql, { razorpayOrderId: h.razorpay_order_id, reason: 'expired' });
  const reason = why || 'Your details were not submitted and verified in time.';
  await sql`UPDATE verification_holds SET status = 'refunded', decided_at = now(), outcome = ${reason}, coupon_claimed = false, credit_claimed = false WHERE id = ${h.id} AND status = 'refunding'`;
  const refund = await refundHold(sql, razorpay, h.id);
  const amount = Number(h.amount_paise) / 100;
  await logAudit(sql, { action: 'held_booking_lapsed', success: true, actorType: 'system', targetType: 'verification_hold', targetId: h.id,
    metadata: { razorpayOrderId: h.razorpay_order_id, guestId: h.guest_id, email: h.guest_email, listingIds: h.listing_ids, reason, amountPaise: Number(h.amount_paise),
      refundFailed: !!refund.failed, couponRestored: !!h.coupon_claimed, creditRestored: !!h.credit_claimed } });
  const gave = [h.coupon_claimed ? 'the coupon you used is yours again' : '', h.credit_claimed ? 'the Aerva credit you used is back in your account' : ''].filter(Boolean).join(', and ');
  await sendMail(h.guest_email, 'Your Aerva booking was not made — full refund', frame('Your booking was not made',
    `<p>${esc(reason)} So the booking could not be confirmed, and the dates have been released.</p>${itemsHtml(h)}
     <p>Your payment of <strong>${inr(amount)}</strong> ${refund.failed ? 'is being refunded in full; our team is completing it and will confirm by email.' : 'is being refunded in full to your original payment method. Refunds usually arrive in 5–7 working days.'}${gave ? ' Also, ' + esc(gave) + '.' : ''}</p>
     <p>You are welcome to book again: verify your details in your profile first and your booking is confirmed at once.</p>${button(PROFILE_URL, 'Verify your details')}`));
  return Object.assign({}, h, { status: 'refunded' });
}

// An ID that is with Aerva when the deadline arrives keeps the booking
// waiting for Aerva's answer, to at most 10 AM on the check-in day.
async function extendIfWithAerva(sql, h) {
  if (h.extended_until) return h;
  const now = Date.now(), dl = ms(h.deadline_at), cap = ms(h.cap_at);
  if (now <= dl || cap <= dl || now >= cap) return h;
  const rev = await pendingReview(sql, h.guest_id);
  if (!rev || ms(rev.created_at) > dl) return h;
  const set = (await sql`UPDATE verification_holds SET extended_until = ${new Date(cap).toISOString()} WHERE id = ${h.id} AND status = 'waiting' AND extended_until IS NULL RETURNING *`)[0];
  if (set) await logAudit(sql, { action: 'held_booking_extended', success: true, actorType: 'system', targetType: 'verification_hold', targetId: h.id, metadata: { guestId: h.guest_id, email: h.guest_email, until: set.extended_until, reviewId: rev.id } });
  return set || h;
}

async function sendReminder(sql, h, which) {
  const g = await loadAccount(sql, h.guest_id);
  if (!g || allDone(g)) return false;
  // Nothing for the guest to do while only Aerva's answer is awaited.
  if (nameDone(g) && phoneDone(g) && await pendingReview(sql, h.guest_id)) return false;
  const left = which === 'hour' ? '1 hour left' : 'Reminder';
  await sendMail(h.guest_email, which === 'hour' ? '1 hour left to confirm your Aerva booking' : 'Reminder: complete your details to confirm your booking', frame(`${left}: complete your details`,
    `<p>Hello ${esc(g.first_name || '')},</p><p><strong>${esc(HELD_TEXT)}</strong></p>${itemsHtml(h)}<p>Still needed: ${esc(missingText(g))}.</p>${stepsHtml(g)}
     <p>Please complete these by <strong>${esc(localMoment(h.deadline_at, h.timezone))}</strong>. After that the booking is not made and your payment of ${inr(Number(h.amount_paise) / 100)} is refunded in full.</p>${button(BOOKINGS_URL, 'Complete your details')}`));
  await logAudit(sql, { action: 'held_booking_reminder', success: true, actorType: 'system', targetType: 'verification_hold', targetId: h.id, metadata: { which, guestId: h.guest_id, email: h.guest_email } });
  return true;
}

// One held payment, brought up to date: confirmed if the guest is verified,
// reminded, extended, or refunded when its time is up. Returns the row as it
// now stands. Safe to call from anywhere, any number of times.
async function tick(sql, razorpay, hold, { lapseReason = null } = {}) {
  let h = (await sql`SELECT * FROM verification_holds WHERE id = ${hold.id}`)[0];
  if (!h || h.status !== 'waiting') return h || null;
  const now = Date.now(), dl = ms(h.deadline_at);
  if (now <= effectiveDeadline(h)) {
    // Verified already (a step finished while a confirmation was failing)?
    if (allDone(await loadAccount(sql, h.guest_id))) {
      await confirmHold(sql, razorpay, h);
      return (await sql`SELECT * FROM verification_holds WHERE id = ${h.id}`)[0];
    }
    if (now <= dl) {
      const t = reminderTimes(h);
      if (t.hour && now >= t.hour && !h.hour_reminded_at) {
        const mine = await sql`UPDATE verification_holds SET hour_reminded_at = now(), half_reminded_at = COALESCE(half_reminded_at, now()) WHERE id = ${h.id} AND status = 'waiting' AND hour_reminded_at IS NULL RETURNING id`;
        if (mine.length) await sendReminder(sql, h, 'hour');
      } else if (now >= t.half && !h.half_reminded_at) {
        const mine = await sql`UPDATE verification_holds SET half_reminded_at = now() WHERE id = ${h.id} AND status = 'waiting' AND half_reminded_at IS NULL RETURNING id`;
        if (mine.length) await sendReminder(sql, h, 'half');
      }
      return (await sql`SELECT * FROM verification_holds WHERE id = ${h.id}`)[0];
    }
    // In the extension: it lasts only while Aerva has not answered.
    if (await pendingReview(sql, h.guest_id)) return h;
    return await expireHold(sql, razorpay, h, lapseReason) || h;
  }
  if (!h.extended_until) {
    h = await extendIfWithAerva(sql, h);
    if (h.extended_until && now <= effectiveDeadline(h)) return h;
  }
  return await expireHold(sql, razorpay, h, lapseReason) || h;
}

// Job 'guest_verification' (get-listings.js), every 5 minutes.
async function runJob(sql, razorpay, { deadlineMs = 4000 } = {}) {
  const started = Date.now();
  const out = { checked: 0, confirmed: 0, reminded: 0, extended: 0, refunded: 0, refundRetries: 0, imagesErased: 0, affected: [] };
  if (!(await ready(sql))) return { ...out, skipped: 'database update not applied yet' };
  out.imagesErased = await purgeDecidedImages(sql);
  if (!razorpay) return { ...out, skipped: 'Razorpay keys not set' };
  // A run that died mid-way: 'confirming' with its booking written is
  // confirmed; without, it waits again. 'refunding' goes on to its refund.
  const stuck = await sql`SELECT * FROM verification_holds WHERE status IN ('confirming', 'refunding') AND claimed_at < now() - make_interval(mins => ${RECLAIM_MINUTES}) LIMIT 20`;
  for (const h of stuck) {
    if (h.status === 'confirming') {
      const rows = await sql`SELECT id, status FROM orders WHERE razorpay_order_id = ${h.razorpay_order_id} ORDER BY id`;
      if (rows.length) await sql`UPDATE verification_holds SET status = ${rows.some(r => r.status === 'paid') ? 'confirmed' : 'conflict'}, order_ids = ${rows.map(r => r.id)}, decided_at = now() WHERE id = ${h.id} AND status = 'confirming'`;
      else await sql`UPDATE verification_holds SET status = 'waiting', claimed_at = NULL WHERE id = ${h.id} AND status = 'confirming'`;
    } else {
      await sql`UPDATE verification_holds SET status = 'refunded', decided_at = now(), outcome = COALESCE(outcome, 'Your details were not submitted and verified in time.') WHERE id = ${h.id} AND status = 'refunding'`;
      await refundHold(sql, razorpay, h.id);
    }
  }
  const open = await sql`SELECT * FROM verification_holds WHERE status = 'waiting' ORDER BY deadline_at LIMIT 60`;
  for (const before of open) {
    if (Date.now() - started > deadlineMs) break;
    out.checked++;
    try {
      const after = await tick(sql, razorpay, before);
      if (!after) continue;
      if (after.status === 'confirmed' || after.status === 'conflict') { out.confirmed++; out.affected.push({ holdId: after.id, email: after.guest_email, what: 'confirmed' }); }
      else if (after.status === 'refunded') { out.refunded++; out.affected.push({ holdId: after.id, email: after.guest_email, what: 'refunded' }); }
      else {
        if ((after.half_reminded_at && !before.half_reminded_at) || (after.hour_reminded_at && !before.hour_reminded_at)) out.reminded++;
        if (after.extended_until && !before.extended_until) out.extended++;
      }
    } catch (err) { console.error('verification hold tick failed:', before.id, err.message); }
  }
  // Refunds that failed (a Razorpay hiccup) are tried again after 15 minutes.
  const retry = await sql`SELECT id FROM verification_holds WHERE status = 'refunded' AND refund_status = 'failed' AND refund_claimed_at < now() - interval '15 minutes' LIMIT 10`;
  for (const c of retry) {
    if (Date.now() - started > deadlineMs) break;
    const r = await refundHold(sql, razorpay, c.id);
    if (r && r.id) out.refundRetries++;
  }
  return out;
}

// ---------------------------------------------------------------- what people see
// verify-payment.js: a payment already handled — is it a held one?
async function byOrder(sql, razorpayOrderId) {
  try {
    if (!(await ready(sql))) return null;
    const h = (await sql`SELECT * FROM verification_holds WHERE razorpay_order_id = ${razorpayOrderId}`)[0];
    if (!h) return null;
    return { status: h.status, view: view(h, await loadAccount(sql, h.guest_id)), outcome: h.outcome };
  } catch (err) { return null; }
}

// GET guest-profile?mode=verification — the three steps and the payments waiting on them.
async function statusFor(sql, razorpay, guestId) {
  const st = await profileStatus(sql, guestId);
  st.holds = [];
  if (st.available) {
    for (const h of await openHolds(sql, guestId)) {
      const now = await tick(sql, razorpay, h);
      if (now && now.status === 'waiting') st.holds.push(view(now));
    }
  }
  return st;
}

// My Bookings (guest-profile.js): payments waiting for the guest's details,
// and — for 14 days — those that lapsed and were refunded.
async function decorateBookings(sql, razorpay, guestId, bookings) {
  try {
    if (!(await ready(sql))) return bookings;
    const g = await loadAccount(sql, guestId);
    const rows = await sql`SELECT * FROM verification_holds WHERE guest_id = ${guestId}
                           AND (status IN ('waiting', 'confirming', 'refunding') OR (status = 'refunded' AND decided_at > now() - interval '14 days'))
                           ORDER BY id DESC LIMIT 20`;
    for (const row of rows) {
      const h = row.status === 'waiting' ? (await tick(sql, razorpay, row) || row) : row;
      if (h.status === 'confirmed' || h.status === 'conflict' || h.status === 'attention') continue;   // the booking rows carry it now
      const items = itemsOf(h);
      const first = items[0] || {};
      const v = view(h, g);
      const lapsed = h.status === 'refunded' || h.status === 'refunding';
      bookings.unshift({
        id: 'v' + h.id, waiting_details: Object.assign(v, { lapsed, refundPending: lapsed && h.refund_status !== 'processed' }),
        suite_name: items.map(i => i.name).join(' + ') || 'Your booking', listing_id: first.listingId || null,
        arrival: first.arrival || null, departure: first.departure || first.arrival || null, nights: first.nights || null, guests: first.guests || null,
        status: lapsed ? 'cancelled' : 'waiting_details', can_change: false, can_cancel_request: false, can_report: false, review_state: null
      });
    }
  } catch (err) { console.error('held bookings not added to My Bookings:', err.message); }
  return bookings;
}

// The bell (guest-auth.js): the guest's waiting payments (a new item at each
// reminder), a lapsed one for 7 days; for a host, a hold that went, 3 days.
async function bellNotifications(sql, { guestId, hostId = null }) {
  const out = [];
  try {
    if (!(await ready(sql))) return out;
    const mine = await sql`SELECT * FROM verification_holds WHERE guest_id = ${guestId}
                           AND (status = 'waiting' OR (status = 'refunded' AND decided_at > now() - interval '7 days')) ORDER BY id DESC LIMIT 5`;
    for (const h of mine) {
      const name = itemsOf(h).map(i => i.name).join(' + ') || 'your booking';
      if (h.status === 'waiting') {
        const stage = h.hour_reminded_at ? 'last-hour' : h.half_reminded_at ? 'half' : 'new';
        out.push({ id: `verify-hold:${h.id}:${stage}`, kind: 'action',
          title: stage === 'last-hour' ? `1 hour left: complete your details for ${name}` : `Complete your details to confirm ${name}`,
          body: `${HELD_TEXT} Please finish by ${localMoment(effectiveDeadline(h), h.timezone)}.`,
          due: stage === 'last-hour' ? 'Last hour' : undefined, href: 'index.html?view=my-bookings' });
      } else {
        out.push({ id: `verify-hold-lapsed:${h.id}`, kind: 'action', title: `Booking not made: ${name}`,
          body: `${h.outcome || 'Your details were not verified in time.'} Your payment is refunded in full.`, href: 'index.html?view=my-bookings' });
      }
    }
    if (hostId) {
      const gone = await sql`
        SELECT h.id, h.summary, h.decided_at FROM verification_holds h
        WHERE h.status = 'refunded' AND h.decided_at > now() - interval '3 days'
          AND EXISTS (SELECT 1 FROM listings l WHERE l.id = ANY(h.listing_ids) AND l.host_id = ${hostId})
        ORDER BY h.id DESC LIMIT 5`;
      for (const h of gone) {
        const it = itemsOf(h)[0] || {};
        out.push({ id: `verify-hold-released:${h.id}`, kind: 'action', title: `Hold released: ${it.name || 'your listing'}`,
          body: `The guest did not complete their details in time, so no booking was made. ${niceDate(it.arrival)}${it.departure && it.departure !== it.arrival ? ' – ' + niceDate(it.departure) : ''} ${it.departure && it.departure !== it.arrival ? 'are' : 'is'} open again.`,
          href: 'host-status.html' });
      }
    }
  } catch (err) { console.error('verification notices not added to the bell:', err.message); }
  return out;
}

// The host's side: payments waiting for the guest's details on their
// listings (dates blocked) and holds that went in the last 3 days. Never a
// guest's name, email or phone, and no money.
async function hostWaiting(sql, hostId, { listingIds = null } = {}) {
  const out = { waiting: [], released: [] };
  try {
    if (!hostId || !(await ready(sql))) return out;
    const rows = await sql`
      SELECT h.id, h.status, h.summary, h.deadline_at, h.extended_until, h.timezone, h.decided_at, h.listing_ids
      FROM verification_holds h
      WHERE (h.status IN ('waiting', 'confirming') OR (h.status = 'refunded' AND h.decided_at > now() - interval '3 days'))
        AND EXISTS (SELECT 1 FROM listings l WHERE l.id = ANY(h.listing_ids) AND l.host_id = ${hostId})
      ORDER BY h.id DESC LIMIT 50`;
    const own = new Set((await sql`SELECT id FROM listings WHERE host_id = ${hostId}`).map(r => Number(r.id)));
    for (const h of rows) {
      for (const it of itemsOf(h)) {
        if (!own.has(Number(it.listingId))) continue;
        if (listingIds && !listingIds.map(Number).includes(Number(it.listingId))) continue;
        const row = { holdId: h.id, listingId: it.listingId, roomId: it.roomId || null, name: it.name, arrival: it.arrival, departure: it.departure, nights: it.nights, guests: it.guests };
        if (h.status === 'refunded') out.released.push(Object.assign(row, { releasedAt: h.decided_at, note: 'The guest did not complete their details in time, so no booking was made. These dates are open again.' }));
        else out.waiting.push(Object.assign(row, { label: 'Waiting for the guest’s details', until: new Date(effectiveDeadline(h)).toISOString(), untilText: localMoment(effectiveDeadline(h), h.timezone),
          note: 'The guest has paid. The dates are held and the booking is confirmed once their details are verified — you get the confirmation then. If they are not verified in time, the dates are released.' }));
      }
    }
  } catch (err) { console.error('held bookings not added for the host:', err.message); }
  return out;
}
// The host's calendar (host-listings.js): the held dates of one home or
// room, as "booked" ranges with no guest on them.
async function calendarRanges(sql, { listingId, roomId = null, startStr, endStr }) {
  try {
    if (!(await ready(sql))) return [];
    const rows = await sql`SELECT h.id, h.summary, h.deadline_at, h.extended_until, h.timezone FROM verification_holds h
                           WHERE h.status IN ('waiting', 'confirming') AND ${Number(listingId)} = ANY(h.listing_ids)`;
    const out = [];
    for (const h of rows) for (const it of itemsOf(h)) {
      if (it.type !== 'stay' || Number(it.listingId) !== Number(listingId) || Number(it.roomId || 0) !== Number(roomId || 0)) continue;
      if (!(it.arrival < endStr && it.departure > startStr)) continue;
      out.push({ id: null, hold_id: h.id, waiting_details: true, start_date: it.arrival, end_date: it.departure, guest_name: 'Waiting for the guest’s details',
        guest_email: null, guest_phone: null, guests: it.guests, nights: it.nights, confirmation_code: null,
        waiting_until: localMoment(effectiveDeadline(h), h.timezone) });
    }
    return out;
  } catch (err) { return []; }
}

// _pricing.js priceStay: are these dates held for a guest whose details are
// being verified? (A change to another booking must not take them.) Never throws.
async function datesHeld(sql, { listingId, roomId = null, arrival, departure }) {
  try {
    if (!readyKnown && !(await ready(sql))) return false;
    const r = await sql`
      SELECT 1 FROM booking_holds b
      WHERE b.released = false AND b.expires_at > now() AND b.listing_id = ${listingId} AND COALESCE(b.room_id, 0) = ${roomId || 0}
        AND b.arrival < ${departure}::date AND b.departure > ${arrival}::date
        AND EXISTS (SELECT 1 FROM verification_holds v WHERE v.razorpay_order_id = b.razorpay_order_id AND v.status IN ('waiting', 'confirming'))
      LIMIT 1`;
    return r.length > 0;
  } catch (err) { return false; }
}
// create-order.js: the guest's own payment already waiting for these dates.
async function ownHoldFor(sql, guestId, stays) {
  try {
    if (!guestId || !(await ready(sql))) return null;
    const mine = await openHolds(sql, guestId);
    for (const h of mine) for (const it of itemsOf(h)) for (const s of (stays || [])) {
      if (it.type === 'stay' && Number(it.listingId) === Number(s.listingId) && Number(it.roomId || 0) === Number(s.roomId || 0) && it.arrival < s.departure && it.departure > s.arrival) return h;
    }
  } catch (err) { /* none */ }
  return null;
}

// create-order.js, before payment:
//   • a gift's buyer and a group's organiser must be verified (when required);
//   • a verified guest books in the name their ID was verified for.
// Throws a user-facing error with `needs`, or returns.
async function assertBeforePayment(sql, guestId, { gift = false, group = false } = {}) {
  if (!guestId || !(await ready(sql))) return;
  const g = await loadAccount(sql, guestId);
  if (!g) return;
  // Sending a stay to someone else always asks for the sender's ID, whether
  // or not verification is required of everyone (owner, 12 Nov 2026:
  // "organiser should have ID verified and that should be the requirement
  // before organiser send gift to anyone"). Only the ID — the phone step
  // needs SMS, which is not set up everywhere, and a gift must not be
  // blocked by that.
  if (gift && !required() && !idDone(g)) {
    throw userError('To send a stay as a gift, verify your government ID first. It takes a couple of minutes in your profile, and it is only ever asked of the person paying.', 400, { needs: ['id'] });
  }
  if (!required()) return;
  if ((gift || group) && !allDone(g)) {
    throw userError(`${gift ? 'To send a stay as a gift' : 'To split a payment with friends'}, verify your details first: ${missingText(g)}. It takes a few minutes in your profile.`, 400, { needs: ['verification'] });
  }
}
// Before the name given at checkout is saved to the account (it would clear
// the ID verification): a verified guest books in their verified name.
async function assertNameKeepsId(sql, guestId, firstName, lastName) {
  if (!required() || !guestId || !(await ready(sql))) return;
  const g = await loadAccount(sql, guestId);
  if (!g || !idDone(g)) return;
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (norm(firstName) === norm(g.first_name) && norm(lastName) === norm(g.last_name)) return;
  throw userError(`Your ID is verified for ${fullName(g)}. Please book in that name. To book in another name, change your name in your profile first — your ID will then need to be verified again.`, 400, { needs: ['name'] });
}

// The guest's own steps (_setup-steps.js): shown as optional unless required.
async function setupSteps(sql, guestId) {
  if (!(await ready(sql))) return [];
  const g = await loadAccount(sql, guestId);
  if (!g) return [];
  const optional = !required();
  const review = idDone(g) ? null : await pendingReview(sql, guestId);
  return [
    { key: 'phone_code', label: 'Verify your phone number', why: optional ? 'Optional — a code by text message confirms the number is yours.' : 'A code by text message confirms the number is yours. Needed to confirm a booking.',
      optional, done: phoneDone(g), href: 'index.html?view=profile&verify=phone' },
    { key: 'guest_id', label: 'Verify your ID', why: optional ? 'Optional — Aadhaar, passport, driving licence or voter ID. Checked in seconds; the image is not kept.' : 'Aadhaar, passport, driving licence or voter ID. Checked in seconds; the image is not kept. Needed to confirm a booking.',
      optional, done: idDone(g), waiting: !!review, waitingText: 'Sent — Aerva is checking it', href: 'index.html?view=profile&verify=id' }
  ];
}

// ---------------------------------------------------------------- accounts
// Admin → Accounts (_accounts-report.js). A held payment is money received
// with no booking row yet: its receipt is listed from here (an advance from
// the guest) until the booking exists — which is then dated at the payment,
// so the same receipt simply moves to the booking — and a refund made
// because the details were never verified is listed from here too.
const REAL_PAY = '^pay_[A-Za-z0-9]{14}$', REAL_REFUND = '^rfnd_[A-Za-z0-9]{14}$';
async function accountsCash(sql, start, end) {
  if (!(await ready(sql))) return { receipts: [], refunds: [] };
  const receipts = await sql`
    SELECT h.id, h.guest_email AS email, h.amount_paise, h.razorpay_payment_id, h.razorpay_order_id, h.paid_at, h.status
    FROM verification_holds h
    WHERE h.razorpay_payment_id ~ ${REAL_PAY} AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.razorpay_order_id = h.razorpay_order_id)
      AND (h.paid_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (h.paid_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp
    ORDER BY h.paid_at`;
  const refunds = await sql`
    SELECT h.id, h.guest_email AS email, h.refund_amount, h.razorpay_refund_id, h.refunded_at, h.outcome
    FROM verification_holds h
    WHERE h.status = 'refunded' AND h.refund_status = 'processed' AND h.razorpay_refund_id ~ ${REAL_REFUND}
      AND (h.refunded_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (h.refunded_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp
    ORDER BY h.refunded_at`;
  return { receipts, refunds };
}
// Everything before the start of `day` (India time): received on payments
// that have no booking row, refunded, and Razorpay's charges on them.
async function accountsBalances(sql, day) {
  const zero = { in: 0, refunded: 0, fee: 0, tax: 0 };
  try {
    if (!(await ready(sql))) return zero;
    const r = (await sql`
      SELECT (SELECT COALESCE(sum(h.amount_paise), 0) / 100.0 FROM verification_holds h
                WHERE h.razorpay_payment_id ~ ${REAL_PAY} AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.razorpay_order_id = h.razorpay_order_id)
                  AND (h.paid_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp) AS paid_in,
             (SELECT COALESCE(sum(h.refund_amount), 0) / 100.0 FROM verification_holds h
                WHERE h.status = 'refunded' AND h.refund_status = 'processed' AND h.razorpay_refund_id ~ ${REAL_REFUND}
                  AND (h.refunded_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp) AS refunded,
             (SELECT COALESCE(sum(f.fee_paise), 0) / 100.0 FROM razorpay_fees f WHERE f.kind = 'payment'
                AND EXISTS (SELECT 1 FROM verification_holds h WHERE h.razorpay_payment_id = f.ref_id AND (h.paid_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp
                              AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.razorpay_order_id = h.razorpay_order_id))) AS fee,
             (SELECT COALESCE(sum(f.tax_paise), 0) / 100.0 FROM razorpay_fees f WHERE f.kind = 'payment'
                AND EXISTS (SELECT 1 FROM verification_holds h WHERE h.razorpay_payment_id = f.ref_id AND (h.paid_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp
                              AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.razorpay_order_id = h.razorpay_order_id))) AS tax`)[0] || {};
    return { in: Number(r.paid_in) || 0, refunded: Number(r.refunded) || 0, fee: Number(r.fee) || 0, tax: Number(r.tax) || 0 };
  } catch (err) { return zero; }
}

module.exports = {
  required, ready, isVerified, idVerified, idLineForHost, profileStatus, profilePrompt, statusFor,
  sendPhoneCode, confirmPhoneCode, markPhoneProved,
  checkGuestId, adoptFromIdVerify, sendForReview, adminList, adminDecide, startDigiLocker, finishDigiLocker,
  holdIfUnverified, confirmHoldsFor, confirmHold, expireHold, refundHold, tick, runJob, byOrder,
  decorateBookings, bellNotifications, hostWaiting, calendarRanges, datesHeld, ownHoldFor,
  assertBeforePayment, assertNameKeepsId, setupSteps, accountsCash, accountsBalances,
  ID_TYPES, ATTEMPTS_PER_DAY, HELD_TEXT, NOT_ON,
  // for tests
  computeDeadline, reminderTimes, judgeGuestId, nameMatch, ageRange, effectiveDeadline, view, forgetReady
};
