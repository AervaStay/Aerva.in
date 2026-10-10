// /api/_city-names.js — one clean name per place. Not an endpoint.
//
// The address search hosts pick from sometimes fills "city" with an
// administrative area instead of the town guests know: "Pune Division",
// "Mawal Subdistrict", or a misspelling such as "Jablpur". Every stay's
// city decides which "Stays in …" page it is on (_seo.js), so two names for
// one place split it into two thin pages. Applied when a listing is saved
// (submit-listing.js, update-listing-pricing.js); existing listings were
// cleaned by migrations/2026-10-10-01-clean-city-names.sql (same rules).

const ADMIN_SUFFIX = /\s+(division|sub-?district|district|tehsil|taluka|taluk)\.?$/i;

// Spellings and old names → the name guests search for.
const ALIASES = {
  jablpur: 'Jabalpur', jabalpur: 'Jabalpur',
  bombay: 'Mumbai', poona: 'Pune', calcutta: 'Kolkata', madras: 'Chennai',
  gurgaon: 'Gurugram', trivandrum: 'Thiruvananthapuram', cochin: 'Kochi'
};

// Mawal (Maval) is the sub-district around Lonavala; homes within 20 km of
// Lonavala are shown as Lonavala, others keep the sub-district's name.
const LONAVALA = { lat: 18.7546, lng: 73.4062 };
function km(a, b, c, d) {
  const R = 6371, r = (x) => x * Math.PI / 180;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function cleanCity(city, lat, lng) {
  if (typeof city !== 'string') return city;
  let c = city.trim().replace(/\s+/g, ' ');
  if (!c) return c;
  c = c.replace(ADMIN_SUFFIX, '').trim() || c;
  const key = c.toLowerCase();
  if (ALIASES[key]) return ALIASES[key];
  if (key === 'mawal' || key === 'maval') {
    const la = Number(lat), ln = Number(lng);
    if (Number.isFinite(la) && Number.isFinite(ln) && (la || ln) && km(la, ln, LONAVALA.lat, LONAVALA.lng) <= 20) return 'Lonavala';
    return 'Maval';
  }
  return c;
}

module.exports = { cleanCity };
