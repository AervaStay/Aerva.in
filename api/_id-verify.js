// /api/_id-verify.js — instant identity verification. Not an endpoint.
//
// Any government photo ID is accepted (Aadhaar, passport, driving
// licence, voter ID, or a national ID card from outside India). It is
// checked in a few seconds and NEVER STORED: the file goes from the
// browser to this function, is read in memory, and is dropped when the
// answer goes back. It is not uploaded to storage, written to the
// database or logged. Only the outcome is kept (guests.id_verification).
//
// Two ways in:
//
//   1. A photo or PDF of the ID, with the details the person types (name
//      as on the ID, date of birth, last 4 characters of the ID number).
//      Claude (vision) reads the document; the code here compares what it
//      read with what was typed. Verified only when the document is a
//      real, readable, unexpired ID of the type chosen and every typed
//      detail matches it.
//
//   2. Aadhaar paperless offline e-KYC: the ZIP the person downloads from
//      myaadhaar.uidai.gov.in, and its share code. The ZIP is opened in
//      memory, UIDAI's digital signature on the XML is checked against
//      UIDAI's certificate (UIDAI_OFFLINE_CERT in Vercel, PEM; several may
//      be pasted one after another), and the file must be recent. The
//      mobile number and email on the Aadhaar are compared with the
//      account's (the XML carries them only as hashes). Shown only when
//      UIDAI_OFFLINE_CERT is set.
//
// What is kept (guests.id_verification, JSON) — never the document, the
// full ID number, the photo, the address or the date of birth:
//   { method: 'document' | 'aadhaar_offline', docType, name, last4,
//     verifiedAt, phone, email, phoneMatch?, emailMatch? }
// `phone` and `email` record which phone and email the account had when
// it was verified: the account, its phone, its email and the ID are tied
// together from then on.
//
// A host's identity and address proof (hosts.aadhaar_status) is set to
// verified by the same check, with any Indian ID that carries an address
// (all four Indian types do).
//
// Messages never say how the check works.

const crypto = require('crypto');

const MODEL = () => process.env.ID_CHECK_MODEL || 'claude-sonnet-5-5';
const MAX_FILE_BYTES = 4.5 * 1024 * 1024;     // per file, after base64 decoding
const MAX_FILES = 2;                           // front and back
const ATTEMPTS_PER_DAY = 8;
const AADHAAR_ZIP_MAX_AGE_DAYS = 3;

const DOC_TYPES = [
  { key: 'aadhaar', label: 'Aadhaar', india: true, numberHint: 'the last 4 digits of the Aadhaar number' },
  { key: 'passport', label: 'Passport', india: false, numberHint: 'the last 4 characters of the passport number' },
  { key: 'driving_licence', label: 'Driving licence', india: true, numberHint: 'the last 4 characters of the licence number' },
  { key: 'voter_id', label: 'Voter ID (EPIC)', india: true, numberHint: 'the last 4 characters of the EPIC number' },
  { key: 'national_id', label: 'National ID card (outside India)', india: false, numberHint: 'the last 4 characters of the ID number' }
];
const DOC_KEYS = DOC_TYPES.map(d => d.key);
// Types that prove a host's identity AND address (an Indian passport does too).
function provesHostAddress(v) {
  if (!v) return false;
  if (v.method === 'aadhaar_offline') return true;
  if (v.docType === 'passport') return v.country === 'IN';
  return ['aadhaar', 'driving_licence', 'voter_id'].includes(v.docType);
}

const NOT_VERIFIED = 'We could not verify this ID. Check that the photo is clear and shows the whole ID, and that your name, date of birth and the last 4 characters match it exactly.';
const userError = (message, status = 400, extra = {}) => Object.assign(new Error(message), { isUserFacing: true, status }, extra);

// ---------------------------------------------------------------- helpers
const normName = (s) => String(s || '').toUpperCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(Boolean);
// Same person's name: every word of one is in the other (order ignored),
// a single letter standing for a word that starts with it, and the first
// names agree. "Ravi Kumar" = "RAVI KUMAR", "Kumar Ravi", "Ravi K";
// "Ravi Kumar" ≠ "Ravi", "Ravi Kumar Sharma".
function namesMatch(typed, onId) {
  const a = normName(typed), b = normName(onId);
  if (!a.length || !b.length || a.length !== b.length) return false;
  const pool = b.slice();
  for (const w of a) {
    let i = pool.indexOf(w);
    if (i < 0) i = pool.findIndex(p => (p.length === 1 && w.startsWith(p)) || (w.length === 1 && p.startsWith(w)));
    if (i < 0) return false;
    pool.splice(i, 1);
  }
  return a.some(w => w.length > 1 && b.includes(w));
}
// Dates: "YYYY-MM-DD", "DD-MM-YYYY", "DD/MM/YYYY", "DDMMYYYY" or "YYYY" → { y, m, d } (m, d may be null).
function parseDate(s) {
  const t = String(s || '').trim();
  let m;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return { y: +m[1], m: +m[2], d: +m[3] };
  if ((m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) return { y: +m[3], m: +m[2], d: +m[1] };
  if ((m = t.match(/^(\d{2})(\d{2})(\d{4})$/))) return { y: +m[3], m: +m[2], d: +m[1] };
  if ((m = t.match(/^(\d{4})$/))) return { y: +m[1], m: null, d: null };
  return null;
}
function sameBirthDate(typed, onId) {
  const a = parseDate(typed), b = parseDate(onId);
  if (!a || !b || !a.m) return false;
  if (b.m == null) return a.y === b.y;          // some IDs print the year of birth only
  return a.y === b.y && a.m === b.m && a.d === b.d;
}
const last4Of = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-4);
const today = () => new Date().toISOString().slice(0, 10);

function mediaTypeOf(declared, bytes) {
  const b = bytes;
  if (b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
function decodeFiles(files) {
  const list = (Array.isArray(files) ? files : []).slice(0, MAX_FILES + 1);
  if (!list.length) throw userError('Add a photo of your ID.');
  if (list.length > MAX_FILES) throw userError('Add at most two photos: the front and the back.');
  return list.map(f => {
    const raw = String((f && f.data) || '').replace(/^data:[^,]*,/, '');
    let bytes;
    try { bytes = Buffer.from(raw, 'base64'); } catch (e) { bytes = Buffer.alloc(0); }
    if (bytes.length < 1000) throw userError('That file could not be read. Try a clear photo of the ID.');
    if (bytes.length > MAX_FILE_BYTES) throw userError('That file is too large. Use a photo under 4 MB.');
    const type = mediaTypeOf(f.type, bytes);
    if (!type) throw userError('Use a photo (JPG, PNG or WebP) or a PDF of the ID.');
    if (type === 'application/pdf' && /\/Encrypt\b/.test(bytes.toString('latin1'))) {
      throw userError('This PDF is password-protected. Open it, take a screenshot of the ID, and add that instead.');
    }
    return { type, bytes };
  });
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
  try { return await fetch(url, Object.assign({}, opts, ctrl ? { signal: ctrl.signal } : {})); }
  finally { if (t) clearTimeout(t); }
}

// ------------------------------------------------- 1. a photo of the ID
const SYSTEM_PROMPT = `You check identity documents for Aerva, an Indian holiday-rental platform. You are shown one or two images (front and back) or a PDF of what should be a government identity document. Read it carefully and answer ONLY with one JSON object, no other text:
{
 "is_identity_document": true|false,
 "document_type": "aadhaar" | "passport" | "driving_licence" | "voter_id" | "national_id" | "pan" | "other" | "none",
 "issuing_country": "two-letter ISO code, e.g. IN",
 "full_name": "the holder's name exactly as printed in English/Latin letters (for a passport: given names then surname)",
 "date_of_birth": "YYYY-MM-DD, or YYYY if only the year is printed, or null",
 "id_number": "the document number as printed (Aadhaar may be masked like XXXX XXXX 1234), or null",
 "expiry_date": "YYYY-MM-DD or null",
 "has_holder_photo": true|false,
 "readable": true|false,
 "looks_genuine": true|false,
 "concerns": ["short reasons if anything looks wrong: edited text, pasted photo, mismatched fonts, a sample/specimen, a template, a drawing, a screenshot of an editing app, details cut off, etc."]
}
Rules: "national_id" is a national identity card issued outside India. A PAN card is "pan". Never guess a field you cannot read: use null. looks_genuine is false for samples, specimens, templates, mock-ups, obviously edited or computer-generated documents, and photos of a person instead of a document. A photo of a real card on a table, or a phone screenshot of an official e-document (e-Aadhaar, mAadhaar, DigiLocker) is fine.`;

async function readDocument(files) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw userError('ID verification is not available right now. Please try again later.', 503);
  const content = files.map(f => f.type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.bytes.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: f.type, data: f.bytes.toString('base64') } });
  content.push({ type: 'text', text: 'Read this identity document and answer with the JSON object.' });
  let res;
  try {
    res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL(), max_tokens: 600, system: SYSTEM_PROMPT, messages: [{ role: 'user', content }] })
    }, 40000);
  } catch (err) {
    console.error('ID check: Claude not reached:', err.message || err);
    throw userError('ID verification is taking too long right now. Please try again in a minute.', 503);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('ID check: Claude HTTP', res.status, detail.slice(0, 200));
    if (res.status === 400 && /image|pdf|document/i.test(detail)) throw userError('That file could not be read. Try a clear photo of the ID.');
    throw userError('ID verification is not available right now. Please try again later.', 503);
  }
  const data = await res.json().catch(() => null);
  const text = data && Array.isArray(data.content) ? data.content.filter(c => c.type === 'text').map(c => c.text).join('') : '';
  const m = text.match(/\{[\s\S]*\}/);
  try { const parsed = m ? JSON.parse(m[0]) : null; if (parsed && typeof parsed === 'object') return parsed; } catch (e) { /* below */ }
  console.error('ID check: unclear answer');
  throw userError('ID verification is not available right now. Please try again later.', 503);
}

// What was read against what was typed. Returns { ok, reason } — the
// reason is for Aerva's audit log only, never shown.
function judgeDocument(read, input) {
  const r = read || {};
  const reason = (code) => ({ ok: false, reason: code });
  if (r.is_identity_document !== true || r.document_type === 'none') return reason('not_an_id');
  if (r.readable === false) return reason('unreadable');
  if (r.looks_genuine !== true) return reason('not_genuine');
  if (r.has_holder_photo === false) return reason('no_photo');
  const want = input.docType;
  const got = String(r.document_type || '');
  if (got !== want) return reason('wrong_type:' + got);
  const country = String(r.issuing_country || '').toUpperCase().slice(0, 2);
  const def = DOC_TYPES.find(d => d.key === want);
  if (def && def.india && country && country !== 'IN') return reason('wrong_country');
  if (want === 'national_id' && country === 'IN') return reason('wrong_country');
  if (r.expiry_date && /^\d{4}-\d{2}-\d{2}$/.test(String(r.expiry_date)) && String(r.expiry_date) < today()) return reason('expired');
  if (!namesMatch(input.name, r.full_name)) return reason('name');
  if (!sameBirthDate(input.dob, r.date_of_birth)) return reason('dob');
  const l4 = last4Of(r.id_number);
  if (l4.length !== 4 || l4 !== last4Of(input.last4)) return reason('number');
  return { ok: true, country: country || null };
}

function cleanInput(body) {
  const docType = String(body.docType || '');
  if (!DOC_KEYS.includes(docType)) throw userError('Choose which ID this is.');
  const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (normName(name).length < 2) throw userError('Enter your full name exactly as it is on the ID.');
  const dob = String(body.dob || '').trim();
  const d = parseDate(dob);
  if (!d || !d.m || d.y < 1900 || d.y > new Date().getFullYear()) throw userError('Enter your date of birth.');
  const last4 = last4Of(body.last4);
  if (last4.length !== 4) throw userError('Enter the last 4 characters of the ID number.');
  return { docType, name, dob, last4 };
}

// ------------------------------- 2. Aadhaar paperless offline e-KYC (ZIP)
function uidaiCerts() {
  const raw = String(process.env.UIDAI_OFFLINE_CERT || '').replace(/\\n/g, '\n').trim();
  if (!raw) return [];
  const pems = raw.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (pems) return pems;
  // A bare base64 certificate (as UIDAI's .cer often is).
  const b64 = raw.replace(/\s+/g, '');
  return /^[A-Za-z0-9+/=]+$/.test(b64) ? ['-----BEGIN CERTIFICATE-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----'] : [];
}
const aadhaarZipAvailable = () => uidaiCerts().length > 0;

async function unzipXml(zipBytes, shareCode) {
  const zipjs = require('@zip.js/zip.js');
  try { zipjs.configure({ useWebWorkers: false }); } catch (e) { /* older builds */ }
  const reader = new zipjs.ZipReader(new zipjs.Uint8ArrayReader(new Uint8Array(zipBytes)));
  let entries;
  try { entries = await reader.getEntries(); }
  catch (e) { throw userError('That is not the Aadhaar ZIP file. Download it again from myaadhaar.uidai.gov.in (Offline eKYC).'); }
  const xmlEntry = entries.find(e => !e.directory && /\.xml$/i.test(e.filename));
  if (!xmlEntry) { await reader.close().catch(() => {}); throw userError('That is not the Aadhaar ZIP file. Download it again from myaadhaar.uidai.gov.in (Offline eKYC).'); }
  if (xmlEntry.uncompressedSize > 3 * 1024 * 1024) { await reader.close().catch(() => {}); throw userError('That is not the Aadhaar ZIP file.'); }
  try {
    const text = await xmlEntry.getData(new zipjs.TextWriter(), { password: shareCode });
    await reader.close().catch(() => {});
    return text;
  } catch (e) {
    await reader.close().catch(() => {});
    if (/password/i.test(String(e && e.message))) throw userError('The share code is not right for this file.');
    throw userError('That file could not be opened. Download it again from myaadhaar.uidai.gov.in (Offline eKYC).');
  }
}

// UIDAI's signature over the whole file. Returns the signed XML (the
// content the signature covers), or throws.
function verifyUidaiSignature(xml) {
  const { SignedXml } = require('xml-crypto');
  const { DOMParser } = require('@xmldom/xmldom');
  let doc;
  try { doc = new DOMParser({ errorHandler: { warning() {}, error() {}, fatalError(e) { throw new Error(e); } } }).parseFromString(xml, 'text/xml'); }
  catch (e) { throw userError(NOT_VERIFIED_AADHAAR); }
  const root = doc && doc.documentElement;
  if (!root || root.localName !== 'OfflinePaperlessKyc') throw userError(NOT_VERIFIED_AADHAAR);
  const sigs = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature');
  if (sigs.length !== 1 || sigs[0].parentNode !== root) throw userError(NOT_VERIFIED_AADHAAR);
  for (const cert of uidaiCerts()) {
    try {
      const sig = new SignedXml({ publicCert: cert, getCertFromKeyInfo: () => null });
      sig.loadSignature(sigs[0]);
      // The signature must cover the whole document (Reference URI="").
      const refs = sig.getReferences ? sig.getReferences() : sig.references;
      if (!refs || refs.length !== 1 || (refs[0].uri || '') !== '') continue;
      if (sig.checkSignature(xml)) {
        const signed = sig.getSignedReferences ? sig.getSignedReferences() : [];
        return signed && signed[0] ? signed[0] : xml;
      }
    } catch (e) { /* try the next certificate */ }
  }
  throw userError(NOT_VERIFIED_AADHAAR);
}
const NOT_VERIFIED_AADHAAR = 'We could not verify this Aadhaar file. Download a new one from myaadhaar.uidai.gov.in (Offline eKYC) and try again.';

// The XML hashes the mobile and email: SHA-256 of (value + share code),
// applied as many times as the last digit of the Aadhaar number (once
// when it is 0 or 1).
function aadhaarHash(value, shareCode, lastDigit) {
  let h = String(value) + String(shareCode);
  const n = lastDigit > 1 ? lastDigit : 1;
  for (let i = 0; i < n; i++) h = crypto.createHash('sha256').update(h).digest('hex');
  return h;
}

function readAadhaarXml(signedXml) {
  const { DOMParser } = require('@xmldom/xmldom');
  const doc = new DOMParser().parseFromString(signedXml, 'text/xml');
  const root = doc.documentElement;
  const ref = String(root.getAttribute('referenceId') || '');
  const poi = doc.getElementsByTagName('Poi')[0];
  const poa = doc.getElementsByTagName('Poa')[0];
  if (!/^\d{4}\d{17}$/.test(ref) || !poi) throw userError(NOT_VERIFIED_AADHAAR);
  const ts = ref.slice(4);
  const generated = new Date(Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12), +ts.slice(12, 14)) - 5.5 * 3600e3);
  return {
    last4: ref.slice(0, 4),
    generated,
    name: String(poi.getAttribute('name') || '').trim(),
    dob: String(poi.getAttribute('dob') || '').trim(),
    mobileHash: String(poi.getAttribute('m') || '').toLowerCase(),
    emailHash: String(poi.getAttribute('e') || '').toLowerCase(),
    state: poa ? String(poa.getAttribute('state') || '').trim() : ''
  };
}

// ------------------------------------------------------------- storage
async function readVerification(sql, guestId) {
  try {
    const r = (await sql`SELECT to_jsonb(g)->'id_verification' AS v FROM guests g WHERE g.id = ${guestId}`)[0];
    const v = r && r.v;
    return v && typeof v === 'object' && v.verifiedAt ? v : null;
  } catch (err) { return null; }
}

async function attemptsToday(sql, guestId) {
  try {
    const r = await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'id_verification_attempt'
                        AND actor_identifier = ${String(guestId)} AND created_at > now() - interval '24 hours'`;
    return Number(r[0] && r[0].n) || 0;
  } catch (e) { return 0; }
}

async function save(sql, logAudit, account, record, meta) {
  try {
    await sql`UPDATE guests SET id_verification = ${JSON.stringify(record)}::jsonb, id_verified_at = now() WHERE id = ${account.id}`;
  } catch (err) {
    if (err.code === '42703') throw userError('ID verification is not available yet. Please try again later.', 503);
    throw err;
  }
  // A host's identity and address proof.
  let hostVerified = false;
  if (account.host_id && provesHostAddress(record)) {
    try {
      const r = await sql`UPDATE hosts SET aadhaar_status = 'verified', aadhaar_rejection_reason = NULL
                          WHERE id = ${account.host_id} RETURNING id, aadhaar_document_url`;
      hostVerified = r.length > 0;
      // A document uploaded earlier for a manual check is no longer needed: erase it.
      const old = r[0] && r[0].aadhaar_document_url;
      if (old) {
        try {
          const { del } = require('@vercel/blob');
          await del(old);
          await sql`UPDATE hosts SET aadhaar_document_url = NULL WHERE id = ${account.host_id}`;
        } catch (e) { console.error('old ID document not erased yet (kept for the purge):', e.message); }
      }
    } catch (e) { console.error('host ID status not updated:', e.message); }
  }
  await logAudit(sql, { action: 'id_verified', success: true, actorType: 'guest', actorIdentifier: String(account.id),
    targetType: 'guest', targetId: account.id, metadata: Object.assign({ method: record.method, docType: record.docType, hostVerified }, meta || {}) });
  return hostVerified;
}

async function loadAccount(sql, guestId) {
  try {
    return (await sql`SELECT id, host_id, name, email, phone, to_jsonb(guests)->>'first_name' AS first_name,
                             to_jsonb(guests)->>'last_name' AS last_name FROM guests WHERE id = ${guestId}`)[0] || null;
  } catch (e) {
    return (await sql`SELECT id, host_id, name, email, phone FROM guests WHERE id = ${guestId}`)[0] || null;
  }
}

// What the page shows: the outcome only.
function describe(v) {
  if (!v) return null;
  const def = DOC_TYPES.find(d => d.key === v.docType);
  return {
    verified: true,
    method: v.method,
    document: v.method === 'aadhaar_offline' ? 'Aadhaar (paperless e-KYC)' : (def ? def.label : 'ID'),
    name: v.name || null,
    last4: v.last4 || null,
    verifiedAt: v.verifiedAt
  };
}

async function status(sql, guestId) {
  const [v, account] = await Promise.all([readVerification(sql, guestId), loadAccount(sql, guestId)]);
  const fullName = account ? ([account.first_name, account.last_name].filter(Boolean).join(' ') || account.name || '') : '';
  return {
    verification: describe(v),
    isHost: !!(account && account.host_id),
    suggestedName: fullName,
    docTypes: DOC_TYPES.map(d => ({ key: d.key, label: d.label, numberHint: d.numberHint })),
    aadhaarZip: aadhaarZipAvailable(),
    attemptsLeft: Math.max(0, ATTEMPTS_PER_DAY - await attemptsToday(sql, guestId))
  };
}

async function logAttempt(sql, logAudit, guestId, success, metadata) {
  await logAudit(sql, { action: 'id_verification_attempt', success, actorType: 'guest', actorIdentifier: String(guestId),
    targetType: 'guest', targetId: guestId, metadata });
}

// POST { docType, name, dob, last4, files: [{ type, data(base64) }] }
async function verifyDocument(sql, logAudit, guestId, body) {
  const account = await loadAccount(sql, guestId);
  if (!account) throw userError('Please log in again.', 401);
  if (await attemptsToday(sql, guestId) >= ATTEMPTS_PER_DAY) throw userError('Too many tries today. Please try again tomorrow, or write to hello@aerva.in.', 429);
  const input = cleanInput(body || {});
  const files = decodeFiles(body && body.files);
  let read;
  try { read = await readDocument(files); }
  finally { files.forEach(f => f.bytes.fill(0)); }   // nothing of the document outlives the request
  const verdict = judgeDocument(read, input);
  await logAttempt(sql, logAudit, guestId, verdict.ok, { method: 'document', docType: input.docType, reason: verdict.reason || null });
  if (!verdict.ok) {
    if (verdict.reason === 'expired') throw userError('This ID has expired. Use an ID that is still valid.');
    if (verdict.reason && verdict.reason.startsWith('wrong_type')) {
      const def = DOC_TYPES.find(d => d.key === input.docType);
      throw userError('This does not look like ' + (def ? 'a ' + def.label : 'the ID you chose') + '. Choose the right type of ID, or add a clearer photo.');
    }
    throw userError(NOT_VERIFIED);
  }
  const record = {
    method: 'document', docType: input.docType, country: verdict.country || null,
    name: String(read.full_name || input.name).replace(/\s+/g, ' ').trim().slice(0, 120),
    last4: last4Of(read.id_number),
    verifiedAt: new Date().toISOString(),
    phone: account.phone || null, email: account.email || null
  };
  const hostVerified = await save(sql, logAudit, account, record);
  return { verification: describe(record), hostVerified };
}

// POST { zip (base64), zipPassword (the share code) }
async function verifyAadhaarZip(sql, logAudit, guestId, body) {
  if (!aadhaarZipAvailable()) throw userError('This option is not available right now. Add a photo of your ID instead.', 503);
  const account = await loadAccount(sql, guestId);
  if (!account) throw userError('Please log in again.', 401);
  if (await attemptsToday(sql, guestId) >= ATTEMPTS_PER_DAY) throw userError('Too many tries today. Please try again tomorrow, or write to hello@aerva.in.', 429);
  const shareCode = String((body && body.zipPassword) || '').trim();
  if (!shareCode || shareCode.length > 20) throw userError('Enter the share code you chose when downloading the file.');
  let zip;
  try { zip = Buffer.from(String((body && body.zip) || '').replace(/^data:[^,]*,/, ''), 'base64'); } catch (e) { zip = Buffer.alloc(0); }
  if (zip.length < 200 || zip[0] !== 0x50 || zip[1] !== 0x4b) throw userError('That is not the Aadhaar ZIP file. Download it again from myaadhaar.uidai.gov.in (Offline eKYC).');
  if (zip.length > MAX_FILE_BYTES) throw userError('That file is too large to be the Aadhaar ZIP file.');
  let x;
  try {
    const xml = await unzipXml(zip, shareCode);
    x = readAadhaarXml(verifyUidaiSignature(xml));
  } catch (err) {
    await logAttempt(sql, logAudit, guestId, false, { method: 'aadhaar_offline', reason: err.isUserFacing ? 'rejected' : 'error' });
    if (err.isUserFacing) throw err;
    console.error('Aadhaar ZIP check failed:', err.message);
    throw userError(NOT_VERIFIED_AADHAAR);
  } finally { zip.fill(0); }
  const ageDays = (Date.now() - x.generated.getTime()) / 864e5;
  if (!(ageDays >= -0.1 && ageDays <= AADHAAR_ZIP_MAX_AGE_DAYS)) {
    await logAttempt(sql, logAudit, guestId, false, { method: 'aadhaar_offline', reason: 'old_file' });
    throw userError('This Aadhaar file is more than ' + AADHAAR_ZIP_MAX_AGE_DAYS + ' days old. Download a new one from myaadhaar.uidai.gov.in (Offline eKYC).');
  }
  const lastDigit = Number(x.last4.slice(-1));
  const mobile10 = String(account.phone || '').replace(/\D/g, '').slice(-10);
  const phoneMatch = !!(x.mobileHash && mobile10.length === 10 && aadhaarHash(mobile10, shareCode, lastDigit) === x.mobileHash);
  const email = String(account.email || '').trim();
  const emailMatch = !!(x.emailHash && email && [email, email.toLowerCase()].some(e => aadhaarHash(e, shareCode, lastDigit) === x.emailHash));
  const record = {
    method: 'aadhaar_offline', docType: 'aadhaar', country: 'IN',
    name: x.name.slice(0, 120), last4: x.last4,
    verifiedAt: new Date().toISOString(),
    phone: account.phone || null, email: account.email || null, phoneMatch, emailMatch
  };
  await logAttempt(sql, logAudit, guestId, true, { method: 'aadhaar_offline', phoneMatch, emailMatch });
  const hostVerified = await save(sql, logAudit, account, record, { phoneMatch, emailMatch });
  return { verification: describe(record), hostVerified };
}

// For the profile others see: just whether, and with what kind of ID.
async function badgeFor(sql, guestId) {
  const v = await readVerification(sql, guestId);
  return v ? { verified: true, document: v.method === 'aadhaar_offline' ? 'Aadhaar' : ((DOC_TYPES.find(d => d.key === v.docType) || {}).label || 'ID') } : null;
}

module.exports = {
  DOC_TYPES, status, verifyDocument, verifyAadhaarZip, readVerification, describe, badgeFor, provesHostAddress, aadhaarZipAvailable,
  // for tests
  namesMatch, sameBirthDate, judgeDocument, aadhaarHash, last4Of
};
