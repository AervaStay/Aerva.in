// /api/verify-payment.js
// Confirms a payment is genuine before you treat a booking as paid.
// Razorpay signs every successful payment with your Key Secret — this function
// re-computes that signature server-side and checks it matches what the browser sent.
// Never trust a "payment succeeded" message from the browser alone.

const crypto = require('crypto');

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    const isValid = expectedSignature === razorpay_signature;

    if (!isValid) {
      // Someone sent a forged/tampered response — do not confirm the booking.
      return res.status(400).json({ verified: false });
    }

    // At this point the payment is confirmed genuine.
    // TODO: write the booking to your database / send confirmation email here.

    return res.status(200).json({ verified: true });
  } catch (err) {
    console.error('verify-payment error:', err);
    return res.status(500).json({ error: 'Verification failed' });
  }
};
