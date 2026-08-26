// /api/host-auth.js
// Passwordless login for hosts.
//
//   POST { email, name?, phone? }  — finds or creates a host account by
//                                    email, emails them a short-lived (15
//                                    min) login link pointing back to
//                                    host-login.html on the frontend.
//
//   GET  ?token=...                — called by host-login.html after the
//                                    host clicks that email link. Verifies
//                                    the short-lived token and exchanges it
//                                    for a longer-lived (30 day) session
//                                    token, which the frontend stores in
//                                    localStorage — see the architecture
//                                    note in README about why it's
//                                    localStorage and not an httpOnly
//                                    cookie (frontend and API are on
//                                    different domains).

const { neon } = require('@neondatabase/serverless');
const { createToken, verifyToken } = require('./_approval-token');

const sql = neon(process.env.DATABASE_URL);

const SITE_BASE = 'https://aerva.in';
const LOGIN_LINK_LIFETIME_MS = 15 * 60 * 1000; // 15 minutes — this is a one-time login step
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — how long a host stays logged in

async function sendLoginEmail(host, verifyToken) {
  if (!process.env.RESEND_API_KEY) {
    // Unlike the admin notification email, this ISN'T optional — without
    // it, a host has no way to actually receive their login link. Logged
    // clearly so it's easy to spot in Vercel's logs if login stops working.
    console.error('RESEND_API_KEY not set — host cannot receive their login link.');
    throw new Error('Login email could not be sent. Please try again shortly.');
  }

  const link = `${SITE_BASE}/host-login.html?verify=${verifyToken}`;
  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">Log in to Aerva</h2>
      <p>Click below to log in to your host account. This link expires in 15 minutes and can only be used once.</p>
      <p><a href="${link}" style="background:#1c1a17; color:#f4eadc; padding:12px 24px; text-decoration:none; display:inline-block;">Log In</a></p>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">If you didn't request this, you can safely ignore this email.</p>
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
      to: host.email,
      subject: 'Your Aerva login link',
      html
    })
  });

  if (!res.ok) {
    // Resend returns a JSON body describing exactly what went wrong —
    // invalid recipient, unverified domain, bad API key, rate limit, etc.
    // Always log the real body so this doesn't need to be re-diagnosed
    // from scratch every time. res.json() can itself fail if Resend
    // returns a non-JSON error page, so fall back to status text.
    let detail;
    try {
      detail = await res.json();
    } catch {
      detail = { message: res.statusText };
    }
    console.error('Resend send failed:', res.status, detail);

    // A 4xx here almost always means Resend rejected the request itself
    // (e.g. "invalid_email" or an undeliverable domain for the recipient)
    // — retrying won't help until the address is fixed, so say so
    // plainly instead of telling the host to "try again." A 5xx (or
    // anything else) is Resend's side acting up — that's the one case
    // where retrying might actually work.
    if (res.status >= 400 && res.status < 500) {
      const err = new Error("That email address looks like it can't receive mail — double check it and try again.");
      err.isUserFacing = true;
      throw err;
    }
    throw new Error('Login email could not be sent. Please try again shortly.');
  }
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ---- Request a login link ----
  if (req.method === 'POST') {
    try {
      const { email, name, phone } = req.body;
      // Requires something@something.something — catches the common
      // mistakes: no "@", or a domain with no dot/TLD (e.g. "name@gmail"
      // instead of "name@gmail.com"). Not a full RFC-5322 validator, but
      // enough to reject obviously malformed addresses before we try to
      // email anyone.
      const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!email || typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
        return res.status(400).json({ error: 'Please enter a complete email address, like you@gmail.com.' });
      }
      const cleanEmail = email.trim().toLowerCase();

      // Find or create — a returning host just logs in; a new one gets an
      // account created on the spot, no separate "sign up" step needed.
      let rows = await sql`SELECT id, email FROM hosts WHERE email = ${cleanEmail}`;
      let host = rows[0];
      if (!host) {
        const inserted = await sql`
          INSERT INTO hosts (email, name, phone) VALUES (${cleanEmail}, ${name || null}, ${phone || null})
          RETURNING id, email
        `;
        host = inserted[0];
      }

      const verifyTok = createToken(host.id, 'host-login-verify', LOGIN_LINK_LIFETIME_MS);
      await sendLoginEmail(host, verifyTok);

      return res.status(200).json({ success: true });
    } catch (err) {
      // Full detail goes to Vercel's logs for us to debug — never the raw
      // error text to whoever's trying to log in. The one exception is
      // sendLoginEmail's isUserFacing errors: those messages are already
      // written to be shown directly (e.g. "that email looks wrong"),
      // as opposed to leaking internals like API keys or stack traces.
      console.error('host-auth (POST) error:', err);
      if (err.isUserFacing) {
        return res.status(400).json({ error: err.message });
      }
      return res.status(500).json({ error: 'Could not send your login link right now. Please try again in a moment.' });
    }
  }

  // ---- Verify a login link, issue a session token ----
  if (req.method === 'GET') {
    const payload = verifyToken(req.query.token);
    if (!payload || payload.action !== 'host-login-verify') {
      return res.status(400).json({ error: 'This login link is invalid or has expired. Please request a new one.' });
    }

    try {
      // Note: _approval-token.js's payload field is generically named
      // "listingId" since it was built for listing-approval tokens first —
      // here it actually holds a host's id. Functionally identical either way.
      const rows = await sql`SELECT id, email, name FROM hosts WHERE id = ${payload.listingId}`;
      const host = rows[0];
      if (!host) return res.status(404).json({ error: 'Account not found.' });

      const sessionToken = createToken(host.id, 'host-session', SESSION_LIFETIME_MS);
      return res.status(200).json({ sessionToken, hostId: host.id, hostEmail: host.email, hostName: host.name });
    } catch (err) {
      console.error('host-auth (GET) error:', err);
      return res.status(500).json({ error: 'Could not verify login link.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
