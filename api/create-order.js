// /api/create-order.js
// Deploy target: Vercel (or Netlify Functions with minor adjustments — see README below)
//
// This runs server-side only. Your Razorpay Key Secret NEVER reaches the browser.
// The browser only ever sees the public Key ID and the order_id this function returns.

const Razorpay = require('razorpay');

// Read from environment variables — set these in your hosting dashboard,
// NEVER hard-code them in this file or commit them to GitHub.
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Server-side source of truth for pricing — mirrors the site's display logic,
// but is recalculated here so a tampered browser request can't change the amount.
const NIGHTLY_RATE = 3500;
const EXTRA_GUEST_RATE = 1500;
const BASE_OCCUPANCY = 2;
const GST_RATE = 0.12;

function calculateTotal(arrival, departure, guests) {
  const arrivalDate = new Date(arrival);
  const departureDate = new Date(departure);
  const nights = Math.round((departureDate - arrivalDate) / (1000 * 60 * 60 * 24));

  if (!nights || nights <= 0) return null;
  if (!guests || guests < 1) return null;

  const roomTotal = NIGHTLY_RATE * nights;
  const extraGuests = Math.max(guests - BASE_OCCUPANCY, 0);
  const extraTotal = extraGuests * EXTRA_GUEST_RATE * nights;
  const subtotal = roomTotal + extraTotal;
  const gst = Math.round(subtotal * GST_RATE);
  return subtotal + gst; // rupees
}

module.exports = async (req, res) => {
  // Basic CORS lockdown — only allow requests from your own domain.
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { arrival, departure, guests, suite, email } = req.body;

    // Reject obviously malformed input before touching Razorpay.
    if (!arrival || !departure || !guests || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const totalRupees = calculateTotal(arrival, departure, Number(guests));
    if (!totalRupees) {
      return res.status(400).json({ error: 'Invalid dates or guest count' });
    }

    const order = await razorpay.orders.create({
      amount: totalRupees * 100, // paise
      currency: 'INR',
      receipt: `aerva_${Date.now()}`,
      notes: { suite: suite || 'Not specified', email, arrival, departure, guests },
    });

    // Only send back what the browser needs — never the secret.
    return res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (err) {
    console.error('create-order error:', err);
    return res.status(500).json({ error: 'Could not create order' });
  }
};
