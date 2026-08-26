// /api/get-listings.js
// Returns APPROVED listings as JSON — read-only, safe to call publicly;
// never exposes pending/rejected submissions, host contact details beyond
// what's guest-facing, or commission_rate.
//
// Supports optional filters via query params, all combinable:
//   ?city=Pune              — partial, case-insensitive match against city
//   ?guests=4               — only listings that can sleep at least this many
//   ?arrival=...&departure=... — only listings with no existing paid
//                                booking that overlaps this date range
//                                (both must be given together)
//
// max_guests is stored as free text (e.g. "4" going forward, but older
// listings may still have range strings like "3–4" or "9+" from before
// the submission form was changed to exact numbers) — parseMaxGuests()
// below extracts the largest number found either way, so filtering works
// correctly against old and new data alike.

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

function parseMaxGuests(raw) {
  if (!raw) return null;
  const numbers = String(raw).match(/\d+/g);
  if (!numbers) return null;
  return Math.max(...numbers.map(Number));
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const cityRaw = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const guestsRaw = typeof req.query.guests === 'string' ? req.query.guests.trim() : '';
    const arrivalRaw = typeof req.query.arrival === 'string' ? req.query.arrival.trim() : '';
    const departureRaw = typeof req.query.departure === 'string' ? req.query.departure.trim() : '';

    const cityFilter = cityRaw ? `%${cityRaw}%` : null;
    const guestsFilter = guestsRaw && !isNaN(Number(guestsRaw)) ? Number(guestsRaw) : null;
    // Dates only apply as a pair — a lone arrival or departure is ignored
    // rather than causing a confusing partial filter.
    const datesFilter = arrivalRaw && departureRaw;
    const arrivalFilter = datesFilter ? arrivalRaw : null;
    const departureFilter = datesFilter ? departureRaw : null;

    // City and date-availability are filtered in SQL — availability
    // specifically needs to check against the orders table, which only
    // makes sense server-side. guests is filtered afterward in JS (see
    // parseMaxGuests) since max_guests can still contain old-format range
    // strings that aren't safe to compare numerically in raw SQL.
    const listings = await sql`
      SELECT
        id, property_name, city, property_type, bedrooms, max_guests,
        nightly_rate, description, amenities, services,
        discount_type, discount_value, discount_min_nights, discount_description,
        exterior_photo_urls, interior_photo_urls, cover_photo_url,
        latitude, longitude, formatted_address,
        created_at
      FROM listings
      WHERE status = 'approved'
        AND (${cityFilter}::text IS NULL OR city ILIKE ${cityFilter})
        AND (
          ${arrivalFilter}::date IS NULL OR NOT EXISTS (
            SELECT 1 FROM orders o
            WHERE o.listing_id = listings.id
              AND o.status = 'paid'
              AND o.arrival < ${departureFilter}::date
              AND o.departure > ${arrivalFilter}::date
          )
        )
      ORDER BY created_at DESC
    `;

    const filtered = guestsFilter
      ? listings.filter(l => {
          const capacity = parseMaxGuests(l.max_guests);
          // A listing with no max_guests set at all isn't excluded by a
          // guest-count search — better to show it and let the guest
          // judge for themselves than to hide it over missing data.
          return capacity === null || capacity >= guestsFilter;
        })
      : listings;

    // One extra query for all paid amenities across every listing being
    // returned, rather than one query per listing — cheaper, and this
    // endpoint can return many listings at once.
    if (filtered.length > 0) {
      const listingIds = filtered.map(l => l.id);
      const amenityRows = await sql`
        SELECT id, listing_id, name, description, price, available_from, available_until
        FROM listing_amenities
        WHERE listing_id = ANY(${listingIds}) AND is_active = TRUE
        ORDER BY created_at ASC
      `;
      const amenitiesByListing = {};
      for (const a of amenityRows) {
        if (!amenitiesByListing[a.listing_id]) amenitiesByListing[a.listing_id] = [];
        amenitiesByListing[a.listing_id].push({
          id: a.id,
          name: a.name,
          description: a.description,
          price: a.price,
          availableFrom: a.available_from,
          availableUntil: a.available_until
        });
      }
      filtered.forEach(l => { l.paid_amenities = amenitiesByListing[l.id] || []; });
    }

    return res.status(200).json({ listings: filtered });
  } catch (err) {
    console.error('get-listings error:', err);
    return res.status(500).json({ error: 'Could not fetch listings' });
  }
};
