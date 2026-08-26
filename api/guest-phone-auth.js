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
//   POST { mode: 'verify', phone, code }
//     Checks the code with Twilio. If correct, finds or creates a guest
//     account by phone number and returns a 30-day session token — the
//     same token type/shape as email+password login, so the existing
//     GET /api/guest-auth session check works for phone-based logins too.
//
// Requires env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_VERIFY_SERVICE_SID (a Verify Service created in the Twilio
// console — not the same as a phone number SID).

const { neon } = require('@neondatabase/serverless');
const { createToken } = require('./_approval-token');
const { logAudit } = require('./_audit-log');

const sql = neon(process.env.DATABASE_URL);

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — matches email login

// E.164: a leading +, then 8-15 digits, first digit 1-9. Catches the
// common mistake of a local number without a country code (e.g.
// "9876543210" instead of "+919876543210") before we ever call Twilio.
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

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

  if (!phone || typeof phone !== 'string' || !E164_PATTERN.test(phone.trim())) {
    return res.status(400).json({ error: 'Please enter your phone number with country code, like +919876543210.' });
  }
  const cleanPhone = phone.trim();

  // ---- Request an OTP ----
  if (mode === 'request') {
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
          metadata: { reason: 'twilio_error', status: verifyRes.status }
        });
        // A 4xx here is almost always an invalid/unreachable number.
        if (verifyRes.status >= 400 && verifyRes.status < 500) {
          return res.status(400).json({ error: "That phone number couldn't be reached. Please double check it." });
        }
        return res.status(500).json({ error: 'Could not send the code right now. Please try again shortly.' });
      }

      await logAudit(sql, {
        action: 'guest_phone_otp_requested', success: true, actorType: 'guest', actorIdentifier: cleanPhone
      });
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('guest-phone-auth (request) error:', err);
      await logAudit(sql, {
        action: 'guest_phone_otp_requested', success: false, actorType: 'guest', actorIdentifier: cleanPhone,
        metadata: { reason: 'server_error' }
      });
      return res.status(500).json({ error: 'Could not send the code right now. Please try again shortly.' });
    }
  }

  // ---- Verify the OTP ----
  if (mode === 'verify') {
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Please enter the code you received.' });
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
          metadata: { reason: 'code_rejected' }
        });
        return res.status(401).json({ error: 'That code is incorrect or has expired. Please request a new one.' });
      }

      // Code approved — find or create the guest account by phone.
      let rows = await sql`SELECT id, email, name, phone FROM guests WHERE phone = ${cleanPhone}`;
      let guest = rows[0];
      if (!guest) {
        const inserted = await sql`
          INSERT INTO guests (phone) VALUES (${cleanPhone})
          RETURNING id, email, name, phone
        `;
        guest = inserted[0];
      }

      const sessionToken = createToken(guest.id, 'guest-session', SESSION_LIFETIME_MS);
      await logAudit(sql, {
        action: 'guest_phone_otp_verified', success: true, actorType: 'guest', actorIdentifier: cleanPhone,
        targetType: 'guest', targetId: guest.id
      });

      return res.status(200).json({ sessionToken, guest: safeGuest(guest) });
    } catch (err) {
      console.error('guest-phone-auth (verify) error:', err);
      await logAudit(sql, {
        action: 'guest_phone_otp_verified', success: false, actorType: 'guest', actorIdentifier: cleanPhone,
        metadata: { reason: 'server_error' }
      });
      return res.status(500).json({ error: 'Could not verify that code right now. Please try again.' });
    }
  }

  return res.status(400).json({ error: 'Invalid request. mode must be "request" or "verify".' });
};
