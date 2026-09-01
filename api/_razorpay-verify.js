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
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  return expectedSignature === razorpay_signature;
}

module.exports = { verifyRazorpaySignature };
