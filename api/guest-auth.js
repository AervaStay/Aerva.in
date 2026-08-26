// /api/guest-auth.js
// Email + password accounts for guests — separate from the passwordless
// magic-link login hosts use (host-auth.js). Session tokens use the same
// signed-token approach as hosts (see _approval-token.js): a guest's
// browser stores a signed session token, never their actual password.
//
//   POST { mode: 'signup', email, password, name?, phone? }
//     Creates a new guest account. The password is hashed with bcrypt
//     before it ever touches the database or a log line — the raw
//     password itself is never stored anywhere.
//
//   POST { mode: 'login', email, password }
//     Verifies credentials, returns a 30-day session token.
//
//   GET  (Authorization: Bearer <sessionToken>)
//     Verifies an existing session token is still valid. Called on page
//     load so a returning guest with a stored token gets logged in
//     automatically, without typing their password again — this is what
//     "remembered in the browser" means here. The token itself is the
//     only thing that ever lives in the browser; never the password.

const bcrypt = require('bcryptjs');
const { neon } = require('@neondatabase/serverless');
const { createToken, verifyToken } = require('./_approval-token');
const { logAudit } = require('./_audit-log');

const sql = neon(process.env.DATABASE_URL);

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — "stay logged in"
const BCRYPT_ROUNDS = 12;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A bcrypt hash of a value nobody will ever type, used only so that a
// login attempt against a non-existent email still runs bcrypt.compare
// once, taking roughly the same time as a real check. Without this, a
// missing-account response would return noticeably faster than a
// wrong-password response, letting an attacker learn which emails have
// accounts just by measuring response time.
const DUMMY_HASH = '$2a$12$CwTycUXWue0Thq9StjUM0uJ8yqxbwmkQ.6qhg0OSyMH0RfaOOKKae';

function safeGuest(guest) {
  // Never send password_hash back to the client, under any circumstance.
  return { id: guest.id, email: guest.email, name: guest.name, phone: guest.phone };
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ---- Auto-login: verify an existing session token ----
  if (req.method === 'GET') {
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
      const rows = await sql`SELECT id, email, name, phone FROM guests WHERE id = ${payload.listingId}`;
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
        INSERT INTO guests (email, password_hash, name, phone)
        VALUES (${cleanEmail}, ${passwordHash}, ${name || null}, ${phone || null})
        RETURNING id, email, name, phone
      `;
      const guest = inserted[0];
      const sessionToken = createToken(guest.id, 'guest-session', SESSION_LIFETIME_MS);

      await logAudit(sql, {
        action: 'guest_signup', success: true, actorType: 'guest', actorIdentifier: cleanEmail,
        targetType: 'guest', targetId: guest.id
      });

      return res.status(200).json({ sessionToken, guest: safeGuest(guest) });
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
      const rows = await sql`SELECT id, email, password_hash, name, phone FROM guests WHERE email = ${cleanEmail}`;
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

  return res.status(400).json({ error: 'Invalid request. mode must be "signup" or "login".' });
};
