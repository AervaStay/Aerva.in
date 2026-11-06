// /api/_photo-sort.js — sorts a host's listing photos into the form's
// sections. Not an endpoint (submit-listing.js, POST { sortPhotos }).
//
// The host adds all their photos at once; the browser sends small copies
// (about 640 px, JPEG) with an id each. Claude (vision) looks at them
// together, in one request, and says for each photo:
//   section   exterior | kitchen | washroom | living_room | garden |
//             balcony | bedroom | other
//   room      for bedroom photos, a letter per physical bedroom (photos
//             of the same bedroom share it: "A", "B", …)
//   with      for a washroom / balcony / sitting area that belongs to a
//             bedroom (en-suite), that bedroom's letter
//   sure      false when it cannot tell
// The browser places them (exterior gallery, the one-photo spaces, the
// bedrooms in order A → Bedroom 1, B → Bedroom 2, …) and the host can move
// any of them. Nothing is stored here: the small copies are read in
// memory and dropped. Never decides anything about the listing itself.

const MODEL = () => process.env.PHOTO_SORT_MODEL || process.env.PHOTO_SCAN_MODEL || 'claude-haiku-4-5-20251001';
const MAX_PHOTOS = 40;
const MAX_BYTES = 400 * 1024;            // per small copy, after base64 decoding
const PER_HOUR = 12;                     // sort requests per account
const SECTIONS = ['exterior', 'kitchen', 'washroom', 'living_room', 'garden', 'balcony', 'bedroom', 'other'];

const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });

const SYSTEM_PROMPT = `You sort photos of a holiday-rental property in India (a villa, home, apartment or resort) into the sections of the listing form. You see every photo at once, each preceded by its id. Answer ONLY with one JSON object, no other text:
{"photos":[{"id":"<id>","section":"exterior|kitchen|washroom|living_room|garden|balcony|bedroom|other","room":"A|B|…|null","with":"A|B|…|null","sure":true|false}]}
Sections:
- exterior: the outside of the building, the entrance, gate, facade, driveway, pool, lawn seen with the building, the view of the property from outside, rooftop.
- kitchen: kitchen or kitchenette, dining nook inside the kitchen.
- washroom: bathroom, toilet, shower, vanity.
- living_room: living or sitting room, lounge, dining room, hall.
- garden: a garden, yard, terrace garden, lawn (without the building as the subject).
- balcony: a balcony, verandah, deck, sit-out.
- bedroom: a room with a bed.
- other: anything else — people, documents, screenshots, food close-ups, a map, a logo, an unclear or blank photo.
Bedrooms: give photos of the same physical bedroom the same "room" letter (same bed, walls, furniture, curtains), starting at "A" for the first bedroom you meet. Different bedrooms get different letters.
"with": for a washroom, balcony or sitting area that is clearly part of a particular bedroom (an en-suite you can see from the bed, the same flooring and door, or the same balcony seen from that bedroom), give that bedroom's letter; otherwise null. Never guess: when unsure, null.
"sure": false when you cannot tell the section with confidence.
Every id you were given must appear exactly once.`;

function mediaOk(b) {
  return (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
         (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||
         (b.length > 12 && b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP');
}
function typeOf(b) { return b[0] === 0xff ? 'image/jpeg' : b[0] === 0x89 ? 'image/png' : 'image/webp'; }

function cleanPhotos(list) {
  if (!Array.isArray(list) || !list.length) throw userError('Add some photos first.');
  if (list.length > MAX_PHOTOS) throw userError(`Add up to ${MAX_PHOTOS} photos at a time.`);
  const seen = new Set();
  return list.map(p => {
    const id = String((p && p.id) || '').slice(0, 40);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || seen.has(id)) throw userError('Something went wrong. Please add the photos again.');
    seen.add(id);
    let bytes;
    try { bytes = Buffer.from(String(p.data || '').replace(/^data:[^,]*,/, ''), 'base64'); } catch (e) { bytes = Buffer.alloc(0); }
    if (bytes.length < 500 || bytes.length > MAX_BYTES || !mediaOk(bytes)) throw userError('One of the photos could not be read. Use JPG or PNG photos.');
    return { id, bytes };
  });
}

// Models to try, in order: the one set in Vercel, then the current Haiku,
// then the older one. A model that is not found is skipped; a busy or
// failing service is tried once more while there is time.
function models() {
  const list = [process.env.PHOTO_SORT_MODEL, process.env.PHOTO_SCAN_MODEL, 'claude-haiku-5-5', 'claude-haiku-4-5-20251001'];
  return list.filter((m, i) => m && list.indexOf(m) === i);
}
const failed = (reason, message, status = 503) => Object.assign(userError(message, status), { reason });
const NOT_NOW = 'Sorting is not available right now. Add the photos to each section yourself.';

// Every complete {"id": …} object in the text, even when the answer was
// cut off or wrapped in other text.
function readAnswer(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  try { const parsed = m ? JSON.parse(m[0]) : null; if (parsed && Array.isArray(parsed.photos)) return parsed.photos; } catch (e) { /* below */ }
  const out = [];
  (String(text || '').match(/\{[^{}]*"id"[^{}]*\}/g) || []).forEach(x => { try { out.push(JSON.parse(x)); } catch (e) { /* skip */ } });
  return out;
}

async function ask(photos) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw failed('no_key', NOT_NOW);
  const content = [];
  photos.forEach(p => {
    content.push({ type: 'text', text: `id: ${p.id}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: typeOf(p.bytes), data: p.bytes.toString('base64') } });
  });
  content.push({ type: 'text', text: 'Sort these photos. Answer with the JSON object only, on one line, no spaces or line breaks.' });
  const started = Date.now();
  const left = () => 52000 - (Date.now() - started);
  const queue = models();
  let lastReason = 'ai_error', retried = false;
  while (queue.length && left() > 8000) {
    const model = queue[0];
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), left()) : null;
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl ? ctrl.signal : undefined,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: Math.min(4096, 400 + photos.length * 70), system: SYSTEM_PROMPT, messages: [{ role: 'user', content }] })
      });
    } catch (err) {
      throw failed('timeout', 'Sorting is taking too long right now. Try again, or add the photos to each section yourself.');
    } finally { if (timer) clearTimeout(timer); }
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const text = data && Array.isArray(data.content) ? data.content.filter(c => c.type === 'text').map(c => c.text).join('') : '';
      const answer = readAnswer(text);
      if (answer.length) return { answer, model, cutOff: !!(data && data.stop_reason === 'max_tokens') };
      console.error('photo sort: unreadable answer from', model, (data && data.stop_reason) || '', text.slice(0, 300));
      throw failed('bad_answer', NOT_NOW);
    }
    const body = (await res.text().catch(() => '')).slice(0, 300);
    console.error('photo sort: Claude HTTP', res.status, model, body);
    if (res.status === 401 || res.status === 403) throw failed('bad_key', NOT_NOW);
    if (res.status === 404 || (res.status === 400 && /model/i.test(body))) { queue.shift(); lastReason = 'no_model'; continue; }
    if (res.status === 400 && /too large|exceed|size/i.test(body)) throw failed('too_big', 'These photos are too many to sort at once. Add fewer at a time, or add them to each section yourself.', 400);
    if ([429, 500, 502, 503, 529].includes(res.status) && !retried) { retried = true; lastReason = 'busy'; await new Promise(r => setTimeout(r, 1500)); continue; }
    lastReason = res.status === 429 || res.status === 529 ? 'busy' : res.status === 400 ? 'refused' : 'ai_error';
    break;
  }
  throw failed(lastReason, NOT_NOW);
}

// Claude's answer → a clean result for every id sent, in the order sent.
// Bedroom letters come only from bedroom photos, renumbered A, B, C… in
// the order met; a "with" that names no such bedroom is dropped.
function normalise(ids, answer) {
  const byId = new Map();
  (Array.isArray(answer) ? answer : []).forEach(a => { if (a && ids.includes(String(a.id)) && !byId.has(String(a.id))) byId.set(String(a.id), a); });
  const key = (x) => { const k = String(x || '').trim().toUpperCase(); return /^[A-Z]{1,2}$/.test(k) ? k : null; };
  const isSure = (a) => byId.has(String(a.id)) && a.sure !== false && SECTIONS.includes(a.section);
  const letters = new Map();
  ids.forEach(id => {
    const a = byId.get(id);
    if (!a || !isSure(a) || a.section !== 'bedroom') return;
    const k = key(a.room) || 'A';
    if (!letters.has(k)) letters.set(k, String.fromCharCode(65 + letters.size));
  });
  return ids.map(id => {
    const a = byId.get(id);
    if (!a || !isSure(a)) return { id, section: 'other', room: null, with: null, sure: false };
    const section = a.section;
    const room = section === 'bedroom' ? letters.get(key(a.room) || 'A') : null;
    const w = ['washroom', 'balcony', 'living_room'].includes(section) ? letters.get(key(a.with)) || null : null;
    return { id, section, room, with: w, sure: true };
  });
}

async function sortPhotos(sql, logAudit, guestId, body) {
  try {
    const r = await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'listing_photos_sorted'
                        AND actor_identifier = ${String(guestId)} AND created_at > now() - interval '1 hour'`;
    if ((r[0] && r[0].n) >= PER_HOUR) throw userError('You have sorted photos many times in the last hour. Add these to each section yourself, or try again later.', 429);
  } catch (e) { if (e.isUserFacing) throw e; }
  const photos = cleanPhotos(body && body.photos);
  let got;
  try { got = await ask(photos); }
  catch (e) {
    // Recorded so the reason can be seen in Admin → Audit log.
    if (e.reason) await logAudit(sql, { action: 'listing_photos_sort_failed', success: false, actorType: 'guest', actorIdentifier: String(guestId),
      targetType: 'guest', targetId: guestId, metadata: { photos: photos.length, reason: e.reason } }).catch(() => {});
    throw e;
  }
  finally { photos.forEach(p => p.bytes.fill(0)); }
  const result = normalise(photos.map(p => p.id), got.answer);
  const counts = result.reduce((c, x) => { c[x.section] = (c[x.section] || 0) + 1; return c; }, {});
  await logAudit(sql, { action: 'listing_photos_sorted', success: true, actorType: 'guest', actorIdentifier: String(guestId),
    targetType: 'guest', targetId: guestId, metadata: { photos: result.length, counts, model: got.model, cutOff: got.cutOff } });
  return { photos: result };
}

module.exports = { sortPhotos, normalise, readAnswer, models, SECTIONS, MAX_PHOTOS, SYSTEM_PROMPT };
