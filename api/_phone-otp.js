// /api/_phone-otp.js — confirming a mobile number by a code sent on WhatsApp.
// Not an endpoint.
//
// Owner, 10 Nov 2026: codes go by WhatsApp through Meta's own WhatsApp
// Cloud API (no middleman), and the only fallback is email — no SMS. Used
// for phone sign-in and for confirming a guest's number (guest-phone-auth.js)
// and for the host's "Verify your phone number" step (host-listings.js).
// Twilio is no longer used for codes.
//
// Aerva makes and checks the code itself, exactly like the email codes
// (_email-otp.js): only an HMAC of it is stored, it is good for 10 minutes
// and 5 guesses, asking again replaces the old one, and a correct code is
// used up at once. A code belongs to ONE number and ONE purpose ('guest' or
// 'host'), so it proves that exact number and nothing else.
//
// Switched OFF until all of these are set in Vercel:
//   WHATSAPP_OTP_ENABLED=1        the switch
//   WHATSAPP_TOKEN                a System User access token (Meta Business
//                                 settings → System users; "Never" expires)
//                                 with whatsapp_business_messaging permission
//   WHATSAPP_PHONE_NUMBER_ID      the sending number's ID (WhatsApp Manager →
//                                 API setup), not the phone number itself
//   WHATSAPP_OTP_TEMPLATE         the approved Authentication template's name
// Optional:
//   WHATSAPP_OTP_LANGUAGE         template language code (default 'en')
//   WHATSAPP_OTP_BUTTON           '0' if the template has no copy-code button
//                                 (default: it has one)
//   WHATSAPP_API_VERSION          Graph API version (default 'v23.0')
// And the database update migrations/2026-11-10-06-whatsapp-otp.sql.
//
// UAT (api/_env.js): WhatsApp messages go only to the numbers listed in
// UAT_WHATSAPP_TO; every other one is dropped (UAT holds a copy of real
// guests' numbers).
//
//   status(sql)                                → { available, reason }
//   sendCode(sql, { phone, purpose, ip, actor }) → { sent, phone, expiresInMinutes }
//                                                  or throws a user-facing error
//   checkCode(sql, { phone, purpose, code })   → { ok } or { ok:false, error }

const crypto = require('crypto');
const { logAudit } = require('./_audit-log');
const { countRecentAttempts } = require('./_rate-limit');
const { E164_PATTERN, normalizeToE164 } = require('./_phone-validation');

const CODE_LIFETIME_MINUTES = 10;
const MAX_ATTEMPTS = 5;                 // wrong guesses before the code is void
const RESEND_WAIT_SECONDS = 45;         // between two codes for one number
const MAX_SENDS_PER_NUMBER_PER_HOUR = 5;
const MAX_SENDS_PER_IP_PER_HOUR = 10;   // stops one script paying for codes to many numbers
const PURPOSES = ['guest', 'host'];
const ADMIN_EMAIL = () => process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in';

const userError = (message, status = 400, extra = {}) => Object.assign(new Error(message), { isUserFacing: true, status }, extra);
const isMissingTable = (err) => !!err && (err.code === '42P01' || err.code === '42703');
const on = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

// Words shown to people. Nothing here explains how Aerva checks anything.
// Guests can always carry on with their email; a host's phone step can be
// skipped for now and done later.
const MSG = {
  off: 'Codes on WhatsApp are not available yet. Please use your email instead.',
  down: 'We cannot send WhatsApp codes right now. Please use your email instead, or try again later.',
  notOnWhatsApp: "We couldn't send a WhatsApp code to that number. Check that the number is right and is on WhatsApp, or use your email instead.",
  busy: 'Too many codes have been asked for just now. Please wait a few minutes and try again.',
  tooMany: 'Too many codes have been sent to this number. Please try again in an hour, or use your email instead.',
};
const HOST_MSG = {
  off: 'Verifying your number on WhatsApp is not available yet. You can skip this step for now.',
  down: 'We cannot send WhatsApp codes right now. Please try again later, or skip this step for now.',
  notOnWhatsApp: "We couldn't send a WhatsApp code to that number. Check that the number is right and is on WhatsApp.",
  busy: MSG.busy,
  tooMany: 'Too many codes have been sent to this number. Please try again in an hour.',
};

function configured() {
  return on(process.env.WHATSAPP_OTP_ENABLED) && !!process.env.WHATSAPP_TOKEN
    && !!process.env.WHATSAPP_PHONE_NUMBER_ID && !!process.env.WHATSAPP_OTP_TEMPLATE;
}

// Is it switched on, and has the database update run?
async function status(sql) {
  if (!configured()) return { available: false, reason: 'not_configured' };
  try { await sql`SELECT 1 FROM phone_otps LIMIT 1`; }
  catch (err) {
    if (isMissingTable(err)) return { available: false, reason: 'database_update_needed' };
    return { available: false, reason: 'database_error' };
  }
  return { available: true };
}

const hashCode = (phone, purpose, code) =>
  crypto.createHmac('sha256', process.env.APPROVAL_TOKEN_SECRET || 'aerva-dev-secret')
    .update(`wa:${purpose}:${phone}:${code}`).digest('hex');

// Six digits, drawn evenly (a plain % would favour the low digits).
function newCode() {
  let out = '';
  while (out.length < 6) {
    const b = crypto.randomBytes(1)[0];
    if (b < 250) out += String(b % 10);
  }
  return out;
}

// Meta's error codes, sorted into: the number's fault, too busy, or Aerva's
// set-up (token, template, account) — the last one emails the admin.
const RECIPIENT_CODES = new Set([131026, 131030, 131021]);
const BUSY_CODES = new Set([4, 80007, 130429, 131048, 131056]);
function classify(httpStatus, err) {
  const code = Number(err && err.code);
  if (RECIPIENT_CODES.has(code)) return 'recipient';
  if (BUSY_CODES.has(code)) return 'busy';
  if (httpStatus === 401 || httpStatus === 403) return 'setup';
  return httpStatus >= 500 ? 'meta_down' : 'setup';
}

// The admin hears about a broken token/template at most once a day.
async function alertAdmin(sql, detail) {
  try {
    const recent = await countRecentAttempts(sql, { action: 'whatsapp_otp_key_alert', windowMinutes: 24 * 60 });
    if (recent > 0 || !process.env.RESEND_API_KEY) return;
    await logAudit(sql, { action: 'whatsapp_otp_key_alert', success: true, actorType: 'system', actorIdentifier: 'whatsapp', metadata: detail });
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to: ADMIN_EMAIL(),
        subject: 'WhatsApp codes are failing — people cannot confirm their number',
        html: `<div style="font-family:sans-serif; max-width:520px;">
          <p>Meta refused to send a WhatsApp sign-in code. Until this is fixed, people can only sign in with email, and hosts cannot finish the phone step.</p>
          <p style="font:13px monospace; background:#f4ebe3; padding:10px;">HTTP ${esc(detail.httpStatus)} · code ${esc(detail.code)} ${esc(detail.subcode || '')}<br>${esc(detail.message)}</p>
          <p>Usual causes: the access token in Vercel (WHATSAPP_TOKEN) expired or lost permission; the template (WHATSAPP_OTP_TEMPLATE) was renamed, paused or not approved; a payment method is missing in WhatsApp Manager; or WHATSAPP_PHONE_NUMBER_ID is wrong.</p>
          <p>You will get this email at most once a day while it keeps failing.</p></div>` })
    });
  } catch (e) { /* the alert itself must never break sign-in */ }
}

// One template message carrying the code. Returns { ok, messageId } or
// { ok:false, kind, httpStatus, error }.
async function deliver(phone, code) {
  const version = process.env.WHATSAPP_API_VERSION || 'v23.0';
  const components = [{ type: 'body', parameters: [{ type: 'text', text: code }] }];
  if (process.env.WHATSAPP_OTP_BUTTON !== '0') {
    // The copy-code button of an Authentication template carries the code too.
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] });
  }
  let res;
  try {
    res = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(process.env.WHATSAPP_PHONE_NUMBER_ID)}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual',
        to: phone.replace(/^\+/, ''), type: 'template',
        template: { name: process.env.WHATSAPP_OTP_TEMPLATE, language: { code: process.env.WHATSAPP_OTP_LANGUAGE || 'en' }, components }
      })
    });
  } catch (err) {
    return { ok: false, kind: 'meta_down', httpStatus: 0, error: { message: String(err && err.message || err) } };
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok && data && Array.isArray(data.messages) && data.messages[0]) {
    return { ok: true, messageId: data.messages[0].id || null };
  }
  const error = (data && data.error) || { message: res.statusText };
  return { ok: false, kind: classify(res.status, error), httpStatus: res.status, error };
}

function cleanPhone(raw) {
  const p = normalizeToE164(String(raw || ''));
  return p && E164_PATTERN.test(p) ? p : null;
}

// Sends a code. Throws a user-facing error (with .emailFallback where email
// is the way forward) — never "sends" a code that went nowhere.
async function sendCode(sql, { phone: rawPhone, purpose, ip = null, actor = null }) {
  if (!PURPOSES.includes(purpose)) throw new Error('phone code purpose must be guest or host');
  const phone = cleanPhone(rawPhone);
  if (!phone) throw userError('Please enter your mobile number with its country code, like +91 98765 43210.');
  const M = purpose === 'host' ? HOST_MSG : MSG;
  const fallback = purpose === 'guest';
  const st = await status(sql);
  if (!st.available) throw userError(M.off, 503, { emailFallback: fallback, whatsappOff: true });

  const audit = (success, metadata = {}) => logAudit(sql, {
    action: 'phone_code_sent', success, actorType: purpose === 'host' ? 'host' : 'guest',
    actorIdentifier: phone, metadata: Object.assign({ ip, purpose, channel: 'whatsapp', by: actor }, metadata)
  });

  // Limits first: the point is not to pay for the message at all.
  if (ip && await countRecentAttempts(sql, { action: 'phone_code_sent', windowMinutes: 60, byIp: ip, onlyFailures: false }) >= MAX_SENDS_PER_IP_PER_HOUR) {
    await audit(false, { reason: 'ip_rate_limited' });
    throw userError('Too many codes have been asked for from this connection. Please try again later.', 429);
  }
  const existing = (await sql`SELECT last_sent_at, sent_count, created_at FROM phone_otps WHERE phone = ${phone} AND purpose = ${purpose}`)[0];
  if (existing) {
    const since = (Date.now() - new Date(existing.last_sent_at).getTime()) / 1000;
    if (since < RESEND_WAIT_SECONDS) {
      throw userError(`Please wait ${Math.ceil(RESEND_WAIT_SECONDS - since)} seconds before asking for another code.`, 429, { waitSeconds: Math.ceil(RESEND_WAIT_SECONDS - since) });
    }
    const withinHour = (Date.now() - new Date(existing.created_at).getTime()) < 3600e3;
    if (withinHour && existing.sent_count >= MAX_SENDS_PER_NUMBER_PER_HOUR) {
      await audit(false, { reason: 'number_rate_limited' });
      throw userError(M.tooMany, 429, { emailFallback: fallback });
    }
  }

  const code = newCode();
  await sql`
    INSERT INTO phone_otps (phone, purpose, code_hash, expires_at, attempts, sent_count, last_sent_at, created_at)
    VALUES (${phone}, ${purpose}, ${hashCode(phone, purpose, code)}, now() + make_interval(mins => ${CODE_LIFETIME_MINUTES}), 0, 1, now(), now())
    ON CONFLICT (phone, purpose) DO UPDATE SET
      code_hash = EXCLUDED.code_hash,
      expires_at = EXCLUDED.expires_at,
      attempts = 0,
      -- an hour after the first one, the count starts again
      sent_count = CASE WHEN phone_otps.created_at > now() - interval '1 hour' THEN phone_otps.sent_count + 1 ELSE 1 END,
      created_at = CASE WHEN phone_otps.created_at > now() - interval '1 hour' THEN phone_otps.created_at ELSE now() END,
      last_sent_at = now()`;

  const out = await deliver(phone, code);
  if (!out.ok) {
    // Nothing arrived, so the stored code is useless — but the count of
    // sends stays (a failing number must not be retried without limit).
    await sql`UPDATE phone_otps SET code_hash = '', expires_at = now() WHERE phone = ${phone} AND purpose = ${purpose}`;
    const err = out.error || {};
    console.error('WhatsApp code not sent:', out.httpStatus, err.code, err.error_subcode, err.message);
    await audit(false, { reason: 'whatsapp_' + out.kind, httpStatus: out.httpStatus, code: err.code || null, subcode: err.error_subcode || null });
    if (out.kind === 'setup') await alertAdmin(sql, { httpStatus: out.httpStatus, code: err.code, subcode: err.error_subcode, message: String(err.message || '').slice(0, 300) });
    if (out.kind === 'recipient') throw userError(M.notOnWhatsApp, 400, { emailFallback: fallback, notOnWhatsApp: true });
    if (out.kind === 'busy') throw userError(M.busy, 429, { emailFallback: fallback });
    throw userError(M.down, 503, { emailFallback: fallback });
  }
  await audit(true, { messageId: out.messageId });
  return { sent: true, phone, channel: 'whatsapp', expiresInMinutes: CODE_LIFETIME_MINUTES, resendAfterSeconds: RESEND_WAIT_SECONDS };
}

// Checks a code. Correct → used up at once (one statement, so two requests
// with the same code cannot both pass).
async function checkCode(sql, { phone: rawPhone, purpose, code: rawCode }) {
  if (!PURPOSES.includes(purpose)) throw new Error('phone code purpose must be guest or host');
  const phone = cleanPhone(rawPhone);
  const code = String(rawCode || '').trim();
  if (!phone) return { ok: false, error: 'Please enter your mobile number with its country code.' };
  if (!/^\d{6}$/.test(code)) return { ok: false, error: 'Enter the 6-digit code from WhatsApp.' };
  let row;
  try { row = (await sql`SELECT code_hash, expires_at, attempts FROM phone_otps WHERE phone = ${phone} AND purpose = ${purpose}`)[0]; }
  catch (err) { if (isMissingTable(err)) return { ok: false, error: MSG.off, status: 503 }; throw err; }
  if (!row || !row.code_hash) return { ok: false, error: 'Please ask for a code first.' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'That code has expired. Please ask for a new one.' };
  }
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'Too many wrong codes. Please ask for a new one.' };
  const want = Buffer.from(row.code_hash);
  const got = Buffer.from(hashCode(phone, purpose, code));
  if (!(want.length === got.length && crypto.timingSafeEqual(want, got))) {
    await sql`UPDATE phone_otps SET attempts = attempts + 1 WHERE phone = ${phone} AND purpose = ${purpose}`;
    const left = MAX_ATTEMPTS - row.attempts - 1;
    return { ok: false, error: left > 0 ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Please ask for a new one.' };
  }
  const used = await sql`
    UPDATE phone_otps SET code_hash = '', expires_at = now()
    WHERE phone = ${phone} AND purpose = ${purpose} AND code_hash = ${row.code_hash}
    RETURNING phone`;
  if (!used.length) return { ok: false, error: 'That code has already been used. Please ask for a new one.' };
  return { ok: true, phone };
}

module.exports = { status, sendCode, checkCode, configured, CODE_LIFETIME_MINUTES, _test: { classify, hashCode } };
