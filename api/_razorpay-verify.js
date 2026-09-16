// /api/_razorpay-verify.js
// Verifies a Razorpay payment signature is genuine — the same HMAC check
// Razorpay's own docs specify. Not an API endpoint itself (the leading
// underscore tells Vercel that, same convention as _approval-token.js).
//
// Never trust a "payment succeeded" message from the browser alone —
// this recomputes the signature server-side using your Key Secret and
// confirms it matches what the browser sent.

const crypto = require('crypto');

function verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature) {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return false;
  // A missing secret is a deploy misconfiguration, not a bad payment —
  // but either way nothing can be verified, so the answer is "not valid"
  // rather than a crypto exception surfacing as a bare 500. Logged loudly
  // so it is obvious in Vercel's logs why every payment is being refused.
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    console.error('RAZORPAY_KEY_SECRET is not set in Vercel — payment signatures cannot be verified, so every payment is being rejected.');
    return false;
  }
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  // Constant-time comparison, same as _approval-token.js. timingSafeEqual
  // throws on unequal lengths, so a length mismatch is rejected first —
  // the length of a hex SHA-256 digest is public anyway (always 64).
  const got = Buffer.from(String(razorpay_signature));
  const want = Buffer.from(expectedSignature);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

module.exports = { verifyRazorpaySignature };
