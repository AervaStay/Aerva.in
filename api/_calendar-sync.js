// /api/_calendar-sync.js — two-way calendar sync (iCal). Not an endpoint.
//
// EXPORT: every listing (and every resort room) has a secret calendar link
//   (get-listings.js?ical=<token>) listing the dates booked on Aerva and the
//   dates the host blocked. Hosts paste it into Airbnb, Agoda, Booking.com,
//   Vrbo… so an Aerva booking closes those dates there.
// IMPORT: hosts paste those platforms' calendar links into Aerva
//   (calendar_feeds). Each sync replaces that feed's dates in
//   listing_blocked_dates (tagged source_feed_id), which every availability
//   check on Aerva already reads — so a date booked elsewhere cannot be
//   booked here.
// WHEN: "Sync now", daily (reviewSweep cron), and just before a booking of
//   that listing is created (create-order.js) — the moment that matters.
//
// Safety: feed links carry the platform's secret, so they are stored
// encrypted. Fetching a host-supplied address from our server is guarded:
// https only, public internet only (no private / internal addresses, checked
// again on every redirect), 8-second timeout, 2 MB limit. A failed sync
// keeps the previous dates — it never silently unblocks anything.
//
// DNS rebinding: the address is checked at the moment of connecting (the
// request's own DNS lookup goes through safeLookup below), so a name that
// answers "public" to the check and "169.254.169.254" to the connection
// is refused too.

const dns = require('dns').promises;
const net = require('net');
const https = require('https');
const crypto = require('crypto');

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 1500;

function isPrivateIpv4(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

// An IPv6 address as 16 bytes, or null. Handles "::" shortening and a
// dotted IPv4 tail ("::ffff:1.2.3.4").
function ipv6Bytes(ip) {
  let v = String(ip).toLowerCase().split('%')[0];
  if (!net.isIPv6(v)) return null;
  let tail = [];
  const dotted = v.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    tail = dotted[1].split('.').map(Number);
    const hex = ((tail[0] << 8) | tail[1]).toString(16) + ':' + ((tail[2] << 8) | tail[3]).toString(16);
    v = v.slice(0, -dotted[1].length) + hex;
  }
  const [head, rest] = v.split('::');
  const h = head ? head.split(':') : [];
  const r = rest !== undefined ? (rest ? rest.split(':') : []) : [];
  const groups = rest !== undefined ? [...h, ...Array(8 - h.length - r.length).fill('0'), ...r] : h;
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) { const n = parseInt(g || '0', 16); out.push(n >> 8, n & 255); }
  return out;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  const b = ipv6Bytes(ip);
  if (!b) return true; // not an address we understand: refuse
  const v4 = (i) => `${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`;
  const zeros = (from, to) => b.slice(from, to).every(x => x === 0);
  // ::  and  ::1
  if (zeros(0, 15) && (b[15] === 0 || b[15] === 1)) return true;
  // IPv4-mapped ::ffff:a.b.c.d (also written ::ffff:a9fe:a9fe)
  if (zeros(0, 10) && b[10] === 255 && b[11] === 255) return isPrivateIpv4(v4(12));
  // IPv4-compatible ::a.b.c.d (deprecated, still routable on some stacks)
  if (zeros(0, 12)) return isPrivateIpv4(v4(12));
  // NAT64 64:ff9b::/96 (well-known) and 64:ff9b:1::/48 (local use)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return zeros(4, 12) ? isPrivateIpv4(v4(12)) : true;
  }
  // 6to4 2002:a.b.c.d::/16 carries an IPv4 address
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIpv4(v4(2));
  // Teredo 2001::/32, documentation 2001:db8::/32 — never a calendar
  if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0 && b[3] === 0) || (b[2] === 0x0d && b[3] === 0xb8))) return true;
  // unique-local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8
  if ((b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) || (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) || b[0] === 0xff) return true;
  return false;
}

// Used as the request's own DNS lookup: resolves the name and refuses the
// connection if ANY answer is private. This is what closes DNS rebinding —
// the checked address is the one connected to.
function safeLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { all: true }).then(addrs => {
    if (!addrs.length) return cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    if (addrs.some(a => isPrivateIp(a.address))) return cb(Object.assign(new Error('private address'), { code: 'EPRIVATE' }));
    if (options && options.all) return cb(null, addrs);
    return cb(null, addrs[0].address, addrs[0].family);
  }, err => cb(err));
}

// Throws a plain-language Error if the address may not be fetched.
async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { throw new Error('That is not a valid link.'); }
  if (u.protocol !== 'https:') throw new Error('Use the https:// calendar link the platform gives you.');
  if (u.username || u.password) throw new Error('That is not a valid calendar link.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('That is not a valid calendar link.');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error('That link’s website could not be found.');
  if (addrs.some(a => isPrivateIp(a.address))) throw new Error('That is not a valid calendar link.');
  return u;
}

// One GET over https, connecting only to an address safeLookup approved.
// Resolves { status, location, text }. Never follows redirects itself.
function httpsGetChecked(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET', lookup: safeLookup, timeout: FETCH_TIMEOUT_MS,
      headers: { 'Accept': 'text/calendar, text/plain, */*', 'User-Agent': 'Aerva-Calendar-Sync/1.0' }
    }, res => {
      const status = res.statusCode || 0;
      const location = res.headers.location || null;
      if (status >= 300 && status < 400) { res.resume(); return resolve({ status, location, text: '' }); }
      if (Number(res.headers['content-length'] || 0) > MAX_BYTES) { res.destroy(); return reject(new Error('That calendar is too large.')); }
      const chunks = []; let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > MAX_BYTES) { res.destroy(); reject(new Error('That calendar is too large.')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status, location, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => reject(new Error('The calendar could not be reached.')));
    });
    // A hard stop for the whole request, not just idle time.
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), FETCH_TIMEOUT_MS);
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', e => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ETIMEDOUT' ? 'The calendar took too long to respond.'
        : e.code === 'EPRIVATE' ? 'That is not a valid calendar link.'
        : e.code === 'ENOTFOUND' ? 'That link’s website could not be found.'
        : 'The calendar could not be reached.'));
    });
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

// Fetch a calendar, following up to 3 redirects, re-checking each one.
async function fetchCalendarText(raw) {
  let url = await assertSafeUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const res = await httpsGetChecked(url);
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = await assertSafeUrl(new URL(res.location, url).toString());
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`The calendar link returned an error (${res.status}). Check the link.`);
    const text = res.text;
    if (text.length > MAX_BYTES) throw new Error('That calendar is too large.');
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link is not a calendar (iCal) link.');
    return text;
  }
  throw new Error('The calendar link redirected too many times.');
}

// YYYY-MM-DD from an iCal DATE or DATE-TIME value (local date as written;
// a UTC "Z" time is read in UTC — booking platforms export whole days).
function icsDate(value) {
  const m = String(value || '').match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// → [{ start, end }] with end EXCLUSIVE (check-out day), as Aerva stores it.
function parseIcs(text) {
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) { cur = {}; continue; }
    if (/^END:VEVENT/i.test(line)) {
      if (cur && cur.start && !/^CANCELLED$/i.test(cur.status || '')) {
        const start = cur.start;
        let end = cur.end || addDays(start, 1);
        if (end <= start) end = addDays(start, 1);
        events.push({ start, end });
      }
      cur = null;
      if (events.length >= MAX_EVENTS) break;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).split(';')[0].toUpperCase();
    const value = line.slice(idx + 1).trim();
    if (name === 'DTSTART') cur.start = icsDate(value);
    else if (name === 'DTEND') cur.end = icsDate(value);
    else if (name === 'STATUS') cur.status = value;
  }
  // Only what can still matter: from yesterday to two years ahead.
  const from = addDays(new Date().toISOString().slice(0, 10), -1);
  const to = addDays(from, 731);
  return events.filter(e => e.end > from && e.start < to);
}

function icsEscape(t) { return String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }
function buildIcs(calName, ranges) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Aerva//Calendar Sync//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(calName)}`];
  for (const r of ranges) {
    out.push('BEGIN:VEVENT', `UID:${r.uid}@aerva.in`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${r.start.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${r.end.replace(/-/g, '')}`,
      `SUMMARY:${icsEscape(r.summary)}`, 'END:VEVENT');
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

function newToken() { return crypto.randomBytes(24).toString('base64url'); }

// Sync one feed. On success its dates are replaced; on failure the old
// dates stay and the error is recorded for the host to see.
async function syncFeed(sql, feed, decryptField) {
  try {
    const url = decryptField(feed.url_enc);
    if (!url) throw new Error('This link could not be read. Remove it and add it again.');
    const events = parseIcs(await fetchCalendarText(url));
    const starts = events.map(e => e.start);
    const ends = events.map(e => e.end);
    const reason = `Booked on ${String(feed.name || 'another site').slice(0, 60)}`;
    // Replace this feed's dates in one step: if the insert fails, the old
    // dates must still be there (a failed sync never unblocks anything).
    if (typeof sql.transaction === 'function') {
      // Neon's HTTP driver runs these as a single transaction.
      const steps = [sql`DELETE FROM listing_blocked_dates WHERE source_feed_id = ${feed.id}`];
      if (events.length) {
        steps.push(sql`
          INSERT INTO listing_blocked_dates (listing_id, room_id, start_date, end_date, reason, source_feed_id)
          SELECT ${feed.listing_id}, ${feed.room_id}, s, e, ${reason}, ${feed.id}
          FROM unnest(${starts}::date[], ${ends}::date[]) AS t(s, e)
        `);
      }
      await sql.transaction(steps);
    } else {
      // No transactions available: add the new rows FIRST, then remove the
      // old ones by id — a failure part-way leaves dates blocked, not open.
      const old = await sql`SELECT id FROM listing_blocked_dates WHERE source_feed_id = ${feed.id}`;
      if (events.length) {
        await sql`
          INSERT INTO listing_blocked_dates (listing_id, room_id, start_date, end_date, reason, source_feed_id)
          SELECT ${feed.listing_id}, ${feed.room_id}, s, e, ${reason}, ${feed.id}
          FROM unnest(${starts}::date[], ${ends}::date[]) AS t(s, e)
        `;
      }
      const oldIds = old.map(r => r.id);
      if (oldIds.length) await sql`DELETE FROM listing_blocked_dates WHERE id = ANY(${oldIds}) AND source_feed_id = ${feed.id}`;
    }
    await sql`UPDATE calendar_feeds SET last_synced_at = now(), last_status = 'ok', last_error = NULL, event_count = ${events.length} WHERE id = ${feed.id}`;
    return { ok: true, events: events.length };
  } catch (err) {
    const msg = String(err.message || 'Sync failed').slice(0, 300);
    try { await sql`UPDATE calendar_feeds SET last_synced_at = now(), last_status = 'error', last_error = ${msg} WHERE id = ${feed.id}`; } catch (e) { /* table missing */ }
    return { ok: false, error: msg };
  }
}

// Sync the feeds of some listings whose last sync is older than
// maxAgeMinutes, in parallel, never taking longer than deadlineMs overall.
// Never throws (a booking must not fail because a feed is down — the old
// dates stay blocked).
async function syncStaleFeeds(sql, decryptField, { listingIds = null, maxAgeMinutes = 15, deadlineMs = 6000, limit = 100 } = {}) {
  try {
    const feeds = listingIds
      ? await sql`SELECT * FROM calendar_feeds WHERE listing_id = ANY(${listingIds.map(Number)})
                    AND (last_synced_at IS NULL OR last_synced_at < now() - make_interval(mins => ${maxAgeMinutes})) LIMIT ${limit}`
      : await sql`SELECT * FROM calendar_feeds WHERE last_synced_at IS NULL OR last_synced_at < now() - make_interval(mins => ${maxAgeMinutes})
                    ORDER BY last_synced_at NULLS FIRST LIMIT ${limit}`;
    if (!feeds.length) return { synced: 0, failed: 0 };
    let synced = 0, failed = 0;
    const work = Promise.all(feeds.map(f => syncFeed(sql, f, decryptField).then(r => { r.ok ? synced++ : failed++; })));
    await Promise.race([work, new Promise(r => setTimeout(r, deadlineMs))]);
    return { synced, failed, total: feeds.length };
  } catch (err) {
    console.error('calendar sync skipped:', err.message);
    return { synced: 0, failed: 0, skipped: true };
  }
}

module.exports = { assertSafeUrl, fetchCalendarText, parseIcs, buildIcs, newToken, syncFeed, syncStaleFeeds, isPrivateIp, safeLookup, ipv6Bytes };
