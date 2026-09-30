// /api/_redact.js — taking contact details out of messages. Not an endpoint.
//
// Used for every message a guest or host types (guest-profile.js, mode
// 'send') and for every template Aerva sends on the host's behalf
// (_template-scheduling.js). What is stored and shown is decided here, on
// the server — never trust a filter in the page.
//
// A phone number is found however it is written:
//   • digits in any spacing or punctuation:  98765 43210, 98-765-432-10
//   • digits split by a word glued between them:  91infinity907207
//   • digits split by letters or emoji:  9a8b7c6d5e..., 9🙂8🙂7...
//   • any digit script: Devanagari ९८७, Bengali, Tamil, Arabic-Indic,
//     fullwidth ９８, maths 𝟗𝟖, circled ⑨, keycap 9️⃣, 🔟
//   • number words, English and Hindi (Latin and Devanagari):
//     "nine eight seven", "nineeightseven", "n i n e", "nau aath saat",
//     "नौ आठ सात", mixed with digits: "9 eight 7 six"
//   • lookalike letters glued to digits: 98765432lO
//   • invisible characters slipped between digits (zero-width spaces)
//   • a number split over several messages: see splitNumberCheck, used by
//     guest-profile.js with the sender's recent messages.
// Seven or more digits written together is a number. Ten or more digits
// anywhere in one message (apart from dates, times, prices and a PIN code)
// is treated as a number spread out, and every digit is removed.
//
// Emails, UPI IDs, and Instagram/Facebook/WhatsApp/Telegram/Snapchat
// mentions and links are removed too.
//
// Honest limit: this is pattern-based. It closes every trick above, but a
// person determined enough can still describe a number in ways no filter
// recognises (a riddle, a picture sent elsewhere). Anything shown in
// Admin that slipped through is worth adding here.

// ---------------------------------------------------------------- words

// Digits each word stands for. strong: counted anywhere. ambiguous: an
// ordinary word too, counted only right next to other digits.
const STRONG_WORDS = {
  zero: 1, one: 1, two: 1, three: 1, four: 1, five: 1, six: 1, seven: 1, eight: 1, nine: 1,
  ten: 2, eleven: 2, twelve: 2, thirteen: 2, fourteen: 2, fifteen: 2, sixteen: 2, seventeen: 2, eighteen: 2, nineteen: 2,
  twenty: 1, thirty: 1, forty: 1, fourty: 1, fifty: 1, sixty: 1, seventy: 1, eighty: 1, ninety: 1,
  // Hindi (Latin letters)
  shunya: 1, shoonya: 1, sunya: 1, shuniya: 1, chaar: 1, paanch: 1, panch: 1, chhe: 1, chhah: 1, chheh: 1, chah: 1,
  saat: 1, aath: 1, aat: 1, nau: 1, naw: 1, das: 2,
  // Hindi (Devanagari)
  'शून्य': 1, 'शुन्य': 1, 'एक': 1, 'दो': 1, 'तीन': 1, 'चार': 1, 'पांच': 1, 'पाँच': 1, 'छह': 1, 'छः': 1, 'छे': 1, 'छै': 1,
  'सात': 1, 'आठ': 1, 'नौ': 1, 'नो': 1, 'दस': 2
};
const AMBIGUOUS_WORDS = {
  o: 1, oh: 1, zer0: 1, won: 1, to: 1, too: 1, tu: 1, for: 1, fore: 1, ate: 1, nein: 1, fiv: 1, sevn: 1, nyn: 1,
  ek: 1, do: 1, teen: 1, tin: 1, char: 1, che: 1, cheh: 1, sat: 1, ath: 1, no: 1,
  double: 1, triple: 2
};
// Letters that pass for digits when glued to digits: 98765432lO.
const LOOKALIKE = { o: 1, O: 1, l: 1, I: 1, i: 1, '|': 1, z: 1, Z: 1, s: 1, S: 1, b: 1, B: 1, g: 1, q: 1 };

// "nineeightseven" → three words; null when it isn't all number words.
function segmentNumberWords(word) {
  if (word.length < 6 || word.length > 80 || !/^[a-z]+$/.test(word)) return null;
  const keys = Object.keys(STRONG_WORDS).filter(k => /^[a-z]+$/.test(k));
  const best = new Array(word.length + 1).fill(null);
  best[0] = { parts: 0, digits: 0 };
  for (let i = 0; i < word.length; i++) {
    if (!best[i]) continue;
    for (const k of keys) {
      if (word.startsWith(k, i)) {
        const next = { parts: best[i].parts + 1, digits: best[i].digits + STRONG_WORDS[k] };
        if (!best[i + k.length] || best[i + k.length].digits < next.digits) best[i + k.length] = next;
      }
    }
  }
  const end = best[word.length];
  return end && end.parts >= 2 ? end.digits : null;
}

// ---------------------------------------------------------------- characters

// Zero values of the decimal digit blocks NFKC does not turn into 0-9.
const DIGIT_BASES = [0x660, 0x6F0, 0x7C0, 0x966, 0x9E6, 0xA66, 0xAE6, 0xB66, 0xBE6, 0xC66, 0xCE6, 0xD66, 0xDE6,
  0xE50, 0xED0, 0xF20, 0x1040, 0x1090, 0x17E0, 0x1810, 0x1946, 0x19D0, 0x1A80, 0x1A90, 0x1B50, 0x1BB0, 0x1C40, 0x1C50,
  0xA620, 0xA8D0, 0xA900, 0xA9D0, 0xA9F0, 0xAA50, 0xABF0, 0xFF10];
// How many digits one character stands for (0 if none).
function digitsInChar(ch) {
  if (ch >= '0' && ch <= '9') return 1;
  const cp = ch.codePointAt(0);
  if (cp === 0x1F51F) return 2;                         // 🔟
  for (const b of DIGIT_BASES) if (cp >= b && cp < b + 10) return 1;
  if (cp < 0x80) return 0;
  const n = ch.normalize('NFKC');
  if (n !== ch && /^[\s().]*\d{1,2}[\s().]*$/.test(n)) return (n.match(/\d/g) || []).length;   // ⑨ ⑩ ¹ 𝟗 ９ ⒐
  return 0;
}
const TRANSPARENT = /[\p{Mn}\p{Me}\p{Cf}\uFE0E\uFE0F]/u;          // zero-width, combining, keycap ⃣, variation selectors
const stripTransparent = (s) => s.replace(new RegExp(TRANSPARENT.source, 'gu'), '');
// Only the invisible ones: a word keeps its vowel signs (पांच, तीन).
const stripInvisible = (s) => s.replace(/[\p{Cf}\uFE0E\uFE0F]/gu, '');

// ---------------------------------------------------------------- dates, times, prices

// Spans that are numbers but not phone numbers. They hold no digits for
// the checks below, and a number cannot be joined across them.
function safeSpans(text) {
  const spans = [];
  const add = (re) => { for (const m of text.matchAll(re)) spans.push([m.index, m.index + m[0].length]); };
  add(/(?<![\d\p{L}])(?:0?[1-9]|[12]\d|3[01])[\/.\-](?:0?[1-9]|1[0-2])(?:[\/.\-](?:(?:19|20)\d{2}|\d{2}))?(?![\d\p{L}])/gu);   // 12/10, 12-10-2026
  add(/(?<![\d\p{L}])(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?![\d\p{L}])/gu);                              // 2026-10-12
  add(/(?<![\d\p{L}])(?:[01]?\d|2[0-3])[:.][0-5]\d(?:\s*(?:am|pm|hrs?))?(?![\d\p{L}])/giu);                                  // 11:30, 9.45 pm
  add(/(?<![\d\p{L}])(?:1[0-2]|0?[1-9])\s*(?:am|pm)(?![\p{L}])/giu);                                                          // 9 am
  add(/(?:₹|\brs\.?|\binr)\s*\d{1,3}(?:,\d{2,3}){0,2}(?:\.\d{1,2})?(?![\d,])/giu);                                           // ₹12,500
  add(/(?<![\d,])\d{1,3}(?:,\d{2,3}){0,2}(?:\.\d{1,2})?\s*(?:₹|rs\.?|rupees|inr|\/-)(?![\p{L}])/giu);                         // 12,500 rs
  add(/(?<![\d\p{L}])(?:[1-9]\d?)(?:st|nd|rd|th)(?![\p{L}])/giu);                                                            // 21st
  // A PIN code written as an address: "pincode 411001", ", Pune 411001".
  add(/(?:\b(?:pin|pincode|pin code|postal code|zip)\s*[:\-]?\s*|,\s*\p{L}+(?:\s\p{L}+)?\s+)[1-9]\d{5}(?=\s*(?:[.,;\n]|$))/giu);
  return spans;
}
const inSpans = (spans, a, b) => spans.some(([s, e]) => a < e && b > s);

// ---------------------------------------------------------------- finding digits

// Every place in the text that stands for digits: [{ start, end, digits, strong }].
function findUnits(text, safe) {
  const units = [];
  // 1. digit characters, in any script
  let i = 0;
  for (const ch of text) {
    const d = digitsInChar(ch);
    if (d && !inSpans(safe, i, i + ch.length)) units.push({ start: i, end: i + ch.length, digits: d, strong: true });
    i += ch.length;
  }
  // 2. words (letters with their marks, so Devanagari words stay whole)
  for (const m of text.matchAll(/[\p{L}\p{M}]+/gu)) {
    const start = m.index, end = start + m[0].length;
    if (inSpans(safe, start, end)) continue;
    const raw = stripInvisible(m[0]);
    const w = raw.normalize('NFC').toLowerCase();
    if (STRONG_WORDS[w] !== undefined) { units.push({ start, end, digits: STRONG_WORDS[w], strong: true }); continue; }
    if (AMBIGUOUS_WORDS[w] !== undefined) { units.push({ start, end, digits: AMBIGUOUS_WORDS[w], strong: false }); continue; }
    const seg = segmentNumberWords(w);
    if (seg) { units.push({ start, end, digits: seg, strong: true }); continue; }
    if (raw.length <= 3 && [...raw].every(c => LOOKALIKE[c])) {
      const before = stripTransparent(text.slice(Math.max(0, start - 3), start)).slice(-1);
      const after = stripTransparent(text.slice(end, end + 3)).slice(0, 1);
      if ((before && digitsInChar(before)) || (after && digitsInChar(after))) units.push({ start, end, digits: raw.length, strong: true });
    }
  }
  // 3. spelled out a letter at a time: "n i n e", "n.i.n.e"
  for (const m of text.matchAll(/(?<![\p{L}])\p{L}(?:[\s.\-_*]{1,2}\p{L}){2,}(?![\p{L}])/gu)) {
    const letters = m[0].replace(/[^\p{L}]/gu, '').toLowerCase();
    const d = STRONG_WORDS[letters] || segmentNumberWords(letters);
    if (d && !inSpans(safe, m.index, m.index + m[0].length)) units.push({ start: m.index, end: m.index + m[0].length, digits: d, strong: true, spelled: true });
  }
  units.sort((a, b) => a.start - b.start || b.end - a.end);
  // a spelled-out run replaces the single letters inside it
  const out = [];
  for (const u of units) {
    const last = out[out.length - 1];
    if (last && u.start < last.end) continue;
    out.push(u);
  }
  return out;
}

// Can a number continue across the text between two digit places?
function joins(text, a, b, safe) {
  if (inSpans(safe, a.end, b.start)) return false;
  const gap = stripTransparent(text.slice(a.end, b.start));
  if (!gap) return true;                                         // glued: 9​8, 9️⃣8️⃣
  if (/[-]/.test(gap)) return false;                  // a protected link
  if (!/[\p{L}\p{N}]/u.test(gap)) {                               // spaces, punctuation, emoji
    return gap.replace(/\s+/g, ' ').length <= 6 && (gap.match(/\n/g) || []).length <= 2;
  }
  // one word glued between digits, no spaces: 91infinity907207
  return /^\p{L}{1,15}$/u.test(gap);
}

// The digit places that count, joined into numbers: [{ units, digits }].
function findNumbers(text, safe) {
  const units = findUnits(text, safe);
  // Ambiguous words count only beside a counted neighbour.
  const counted = units.map(u => u.strong);
  let changed = true;
  while (changed) {
    changed = false;
    units.forEach((u, k) => {
      if (counted[k]) return;
      const prev = k > 0 && counted[k - 1] && joins(text, units[k - 1], u, safe);
      const next = k < units.length - 1 && counted[k + 1] && joins(text, u, units[k + 1], safe);
      if (prev || next) { counted[k] = true; changed = true; }
    });
  }
  const live = units.filter((u, k) => counted[k]);
  const groups = [];
  for (const u of live) {
    const g = groups[groups.length - 1];
    if (g && joins(text, g.units[g.units.length - 1], u, safe)) { g.units.push(u); g.digits += u.digits; }
    else groups.push({ units: [u], digits: u.digits });
  }
  return groups;
}

// ---------------------------------------------------------------- links

const SOCIAL_URL_PATTERN = /(instagram\.com|facebook\.com|fb\.com|fb\.me|wa\.me|whatsapp\.com|t\.me|telegram\.me|snapchat\.com)/i;

// Aerva's own Blob store, when it can be told from the upload token
// (vercel_blob_rw_<storeId>_<secret>; the store serves from
// <storeid>.public.blob.vercel-storage.com). Without the token any Blob
// store is accepted — still only a photo link, never free text.
function blobHostPattern() {
  const m = String(process.env.BLOB_READ_WRITE_TOKEN || '').match(/^vercel_blob_rw_([A-Za-z0-9]+)_/);
  const store = m ? m[1].toLowerCase().replace(/[^a-z0-9]/g, '') : '[a-z0-9]+';
  return new RegExp(`^https://${store}\\.public\\.blob\\.vercel-storage\\.com/[A-Za-z0-9._~%/-]+(\\?[A-Za-z0-9=&._-]*)?$`, 'i');
}
// A map link to a latitude/longitude (what @maplink produces from a
// listing's position) — digits, but not a phone number.
const MAP_LATLNG_URL = /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=-?\d{1,3}\.\d+,-?\d{1,3}\.\d+$/;

// Only these links are set aside untouched; every other link is checked
// like any other text. They are set aside at all because a photo's file
// name is full of digit runs and would otherwise be turned into a dead link.
function isProtectedUrl(url) {
  return blobHostPattern().test(url) || MAP_LATLNG_URL.test(url);
}

// ---------------------------------------------------------------- removing

const NUMBER_REMOVED = '[number removed]';

function replaceSpans(text, spans, label) {
  let out = '', at = 0;
  for (const [s, e] of spans.sort((x, y) => x[0] - y[0])) {
    if (s < at) continue;
    out += text.slice(at, s) + label;
    at = e;
  }
  return out + text.slice(at);
}
const collapse = (t) => t.replace(/(\[number removed\][\s,.\-]*){2,}/g, NUMBER_REMOVED + ' ').replace(/\[number removed\] $/, NUMBER_REMOVED);

// Links, emails, UPI IDs and social handles out; protected links parked
// as private-use placeholders. Returns { text, urls, redacted }.
function removeLinksAndHandles(input) {
  let text = String(input == null ? '' : input);
  let redacted = false;
  const urls = [];
  text = text.replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
    if (SOCIAL_URL_PATTERN.test(match)) { redacted = true; return '[contact info removed]'; }
    if (!isProtectedUrl(match)) return match;             // left in place: the checks below see it
    urls.push(match);
    return '' + String.fromCharCode(0xE100 + urls.length - 1) + '';
  });
  text = text.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, () => { redacted = true; return '[email removed]'; });
  // Spelled out: ravi (at) gmail (dot) com, ravi at gmail dot com
  text = text.replace(/[a-zA-Z0-9._%+-]+\s*(?:\(at\)|\[at\]|\sat\s)\s*[a-zA-Z0-9-]+\s*(?:\(dot\)|\[dot\]|\sdot\s)\s*[a-zA-Z]{2,}/gi, () => { redacted = true; return '[email removed]'; });
  // UPI IDs: name@okicici, 98xxxx@ybl
  text = text.replace(/[a-zA-Z0-9._-]{2,}@(?:ok[a-z]+|ybl|ibl|axl|apl|upi|paytm|ptyes|ptaxis|pthdfc|ptsbi|yapl|ikwik|jupiteraxis|fbl|waicici|wahdfcbank|wasbi|waaxis|kotak|icici|hdfcbank|sbi|axisbank|pingpay|freecharge)\b/gi, () => { redacted = true; return '[contact info removed]'; });
  text = text.replace(/\b(instagram|insta|ig|facebook|fb|whatsapp|whats app|watsapp|whatsap|telegram|snapchat)\b\s*(?:id|handle|no\.?|number)?\s*[:@\-]?\s*@?[a-zA-Z][a-zA-Z0-9._]{2,}/gi, (m, _w) => {
    redacted = true; return '[contact info removed]';
  });
  text = text.replace(/\b(instagram\.com|facebook\.com|fb\.com|wa\.me|t\.me)\/[a-zA-Z0-9._]+/gi, () => { redacted = true; return '[contact info removed]'; });
  return { text, urls, redacted };
}
const restoreLinks = (text, urls) => text.replace(/([-])/g, (_m, c) => urls[c.charCodeAt(0) - 0xE100]);

// The main check. { displayText, wasRedacted }.
function redactContactInfo(input) {
  const first = removeLinksAndHandles(input);
  let text = first.text;
  let redacted = first.redacted;
  const safe = safeSpans(text);
  const groups = findNumbers(text, safe);
  const total = groups.reduce((n, g) => n + g.digits, 0);
  let spans;
  if (total >= 10) {
    spans = groups.flatMap(g => g.units.map(u => [u.start, u.end]));           // spread out: every digit goes
  } else {
    spans = groups.filter(g => g.digits >= 7).map(g => [g.units[0].start, g.units[g.units.length - 1].end]);
  }
  if (spans.length) {
    redacted = true;
    text = collapse(replaceSpans(text, spans, NUMBER_REMOVED));
  }
  return { displayText: restoreLinks(text, first.urls), wasRedacted: redacted };
}

// How many digits a message holds (dates, times, prices and links aside).
function digitCount(input) {
  const { text } = removeLinksAndHandles(input);
  return findNumbers(text, safeSpans(text)).reduce((n, g) => n + g.digits, 0);
}
// A short message that is mostly digits: a piece of a number.
function isNumberPiece(input) {
  const { text } = removeLinksAndHandles(input);
  const groups = findNumbers(text, safeSpans(text));
  const digits = groups.reduce((n, g) => n + g.digits, 0);
  if (digits < 3) return false;
  const visible = (t) => stripTransparent(t).replace(/[\s\p{P}\p{S}]/gu, '').length;
  const covered = groups.reduce((n, g) => n + g.units.reduce((k, u) => k + visible(text.slice(u.start, u.end)), 0), 0);
  const all = visible(text);
  return all > 0 && covered / all >= 0.5;
}
// Every digit out, whatever the grouping.
function removeAllDigits(input) {
  const first = removeLinksAndHandles(input);
  const safe = safeSpans(first.text);
  const spans = findNumbers(first.text, safe).flatMap(g => g.units.map(u => [u.start, u.end]));
  const out = spans.length ? collapse(replaceSpans(first.text, spans, NUMBER_REMOVED)) : first.text;
  return restoreLinks(out, first.urls);
}

// A number sent in pieces: "98765" … "43210". Given this message and the
// sender's recent messages in the conversation (newest first,
// [{ id, display_text }]), returns the ids whose digits must go too, or
// null when this message is not part of a split number.
function splitNumberCheck(displayText, recent) {
  if (!isNumberPiece(displayText)) return null;
  let total = digitCount(displayText);
  const pieces = [];
  for (const m of recent || []) {
    if (!isNumberPiece(m.display_text)) continue;
    total += digitCount(m.display_text);
    pieces.push(m.id);
  }
  return total >= 10 ? pieces : null;
}

module.exports = { redactContactInfo, isProtectedUrl, digitCount, isNumberPiece, removeAllDigits, splitNumberCheck, NUMBER_REMOVED };
