// /api/host-listings.js
// Returns every listing belonging to the logged-in host — pending,
// approved, and rejected, so the dashboard can show real status, not just
// what's live to guests. Requires a valid host-session token, sent as:
//   Authorization: Bearer <sessionToken>

const { neon } = require('@neondatabase/serverless');
const { verifyToken, createToken } = require('./_approval-token');

const sql = neon(process.env.DATABASE_URL);
const SITE_BASE = 'https://aerva.in';
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'] || '';
  const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = sessionToken ? verifyToken(sessionToken) : null;

  if (!payload || payload.action !== 'host-session') {
    return res.status(401).json({ error: 'Please log in again.' });
  }

  try {
    const listings = await sql`
      SELECT id, property_name, city, property_type, bedrooms, max_guests, nightly_rate, status,
             description, amenities, services, host_name, host_phone,
             discount_type, discount_value, discount_min_nights, discount_description,
             exterior_photo_urls, interior_photo_urls, created_at
      FROM listings
      WHERE host_id = ${payload.listingId}
      ORDER BY created_at DESC
    `;
    // Generate a fresh "manage price" link for each listing on the spot —
    // the host doesn't have to dig up the one-time email from approval time.
    const listingsWithLinks = listings.map(l => ({
      ...l,
      manageLink: `${SITE_BASE}/manage-listing.html?token=${createToken(l.id, 'manage-pricing', TWO_YEARS_MS)}`
    }));
    return res.status(200).json({ listings: listingsWithLinks });
  } catch (err) {
    console.error('host-listings error:', err);
    return res.status(500).json({ error: 'Could not load your listings.' });
  }
};
