// /api/verify-payment.js
// Confirms a payment is genuine before a booking is treated as paid.
//
// The browser posts Razorpay's { razorpay_order_id, razorpay_payment_id,
// razorpay_signature } here right after paying. The signature is
// re-computed server-side with the Key Secret — a forged or tampered
// response is refused. Everything after that (asking Razorpay about the
// payment itself, re-checking the dates and coupon, writing the order
// rows, deposits, co-host shares, emails) lives in _confirm-booking.js,
// shared with the payment_reconcile job that records payments whose
// browser never came back.
//
// Security deposit lifecycle (see orders.deposit_status):
//   'held'     — set when payment is confirmed; released 7 days after
//                departure unless the host raises a concern.
//   'disputed' — host-listings.js raiseDispute.
//   'refunded' — _deposits.js (scheduler / admin).
//   'resolved' — admin resolves a dispute (get-pending-listings.js).

const { verifyRazorpaySignature } = require('./_razorpay-verify');
const Razorpay = require('razorpay');
const { neon } = require('@neondatabase/serverless');
const { confirmBooking } = require('./_confirm-booking');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
const sql = neon(process.env.DATABASE_URL);

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details' });
    }
    if (!verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      // A forged or tampered response — never confirm the booking.
      return res.status(400).json({ verified: false });
    }

    const result = await confirmBooking(sql, razorpay, {
      razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id, source: 'browser'
    });

    switch (result.status) {
      case 'confirmed': return res.status(200).json({ verified: true });
      case 'duplicate': return res.status(200).json({ verified: true, alreadyConfirmed: true });
      // Dates or coupon taken by another payment: nothing is booked and
      // the guest is refunded in full. `message` is what the page shows.
      case 'conflict': return res.status(200).json({ verified: false, refunded: true, message: result.message });
      // Payment not settled yet, or a temporary problem: nothing written,
      // and the payment_reconcile job finishes it within minutes.
      case 'pending':
      case 'error':
      default:
        return res.status(200).json({
          verified: false, pending: true,
          message: result.userMessage || 'Your payment was received. We are still confirming your booking — you will get an email within a few minutes. Please do not pay again.'
        });
    }
  } catch (err) {
    console.error('verify-payment error:', err);
    return res.status(500).json({ error: 'Verification failed' });
  }
};
