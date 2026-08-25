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
  const payload = { listingId, action, exp: Date.now() + lifetimeMs };
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET).update(payloadStr).digest('base64url');
  return `${payloadStr}.${signature}`;
}

function verifyToken(token) {
  const [payloadStr, signature] = String(token).split('.');
  if (!payloadStr || !signature) return null;

  const expectedSignature = crypto.createHmac('sha256', SECRET).update(payloadStr).digest('base64url');

  // Constant-time comparison — avoids leaking timing information about
  // how much of the signature matched, same reasoning as payment verification.
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (sigBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return null;

  const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString());
  if (Date.now() > payload.exp) return null; // expired

  return payload; // { listingId, action, exp }
}

module.exports = { createToken, verifyToken };
