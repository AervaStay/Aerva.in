// /api/host-listings.js
// Returns every listing belonging to the logged-in guest's linked host
// account — pending, approved, and rejected, so the dashboard can show
// real status, not just what's live to guests. Requires a valid
// guest-session token (the single login used across the whole site — see
// guest-auth.js / guest-phone-auth.js), sent as:
//   Authorization: Bearer <sessionToken>
//
// A guest who hasn't listed a property yet simply has no linked host
// account (guests.host_id is null) — that's not an error, it just means
// an empty list, same as a brand-new account.

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

  if (!payload || payload.action !== 'guest-session') {
    return res.status(401).json({ error: 'Please log in again.' });
  }
  const guestId = payload.listingId; // generically-named token field — see host-auth.js note

  try {
    const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
    const guest = guestRows[0];
    if (!guest) return res.status(401).json({ error: 'Please log in again.' });

    // Never hosted anything yet — an empty dashboard, not an error.
    if (!guest.host_id) {
      return res.status(200).json({ listings: [], bookings: [] });
    }

    const listings = await sql`
      SELECT id, property_name, city, property_type, bedrooms, max_guests, nightly_rate, status,
             description, amenities, services, host_name, host_phone,
             discount_type, discount_value, discount_min_nights, discount_description,
             latitude, longitude, formatted_address,
             exterior_photo_urls, interior_photo_urls, cover_photo_url, created_at
      FROM listings
      WHERE host_id = ${guest.host_id}
      ORDER BY created_at DESC
    `;
    // Generate a fresh "manage price" link for each listing on the spot —
    // the host doesn't have to dig up the one-time email from approval time.
    const listingsWithLinks = listings.map(l => ({
      ...l,
      manageLink: `${SITE_BASE}/manage-listing.html?token=${createToken(l.id, 'manage-pricing', TWO_YEARS_MS)}`
    }));

    // "Aerva Host" status — awarded the moment a host has at least one
    // approved listing. Computed here rather than stored anywhere, so it's
    // always accurate the instant a listing's status flips to 'approved'
    // (see approve-listing.js), with nothing to keep in sync.
    const hostBadge = listings.some(l => l.status === 'approved') ? 'Aerva Host' : null;

    // Bookings/earnings for this host's listings — deliberately selects
    // only host-relevant columns. `total` and `guest_service_fee` are
    // NEVER included here on purpose: total includes the guest's own
    // service fee, which is Aerva's guest-side revenue and none of the
    // host's business, exactly as guests never see the host's commission.
    // subtotal + gst here already reflects what the guest paid for the
    // stay itself, before that split — payout_amount is what actually
    // lands with the host after commission.
    const bookings = await sql`
      SELECT o.id, o.suite_name, o.listing_id, o.arrival, o.departure, o.nights,
             o.subtotal, o.discount_amount, o.gst,
             o.commission_rate, o.commission_amount, o.payout_amount,
             o.status, o.created_at
      FROM orders o
      JOIN listings l ON o.listing_id = l.id
      WHERE l.host_id = ${guest.host_id}
      ORDER BY o.created_at DESC
      LIMIT 100
    `;

    return res.status(200).json({ listings: listingsWithLinks, hostBadge, bookings });
  } catch (err) {
    console.error('host-listings error:', err);
    return res.status(500).json({ error: 'Could not load your listings.' });
  }
};
