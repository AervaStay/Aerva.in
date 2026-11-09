// /api/_listing-special.js
// "What's special about this place?" and "Recommended by your host" —
// optional listing text the host writes on the list-property form
// (submit-listing.js) and later on Manage listing (update-listing-pricing.js),
// shown to guests on the listing page (get-listings.js, aerva.js) and to
// Aerva on the admin review. Not an API endpoint itself — the leading
// underscore tells Vercel that.
//
// Stored on listings (migrations/2026-11-09-09-listing-special.sql):
//   special_highlights   JSONB  ["…", …]       up to 5, 120 characters each
//   special_story        TEXT   one paragraph, up to 600 characters
//   host_recommendations JSONB  [{ kind, name, note, distance, link }]  up to 10
//   suggested_experience_ids JSONB [id, …]     up to 6 live Aerva experiences,
//                                               any host; shown to guests only
//                                               while booking (get-listings
//                                               ?suggestedFor=)
//
// Rules, the same for both pages:
//   - Text is tidied (spaces collapsed, HTML tags taken out) and then put
//     through the contact-details check used for messages (_redact.js):
//     phone numbers, emails, social handles and links are removed.
//   - Over a limit → refused with a message saying which limit (the form
//     enforces the same limits as you type, so only a tampered or very old
//     page reaches this).
//   - A recommendation's link is the only place a URL is allowed: http(s)
//     only, up to 300 characters, no IP-address host, not Aerva's own
//     site, not a messaging/social contact link, no user:password@.
//   - Only fields the request sends are changed ("not sent" = leave alone).
//   - Saved in its own UPDATE, so a database without the new columns skips
//     them with a note and never fails the listing save.

const { redactContactInfo } = require('./_redact');

const LIMITS = { experiences: 6, highlights: 5, highlightLen: 120, storyLen: 600, recs: 10, recName: 80, recNote: 200, recDistance: 40, recLink: 300 };
const REC_KINDS = {
  things_to_do: 'Things to do', food_drink: 'Food & drink', experience: 'Experience',
  shopping: 'Shopping', getting_around: 'Getting around', other: 'Other'
};
const NOT_SAVED_NOTE = "Your listing was saved. “What’s special” and your recommendations could not be saved just now (Aerva is finishing a site update) — please add them again later.";

// Tags in either form: real < > or the look-alikes _plain-text.js turns them into.
const TAG = /<\/?[a-zA-Z][^<>]{0,300}>|‹\/?[a-zA-Z][^‹›]{0,300}›/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function tidyLine(v) {
  return String(v == null ? '' : v).replace(TAG, ' ').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
}
function tidyParagraph(v) {
  return String(v == null ? '' : v).replace(TAG, ' ').replace(CONTROL, '').replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function redact(text, flag) {
  if (!text) return text;
  const r = redactContactInfo(text);
  if (r.wasRedacted) flag.redacted = true;
  return String(r.displayText).replace(/[^\S\n]+/g, ' ').trim();
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const CONTACT_HOSTS = /(^|\.)(wa\.me|whatsapp\.com|t\.me|telegram\.me|telegram\.org|instagram\.com|facebook\.com|fb\.com|fb\.me|m\.me|snapchat\.com|signal\.me)$/i;
const AERVA_HOSTS = /(^|\.)(aerva\.in|aerva-in\.vercel\.app)$/i;

// null = fine (or empty); otherwise the reason it cannot be used.
function linkProblem(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.length > LIMITS.recLink) return `is longer than ${LIMITS.recLink} characters`;
  if (!/^https?:\/\//i.test(s)) return 'must start with https:// or http://';
  let u;
  try { u = new URL(s); } catch (e) { return 'is not a valid web address'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'must start with https:// or http://';
  if (u.username || u.password) return 'cannot contain a user name or password';
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.startsWith('[') || IPV4.test(host) || /^\d+$/.test(host) || host.includes(':')) return 'must use a website name, not an IP address';
  if (!host.includes('.') || host === 'localhost' || /\.(local|internal|localhost)$/.test(host)) return 'must be a public website';
  if (AERVA_HOSTS.test(host)) return 'cannot point to Aerva itself';
  if (CONTACT_HOSTS.test(host)) return 'cannot be a messaging or social-media contact link';
  return null;
}

const sentKey = (body, k) => !!body && Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;

// Reads specialHighlights / specialStory / hostRecommendations /
// suggestedExperienceIds from a request body.
// → { error } or { values: { column: value }, redacted, dropped }.
// sql is needed only when suggestedExperienceIds is sent: each id must be
// an experience (a stay, or an id that does not exist, is refused; the
// same one twice is refused); one that is no longer live is dropped.
async function cleanSpecial(body, sql, { selfId = null } = {}) {
  const values = {};
  const flag = { redacted: false };
  if (sentKey(body, 'specialHighlights')) {
    const raw = Array.isArray(body.specialHighlights) ? body.specialHighlights : [];
    const items = raw.map(tidyLine).filter(Boolean);
    if (items.length > LIMITS.highlights) return { error: `“What’s special” can have up to ${LIMITS.highlights} highlights.` };
    const long = items.findIndex(t => t.length > LIMITS.highlightLen);
    if (long !== -1) return { error: `Highlight ${long + 1} is longer than ${LIMITS.highlightLen} characters. Please shorten it.` };
    values.special_highlights = items.map(t => redact(t, flag)).filter(Boolean);
  }
  if (sentKey(body, 'specialStory')) {
    const story = tidyParagraph(body.specialStory);
    if (story.length > LIMITS.storyLen) return { error: `“The story of this place” can be up to ${LIMITS.storyLen} characters.` };
    values.special_story = redact(story, flag) || null;
  }
  if (sentKey(body, 'hostRecommendations')) {
    const raw = Array.isArray(body.hostRecommendations) ? body.hostRecommendations : [];
    const recs = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const name = tidyLine(r.name), note = tidyLine(r.note), distance = tidyLine(r.distance), link = String(r.link == null ? '' : r.link).trim();
      if (!name && !note && !distance && !link) continue;               // an empty row the host left
      const n = recs.length + 1;
      if (!name) return { error: `Recommendation ${n} needs a name.` };
      if (name.length > LIMITS.recName) return { error: `The name of recommendation ${n} is longer than ${LIMITS.recName} characters.` };
      if (note.length > LIMITS.recNote) return { error: `The note for “${name}” is longer than ${LIMITS.recNote} characters.` };
      if (distance.length > LIMITS.recDistance) return { error: `The distance or time for “${name}” is longer than ${LIMITS.recDistance} characters.` };
      const why = linkProblem(link);
      if (why) return { error: `The link for “${name}” can’t be used: it ${why}.`, field: 'link' };
      recs.push({
        kind: REC_KINDS[r.kind] ? r.kind : 'other',
        name: redact(name, flag), note: redact(note, flag) || '', distance: redact(distance, flag) || '',
        link: link ? new URL(link).toString() : ''
      });
    }
    if (recs.length > LIMITS.recs) return { error: `You can add up to ${LIMITS.recs} recommendations.` };
    values.host_recommendations = recs.filter(x => x.name);
  }
  let dropped = 0;
  if (sentKey(body, 'suggestedExperienceIds')) {
    const raw = Array.isArray(body.suggestedExperienceIds) ? body.suggestedExperienceIds : [];
    const ids = raw.map(x => (x && typeof x === 'object') ? x.id : x).filter(x => x !== null && x !== '' && x !== undefined).map(Number);
    if (ids.some(n => !Number.isInteger(n) || n <= 0)) return { error: 'One of the suggested experiences could not be found.' };
    if (new Set(ids).size !== ids.length) return { error: 'The same experience is suggested twice. Please remove the repeat.' };
    if (ids.length > LIMITS.experiences) return { error: `You can suggest up to ${LIMITS.experiences} Aerva experiences.` };
    if (selfId && ids.includes(Number(selfId))) return { error: 'A listing cannot suggest itself.' };
    let rows = [];
    if (ids.length) rows = await sql`SELECT id, status, COALESCE(listing_type, 'stay') AS listing_type, property_name FROM listings WHERE id = ANY(${ids})`;
    const byId = new Map(rows.map(r => [Number(r.id), r]));
    const keep = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) return { error: 'One of the suggested experiences could not be found.' };
      if (r.listing_type !== 'experience') return { error: `\u201c${r.property_name}\u201d is a stay, not an Aerva experience. Only experiences can be suggested.` };
      if (r.status !== 'approved') { dropped++; continue; }
      keep.push(id);
    }
    values.suggested_experience_ids = keep;
  }
  return { values, redacted: flag.redacted, dropped };
}

// What a listing has now (empty before the migration).
async function readSpecial(sql, listingId) {
  const r = (await sql`SELECT COALESCE(to_jsonb(l)->'special_highlights', '[]'::jsonb) AS special_highlights,
                              to_jsonb(l)->>'special_story' AS special_story,
                              COALESCE(to_jsonb(l)->'host_recommendations', '[]'::jsonb) AS host_recommendations,
                              COALESCE(to_jsonb(l)->'suggested_experience_ids', '[]'::jsonb) AS suggested_experience_ids
                       FROM listings l WHERE id = ${listingId}`)[0];
  return r || { special_highlights: [], special_story: null, host_recommendations: [], suggested_experience_ids: [] };
}

// Saves what cleanSpecial returned. Never throws for a missing column:
// → { saved, skipped, note }.
async function saveSpecial(sql, listingId, values) {
  const v = values || {};
  const hasH = 'special_highlights' in v, hasS = 'special_story' in v, hasR = 'host_recommendations' in v, hasE = 'suggested_experience_ids' in v;
  if (!listingId || (!hasH && !hasS && !hasR && !hasE)) return { saved: false };
  try {
    await sql`UPDATE listings SET
        special_highlights = CASE WHEN ${hasH} THEN ${JSON.stringify(v.special_highlights || [])}::jsonb ELSE special_highlights END,
        special_story = CASE WHEN ${hasS} THEN ${hasS ? v.special_story : null}::text ELSE special_story END,
        host_recommendations = CASE WHEN ${hasR} THEN ${JSON.stringify(v.host_recommendations || [])}::jsonb ELSE host_recommendations END,
        suggested_experience_ids = CASE WHEN ${hasE} THEN ${JSON.stringify(v.suggested_experience_ids || [])}::jsonb ELSE suggested_experience_ids END
      WHERE id = ${listingId}`;
    return { saved: true };
  } catch (err) {
    if (err && err.code === '42703') {
      console.warn('listing special text not saved (apply migrations/2026-11-09-09-listing-special.sql):', err.message);
      return { saved: false, skipped: true, note: NOT_SAVED_NOTE };
    }
    throw err;
  }
}

// For the admin's emails: what changed, as escaped HTML lines.
function describeChange(before, values, esc) {
  const lines = [];
  const same = (a, b) => JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);
  if ('special_highlights' in values && !same(before.special_highlights || [], values.special_highlights)) {
    lines.push('What’s special: ' + (values.special_highlights.length ? values.special_highlights.map(t => '• ' + esc(t)).join('<br>') : '(removed)'));
  }
  if ('special_story' in values && !same(before.special_story || null, values.special_story || null)) {
    lines.push('The story of this place: ' + (values.special_story ? esc(values.special_story) : '(removed)'));
  }
  if ('host_recommendations' in values && !same(before.host_recommendations || [], values.host_recommendations)) {
    lines.push('Recommended by your host: ' + (values.host_recommendations.length
      ? values.host_recommendations.map(r => `• [${esc(REC_KINDS[r.kind] || 'Other')}] ${esc(r.name)}${r.note ? ' — ' + esc(r.note) : ''}${r.distance ? ' (' + esc(r.distance) + ')' : ''}${r.link ? ' — ' + esc(r.link) : ''}`).join('<br>')
      : '(removed)'));
  }
  if ('suggested_experience_ids' in values && !same((before.suggested_experience_ids || []).map(Number), values.suggested_experience_ids)) {
    lines.push('Suggested Aerva experiences: ' + (values.suggested_experience_ids.length ? values.suggested_experience_ids.map(id => '#' + Number(id)).join(', ') : '(removed)'));
  }
  return lines;
}

// Live experiences suggested on a stay, for the guest's booking step
// (get-listings ?suggestedFor=<listingId>). Anything no longer live, or no
// longer an experience, is dropped here. Order is the host's.
async function suggestedFor(sql, listingId) {
  let ids = [];
  try {
    const r = (await sql`SELECT COALESCE(to_jsonb(l)->'suggested_experience_ids', '[]'::jsonb) AS ids, COALESCE(listing_type, 'stay') AS listing_type
                         FROM listings l WHERE id = ${Number(listingId) || 0}`)[0];
    if (!r || r.listing_type !== 'stay') return [];
    ids = (Array.isArray(r.ids) ? r.ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, LIMITS.experiences);
  } catch (e) { return []; }
  if (!ids.length) return [];
  const rows = await sql`SELECT id, property_name, city, nightly_rate AS price, experience_price_unit, experience_duration_hours, experience_duration_days,
                                cover_photo_url, exterior_photo_urls, interior_photo_urls
                         FROM listings WHERE id = ANY(${ids}) AND status = 'approved' AND listing_type = 'experience'`;
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  return ids.map(id => byId.get(id)).filter(Boolean).map(cardOf);
}

function cardOf(r) {
  const photos = [r.cover_photo_url, ...(Array.isArray(r.exterior_photo_urls) ? r.exterior_photo_urls : []), ...(Array.isArray(r.interior_photo_urls) ? r.interior_photo_urls : [])];
  const photo = photos.map(p => typeof p === 'string' ? p : (p && p.url)).find(Boolean) || null;
  return { id: Number(r.id), name: r.property_name, city: r.city || '', price: r.price != null ? Number(r.price) : null,
    priceUnit: r.experience_price_unit || null, durationHours: r.experience_duration_hours != null ? Number(r.experience_duration_hours) : null,
    durationDays: r.experience_duration_days != null ? Number(r.experience_duration_days) : null, photo };
}

// The host's picker (get-listings ?experiencePick=1&q=&city=&ids=): live
// experiences from any host, the host's own city first, then the rest.
// ids= returns those exact ones (to show what is already picked).
async function pickExperiences(sql, { q = '', city = '', ids = '' } = {}) {
  const idList = String(ids || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 20);
  if (idList.length) {
    const rows = await sql`SELECT id, property_name, city, nightly_rate AS price, experience_price_unit, experience_duration_hours, experience_duration_days,
                                  cover_photo_url, exterior_photo_urls, interior_photo_urls
                           FROM listings WHERE id = ANY(${idList}) AND status = 'approved' AND listing_type = 'experience'`;
    return rows.map(cardOf);
  }
  const term = String(q || '').trim().slice(0, 60);
  const like = '%' + term.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
  const c = String(city || '').trim().slice(0, 100);
  const rows = await sql`SELECT id, property_name, city, nightly_rate AS price, experience_price_unit, experience_duration_hours, experience_duration_days,
                                cover_photo_url, exterior_photo_urls, interior_photo_urls,
                                (${c} <> '' AND lower(COALESCE(city, '')) = lower(${c})) AS same_city
                         FROM listings
                         WHERE status = 'approved' AND listing_type = 'experience'
                           AND (${term} = '' OR property_name ILIKE ${like} OR COALESCE(city, '') ILIKE ${like} OR COALESCE(experience_category, '') ILIKE ${like})
                         ORDER BY same_city DESC, property_name ASC
                         LIMIT 30`;
  return rows.map(r => ({ ...cardOf(r), sameCity: !!r.same_city }));
}

module.exports = { LIMITS, REC_KINDS, cleanSpecial, suggestedFor, pickExperiences, readSpecial, saveSpecial, describeChange, linkProblem, NOT_SAVED_NOTE };
