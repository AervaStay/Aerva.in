// /api/_seo.js — pages for Google: one per home, one per city, and the
// sitemap. Not an endpoint: get-listings.js answers ?seo=stay|city|sitemap,
// and vercel.json maps the clean addresses onto it:
//     /stays/<name>-<city>   → ?seo=stay&slug=…
//     /stays-in/<city>       → ?seo=city&city=…
//     /sitemap.xml           → ?seo=sitemap
// Everything a search engine needs is in the HTML itself (name, place,
// price, photos, reviews, structured data), so nothing depends on scripts
// running. Guests who land here book through the normal page
// (index.html?listing=<id>), which points back here as its canonical
// address.
//
// The data comes from the same public listing query the site uses, so a
// page never shows a home, price or rating the site itself would not.

const { IS_PROD } = require('./_env');

function siteBase() {
  if (IS_PROD) return 'https://aerva.in';
  return String(process.env.UAT_SITE_URL || 'https://uat.aerva.in').replace(/\/$/, '');
}

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');

// "Lonavala Hill House", "Lonavala" → "lonavala-hill-house"; the city is
// added when the name does not already say it. Same rule as aerva.js
// staySlug(), so the site's canonical links match these addresses.
function slugify(s) {
  return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
function staySlug(l) {
  const name = slugify(l.property_name), city = slugify(l.city);
  return (!city || name.split('-').join(' ').includes(city.split('-').join(' '))) ? name || String(l.id) : `${name}-${city}`;
}
function stayPath(l) { return '/stays/' + staySlug(l); }
function cityPath(city) { return '/stays-in/' + slugify(city); }

// Slugs can repeat (two "Hill House"s in one city): the oldest listing
// keeps the plain address, later ones get "-<id>" added.
function slugMap(listings) {
  const map = new Map(); const byId = new Map();
  [...listings].sort((a, b) => a.id - b.id).forEach(l => {
    let s = staySlug(l);
    if (map.has(s)) s = s + '-' + l.id;
    map.set(s, l); byId.set(l.id, s);
  });
  return { map, byId };
}

function photosOf(l) {
  const all = [l.cover_photo_url, ...(l.interior_photo_urls || []), ...(l.exterior_photo_urls || [])]
    .map(p => typeof p === 'string' ? p : (p && p.url)).filter(u => typeof u === 'string' && /^https:\/\//.test(u));
  return [...new Set(all)];
}
const sleeps = (l) => { const m = String(l.max_guests || '').match(/\d+/g); return m ? Math.max(...m.map(Number)) : null; };
const ratingOk = (l) => Number(l.review_count) > 0 && l.rating != null && Number(l.rating) > 0;
function plainDescription(l, max = 155) {
  const d = String(l.description || '').replace(/\s+/g, ' ').trim();
  const lead = `${l.property_type || 'Home'} in ${[l.area, l.city].filter(Boolean).join(', ')}` +
    (sleeps(l) ? `, sleeps ${sleeps(l)}` : '') + (l.nightly_rate ? `, from ${inr(l.nightly_rate)} a night` : '') + '.';
  const text = d.length > 20 ? `${lead} ${d}` : `${lead} Hand-picked and personally reviewed by Aerva.`;
  return text.length > max ? text.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : text;
}

// ---- Page frame ----
function page({ title, description, canonical, image, jsonLd, body }) {
  const ld = (Array.isArray(jsonLd) ? jsonLd : [jsonLd]).filter(Boolean)
    .map(x => `<script type="application/ld+json">${JSON.stringify(x).replace(/</g, '\\u003c')}</script>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en-IN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Aerva">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='%23f4ebe3'/><text x='50' y='68' font-family='Georgia,serif' font-size='60' text-anchor='middle' fill='%23A9885A'>A</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,wght@0,400;0,500;1,400&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
${ld}
<style>
:root{--ink:#1c1b19;--ink2:#4a453e;--ink3:#6e675d;--gold:#7c6030;--line:#e7dfd4;--band:#f7f3ee;}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Jost,system-ui,sans-serif;color:var(--ink);background:#fff;line-height:1.6;font-size:16px}
a{color:inherit}
.top{display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid var(--line);max-width:1180px;margin:0 auto}
.brand{text-decoration:none;display:flex;flex-direction:column;line-height:1}
.brand b{font-family:'Bodoni Moda',Georgia,serif;font-weight:500;letter-spacing:.32em;font-size:22px}
.brand small{font-size:9.5px;letter-spacing:.3em;color:var(--gold);margin-top:5px}
.top nav a{font-size:12px;letter-spacing:.14em;text-transform:uppercase;text-decoration:none;margin-left:22px}
main{max-width:1180px;margin:0 auto;padding:22px 24px 60px}
.crumbs{font-size:13px;color:var(--ink3);margin-bottom:14px}
.crumbs a{text-decoration:none}.crumbs a:hover{text-decoration:underline}
h1{font-family:'Bodoni Moda',Georgia,serif;font-weight:400;font-size:clamp(28px,4.4vw,44px);line-height:1.15}
h2{font-family:'Bodoni Moda',Georgia,serif;font-weight:400;font-size:24px;margin:34px 0 12px}
.sub{color:var(--ink2);margin-top:8px;font-size:15px}
.star{color:var(--gold)}
.gallery{display:grid;grid-template-columns:2fr 1fr 1fr;grid-auto-rows:190px;gap:8px;margin:22px 0;border-radius:14px;overflow:hidden}
.gallery img{width:100%;height:100%;object-fit:cover;display:block;background:var(--band)}
.gallery img:first-child{grid-row:span 2}
.noimg{height:260px;border-radius:14px;background:var(--band);display:flex;align-items:center;justify-content:center;font-family:'Bodoni Moda',serif;font-size:64px;color:#c6ad84;margin:22px 0}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:40px}
.facts{display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--ink2);font-size:14.5px}
.desc{white-space:pre-line;color:var(--ink2);margin-top:6px}
.amen{columns:2;gap:24px;color:var(--ink2);font-size:14.5px;list-style:none}
.amen li{padding:3px 0}
.book{position:sticky;top:20px;border:1px solid var(--line);border-radius:14px;padding:22px;align-self:start}
.price{font-size:26px;font-family:'Bodoni Moda',serif}.price small{font-family:Jost;font-size:14px;color:var(--ink3)}
.btn{display:block;text-align:center;background:#1c1a17;color:#f4eadc;text-decoration:none;padding:14px 18px;border-radius:10px;margin-top:16px;letter-spacing:.06em}
.note{font-size:12.5px;color:var(--ink3);margin-top:10px;text-align:center}
.rev{border-top:1px solid var(--line);padding:16px 0}.rev b{font-weight:500}.rev p{color:var(--ink2);margin-top:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:26px;margin-top:20px}
.card{text-decoration:none;display:block}
.card .ph{aspect-ratio:4/3;border-radius:14px;overflow:hidden;background:var(--band);display:flex;align-items:center;justify-content:center;font-family:'Bodoni Moda',serif;font-size:48px;color:#c6ad84}
.card img{width:100%;height:100%;object-fit:cover}
.card h3{font-family:'Bodoni Moda',serif;font-weight:400;font-size:20px;margin-top:12px}
.card .meta{font-size:13.5px;color:var(--ink2)}
.card .pr{font-size:14.5px;margin-top:2px}
.intro{color:var(--ink2);max-width:760px;margin-top:10px}
.places{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
.places a{border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:14px;text-decoration:none}
footer{border-top:1px solid var(--line);color:var(--ink3);font-size:13px;text-align:center;padding:26px 24px}
@media (max-width:820px){.layout{grid-template-columns:1fr}.book{position:static}.gallery{grid-template-columns:1fr 1fr;grid-auto-rows:140px}.gallery img:first-child{grid-column:span 2;grid-row:span 2}.amen{columns:1}.top nav a{margin-left:14px}}
</style>
</head>
<body>
<header class="top"><a class="brand" href="/"><b>AERVA</b><small>STAY ELEGANT</small></a>
<nav><a href="/index.html?view=suites">Stays</a><a href="/index.html?view=experiences">Experiences</a></nav></header>
<main>
${body}
</main>
<footer>© ${new Date().getFullYear()} Aerva · Hand-picked homes across India, each personally reviewed. · <a href="/index.html?view=help">Help</a></footer>
</body>
</html>`;
}

function cardHtml(l, path) {
  const ph = photosOf(l)[0];
  return `<a class="card" href="${esc(path)}">
    <div class="ph">${ph ? `<img src="${esc(ph)}" alt="${esc(l.property_name)}, ${esc(l.city)}" loading="lazy">` : esc(String(l.property_name || 'A').charAt(0))}</div>
    <h3>${esc(l.property_name)}</h3>
    <div class="meta">${esc([l.area, l.city].filter(Boolean).join(', '))}${l.property_type ? ' · ' + esc(l.property_type) : ''}${sleeps(l) ? ' · sleeps ' + sleeps(l) : ''}</div>
    <div class="pr">${l.nightly_rate ? `<b>${inr(l.nightly_rate)}</b> a night` : 'Price on request'}${ratingOk(l) ? ` · <span class="star">★</span> ${Number(l.rating).toFixed(1)} (${Number(l.review_count)})` : ''}</div>
  </a>`;
}

// ---- One home ----
function stayPage(l, reviewsData, { slug, cityHasPage }) {
  const base = siteBase();
  const canonical = base + '/stays/' + slug;
  const photos = photosOf(l);
  const place = [l.area, l.city].filter(Boolean).join(', ');
  const title = `${l.property_name} — ${l.property_type || 'Stay'} in ${l.city || 'India'} | Aerva`;
  const description = plainDescription(l);
  const reviews = (reviewsData && Array.isArray(reviewsData.reviews)) ? reviewsData.reviews.filter(r => r.comment && r.comment.trim()).slice(0, 6) : [];
  const amenities = (Array.isArray(l.amenities) ? l.amenities : []).map(a => typeof a === 'string' ? a : (a && (a.name || a.label))).filter(Boolean).slice(0, 24);
  const bookHref = `/index.html?listing=${Number(l.id)}`;
  const cityUrl = base + cityPath(l.city);

  const lodging = {
    '@context': 'https://schema.org', '@type': 'LodgingBusiness',
    '@id': canonical, name: l.property_name, url: canonical, description,
    image: photos.slice(0, 8),
    address: { '@type': 'PostalAddress', addressLocality: l.city || undefined, streetAddress: l.area || undefined, addressCountry: 'IN' },
    ...(l.latitude && l.longitude ? { geo: { '@type': 'GeoCoordinates', latitude: Number(l.latitude), longitude: Number(l.longitude) } } : {}),
    ...(l.nightly_rate ? { priceRange: `From ${inr(l.nightly_rate)} per night` } : {}),
    ...(amenities.length ? { amenityFeature: amenities.map(a => ({ '@type': 'LocationFeatureSpecification', name: a, value: true })) } : {}),
    ...(ratingOk(l) ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: Number(Number(l.rating).toFixed(1)), reviewCount: Number(l.review_count), bestRating: 5, worstRating: 1 } } : {}),
    ...(reviews.length ? { review: reviews.map(r => ({ '@type': 'Review', author: { '@type': 'Person', name: r.name }, ...(r.month ? { datePublished: r.month + '-01' } : {}),
      ...(r.score ? { reviewRating: { '@type': 'Rating', ratingValue: Number(Number(r.score).toFixed(1)), bestRating: 5, worstRating: 1 } } : {}), reviewBody: String(r.comment).slice(0, 600) })) } : {})
  };
  const crumbs = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Aerva', item: base + '/' },
      ...(l.city ? [{ '@type': 'ListItem', position: 2, name: `Stays in ${l.city}`, item: cityUrl }] : []),
      { '@type': 'ListItem', position: l.city ? 3 : 2, name: l.property_name, item: canonical }
    ]
  };
  const monthName = (m) => { if (!m) return ''; const d = new Date(m + '-01T00:00:00Z'); return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };

  const body = `
<div class="crumbs"><a href="/">Aerva</a>${l.city ? ` › <a href="${esc(cityPath(l.city))}">Stays in ${esc(l.city)}</a>` : ''} › ${esc(l.property_name)}</div>
<h1>${esc(l.property_name)}</h1>
<p class="sub">${esc(place)}${l.property_type ? ' · ' + esc(l.property_type) : ''}${ratingOk(l) ? ` · <span class="star">★</span> ${Number(l.rating).toFixed(1)} · ${Number(l.review_count)} review${Number(l.review_count) === 1 ? '' : 's'}` : ' · New on Aerva'}</p>
${photos.length ? `<div class="gallery">${photos.slice(0, 5).map((u, i) => `<img src="${esc(u)}" alt="${esc(l.property_name)} — photo ${i + 1}" ${i ? 'loading="lazy"' : 'fetchpriority="high"'}>`).join('')}</div>` : `<div class="noimg">${esc(String(l.property_name || 'A').charAt(0))}</div>`}
<div class="layout">
  <div>
    <div class="facts">${[l.property_type, l.bedrooms ? `${l.bedrooms} bedroom${String(l.bedrooms) === '1' ? '' : 's'}` : '', sleeps(l) ? `Sleeps ${sleeps(l)}` : '', l.pet_friendly ? 'Pets welcome' : '', l.cancellation_policy === 'flexible' ? 'Flexible cancellation' : l.cancellation_policy === 'firm' ? 'Firm cancellation' : ''].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('')}</div>
    <h2>About this home</h2>
    <p class="desc">${esc(String(l.description || '').trim() || `A hand-picked ${String(l.property_type || 'home').toLowerCase()} in ${place}, personally reviewed by Aerva.`)}</p>
    ${amenities.length ? `<h2>What this place offers</h2><ul class="amen">${amenities.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
    <h2>Reviews</h2>
    ${reviews.length ? reviews.map(r => `<div class="rev"><b>${esc(r.name)}</b>${r.score ? ` · <span class="star">★</span> ${Number(r.score).toFixed(1)}` : ''}${r.month ? ` · <span style="color:var(--ink3)">${esc(monthName(r.month))}</span>` : ''}<p>${esc(r.comment)}</p></div>`).join('') : '<p class="desc">No reviews yet — this home is new on Aerva.</p>'}
    ${l.city && cityHasPage ? `<h2>More stays in ${esc(l.city)}</h2><p><a href="${esc(cityPath(l.city))}">See every Aerva home in and around ${esc(l.city)} ›</a></p>` : ''}
  </div>
  <aside class="book">
    <div class="price">${l.nightly_rate ? `${inr(l.nightly_rate)} <small>a night</small>` : '<small>Price on request</small>'}</div>
    <a class="btn" href="${esc(bookHref)}">Check dates &amp; book</a>
    <p class="note">You won’t be charged yet. Taxes and fees are shown before you pay.</p>
  </aside>
</div>`;
  return page({ title, description, canonical, image: photos[0], jsonLd: [lodging, crumbs], body });
}

// ---- One city ----
function haversineKm(a, b, c, d) {
  const R = 6371, toR = (x) => x * Math.PI / 180;
  const dLat = toR(c - a), dLng = toR(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a)) * Math.cos(toR(c)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function citySummary(listings) {
  const by = new Map();
  listings.forEach(l => { const s = slugify(l.city); if (!s) return; if (!by.has(s)) by.set(s, { slug: s, name: String(l.city).trim(), homes: [] }); by.get(s).homes.push(l); });
  return [...by.values()].sort((a, b) => b.homes.length - a.homes.length || a.name.localeCompare(b.name));
}
function cityHeadline(homes, city) {
  const types = homes.map(h => String(h.property_type || '').toLowerCase());
  const villas = types.filter(t => t.includes('villa')).length;
  if (villas && villas >= homes.length / 2) return `Luxury villas in ${city}`;
  return `Boutique stays in ${city}`;
}
function cityPage(cityInfo, allListings, slugs) {
  const base = siteBase();
  const city = cityInfo.name;
  const canonical = base + cityPath(city);
  const homes = [...cityInfo.homes].sort((a, b) => (Number(b.review_count) > 0) - (Number(a.review_count) > 0) || (Number(b.rating) || 0) - (Number(a.rating) || 0) || (Number(b.like_count) || 0) - (Number(a.like_count) || 0));
  // Homes within 75 km, outside the city itself.
  const anchor = homes.find(h => h.latitude && h.longitude);
  const nearby = anchor ? allListings.filter(l => slugify(l.city) !== cityInfo.slug && l.latitude && l.longitude
    && haversineKm(Number(anchor.latitude), Number(anchor.longitude), Number(l.latitude), Number(l.longitude)) <= 75).slice(0, 12) : [];
  const headline = cityHeadline(homes, city);
  const prices = homes.map(h => Number(h.nightly_rate)).filter(n => n > 0);
  const from = prices.length ? Math.min(...prices) : null;
  const title = `${headline} — ${homes.length} hand-picked home${homes.length === 1 ? '' : 's'} | Aerva`;
  const description = `${homes.length} hand-picked ${homes.length === 1 ? 'home' : 'homes'} in ${city}${from ? `, from ${inr(from)} a night` : ''}. Every Aerva stay is personally reviewed — villas, apartments and boutique homes with honest reviews.`;
  const pathOf = (l) => '/stays/' + slugs.byId.get(l.id);
  const others = citySummary(allListings).filter(c => c.slug !== cityInfo.slug).slice(0, 16);
  const list = {
    '@context': 'https://schema.org', '@type': 'ItemList', name: headline,
    itemListElement: homes.map((l, i) => ({ '@type': 'ListItem', position: i + 1, url: base + pathOf(l), name: l.property_name }))
  };
  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Aerva', item: base + '/' },
    { '@type': 'ListItem', position: 2, name: `Stays in ${city}`, item: canonical }] };
  const body = `
<div class="crumbs"><a href="/">Aerva</a> › <a href="/stays-in/">Places to stay</a> › Stays in ${esc(city)}</div>
<h1>${esc(headline)}</h1>
<p class="intro">${homes.length} hand-picked ${homes.length === 1 ? 'home' : 'homes'} in ${esc(city)}${from ? `, from ${inr(from)} a night` : ''}. Every stay on Aerva is reviewed personally before it is listed — never a template, never bulk-listed.</p>
<div class="grid">${homes.map(l => cardHtml(l, pathOf(l))).join('')}</div>
${nearby.length ? `<h2>Also near ${esc(city)}</h2><div class="grid">${nearby.map(l => cardHtml(l, pathOf(l))).join('')}</div>` : ''}
${others.length ? `<h2>More places to stay</h2><div class="places">${others.map(c => `<a href="${esc(cityPath(c.name))}">${esc(c.name)} (${c.homes.length})</a>`).join('')}</div>` : ''}
<p style="margin-top:34px"><a class="btn" style="display:inline-block" href="/index.html">Search dates on Aerva</a></p>`;
  return page({ title, description, canonical, image: photosOf(homes[0] || {})[0], jsonLd: [list, crumbs], body });
}

// ---- Every place (/stays-in/) ----
function citiesPage(allListings, slugs) {
  const base = siteBase();
  const canonical = base + '/stays-in/';
  const cities = citySummary(allListings);
  const title = 'Places to stay across India — hand-picked homes | Aerva';
  const description = `Hand-picked villas, apartments and boutique homes in ${cities.slice(0, 6).map(c => c.name).join(', ')}${cities.length > 6 ? ' and more' : ''}. Every Aerva stay is personally reviewed.`;
  const list = { '@context': 'https://schema.org', '@type': 'ItemList', name: 'Places to stay on Aerva',
    itemListElement: cities.map((c, i) => ({ '@type': 'ListItem', position: i + 1, url: base + cityPath(c.name), name: `Stays in ${c.name}` })) };
  const body = `
<div class="crumbs"><a href="/">Aerva</a> › Places to stay</div>
<h1>Places to stay</h1>
<p class="intro">${allListings.length} hand-picked ${allListings.length === 1 ? 'home' : 'homes'} in ${cities.length} ${cities.length === 1 ? 'place' : 'places'} across India. Every stay on Aerva is reviewed personally before it is listed.</p>
${cities.map(c => {
  const homes = [...c.homes].sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0)).slice(0, 3);
  return `<h2><a href="${esc(cityPath(c.name))}" style="text-decoration:none">${esc(cityHeadline(c.homes, c.name))} ›</a></h2>
<div class="grid">${homes.map(l => cardHtml(l, '/stays/' + slugs.byId.get(l.id))).join('')}</div>
${c.homes.length > 3 ? `<p style="margin-top:12px"><a href="${esc(cityPath(c.name))}">See all ${c.homes.length} homes in ${esc(c.name)} ›</a></p>` : ''}`;
}).join('')}
${cities.length ? '' : '<p class="intro">New homes are being added — check back soon.</p>'}`;
  return page({ title, description, canonical, image: photosOf((cities[0] && cities[0].homes[0]) || {})[0], jsonLd: list, body });
}

function notFoundPage(what) {
  const base = siteBase();
  return page({ title: 'Not found | Aerva', description: 'This page is not on Aerva any more.', canonical: base + '/',
    body: `<h1>${esc(what)}</h1><p class="intro">It may have been taken down by its host.</p><p style="margin-top:22px"><a class="btn" style="display:inline-block" href="/index.html">See all homes</a></p>` });
}

function sitemap(listings, slugs) {
  const base = siteBase();
  const day = (d) => { const x = d ? new Date(d) : null; return x && !isNaN(x) ? x.toISOString().slice(0, 10) : null; };
  const urls = [{ loc: base + '/', priority: '1.0' }, { loc: base + '/stays-in/', priority: '0.9' }];
  citySummary(listings).forEach(c => urls.push({ loc: base + cityPath(c.name), priority: '0.8' }));
  listings.forEach(l => urls.push({ loc: base + '/stays/' + slugs.byId.get(l.id), lastmod: day(l.price_changed_at || l.created_at), priority: '0.7' }));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<priority>${u.priority}</priority></url>`).join('\n') +
    `\n</urlset>\n`;
}

module.exports = { slugify, staySlug, stayPath, cityPath, slugMap, citySummary, stayPage, cityPage, citiesPage, notFoundPage, sitemap, siteBase };
