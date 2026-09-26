// /api/guest-phone-auth.js
// Phone + OTP login for guests, using Twilio Verify — Twilio generates,
// sends, expires, and rate-limits the OTP itself server-side, so this
// file never stores or compares a code directly. That's deliberately
// simpler and safer than rolling a custom OTP system.
//
//   POST { mode: 'request', phone }
//     Triggers an SMS with a one-time code to the given phone number
//     (E.164 format, e.g. +919876543210).
//
//   NOTE: every code Twilio sends costs money, per message. Confirming an
//   account is therefore done by EMAIL instead (guest-auth.js, mode
//   'emailOtp…'), which costs nothing — this stays only for hosts and
//   guests who prefer to sign in with their number.
//
//   POST { mode: 'verify', phone, code }        — sign in by phone
//   POST { mode: 'link', phone, code }           — signed in already:
//     attaches this verified number to THAT account instead of switching
//     to another one. Every account ends up linked to a number its owner
//     proved by OTP, which is what a host is given to reach the guest.
//     Checks the code with Twilio. If correct, finds or creates a guest
//     account by phone number and returns a 30-day session token — the
//     same token type/shape as email+password login, so the existing
//     GET /api/guest-auth session check works for phone-based logins too.
//
// Requires env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_VERIFY_SERVICE_SID (a Verify Service created in the Twilio
// console — not the same as a phone number SID), and PHONE_LOGIN_ENABLED
// = true. Without that flag every mode is refused with a clear message.

const { neon } = require('@neondatabase/serverless');
const { verifyToken } = require('./_approval-token');
const { sessionStatus, newSessionToken, reactivateIfPaused } = require('./_accounts');
const { logAudit } = require('./_audit-log');
const { getClientIp, countRecentAttempts } = require('./_rate-limit');
const { E164_PATTERN, normalizeToE164, phoneMatchSuffix } = require('./_phone-validation');

const sql = neon(process.env.DATABASE_URL);

// Phone sign-in is built but switched off until Twilio is set up (the
// sign-in page hides it). 'true' or '1' in Vercel turns it on.
// Same string as TERMS_VERSION in guest-auth.js and guest-login.html.
const TERMS_VERSION = '1.0 (26 September 2026)';
const PHONE_LOGIN_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.PHONE_LOGIN_ENABLED || ''));

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — matches email login

// Twilio Verify rate-limits per DESTINATION number on its own, which
// stops someone hammering one person's phone. What it does not stop is
// one script requesting codes for thousands of DIFFERENT numbers — every
// one of those is a real SMS that Aerva pays for. That's SMS pumping
// (a.k.a. toll fraud), and the bill lands before anyone notices the
// traffic. These caps are the actual protection; Twilio's own limits are
// a second layer underneath, not a substitute.
const OTP_REQUESTS_PER_IP_PER_HOUR = 10;
const OTP_REQUESTS_PER_NUMBER_PER_HOUR = 5;
// Verification is cheap (no SMS sent), but uncapped it's a brute-force
// surface against a 6-digit code, so it gets a looser limit of its own.
const OTP_VERIFY_FAILURES_PER_IP_PER_HOUR = 20;

// E.164 shape check, plus the normalizer that accepts the same number
// written with spaces, dashes, a 00 prefix, or no country code at all —
// both shared with guest-auth.js's signup so every write to guests.phone
// lands in one consistent format. See _phone-validation.js.

function twilioAuthHeader() {
  const creds = `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`;
  return 'Basic ' + Buffer.from(creds).toString('base64');
}

function safeGuest(guest) {
  return { id: guest.id, email: guest.email, name: guest.name, phone: guest.phone };
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  // Authorization: the 'link' mode is used by someone already signed in.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Off unless PHONE_LOGIN_ENABLED is set in Vercel: the sign-in page hides
  // phone login, and every text message is billed, so nothing here may
  // send one — or sign anyone in — until it is switched on on purpose.
  if (!PHONE_LOGIN_ENABLED) {
    return res.status(503).json({ error: 'Logging in by phone is not available. Please log in with your email instead.', phoneLoginDisabled: true });
  }

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_VERIFY_SERVICE_SID) {
    console.error('Twilio env vars not fully set — phone login cannot work.');
    return res.status(500).json({ error: 'Phone login is not available right now. Please try email instead.' });
  }

  const { mode, phone, code } = req.body || {};
  const clientIp = getClientIp(req);

  // Accept whatever the person typed and normalize it, rather than
  // rejecting anything that isn't already perfect E.164 — "098765 43210"
  // and "+91 98765-43210" are the same number, and Twilio only ever sees
  // the canonical form.
  const cleanPhone = normalizeToE164(phone);
  if (!cleanPhone || !E164_PATTERN.test(cleanPhone)) {
    return res.status(400).json({ error: 'Please enter your phone number with country code, like +919876543210.' });
  }

  // ---- Request an OTP ----
  if (mode === 'request') {
    // Checked BEFORE the Twilio call — the whole point is to not send
    // (and not pay for) the message in the first place. countRecentAttempts
    // fails open on a database error, which is the right trade here: a
    // broken rate-limit check shouldn't lock every real guest out of
    // logging in.
    const requestsByIp = await countRecentAttempts(sql, {
      action: 'guest_phone_otp_requested', windowMinutes: 60, byIp: clientIp, onlyFailures: false
    });
    if (requestsByIp >= OTP_REQUESTS_PER_IP_PER_HOUR) {
      await logAudit(sql, {
        action: 'guest_phone_otp_blocked', success: false, actorType: 'guest', actorIdentifier: cleanPhone,
        metadata: { reason: 'ip_rate_limited', ip: clientIp }
      });
      return res.status(429).json({ error: 'Too many codes requested from this connection. Please try again later.' });
    }

    const requestsByNumber = await countRecentAttempts(sql, {
      action: 'guest_phone_otp_requested', windowMinutes: 60, byActor: cleanPhone, onlyFailures: false
    });
    if (requestsByNumber >= OTP_REQUESTS_PER_NUMBER_PER_HOUR) {
      await logAudit(sql, {
        action: 'guest_phone_otp_blocked', success: false, actorType: 'guest', actorIdentifier: cleanPhone,
        metadata: { reason: 'number_rate_limited', ip: clientIp }
      });
      return res.status(429).json({ error: 'Too many codes requested for this number. Please try again later.' });
    }

    try {
      const verifyRes = await fetch(
        `https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/Verifications`,
        {
          method: 'POST',
          headers: {
            'Authorization': twilioAuthHeader(),
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({ To: cleanPhone, Channel: 'sms' })
        }
      );

      if (!verifyRes.ok) {
        let detail;
        try { detail = await verifyRes.json(); } catch { detail = { message: verifyRes.statusText }; }
        console.error('Twilio Verify (start) failed:', verifyRes.status, detail);
        await logAudit(sql, {
          action: 'guest_phone_otp_requested', success: false, actorType: 'guest', actorIdentifier: cleanPhone,
          metadata: { reason: 'twilio_error', status: verifyRes.status, ip: clientIp }
        });
        // A 4xx here is almost always an invalid/unreachable number.
        if (verifyRes.status >= 400 && verifyRes.status < 500) {
          return res.status(400).json({ error: "That phone number couldn't be reached. Please double check it." });
        }
        return res.status(500).json({ error: 'Could not send the code right now. Please try again shortly.' });
      }

      await logAudit(sql, {
        action: 'guest_phone_otp_requested', success: true, actorType: 'guest', actorIdentifier: cleanPhone,
        metadata: { ip: clientIp }
      });
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('guest-phone-auth (request) error:', err);
      await logAudit(sql, {
        action: 'guest_phone_otp_requested', success: false, actorType: 'guest', actorIdentifier: cleanPhone,
        metadata: { reason: 'server_error', ip: clientIp }
      });
      return res.status(500).json({ error: 'Could not send the code right now. Please try again shortly.' });
    }
  }

  // ---- Verify the OTP ----
  // 'verify' signs the guest in; 'link' attaches the number to the account
  // they are already signed in to. Both need the same code check first.
  if (mode === 'verify' || mode === 'link') {
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Please enter the code you received.' });
    }

    // A 6-digit code is only 10^6 possibilities; Twilio expires codes and
    // caps checks per verification, but nothing there stops one IP
    // grinding away across many numbers at once.
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
      const checkRes = await fetch(
        `https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`,
        {
          method: 'POST',
          headers: {
            'Authorization': twilioAuthHeader(),
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({ To: cleanPhone, Code: code.trim() })
        }
      );

      const checkData = await checkRes.json().catch(() => null);

      if (!checkRes.ok || !checkData || checkData.status !== 'approved') {
        console.error('Twilio Verify (check) not approved:', checkRes.status, checkData);
        await logAudit(sql, {
          action: 'guest_phone_otp_verified', success: false, actorType: 'guest', actorIdentifier: cleanPhone,
          metadata: { reason: 'code_rejected', ip: clientIp }
        });
        return res.status(401).json({ error: 'That code is incorrect or has expired. Please request a new one.' });
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
      await reactivateIfPaused(sql, guest.id);

      const sessionToken = await newSessionToken(sql, guest.id, SESSION_LIFETIME_MS);
      await logAudit(sql, {
        action: 'guest_phone_otp_verified', success: true, actorType: 'guest', actorIdentifier: cleanPhone,
        targetType: 'guest', targetId: guest.id, metadata: { ip: clientIp }
      });

      return res.status(200).json({ sessionToken, guest: safeGuest(guest) });
    } catch (err) {
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
