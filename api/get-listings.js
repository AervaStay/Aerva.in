// /api/get-listings.js
   // redeploy trigger
// Returns APPROVED listings as JSON — read-only, safe to call publicly;
// never exposes pending/rejected submissions, host contact details beyond
// what's guest-facing, or commission_rate.
//
// Supports optional filters via query params, all combinable:
//   ?city=Pune              — partial, case-insensitive match against city
//                              (fallback only — see lat/lng below)
//   ?lat=...&lng=...&radiusKm=200 — only listings within this distance of
//                              a point (typically a geocoded place name —
//                              see aerva.html's performSearch). Preferred
//                              over ?city, since a plain text match finds
//                              nothing when a guest searches a nearby town
//                              that doesn't literally match any listing's
//                              city field.
//   ?guests=4               — only listings that can sleep at least this many
//   ?arrival=...&departure=... — only listings with no existing paid
//                                booking that overlaps this date range
//                                (both must be given together)
//   ?availabilityFor=<id>   — a completely different mode: ignores every
//                              other param and returns only that one
//                              listing's booked date ranges, for the
//                              listing page's availability calendar. Kept
//                              in this file rather than its own /api
//                              endpoint to stay under Vercel's Hobby-plan
//                              12-serverless-function limit.
//   ?siteBackground=1       — another standalone mode: returns the
//                              admin's chosen homepage background photos
//                              (saved via the POST mode on
//                              get-pending-listings.js), or an empty list
//                              if none are set yet.
//   ?experiences=1          — another standalone mode: returns every
//                              approved Aerva Experience (listing_type =
//                              'experience'), each joined with a summary
//                              of the property that hosts it. The default
//                              (no special param) query only ever returns
//                              listing_type = 'stay' rows now — experiences
//                              never appear in the regular Suites results.
//   ?currencyRates=1        — public, returns the currency conversion
//                              rates last cached by the daily cron below
//                              (or { rates: null } if none have been
//                              fetched yet — the frontend falls back to
//                              plain INR in that case).
//   ?refreshCurrencyRates=1 — NOT public — requires an Authorization:
//                              Bearer <CRON_SECRET> header, which only
//                              Vercel's own Cron scheduler sends (see
//                              vercel.json). Fetches fresh rates and
//                              caches them; called automatically once a
//                              day, never by the frontend directly.
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

// Normalizes a DATE column value to 'YYYY-MM-DD' whether the driver
// returns it as a JS Date object or an already-formatted string — same
// helper used in create-order.js for the same reason. Only needed here
// for the ?availabilityFor= branch below.
function toDateStr(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0];
  return String(val).slice(0, 10);
}

// Same Haversine formula used client-side for "distance from me" — kept
// in sync deliberately, since both should agree on what "200km" means.
function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ---- Availability lookup for one listing ----
    // Folded into this same endpoint (rather than its own /api file) to
    // stay under Vercel's Hobby-plan serverless function limit — adding a
    // 13th function file failed the build outright. ?availabilityFor=<id>
    // takes over the whole request and skips the normal listings query
    // entirely; it returns only which date ranges are already paid and
    // booked for that listing, never anything about who booked them.
    const availabilityForRaw = typeof req.query.availabilityFor === 'string' ? req.query.availabilityFor.trim() : '';
    if (availabilityForRaw) {
      const listingId = Number(availabilityForRaw);
      if (!listingId) {
        return res.status(400).json({ error: 'Missing or invalid availabilityFor' });
      }
      const orderRows = await sql`
        SELECT arrival, departure FROM orders
        WHERE listing_id = ${listingId} AND status = 'paid'
        ORDER BY arrival ASC
      `;
      const bookedRanges = orderRows.map(r => ({
        arrival: toDateStr(r.arrival),
        departure: toDateStr(r.departure),
      }));

      // Host-blocked dates (maintenance, personal use, etc.) — shown on
      // the same calendar as booked dates so a guest can't even try to
      // select them, though create-order.js is what actually enforces it.
      const blockedRows = await sql`
        SELECT start_date, end_date, reason FROM listing_blocked_dates
        WHERE listing_id = ${listingId}
        ORDER BY start_date ASC
      `;
      const blockedRanges = blockedRows.map(r => ({
        arrival: toDateStr(r.start_date),
        departure: toDateStr(r.end_date),
        reason: r.reason || null,
      }));

      return res.status(200).json({ bookedRanges, blockedRanges });
    }

    // ---- Homepage background images, chosen by the admin ----
    // Public and read-only, like everything else in this file. Returns
    // whatever admin.html last saved via the POST mode on
    // get-pending-listings.js. An empty array is a normal, expected
    // result (admin hasn't picked any yet) — the homepage itself decides
    // to fall back to listing cover photos in that case, not this endpoint.
    if (req.query.siteBackground === '1') {
      try {
        const rows = await sql`SELECT value FROM site_settings WHERE key = 'homepage_background_images'`;
        const images = rows[0] && Array.isArray(rows[0].value) ? rows[0].value : [];
        return res.status(200).json({ images });
      } catch (settingsErr) {
        // Most likely cause: the site_settings table hasn't been created
        // yet (see the header comment for the CREATE TABLE statement).
        // Treat that the same as "admin hasn't picked any images" rather
        // than failing the request — the homepage's own cover-photo
        // fallback handles an empty list just fine.
        console.error('siteBackground lookup failed (site_settings may not exist yet):', settingsErr);
        return res.status(200).json({ images: [] });
      }
    }

    // ---- Currency display rates ----
    // Public, read-only — returns whatever was last cached by the daily
    // cron refresh below. Never fetches live from here on a guest's own
    // page load; that's exactly the fragility this replaced (a third-
    // party API being slow/down/CORS-blocked no longer affects guests at
    // all, since they're reading from our own database, not the source
    // directly).
    if (req.query.currencyRates === '1') {
      try {
        const rows = await sql`SELECT value, updated_at FROM site_settings WHERE key = 'currency_rates'`;
        if (!rows[0]) return res.status(200).json({ rates: null, updatedAt: null });
        return res.status(200).json({ rates: rows[0].value, updatedAt: rows[0].updated_at });
      } catch (settingsErr) {
        console.error('currencyRates lookup failed (site_settings may not exist yet):', settingsErr);
        return res.status(200).json({ rates: null, updatedAt: null });
      }
    }

    // ---- Daily currency rate refresh (Vercel Cron only) ----
    // Vercel calls this automatically once a day per the schedule in
    // vercel.json, with an Authorization header it generates itself from
    // your CRON_SECRET env var — this check is what stops anyone else
    // from hitting this URL and forcing a refresh (harmless on its own,
    // but still not something a public endpoint should allow arbitrarily).
    if (req.query.refreshCurrencyRates === '1') {
      const authHeader = req.headers['authorization'] || '';
      if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      // Same two free/keyless sources the frontend used to call directly
      // — tried in order, first one to return a real-looking rate table
      // wins. If both fail, the cached rates from the last successful
      // run stay in place rather than being wiped out.
      const sources = [
        { url: 'https://open.er-api.com/v6/latest/INR', extract: (data) => data && data.rates },
        { url: 'https://api.exchangerate-api.com/v4/latest/INR', extract: (data) => data && data.rates },
      ];
      for (const source of sources) {
        try {
          const res2 = await fetch(source.url);
          if (!res2.ok) continue;
          const data = await res2.json();
          const rates = source.extract(data);
          if (rates && rates.USD && rates.GBP) {
            await sql`
              INSERT INTO site_settings (key, value, updated_at)
              VALUES ('currency_rates', ${JSON.stringify(rates)}, now())
              ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(rates)}, updated_at = now()
            `;
            return res.status(200).json({ success: true, source: source.url });
          }
        } catch (fetchErr) {
          console.error('refreshCurrencyRates: source failed, trying next:', source.url, fetchErr);
        }
      }
      return res.status(502).json({ error: 'Both currency rate sources failed — cached rates left unchanged.' });
    }

    // ---- Aerva Experience browsing ----
    // Public, read-only, same pattern as everything else here. Returns
    // every approved experience along with a summary of the property that
    // hosts it — city/photo/whether it has its own bookable stay — so the
    // frontend can show "Hosted at X" and, if that property is itself an
    // approved stay listing, offer the "also book your stay here"
    // cross-sell without a second round trip.
    if (req.query.experiences === '1') {
      // Same lat/lng/radiusKm distance filter stays use — a location
      // search should narrow experiences down exactly the same way it
      // narrows suites, not leave every experience in India showing
      // regardless of where the guest actually searched.
      const expLatRaw = typeof req.query.lat === 'string' ? Number(req.query.lat) : null;
      const expLngRaw = typeof req.query.lng === 'string' ? Number(req.query.lng) : null;
      const expRadiusRaw = typeof req.query.radiusKm === 'string' ? Number(req.query.radiusKm) : null;
      const expDistanceFilter = (expLatRaw != null && !isNaN(expLatRaw) && expLngRaw != null && !isNaN(expLngRaw) && expRadiusRaw != null && !isNaN(expRadiusRaw))
        ? { lat: expLatRaw, lng: expLngRaw, radiusKm: expRadiusRaw }
        : null;
      const expCityRaw = typeof req.query.city === 'string' ? req.query.city.trim() : '';

      // A guest searching specific dates shouldn't see an experience
      // that's actually blocked (or already booked) across the whole
      // span they'd need — same overlap rule the stays query above uses,
      // and same multi-day-aware span (a guest searching a single day
      // still only needs that one day free, so a multi-day experience's
      // own duration doesn't factor in here — it's checked properly at
      // actual booking time in create-order.js instead).
      const expArrivalRaw = typeof req.query.arrival === 'string' ? req.query.arrival.trim() : '';
      const expDepartureRaw = typeof req.query.departure === 'string' ? req.query.departure.trim() : '';
      const expDatesFilter = expArrivalRaw && expDepartureRaw;

      const experiences = await sql`
        SELECT
          e.id, e.property_name, e.description, e.experience_category,
          e.nightly_rate AS price, e.experience_price_unit, e.experience_duration_hours, e.experience_duration_days, e.experience_type,
          e.exterior_photo_urls, e.interior_photo_urls, e.cover_photo_url,
          e.host_name, e.created_at,
          e.hosting_listing_id, e.city, e.latitude, e.longitude, e.formatted_address,
          e.experience_arranges_travel, e.experience_travel_details,
          e.experience_meeting_point_type, e.experience_meeting_point_details,
          e.experience_start_time, e.experience_refund_policy,
          e.experience_meeting_point_lat, e.experience_meeting_point_lng, e.experience_meeting_point_address,
          e.experience_instructions, e.experience_special_instructions,
          e.experience_available_from, e.experience_available_until,
          h.property_name AS hosting_property_name, h.city AS hosting_city, h.area AS hosting_area,
          h.nightly_rate AS hosting_nightly_rate, h.cover_photo_url AS hosting_cover_photo_url,
          h.exterior_photo_urls AS hosting_exterior_photo_urls, h.interior_photo_urls AS hosting_interior_photo_urls,
          h.status AS hosting_status
        FROM listings e
        LEFT JOIN listings h ON h.id = e.hosting_listing_id
        WHERE e.status = 'approved' AND e.listing_type = 'experience'
          AND (
            NOT ${expDatesFilter} OR (
              NOT EXISTS (
                SELECT 1 FROM orders o
                WHERE o.listing_id = e.id
                  AND o.status = 'paid'
                  AND o.arrival < ${expDatesFilter ? expDepartureRaw : null}::date
                  AND o.departure > ${expDatesFilter ? expArrivalRaw : null}::date
              )
              AND NOT EXISTS (
                SELECT 1 FROM listing_blocked_dates b
                WHERE b.listing_id = e.id
                  AND b.start_date < ${expDatesFilter ? expDepartureRaw : null}::date
                  AND b.end_date > ${expDatesFilter ? expArrivalRaw : null}::date
              )
            )
          )
        ORDER BY e.created_at DESC
      `;

      // Same "no coordinates falls back to city text, otherwise strict
      // distance" rule the suites filter below uses (see the comment
      // there for the reasoning) — kept consistent between the two.
      const filteredExperiences = expDistanceFilter
        ? experiences.filter(e => {
            if (e.latitude == null || e.longitude == null) {
              if (!expCityRaw) return false;
              const needle = expCityRaw.toLowerCase();
              return (e.city && e.city.toLowerCase().includes(needle));
            }
            const km = haversineDistanceKm(expDistanceFilter.lat, expDistanceFilter.lng, Number(e.latitude), Number(e.longitude));
            return km <= expDistanceFilter.radiusKm;
          })
        : experiences;

      return res.status(200).json({ experiences: filteredExperiences });
    }

    // ?experiencesFor=<listingId> — every approved experience hosted AT
    // this specific stay listing, for the listing detail page to offer
    // as an add-on. 'with_stay' ones can be booked in the SAME order as
    // this stay (create-order.js already accepts a stays[] and an
    // experiences[] together in one request — no new checkout needed);
    // 'without_stay' ones are just shown as a separate thing to book.
    if (req.query.experiencesFor) {
      const hostingId = Number(req.query.experiencesFor);
      if (!hostingId || isNaN(hostingId)) {
        return res.status(400).json({ error: 'Invalid listing id' });
      }
      const experiencesFor = await sql`
        SELECT id, property_name, description, experience_category, experience_type,
               nightly_rate AS price, experience_price_unit, experience_duration_hours, experience_duration_days,
               exterior_photo_urls, interior_photo_urls, cover_photo_url,
               city, latitude, longitude, formatted_address,
               experience_arranges_travel, experience_travel_details,
               experience_meeting_point_type, experience_meeting_point_details,
               experience_start_time, experience_refund_policy,
               experience_meeting_point_lat, experience_meeting_point_lng, experience_meeting_point_address,
               experience_instructions, experience_special_instructions,
               experience_available_from, experience_available_until
        FROM listings
        WHERE status = 'approved' AND listing_type = 'experience' AND hosting_listing_id = ${hostingId}
        ORDER BY created_at DESC
      `;
      return res.status(200).json({ experiences: experiencesFor });
    }

    const cityRaw = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const guestsRaw = typeof req.query.guests === 'string' ? req.query.guests.trim() : '';
    const arrivalRaw = typeof req.query.arrival === 'string' ? req.query.arrival.trim() : '';
    const departureRaw = typeof req.query.departure === 'string' ? req.query.departure.trim() : '';
    const latRaw = typeof req.query.lat === 'string' ? Number(req.query.lat) : null;
    const lngRaw = typeof req.query.lng === 'string' ? Number(req.query.lng) : null;
    const radiusRaw = typeof req.query.radiusKm === 'string' ? Number(req.query.radiusKm) : null;

    const cityFilter = cityRaw ? `%${cityRaw}%` : null;
    const guestsFilter = guestsRaw && !isNaN(Number(guestsRaw)) ? Number(guestsRaw) : null;
    // Only a genuine, complete lat/lng/radius triple activates distance
    // filtering — a lone or malformed value is ignored rather than
    // crashing or silently filtering everything out.
    const distanceFilter = (latRaw != null && !isNaN(latRaw) && lngRaw != null && !isNaN(lngRaw) && radiusRaw != null && !isNaN(radiusRaw))
      ? { lat: latRaw, lng: lngRaw, radiusKm: radiusRaw }
      : null;
    // Dates only apply as a pair — a lone arrival or departure is ignored
    // rather than causing a confusing partial filter.
    const datesFilter = arrivalRaw && departureRaw;
    const arrivalFilter = datesFilter ? arrivalRaw : null;
    const departureFilter = datesFilter ? departureRaw : null;

    // When a real distance search is active (a guest typed/picked a
    // place, turned into a 200km radius below), the city/area text is
    // NOT also required — a "Mumbai" search legitimately should surface
    // a nearby Pune listing within range, even though its city field
    // says "Pune," not "Mumbai." That's the actual point of a radius
    // search. (An earlier version of this required both together, which
    // broke exactly that — a Mumbai search stopped finding Pune at all.)
    // Only "Near Me" (no typed place, pure geolocation) has no text
    // filter to begin with, so it's unaffected either way.
    const effectiveCityFilter = distanceFilter ? null : cityFilter;

    // City and date-availability are filtered in SQL — availability
    // specifically needs to check against the orders table, which only
    // makes sense server-side. guests and distance are filtered afterward
    // in JS (see parseMaxGuests / haversineDistanceKm) since both need
    // logic that's awkward or unsafe to express directly in SQL.
    const listings = await sql`
      SELECT
        id, property_name, city, area, property_type, bedrooms, max_guests,
        nightly_rate, description, amenities, services, host_name,
        discount_type, discount_value, discount_min_nights, discount_description,
        exterior_photo_urls, interior_photo_urls, cover_photo_url,
        latitude, longitude, formatted_address,
        pet_friendly, max_pets_allowed, allowed_pet_types, pet_fee, security_deposit,
        created_at
      FROM listings
      WHERE status = 'approved' AND listing_type = 'stay'
        AND (${effectiveCityFilter}::text IS NULL OR city ILIKE ${effectiveCityFilter} OR area ILIKE ${effectiveCityFilter})
        AND (
          ${arrivalFilter}::date IS NULL OR (
            NOT EXISTS (
              SELECT 1 FROM orders o
              WHERE o.listing_id = listings.id
                AND o.status = 'paid'
                AND o.arrival < ${departureFilter}::date
                AND o.departure > ${arrivalFilter}::date
            )
            AND NOT EXISTS (
              SELECT 1 FROM listing_blocked_dates b
              WHERE b.listing_id = listings.id
                AND b.start_date < ${departureFilter}::date
                AND b.end_date > ${arrivalFilter}::date
            )
          )
        )
      ORDER BY created_at DESC
    `;

    const afterGuestsFilter = guestsFilter
      ? listings.filter(l => {
          const capacity = parseMaxGuests(l.max_guests);
          // A listing with no max_guests set at all isn't excluded by a
          // guest-count search — better to show it and let the guest
          // judge for themselves than to hide it over missing data.
          return capacity === null || capacity >= guestsFilter;
        })
      : listings;

    // A listing with no coordinates at all can't have a real distance
    // measured — rather than excluding it outright (punishing a data gap
    // that isn't the guest's problem), it falls back to a plain city/area
    // text match instead, same tolerance as the guest-count case above.
    // A listing WITH coordinates goes strictly by measured distance,
    // regardless of what its city/area text says — that's the actually
    // reliable signal once it exists.
    const filtered = distanceFilter
      ? afterGuestsFilter.filter(l => {
          if (l.latitude == null || l.longitude == null) {
            if (!cityRaw) return false;
            const needle = cityRaw.toLowerCase();
            return (l.city && l.city.toLowerCase().includes(needle)) || (l.area && l.area.toLowerCase().includes(needle));
          }
          const km = haversineDistanceKm(distanceFilter.lat, distanceFilter.lng, Number(l.latitude), Number(l.longitude));
          return km <= distanceFilter.radiusKm;
        })
      : afterGuestsFilter;

    // One extra query for all paid amenities across every listing being
    // returned, rather than one query per listing — cheaper, and this
    // endpoint can return many listings at once.
    if (filtered.length > 0) {
      const listingIds = filtered.map(l => l.id);
      const amenityRows = await sql`
        SELECT id, listing_id, name, description, price, available_from, available_until, excluded_weekdays
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
          availableUntil: a.available_until,
          excludedWeekdays: Array.isArray(a.excluded_weekdays) ? a.excluded_weekdays : []
        });
      }
      filtered.forEach(l => { l.paid_amenities = amenitiesByListing[l.id] || []; });

      // Active/upcoming promotions — same one-query-for-everyone pattern
      // as paid amenities just above. "Active" here means is_active AND
      // not yet ended (end_date > today), so a currently-running or
      // future-dated promotion shows, but a lapsed one quietly stops
      // appearing without the host needing to delete it. This is
      // teaser/display data only — create-order.js is what actually
      // recalculates and applies the discount at checkout, using the
      // guest's real selected dates, not anything read here.
      const promoRows = await sql`
        SELECT id, listing_id, name, discount_type, discount_value, min_nights, start_date, end_date
        FROM listing_promotions
        WHERE listing_id = ANY(${listingIds}) AND is_active = TRUE AND end_date > CURRENT_DATE
        ORDER BY start_date ASC
      `;
      const promotionsByListing = {};
      for (const p of promoRows) {
        if (!promotionsByListing[p.listing_id]) promotionsByListing[p.listing_id] = [];
        promotionsByListing[p.listing_id].push({
          id: p.id,
          name: p.name,
          discountType: p.discount_type,
          discountValue: p.discount_value,
          minNights: p.min_nights,
          startDate: toDateStr(p.start_date),
          endDate: toDateStr(p.end_date),
        });
      }
      filtered.forEach(l => { l.active_promotions = promotionsByListing[l.id] || []; });
    }

    return res.status(200).json({ listings: filtered });
  } catch (err) {
    console.error('get-listings error:', err);
    return res.status(500).json({ error: 'Could not fetch listings' });
  }
};
