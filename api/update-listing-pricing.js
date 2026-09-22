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
const { readCohostManageToken } = require('./_cohosts');
const { findNameClashInPincode, nameClashMessage } = require('./_listing-rules');
const { timezoneForAddress } = require('./_timezones');
const { logAudit } = require('./_audit-log');
const { resolveSatisfiedComplianceFlags } = require('./_compliance');
const { sanitizeBody } = require('./_plain-text');
const { assertSafeUrl, syncFeed, newToken } = require('./_calendar-sync');
const { encryptField, decryptField, encryptionReady } = require('./_secure-fields');

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

// Two kinds of Manage link: the host's own ('manage-pricing'), and a
// co-host's ('manage-cohost', see _cohosts.js), which is checked against
// the cohosts table on every use — so it stops working the moment the
// co-host is removed or loses that listing — and can never rename it.
async function resolveManageAccess(req) {
  const token = req.method === 'GET' ? req.query.token : (req.body || {}).token;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return null;
  if (payload.action === 'manage-pricing') return { listingId: payload.listingId, isCohost: false };
  if (payload.action === 'manage-cohost') {
    const c = await readCohostManageToken(sql, payload);
    return c ? { listingId: c.listingId, isCohost: true, cohostId: c.cohostId } : null;
  }
  return null;
}

module.exports = async (req, res) => {
  // Typed text can never become markup — see _plain-text.js.
  sanitizeBody(req);

  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const access = await resolveManageAccess(req);
  const listingId = access ? access.listingId : null;
  if (!listingId) {
    return res.status(400).json({ error: 'This link is no longer valid. Contact hello@aerva.in if you need a new one.' });
  }

  // ---- Calendar sync (Manage page → Calendar sync) ----
  // GET  ?token&calendarSync=1                 → export links + linked calendars
  // POST { token, calendarSync: { action } }  → add | remove | syncNow | newLink
  // Hosts and co-hosts (their Manage link) alike. See _calendar-sync.js.
  const calMode = (req.method === 'GET' && req.query.calendarSync === '1') || (req.method === 'POST' && req.body && req.body.calendarSync);
  if (calMode) {
    const actor = access.isCohost ? { actorType: 'cohost', actorIdentifier: `cohost #${access.cohostId}` } : { actorType: 'host', actorIdentifier: `listing #${listingId}` };
    try {
      const listingRow = (await sql`SELECT id, property_name, property_type FROM listings WHERE id = ${listingId}`)[0];
      if (!listingRow) return res.status(404).json({ error: 'Listing not found.' });
      const rooms = await sql`SELECT id, room_name FROM listing_rooms WHERE listing_id = ${listingId} AND is_active = true ORDER BY sort_order, id`;
      const exportBase = 'https://aerva-in.vercel.app/api/get-listings?ical=';
      const loadState = async () => {
        await sql`UPDATE listings SET ical_token = ${newToken()} WHERE id = ${listingId} AND ical_token IS NULL`;
        for (const r of rooms) await sql`UPDATE listing_rooms SET ical_token = ${newToken()} WHERE id = ${r.id} AND ical_token IS NULL`;
        const lt = (await sql`SELECT ical_token FROM listings WHERE id = ${listingId}`)[0].ical_token;
        const rt = rooms.length ? await sql`SELECT id, ical_token FROM listing_rooms WHERE id = ANY(${rooms.map(r => r.id)})` : [];
        const feeds = await sql`SELECT f.id, f.name, f.room_id, f.url_host, f.last_synced_at, f.last_status, f.last_error, f.event_count, r.room_name
                                FROM calendar_feeds f LEFT JOIN listing_rooms r ON r.id = f.room_id WHERE f.listing_id = ${listingId} ORDER BY f.id`;
        return {
          exportLinks: [{ roomId: null, label: rooms.length ? 'Whole property' : listingRow.property_name, url: exportBase + lt }]
            .concat(rooms.map(r => ({ roomId: r.id, label: r.room_name, url: exportBase + (rt.find(x => x.id === r.id) || {}).ical_token }))),
          rooms: rooms.map(r => ({ id: r.id, name: r.room_name })),
          feeds: feeds.map(f => ({ id: f.id, name: f.name, room: f.room_name || null, site: f.url_host, lastSyncedAt: f.last_synced_at,
                                   status: f.last_status || 'pending', error: f.last_error || null, dates: f.event_count }))
        };
      };
      if (req.method === 'GET') return res.status(200).json(await loadState());

      const c = req.body.calendarSync || {};
      if (c.action === 'add') {
        if (!encryptionReady()) return res.status(503).json({ error: 'Calendar links cannot be saved right now. Please try again later.' });
        const name = String(c.name || '').trim().slice(0, 40);
        if (!name) return res.status(400).json({ error: 'Name the calendar, e.g. Airbnb.' });
        let u;
        try { u = await assertSafeUrl(c.url); } catch (e) { return res.status(400).json({ error: e.message }); }
        const roomId = c.roomId ? Number(c.roomId) : null;
        if (roomId && !rooms.some(r => r.id === roomId)) return res.status(400).json({ error: 'Choose one of this property’s rooms.' });
        const count = (await sql`SELECT count(*)::int AS n FROM calendar_feeds WHERE listing_id = ${listingId}`)[0].n;
        if (count >= 10) return res.status(400).json({ error: 'Up to 10 linked calendars per listing.' });
        const feed = (await sql`INSERT INTO calendar_feeds (listing_id, room_id, name, url_enc, url_host)
                                VALUES (${listingId}, ${roomId}, ${name}, ${encryptField(u.toString())}, ${u.hostname}) RETURNING *`)[0];
        const result = await syncFeed(sql, feed, decryptField);
        await logAudit(sql, { action: 'calendar_feed_added', success: true, ...actor, targetType: 'listing', targetId: listingId, metadata: { feedId: feed.id, site: u.hostname, firstSync: result.ok ? 'ok' : 'error' } });
        return res.status(200).json({ ...(await loadState()), result });
      }
      if (c.action === 'remove') {
        const del = await sql`DELETE FROM calendar_feeds WHERE id = ${Number(c.feedId) || 0} AND listing_id = ${listingId} RETURNING id`;
        if (!del.length) return res.status(404).json({ error: 'Calendar not found.' });
        await logAudit(sql, { action: 'calendar_feed_removed', success: true, ...actor, targetType: 'listing', targetId: listingId, metadata: { feedId: del[0].id } });
        return res.status(200).json(await loadState());
      }
      if (c.action === 'syncNow') {
        const feeds = await sql`SELECT * FROM calendar_feeds WHERE listing_id = ${listingId}`;
        const results = await Promise.race([
          Promise.all(feeds.map(f => syncFeed(sql, f, decryptField))),
          new Promise(r => setTimeout(() => r(null), 8000))
        ]);
        return res.status(200).json({ ...(await loadState()), synced: results ? results.filter(x => x.ok).length : null, total: feeds.length });
      }
      if (c.action === 'newLink') {
        const roomId = c.roomId ? Number(c.roomId) : null;
        if (roomId) {
          if (!rooms.some(r => r.id === roomId)) return res.status(400).json({ error: 'Choose one of this property’s rooms.' });
          await sql`UPDATE listing_rooms SET ical_token = ${newToken()} WHERE id = ${roomId}`;
        } else {
          await sql`UPDATE listings SET ical_token = ${newToken()} WHERE id = ${listingId}`;
        }
        await logAudit(sql, { action: 'calendar_export_link_replaced', success: true, ...actor, targetType: 'listing', targetId: listingId, metadata: { roomId } });
        return res.status(200).json(await loadState());
      }
      return res.status(400).json({ error: 'Unknown calendar action.' });
    } catch (err) {
      console.error('calendar sync mode failed:', err);
      return res.status(500).json({ error: 'Calendar sync is unavailable right now. Please try again.' });
    }
  }

  // ---- Load current pricing for the form ----
  // ---- Room-level availability for the next 30 days, for the Resort
  // calendar view (manage-listing.html's Calendar tab). Kept as its own
  // lightweight mode rather than folded into the main GET below — the
  // main GET already returns the full listing plus every room's own
  // details, but not per-room booked/blocked date RANGES, which this
  // specifically needs and the calendar UI polls independently of the
  // rest of the page.
  if (req.method === 'GET' && req.query.roomCalendar === '1') {
    try {
      const listingRows = await sql`SELECT id, property_name, property_type FROM listings WHERE id = ${listingId}`;
      const listing = listingRows[0];
      if (!listing) return res.status(404).json({ error: 'This listing could not be found.' });
      if (listing.property_type !== 'Resort') {
        return res.status(200).json({ propertyName: listing.property_name, rooms: [], startDate: null, days: 0 });
      }

      const rooms = await sql`
        SELECT id, room_name FROM listing_rooms
        WHERE listing_id = ${listingId} AND is_active = TRUE
        ORDER BY sort_order ASC, created_at ASC
      `;

      const DAYS = 30;
      const startDate = new Date();
      startDate.setUTCHours(0, 0, 0, 0);
      const endDate = new Date(startDate);
      endDate.setUTCDate(endDate.getUTCDate() + DAYS);
      const startStr = startDate.toISOString().slice(0, 10);
      const endStr = endDate.toISOString().slice(0, 10);

      const roomsWithRanges = [];
      for (const room of rooms) {
        const bookedRows = await sql`
          SELECT id, arrival AS start_date, departure AS end_date, guest_email, guests, nights, total
          FROM orders
          WHERE room_id = ${room.id} AND status = 'paid'
            AND arrival < ${endStr}::date AND departure > ${startStr}::date
          ORDER BY arrival ASC
        `;
        const blockedRows = await sql`
          SELECT start_date, end_date, reason
          FROM listing_blocked_dates
          WHERE listing_id = ${listingId} AND (room_id = ${room.id} OR room_id IS NULL)
            AND start_date < ${endStr}::date AND end_date > ${startStr}::date
          ORDER BY start_date ASC
        `;
        roomsWithRanges.push({
          id: room.id,
          roomName: room.room_name,
          ranges: [
            ...bookedRows.map(r => ({
              start: r.start_date, end: r.end_date, type: 'booked', label: r.guest_email || 'Booked',
              orderId: r.id, guestEmail: r.guest_email, guests: r.guests, nights: r.nights, total: r.total
            })),
            ...blockedRows.map(r => ({ start: r.start_date, end: r.end_date, type: 'blocked', label: r.reason || 'Blocked' })),
          ]
        });
      }

      return res.status(200).json({ propertyName: listing.property_name, rooms: roomsWithRanges, startDate: startStr, days: DAYS });
    } catch (err) {
      console.error('update-listing-pricing (roomCalendar) error:', err);
      return res.status(500).json({ error: 'Could not load the room calendar right now.' });
    }
  }

  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT id, property_name, property_type, bedrooms, city, area, nightly_rate, discount_type, discount_value, discount_min_nights, discount_description,
               exterior_photo_urls, interior_photo_urls, cover_photo_url, amenities, services,
               latitude, longitude, formatted_address, pincode,
               pet_friendly, max_pets_allowed, allowed_pet_types, pet_fee, security_deposit,
               experience_price_unit, commission_rate,
               check_in_time, check_out_time, wifi_name, wifi_password, access_code,
               auto_send_checkin_instructions, checkin_photos, status, rooms_pending_review, status_before_compliance_block, admin_status_reason,
               COALESCE(to_jsonb(listings)->>'cancellation_policy', 'flexible') AS cancellation_policy
        FROM listings WHERE id = ${listingId}
      `;
      const listing = rows[0];
      if (!listing) return res.status(404).json({ error: 'This listing could not be found.' });

      const paidAmenities = await sql`
        SELECT id, name, description, price, available_from, available_until, excluded_weekdays, is_active
        FROM listing_amenities WHERE listing_id = ${listingId} ORDER BY created_at ASC
      `;

      // Listing-level rows only (room_id IS NULL). Per-room blocks are
      // created and managed on the Status page; loading them here made
      // the dashboard treat a "Room 2 is blocked" row as if the whole
      // listing were blocked, and its full-replace save could then
      // delete or flatten them.
      const blockedDates = await sql`
        SELECT id, start_date, end_date, reason
        FROM listing_blocked_dates
        WHERE listing_id = ${listingId} AND room_id IS NULL
        ORDER BY start_date ASC
      `;

      const promotions = await sql`
        SELECT id, name, discount_type, discount_value, min_nights, start_date, end_date, is_active
        FROM listing_promotions WHERE listing_id = ${listingId} ORDER BY start_date ASC
      `;

      const customFields = await sql`
        SELECT id, field_label, field_value FROM listing_custom_fields
        WHERE listing_id = ${listingId} ORDER BY sort_order ASC, created_at ASC
      `;

      // Only meaningful for property_type = 'Resort' — a regular
      // single-unit listing has no rooms at all, this just comes back
      // empty for those.
      const rooms = await sql`
        SELECT id, room_name, max_occupancy, nightly_rate, description, cover_photo_url, photo_urls, is_active, pending_review, pending_changes, last_rejection_reason, last_rejected_at
        FROM listing_rooms WHERE listing_id = ${listingId} ORDER BY sort_order ASC, created_at ASC
      `;

      return res.status(200).json({ listing, paidAmenities, blockedDates, promotions, customFields, rooms });
    } catch (err) {
      console.error('update-listing-pricing (GET) error:', err);
      return res.status(500).json({ error: 'Could not load your listing right now. Please try again.' });
    }
  }

  // ---- Save changes ----
  if (req.method === 'POST') {
    try {
      // A host can withdraw a pending change on ONE specific room at any
      // time — scoped to that room only now, not the whole listing's
      // rooms, matching the same per-room granularity the staging logic
      // itself uses. A brand-new room that was never live gets removed
      // entirely (nothing to "restore" it to); an edit to a previously-
      // live room instead reverts it back to active, undoing the
      // temporary deactivation, since withdrawing the edit means it
      // should keep operating exactly as it did before the edit attempt.
      if (req.body && req.body.cancelPendingRoomChangeForRoomId) {
        const roomRows = await sql`
          SELECT id, pending_changes, listing_id FROM listing_rooms
          WHERE id = ${Number(req.body.cancelPendingRoomChangeForRoomId)} AND listing_id = ${listingId} AND pending_review = TRUE
        `;
        const room = roomRows[0];
        if (!room) return res.status(404).json({ error: 'No pending change was found for that room.' });
        const hostRows = await sql`SELECT host_email FROM listings WHERE id = ${listingId}`;
        // A brand-new room's pending_changes holds only its
        // newRoomIntendedActive marker (see the insert above) — nothing
        // to "restore" it to, since it never had a prior live state, so
        // withdrawing it means deleting it outright. An edit to a
        // previously-live room instead reverts to active, since
        // withdrawing the edit means the room keeps operating exactly as
        // it did before the edit attempt.
        const isNewRoomProposal = room.pending_changes && Object.prototype.hasOwnProperty.call(room.pending_changes, 'newRoomIntendedActive');
        if (isNewRoomProposal) {
          await sql`DELETE FROM listing_rooms WHERE id = ${room.id}`;
        } else {
          await sql`UPDATE listing_rooms SET pending_changes = NULL, pending_review = FALSE, pending_since = NULL, is_active = TRUE WHERE id = ${room.id}`;
        }
        await logAudit(sql, {
          action: 'room_change_cancelled', success: true, actorType: 'host', actorIdentifier: hostRows[0] ? hostRows[0].host_email : null,
          targetType: 'listing_room', targetId: room.id, metadata: { listingId }
        });
        return res.status(200).json({ success: true });
      }

      const { propertyName, nightlyRate, discountType, discountValue, discountMinNights, discountDescription,
              exteriorPhotoUrls, interiorPhotoUrls, coverPhotoUrl, amenities, services, paidAmenities, blockedDates, blockedDatesLoadedIds, promotions,
              latitude, longitude, formattedAddress, city, area, pincode, maxGuests,
              petFriendly, maxPetsAllowed, allowedPetTypes, petFee, securityDeposit, experiencePriceUnit,
              checkInTime, checkOutTime, wifiName, wifiPassword, accessCode,
              customFields, autoSendCheckinInstructions, checkinPhotos, rooms, bedrooms, cancellationPolicy } = req.body || {};

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

      // ---- Name, and one property name per pincode ----
      // A host may rename their listing here, and may change its pincode.
      // Either can collide with another property, so both are checked
      // against the name that will actually be stored — the same rule and
      // the same message as submission (see _listing-rules.js).
      const meRows = await sql`SELECT property_name, pincode, listing_type, property_type FROM listings WHERE id = ${listingId}`;
      const me = meRows[0];
      // Only the host renames a listing. A co-host's save keeps the
      // current name whatever the form sent.
      const safeName = !access.isCohost && typeof propertyName === 'string' && propertyName.trim()
        ? propertyName.trim().slice(0, 120)
        : null;
      if (!access.isCohost && propertyName !== undefined && !safeName) {
        return res.status(400).json({ error: 'Please give this listing a name guests will recognise.' });
      }
      const newPincode = typeof pincode === 'string' && pincode.trim() ? pincode.trim().slice(0, 20) : null;
      if (me && (me.listing_type || 'stay') === 'stay') {
        const finalName = safeName || me.property_name;
        const finalPincode = newPincode || String(me.pincode || '').trim();
        const nameChanged = safeName && safeName.toLowerCase() !== String(me.property_name || '').trim().toLowerCase();
        const pincodeChanged = newPincode && newPincode !== String(me.pincode || '').trim();
        if (nameChanged || pincodeChanged) {
          const clash = await findNameClashInPincode(sql, {
            propertyName: finalName, pincode: finalPincode, propertyType: me.property_type,
            excludeListingId: listingId
          });
          if (clash) {
            return res.status(409).json({ error: nameClashMessage(finalName, finalPincode) });
          }
        }
      }

      const before = await sql`
        SELECT nightly_rate, exterior_photo_urls, interior_photo_urls,
               pet_friendly, max_pets_allowed, allowed_pet_types, pet_fee, security_deposit,
               property_type, bedrooms, status, rooms_pending_review, status_before_compliance_block
        FROM listings WHERE id = ${listingId}
      `;
      if (!before[0]) return res.status(404).json({ error: 'This listing could not be found.' });
      // A listing auto-blocked by the compliance system (see
      // _compliance.js) is a deliberate exception to "must be approved
      // to manage" below — the whole point of that block is to give the
      // host a way to fix the specific issue and get automatically
      // restored, so locking them out of the one page that lets them fix
      // it would defeat the entire mechanism. A listing an admin blocked
      // manually for an unrelated reason (status_before_compliance_block
      // is NULL in that case) still correctly stays locked.
      const isComplianceBlocked = before[0].status === 'blocked' && before[0].status_before_compliance_block;
      if (before[0].status !== 'approved' && !isComplianceBlocked) {
        return res.status(403).json({
          error: before[0].status === 'rejected'
            ? 'This listing was not approved and needs to be resubmitted before it can be managed here. Please contact hello@aerva.in if you have questions about the rejection.'
            : 'Your listing is still awaiting review — you\'ll be able to manage your rooms and pricing here once it\'s approved.'
        });
      }
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

      // Guest-info fields — used to fill in @checkin/@checkout/@wifiname/
      // @wifipassword/@accesscode when a host inserts a quick-reply
      // template (see guest-profile.js's myConversations / index.html's
      // template-placeholder resolver). Same "undefined = not sent this
      // time, leave alone" pattern as location above — an unrelated
      // price-only save shouldn't blank these out. An explicit empty
      // string, though, does clear the field (a host removing a value
      // they'd set before).
      const safeCheckInTime = typeof checkInTime === 'string' ? checkInTime.trim().slice(0, 50) : undefined;
      const safeCheckOutTime = typeof checkOutTime === 'string' ? checkOutTime.trim().slice(0, 50) : undefined;
      const safeWifiName = typeof wifiName === 'string' ? wifiName.trim().slice(0, 100) : undefined;
      const safeWifiPassword = typeof wifiPassword === 'string' ? wifiPassword.trim().slice(0, 100) : undefined;
      const safeAccessCode = typeof accessCode === 'string' ? accessCode.trim().slice(0, 100) : undefined;

      // Capped at 3 regardless of what's submitted — enforced here, not
      // just in the UI, since the UI cap is trivially bypassable by
      // anyone calling this endpoint directly. Always a full overwrite
      // (like paid amenities/custom fields above), not a COALESCE — the
      // manage-listing.html form always submits its complete current
      // state for this field, so an empty array here genuinely means
      // "no check-in photos," not "wasn't touched this time."
      const safeCheckinPhotos = Array.isArray(checkinPhotos)
        ? checkinPhotos
            .filter(p => p && typeof p.url === 'string' && p.url.trim())
            .slice(0, 3)
            .map(p => ({ caption: typeof p.caption === 'string' ? p.caption.trim().slice(0, 80) : '', url: p.url.trim() }))
        : [];

      // Declared room count — same "Bedrooms" field submitted at listing
      // creation, relabeled "Number of Rooms" for a Resort (see
      // index.html's listType change handler). Same "not sent this time,
      // leave alone" convention as the guest-info fields above. No
      // longer validated against the actual room count — manage-
      // listing.html now sends this as simply however many active rooms
      // exist when saving, computed automatically rather than a number
      // the host has to separately declare and keep in sync by hand.
      const finalBedrooms = (bedrooms !== undefined && bedrooms !== null && bedrooms !== '')
        ? Number(bedrooms) : before[0].bedrooms;

      const updated = await sql`
        UPDATE listings SET
          nightly_rate = ${rate},
          property_name = COALESCE(${safeName}, property_name),
          -- Re-derived whenever the address changes: a listing that moves
          -- country must move clock with it.
          timezone = COALESCE(${typeof formattedAddress === 'string' && formattedAddress.trim() ? timezoneForAddress(formattedAddress) : null}, timezone),
          city = ${safeCity}, area = ${safeArea},
          bedrooms = ${finalBedrooms},
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
          pincode = COALESCE(${typeof pincode === 'string' && pincode.trim() ? pincode.trim().slice(0, 20) : null}, pincode),
          max_guests = COALESCE(${(maxGuests !== undefined && maxGuests !== null && String(maxGuests).trim() && Number(maxGuests) > 0) ? String(Math.floor(Number(maxGuests))) : null}, max_guests),
          pet_friendly = ${finalPetFriendly}, max_pets_allowed = ${finalMaxPets},
          allowed_pet_types = ${JSON.stringify(finalPetTypes)}, pet_fee = ${finalPetFee},
          security_deposit = ${finalSecurityDeposit},
          experience_price_unit = COALESCE(${(experiencePriceUnit === 'per_person' || experiencePriceUnit === 'flat') ? experiencePriceUnit : null}, experience_price_unit),
          check_in_time = COALESCE(${safeCheckInTime ?? null}, check_in_time),
          check_out_time = COALESCE(${safeCheckOutTime ?? null}, check_out_time),
          wifi_name = COALESCE(${safeWifiName ?? null}, wifi_name),
          wifi_password = COALESCE(${safeWifiPassword ?? null}, wifi_password),
          access_code = COALESCE(${safeAccessCode ?? null}, access_code),
          auto_send_checkin_instructions = ${autoSendCheckinInstructions === true},
          checkin_photos = ${JSON.stringify(safeCheckinPhotos)}
        WHERE id = ${listingId}
        RETURNING id, property_name, host_email, max_guests
      `;
      const listing = updated[0];

      // Refund policy (Flexible / Firm). Applies to NEW bookings only: each
      // paid booking keeps the policy it was bought under (_cancellations.js).
      // Separate from the save above so the save still works before
      // migration_cancellation_policy.sql has run.
      if (cancellationPolicy === 'flexible' || cancellationPolicy === 'firm') {
        try { await sql`UPDATE listings SET cancellation_policy = ${cancellationPolicy} WHERE id = ${listingId}`; }
        catch (err) { console.error('cancellation_policy not saved (run migration_cancellation_policy.sql):', err.message); }
      }

      if (rateChanged) {
        await sql`INSERT INTO price_history (listing_id, nightly_rate) VALUES (${listingId}, ${rate})`;
      }

      // Checked right after the save that actually changed max_guests
      // (among possibly other fields) — resolves any open compliance
      // flag on THIS listing now satisfied, restoring it from an auto-
      // block if every flag that caused it is now clear. Never blocks or
      // fails the save itself either way (see _compliance.js).
      await resolveSatisfiedComplianceFlags(sql, listingId, { max_guests: listing.max_guests });

      // ---- Sync dynamic custom check-in fields: same "submitted array
      // is the full set" pattern as paid amenities below — matched rows
      // update, unmatched-id rows are new, anything no longer present
      // gets deleted. Order preserved via each row's position in the array.
      if (Array.isArray(customFields)) {
        try {
          const existingFieldRows = await sql`SELECT id FROM listing_custom_fields WHERE listing_id = ${listingId}`;
          const existingFieldIds = new Set(existingFieldRows.map(r => r.id));
          const submittedFieldIds = new Set();

          for (let i = 0; i < customFields.length; i++) {
            const f = customFields[i];
            const label = typeof f.label === 'string' ? f.label.trim().slice(0, 80) : '';
            if (!label) continue; // a field with no label isn't meaningful — skip rather than fail the whole save
            const value = typeof f.value === 'string' ? f.value.trim().slice(0, 300) : '';

            if (f.id && existingFieldIds.has(Number(f.id))) {
              await sql`
                UPDATE listing_custom_fields SET field_label = ${label}, field_value = ${value}, sort_order = ${i}
                WHERE id = ${Number(f.id)} AND listing_id = ${listingId}
              `;
              submittedFieldIds.add(Number(f.id));
            } else {
              await sql`
                INSERT INTO listing_custom_fields (listing_id, field_label, field_value, sort_order)
                VALUES (${listingId}, ${label}, ${value}, ${i})
              `;
            }
          }
          const fieldIdsToDelete = [...existingFieldIds].filter(id => !submittedFieldIds.has(id));
          if (fieldIdsToDelete.length) {
            await sql`DELETE FROM listing_custom_fields WHERE id = ANY(${fieldIdsToDelete}) AND listing_id = ${listingId}`;
          }
        } catch (fieldErr) {
          console.error('Custom check-in fields sync failed:', fieldErr);
          // Doesn't fail the whole save — the rest of the listing's
          // changes (price, photos, etc.) already succeeded above.
        }
      }

      // ---- Sync resort rooms — was previously "harmless no-op for
      // anything else, since the array would just be empty," but that
      // assumption broke the moment recomputing nightly_rate (below)
      // was added: manage-listing.html always sends rooms:[] for every
      // non-Resort save too (roomRows is simply never populated for
      // those), and an unconditional recompute would have overwritten
      // every regular listing's real price with NULL on its very next
      // save. Explicitly gated on property_type now, not just array
      // presence. Same "submitted array is the full set" pattern as
      // custom fields above. Each room carries its own price and
      // occupancy limit — that's what makes a resort's rooms
      // independently bookable and independently priced, rather than
      // one blended rate for the whole property.
      let roomsWarning = null;
      if (Array.isArray(rooms) && before[0].property_type === 'Resort') {
        try {
          const existingActiveRoomCount = await sql`SELECT COUNT(*)::int AS count FROM listing_rooms WHERE listing_id = ${listingId} AND is_active = TRUE`;
          // First-time setup (completing what approval's pre-population
          // may have missed, or a resort that had none staged at
          // submission) applies directly — there's nothing live yet for
          // a change to override. Once real, active rooms exist, any
          // further change is staged for admin review instead — see the
          // else branch below. Rooms already awaiting review can't be
          // edited again until that review finishes, so the admin isn't
          // reviewing a moving target.
          if (existingActiveRoomCount[0].count === 0) {

          const existingRoomRows = await sql`SELECT id FROM listing_rooms WHERE listing_id = ${listingId}`;
          const existingRoomIds = new Set(existingRoomRows.map(r => r.id));
          const submittedRoomIds = new Set();
          // Tracked so the host gets told explicitly which rooms didn't
          // save, rather than a room with real photos/pricing silently
          // never making it into the database with no error at all —
          // that used to be the only outcome here.
          const skippedRoomLabels = [];

          for (let i = 0; i < rooms.length; i++) {
            const r = rooms[i];
            const roomName = typeof r.roomName === 'string' ? r.roomName.trim().slice(0, 100) : '';
            const maxOccupancy = Number(r.maxOccupancy);
            const roomRate = Number(r.nightlyRate);
            // A room missing a name, a real occupancy limit, or a real
            // price isn't meaningful to save — skipped rather than
            // failing the whole listing save over one incomplete row
            // (a host might genuinely still be mid-way through setting
            // up a different room and just wants to save progress on
            // the rest).
            if (!roomName || !maxOccupancy || maxOccupancy < 1 || !roomRate || roomRate <= 0) {
              const hasAnyPhotos = Array.isArray(r.photos) && r.photos.some(p => p && typeof p.url === 'string' && p.url.trim());
              if (hasAnyPhotos || maxOccupancy > 0 || roomRate > 0) {
                skippedRoomLabels.push(roomName || `Room ${i + 1}`);
              }
              continue;
            }
            const description = typeof r.description === 'string' ? r.description.trim().slice(0, 500) : '';
            // A room's whole gallery — no forced washroom/balcony
            // labeling, just however many photos the host added. First
            // photo becomes cover_photo_url (what shows on cards/search
            // results); the rest live in photo_urls for that room's own
            // detail view.
            const safeUrls = Array.isArray(r.photos)
              ? r.photos.filter(p => p && typeof p.url === 'string' && p.url.trim()).map(p => p.url.trim())
              : [];
            const coverPhotoUrl = safeUrls[0] || null;
            const photoUrls = safeUrls.slice(1).map(url => ({ url }));
            // A room without at least one photo is saved (so the host
            // doesn't lose their other entered data), but forced
            // inactive regardless of what was requested — not bookable
            // by guests until a photo is actually added. Defense-in-
            // depth alongside the declared-room-count check above, which
            // normally catches this first when a real count is set.
            const isActive = r.isActive !== false && !!coverPhotoUrl;

            if (r.id && existingRoomIds.has(Number(r.id))) {
              await sql`
                UPDATE listing_rooms SET room_name = ${roomName}, max_occupancy = ${maxOccupancy},
                  nightly_rate = ${roomRate}, description = ${description}, is_active = ${isActive}, sort_order = ${i},
                  cover_photo_url = COALESCE(${coverPhotoUrl}, cover_photo_url),
                  photo_urls = ${JSON.stringify(photoUrls)}
                WHERE id = ${Number(r.id)} AND listing_id = ${listingId}
              `;
              submittedRoomIds.add(Number(r.id));
            } else {
              await sql`
                INSERT INTO listing_rooms (listing_id, room_name, max_occupancy, nightly_rate, description, is_active, sort_order, cover_photo_url, photo_urls)
                VALUES (${listingId}, ${roomName}, ${maxOccupancy}, ${roomRate}, ${description}, ${isActive}, ${i}, ${coverPhotoUrl}, ${JSON.stringify(photoUrls)})
              `;
            }
          }
          // Deliberately NOT deleted, even if removed from the submitted
          // array — a room with past or future paid bookings against it
          // (orders.room_id) shouldn't disappear and orphan that
          // history, same reasoning listings themselves are never hard-
          // deleted elsewhere in this codebase. Marking is_active=false
          // (by simply omitting it from the form) is the intended way
          // to retire a room instead.
          const roomIdsNoLongerSubmitted = [...existingRoomIds].filter(id => !submittedRoomIds.has(id));
          if (roomIdsNoLongerSubmitted.length) {
            await sql`UPDATE listing_rooms SET is_active = false WHERE id = ANY(${roomIdsNoLongerSubmitted}) AND listing_id = ${listingId}`;
          }
          // The listing's own nightly_rate — what actually drives the
          // "From ₹X/night" card display, price filtering, and sorting
          // everywhere on the site — is the lowest ACTIVE room price,
          // recomputed fresh here. A host editing one room's price later
          // (the very reason this Rooms tab exists) would otherwise
          // leave the card showing a stale number from whatever it was
          // at initial approval, or from a room that's since gone
          // inactive.
          const cheapestActiveRoom = await sql`
            SELECT MIN(nightly_rate) AS min_rate FROM listing_rooms
            WHERE listing_id = ${listingId} AND is_active = TRUE AND nightly_rate IS NOT NULL
          `;
          await sql`UPDATE listings SET nightly_rate = ${cheapestActiveRoom[0].min_rate} WHERE id = ${listingId}`;
          if (skippedRoomLabels.length) {
            roomsWarning = `${skippedRoomLabels.join(', ')} ${skippedRoomLabels.length === 1 ? 'has' : 'have'} photos or pricing but weren't saved — each room needs a name, max guests, and price to be saved.`;
          }

          } else {
            // Real, active rooms already exist — this resort is live and
            // bookable. Per-room now, not per-listing: removing a room
            // needs no review at all (just deactivated immediately,
            // below); a genuinely new room is staged inactive on its
            // own, never touching any other room's availability; and
            // editing an existing room stages just THAT room's proposed
            // changes and deactivates only it, leaving every other room
            // — including ones the host hasn't touched at all — fully
            // bookable throughout. The whole-listing freeze this used to
            // do meant one room edit could block bookings on rooms
            // nobody was even changing.
            const currentRoomsForCompare = await sql`
              SELECT id, room_name, max_occupancy, nightly_rate, description, is_active, cover_photo_url, photo_urls, pending_review
              FROM listing_rooms WHERE listing_id = ${listingId}
            `;
            const currentById = new Map(currentRoomsForCompare.map(r => [r.id, r]));
            function submittedRoomPhotoUrls(r){
              return Array.isArray(r.photos)
                ? r.photos.filter(p => p && typeof p.url === 'string' && p.url.trim()).map(p => p.url.trim())
                : [];
            }
            function currentRoomPhotoUrls(r){
              const rest = Array.isArray(r.photo_urls) ? r.photo_urls.map(p => p && p.url).filter(Boolean) : [];
              return r.cover_photo_url ? [r.cover_photo_url, ...rest] : rest;
            }

            const submittedIds = new Set();
            const roomsStagedForReview = [];
            const roomsSkippedAlreadyPending = [];

            for (let i = 0; i < rooms.length; i++) {
              const r = rooms[i];
              const roomName = typeof r.roomName === 'string' ? r.roomName.trim().slice(0, 100) : '';
              const maxOccupancy = Number(r.maxOccupancy) || null;
              const roomRate = Number(r.nightlyRate) || null;
              const description = typeof r.description === 'string' ? r.description.trim().slice(0, 500) : '';
              const isActive = r.isActive !== false;
              const photos = submittedRoomPhotoUrls(r);
              const coverPhotoUrl = photos[0] || null;
              const photoUrls = photos.slice(1).map(url => ({ url }));

              if (r.id && currentById.has(Number(r.id))) {
                submittedIds.add(Number(r.id));
                const cur = currentById.get(Number(r.id));
                // A room already awaiting review on its own is left
                // completely alone here — same reasoning the old
                // listing-wide guard had, just scoped down to this one
                // room instead of freezing every room over it.
                if (cur.pending_review) {
                  roomsSkippedAlreadyPending.push(cur.room_name || roomName || `Room ${i + 1}`);
                  continue;
                }
                const curPhotos = currentRoomPhotoUrls(cur);
                const samePhotos = photos.length === curPhotos.length && photos.every((url, idx) => url === curPhotos[idx]);
                const hasChange = (
                  roomName !== (cur.room_name || '') ||
                  maxOccupancy !== (cur.max_occupancy == null ? null : Number(cur.max_occupancy)) ||
                  roomRate !== (cur.nightly_rate == null ? null : Number(cur.nightly_rate)) ||
                  description !== (cur.description || '') ||
                  isActive !== cur.is_active ||
                  !samePhotos
                );
                if (!hasChange) continue; // genuinely unchanged — left completely untouched
                // Staged onto this one room only: its OWN current fields
                // (room_name, price, etc.) stay exactly as they are —
                // that's what "still live" means for this room's
                // existing bookings and search visibility — while the
                // proposal sits in pending_changes. Deactivated per the
                // requirement that an edited room shouldn't stay
                // bookable with details that no longer reflect what it
                // actually looks like right now.
                await sql`
                  UPDATE listing_rooms SET
                    pending_changes = ${JSON.stringify({ roomName, maxOccupancy, nightlyRate: roomRate, description, isActive, coverPhotoUrl, photoUrls })},
                    pending_review = TRUE, pending_since = now(), is_active = FALSE,
                    last_rejection_reason = NULL, last_rejected_at = NULL
                  WHERE id = ${Number(r.id)} AND listing_id = ${listingId}
                `;
                roomsStagedForReview.push(roomName || cur.room_name || `Room ${i + 1}`);
              } else {
                // A genuinely new room — nothing existing to compare
                // against or deactivate. Inserted directly as inactive
                // and pending; it simply doesn't exist yet as far as
                // guests or other rooms are concerned, so there's no
                // "other rooms unaffected" consideration needed here —
                // there's nothing for it to affect.
                if (!roomName || !maxOccupancy || maxOccupancy < 1 || !roomRate || roomRate <= 0) continue; // incomplete — not worth staging yet
                // pending_changes here holds just the host's intended
                // active/inactive preference — everything else about a
                // brand-new room already lives directly in its own
                // fields, but is_active itself is forced false while
                // pending (see below), so this is the only value that
                // would otherwise be lost by approval time.
                await sql`
                  INSERT INTO listing_rooms (listing_id, room_name, max_occupancy, nightly_rate, description, is_active, sort_order, cover_photo_url, photo_urls, pending_review, pending_since, pending_changes)
                  VALUES (${listingId}, ${roomName}, ${maxOccupancy}, ${roomRate}, ${description}, FALSE, ${i}, ${coverPhotoUrl}, ${JSON.stringify(photoUrls)}, TRUE, now(), ${JSON.stringify({ newRoomIntendedActive: isActive })})
                `;
                roomsStagedForReview.push(roomName);
              }
            }
            // Removing a room needs no review — deactivated immediately.
            // A host taking a room out of service isn't introducing
            // anything new that needs vetting, and holding this back
            // pending admin approval would mean a room the host actively
            // wants OFF the market stays bookable in the meantime, the
            // opposite of what they asked for.
            const roomIdsRemoved = [...currentById.keys()].filter(id => !submittedIds.has(id) && !currentById.get(id).pending_review);
            if (roomIdsRemoved.length) {
              await sql`UPDATE listing_rooms SET is_active = FALSE WHERE id = ANY(${roomIdsRemoved}) AND listing_id = ${listingId}`;
            }

            const cheapestActiveRoom = await sql`
              SELECT MIN(nightly_rate) AS min_rate FROM listing_rooms
              WHERE listing_id = ${listingId} AND is_active = TRUE AND nightly_rate IS NOT NULL
            `;
            await sql`UPDATE listings SET nightly_rate = ${cheapestActiveRoom[0].min_rate} WHERE id = ${listingId}`;

            const warningParts = [];
            if (roomsStagedForReview.length) {
              warningParts.push(`${roomsStagedForReview.join(', ')} ${roomsStagedForReview.length === 1 ? 'is' : 'are'} awaiting admin review and temporarily unavailable to guests until approved — every other room is unaffected and stays bookable.`);
              await logAudit(sql, {
                action: 'room_changes_submitted', success: true, actorType: 'host', actorIdentifier: listing.host_email,
                targetType: 'listing', targetId: listingId, metadata: { rooms: roomsStagedForReview }
              });
            }
            if (roomsSkippedAlreadyPending.length) {
              warningParts.push(`${roomsSkippedAlreadyPending.join(', ')} already ${roomsSkippedAlreadyPending.length === 1 ? 'has' : 'have'} a change awaiting review — that submission was left as-is rather than being overwritten.`);
            }
            if (warningParts.length) roomsWarning = warningParts.join(' ');
          }
        } catch (roomErr) {
          console.error('Resort rooms sync failed:', roomErr);
          // Doesn't fail the whole save — same as custom fields above.
        }
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
          // Only listing-level rows are in scope — a per-room block made
          // on the Status page is never touched by this save.
          const existingRows = await sql`SELECT id FROM listing_blocked_dates WHERE listing_id = ${listingId} AND room_id IS NULL`;
          const existingIds = new Set(existingRows.map(r => r.id));
          const submittedIds = new Set();

          // The stale-overwrite guard. The dashboard holds a copy of the
          // blocks from when the page loaded; if the host blocks dates on
          // the Status page in the meantime, those rows exist in the
          // database but not in the dashboard's copy. Deleting "anything
          // not resubmitted" (the old behaviour) silently wiped them.
          // Now the client says which ids it loaded, and only THOSE can be
          // deleted — rows created since load survive untouched. If an
          // older client doesn't send the list, fall back to the previous
          // behaviour, but still scoped to listing-level rows.
          const loadedIds = Array.isArray(blockedDatesLoadedIds)
            ? new Set(blockedDatesLoadedIds.map(Number).filter(Number.isFinite))
            : null;

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
                WHERE id = ${Number(b.id)} AND listing_id = ${listingId} AND room_id IS NULL
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

          const idsToDelete = [...existingIds].filter(id =>
            !submittedIds.has(id) && (loadedIds === null || loadedIds.has(id))
          );
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

      const warning = [paidAmenitiesError, blockedDatesError, promotionsError, roomsWarning].filter(Boolean).join(' ') || undefined;
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
