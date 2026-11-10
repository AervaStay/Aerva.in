// /api/guest-phone-auth.js
// Phone + code for guests. The code goes by WhatsApp (owner, 10 Nov 2026:
// Meta's WhatsApp Cloud API, fallback email only — no SMS). Aerva makes,
// stores (as a hash), sends and checks the code in _phone-otp.js; Twilio is
// no longer used.
//
//   GET  ?status=1                               → { available }
//     Whether WhatsApp codes are switched on. The sign-in page shows "Log in
//     with phone" and checkout asks for a code only while this is true.
//
//   POST { mode: 'request', phone }
//     Sends a 6-digit code on WhatsApp to the number (any common way of
//     writing it; stored and sent as E.164, e.g. +919876543210).
//
//   POST { mode: 'verify', phone, code }        — sign in by phone
//   POST { mode: 'link', phone, code }           — signed in already:
//     attaches this verified number to THAT account instead of switching
//     to another one. Every account ends up linked to a number its owner
//     proved by code, which is what a host is given to reach the guest.
//     'verify' finds or creates a guest account by the number and returns a
//     30-day session token — the same token type/shape as email+password
//     login, so the existing GET /api/guest-auth session check works for
//     phone-based logins too.
//
// Switched on by the WhatsApp settings described in _phone-otp.js plus the
// database update 2026-11-10-06-whatsapp-otp.sql. Until then every mode is
// refused with a message pointing to email.

require('./_env'); // production vs UAT safety rails — must load first
const { neon } = require('@neondatabase/serverless');
const { verifyToken } = require('./_approval-token');
const { sessionStatus, newSessionToken, reactivateIfPaused, assertNotSuspended, SUSPENDED_MESSAGE } = require('./_accounts');
const { logAudit } = require('./_audit-log');
const { getClientIp, countRecentAttempts } = require('./_rate-limit');
const { E164_PATTERN, normalizeToE164, phoneMatchSuffix } = require('./_phone-validation');
const phoneOtp = require('./_phone-otp');

const sql = neon(process.env.DATABASE_URL);

// Same string as TERMS_VERSION in guest-auth.js and guest-login.html.
const TERMS_VERSION = '1.0 (26 September 2026)';

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — matches email login

// How many codes a number or a connection may ask for is capped in
// _phone-otp.js (every WhatsApp message is billed). Checking is free, but
// uncapped it is a brute-force surface against a 6-digit code, so it gets
// a limit of its own.
const OTP_VERIFY_FAILURES_PER_IP_PER_HOUR = 20;

// E.164 shape check, plus the normalizer that accepts the same number
// written with spaces, dashes, a 00 prefix, or no country code at all —
// both shared with guest-auth.js's signup so every write to guests.phone
// lands in one consistent format. See _phone-validation.js.

function safeGuest(guest) {
  return { id: guest.id, email: guest.email, name: guest.name, phone: guest.phone };
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // Authorization: the 'link' mode is used by someone already signed in.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') {
    const st = await phoneOtp.status(sql);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ available: st.available, channel: 'whatsapp' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Off until WhatsApp codes are set up (see _phone-otp.js): nothing here
  // may send a message — or sign anyone in — until then.
  const st = await phoneOtp.status(sql);
  if (!st.available) {
    return res.status(503).json({ error: 'Codes on WhatsApp are not available yet. Please use your email instead.', phoneLoginDisabled: true, emailFallback: true });
  }

  const { mode, phone, code } = req.body || {};
  const clientIp = getClientIp(req);

  // Accept whatever the person typed and normalize it, rather than
  // rejecting anything that isn't already perfect E.164 — "098765 43210"
  // and "+91 98765-43210" are the same number, and only the canonical form
  // is stored or sent.
  const cleanPhone = normalizeToE164(phone);
  if (!cleanPhone || !E164_PATTERN.test(cleanPhone)) {
    return res.status(400).json({ error: 'Please enter your phone number with country code, like +919876543210.' });
  }

  // ---- Request a code (WhatsApp) ----
  if (mode === 'request') {
    try {
      const out = await phoneOtp.sendCode(sql, { phone: cleanPhone, purpose: 'guest', ip: clientIp });
      return res.status(200).json({ success: true, channel: out.channel, expiresInMinutes: out.expiresInMinutes, resendAfterSeconds: out.resendAfterSeconds });
    } catch (err) {
      if (err.isUserFacing) {
        return res.status(err.status || 400).json({ error: err.message, emailFallback: !!err.emailFallback,
          notOnWhatsApp: !!err.notOnWhatsApp, waitSeconds: err.waitSeconds || undefined });
      }
      console.error('guest-phone-auth (request) error:', err);
      return res.status(500).json({ error: 'Could not send the code right now. Please try again shortly, or use your email instead.', emailFallback: true });
    }
  }

  // ---- Verify the OTP ----
  // 'verify' signs the guest in; 'link' attaches the number to the account
  // they are already signed in to. Both need the same code check first.
  if (mode === 'verify' || mode === 'link') {
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Please enter the 6-digit code from WhatsApp.' });
    }

    // A 6-digit code is only 10^6 possibilities; each code allows 5 guesses
    // (_phone-otp.js), but nothing there stops one IP grinding away across
    // many numbers at once.
    const failedVerifies = await countRecentAttempts(sql, {
      action: 'guest_phone_otp_verified', windowMinutes: 60, byIp: clientIp, onlyFailures: true
    });
    if (failedVerifies >= OTP_VERIFY_FAILURES_PER_IP_PER_HOUR) {
      await logAudit(sql, {
        action: 'guest_phone_otp_blocked', success: false, actorType: 'guest', actorIdentifier: cleanPhone,
        metadata: { reason: 'verify_rate_limited', ip: clientIp }
      });
      return res.status(429).json({ error: 'Too many incorrect codes. Please try again later.' });
    }

    try {
      const check = await phoneOtp.checkCode(sql, { phone: cleanPhone, purpose: 'guest', code });
      if (!check.ok) {
        await logAudit(sql, {
          action: 'guest_phone_otp_verified', success: false, actorType: 'guest', actorIdentifier: cleanPhone,
          metadata: { reason: 'code_rejected', ip: clientIp }
        });
        return res.status(check.status || 401).json({ error: check.error });
      }

      // Who holds this number now, and did they prove it? A number that was
      // only typed in (savePhone, sign-up) is contact detail, never a way
      // in: signing in by code matches only a PROVED number, and whoever
      // proves it takes it over from an unverified holder. Before
      // migration_session_version.sql there is no phone_verified column;
      // every holder then counts as proved (the old behaviour).
      const holderOf = async (excludeId) => (await sql`
        SELECT g.id, g.email, g.name, g.phone,
               (to_jsonb(g) ? 'phone_verified') AS has_flag, (to_jsonb(g)->>'phone_verified') = 'true' AS verified
        FROM guests g
        WHERE btrim(g.phone) = ${cleanPhone} AND g.id <> ${excludeId} AND g.deleted_at IS NULL
      `)[0] || null;
      const isProved = (h) => !!h && (!h.has_flag || h.verified);
      // Takes the number off an unverified holder. false if it cannot (the
      // number is that account's only sign-in, so it cannot be left empty).
      const release = async (h) => {
        try {
          const r = await sql`UPDATE guests SET phone = NULL, phone_verified = false
                              WHERE id = ${h.id} AND phone_verified = false RETURNING id`;
          if (!r.length) return false;
          await logAudit(sql, { action: 'guest_phone_released', success: true, actorType: 'guest', actorIdentifier: cleanPhone,
            targetType: 'guest', targetId: h.id, metadata: { reason: 'proved_by_another_account', ip: clientIp } });
          return true;
        } catch (err) {
          console.error('could not release an unverified number:', err.message);
          return false;
        }
      };
      const markProved = async (id) => {
        try { await sql`UPDATE guests SET phone_verified = true WHERE id = ${id}`; }
        catch (err) { /* before migration_session_version.sql */ }
      };

      // Signed in already: the verified number joins THIS account.
      if (mode === 'link') {
        const auth = String(req.headers.authorization || '');
        const payload = auth.startsWith('Bearer ') ? verifyToken(auth.slice(7)) : null;
        const st = await sessionStatus(sql, payload);
        if (st === 'deleted') return res.status(401).json({ error: 'This account has been deleted.' });
        if (st === 'suspended') return res.status(401).json({ error: SUSPENDED_MESSAGE, suspended: true, signinHelp: true });
        if (st === 'error') return res.status(503).json({ error: 'Could not check your sign-in right now. Please try again.' });
        const meId = st === 'ok' ? Number(payload.listingId) : 0;
        if (!meId) return res.status(401).json({ error: 'Please log in again.' });
        // The number may already sit on another account. If that owner
        // proved it too, it is not simply taken away; if they only typed
        // it in, the person who just proved it wins.
        const holder = await holderOf(meId);
        if (holder && (isProved(holder) || !(await release(holder)))) {
          return res.status(409).json({ error: 'This number is already on another Aerva account. Log in with that number instead, or use a different one.' });
        }
        await sql`UPDATE guests SET phone = ${cleanPhone} WHERE id = ${meId}`;
        await markProved(meId);
        await logAudit(sql, { action: 'guest_phone_linked', success: true, actorType: 'guest', actorIdentifier: cleanPhone,
          targetType: 'guest', targetId: meId, metadata: { ip: clientIp } });
        const me = (await sql`SELECT id, email, name, phone FROM guests WHERE id = ${meId}`)[0];
        return res.status(200).json({ linked: true, guest: safeGuest(me) });
      }

      // Code approved — find the account that PROVED this number, or make one.
      let guest = null;
      const holder = await holderOf(0);
      if (holder && isProved(holder)) guest = holder;
      else if (holder && !(await release(holder))) {
        return res.status(409).json({ error: 'This number is on an account that signs in another way. Please log in with your email.' });
      }

      // No exact match. Before creating a NEW account, check for one
      // written before phone normalization existed — a number stored as
      // "9876543210" rather than "+919876543210". Adopted only when that
      // account has no email or password: such an account can only have
      // been made by signing in with this phone. An account with an email
      // merely had the number typed into it, which proves nothing about
      // who is holding the phone now — adopting it would hand that account
      // to whoever controls the number. If more than one row matches, none
      // is adopted, since guessing between two real accounts is worse
      // than making a new one.
      if (!guest) {
        const suffix = phoneMatchSuffix(cleanPhone);
        if (suffix) {
          const legacy = await sql`
            SELECT id, email, name, phone FROM guests
            WHERE phone IS NOT NULL
              AND phone NOT LIKE '+%'
              AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE ${'%' + suffix}
              AND deleted_at IS NULL
          `;
          if (legacy.length === 1 && !String(legacy[0].email || '').trim()) {
            const adopted = await sql`
              UPDATE guests SET phone = ${cleanPhone} WHERE id = ${legacy[0].id} AND password_hash IS NULL
              RETURNING id, email, name, phone
            `;
            if (adopted[0]) {
              guest = adopted[0];
              await logAudit(sql, {
                action: 'guest_phone_legacy_adopted', success: true, actorType: 'guest', actorIdentifier: cleanPhone,
                targetType: 'guest', targetId: guest.id,
                metadata: { previousFormat: legacy[0].phone, ip: clientIp }
              });
            }
          }
        }
      }

      if (!guest) {
        // A new account agrees to the Terms and Privacy Policy, as on
        // sign-up (guest-auth.js); the version, time and IP are kept.
        const b = req.body || {};
        if (!(b.consent === true || b.consent === 'true')) {
          return res.status(400).json({ needsConsent: true,
            error: 'This number is new to Aerva. Tick the box to agree to the Terms of Service and Privacy Policy, then ask for a new code.' });
        }
        const inserted = await sql`
          INSERT INTO guests (phone) VALUES (${cleanPhone})
          RETURNING id, email, name, phone
        `;
        guest = inserted[0];
        try {
          await sql`UPDATE guests SET consent_version = ${TERMS_VERSION}, consent_at = now(), consent_ip = ${clientIp} WHERE id = ${guest.id}`;
        } catch (err) { /* before migration_session_version.sql */ }
      }

      // The number is proved, so the account is linked to it from here on.
      await markProved(guest.id);
      // Logging in un-pauses an account that was paused (_accounts.js).
      await assertNotSuspended(sql, guest.id);   // suspended by Aerva: no sign-in
      await reactivateIfPaused(sql, guest.id);

      const sessionToken = await newSessionToken(sql, guest.id, SESSION_LIFETIME_MS);
      await logAudit(sql, {
        action: 'guest_phone_otp_verified', success: true, actorType: 'guest', actorIdentifier: cleanPhone,
        targetType: 'guest', targetId: guest.id, metadata: { ip: clientIp }
      });

      return res.status(200).json({ sessionToken, guest: safeGuest(guest) });
    } catch (err) {
      if (err.suspended) return res.status(403).json({ error: err.message, suspended: true, signinHelp: true });
      console.error('guest-phone-auth (verify) error:', err);
      await logAudit(sql, {
        action: 'guest_phone_otp_verified', success: false, actorType: 'guest', actorIdentifier: cleanPhone,
        metadata: { reason: 'server_error', ip: clientIp }
      });
      return res.status(500).json({ error: 'Could not verify that code right now. Please try again.' });
    }
  }

  return res.status(400).json({ error: 'Invalid request. mode must be "request" or "verify".' });
};
