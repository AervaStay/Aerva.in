// /api/_rates.js — Aerva's commission (hosts) and service fee (guests), set
// per property type in Admin → Commission settings. Not an endpoint.
//
// Rates live in fee_rates (migrations/2026-10-25-04-fee-rates.sql): one row
// per rate ever set, never edited or deleted. The rate for a booking is
// the row for its audience and property type — or '*' (all types) — with
// the latest effective_from on or before the moment the booking is made;
// when an all-types row and a type's own row compete, the later one wins.
// A booking keeps the rates of the moment it was made, through any later
// change to it (_booking-changes.js passes that moment as `at`).
//
// THE 33-DAY RULE (hosts): a host rate takes effect no sooner than 33 days
// after it is set — 31 days' notice plus 2 days for time zones. It is held
// three times: here when it is set, in the database (CHECK constraint),
// and again here when rates are read (a row that breaks it is ignored).
// Guest rates take effect at once, with no notice.
//
// Hosts affected by a host rate change are emailed a formal notice and
// acknowledge it in their dashboard (host-listings.js). Declining it, or
// not acknowledging it by the date it takes effect, ends the host's
// agreement (_host-agreement.js endAgreement). Every notice and answer is
// kept in fee_rate_notices.

const DEFAULTS = { host: 5, guest: 5 };
const NOTICE_DAYS = 31, TZ_DAYS = 2, MIN_HOST_DAYS = NOTICE_DAYS + TZ_DAYS;   // 33
const PROPERTY_TYPES = ['Entire Home / Villa', 'Studio Apartment', 'Suite within a larger property', 'Cabin / Cottage',
  'Heritage / Traditional Home', 'Resort', 'Other', 'Experience'];
const DAY = 86400e3;
const SITE = 'https://aerva.in';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });

// The rate type of a listing: its property type, or 'Experience'.
function rateType(listing) {
  if (!listing) return 'Other';
  if (String(listing.listing_type || listing.listingType || '') === 'experience') return 'Experience';
  const t = String(listing.property_type || listing.propertyType || '').trim();
  return PROPERTY_TYPES.includes(t) ? t : 'Other';
}
const typeLabel = (t) => t === '*' ? 'all property types' : t;

// A row is valid when it is not withdrawn and (for hosts) keeps the 33-day rule.
function validRow(r) {
  if (r.status === 'cancelled') return false;
  if (r.audience !== 'host' || (r.note === 'starting rate' && r.created_by === 'system')) return true;
  return new Date(r.effective_from).getTime() >= new Date(r.created_at).getTime() + MIN_HOST_DAYS * DAY - 1000;
}

// The row in force for (audience, type) at `at`, from a list of rows.
function rowAt(rows, audience, type, at = new Date(), { exceptId = null } = {}) {
  const t = new Date(at).getTime();
  let best = null;
  for (const r of rows) {
    if (r.audience !== audience || (r.property_type !== type && r.property_type !== '*')) continue;
    if (exceptId && r.id === exceptId) continue;
    if (!validRow(r)) continue;
    const e = new Date(r.effective_from).getTime();
    if (e > t) continue;
    if (!best) { best = r; continue; }
    const be = new Date(best.effective_from).getTime();
    if (e > be || (e === be && r.property_type !== '*' && best.property_type === '*') || (e === be && r.property_type === best.property_type && r.id > best.id)) best = r;
  }
  return best;
}

let cache = { at: 0, rows: null };
async function loadRates(sql, { fresh = false } = {}) {
  if (!fresh && cache.rows && Date.now() - cache.at < 30000) return cache.rows;
  try {
    const rows = await sql`SELECT id, audience, property_type, rate, effective_from, created_at, created_by, note, status, cancelled_at, cancelled_by
                           FROM fee_rates ORDER BY effective_from, id`;
    cache = { at: Date.now(), rows: rows.map(r => Object.assign({}, r, { rate: Number(r.rate) })) };
  } catch (e) {
    cache = { at: Date.now(), rows: [] };       // before the database update: the starting 5% / 5%
  }
  return cache.rows;
}
const clearCache = () => { cache = { at: 0, rows: null }; };

// The rate (a percentage) for audience 'host' | 'guest', a rate type, at a moment.
async function rateAt(sql, audience, type, at = new Date()) {
  const rows = await loadRates(sql);
  const r = rowAt(rows, audience, type, at);
  return r ? Number(r.rate) : DEFAULTS[audience];
}
// Both rates for a listing at a moment: { host, guest, type }.
async function ratesFor(sql, listing, at = new Date()) {
  const type = rateType(listing);
  return { type, host: await rateAt(sql, 'host', type, at), guest: await rateAt(sql, 'guest', type, at) };
}
// The rates in force now for every type: { host: { type: rate }, guest: {...} }.
async function currentRates(sql) {
  const rows = await loadRates(sql);
  const out = { host: {}, guest: {} };
  for (const aud of ['host', 'guest']) for (const t of PROPERTY_TYPES) { const r = rowAt(rows, aud, t); out[aud][t] = r ? Number(r.rate) : DEFAULTS[aud]; }
  return out;
}

// India-time midnight starting a YYYY-MM-DD day.
const istMidnight = (ymd) => new Date(ymd + 'T00:00:00+05:30');
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
// The first day a host rate set now may take effect (India time).
function earliestHostDate(now = new Date()) {
  const min = now.getTime() + MIN_HOST_DAYS * DAY;
  let d = new Date(min + 5.5 * 3600e3).toISOString().slice(0, 10);
  if (istMidnight(d).getTime() < min) d = new Date(istMidnight(d).getTime() + DAY + 5.5 * 3600e3).toISOString().slice(0, 10);
  return d;
}

async function scheduleRate(sql, { audience, propertyType, rate, effectiveDate, note = '', by = 'admin' }) {
  if (!['host', 'guest'].includes(audience)) throw userError('Choose hosts or guests.');
  const type = propertyType === '*' || propertyType === '' || propertyType == null ? '*' : String(propertyType);
  if (type !== '*' && !PROPERTY_TYPES.includes(type)) throw userError('Choose a property type.');
  const pct = Math.round(Number(rate) * 100) / 100;
  if (!(Number.isFinite(pct) && pct >= 0 && pct <= 50)) throw userError('Enter a rate from 0 to 50%.');
  let effective;
  if (audience === 'guest') {
    effective = new Date();                                 // guests: at once
  } else {
    const min = earliestHostDate();
    const d = String(effectiveDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw userError(`Choose the date the new host rate takes effect: ${min} or later.`);
    if (d < min) throw userError(`A host rate can take effect on ${min} at the earliest — 31 days’ notice plus 2 days for time zones.`);
    effective = istMidnight(d);
    if (effective.getTime() < Date.now() + MIN_HOST_DAYS * DAY) throw userError(`A host rate can take effect on ${min} at the earliest.`);
  }
  // 'starting rate' is reserved for the rows the database update adds.
  let cleanNote = String(note || '').trim().slice(0, 300);
  if (/^starting rate$/i.test(cleanNote)) cleanNote = 'Starting rate (set by admin)';
  const rows = await loadRates(sql, { fresh: true });
  const before = rowAt(rows, audience, type === '*' ? 'Other' : type, effective);
  const ins = await sql`INSERT INTO fee_rates (audience, property_type, rate, effective_from, created_by, note)
                        VALUES (${audience}, ${type}, ${pct}, ${effective.toISOString()}, ${String(by).slice(0, 120)}, ${cleanNote || null})
                        RETURNING *`;
  clearCache();
  return { row: ins[0], previousRate: before ? Number(before.rate) : DEFAULTS[audience] };
}

async function cancelRate(sql, id, by = 'admin') {
  const r = (await sql`UPDATE fee_rates SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${String(by).slice(0, 120)}
                       WHERE id = ${Number(id) || 0} AND status = 'set' AND effective_from > now() AND COALESCE(note, '') <> 'starting rate' RETURNING *`)[0];
  if (!r) throw userError('Only a change that has not yet taken effect can be withdrawn.');
  clearCache();
  // Hosts already told are told it is withdrawn.
  if (r.audience === 'host') {
    try {
      const told = await sql`SELECT n.host_id, h.name, (SELECT email FROM guests g WHERE g.host_id = n.host_id ORDER BY g.id LIMIT 1) AS email
                             FROM fee_rate_notices n JOIN hosts h ON h.id = n.host_id WHERE n.rate_id = ${r.id}`;
      for (const h of told) {
        await sendEmail(h.email, 'Aerva commission revision withdrawn',
          `<div style="font-family:sans-serif; max-width:600px; color:#1c1a17; line-height:1.6;"><p>Dear ${esc(h.name || 'Host')},</p>
           <p>The revision of Aerva’s commission for ${esc(typeLabel(r.property_type))} to ${esc(Number(r.rate))}%, announced for ${esc(dateLabel(r.effective_from))}, has been withdrawn. Your commission stays as it is, and no action is needed.</p>
           <p>Aerva</p></div>`);
      }
    } catch (e) { /* notices table not there yet */ }
  }
  return r;
}

const dateLabel = (v) => new Date(v).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html }) });
    return r.ok;
  } catch (e) { return false; }
}

// The rate types a host rate row applies to.
const typesOf = (row) => row.property_type === '*' ? PROPERTY_TYPES : [row.property_type];

// Notices for every host rate change still to come: each host with a
// listing of an affected type is emailed once and asked to acknowledge.
// Then, for changes now in effect, hosts who neither acknowledged nor
// declined have their agreement ended.
async function runRateNotices(sql, { deadlineMs = 5000 } = {}) {
  const started = Date.now();
  const out = { noticed: 0, ended: 0 };
  let upcoming;
  try {
    upcoming = await sql`SELECT * FROM fee_rates WHERE audience = 'host' AND status = 'set' AND effective_from > now() AND COALESCE(note, '') <> 'starting rate' ORDER BY id`;
  } catch (e) { return Object.assign(out, { skipped: 'database update not applied' }); }
  const rows = await loadRates(sql, { fresh: true });
  for (const r of upcoming) {
    if (!validRow(r)) continue;
    const types = typesOf(r);
    let hosts;
    try {
      hosts = await sql`
        SELECT h.id, h.name, (SELECT email FROM guests g WHERE g.host_id = h.id ORDER BY g.id LIMIT 1) AS email,
               array_agg(DISTINCT CASE WHEN l.listing_type = 'experience' THEN 'Experience' ELSE COALESCE(l.property_type, 'Other') END) AS types
        FROM hosts h JOIN listings l ON l.host_id = h.id
        WHERE l.status IN ('approved', 'pending')
          AND (CASE WHEN l.listing_type = 'experience' THEN 'Experience' ELSE COALESCE(l.property_type, 'Other') END) = ANY(${types})
          AND NOT EXISTS (SELECT 1 FROM fee_rate_notices n WHERE n.rate_id = ${r.id} AND n.host_id = h.id)
        GROUP BY h.id, h.name LIMIT 50`;
    } catch (e) { return Object.assign(out, { skipped: 'database update not applied' }); }
    for (const h of hosts) {
      if (Date.now() - started > deadlineMs) return out;
      const claimed = await sql`INSERT INTO fee_rate_notices (rate_id, host_id) VALUES (${r.id}, ${h.id}) ON CONFLICT DO NOTHING RETURNING id`;
      if (!claimed.length) continue;
      // One commission for the host — not a line per property type.
      const one = oneChange((h.types || []).filter(t => types.includes(t)).map(t => {
        const prev = rowAt(rows, 'host', t, new Date(new Date(r.effective_from).getTime() - 1), { exceptId: r.id });
        return { from: prev ? Number(prev.rate) : DEFAULTS.host, to: Number(r.rate) };
      }), r.rate);
      const html = `<div style="font-family:sans-serif; max-width:620px; color:#1c1a17; line-height:1.6;">
        <p style="font-size:12px; letter-spacing:0.14em; color:#8a6c39;">AERVA</p>
        <p>Dear ${esc(h.name || 'Host')},</p>
        <p>This is formal notice of a revision of Aerva’s commission on your listings: <strong>from ${esc(one.from)} to ${esc(one.to)}</strong>.</p>
        <p><strong>The revised commission applies to bookings made on or after ${esc(dateLabel(r.effective_from))} (12:00 AM, India time).</strong> This notice is given 31 days in advance, with 2 more days to allow for time zones. Bookings made before that date keep the commission in force when they were made.</p>
        <p>Please review and acknowledge the revision in your dashboard before ${esc(dateLabel(r.effective_from))}. If you decline it, or do not acknowledge it by then, your agreement with Aerva ends under the Aerva Host Agreement: your listings are deactivated, confirmed bookings go ahead, and amounts due to you are paid.</p>
        <p><a href="${SITE}/host-dashboard.html" style="background:#1c1a17; color:#f4eadc; padding:11px 20px; text-decoration:none; display:inline-block;">Review and acknowledge</a></p>
        <p style="font-size:13px; color:#6e675d;">Questions: raise a request in the Resolution Center or write to hello@aerva.in.</p></div>`;
      const ok = await sendEmail(h.email, `Notice: revision of Aerva’s commission from ${dateLabel(r.effective_from)}`, html);
      await sql`UPDATE fee_rate_notices SET emailed = ${ok} WHERE id = ${claimed[0].id}`;
      out.noticed++;
    }
  }
  // In effect now, never answered: the agreement ends (once per notice).
  let lapsed = [];
  try {
    lapsed = await sql`SELECT n.id, n.host_id FROM fee_rate_notices n JOIN fee_rates r ON r.id = n.rate_id
                       WHERE r.status = 'set' AND r.effective_from <= now() AND n.acknowledged_at IS NULL AND n.declined_at IS NULL AND n.ended_at IS NULL
                       ORDER BY n.id LIMIT 20`;
  } catch (e) { lapsed = []; }
  for (const n of lapsed) {
    if (Date.now() - started > deadlineMs) break;
    const claimed = await sql`UPDATE fee_rate_notices SET ended_at = now() WHERE id = ${n.id} AND ended_at IS NULL RETURNING id`;
    if (!claimed.length) continue;
    await require('./_host-agreement').endAgreement(sql, n.host_id, { action: 'terminated', via: 'rate_not_acknowledged' });
    out.ended++;
  }
  return out;
}

// What a host is shown: ONE commission, never a rate per property type.
// rates: numbers → "6%", or "5–6%" if the host's listings differ.
function pct(list) {
  const v = [...new Set((list || []).map(Number).filter(n => Number.isFinite(n)))].sort((a, b) => a - b);
  if (!v.length) return '';
  return v.length === 1 ? `${v[0]}%` : `${v[0]}–${v[v.length - 1]}%`;
}
// changes: [{ from, to }] → { from: '5%', to: '6%' }.
function oneChange(changes, fallbackTo) {
  const c = changes || [];
  return { from: pct(c.map(x => x.from)), to: pct(c.length ? c.map(x => x.to) : [fallbackTo]) };
}

// For the host dashboard: notices waiting for this host's answer, with
// the old and new rate for each of the host's own property types.
async function pendingNotices(sql, hostId) {
  try {
    const rows = await sql`SELECT n.id, n.sent_at, r.property_type, r.rate, r.effective_from, r.id AS rate_id
                           FROM fee_rate_notices n JOIN fee_rates r ON r.id = n.rate_id
                           WHERE n.host_id = ${hostId} AND r.status = 'set' AND r.effective_from > now()
                             AND n.acknowledged_at IS NULL AND n.declined_at IS NULL ORDER BY r.effective_from`;
    if (!rows.length) return [];
    const mine = (await sql`SELECT DISTINCT CASE WHEN listing_type = 'experience' THEN 'Experience' ELSE COALESCE(property_type, 'Other') END AS t
                            FROM listings WHERE host_id = ${hostId} AND status IN ('approved', 'pending', 'deactivated')`).map(x => x.t);
    const all = await loadRates(sql);
    return rows.map(n => {
      const types = (n.property_type === '*' ? mine : [n.property_type]).filter(t => mine.includes(t));
      const changes = types.map(t => { const p = rowAt(all, 'host', t, new Date(new Date(n.effective_from).getTime() - 1), { exceptId: n.rate_id });
        return { from: p ? Number(p.rate) : DEFAULTS.host, to: Number(n.rate) }; });
      // One commission for the host — not a line per property type.
      return { id: n.id, rate: Number(n.rate), effectiveFrom: n.effective_from, sentAt: n.sent_at, commission: oneChange(changes, n.rate) };
    });
  } catch (e) { return []; }
}

// Admin: every rate with its state — scheduled (days to go), in effect
// (days and months so far), ended (days and months it lasted), withdrawn.
async function rateHistory(sql) {
  const rows = await loadRates(sql, { fresh: true });
  const now = Date.now();
  let notices = {};
  try {
    (await sql`SELECT rate_id, count(*)::int AS sent, count(acknowledged_at)::int AS acknowledged, count(declined_at)::int AS declined, count(ended_at)::int AS ended
               FROM fee_rate_notices GROUP BY rate_id`).forEach(n => { notices[n.rate_id] = n; });
  } catch (e) { notices = {}; }
  const out = rows.map(r => {
    const from = new Date(r.effective_from).getTime();
    // Ends when the next valid row for the same audience and type (or an
    // all-types row) takes effect after it.
    const next = rows.filter(x => x.id !== r.id && validRow(x) && x.audience === r.audience
      && (r.property_type === '*' ? x.property_type === '*' : (x.property_type === r.property_type || x.property_type === '*'))
      && new Date(x.effective_from).getTime() > from)
      .sort((a, b) => new Date(a.effective_from) - new Date(b.effective_from))[0];
    const until = next ? new Date(next.effective_from).getTime() : null;
    let state, days;
    if (r.status === 'cancelled') { state = 'withdrawn'; days = 0; }
    else if (!validRow(r)) { state = 'ignored'; days = 0; }
    else if (from > now) { state = 'scheduled'; days = Math.ceil((from - now) / DAY); }
    else if (until && until <= now) { state = 'ended'; days = Math.round((until - from) / DAY); }
    else { state = 'in effect'; days = Math.floor((now - from) / DAY); }
    return { id: r.id, audience: r.audience, propertyType: r.property_type, appliesTo: typeLabel(r.property_type), rate: Number(r.rate),
      effectiveFrom: r.effective_from, until: until ? new Date(until).toISOString() : null, setAt: r.created_at, setBy: r.created_by, note: r.note,
      state, days, months: Math.round((days / 30.44) * 10) / 10, notices: notices[r.id] || null, cancelledAt: r.cancelled_at };
  });
  return out.reverse();
}

module.exports = { DEFAULTS, PROPERTY_TYPES, MIN_HOST_DAYS, NOTICE_DAYS, TZ_DAYS, rateType, rateAt, ratesFor, currentRates, loadRates, rowAt, validRow,
  scheduleRate, cancelRate, runRateNotices, pendingNotices, rateHistory, earliestHostDate, istToday, clearCache };
