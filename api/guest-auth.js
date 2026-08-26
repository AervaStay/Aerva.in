// /api/guest-auth.js
// Email + password accounts for guests — separate from phone/OTP login
// (guest-phone-auth.js). Session tokens use the same signed-token
// approach as everywhere else (see _approval-token.js): a guest's browser
// stores a signed session token, never their actual password.
//
//   POST { mode: 'signup', email, password, name?, phone? }
//     Creates a new guest account, UNVERIFIED. Does not log them in —
//     instead sends a verification email with a 24-hour link. The
//     password is hashed with bcrypt before it ever touches the database
//     or a log line; the raw password itself is never stored anywhere.
//
//   POST { mode: 'login', email, password }
//     Verifies credentials. Blocks login with a clear error if the
//     account's email hasn't been verified yet.
//
//   POST { mode: 'resend-verification', email }
//     Sends a fresh verification link, for when the first one expired or
//     got lost.
//
//   GET  ?token=<verifyToken>
//     Called when a guest clicks the link in their verification email.
//     Marks the account verified and returns a session token, so
//     clicking the link both verifies AND logs them in — one step, not two.
//
//   GET  (Authorization: Bearer <sessionToken>)
//     Verifies an existing session token is still valid. Called on page
//     load so a returning guest with a stored token gets logged in
//     automatically, without typing their password again.

const bcrypt = require('bcryptjs');
const { neon } = require('@neondatabase/serverless');
const { createToken, verifyToken } = require('./_approval-token');
const { logAudit } = require('./_audit-log');

const sql = neon(process.env.DATABASE_URL);

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — "stay logged in"
const VERIFY_LINK_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours — plenty of time to check an inbox
const BCRYPT_ROUNDS = 12;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SITE_BASE = 'https://aerva.in';

// A bcrypt hash of a value nobody will ever type, used only so that a
// login attempt against a non-existent email still runs bcrypt.compare
// once, taking roughly the same time as a real check. Without this, a
// missing-account response would return noticeably faster than a
// wrong-password response, letting an attacker learn which emails have
// accounts just by measuring response time.
const DUMMY_HASH = '$2a$12$CwTycUXWue0Thq9StjUM0uJ8yqxbwmkQ.6qhg0OSyMH0RfaOOKKae';

function safeGuest(guest) {
  // Never send password_hash back to the client, under any circumstance.
  return { id: guest.id, email: guest.email, name: guest.name, phone: guest.phone, accountType: guest.account_type };
}

async function sendVerificationEmail(guest, verifyTok) {
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set — guest cannot receive their verification link.');
    throw new Error('Verification email could not be sent. Please try again shortly.');
  }

  const link = `${SITE_BASE}/guest-login.html?verify=${verifyTok}`;
  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">Confirm your email</h2>
      <p>Click below to verify your email and log in to your Aerva account. This link expires in 24 hours.</p>
      <p><a href="${link}" style="background:#1c1a17; color:#f4eadc; padding:12px 24px; text-decoration:none; display:inline-block;">Verify Email</a></p>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">If you didn't create an Aerva account, you can safely ignore this email.</p>
    </div>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Aerva <hello@aerva.in>',
      to: guest.email,
      subject: 'Confirm your Aerva account',
      html
    })
  });

  if (!res.ok) {
    let detail;
    try { detail = await res.json(); } catch { detail = { message: res.statusText }; }
    console.error('Resend send failed:', res.status, detail);

    // Only a 422 from Resend actually means "this recipient/request was
    // rejected" (e.g. malformed or undeliverable address) — that's the
    // one case worth blaming on what the guest typed. A 401 means OUR API
    // key is wrong; 403 usually means a domain/sending permission issue;
    // neither has anything to do with the email address itself, and
    // mislabeling them that way (an earlier version of this code did)
    // sends people on a wild goose chase checking their own typing for a
    // problem that's actually on our end.
    if (res.status === 422) {
      const err = new Error("That email address looks like it can't receive mail — double check it and try again.");
      err.isUserFacing = true;
      throw err;
    }
    throw new Error('Verification email could not be sent. Please try again shortly.');
  }
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ---- GET: either "verify this email link" or "check my session" ----
  if (req.method === 'GET') {
    // A query-string token means this is a click from the verification
    // email — distinct from the Authorization-header session check below.
    if (req.query.token) {
      const payload = verifyToken(req.query.token);
      if (!payload || payload.action !== 'guest-email-verify') {
        return res.status(400).json({ error: 'This verification link is invalid or has expired. Please request a new one.' });
      }
      try {
        const rows = await sql`
          UPDATE guests SET email_verified = TRUE WHERE id = ${payload.listingId}
          RETURNING id, email, name, phone, account_type
        `;
        const guest = rows[0];
        if (!guest) return res.status(404).json({ error: 'Account not found.' });

        const sessionToken = createToken(guest.id, 'guest-session', SESSION_LIFETIME_MS);
        await logAudit(sql, {
          action: 'guest_email_verified', success: true, actorType: 'guest', actorIdentifier: guest.email,
          targetType: 'guest', targetId: guest.id
        });
        return res.status(200).json({ sessionToken, guest: safeGuest(guest) });
      } catch (err) {
        console.error('guest-auth (verify) error:', err);
        return res.status(500).json({ error: 'Could not verify your email right now. Please try again.' });
      }
    }

    // Otherwise, this is the normal "is my stored session still valid" check.
    const authHeader = req.headers['authorization'] || '';
    const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const payload = sessionToken ? verifyToken(sessionToken) : null;

    if (!payload || payload.action !== 'guest-session') {
      return res.status(401).json({ error: 'Please log in again.' });
    }

    try {
      // Reuses the generically-named "listingId" field from
      // _approval-token.js — same pattern as host-auth.js, here it holds
      // a guest's id instead.
      const rows = await sql`SELECT id, email, name, phone, account_type FROM guests WHERE id = ${payload.listingId}`;
      const guest = rows[0];
      if (!guest) return res.status(401).json({ error: 'Please log in again.' });
      return res.status(200).json({ guest: safeGuest(guest) });
    } catch (err) {
      console.error('guest-auth (GET) error:', err);
      return res.status(500).json({ error: 'Could not verify your session.' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { mode, email, password, name, phone } = req.body || {};

  // ---- Resend a verification link ----
  if (mode === 'resend-verification') {
    if (!email || typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
      return res.status(400).json({ error: 'Please enter a complete email address, like you@gmail.com.' });
    }
    const cleanEmail = email.trim().toLowerCase();
    try {
      const rows = await sql`SELECT id, email, email_verified FROM guests WHERE email = ${cleanEmail}`;
      const guest = rows[0];
      // Deliberately the same success response whether or not the account
      // exists or is already verified — same reasoning as login's
      // identical error message, so this can't be used to probe which
      // emails are registered.
      if (guest && !guest.email_verified) {
        const verifyTok = createToken(guest.id, 'guest-email-verify', VERIFY_LINK_LIFETIME_MS);
        await sendVerificationEmail(guest, verifyTok);
        await logAudit(sql, {
          action: 'guest_verification_resent', success: true, actorType: 'guest', actorIdentifier: cleanEmail,
          targetType: 'guest', targetId: guest.id
        });
      }
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('guest-auth (resend-verification) error:', err);
      await logAudit(sql, {
        action: 'guest_verification_resent', success: false, actorType: 'guest', actorIdentifier: cleanEmail,
        metadata: { reason: 'server_error' }
      });
      // Still return success — see note above — but log the real failure.
      return res.status(200).json({ success: true });
    }
  }

  if (!email || typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
    return res.status(400).json({ error: 'Please enter a complete email address, like you@gmail.com.' });
  }
  const cleanEmail = email.trim().toLowerCase();

  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  // ---- Sign up ----
  if (mode === 'signup') {
    try {
      const existing = await sql`SELECT id FROM guests WHERE email = ${cleanEmail}`;
      if (existing[0]) {
        await logAudit(sql, {
          action: 'guest_signup', success: false, actorType: 'guest', actorIdentifier: cleanEmail,
          metadata: { reason: 'email_already_registered' }
        });
        return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const inserted = await sql`
        INSERT INTO guests (email, password_hash, name, phone, email_verified)
        VALUES (${cleanEmail}, ${passwordHash}, ${name || null}, ${phone || null}, FALSE)
        RETURNING id, email, name, phone, account_type
      `;
      const guest = inserted[0];

      const verifyTok = createToken(guest.id, 'guest-email-verify', VERIFY_LINK_LIFETIME_MS);
      try {
        await sendVerificationEmail(guest, verifyTok);
      } catch (emailErr) {
        console.error('guest-auth (signup) verification email failed:', emailErr);
        await logAudit(sql, {
          action: 'guest_signup', success: false, actorType: 'guest', actorIdentifier: cleanEmail,
          metadata: { reason: 'verification_email_failed' }
        });
        const message = emailErr.isUserFacing
          ? emailErr.message
          : 'Your account was created, but the verification email could not be sent. Please try "Resend verification email" in a moment.';
        return res.status(200).json({ success: true, requiresVerification: true, email: cleanEmail, warning: message });
      }

      await logAudit(sql, {
        action: 'guest_signup', success: true, actorType: 'guest', actorIdentifier: cleanEmail,
        targetType: 'guest', targetId: guest.id
      });

      // No session token here on purpose — the account isn't usable until
      // the guest clicks the verification link.
      return res.status(200).json({ success: true, requiresVerification: true, email: cleanEmail });
    } catch (err) {
      console.error('guest-auth (signup) error:', err);
      await logAudit(sql, {
        action: 'guest_signup', success: false, actorType: 'guest', actorIdentifier: cleanEmail,
        metadata: { reason: 'server_error' }
      });
      return res.status(500).json({ error: 'Could not create your account right now. Please try again.' });
    }
  }

  // ---- Log in ----
  if (mode === 'login') {
    try {
      const rows = await sql`SELECT id, email, password_hash, name, phone, email_verified, account_type FROM guests WHERE email = ${cleanEmail}`;
      const guest = rows[0];

      // Always run bcrypt.compare, even for a non-existent account — see
      // DUMMY_HASH above for why. This keeps response timing consistent
      // whether the email exists or not.
      const passwordMatches = await bcrypt.compare(password, guest ? guest.password_hash : DUMMY_HASH);

      if (!guest || !passwordMatches) {
        await logAudit(sql, {
          action: 'guest_login', success: false, actorType: 'guest', actorIdentifier: cleanEmail,
          metadata: { reason: !guest ? 'no_such_account' : 'wrong_password' }
        });
        // Deliberately the same message either way — never reveal
        // whether the email itself is registered.
        return res.status(401).json({ error: 'Incorrect email or password.' });
      }

      if (!guest.email_verified) {
        await logAudit(sql, {
          action: 'guest_login', success: false, actorType: 'guest', actorIdentifier: cleanEmail,
          metadata: { reason: 'email_not_verified' }
        });
        return res.status(403).json({
          error: 'Please verify your email before logging in — check your inbox for the link we sent.',
          requiresVerification: true
        });
      }

      const sessionToken = createToken(guest.id, 'guest-session', SESSION_LIFETIME_MS);
      await logAudit(sql, {
        action: 'guest_login', success: true, actorType: 'guest', actorIdentifier: cleanEmail,
        targetType: 'guest', targetId: guest.id
      });

      return res.status(200).json({ sessionToken, guest: safeGuest(guest) });
    } catch (err) {
      console.error('guest-auth (login) error:', err);
      await logAudit(sql, {
        action: 'guest_login', success: false, actorType: 'guest', actorIdentifier: cleanEmail,
        metadata: { reason: 'server_error' }
      });
      return res.status(500).json({ error: 'Could not log you in right now. Please try again.' });
    }
  }

  return res.status(400).json({ error: 'Invalid request. mode must be "signup", "login", or "resend-verification".' });
};
