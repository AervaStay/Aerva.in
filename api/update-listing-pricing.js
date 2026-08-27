// /api/update-listing-pricing.js
// Backs manage-listing.html — the long-lived link a host gets by email
// after their listing is approved (see approve-listing.js) and can reuse
// anytime from their dashboard (see host-listings.js) to manage their
// nightly rate, discount, photos, included amenities/services, and paid
// add-ons, all without logging in again.
//
//   GET  ?token=...
//     Loads everything the form needs to pre-fill: pricing, discount,
//     photos, amenities/services, and this listing's paid amenities.
//
//   POST { token, nightlyRate, discountType, discountValue,
//          discountMinNights, discountDescription,
//          exteriorPhotoUrls, interiorPhotoUrls, coverPhotoUrl,
//          amenities, services, paidAmenities }
//     Saves everything in one request. A rate change is also logged to
//     price_history. paidAmenities is a full-replace "sync" — whatever
//     array is sent becomes the complete set: existing rows matching an
//     id are updated, rows with no id are inserted as new, and any
//     existing row NOT present in the array is deleted.

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
        SELECT id, property_name, nightly_rate, discount_type, discount_value, discount_min_nights, discount_description,
               exterior_photo_urls, interior_photo_urls, cover_photo_url, amenities, services,
               latitude, longitude, formatted_address
        FROM listings WHERE id = ${listingId}
      `;
      const listing = rows[0];
      if (!listing) return res.status(404).json({ error: 'This listing could not be found.' });

      const paidAmenities = await sql`
        SELECT id, name, description, price, available_from, available_until, excluded_weekdays, is_active
        FROM listing_amenities WHERE listing_id = ${listingId} ORDER BY created_at ASC
      `;

      return res.status(200).json({ listing, paidAmenities });
    } catch (err) {
      console.error('update-listing-pricing (GET) error:', err);
      return res.status(500).json({ error: 'Could not load your listing right now. Please try again.' });
    }
  }

  // ---- Save changes ----
  if (req.method === 'POST') {
    try {
      const { nightlyRate, discountType, discountValue, discountMinNights, discountDescription,
              exteriorPhotoUrls, interiorPhotoUrls, coverPhotoUrl, amenities, services, paidAmenities,
              latitude, longitude, formattedAddress } = req.body || {};

      const rate = nightlyRate ? Number(nightlyRate) : null;
      if (!rate || rate <= 0) {
        return res.status(400).json({ error: 'Please enter a valid nightly rate.' });
      }

      const before = await sql`
        SELECT nightly_rate, exterior_photo_urls, interior_photo_urls FROM listings WHERE id = ${listingId}
      `;
      if (!before[0]) return res.status(404).json({ error: 'This listing could not be found.' });
      const rateChanged = Number(before[0].nightly_rate) !== rate;

      // Same defensive pattern as submit-listing.js — only real Blob URLs
      // are accepted. undefined (not []) means "not sent this time, leave
      // as-is" — a price-only save from this same page shouldn't silently
      // wipe out the photo arrays.
      function sanitizePhotoUrls(urls){
        return Array.isArray(urls)
          ? urls.filter(url => typeof url === 'string' && url.startsWith('https://')).slice(0, 20)
          : undefined;
      }
      const safeExteriorUrls = sanitizePhotoUrls(exteriorPhotoUrls);
      const safeInteriorUrls = sanitizePhotoUrls(interiorPhotoUrls);

      // Validate the cover choice against whatever the photo arrays will
      // actually be after this save — freshly updated ones if provided,
      // otherwise whatever's already in the database. This is what
      // prevents a price-only save (no photo fields sent at all) from
      // resetting an existing cover choice just because this request
      // didn't happen to repeat it.
      const effectiveExterior = safeExteriorUrls !== undefined ? safeExteriorUrls : (before[0].exterior_photo_urls || []);
      const effectiveInterior = safeInteriorUrls !== undefined ? safeInteriorUrls : (before[0].interior_photo_urls || []);
      const safeCoverUrl = (typeof coverPhotoUrl === 'string' && [...effectiveExterior, ...effectiveInterior].includes(coverPhotoUrl))
        ? coverPhotoUrl
        : null;

      // Same bounds-check pattern as submit-listing.js. undefined (not
      // null) means "not sent this time, leave the existing value alone"
      // — a photo-only or price-only save shouldn't wipe out a location
      // that was already set.
      const safeLat = (latitude && !isNaN(Number(latitude)) && Math.abs(Number(latitude)) <= 90) ? Number(latitude) : undefined;
      const safeLng = (longitude && !isNaN(Number(longitude)) && Math.abs(Number(longitude)) <= 180) ? Number(longitude) : undefined;

      const updated = await sql`
        UPDATE listings SET
          nightly_rate = ${rate},
          discount_type = ${discountType || null},
          discount_value = ${discountValue ? Number(discountValue) : null},
          discount_min_nights = ${discountMinNights ? Number(discountMinNights) : null},
          discount_description = ${discountDescription || null},
          exterior_photo_urls = COALESCE(${safeExteriorUrls ? JSON.stringify(safeExteriorUrls) : null}, exterior_photo_urls),
          interior_photo_urls = COALESCE(${safeInteriorUrls ? JSON.stringify(safeInteriorUrls) : null}, interior_photo_urls),
          cover_photo_url = ${safeCoverUrl},
          amenities = COALESCE(${Array.isArray(amenities) ? JSON.stringify(amenities) : null}, amenities),
          services = COALESCE(${Array.isArray(services) ? JSON.stringify(services) : null}, services),
          latitude = COALESCE(${safeLat ?? null}, latitude),
          longitude = COALESCE(${safeLng ?? null}, longitude),
          formatted_address = COALESCE(${formattedAddress || null}, formatted_address)
        WHERE id = ${listingId}
        RETURNING id, property_name, host_email
      `;
      const listing = updated[0];

      if (rateChanged) {
        await sql`INSERT INTO price_history (listing_id, nightly_rate) VALUES (${listingId}, ${rate})`;
      }

      // ---- Sync paid amenities: the submitted array becomes the full
      // set. Anything with a matching id gets updated, anything with no
      // id is new, and any existing row not present anymore gets deleted.
      let paidAmenitiesError = null;
      if (Array.isArray(paidAmenities)) {
        try {
          const existingRows = await sql`SELECT id FROM listing_amenities WHERE listing_id = ${listingId}`;
          const existingIds = new Set(existingRows.map(r => r.id));
          const submittedIds = new Set();

          for (const a of paidAmenities) {
            const name = typeof a.name === 'string' ? a.name.trim().slice(0, 100) : '';
            const price = Number(a.price);
            if (!name || !price || price <= 0) continue; // skip incomplete rows rather than failing the whole save
            const description = typeof a.description === 'string' ? a.description.slice(0, 500) : null;
            const availableFrom = a.availableFrom || null;
            const availableUntil = a.availableUntil || null;
            // Only real weekday numbers (0=Sunday..6=Saturday), deduplicated —
            // defensive against anything malformed making it into the DB.
            const excludedWeekdays = Array.isArray(a.excludedWeekdays)
              ? [...new Set(a.excludedWeekdays.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))]
              : [];
            const isActive = a.isActive !== false;

            if (a.id && existingIds.has(Number(a.id))) {
              await sql`
                UPDATE listing_amenities SET
                  name = ${name}, description = ${description}, price = ${price},
                  available_from = ${availableFrom}, available_until = ${availableUntil},
                  excluded_weekdays = ${JSON.stringify(excludedWeekdays)}, is_active = ${isActive}
                WHERE id = ${Number(a.id)} AND listing_id = ${listingId}
              `;
              submittedIds.add(Number(a.id));
            } else {
              const inserted = await sql`
                INSERT INTO listing_amenities (listing_id, name, description, price, available_from, available_until, excluded_weekdays, is_active)
                VALUES (${listingId}, ${name}, ${description}, ${price}, ${availableFrom}, ${availableUntil}, ${JSON.stringify(excludedWeekdays)}, ${isActive})
                RETURNING id
              `;
              submittedIds.add(inserted[0].id);
            }
          }

          const idsToDelete = [...existingIds].filter(id => !submittedIds.has(id));
          if (idsToDelete.length) {
            await sql`DELETE FROM listing_amenities WHERE id = ANY(${idsToDelete}) AND listing_id = ${listingId}`;
          }
        } catch (amenityErr) {
          // Don't fail the whole save over the amenities sync — price and
          // photos are more important and already committed above. Log it
          // and let the user know this one part needs another try.
          console.error('Paid amenities sync failed:', amenityErr);
          paidAmenitiesError = 'Your other changes saved, but paid amenities could not be updated. Please try again.';
        }
      }

      await logAudit(sql, {
        action: 'listing_pricing_updated', success: true, actorType: 'host', actorIdentifier: listing.host_email,
        targetType: 'listing', targetId: listingId,
        metadata: { newRate: rate, rateChanged, discountType: discountType || null, paidAmenitiesError: !!paidAmenitiesError }
      });

      return res.status(200).json({ success: true, warning: paidAmenitiesError || undefined });
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
