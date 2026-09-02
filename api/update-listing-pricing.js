// /api/update-listing-pricing.js
// Backs manage-listing.html — the long-lived link a host gets by email
// after their listing is approved (see approve-listing.js) and can reuse
// anytime from their dashboard (see host-listings.js) to manage their
// nightly rate, discount, photos, included amenities/services, paid
// add-ons, and pet policy, all without logging in again.
//
//   GET  ?token=...
//     Loads everything the form needs to pre-fill: pricing, discount,
//     photos, amenities/services, pet policy, and this listing's paid
//     amenities.
//
//   POST { token, nightlyRate, discountType, discountValue,
//          discountMinNights, discountDescription,
//          exteriorPhotoUrls, interiorPhotoUrls, coverPhotoUrl,
//          amenities, services, paidAmenities,
//          petFriendly, maxPetsAllowed, allowedPetTypes, petFee,
//          blockedDates }
//     Saves everything in one request. A rate change is also logged to
//     price_history. paidAmenities is a full-replace "sync" — whatever
//     array is sent becomes the complete set: existing rows matching an
//     id are updated, rows with no id are inserted as new, and any
//     existing row NOT present in the array is deleted. Pet policy is
//     also a full-replace set of its own four fields — see the inline
//     comment near where it's resolved for how "not sent at all" differs
//     from "explicitly set to No". blockedDates is the same full-replace
//     "sync" pattern as paidAmenities — dates a host takes off the
//     market themselves (maintenance, personal use, etc.), enforced
//     server-side in create-order.js so a guest genuinely can't book
//     over them, not just hidden from the calendar UI.

const { neon } = require('@neondatabase/serverless');
const { verifyToken } = require('./_approval-token');
const { logAudit } = require('./_audit-log');

const sql = neon(process.env.DATABASE_URL);

// City/area need to be enterable in ANY script when it's the actual
// place name (Google's Places Autocomplete is set to language=en on the
// frontend now, which handles the vast majority of cases), but the
// stored value itself must end up in Latin script — search matching,
// admin review, and consistency across the site all depend on that. This
// checks for characters outside Basic Latin + the Latin-1/Extended-A/B
// ranges (which already cover accented characters like "São Paulo" or
// "Zürich" fine) — anything beyond that (Devanagari, CJK, Arabic,
// Cyrillic, etc.) gets caught here as a last line of defense, since a
// host could still paste or type something directly regardless of what
// the autocomplete suggests.
function hasNonLatinScript(str) {
  return /[^\u0000-\u024F\s]/.test(str);
}

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
        SELECT id, property_name, city, area, nightly_rate, discount_type, discount_value, discount_min_nights, discount_description,
               exterior_photo_urls, interior_photo_urls, cover_photo_url, amenities, services,
               latitude, longitude, formatted_address,
               pet_friendly, max_pets_allowed, allowed_pet_types, pet_fee, security_deposit
        FROM listings WHERE id = ${listingId}
      `;
      const listing = rows[0];
      if (!listing) return res.status(404).json({ error: 'This listing could not be found.' });

      const paidAmenities = await sql`
        SELECT id, name, description, price, available_from, available_until, excluded_weekdays, is_active
        FROM listing_amenities WHERE listing_id = ${listingId} ORDER BY created_at ASC
      `;

      const blockedDates = await sql`
        SELECT id, start_date, end_date, reason
        FROM listing_blocked_dates WHERE listing_id = ${listingId} ORDER BY start_date ASC
      `;

      const promotions = await sql`
        SELECT id, name, discount_type, discount_value, min_nights, start_date, end_date, is_active
        FROM listing_promotions WHERE listing_id = ${listingId} ORDER BY start_date ASC
      `;

      return res.status(200).json({ listing, paidAmenities, blockedDates, promotions });
    } catch (err) {
      console.error('update-listing-pricing (GET) error:', err);
      return res.status(500).json({ error: 'Could not load your listing right now. Please try again.' });
    }
  }

  // ---- Save changes ----
  if (req.method === 'POST') {
    try {
      const { nightlyRate, discountType, discountValue, discountMinNights, discountDescription,
              exteriorPhotoUrls, interiorPhotoUrls, coverPhotoUrl, amenities, services, paidAmenities, blockedDates, promotions,
              latitude, longitude, formattedAddress, city, area,
              petFriendly, maxPetsAllowed, allowedPetTypes, petFee, securityDeposit } = req.body || {};

      const rate = nightlyRate ? Number(nightlyRate) : null;
      if (!rate || rate <= 0) {
        return res.status(400).json({ error: 'Please enter a valid nightly rate.' });
      }
      const safeCity = typeof city === 'string' ? city.trim().slice(0, 100) : '';
      if (!safeCity) {
        return res.status(400).json({ error: 'Please enter a city.' });
      }
      if (hasNonLatinScript(safeCity)) {
        return res.status(400).json({ error: 'Please enter the city in English (Latin script) — e.g. "Pune", not a local-script spelling.' });
      }
      const safeArea = typeof area === 'string' && area.trim() ? area.trim().slice(0, 100) : null;
      if (safeArea && hasNonLatinScript(safeArea)) {
        return res.status(400).json({ error: 'Please enter the area in English (Latin script) — e.g. "Koregaon Park", not a local-script spelling.' });
      }

      const before = await sql`
        SELECT nightly_rate, exterior_photo_urls, interior_photo_urls,
               pet_friendly, max_pets_allowed, allowed_pet_types, pet_fee, security_deposit
        FROM listings WHERE id = ${listingId}
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

      // Pet policy — same "Dog"/"Cat" whitelist as submit-listing.js. A
      // save that doesn't send petFriendly at all (e.g. a price-only
      // update from elsewhere) leaves the existing pet policy untouched;
      // one that does replaces all four fields together, since they only
      // make sense as a set — switching to "No" clears the detail fields
      // rather than leaving a stale count/fee behind.
      const ALLOWED_PET_TYPES = ['Dog', 'Cat', 'Bird', 'Rabbit', 'Fish', 'Hamster', 'Turtle', 'Other'];
      const petFriendlyProvided = petFriendly === true || petFriendly === false;
      const finalPetFriendly = petFriendlyProvided ? petFriendly : before[0].pet_friendly;
      const finalMaxPets = petFriendlyProvided
        ? (petFriendly === true && maxPetsAllowed ? Number(maxPetsAllowed) : null)
        : before[0].max_pets_allowed;
      const finalPetTypes = petFriendlyProvided
        ? (petFriendly === true && Array.isArray(allowedPetTypes) ? allowedPetTypes.filter(t => ALLOWED_PET_TYPES.includes(t)) : [])
        : (before[0].allowed_pet_types || []);
      const finalPetFee = petFriendlyProvided
        ? (petFriendly === true && petFee ? Number(petFee) : null)
        : before[0].pet_fee;

      // Security deposit — always sent fresh from the manage-listing form
      // (like the discount fields above), so this simply overwrites rather
      // than needing the same "not sent at all" handling pet policy needs.
      const finalSecurityDeposit = securityDeposit && Number(securityDeposit) > 0 ? Number(securityDeposit) : null;

      const updated = await sql`
        UPDATE listings SET
          nightly_rate = ${rate},
          city = ${safeCity}, area = ${safeArea},
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
          formatted_address = COALESCE(${formattedAddress || null}, formatted_address),
          pet_friendly = ${finalPetFriendly}, max_pets_allowed = ${finalMaxPets},
          allowed_pet_types = ${JSON.stringify(finalPetTypes)}, pet_fee = ${finalPetFee},
          security_deposit = ${finalSecurityDeposit}
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

      // ---- Sync blocked dates: same full-replace pattern as paid
      // amenities above. Ranges are host-defined (maintenance, personal
      // use, etc.) and are what create-order.js actually checks against
      // before letting a guest pay — this isn't just a calendar display.
      let blockedDatesError = null;
      if (Array.isArray(blockedDates)) {
        try {
          const existingRows = await sql`SELECT id FROM listing_blocked_dates WHERE listing_id = ${listingId}`;
          const existingIds = new Set(existingRows.map(r => r.id));
          const submittedIds = new Set();

          for (const b of blockedDates) {
            const startDate = typeof b.startDate === 'string' ? b.startDate : null;
            const endDate = typeof b.endDate === 'string' ? b.endDate : null;
            // Skip incomplete or backwards ranges rather than failing the
            // whole save — same tolerance as paid amenities' skip-if-incomplete rule.
            if (!startDate || !endDate || endDate <= startDate) continue;
            const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 200) || null : null;

            if (b.id && existingIds.has(Number(b.id))) {
              await sql`
                UPDATE listing_blocked_dates SET start_date = ${startDate}, end_date = ${endDate}, reason = ${reason}
                WHERE id = ${Number(b.id)} AND listing_id = ${listingId}
              `;
              submittedIds.add(Number(b.id));
            } else {
              const inserted = await sql`
                INSERT INTO listing_blocked_dates (listing_id, start_date, end_date, reason)
                VALUES (${listingId}, ${startDate}, ${endDate}, ${reason})
                RETURNING id
              `;
              submittedIds.add(inserted[0].id);
            }
          }

          const idsToDelete = [...existingIds].filter(id => !submittedIds.has(id));
          if (idsToDelete.length) {
            await sql`DELETE FROM listing_blocked_dates WHERE id = ANY(${idsToDelete}) AND listing_id = ${listingId}`;
          }
        } catch (blockedErr) {
          console.error('Blocked dates sync failed:', blockedErr);
          blockedDatesError = 'Your other changes saved, but blocked dates could not be updated. Please try again.';
        }
      }

      // ---- Sync promotions: same full-replace pattern again. Each
      // promotion needs a name, a valid discount type/value, and a real
      // date range — rows missing any of that are skipped rather than
      // failing the whole save.
      let promotionsError = null;
      if (Array.isArray(promotions)) {
        try {
          const existingRows = await sql`SELECT id FROM listing_promotions WHERE listing_id = ${listingId}`;
          const existingIds = new Set(existingRows.map(r => r.id));
          const submittedIds = new Set();

          for (const p of promotions) {
            const name = typeof p.name === 'string' ? p.name.trim().slice(0, 100) : '';
            const discType = p.discountType === 'flat' ? 'flat' : (p.discountType === 'percentage' ? 'percentage' : null);
            const discValue = Number(p.discountValue);
            const startDate = typeof p.startDate === 'string' ? p.startDate : null;
            const endDate = typeof p.endDate === 'string' ? p.endDate : null;
            if (!name || !discType || !discValue || discValue <= 0 || !startDate || !endDate || endDate <= startDate) continue;
            const minNights = p.minNights ? Number(p.minNights) : null;
            const isActive = p.isActive !== false;

            if (p.id && existingIds.has(Number(p.id))) {
              await sql`
                UPDATE listing_promotions SET
                  name = ${name}, discount_type = ${discType}, discount_value = ${discValue},
                  min_nights = ${minNights}, start_date = ${startDate}, end_date = ${endDate}, is_active = ${isActive}
                WHERE id = ${Number(p.id)} AND listing_id = ${listingId}
              `;
              submittedIds.add(Number(p.id));
            } else {
              const inserted = await sql`
                INSERT INTO listing_promotions (listing_id, name, discount_type, discount_value, min_nights, start_date, end_date, is_active)
                VALUES (${listingId}, ${name}, ${discType}, ${discValue}, ${minNights}, ${startDate}, ${endDate}, ${isActive})
                RETURNING id
              `;
              submittedIds.add(inserted[0].id);
            }
          }

          const idsToDelete = [...existingIds].filter(id => !submittedIds.has(id));
          if (idsToDelete.length) {
            await sql`DELETE FROM listing_promotions WHERE id = ANY(${idsToDelete}) AND listing_id = ${listingId}`;
          }
        } catch (promoErr) {
          console.error('Promotions sync failed:', promoErr);
          promotionsError = 'Your other changes saved, but promotions could not be updated. Please try again.';
        }
      }

      await logAudit(sql, {
        action: 'listing_pricing_updated', success: true, actorType: 'host', actorIdentifier: listing.host_email,
        targetType: 'listing', targetId: listingId,
        metadata: { newRate: rate, rateChanged, discountType: discountType || null, paidAmenitiesError: !!paidAmenitiesError, blockedDatesError: !!blockedDatesError, promotionsError: !!promotionsError }
      });

      const warning = [paidAmenitiesError, blockedDatesError, promotionsError].filter(Boolean).join(' ') || undefined;
      return res.status(200).json({ success: true, warning });
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
