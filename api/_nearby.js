// /api/_nearby.js — "Nearby": things to do and getting around, for a
// listing. Not an endpoint (get-listings.js ?nearby=<listingId>).
//
// THE OWNER'S ASK (9 Nov 2026): what can be done in and around the
// property's city, and public transport (metro, trains, buses), taxis and
// airports — from a FREE source, each with a link to a third-party page.
// Aerva has no responsibility of any kind for third parties (fraud,
// violence or any other situation): before any third-party link opens,
// the guest is shown that and agrees, and the agreement is recorded
// (recordConsent; aerva.js aervaOpenThirdParty).
//
// SOURCE: OpenStreetMap, through the public Overpass API — free, no key,
// ODbL licence (credit shown: "© OpenStreetMap contributors"). One query
// per listing, kept for CACHE_DAYS (listing moved → asked again); a failed
// ask is not retried for RETRY_MINUTES, and the last good answer is kept.
// Links: the place's own website or Wikipedia page when OpenStreetMap has
// one, else its OpenStreetMap page; directions open Google Maps (no key).

const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const CACHE_DAYS = 30;
const RETRY_MINUTES = 60;
const THINGS_RADIUS_M = 8000, TRANSPORT_RADIUS_M = 6000, LOCAL_RADIUS_M = 3000, AIRPORT_RADIUS_M = 80000;
const MAX_THINGS = 14;
const ATTRIBUTION = 'Places: © OpenStreetMap contributors (ODbL)';

function km(aLat, aLng, bLat, bLng) {
  const R = 6371, rad = (d) => d * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)) * 10) / 10;
}
const httpUrl = (u) => { const s = String(u || '').trim(); return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : null; };

function query(lat, lng) {
  const at = (r) => `(around:${r},${lat},${lng})`;
  return `[out:json][timeout:20];(
  nwr${at(THINGS_RADIUS_M)}["tourism"~"^(attraction|museum|viewpoint|zoo|theme_park|gallery|aquarium)$"]["name"];
  nwr${at(THINGS_RADIUS_M)}["historic"~"^(monument|fort|castle|ruins|memorial|archaeological_site|palace)$"]["name"];
  nwr${at(THINGS_RADIUS_M)}["leisure"~"^(park|nature_reserve|water_park|garden)$"]["name"];
  nwr${at(THINGS_RADIUS_M)}["natural"~"^(beach|peak|waterfall)$"]["name"];
  nwr${at(THINGS_RADIUS_M)}["amenity"="place_of_worship"]["wikipedia"]["name"];
  nwr${at(TRANSPORT_RADIUS_M)}["railway"~"^(station|halt)$"]["name"];
  nwr${at(TRANSPORT_RADIUS_M)}["station"~"^(subway|light_rail)$"]["name"];
  nwr${at(LOCAL_RADIUS_M)}["amenity"~"^(bus_station|taxi)$"];
  nwr${at(AIRPORT_RADIUS_M)}["aeroway"="aerodrome"]["iata"]["name"];
);out center tags 400;`;
}

const THING_LABEL = {
  attraction: 'Attraction', museum: 'Museum', viewpoint: 'Viewpoint', zoo: 'Zoo', theme_park: 'Theme park', gallery: 'Art gallery', aquarium: 'Aquarium',
  monument: 'Monument', fort: 'Fort', castle: 'Castle', ruins: 'Ruins', memorial: 'Memorial', archaeological_site: 'Heritage site', palace: 'Palace',
  park: 'Park', nature_reserve: 'Nature reserve', water_park: 'Water park', garden: 'Garden', beach: 'Beach', peak: 'Hill or peak', waterfall: 'Waterfall',
  place_of_worship: 'Place of worship'
};

// Turns Overpass elements into the two lists, nearest first.
function build(lat, lng, elements) {
  const things = [], transport = { metro: [], train: [], bus: [], taxi: [], airport: [] };
  const seen = new Set();
  for (const e of elements || []) {
    const t = e.tags || {};
    const pLat = Number(e.lat != null ? e.lat : e.center && e.center.lat);
    const pLng = Number(e.lon != null ? e.lon : e.center && e.center.lon);
    if (!Number.isFinite(pLat) || !Number.isFinite(pLng)) continue;
    const name = String(t['name:en'] || t.name || '').trim().slice(0, 120);
    const dist = km(lat, lng, pLat, pLng);
    const wiki = typeof t.wikipedia === 'string' && /^[a-z-]{2,10}:.+/.test(t.wikipedia)
      ? `https://${t.wikipedia.split(':')[0]}.wikipedia.org/wiki/${encodeURIComponent(t.wikipedia.split(':').slice(1).join(':').replace(/ /g, '_'))}` : null;
    const link = httpUrl(t.website) || httpUrl(t['contact:website']) || wiki || `https://www.openstreetmap.org/${e.type}/${e.id}`;
    const linkKind = httpUrl(t.website) || httpUrl(t['contact:website']) ? 'Official site' : wiki ? 'Wikipedia' : 'OpenStreetMap';
    const item = { name, km: dist, lat: pLat, lng: pLng, link, linkKind, source: 'osm' };
    if (t.aeroway === 'aerodrome') { transport.airport.push({ ...item, label: `Airport${t.iata ? ' (' + t.iata + ')' : ''}` }); continue; }
    if (t.station === 'subway' || t.station === 'light_rail' || t.subway === 'yes' || /metro/i.test(t.network || '') || /metro/i.test(t.operator || '')) {
      if (name) transport.metro.push({ ...item, label: 'Metro station' }); continue;
    }
    if (t.railway === 'station' || t.railway === 'halt') { if (name) transport.train.push({ ...item, label: 'Railway station' }); continue; }
    if (t.amenity === 'bus_station') { transport.bus.push({ ...item, name: name || 'Bus station', label: 'Bus station' }); continue; }
    if (t.amenity === 'taxi') { transport.taxi.push({ ...item, name: name || 'Taxi stand', label: 'Taxi stand' }); continue; }
    if (!name) continue;
    const kind = t.tourism || t.historic || t.leisure || t.natural || t.amenity;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Places with their own page come first among those at a similar distance.
    things.push({ ...item, label: THING_LABEL[kind] || 'Place', rank: dist - (wiki || httpUrl(t.website) ? 1.5 : 0) });
  }
  things.sort((a, b) => a.rank - b.rank);
  const near = (list, n) => list.sort((a, b) => a.km - b.km).filter((x, i, arr) => arr.findIndex(y => y.name === x.name) === i).slice(0, n);
  return {
    things: things.slice(0, MAX_THINGS).map(({ rank, ...x }) => x),
    transport: { metro: near(transport.metro, 3), train: near(transport.train, 2), bus: near(transport.bus, 2), taxi: near(transport.taxi, 2), airport: near(transport.airport, 2) },
    // Ride-hailing apps: the guest's own app, picked up at the property.
    taxiApps: [
      { name: 'Uber', link: `https://m.uber.com/ul/?action=setPickup&pickup[latitude]=${lat}&pickup[longitude]=${lng}` },
      { name: 'Ola', link: 'https://www.olacabs.com/' },
      { name: 'Rapido', link: 'https://www.rapido.bike/' }
    ],
    attribution: ATTRIBUTION
  };
}

async function fetchOverpass(lat, lng) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(OVERPASS_URL, { method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Aerva/1.0 (+https://aerva.in)' },
      body: 'data=' + encodeURIComponent(query(lat, lng)) });
    if (!r.ok) throw new Error(`Overpass ${r.status}`);
    const j = await r.json();
    return Array.isArray(j.elements) ? j.elements : [];
  } finally { clearTimeout(timer); }
}

// The listing's nearby places, from the cache or freshly asked.
async function nearbyFor(sql, listingId) {
  const l = (await sql`SELECT id, latitude, longitude, city FROM listings WHERE id = ${Number(listingId) || 0} AND status = 'approved'`)[0];
  if (!l) return { error: 'Listing not found.', status: 404 };
  const lat = Number(l.latitude), lng = Number(l.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (!lat && !lng)) return { listingId: l.id, city: l.city || null, things: [], transport: {}, taxiApps: [], attribution: ATTRIBUTION, noLocation: true };
  let cached = null;
  try { cached = (await sql`SELECT * FROM nearby_places WHERE listing_id = ${l.id}`)[0] || null; }
  catch (err) { if (err && err.code === '42P01') return { listingId: l.id, city: l.city || null, things: [], transport: {}, taxiApps: [], attribution: ATTRIBUTION, notReady: true }; throw err; }
  const sameSpot = cached && Math.abs(Number(cached.lat) - lat) < 1e-4 && Math.abs(Number(cached.lng) - lng) < 1e-4;
  const fresh = sameSpot && cached.data && cached.fetched_at && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_DAYS * 86400e3;
  const waiting = cached && cached.failed_at && Date.now() - new Date(cached.failed_at).getTime() < RETRY_MINUTES * 60e3;
  if (!fresh && !waiting) {
    try {
      const data = build(lat, lng, await fetchOverpass(lat, lng));
      await sql`INSERT INTO nearby_places (listing_id, lat, lng, data, fetched_at, failed_at) VALUES (${l.id}, ${lat}, ${lng}, ${JSON.stringify(data)}::jsonb, now(), NULL)
                ON CONFLICT (listing_id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, data = EXCLUDED.data, fetched_at = now(), failed_at = NULL`;
      return { listingId: l.id, city: l.city || null, ...data };
    } catch (err) {
      console.error('nearby places not fetched:', l.id, err.message);
      try {
        await sql`INSERT INTO nearby_places (listing_id, lat, lng, failed_at) VALUES (${l.id}, ${lat}, ${lng}, now())
                  ON CONFLICT (listing_id) DO UPDATE SET failed_at = now()`;
      } catch (e) { /* none */ }
    }
  }
  if (cached && cached.data) return { listingId: l.id, city: l.city || null, ...cached.data, stale: !fresh };
  return { listingId: l.id, city: l.city || null, things: [], transport: {}, taxiApps: build(lat, lng, []).taxiApps, attribution: ATTRIBUTION, unavailable: true };
}

// The guest agreed to the third-party notice before a link opened. Never throws.
async function recordConsent(sql, { guestId = null, ip = null, listingId, item, link, kind }) {
  try {
    await require('./_audit-log').logAudit(sql, { action: 'third_party_link_consent', success: true, actorType: 'guest', actorIdentifier: guestId ? String(guestId) : ('anon:' + (ip || 'unknown')),
      targetType: 'listing', targetId: Number(listingId) || null,
      metadata: { item: String(item || '').slice(0, 160), link: String(link || '').slice(0, 500), kind: String(kind || '').slice(0, 40), ip: ip || null,
        notice: 'Third-party place or service: Aerva does not own, check or run it and is not responsible for anything that happens there, including fraud, violence, injury or loss.' } });
    return true;
  } catch (e) { return false; }
}

module.exports = { nearbyFor, recordConsent, build, query, ATTRIBUTION };
