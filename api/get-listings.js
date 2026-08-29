// /api/get-listing-availability.js
// Powers the availability calendar on a listing's full detail page.
// Public and read-only, like get-listings.js — returns only which date
// ranges are already booked and paid for on this one listing, nothing
// about who booked them. No guest identity, no order details, just
// arrival/departure pairs a calendar can grey out.

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

// Normalizes a DATE column value to 'YYYY-MM-DD' whether the driver
// returns it as a JS Date object or an already-formatted string — same
// helper used in create-order.js for the same reason.
function toDateStr(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0];
  return String(val).slice(0, 10);
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const listingId = Number(req.query.listingId);
  if (!listingId) {
    return res.status(400).json({ error: 'Missing or invalid listingId' });
  }

  try {
    // Only confirmed, paid bookings block the calendar — a listing that
    // was never approved or has no paid bookings simply comes back with
    // an empty range list, not an error, so the calendar just renders as
    // fully open.
    const rows = await sql`
      SELECT arrival, departure FROM orders
      WHERE listing_id = ${listingId} AND status = 'paid'
      ORDER BY arrival ASC
    `;
    const bookedRanges = rows.map(r => ({
      arrival: toDateStr(r.arrival),
      departure: toDateStr(r.departure),
    }));

    return res.status(200).json({ bookedRanges });
  } catch (err) {
    console.error('get-listing-availability error:', err);
    return res.status(500).json({ error: 'Could not load availability' });
  }
};
