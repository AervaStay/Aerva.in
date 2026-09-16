// /api/_approval-token.js
// Shared by submit-listing.js (creates tokens for email links) and
// approve-listing.js (verifies them). Not an API endpoint itself.
//
// A token is stateless: no database row to track it, no "used" flag to
// manage. It's a signed, expiring instruction — "approve listing 42" —
// verified with HMAC-SHA256, the same pattern used to verify Razorpay's
// payment signatures elsewhere in this backend.

const crypto = require('crypto');

const SECRET = process.env.APPROVAL_TOKEN_SECRET;
const TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — default, used by approve/reject links

function createToken(listingId, action, lifetimeMs = TOKEN_LIFETIME_MS) {
  if (!SECRET) {
    // This is the exact failure that used to surface as a cryptic
    // "key argument must be of type string..." error — logging it
    // explicitly here makes the real cause obvious in Vercel's logs
    // instead of a generic crypto internals message.
    throw new Error('APPROVAL_TOKEN_SECRET environment variable is not set in Vercel.');
  }
  const payload = { listingId, action, exp: Date.now() + lifetimeMs };
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET).update(payloadStr).digest('base64url');
  return `${payloadStr}.${signature}`;
}

// Returns null for anything that is not a valid, unexpired token — and
// that includes "cannot check at all". Every caller already treats null
// as "not signed in", so a missing secret now logs people out cleanly
// instead of crashing every authenticated request with a 500. Logged on
// each call so the real cause is unmissable in Vercel's logs.
function verifyToken(token) {
  if (!SECRET) {
    console.error('APPROVAL_TOKEN_SECRET environment variable is not set in Vercel — every token is being rejected.');
    return null;
  }
  const [payloadStr, signature] = String(token).split('.');
  if (!payloadStr || !signature) return null;

  const expectedSignature = crypto.createHmac('sha256', SECRET).update(payloadStr).digest('base64url');

  // Constant-time comparison — avoids leaking timing information about
  // how much of the signature matched, same reasoning as payment verification.
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (sigBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return null;

  // Only reachable with a correct signature, so in practice this is only
  // ever our own JSON — guarded anyway, since a parse error here would be
  // another way for a token check to become a 500.
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString());
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null; // expired or malformed

  return payload; // { listingId, action, exp }
}

module.exports = { createToken, verifyToken };
