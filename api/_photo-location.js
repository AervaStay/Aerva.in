// /api/_photo-location.js — where new stay photos were taken, for the
// admin to review. Not an endpoint.
//
// Hosts may upload photos from anywhere: nothing is refused for location
// (owner's decision, 1 Oct 2026 — it is the host's responsibility to show
// the right property). What Aerva does is RECORD where each new stay photo
// was taken, when the file says, so the admin can spot photos that are
// probably not of the property:
//   • 'photo'  — the location the camera wrote into the photo (read in the
//                browser from the original file, before it is shrunk:
//                shrinking erases it);
//   • 'copied' — a photo already used on another listing (Clone "with
//                photos"): that listing's pin;
//   • 'none'   — the file carries no location (phones usually strip it on
//                upload; screenshots and forwarded photos have none).
// Admin → Live Listings → "Photo locations to check" lists new photos taken
// more than MAX_KM from the listing's pin, or with no location.
//
// Photos already on a listing before this began have no row and are not
// listed. Experiences are not covered. A location can be faked — this is a
// hint for review, not proof. Table: sql/migration_photo_locations.sql;
// before it runs, nothing is recorded.

const MAX_KM = 2;

const isMissingTable = (err) => !!err && (err.code === '42P01' || err.code === '42703');
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
  const takenAt = typeof l.takenAt === 'string' && !isNaN(Date.parse(l.takenAt)) ? new Date(l.takenAt).toISOString() : null;
  return { lat: num(l.lat), lng: num(l.lng), source: 'photo', takenAt };
}

// Records where each NEW photo of one save was taken. urls: every stay
// photo URL the save keeps. Never refuses anything and never throws: a
// problem here must not stop a host saving.
async function recordPhotoLocations(sql, { listingId = null, urls = [], locations = null }) {
  try {
    const list = [...new Set((urls || []).filter(u => typeof u === 'string' && u.trim()).map(u => u.trim()))];
    if (!list.length) return { recorded: 0 };
    const known = new Set((await sql`SELECT url FROM photo_locations WHERE url = ANY(${list})`).map(r => r.url));
    const onListing = await photosOnListing(sql, listingId);
    let recorded = 0;
    for (const url of list) {
      if (known.has(url) || onListing.has(url)) continue;     // recorded before, or there before this began
      let loc = sentLocation(locations, url);
      if (!loc) {
        const other = await pinOfListingWith(sql, url, listingId);
        loc = other ? { lat: other.lat, lng: other.lng, source: 'copied', takenAt: null } : { lat: null, lng: null, source: 'none', takenAt: null };
      }
      await sql`INSERT INTO photo_locations (url, lat, lng, source, taken_at, listing_id)
                VALUES (${url}, ${loc.lat}, ${loc.lng}, ${loc.source}, ${loc.takenAt}, ${listingId || null})
                ON CONFLICT (url) DO NOTHING`;
      recorded++;
    }
    return { recorded };
  } catch (err) {
    if (!isMissingTable(err)) console.error('photo location record failed:', err.message || err);
    return { recorded: 0 };
  }
}

// For a brand-new listing: rows stored before its id existed get it now.
async function tagListing(sql, urls, listingId) {
  try {
    const list = [...new Set((urls || []).filter(Boolean))];
    if (list.length && listingId) await sql`UPDATE photo_locations SET listing_id = ${listingId} WHERE url = ANY(${list}) AND listing_id IS NULL`;
  } catch (err) { if (!isMissingTable(err)) console.error('photo_locations tag failed:', err.message || err); }
}

// One location against a pin: { status: 'at_property'|'too_far'|'no_location'|'no_pin', km? }.
function judgeLocation(loc, pin) {
  const havePin = pin && validLat(pin.lat) && validLng(pin.lng);
  if (!loc || !validLat(loc.lat) || !validLng(loc.lng)) return { status: 'no_location', ok: false };
  if (!havePin) return { status: 'no_pin', ok: true };
  const km = Math.round(distanceKm({ lat: num(pin.lat), lng: num(pin.lng) }, { lat: num(loc.lat), lng: num(loc.lng) }) * 10) / 10;
  return { status: km <= MAX_KM ? 'at_property' : 'too_far', ok: km <= MAX_KM, km };
}

// Admin → "Photo locations to check": new photos (last 90 days) still on a
// listing, taken more than MAX_KM from its pin or with no location,
// grouped by listing, newest first.
async function flaggedPhotoLocations(sql, { days = 90, limit = 100 } = {}) {
  let rows;
  try {
    rows = await sql`
      SELECT pl.url, pl.lat, pl.lng, pl.source, pl.taken_at, pl.created_at, pl.listing_id,
             l.property_name, l.host_name, l.host_email, l.latitude, l.longitude, l.status
      FROM photo_locations pl JOIN listings l ON l.id = pl.listing_id
      WHERE pl.created_at > now() - make_interval(days => ${days}) AND COALESCE(l.listing_type, 'stay') = 'stay'
      ORDER BY pl.created_at DESC LIMIT 2000`;
  } catch (err) { if (isMissingTable(err)) return []; throw err; }
  const byListing = new Map();
  for (const r of rows) {
    const pin = r.latitude != null && r.longitude != null ? { lat: Number(r.latitude), lng: Number(r.longitude) } : null;
    const j = judgeLocation(r.lat == null ? null : { lat: Number(r.lat), lng: Number(r.lng) }, pin);
    if (j.status !== 'too_far' && j.status !== 'no_location') continue;
    if (!byListing.has(r.listing_id)) byListing.set(r.listing_id, { listingId: r.listing_id, listingName: r.property_name, hostName: r.host_name, hostEmail: r.host_email, status: r.status, photos: [] });
    byListing.get(r.listing_id).photos.push({ url: r.url, status: j.status, km: j.km == null ? null : j.km, source: r.source, takenAt: r.taken_at, addedAt: r.created_at });
  }
  // Only photos still on the listing.
  const out = [];
  for (const g of byListing.values()) {
    const current = await photosOnListing(sql, g.listingId);
    g.photos = g.photos.filter(p => current.has(p.url));
    if (g.photos.length) out.push(g);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { recordPhotoLocations, tagListing, judgeLocation, flaggedPhotoLocations, distanceKm, MAX_KM };
