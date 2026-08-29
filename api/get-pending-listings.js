// /api/get-pending-listings.js
// Powers admin.html. Requires the x-admin-secret header to match
// ADMIN_SECRET — this is intentionally simple (a single shared password,
// not per-user accounts), appropriate for a small internal review tool,
// not a substitute for real authentication if this ever needs multiple
// reviewers with different permissions.
//
//   GET  — pending listings for review, as before.
//   POST { backgroundImages: [url, url, ...] }
//        — saves the admin's chosen homepage background photos. Kept in
//          this same file (rather than its own /api endpoint) to stay
//          under Vercel's Hobby-plan 12-serverless-function limit, and
//          because it's the same admin-secret gate either way. Uploading
//          the actual image files still goes through the existing
//          blob-upload.js first — this call only saves the resulting
//          URLs. An empty array clears the selection, and the homepage
//          falls back to using every listing's own cover photo instead
//          (see get-listings.js's ?siteBackground=1 mode, which is what
//          the homepage actually reads from).
//
// Requires a site_settings table:
//   CREATE TABLE IF NOT EXISTS site_settings (
//     key TEXT PRIMARY KEY,
//     value JSONB NOT NULL,
//     updated_at TIMESTAMPTZ DEFAULT now()
//   );

const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const BACKGROUND_IMAGES_KEY = 'homepage_background_images';

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminSecret = req.headers['x-admin-secret'];
  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'POST') {
    try {
      const { backgroundImages } = req.body || {};
      // Only real Blob URLs are kept — same defensive pattern used
      // everywhere else photo URLs are accepted from a request body (see
      // submit-listing.js) — never trust an arbitrary string into this.
      const safeImages = Array.isArray(backgroundImages)
        ? backgroundImages.filter(url => typeof url === 'string' && url.startsWith('https://')).slice(0, 20)
        : [];

      await sql`
        INSERT INTO site_settings (key, value, updated_at)
        VALUES (${BACKGROUND_IMAGES_KEY}, ${JSON.stringify(safeImages)}, now())
        ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(safeImages)}, updated_at = now()
      `;

      return res.status(200).json({ success: true, images: safeImages });
    } catch (err) {
      console.error('get-pending-listings (POST background) error:', err);
      return res.status(500).json({ error: 'Could not save background images right now.' });
    }
  }

  try {
    const listings = await sql`
      SELECT id, property_name, city, property_type, bedrooms, max_guests,
             nightly_rate, description, amenities, services,
             host_name, host_email, host_phone,
             discount_type, discount_value, discount_min_nights, discount_description,
             exterior_photo_urls, interior_photo_urls,
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
