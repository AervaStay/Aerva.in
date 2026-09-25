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
// console — not the same as a phone number SID).

const { neon } = require('@neondatabase/serverless');
const { createToken, verifyToken } = require('./_approval-token');
const { logAudit } = require('./_audit-log');
const { getClientIp, countRecentAttempts } = require('./_rate-limit');
const { E164_PATTERN, normalizeToE164, phoneMatchSuffix } = require('./_phone-validation');

const sql = neon(process.env.DATABASE_URL);

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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

      // Signed in already: the verified number joins THIS account.
      if (mode === 'link') {
        const auth = String(req.headers.authorization || '');
        const payload = auth.startsWith('Bearer ') ? verifyToken(auth.slice(7)) : null;
        const meId = payload && payload.action === 'guest-session' ? Number(payload.listingId) : 0;
        if (!meId) return res.status(401).json({ error: 'Please log in again.' });
        // The number may already sit on another account — that account's
        // owner proved it once too, so it is not simply taken away.
        const taken = await sql`SELECT id FROM guests WHERE phone = ${cleanPhone} AND id <> ${meId} AND deleted_at IS NULL`;
        if (taken.length) {
          return res.status(409).json({ error: 'This number is already on another Aerva account. Log in with that number instead, or use a different one.' });
        }
        await sql`UPDATE guests SET phone = ${cleanPhone}, phone_verified_at = now() WHERE id = ${meId}`;
        await logAudit(sql, { action: 'guest_phone_linked', success: true, actorType: 'guest', actorIdentifier: cleanPhone,
          targetType: 'guest', targetId: meId, metadata: { ip: clientIp } });
        const me = (await sql`SELECT id, email, name, phone FROM guests WHERE id = ${meId}`)[0];
        return res.status(200).json({ linked: true, guest: safeGuest(me) });
      }

      // Code approved — find or create the guest account by phone.
      let rows = await sql`SELECT id, email, name, phone FROM guests WHERE phone = ${cleanPhone}`;
      let guest = rows[0];

      // No exact match. Before creating a NEW account, check for one
      // written before phone normalization existed — a guest who signed
      // up by email and typed "9876543210" into the old free-text phone
      // field has the same number stored as a different string, and
      // creating a second account here would split their bookings,
      // coupons, and message threads across two identities with no way
      // to merge them afterwards.
      //
      // The match is on the last 10 digits, which is deliberately narrow:
      // it only ever ADOPTS a row whose number is the same one Twilio
      // just verified the person controls. Twilio's approval is what
      // authenticates them — the suffix only decides which existing row
      // that verified number belongs to. If more than one row somehow
      // matches, none is adopted, since guessing between two real
      // accounts is worse than making a new one.
      if (!guest) {
        const suffix = phoneMatchSuffix(cleanPhone);
        if (suffix) {
          const legacy = await sql`
            SELECT id, email, name, phone FROM guests
            WHERE phone IS NOT NULL
              AND phone NOT LIKE '+%'
              AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE ${'%' + suffix}
          `;
          if (legacy.length === 1) {
            const adopted = await sql`
              UPDATE guests SET phone = ${cleanPhone} WHERE id = ${legacy[0].id}
              RETURNING id, email, name, phone
            `;
            guest = adopted[0];
            await logAudit(sql, {
              action: 'guest_phone_legacy_adopted', success: true, actorType: 'guest', actorIdentifier: cleanPhone,
              targetType: 'guest', targetId: guest.id,
              metadata: { previousFormat: legacy[0].phone, ip: clientIp }
            });
          }
        }
      }

      if (!guest) {
        const inserted = await sql`
          INSERT INTO guests (phone) VALUES (${cleanPhone})
          RETURNING id, email, name, phone
        `;
        guest = inserted[0];
      }

      // The number is proved, so the account is linked to it from here on.
      try { await sql`UPDATE guests SET phone_verified_at = now() WHERE id = ${guest.id}`; }
      catch (err) { /* before migration_guest_details.sql */ }
      // Logging in un-pauses an account that was paused (_accounts.js).
      await require('./_accounts').reactivateIfPaused(sql, guest.id);

      const sessionToken = createToken(guest.id, 'guest-session', SESSION_LIFETIME_MS);
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
