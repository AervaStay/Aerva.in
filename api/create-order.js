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
const { verifyToken } = require('./_approval-token');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
const sql = neon(process.env.DATABASE_URL);

const EXTRA_GUEST_RATE = 1500;
const BASE_OCCUPANCY = 2;
const GST_RATE = 0.12;
const MAX_STAYS = 5; // matches the frontend cap — reject anything absurd
const MAX_AMENITIES_PER_STAY = 15;

function calculateNights(arrival, departure) {
  const arrivalDate = new Date(arrival);
  const departureDate = new Date(departure);
  return Math.round((departureDate - arrivalDate) / (1000 * 60 * 60 * 24));
}

// Every night of a stay as 'YYYY-MM-DD' strings: arrival up to (not
// including) departure — the same convention calculateNights already
// implies (departure is checkout day, not a night stayed).
function getNightsInRange(arrival, departure) {
  const nights = [];
  let d = new Date(arrival);
  const end = new Date(departure);
  while (d < end) {
    nights.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return nights;
}

// Normalizes a DATE column value to 'YYYY-MM-DD' whether the driver
// returns it as a JS Date object or an already-formatted string — safer
// than assuming one or the other for something this payment-critical.
function toDateStr(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0];
  return String(val).slice(0, 10);
}

// Re-fetches and re-validates every selected paid amenity fresh from the
// database — never trusts price, name, or availability from the browser.
// Returns { amenityTotal, amenityDetails, error }. On any invalid
// selection (wrong listing, inactive, a date outside the amenity's
// availability window, or a date outside the stay itself), returns an
// error rather than silently dropping it — a payment total should never
// change quietly out from under what the guest actually selected.
async function validateAndPriceAmenities(sql, listingId, arrival, departure, requested) {
  if (!Array.isArray(requested) || requested.length === 0) {
    return { amenityTotal: 0, amenityDetails: [] };
  }
  if (requested.length > MAX_AMENITIES_PER_STAY) {
    return { error: 'Too many amenities selected for one stay.' };
  }

  const stayNights = new Set(getNightsInRange(arrival, departure));
  const amenityDetails = [];
  let amenityTotal = 0;

  for (const req of requested) {
    const amenityId = Number(req.amenityId);
    const dates = Array.isArray(req.dates) ? [...new Set(req.dates)] : [];
    if (!amenityId || dates.length === 0) continue;

    const rows = await sql`
      SELECT id, name, price, available_from, available_until
      FROM listing_amenities
      WHERE id = ${amenityId} AND listing_id = ${listingId} AND is_active = TRUE
    `;
    const amenity = rows[0];
    if (!amenity) {
      return { error: `One of the selected amenities is no longer available. Please refresh and try again.` };
    }

    for (const date of dates) {
      if (!stayNights.has(date)) {
        return { error: `${amenity.name}: selected date ${date} isn't part of this stay.` };
      }
      if (amenity.available_from && date < toDateStr(amenity.available_from)) {
        return { error: `${amenity.name} isn't available on ${date}.` };
      }
      if (amenity.available_until && date > toDateStr(amenity.available_until)) {
        return { error: `${amenity.name} isn't available on ${date}.` };
      }
    }

    const price = Number(amenity.price);
    const total = price * dates.length;
    amenityTotal += total;
    amenityDetails.push({ id: amenity.id, name: amenity.name, pricePerNight: price, dates, total });
  }

  return { amenityTotal, amenityDetails };
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

// A logged-in guest booking is optional, not required — Aerva still
// supports guest checkout without an account. If a valid guest session
// token is present, its id rides along in the Razorpay order's notes so
// verify-payment.js can link the eventual order row back to the account;
// if it's missing, expired, or invalid, booking proceeds exactly as
// before, just without that link.
function getOptionalGuestId(req) {
  const authHeader = req.headers['authorization'] || '';
  const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!sessionToken) return null;
  const payload = verifyToken(sessionToken);
  if (!payload || payload.action !== 'guest-session') return null;
  return payload.listingId; // generically-named token field — see host-auth.js note; here it's the guest's id
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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

    const guestId = getOptionalGuestId(req);

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

      // Amenities are priced fresh from the database and are never
      // discounted — the discount applies to the room rate only, not to
      // optional add-ons chosen on top of it.
      const { amenityTotal, amenityDetails, error: amenityError } = await validateAndPriceAmenities(
        sql, listing.id, s.arrival, s.departure, s.selectedAmenities
      );
      if (amenityError) {
        return res.status(400).json({ error: `Stay ${i + 1}: ${amenityError}` });
      }

      const staySubtotal = beforeDiscount - discountAmount + amenityTotal;

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
        amenities: amenityDetails,
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
        guestId: guestId || '',
        stayCount: stays.length,
        // Razorpay notes have a size limit we haven't hit in practice yet,
        // but amenities make this payload meaningfully bigger than before
        // — if bookings with several amenities/dates start failing here,
        // this is the first place to check (may need a shorter encoding,
        // or storing full details in our own DB keyed by a short token
        // instead of putting everything in Razorpay's notes directly).
        stays: JSON.stringify(stayDetails).slice(0, 4000),
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
