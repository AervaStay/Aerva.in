// /api/verify-payment.js
// Confirms a payment is genuine before you treat a booking as paid.
// Razorpay signs every successful payment with your Key Secret — this function
// re-computes that signature server-side and checks it matches what the browser sent.
// Never trust a "payment succeeded" message from the browser alone.
//
// Once verified, this also writes one row per stay into the `orders` table —
// pulling the trusted stay/email details back from Razorpay's own order
// record (via order.notes), not from anything the browser sends here, so a
// tampered request can't fake what got booked or at what price.

const crypto = require('crypto');
const Razorpay = require('razorpay');
const { neon } = require('@neondatabase/serverless');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
const sql = neon(process.env.DATABASE_URL);

// Same platform-set commission used for new listing submissions. Kept only
// as a fallback for orders that predate real listing_id/commissionRate data
// (e.g. anything booked before this update shipped) — every new order now
// uses the specific listing's own commission_rate, passed through from
// create-order.js via the Razorpay order notes.
const FALLBACK_COMMISSION_RATE = 15;

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

    // Payment is genuine. Pull the trusted stay details back from Razorpay's
    // own order record — this is what create-order.js stored in `notes`
    // when the order was created, server-side, before any payment happened.
    try {
      const order = await razorpay.orders.fetch(razorpay_order_id);
      const email = order.notes?.email;
      const stays = order.notes?.stays ? JSON.parse(order.notes.stays) : [];

      for (const stay of stays) {
        const gstShare = Math.round((stay.subtotal / stays.reduce((sum, s) => sum + s.subtotal, 0)) *
          (order.amount / 100 - stays.reduce((sum, s) => sum + s.subtotal, 0)));
        const stayTotal = stay.subtotal + gstShare;
        const commissionRate = stay.commissionRate != null ? Number(stay.commissionRate) : FALLBACK_COMMISSION_RATE;
        const commissionAmount = Math.round(stayTotal * (commissionRate / 100));
        const payoutAmount = stayTotal - commissionAmount;

        await sql`
          INSERT INTO orders (
            suite_name, listing_id, guest_email, arrival, departure, guests, nights,
            subtotal, discount_amount, gst, total,
            commission_rate, commission_amount, payout_amount,
            razorpay_order_id, razorpay_payment_id, status
          ) VALUES (
            ${stay.suite}, ${stay.listingId || null}, ${email}, ${stay.arrival}, ${stay.departure}, ${stay.guests}, ${stay.nights},
            ${stay.subtotal}, ${stay.discountAmount || 0}, ${gstShare}, ${stayTotal},
            ${commissionRate}, ${commissionAmount}, ${payoutAmount},
            ${razorpay_order_id}, ${razorpay_payment_id}, 'paid'
          )
        `;
      }
    } catch (dbErr) {
      // A booking that's paid-for but not logged to `orders` is recoverable
      // (the payment itself is safely recorded in Razorpay's own dashboard).
      // Don't fail the guest's confirmation over a logging problem.
      console.error('Could not write order(s) to database:', dbErr);
    }

    return res.status(200).json({ verified: true });
  } catch (err) {
    console.error('verify-payment error:', err);
    return res.status(500).json({ error: 'Verification failed' });
  }
};
