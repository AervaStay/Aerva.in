// /api/create-order.js
// Deploy target: Vercel (or Netlify Functions with minor adjustments — see README below)
//
// This runs server-side only. Your Razorpay Key Secret NEVER reaches the browser.
// The browser only ever sees the public Key ID and the order_id this function returns.
//
// Pricing is now driven entirely by each listing's own row in the database —
// nightly_rate, discount_type/value/min_nights, commission_rate — never by
// anything the browser sends. This mirrors the frontend's own calculation,
// but is the actual source of truth: a tampered browser request can change
// what it *displays*, never what it's actually charged.

const Razorpay = require('razorpay');
const { neon } = require('@neondatabase/serverless');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
const sql = neon(process.env.DATABASE_URL);

const EXTRA_GUEST_RATE = 1500;
const BASE_OCCUPANCY = 2;
const GST_RATE = 0.12;
const MAX_STAYS = 5; // matches the frontend cap — reject anything absurd

function calculateNights(arrival, departure) {
  const arrivalDate = new Date(arrival);
  const departureDate = new Date(departure);
  return Math.round((departureDate - arrivalDate) / (1000 * 60 * 60 * 24));
}

function calculateDiscount(listing, nights, subtotalBeforeDiscount) {
  if (!listing.discount_type || !listing.discount_value) return 0;
  if (listing.discount_min_nights && nights < listing.discount_min_nights) return 0;
  if (listing.discount_type === 'percentage') {
    return Math.round(subtotalBeforeDiscount * (Number(listing.discount_value) / 100));
  }
  if (listing.discount_type === 'flat') {
    return Math.min(Number(listing.discount_value), subtotalBeforeDiscount);
  }
  return 0;
}

module.exports = async (req, res) => {
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

    let grandSubtotal = 0;
    let grandDiscount = 0;
    const stayDetails = [];
    const seenListingIds = new Set();

    for (let i = 0; i < stays.length; i++) {
      const s = stays[i];
      if (!s.listingId || !s.arrival || !s.departure || !s.guests) {
        return res.status(400).json({ error: `Stay ${i + 1}: missing home selection, dates, or guest count` });
      }

      // Each property can only appear once per booking request.
      if (seenListingIds.has(s.listingId)) {
        return res.status(400).json({ error: `Stay ${i + 1} repeats a home already used in this request.` });
      }
      seenListingIds.add(s.listingId);

      // The listing is looked up fresh from the database — this is the
      // "validate against what the owner actually shared" step. A listing
      // that's been rejected, deleted, or never approved can't be booked,
      // no matter what the browser sends.
      const rows = await sql`
        SELECT id, property_name, nightly_rate, discount_type, discount_value,
               discount_min_nights, commission_rate
        FROM listings
        WHERE id = ${s.listingId} AND status = 'approved'
      `;
      const listing = rows[0];
      if (!listing) {
        return res.status(400).json({ error: `Stay ${i + 1}: this home is no longer available to book.` });
      }
      if (!listing.nightly_rate) {
        return res.status(400).json({ error: `Stay ${i + 1}: ${listing.property_name} doesn't have a rate set yet.` });
      }

      const nights = calculateNights(s.arrival, s.departure);
      const guests = Number(s.guests);
      if (!nights || nights <= 0 || !guests || guests < 1) {
        return res.status(400).json({ error: `Stay ${i + 1}: invalid dates or guest count` });
      }

      const rate = Number(listing.nightly_rate);
      const roomTotal = rate * nights;
      const extraGuests = Math.max(guests - BASE_OCCUPANCY, 0);
      const extraTotal = extraGuests * EXTRA_GUEST_RATE * nights;
      const beforeDiscount = roomTotal + extraTotal;
      const discountAmount = calculateDiscount(listing, nights, beforeDiscount);
      const staySubtotal = beforeDiscount - discountAmount;

      grandSubtotal += staySubtotal;
      grandDiscount += discountAmount;

      stayDetails.push({
        listingId: listing.id,
        suite: listing.property_name,
        arrival: s.arrival,
        departure: s.departure,
        guests,
        nights,
        subtotal: staySubtotal,
        discountAmount,
        commissionRate: Number(listing.commission_rate),
      });
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
