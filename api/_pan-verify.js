// /api/_pan-verify.js — instant PAN check. Not an endpoint.
//
// The host types the PAN and the name as printed, and adds a photo or PDF
// of the PAN card (or e-PAN). Claude (vision) reads the card in memory; the
// code compares what was read with what was typed. Verified at once when:
//   • it is a PAN card (or e-PAN), readable, and does not look edited, a
//     sample or a screenshot of an editing app;
//   • the PAN printed on it is exactly the PAN typed (all 10 characters);
//   • the holder's name on it is the name typed (not the father's name).
// The card is NEVER STORED: it goes from the browser to this function and
// is dropped when the answer goes back. Only the outcome is kept (the PAN,
// encrypted, as before; pan_status 'verified'; the audit log).
//
// When it cannot be verified the host can try again (a clearer photo) or
// send the card for Aerva to check by hand — the earlier review, kept as
// the fallback (the card is then stored until the admin decides, and
// erased then). Messages never say how the check works.

const { decodeFiles, fetchWithTimeout, userError, namesMatch } = require('./_id-verify');
const words = (s) => String(s || '').toUpperCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(Boolean);

const MODEL = () => process.env.ID_CHECK_MODEL || 'claude-sonnet-5-5';
const ATTEMPTS_PER_DAY = 5;
const NOT_VERIFIED = 'We could not verify this PAN card. Use a clear, straight photo of the whole card, and check that the PAN and your name are exactly as printed on it.';

const SYSTEM_PROMPT = `You check Indian PAN cards (Permanent Account Number, issued by the Income Tax Department) for Aerva, an Indian holiday-rental platform. You are shown one or two images, or a PDF (an e-PAN). Answer ONLY with one JSON object, no other text:
{
 "is_pan_card": true|false,
 "readable": true|false,
 "looks_genuine": true|false,
 "pan_number": "the 10-character PAN exactly as printed (5 letters, 4 digits, 1 letter — read each character carefully, it is printed under 'Permanent Account Number'), or null",
 "holder_name": "the card holder's name exactly as printed (the line labelled Name, or the first name line), or null",
 "fathers_name": "the father's name as printed, or null",
 "date_of_birth": "YYYY-MM-DD, or null",
 "concerns": ["ONLY signs the card is fake or tampered with: edited or overlaid text, mismatched fonts, a sample/specimen, a template, a mock-up, a drawing, a photo of a screen showing an editing app, more than one card"],
 "photo_notes": ["ordinary photo issues that do NOT make the card fake: glare, slight blur, an angle, shadows, a worn or laminated card, a crease"]
}
Rules: Never guess a character you cannot read: use null. Ordinary photo issues go in photo_notes, never in concerns, and do not make the card less genuine. holder_name is the card holder, never the father's name. looks_genuine is false for samples, specimens, templates, mock-ups, drawings, or any sign of editing. A clear photo of a real card, or an e-PAN PDF, is genuine.`;

async function readPanCard(files) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw userError('PAN check is not available right now.', 503, { canSendForReview: true });
  const content = files.map(f => f.type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.bytes.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: f.type, data: f.bytes.toString('base64') } });
  content.push({ type: 'text', text: 'Read this PAN card and answer with the JSON object.' });
  let res;
  try {
    res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL(), max_tokens: 500, system: SYSTEM_PROMPT, messages: [{ role: 'user', content }] })
    }, 40000);
  } catch (err) {
    console.error('PAN check: Claude not reached:', err.message || err);
    throw userError('The PAN check is taking too long right now. Try again in a minute, or send it to Aerva to check.', 503, { canSendForReview: true });
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('PAN check: Claude HTTP', res.status, detail.slice(0, 200));
    if (res.status === 400 && /image|pdf|document/i.test(detail)) throw userError('That file could not be read. Try a clear photo of the PAN card.', 400, { canSendForReview: true });
    throw userError('PAN check is not available right now. Try again later, or send it to Aerva to check.', 503, { canSendForReview: true });
  }
  const data = await res.json().catch(() => null);
  const text = data && Array.isArray(data.content) ? data.content.filter(c => c.type === 'text').map(c => c.text).join('') : '';
  const m = text.match(/\{[\s\S]*\}/);
  try { const parsed = m ? JSON.parse(m[0]) : null; if (parsed && typeof parsed === 'object') return parsed; } catch (e) { /* below */ }
  console.error('PAN check: unclear answer');
  throw userError('PAN check is not available right now. Try again later, or send it to Aerva to check.', 503, { canSendForReview: true });
}

// What was read against what was typed. { ok, reason } — the reason is for
// the audit log only, never shown.
const tidyName = (s) => words(s).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
const cleanPan = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// A PAN is always 5 letters, 4 digits, 1 letter. Characters that look
// alike on a card (O/0, I/1, S/5, B/8, Z/2, G/6) are read for the kind
// the position must hold, so a misread does not fail a real card.
const AS_LETTER = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z', '6': 'G' };
const AS_DIGIT = { O: '0', D: '0', Q: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
function panShape(s) {
  const c = cleanPan(s);
  if (c.length !== 10) return c;
  return c.split('').map((ch, i) => (i >= 5 && i <= 8) ? (AS_DIGIT[ch] || ch) : (AS_LETTER[ch] || ch)).join('');
}
function judgePan(read, input) {
  const r = read || {};
  const no = (reason) => ({ ok: false, reason });
  if (r.is_pan_card !== true) return no('not_a_pan_card');
  if (r.readable === false) return no('unreadable');
  if (r.looks_genuine !== true) return no('not_genuine');
  // Only real signs of a fake count; ordinary photo issues (glare, angle,
  // blur) a model sometimes lists here are ignored.
  const serious = (Array.isArray(r.concerns) ? r.concerns : []).filter(c => /edit|overlay|font|specimen|sample|template|mock|draw|screen|tamper|fake|forg|more than one|another card|altered|pasted/i.test(String(c || '')));
  if (serious.length) return no('concerns');
  const printed = panShape(r.pan_number);
  if (printed.length !== 10) return no('number_unreadable');
  const typed = panShape(input.pan);
  if (printed !== typed) {
    // Which positions differ (1–10) — for the audit log; the PAN itself is never logged.
    const at = printed.split('').map((ch, i) => ch === typed[i] ? 0 : i + 1).filter(Boolean);
    return { ok: false, reason: 'number', numberDiffAt: at };
  }
  if (r.holder_name && namesMatch(input.name, r.holder_name)) return { ok: true, name: tidyName(r.holder_name) };
  // The name typed without the middle name(s) printed on the card (e.g.
  // "Tanish Jain" for TANISH KUMAR JAIN): same first and last name, every
  // typed word on the card. Verified, and the full printed name is kept.
  const t = words(input.name), c = words(r.holder_name);
  if (t.length >= 2 && c.length > t.length && t[0] === c[0] && t[t.length - 1] === c[c.length - 1] && t.every(w => c.includes(w))) {
    return { ok: true, name: tidyName(r.holder_name), middleAdded: true };
  }
  // The father's name typed by mistake: still not verified.
  return no(r.fathers_name && namesMatch(input.name, r.fathers_name) ? 'fathers_name' : 'name');
}

async function attemptsToday(sql, hostId) {
  try {
    const r = await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'pan_check_attempt'
                        AND target_type = 'host' AND target_id = ${Number(hostId) || 0} AND created_at > now() - interval '24 hours'`;
    return Number(r[0] && r[0].n) || 0;
  } catch (e) { return 0; }
}

// { pan, name, files } → { ok: true } or throws a user-facing error
// (with canSendForReview). Records every attempt.
async function checkPanCard(sql, logAudit, hostId, { pan, name, files }) {
  if (await attemptsToday(sql, hostId) >= ATTEMPTS_PER_DAY) {
    throw userError('Too many tries today. Send it to Aerva to check, or try again tomorrow.', 429, { canSendForReview: true });
  }
  const decoded = decodeFiles(files);
  let read;
  try { read = await readPanCard(decoded); }
  finally { decoded.forEach(f => f.bytes.fill(0)); }       // nothing of the card outlives the request
  const verdict = judgePan(read, { pan, name });
  await logAudit(sql, { action: 'pan_check_attempt', success: verdict.ok, actorType: 'host', actorIdentifier: String(hostId),
    targetType: 'host', targetId: hostId, metadata: { reason: verdict.reason || null, middleAdded: !!verdict.middleAdded, numberDiffAt: verdict.numberDiffAt || undefined,
      photoNotes: read && Array.isArray(read.photo_notes) ? read.photo_notes.slice(0, 3).map(x => String(x).slice(0, 80)) : [],
      concerns: read && Array.isArray(read.concerns) ? read.concerns.slice(0, 3).map(x => String(x).slice(0, 80)) : [] } });
  if (!verdict.ok) throw userError(NOT_VERIFIED, 400, { canSendForReview: true });
  // The name exactly as printed on the card (kept as the PAN name).
  return { ok: true, name: verdict.name || null };
}

module.exports = { checkPanCard, judgePan, ATTEMPTS_PER_DAY, SYSTEM_PROMPT };
