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
const MAX_STAYS = 5; // matches the frontend cap — reject anything absurd

function calculateStaySubtotal(arrival, departure, guests) {
  const arrivalDate = new Date(arrival);
  const departureDate = new Date(departure);
  const nights = Math.round((departureDate - arrivalDate) / (1000 * 60 * 60 * 24));

  if (!nights || nights <= 0) return null;
  if (!guests || guests < 1) return null;

  const roomTotal = NIGHTLY_RATE * nights;
  const extraGuests = Math.max(guests - BASE_OCCUPANCY, 0);
  const extraTotal = extraGuests * EXTRA_GUEST_RATE * nights;
  return { nights, subtotal: roomTotal + extraTotal };
}

function datesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
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
    const { stays, email } = req.body;

    if (!email || !Array.isArray(stays) || stays.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (stays.length > MAX_STAYS) {
      return res.status(400).json({ error: 'Too many stays in one request' });
    }

    // Recalculate every stay's subtotal server-side — never trust a total
    // the browser sends. Also re-check for the guest self-overlap rule,
    // since a tampered request could skip the frontend validation entirely.
    let grandSubtotal = 0;
    const stayDetails = [];

    for (let i = 0; i < stays.length; i++) {
      const s = stays[i];
      if (!s.arrival || !s.departure || !s.guests) {
        return res.status(400).json({ error: `Stay ${i + 1}: missing dates or guest count` });
      }

      const result = calculateStaySubtotal(s.arrival, s.departure, Number(s.guests));
      if (!result) {
        return res.status(400).json({ error: `Stay ${i + 1}: invalid dates or guest count` });
      }

      // Same-guest double-booking check (same rule as the frontend) —
      // this is NOT a check against other guests' bookings. See README:
      // that requires a real booking calendar/database, not yet wired up.
      for (let j = 0; j < i; j++) {
        const other = stays[j];
        if (
          other.suite === s.suite &&
          s.suite !== 'Not sure yet' &&
          datesOverlap(s.arrival, s.departure, other.arrival, other.departure)
        ) {
          return res.status(400).json({
            error: `Stay ${i + 1} overlaps with Stay ${j + 1} — same home, overlapping dates.`,
          });
        }
      }

      grandSubtotal += result.subtotal;
      stayDetails.push({ suite: s.suite, arrival: s.arrival, departure: s.departure, guests: s.guests, nights: result.nights, subtotal: result.subtotal });
    }

    const gst = Math.round(grandSubtotal * GST_RATE);
    const totalRupees = grandSubtotal + gst;

    const order = await razorpay.orders.create({
      amount: totalRupees * 100, // paise
      currency: 'INR',
      receipt: `aerva_${Date.now()}`,
      notes: {
        email,
        stayCount: stays.length,
        // Razorpay notes have a length limit — keep this compact.
        stays: JSON.stringify(stayDetails).slice(0, 2000),
      },
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
