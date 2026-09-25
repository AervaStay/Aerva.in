// /api/_email-otp.js — confirming an account by a code sent to its email.
// Not an endpoint.
//
// WHY EMAIL. Every SMS or WhatsApp message is billed per message; email
// through Resend, which Aerva already sends booking confirmations with,
// costs nothing. One account is one email address and one phone number
// (migration_email_otp.sql enforces both), and the code that proves the
// account belongs to the person goes to the email.
//
// The code itself is never stored — only a salted SHA-256 hash of it, with
// an expiry, so a copy of the database cannot be used to sign in as
// anybody. A code is good for 10 minutes and 5 guesses, and asking for a
// new one replaces the old one outright.
//
//   requestCode(sql, email, { ip })  → sends a code, or a user-facing error
//   checkCode(sql, email, code)      → { ok } or { ok: false, error }

const crypto = require('crypto');

const CODE_LIFETIME_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_WAIT_SECONDS = 45;          // between codes for one address
const MAX_SENDS_PER_HOUR = 6;            // per address
const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });

const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
const looksLikeEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
// Salted with the same secret every other signed value here uses, so a
// stolen table of hashes is not a table of codes.
const hashCode = (email, code) =>
  crypto.createHmac('sha256', process.env.APPROVAL_TOKEN_SECRET || 'aerva-dev-secret')
    .update(`${email}:${code}`).digest('hex');

// Six digits, drawn evenly (a plain % would favour the low digits).
function newCode() {
  let out = '';
  while (out.length < 6) {
    const b = crypto.randomBytes(1)[0];
    if (b < 250) out += String(b % 10);
  }
  return out;
}

function emailHtml(code, purpose) {
  return `<div style="font-family:sans-serif; max-width:440px;">
    <h2 style="font-family:Georgia,serif; margin:0 0 6px;">Your Aerva code</h2>
    <p style="color:#4a453e; margin:0 0 16px;">${purpose === 'link' ? 'Use this to confirm your email address.' : 'Use this to sign in to Aerva.'}</p>
    <p style="font-size:30px; font-weight:600; letter-spacing:0.22em; margin:0 0 16px; color:#1c1b19;">${code}</p>
    <p style="font-size:13.5px; color:#6e675d; margin:0;">It expires in ${CODE_LIFETIME_MINUTES} minutes. If you did not ask for it, you can ignore this email — nobody can use it without your inbox.</p>
  </div>`;
}

// Sends a code. Throws a user-facing error when asked too often, or when
// email is not configured — never "sends" a code that went nowhere.
async function requestCode(sql, rawEmail, { purpose = 'login' } = {}) {
  const email = normalizeEmail(rawEmail);
  if (!looksLikeEmail(email) || email.length > 254) throw userError('Please enter a valid email address.');
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY is not set — no email code can be sent.');
    throw userError('We cannot send codes by email right now. Please write to hello@aerva.in.', 503);
  }
  const existing = (await sql`SELECT last_sent_at, sent_count, created_at FROM email_otps WHERE email = ${email}`)[0];
  if (existing) {
    const since = (Date.now() - new Date(existing.last_sent_at).getTime()) / 1000;
    if (since < RESEND_WAIT_SECONDS) {
      throw userError(`Please wait ${Math.ceil(RESEND_WAIT_SECONDS - since)} seconds before asking for another code.`, 429);
    }
    const hourOld = (Date.now() - new Date(existing.created_at).getTime()) < 3600e3;
    if (hourOld && existing.sent_count >= MAX_SENDS_PER_HOUR) {
      throw userError('Too many codes have been sent to this address. Please try again later.', 429);
    }
  }
  const code = newCode();
  await sql`
    INSERT INTO email_otps (email, code_hash, expires_at, attempts, sent_count, last_sent_at, created_at)
    VALUES (${email}, ${hashCode(email, code)}, now() + make_interval(mins => ${CODE_LIFETIME_MINUTES}), 0, 1, now(), now())
    ON CONFLICT (email) DO UPDATE SET
      code_hash = EXCLUDED.code_hash,
      expires_at = EXCLUDED.expires_at,
      attempts = 0,
      -- an hour after the first one, the count starts again
      sent_count = CASE WHEN email_otps.created_at > now() - interval '1 hour' THEN email_otps.sent_count + 1 ELSE 1 END,
      created_at = CASE WHEN email_otps.created_at > now() - interval '1 hour' THEN email_otps.created_at ELSE now() END,
      last_sent_at = now()`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to: email, subject: `${code} is your Aerva code`, html: emailHtml(code, purpose) })
  });
  if (!res.ok) {
    // Nothing arrived, so the stored code is useless: clear it rather than
    // leave someone waiting for an email that is not coming.
    await sql`DELETE FROM email_otps WHERE email = ${email}`;
    console.error('Resend refused the code email:', res.status, await res.text().catch(() => ''));
    throw userError('We could not send the code to that address. Please check it and try again.', 502);
  }
  return { sent: true, email, expiresInMinutes: CODE_LIFETIME_MINUTES };
}

// Checks a code. Correct → used up at once, so it cannot be replayed.
async function checkCode(sql, rawEmail, rawCode) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode || '').trim();
  if (!/^\d{4,8}$/.test(code)) return { ok: false, error: 'Enter the 6-digit code from your email.' };
  const row = (await sql`SELECT code_hash, expires_at, attempts FROM email_otps WHERE email = ${email}`)[0];
  if (!row) return { ok: false, error: 'That code has expired. Please ask for a new one.' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await sql`DELETE FROM email_otps WHERE email = ${email}`;
    return { ok: false, error: 'That code has expired. Please ask for a new one.' };
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await sql`DELETE FROM email_otps WHERE email = ${email}`;
    return { ok: false, error: 'Too many wrong codes. Please ask for a new one.' };
  }
  const want = Buffer.from(row.code_hash);
  const got = Buffer.from(hashCode(email, code));
  const same = want.length === got.length && crypto.timingSafeEqual(want, got);
  if (!same) {
    await sql`UPDATE email_otps SET attempts = attempts + 1 WHERE email = ${email}`;
    const left = MAX_ATTEMPTS - row.attempts - 1;
    return { ok: false, error: left > 0 ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Please ask for a new one.' };
  }
  await sql`DELETE FROM email_otps WHERE email = ${email}`;
  return { ok: true, email };
}

module.exports = {
  CODE_LIFETIME_MINUTES, MAX_ATTEMPTS, RESEND_WAIT_SECONDS,
  normalizeEmail, looksLikeEmail, requestCode, checkCode
};
