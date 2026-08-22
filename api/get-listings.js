// /api/get-listings.js
// Returns all APPROVED listings as JSON. This is read-only and safe to call
// publicly — it never exposes pending/rejected submissions or host contact
// details beyond what's meant to be shown on the live site. Also never
// exposes commission_rate — that's internal, not guest-facing.
//
// Now wired into the Suites section and Reserve form (see Steps 2-3) —
// includes discount fields so the site can calculate and display offers.

const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const listings = await sql`
      SELECT
        id, property_name, city, property_type, bedrooms, max_guests,
        nightly_rate, description, amenities, services,
        discount_type, discount_value, discount_min_nights, discount_description,
        created_at
      FROM listings
      WHERE status = 'approved'
      ORDER BY created_at DESC
    `;

    return res.status(200).json({ listings });
  } catch (err) {
    console.error('get-listings error:', err);
    return res.status(500).json({ error: 'Could not fetch listings' });
  }
};
