// /api/get-pending-listings.js
// Powers admin.html. Requires the x-admin-secret header to match
// ADMIN_SECRET — this is intentionally simple (a single shared password,
// not per-user accounts), appropriate for a small internal review tool,
// not a substitute for real authentication if this ever needs multiple
// reviewers with different permissions.

const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-admin-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const adminSecret = req.headers['x-admin-secret'];
  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const listings = await sql`
      SELECT id, property_name, city, property_type, bedrooms, max_guests,
             nightly_rate, description, amenities, services,
             host_name, host_email, host_phone,
             discount_type, discount_value, discount_min_nights, discount_description,
             commission_rate, created_at
      FROM listings
      WHERE status = 'pending'
      ORDER BY created_at ASC
    `;
    return res.status(200).json({ listings });
  } catch (err) {
    console.error('get-pending-listings error:', err);
    return res.status(500).json({ error: 'Could not fetch listings' });
  }
};

