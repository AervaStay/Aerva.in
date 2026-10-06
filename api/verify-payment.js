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

    // The booking's confirmation code(s), shown on the page straight away:
    // [{ item, code }]. A repeat call reads them back from the booking.
    const codesFor = async () => {
      try {
        return (await sql`SELECT suite_name, confirmation_code FROM orders
                          WHERE razorpay_order_id = ${razorpay_order_id} AND status = 'paid' AND confirmation_code IS NOT NULL ORDER BY id`)
          .map(r => ({ item: r.suite_name, code: r.confirmation_code }));
      } catch (err) { return []; }
    };
    // What the page shows on its "Booking confirmed" screen: each booking
    // in this payment, and what was paid. Only ever for a payment whose
    // Razorpay signature checked out above.
    const summaryFor = async () => {
      try {
        const rows = await sql`
          SELECT o.id, o.suite_name, o.arrival, o.departure, o.nights, o.guests, o.confirmation_code, o.guest_email,
                 o.listing_id, l.listing_type, l.check_in_time, l.check_out_time, l.city
          FROM orders o LEFT JOIN listings l ON l.id = o.listing_id
          WHERE o.razorpay_order_id = ${razorpay_order_id} AND o.status = 'paid' ORDER BY o.id`;
        let paid = null, currency = 'INR', method = null;
        try {
          const p = await razorpay.payments.fetch(razorpay_payment_id);
          paid = Number(p.amount) / 100; currency = p.currency || 'INR'; method = p.method || null;
        } catch (e) { /* the summary still shows, without the amount */ }
        // A DATE column comes back as midnight in the server's own time zone:
        // read it back the same way, never through UTC (which can shift a day).
        const day = (d) => {
          if (!d) return null;
          if (typeof d === 'string') return d.slice(0, 10);
          const pad = (n) => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        };
        return {
          email: rows[0] ? rows[0].guest_email : null,
          paid, currency, method, paymentId: razorpay_payment_id,
          items: rows.map(r => ({
            orderId: r.id, name: r.suite_name, arrival: day(r.arrival), departure: day(r.departure),
            nights: Number(r.nights) || null, guests: Number(r.guests) || null, code: r.confirmation_code || null,
            experience: r.listing_type === 'experience', city: r.city || null,
            checkIn: r.check_in_time || null, checkOut: r.check_out_time || null
          }))
        };
      } catch (err) { console.error('booking summary failed:', err.message); return null; }
    };
    switch (result.status) {
      case 'confirmed': return res.status(200).json({ verified: true, confirmationCodes: result.confirmationCodes || [], summary: await summaryFor() });
      case 'duplicate': {
        // Already recorded — by an earlier call, or by the reconcile job.
        const codes = await codesFor();
        return res.status(200).json({ verified: true, alreadyConfirmed: true, confirmationCodes: codes, summary: await summaryFor() });
      }
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
