// /api/_photo-location.js — every new stay photo must be taken at the
// property. Not an endpoint.
//
// Aerva policy: a listing's photos show that listing. A NEW photo on a
// stay (home, villa, resort, its rooms) is accepted only when it carries
// a location within MAX_KM of the listing's map pin:
//   • 'photo'  — the location the camera wrote into the photo (read in the
//                browser from the original file, before it is shrunk:
//                shrinking erases it);
//   • 'device' — the photo has none (phones strip it on upload), so the
//                browser asked for the host's current location while they
//                picked it: they are at the property;
//   • 'copied' — a photo already used on another listing whose pin is
//                within MAX_KM (Clone "with photos": a second unit in the
//                same building).
// Anything else is refused with the policy message and the save does not
// happen. The browser checks first (aerva-photo-location.js) so hosts
// learn at once; this is the rule that cannot be skipped.
//
// Photos already on a listing before this rule (they have no row in
// photo_locations) are left alone: their location was erased long ago.
// Experiences are not covered: their photos are often taken on the trail.
//
// A location can be faked with the right tools — this is strong evidence,
// not proof. Tables: sql/migration_photo_locations.sql. Before it runs,
// nothing is checked.

const MAX_KM = 2;
const POLICY_MESSAGE = 'Some photos don\'t comply with Aerva policies: every photo must be taken at the property. '
  + 'Use photos taken there with your camera\'s location turned on, or add them while you are at the property and allow location when asked.';

const isMissingTable = (err) => !!err && err.code === '42P01';
const num = (v) => (v === null || v === undefined || v === '') ? NaN : Number(v);
const validLat = (v) => Number.isFinite(num(v)) && Math.abs(num(v)) <= 90;
const validLng = (v) => Number.isFinite(num(v)) && Math.abs(num(v)) <= 180;

function distanceKm(a, b) {
  const R = 6371, rad = (d) => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Every URL string anywhere inside a value.
function urlsIn(value, out = new Set()) {
  if (typeof value === 'string') { if (/^https:\/\//.test(value.trim())) out.add(value.trim()); }
  else if (Array.isArray(value)) value.forEach(v => urlsIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => urlsIn(v, out));
  return out;
}

// The photos on a listing (and its rooms) right now.
async function photosOnListing(sql, listingId) {
  const urls = new Set();
  if (!listingId) return urls;
  const l = (await sql`SELECT cover_photo_url, photo_urls, photos, exterior_photo_urls, interior_photo_urls, pending_room_photos, pending_room_changes
                       FROM listings WHERE id = ${listingId}`)[0];
  if (l) urlsIn(l, urls);
  for (const r of await sql`SELECT cover_photo_url, photo_urls, pending_changes FROM listing_rooms WHERE listing_id = ${listingId}`) urlsIn(r, urls);
  return urls;
}

// A pin of another listing already showing this photo (Clone "with photos").
async function pinOfListingWith(sql, url, excludeListingId) {
  const rows = await sql`
    SELECT l.latitude, l.longitude FROM listings l
    WHERE l.id IS DISTINCT FROM ${excludeListingId || null} AND l.latitude IS NOT NULL AND l.longitude IS NOT NULL
      AND (strpos(COALESCE(l.cover_photo_url, '') || COALESCE(l.photo_urls::text, '') || COALESCE(l.exterior_photo_urls::text, '')
                  || COALESCE(l.interior_photo_urls::text, '') || COALESCE(l.pending_room_photos::text, ''), ${url}) > 0
           OR EXISTS (SELECT 1 FROM listing_rooms r WHERE r.listing_id = l.id
                        AND strpos(COALESCE(r.cover_photo_url, '') || COALESCE(r.photo_urls::text, ''), ${url}) > 0))
    LIMIT 1`;
  return rows[0] ? { lat: Number(rows[0].latitude), lng: Number(rows[0].longitude) } : null;
}

// What the browser sent for one photo, if usable.
function sentLocation(locations, url) {
  const l = locations && typeof locations === 'object' ? locations[url] : null;
  if (!l || typeof l !== 'object' || !validLat(l.lat) || !validLng(l.lng)) return null;
  const source = l.source === 'device' ? 'device' : 'photo';
  const accuracy = Number.isFinite(num(l.accuracy)) ? Math.max(0, Math.min(100000, num(l.accuracy))) : null;
  const takenAt = typeof l.takenAt === 'string' && !isNaN(Date.parse(l.takenAt)) ? new Date(l.takenAt).toISOString() : null;
  return { lat: num(l.lat), lng: num(l.lng), source, accuracy, takenAt };
}

// How far a located photo may be: 2 km, plus the phone's own uncertainty
// (capped at 500 m) for a device location.
const allowedKm = (loc) => MAX_KM + (loc.source === 'device' && loc.accuracy ? Math.min(loc.accuracy, 500) / 1000 : 0);

// Checks the photos of one save. urls: every stay photo URL the save
// would keep. pin: the listing's map pin after the save ({lat, lng}), or
// null when not chosen yet (a draft) — then only "has a location" is
// checked, and distance is checked at the save that has a pin.
// Returns { ok: true } or { ok: false, status, error, rejectedPhotos: [{ url, reason, km? }] }.
async function checkPhotoLocations(sql, { listingId = null, urls = [], pin = null, locations = null }) {
  const list = [...new Set((urls || []).filter(u => typeof u === 'string' && u.trim()).map(u => u.trim()))];
  if (!list.length) return { ok: true };
  let known;
  try {
    known = new Map((await sql`SELECT url, lat, lng, source, accuracy FROM photo_locations WHERE url = ANY(${list})`)
      .map(r => [r.url, { lat: Number(r.lat), lng: Number(r.lng), source: r.source, accuracy: r.accuracy == null ? null : Number(r.accuracy) }]));
  } catch (err) {
    if (isMissingTable(err)) return { ok: true };   // migration not run yet: nothing is checked
    throw err;
  }
  const havePin = pin && validLat(pin.lat) && validLng(pin.lng);
  const at = havePin ? { lat: num(pin.lat), lng: num(pin.lng) } : null;
  const onListing = await photosOnListing(sql, listingId);

  const rejected = [], toStore = [];
  for (const url of list) {
    let loc = known.get(url) || null;
    if (!loc) {
      if (onListing.has(url)) continue;                 // there before this rule: left alone
      loc = sentLocation(locations, url);
      if (!loc) {
        const other = await pinOfListingWith(sql, url, listingId);
        if (other) loc = { lat: other.lat, lng: other.lng, source: 'copied', accuracy: null, takenAt: null };
      }
      if (!loc) { rejected.push({ url, reason: 'no_location' }); continue; }
      toStore.push(Object.assign({ url }, loc));
    }
    if (at) {
      const km = distanceKm(at, loc);
      if (km > allowedKm(loc)) rejected.push({ url, reason: 'too_far', km: Math.round(km * 10) / 10 });
    }
  }
  if (rejected.length) {
    return { ok: false, status: 400, error: POLICY_MESSAGE, rejectedPhotos: rejected };
  }
  for (const s of toStore) {
    await sql`INSERT INTO photo_locations (url, lat, lng, source, accuracy, taken_at, listing_id)
              VALUES (${s.url}, ${s.lat}, ${s.lng}, ${s.source}, ${s.accuracy}, ${s.takenAt || null}, ${listingId || null})
              ON CONFLICT (url) DO NOTHING`;
  }
  return { ok: true, stored: toStore.length };
}

// For a brand-new listing: rows stored before its id existed get it now.
async function tagListing(sql, urls, listingId) {
  try {
    const list = [...new Set((urls || []).filter(Boolean))];
    if (list.length && listingId) await sql`UPDATE photo_locations SET listing_id = ${listingId} WHERE url = ANY(${list}) AND listing_id IS NULL`;
  } catch (err) { if (!isMissingTable(err)) console.error('photo_locations tag failed:', err.message || err); }
}

// For the admin review: each photo's recorded location and distance.
async function locationsFor(sql, urls, pin) {
  try {
    const list = [...new Set((urls || []).filter(Boolean))];
    if (!list.length) return {};
    const rows = await sql`SELECT url, lat, lng, source, taken_at FROM photo_locations WHERE url = ANY(${list})`;
    const havePin = pin && validLat(pin.lat) && validLng(pin.lng);
    const out = {};
    for (const r of rows) {
      out[r.url] = { source: r.source, takenAt: r.taken_at,
        km: havePin ? Math.round(distanceKm({ lat: num(pin.lat), lng: num(pin.lng) }, { lat: Number(r.lat), lng: Number(r.lng) }) * 10) / 10 : null };
    }
    return out;
  } catch (err) { if (isMissingTable(err)) return {}; throw err; }
}

module.exports = { checkPhotoLocations, tagListing, locationsFor, distanceKm, MAX_KM, POLICY_MESSAGE };
