// /api/update-listing-pricing.js
// Backs manage-listing.html — the long-lived link a host gets by email
// after their listing is approved (see approve-listing.js) and can reuse
// anytime from their dashboard (see host-listings.js) to change their
// nightly rate or set up a discount, without logging in again.
//
//   GET  ?token=...
//     Loads the listing's current price/discount so the form can be
//     pre-filled.
//
//   POST { token, nightlyRate, discountType, discountValue,
//          discountMinNights, discountDescription }
//     Saves the changes. A rate change is also logged to price_history,
//     same as when a listing is first submitted.

const { neon } = require('@neondatabase/serverless');
const { verifyToken } = require('./_approval-token');
const { logAudit } = require('./_audit-log');

const sql = neon(process.env.DATABASE_URL);

function requireListingId(req) {
  const token = req.method === 'GET' ? req.query.token : (req.body || {}).token;
  const payload = token ? verifyToken(token) : null;
  if (!payload || payload.action !== 'manage-pricing') return null;
  return payload.listingId;
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const listingId = requireListingId(req);
  if (!listingId) {
    return res.status(400).json({ error: 'This link is no longer valid. Contact hello@aerva.in if you need a new one.' });
  }

  // ---- Load current pricing for the form ----
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT id, property_name, nightly_rate, discount_type, discount_value, discount_min_nights, discount_description
        FROM listings WHERE id = ${listingId}
      `;
      const listing = rows[0];
      if (!listing) return res.status(404).json({ error: 'This listing could not be found.' });
      return res.status(200).json({ listing });
    } catch (err) {
      console.error('update-listing-pricing (GET) error:', err);
      return res.status(500).json({ error: 'Could not load your listing right now. Please try again.' });
    }
  }

  // ---- Save changes ----
  if (req.method === 'POST') {
    try {
      const { nightlyRate, discountType, discountValue, discountMinNights, discountDescription } = req.body || {};

      const rate = nightlyRate ? Number(nightlyRate) : null;
      if (!rate || rate <= 0) {
        return res.status(400).json({ error: 'Please enter a valid nightly rate.' });
      }

      const before = await sql`SELECT nightly_rate FROM listings WHERE id = ${listingId}`;
      if (!before[0]) return res.status(404).json({ error: 'This listing could not be found.' });
      const rateChanged = Number(before[0].nightly_rate) !== rate;

      const updated = await sql`
        UPDATE listings SET
          nightly_rate = ${rate},
          discount_type = ${discountType || null},
          discount_value = ${discountValue ? Number(discountValue) : null},
          discount_min_nights = ${discountMinNights ? Number(discountMinNights) : null},
          discount_description = ${discountDescription || null}
        WHERE id = ${listingId}
        RETURNING id, property_name, host_email
      `;
      const listing = updated[0];

      if (rateChanged) {
        await sql`INSERT INTO price_history (listing_id, nightly_rate) VALUES (${listingId}, ${rate})`;
      }

      await logAudit(sql, {
        action: 'listing_pricing_updated', success: true, actorType: 'host', actorIdentifier: listing.host_email,
        targetType: 'listing', targetId: listingId,
        metadata: { newRate: rate, rateChanged, discountType: discountType || null }
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('update-listing-pricing (POST) error:', err);
      await logAudit(sql, {
        action: 'listing_pricing_updated', success: false, actorType: 'host', actorIdentifier: null,
        targetType: 'listing', targetId: listingId, metadata: { reason: 'server_error' }
      });
      return res.status(500).json({ error: 'Could not save your changes right now. Please try again.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
