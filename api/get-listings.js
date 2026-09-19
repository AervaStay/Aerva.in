// /api/get-listings.js
   // redeploy trigger
// Returns APPROVED listings as JSON — read-only, safe to call publicly;
// never exposes pending/rejected submissions, host contact details beyond
// what's guest-facing, or commission_rate.
//
// Supports optional filters via query params, all combinable:
//   ?reviewsFor=<id>&offset=<n>&limit=<n> — standalone mode: published
//                              reviews for one live listing, first names
//                              only. limit defaults to 5, capped at 100.
//   ?city=Pune              — partial, case-insensitive match against city
//                              (fallback only — see lat/lng below)
//   ?lat=...&lng=...&radiusKm=200 — only listings within this distance of
//                              a point (typically a geocoded place name —
//                              see aerva.html's performSearch). Preferred
//                              over ?city, since a plain text match finds
//                              nothing when a guest searches a nearby town
//                              that doesn't literally match any listing's
//                              city field.
//   ?guests=4               — only listings that can sleep at least this many
//   ?arrival=...&departure=... — only listings with no existing paid
//                                booking that overlaps this date range
//                                (both must be given together)
//   ?availabilityFor=<id>   — a completely different mode: ignores every
//                              other param and returns only that one
//                              listing's booked date ranges, for the
//                              listing page's availability calendar. Kept
//                              in this file rather than its own /api
//                              endpoint to stay under Vercel's Hobby-plan
//                              12-serverless-function limit.
//   ?siteBackground=1       — another standalone mode: returns the
//                              admin's chosen homepage background photos
//                              (saved via the POST mode on
//                              get-pending-listings.js), or an empty list
//                              if none are set yet.
//   ?experiences=1          — another standalone mode: returns every
//                              approved Aerva Experience (listing_type =
//                              'experience'), each joined with a summary
//                              of the property that hosts it. The default
//                              (no special param) query only ever returns
//                              listing_type = 'stay' rows now — experiences
//                              never appear in the regular Suites results.
//   ?currencyRates=1        — public, returns the currency conversion
//                              rates last cached by the daily cron below
//                              (or { rates: null } if none have been
//                              fetched yet — the frontend falls back to
//                              plain INR in that case).
//   ?refreshCurrencyRates=1 — NOT public — requires an Authorization:
//                              Bearer <CRON_SECRET> header, which only
//                              Vercel's own Cron scheduler sends (see
//                              vercel.json). Fetches fresh rates and
//                              caches them; called automatically once a
//                              day, never by the frontend directly.
//
// max_guests is stored as free text (e.g. "4" going forward, but older
// listings may still have range strings like "3–4" or "9+" from before
// the submission form was changed to exact numbers) — parseMaxGuests()
// below extracts the largest number found either way, so filtering works
// correctly against old and new data alike.

const { neon } = require('@neondatabase/serverless');
const { hostTier, reviewScore, REVIEW_FACTORS, propertyTier, propertyFlag,
        propertyCutoffs, PROPERTY_TIERS, experienceTier, EXPERIENCE_FACTORS,
        cityCutoffs, cutoffsForCity, isReviewDay, nextReviewDate } = require('./_tiers');
const { REVIEW_WINDOW_DAYS } = require('./_review-policy');
const { guestTier, GUEST_FACTORS, QUALIFYING_BOOKING_MIN, GUEST_TIERS, HOST_TIERS,
        tierByKey, applyDecayCap } = require('./_tiers');
const { verifyToken, secretMatches } = require('./_approval-token');
const { buildIcs, syncStaleFeeds } = require('./_calendar-sync');
const { decryptField } = require('./_secure-fields');
const { enforceComplianceDeadlines, runAllComplianceScans } = require('./_compliance');
const { DEFAULT_TIMEZONE } = require('./_timezones');
const { answeredQuestions, placesWithAerva } = require('./_profiles');
const { logAudit } = require('./_audit-log');
const { recordTierChange, pendingTierRecomputes, clearTierRecomputes,
        lastSnapshotRun, markSnapshotRun, standingBefore } = require('./_tier-history');
const sql = neon(process.env.DATABASE_URL);

function parseMaxGuests(raw) {
  if (!raw) return null;
  const numbers = String(raw).match(/\d+/g);
  if (!numbers) return null;
  return Math.max(...numbers.map(Number));
}

// Normalizes a DATE column value to 'YYYY-MM-DD' whether the driver
// returns it as a JS Date object or an already-formatted string — same
// helper used in create-order.js for the same reason. Only needed here
// for the ?availabilityFor= branch below.
function toDateStr(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0];
  return String(val).slice(0, 10);
}

// Same Haversine formula used client-side for "distance from me" — kept
// in sync deliberately, since both should agree on what "200km" means.
function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" on every
// scheduled call once CRON_SECRET is set in the project's env vars. Both
// cron paths below require it. Fails CLOSED: with no CRON_SECRET
// configured, nothing is authorized — an unset secret must never turn
// into "anyone may run this". Constant-time compare, same reasoning as
// _approval-token.js.
const crypto = require('crypto');
function isCronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(String(req.headers['authorization'] || ''));
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// A signed-in ADMIN may also run the sweep, from the admin tool's own
// button. CRON_SECRET can never be put in a browser — it would be visible
// to anyone who opened the page — so the admin's existing session is what
// authorises this instead, exactly as it does for every other admin
// action. Same two ways in as get-pending-listings.js: an admin session
// token, or the x-admin-secret header.
function isAdminAuthorized(req) {
  const header = String(req.headers['authorization'] || '');
  if (header.startsWith('Bearer ')) {
    const payload = verifyToken(header.slice(7));
    if (payload && payload.action === 'admin-session') return true;
  }
  return secretMatches(req.headers['x-admin-secret'], process.env.ADMIN_SECRET);
}


// The booking's thread, created if the two have never messaged. Shared by
// the invite and the delivered host review below.
async function conversationForOrder(sql, order) {
  const existing = await sql`SELECT id FROM conversations WHERE order_id = ${order.id}`;
  if (existing[0]) return existing[0].id;
  const ins = await sql`
    INSERT INTO conversations (order_id, listing_id, guest_id, guest_email, host_id)
    VALUES (${order.id}, ${order.listing_id}, ${order.guest_id}, ${order.guest_email}, ${order.host_id})
    RETURNING id`;
  return ins[0].id;
}

// "Please review your stay", in the thread, alongside the email.
async function postReviewInviteToThread(sql, order) {
  const conversationId = await conversationForOrder(sql, order);
  // Says nothing about the host's own review, in either direction. A
  // guest told "published once your host reviews too" learns something
  // about the host's behaviour from the timing alone, which is what the
  // double-blind rule exists to prevent.
  const text = `How was ${order.suite_name || 'your stay'}? Please leave a review from My Bookings — `
    + `you have ${REVIEW_WINDOW_DAYS} days from checkout.`;
  await sql`
    INSERT INTO messages (conversation_id, sender_type, original_text, display_text, was_redacted)
    VALUES (${conversationId}, 'system', ${text}, ${text}, false)`;
}

// The host's review of the guest, once it is public. Written out in full —
// the scores and what they wrote — because a guest should not have to go
// looking for something said about them.
async function postHostReviewToThread(sql, gr) {
  const orders = await sql`
    SELECT o.id, o.guest_id, o.guest_email, o.listing_id, o.suite_name, l.host_id
    FROM orders o JOIN listings l ON l.id = o.listing_id
    WHERE o.id = ${gr.order_id}`;
  const order = orders[0];
  if (!order) return;
  const conversationId = await conversationForOrder(sql, order);
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const parts = [
    ['Cleanliness', num(gr.cleanliness)], ['Communication', num(gr.communication)],
    ['Respectfulness', num(gr.respectful)], ['Rules followed', num(gr.rules)]
  ].filter(p => p[1] !== null).map(p => `${p[0]} ${p[1].toFixed(1)}`);
  // Older reviews carry only a single overall rating.
  if (!parts.length && num(gr.rating)) parts.push(`Overall ${num(gr.rating).toFixed(1)}`);
  const lines = [`Your host has reviewed your stay at ${order.suite_name || 'this property'}.`];
  if (parts.length) lines.push(parts.join(' · '));
  const comment = String(gr.comment || '').trim();
  if (comment) lines.push(`"${comment}"`);
  lines.push('This counts towards your guest standing on Aerva.');
  const text = lines.join('\n');
  await sql`
    INSERT INTO messages (conversation_id, sender_type, original_text, display_text, was_redacted)
    VALUES (${conversationId}, 'system', ${text}, ${text}, false)`;
}

// The post-checkout review invitation. Plain, short, and it links
// straight to the guest's bookings, where the review form lives. Never
// throws: a failed send must not stop the sweep, and is reported so the
// count in the admin tool stays honest.
async function sendReviewPromptEmail(order) {
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set — review prompts cannot be emailed.');
    return false;
  }
  if (!order.guest_email) return false;
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const what = esc(order.suite_name || 'your stay');
  const html = `
    <div style="font-family:sans-serif; max-width:520px;">
      <h2 style="font-family:Georgia,serif;">How was ${what}?</h2>
      <p>Your review helps the next guest choose well, and tells your host what went right or wrong.</p>
      <p>It takes a minute. You have ${REVIEW_WINDOW_DAYS} days from checkout.</p>
      <p><a href="https://aerva.in/index.html?view=my-bookings" style="display:inline-block; background:#1c1a17; color:#f4ebe3; padding:11px 20px; text-decoration:none; border-radius:4px;">Write your review</a></p>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">Questions? Write to hello@aerva.in.</p>
    </div>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Aerva <hello@aerva.in>', to: order.guest_email,
        subject: `How was ${order.suite_name || 'your stay'}?`, html
      })
    });
    if (!res.ok) { console.error('review prompt email failed:', res.status); return false; }
    return true;
  } catch (err) {
    console.error('review prompt email failed:', err);
    return false;
  }
}

// Decides standing for hosts, guests and listings AS OF a moment, and
// records it. Shared by the quarterly review and by admin corrections, so
// both apply identical rules.
//   asOf     — ISO timestamp; only bookings and published reviews before
//              it count, over the twelve months before it.
//   prev     — { host: {id: key}, guest: {id: key} }, standing held going
//              into the review, for the one-rung decay cap.
//   hosts    — null for every host, or an array of host ids.
//   guests   — null for every guest, or an array of guest ids.
//   listings — whether to re-rank listings (always all of them: bands are
//              relative, so one listing cannot be re-ranked alone).
async function runTierSnapshot({ asOf, prev, hosts, guests, listings }) {
  const changes = { listing: 0, host: 0, guest: 0 };
  // Empty array = "none requested", so skip entirely rather than letting
  // ANY('{}') run a pointless query.
  const hostFilter = hosts === null ? null : hosts;
  const guestFilter = guests === null ? null : guests;
  const minPool = Math.min(...PROPERTY_TIERS.map(t => t.minReviews));
  const pool = !listings ? [] : await sql`
    SELECT r.listing_id,
           AVG(r.hygiene) AS hygiene, AVG(r.communication) AS communication,
           AVG(r.services) AS services, AVG(r.value_rating) AS value,
           AVG(r.location) AS location, COUNT(*) AS n,
           BOOL_OR(l.status = 'approved') AS approved,
           MIN(l.city) AS city
    FROM listing_reviews r
    JOIN listings l ON l.id = r.listing_id
    WHERE r.published_at IS NOT NULL AND r.admin_reverted_at IS NULL
      AND r.published_at < ${asOf}
      -- Stay reviews only. Experience reviews carry no hygiene and
      -- are scored on their own factors; counting them here would
      -- inflate review counts and mix their value score into a
      -- property's. See experienceTier for where they do count.
      AND r.hygiene IS NOT NULL
    GROUP BY r.listing_id
  `;
  const scored = pool.map(r => ({
    listingId: r.listing_id,
    approved: r.approved === true,
    city: r.city,
    n: Number(r.n) || 0,
    factors: {
      hygiene: Number(r.hygiene), communication: Number(r.communication),
      services: Number(r.services), value: Number(r.value), location: Number(r.location)
    }
  }));
  // Only APPROVED listings set the bar. A draft, deactivated or
  // removed listing with glowing reviews would otherwise raise the
  // cutoff for every live property, so a real host could lose a
  // badge to something no guest can even book.
  // Ranked within each listing's own CITY, with cities too small to
  // rank internally falling back to the national field. Only live
  // listings set a bar — a draft with glowing reviews must not raise
  // the cutoff for properties a guest can actually book.
  const cityCuts = cityCutoffs(
    scored.filter(x => x.approved && x.n >= minPool)
          .map(x => ({ city: x.city, score: reviewScore(x.factors, REVIEW_FACTORS) })),
    PROPERTY_TIERS
  );

  for (const x of (listings ? scored : [])) {
    // A listing that is not live is skipped entirely: no standing
    // computed, no tier_current update, no history row. Its existing
    // history is left exactly as it stands — an append-only log of
    // what was true while it was live, which is the only honest
    // record of it.
    //
    // The consequence on reactivation is deliberate and worth
    // stating: nothing is restored. The next sweep recomputes from
    // scratch against whatever the bar is THEN, and a listing that
    // was Aerva Exceptional a year ago may come back to nothing,
    // because the field moved on while it was away. Holding a badge
    // earned against a vanished field would be the dishonest option.
    if (!x.approved) continue;

    const t = propertyTier({ reviewCount: x.n, factors: x.factors },
                           cutoffsForCity(cityCuts, x.city));
    const r = await recordTierChange(sql, {
      subjectType: 'listing', subjectId: x.listingId, tier: t,
      score: Number(reviewScore(x.factors, REVIEW_FACTORS).toFixed(3)),
      reviewCount: x.n, cutoffs: cutoffsForCity(cityCuts, x.city)
    });
    if (r.changed) changes.listing++;
  }

  // A live listing that USED to hold a badge but now has no counted
  // reviews at all (every one reverted, say) never appears in the pool
  // above, so it would keep that badge forever. Clear it explicitly.
  // Non-live listings are still left alone, as described above.
  if (listings) {
    const scoredLive = new Set(scored.filter(x => x.approved).map(x => x.listingId));
    const held = await sql`
      SELECT tc.subject_id FROM tier_current tc
      JOIN listings l ON l.id = tc.subject_id AND l.status = 'approved'
      WHERE tc.subject_type = 'listing' AND tc.tier_key IS NOT NULL
    `;
    for (const h of held) {
      if (scoredLive.has(h.subject_id)) continue;
      const r = await recordTierChange(sql, {
        subjectType: 'listing', subjectId: h.subject_id, tier: null,
        score: null, reviewCount: 0, cutoffs: null
      });
      if (r.changed) changes.listing++;
    }
  }

  // Hosts: payout over a rolling twelve months plus their own
  // published reviews. This snapshot is now the ONLY place host
  // standing is decided — the header and listing cards read it.
  const hostRows = (hostFilter && !hostFilter.length) ? [] : await sql`
    SELECT l.host_id,
           COALESCE(SUM(o.payout_amount), 0) AS payout
    FROM listings l
    LEFT JOIN orders o
      ON o.listing_id = l.id AND o.status = 'paid'
      AND o.created_at >= ${asOf}::timestamptz - INTERVAL '12 months'
      AND o.created_at < ${asOf}
    WHERE l.host_id IS NOT NULL
      AND (${hostFilter}::int[] IS NULL OR l.host_id = ANY(${hostFilter}::int[]))
    GROUP BY l.host_id
  `;
  // Host standing counts reviews from the last 12 months across ALL
  // their listings, live or not.
  //
  // Deliberately NOT restricted to approved listings, unlike the
  // property ladder. A host with one excellent property and one poor
  // one could otherwise deactivate the poor one and watch their own
  // average jump — deactivation would become a way to launder a bad
  // record. The rolling window is what handles a genuinely retired
  // property instead: its reviews age out after a year rather than
  // being erased the day it comes down.
  const hostRev = (hostFilter && !hostFilter.length) ? [] : await sql`
    SELECT host_id, AVG(hygiene) AS hygiene, AVG(communication) AS communication,
           AVG(services) AS services, AVG(value_rating) AS value,
           AVG(location) AS location, COUNT(*) AS n
    FROM listing_reviews
    WHERE published_at IS NOT NULL AND admin_reverted_at IS NULL
      AND published_at >= ${asOf}::timestamptz - INTERVAL '12 months'
      AND published_at < ${asOf}
      AND hygiene IS NOT NULL -- stay reviews only; see the property pool above
    GROUP BY host_id
  `;
  const revByHost = {};
  hostRev.forEach(r => { revByHost[r.host_id] = r; });
  for (const h of hostRows) {
    const rv = revByHost[h.host_id];
    const n = rv ? Number(rv.n) || 0 : 0;
    const factors = n > 0 ? {
      hygiene: Number(rv.hygiene), communication: Number(rv.communication),
      services: Number(rv.services), value: Number(rv.value), location: Number(rv.location)
    } : undefined;
    const earned = hostTier({ totalPayout: Number(h.payout) || 0, reviewCount: n, factors });
    const t = applyDecayCap(HOST_TIERS, prev.host[h.host_id], earned);
    const r = await recordTierChange(sql, {
      subjectType: 'host', subjectId: h.host_id, tier: t,
      score: factors ? Number(reviewScore(factors, REVIEW_FACTORS).toFixed(3)) : null,
      reviewCount: n, metric: Number(h.payout) || 0
    });
    if (r.changed) changes.host++;
  }

  // Guests: quarterly, like hosts, against a ROLLING twelve months.
  // This used to count from 1 January of the current year, which on
  // the 1 January review day meant one day of spend, so every guest
  // lost their badge at once.
  //
  // Every guest who has EVER had a paid booking is assessed, not just
  // those active in the window. A guest who stopped booking must
  // decay a rung per quarter; leaving them out would freeze their
  // last badge forever.
  const guestRows = (guestFilter && !guestFilter.length) ? [] : await sql`
    SELECT g.id AS guest_id,
           COALESCE(SUM(o.total), 0) AS spend,
           COUNT(o.id)               AS bookings,
           COUNT(o.id) FILTER (WHERE o.total >= ${QUALIFYING_BOOKING_MIN}) AS qualifying
    FROM guests g
    LEFT JOIN orders o ON o.guest_id = g.id AND o.status = 'paid'
      AND o.created_at >= ${asOf}::timestamptz - INTERVAL '12 months'
      AND o.created_at < ${asOf}
    WHERE EXISTS (SELECT 1 FROM orders x WHERE x.guest_id = g.id AND x.status = 'paid' AND x.created_at < ${asOf})
      AND (${guestFilter}::int[] IS NULL OR g.id = ANY(${guestFilter}::int[]))
    GROUP BY g.id
  `;
  // Same twelve-month window as spend, and as the host side.
  const guestRev = (guestFilter && !guestFilter.length) ? [] : await sql`
    SELECT guest_id, AVG(cleanliness) AS cleanliness, AVG(communication) AS communication,
           AVG(respectful) AS respectful, AVG(rules) AS rules, COUNT(*) AS n
    FROM guest_reviews
    WHERE cleanliness IS NOT NULL
      AND published_at IS NOT NULL AND admin_reverted_at IS NULL
      AND published_at >= ${asOf}::timestamptz - INTERVAL '12 months'
      AND published_at < ${asOf}
    GROUP BY guest_id
  `;
  const revByGuest = {};
  guestRev.forEach(r => { revByGuest[r.guest_id] = r; });
  for (const g of guestRows) {
    const rv = revByGuest[g.guest_id];
    const n = rv ? Number(rv.n) || 0 : 0;
    const factors = n > 0 ? {
      cleanliness: Number(rv.cleanliness), communication: Number(rv.communication),
      respectful: Number(rv.respectful), rules: Number(rv.rules)
    } : undefined;
    const earned = guestTier({
      totalSpend: Number(g.spend) || 0,
      bookingCount: Number(g.bookings) || 0,
      qualifyingBookings: Number(g.qualifying) || 0,
      reviewCount: n, factors
    });
    const t = applyDecayCap(GUEST_TIERS, prev.guest[g.guest_id], earned);
    const r = await recordTierChange(sql, {
      subjectType: 'guest', subjectId: g.guest_id, tier: t,
      score: factors ? Number(reviewScore(factors, GUEST_FACTORS).toFixed(3)) : null,
      reviewCount: n, metric: Number(g.spend) || 0
    });
    if (r.changed) changes.guest++;
  }
  return changes;
}

// Likes per listing (stays and experiences share listing_likes). Never
// throws: before migration_listing_likes.sql has run, or if the query
// fails, every count is simply 0 — likes are decoration, never a reason
// for the listings themselves not to load.
async function attachLikeCounts(rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  const counts = {};
  try {
    const ids = rows.map(r => r.id);
    const found = await sql`
      SELECT listing_id, COUNT(*)::int AS n FROM listing_likes
      WHERE listing_id = ANY(${ids}) GROUP BY listing_id
    `;
    found.forEach(r => { counts[r.listing_id] = Number(r.n) || 0; });
  } catch (err) {
    console.error('like counts failed (non-fatal):', err.message);
  }
  rows.forEach(r => { r.like_count = counts[r.id] || 0; });
}

module.exports = async (req, res) => {
  // CORS first, before ANY branch can return. The review sweep below used
  // to run ahead of these headers, so the admin tool's Batch Jobs button
  // (a browser request carrying an Authorization header) failed twice
  // over: the preflight never allowed Authorization, and the sweep's own
  // response had no Allow-Origin. Vercel's cron is server-to-server and
  // never noticed, which is why the nightly run kept working.
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ---- Calendar export: GET ?ical=<secret token> ----
  // A listing's (or resort room's) calendar for Airbnb, Agoda, Booking.com,
  // Vrbo…: dates booked on Aerva and dates the host blocked. Dates imported
  // FROM those platforms are left out, so calendars never echo each other.
  // The token is the only key: unknown or replaced tokens get 404.
  if (req.method === 'GET' && typeof req.query.ical === 'string') {
    try {
      const token = req.query.ical.trim();
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return res.status(404).send('Not found');
      let listing = (await sql`SELECT id, property_name FROM listings WHERE ical_token = ${token} AND status = 'approved'`)[0] || null;
      let room = null;
      if (!listing) {
        room = (await sql`SELECT r.id, r.room_name, r.listing_id, l.property_name FROM listing_rooms r JOIN listings l ON l.id = r.listing_id
                          WHERE r.ical_token = ${token} AND l.status = 'approved'`)[0] || null;
        if (!room) return res.status(404).send('Not found');
      }
      const listingId = listing ? listing.id : room.listing_id;
      const roomId = room ? room.id : null;
      const orders = await sql`
        SELECT id, arrival::text AS a, departure::text AS d FROM orders
        WHERE listing_id = ${listingId} AND status = 'paid' AND COALESCE(order_type, 'stay') = 'stay'
          AND departure >= CURRENT_DATE - 1
          AND (${roomId}::int IS NULL OR room_id = ${roomId})
      `;
      const blocks = await sql`
        SELECT id, start_date::text AS s, end_date::text AS e FROM listing_blocked_dates
        WHERE listing_id = ${listingId} AND source_feed_id IS NULL AND end_date >= CURRENT_DATE - 1
          AND (room_id IS NULL OR ${roomId}::int IS NULL OR room_id = ${roomId})
      `;
      const ranges = [
        ...orders.map(o => ({ uid: `order-${o.id}`, start: o.a, end: o.d, summary: 'Booked on Aerva' })),
        ...blocks.map(b => ({ uid: `block-${b.id}`, start: b.s, end: b.e, summary: 'Not available' }))
      ].filter(r => r.start && r.end && r.end > r.start);
      const name = 'Aerva — ' + (listing ? listing.property_name : `${room.property_name} · ${room.room_name}`);
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.status(200).send(buildIcs(name, ranges));
    } catch (err) {
      console.error('ical export failed:', err);
      return res.status(500).send('Calendar unavailable');
    }
  }

  // ---- Daily review sweep (cron) ----
  // GET ?reviewSweep=1 — runs once a day from vercel.json. Two jobs:
  //
  //   1. Publish what is due. A review goes live the moment BOTH sides
  //      have reviewed, or once the window closes, whichever comes first.
  //      Both cases are handled here rather than at submission time so
  //      there is a single place that decides visibility.
  //   2. Prompt guests who checked out yesterday and have not reviewed.
  //
  // Vercel's Hobby plan caps cron at once per day, which is why "publish
  // immediately when both sides review" is really "within a day". That is
  // a plan limit, not a design choice — on Pro this becomes hourly by
  // changing the schedule alone, no code change.
  //
  // Cron-only. Without this, anyone who found the URL could run the full
  // tier recompute on demand — and with ?forceTierSnapshot=1, re-rate
  // every host, guest and listing on any day of the quarter, not just a
  // review day. To run it by hand (first deploy, testing):
  //   curl -H "Authorization: Bearer $CRON_SECRET" \
  //     "https://aerva-in.vercel.app/api/get-listings?reviewSweep=1&forceTierSnapshot=1"
  if (req.method === 'GET' && req.query.reviewSweep === '1') {
    if (!isCronAuthorized(req) && !isAdminAuthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Daily calendar sync rides on this job (the Hobby plan runs cron once a
    // day). Feeds not synced in 20 hours; 7-second budget. Anything not
    // reached is still synced before any booking of that listing.
    const calendarSync = await syncStaleFeeds(sql, decryptField, { maxAgeMinutes: 20 * 60, deadlineMs: 7000, limit: 300 });
    try {
      // Both sides in — release the pair together.
      const pairs = await sql`
        UPDATE listing_reviews lr SET published_at = now()
        FROM guest_reviews gr
        WHERE gr.order_id = lr.order_id
          AND lr.published_at IS NULL AND lr.admin_reverted_at IS NULL
          AND gr.admin_reverted_at IS NULL
        RETURNING lr.id
      `;
      const pairsBack = await sql`
        UPDATE guest_reviews gr SET published_at = now()
        FROM listing_reviews lr
        WHERE lr.order_id = gr.order_id
          AND gr.published_at IS NULL AND gr.admin_reverted_at IS NULL
          AND lr.admin_reverted_at IS NULL
        RETURNING gr.id, gr.order_id, gr.comment, gr.rating,
                  gr.cleanliness, gr.communication, gr.respectful, gr.rules
      `;
      // Window closed — publish whatever is there, unmatched. Anchored to
      // the stay's departure, never to when the review was written.
      const lapsedListing = await sql`
        UPDATE listing_reviews lr SET published_at = now()
        FROM orders o JOIN listings l ON l.id = o.listing_id
        WHERE o.id = lr.order_id
          AND lr.published_at IS NULL AND lr.admin_reverted_at IS NULL
          AND o.departure <= (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), ${DEFAULT_TIMEZONE}))::date - ${REVIEW_WINDOW_DAYS}::int
        RETURNING lr.id
      `;
      const lapsedGuest = await sql`
        UPDATE guest_reviews gr SET published_at = now()
        FROM orders o JOIN listings l ON l.id = o.listing_id
        WHERE o.id = gr.order_id
          AND gr.published_at IS NULL AND gr.admin_reverted_at IS NULL
          AND o.departure <= (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), ${DEFAULT_TIMEZONE}))::date - ${REVIEW_WINDOW_DAYS}::int
        RETURNING gr.id, gr.order_id, gr.comment, gr.rating,
                  gr.cleanliness, gr.communication, gr.respectful, gr.rules
      `;

      // ---- The host's review of the guest, delivered to the guest ----
      // Posted into the booking thread at the moment it becomes public,
      // and only then: while it is held, neither side may read the
      // other's. Publication sets published_at once, so each review is
      // delivered exactly once.
      for (const gr of [...pairsBack, ...lapsedGuest]) {
        try {
          await postHostReviewToThread(sql, gr);
        } catch (err) {
          console.error('could not deliver host review for order', gr.order_id, err);
        }
      }

      // Prompt yesterday's checkouts. review_prompt_sent_at is what stops
      // this messaging the same guest every morning until they review.
      const toPrompt = await sql`
        SELECT o.id, o.guest_id, o.guest_email, o.listing_id, o.suite_name, l.host_id
        FROM orders o JOIN listings l ON l.id = o.listing_id
        WHERE o.status = 'paid'
          -- Checked out on the property's calendar, same as the window.
          AND o.departure < (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), ${DEFAULT_TIMEZONE}))::date
          AND o.departure >= (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), ${DEFAULT_TIMEZONE}))::date - 3
          AND o.review_prompt_sent_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM listing_reviews r WHERE r.order_id = o.id)
        LIMIT 200
      `;
      // Three ways, because one is easy to miss: an email, a message in
      // the booking thread, and the bar on the site (that one is counted
      // live from the session, not here). review_prompt_sent_at is what
      // stops any of it repeating every morning.
      let promptedCount = 0;
      for (const o of toPrompt) {
        try {
          const sent = await sendReviewPromptEmail(o);
          try {
            await postReviewInviteToThread(sql, o);
          } catch (err) {
            // The email may well have gone; do not lose it over this.
            console.error('could not post review invite for order', o.id, err);
          }
          // Marked either way: an address that bounces must not be retried
          // every morning for the rest of the window.
          await sql`UPDATE orders SET review_prompt_sent_at = now() WHERE id = ${o.id}`;
          if (sent) promptedCount++;
        } catch (err) {
          // One bad order must not stop the sweep for every other guest.
          console.error('review prompt failed for order', o.id, err);
        }
      }

      // ---- Standing snapshot ----
      // Runs after publication, so today's newly-visible reviews are
      // already counted. Records a row only where standing actually
      // changed; see _tier-history.js for why.
      //
      // The cutoffs are snapshotted with every property row. Without that
      // a historical score is uninterpretable: "4.93" means nothing unless
      // you also know the top-5% bar was 4.92 that day.
      // Standing is recomputed only on a REVIEW DAY — 1 Jan, 1 Apr, 1 Jul,
      // 1 Oct — assessing the quarter just ended, and holds unchanged
      // between them. Everything above (publishing reviews, prompting
      // guests) still runs daily; only the badges are frozen.
      //
      // ?forceTierSnapshot=1 recomputes off-cycle, for testing and for the
      // first run after deploy, when tier_current is empty and waiting for
      // the next quarter would mean no badges anywhere for months.
      // Compliance deadlines are enforced here rather than on a cron of
      // their own: Vercel's Hobby plan allows two cron jobs and both are
      // taken. A listing 15 days past its flag is deactivated the next
      // morning without anyone pressing anything. Never fatal — a failure
      // here must not stop reviews being published.
      // Scan first, then enforce. Scanning daily is what makes this
      // automatic: a listing that stops meeting a requirement is found
      // the next morning and its host told, without an admin running
      // anything. Enforcing afterwards means a listing flagged 15 days
      // ago comes down in the same pass.
      let compliance = null;
      let complianceScan = null;
      try {
        complianceScan = await runAllComplianceScans(sql);
        compliance = await enforceComplianceDeadlines(sql, logAudit);
      } catch (err) {
        console.error('compliance run failed (non-fatal):', err);
      }

      const forceSnapshot = req.query.forceTierSnapshot === '1';
      const summary = {
        calendarSync,
        publishedPaired: pairs.length + pairsBack.length,
        publishedLapsed: lapsedListing.length + lapsedGuest.length,
        prompted: promptedCount,
        complianceFlagged: complianceScan ? complianceScan.reduce((a, r) => a + (r.flagged || 0), 0) : null,
        complianceBlocked: compliance ? compliance.blocked : null,
        nextReview: nextReviewDate(new Date(), 'quarterly')
      };

      // Full review: every subject, as of right now.
      if (isReviewDay(new Date(), 'quarterly') || forceSnapshot) {
        const startedAt = new Date().toISOString();
        let changes;
        try {
          const prevRows = await sql`
            SELECT subject_type, subject_id, tier_key FROM tier_current
            WHERE subject_type IN ('host', 'guest')
          `;
          const prev = { host: {}, guest: {} };
          prevRows.forEach(r => { prev[r.subject_type][r.subject_id] = r.tier_key; });
          changes = await runTierSnapshot({ asOf: startedAt, prev, hosts: null, guests: null, listings: true });
          await markSnapshotRun(sql, startedAt);
          // A full review covers every pending admin correction too.
          await clearTierRecomputes(sql, startedAt);
        } catch (err) {
          console.error('tier snapshot failed (non-fatal):', err);
          changes = { error: true };
        }
        return res.status(200).json({ ...summary, tierChanges: changes });
      }

      // ---- Admin corrections (within 48 hours) ----
      // Between review days badges stay frozen, EXCEPT where an admin has
      // reverted a review. Those subjects get the last quarterly review
      // re-run for them alone, as of the moment it ran, with the reverted
      // review now excluded. See _tier-history.js.
      const queue = await pendingTierRecomputes(sql);
      if (!queue.length) {
        return res.status(200).json({ ...summary, tierSnapshot: 'skipped — not a review day' });
      }
      const takenUpTo = queue.reduce((m, e) => (e.at && e.at > m ? e.at : m), '');
      const lastRun = await lastSnapshotRun(sql);
      if (!lastRun) {
        // No review has ever run, so no badge exists to correct. The first
        // full review will already leave the reverted review out.
        await clearTierRecomputes(sql, takenUpTo);
        return res.status(200).json({ ...summary, corrections: 'none needed — no review has run yet' });
      }
      try {
        const ids = (type) => [...new Set(queue.filter(e => e.type === type && e.id != null).map(e => Number(e.id)))];
        const prev = {
          host: await standingBefore(sql, 'host', lastRun),
          guest: await standingBefore(sql, 'guest', lastRun)
        };
        const changes = await runTierSnapshot({
          asOf: lastRun, prev,
          hosts: ids('host'), guests: ids('guest'),
          listings: queue.some(e => e.type === 'listing')
        });
        await clearTierRecomputes(sql, takenUpTo);
        return res.status(200).json({ ...summary, corrections: { requests: queue.length, asOf: lastRun, changes } });
      } catch (err) {
        // Queue left in place, so tomorrow's sweep retries.
        console.error('tier correction failed (will retry tomorrow):', err);
        return res.status(200).json({ ...summary, corrections: 'failed — will retry at the next sweep' });
      }
    } catch (err) {
      console.error('reviewSweep error:', err);
      return res.status(500).json({ error: 'Review sweep failed.' });
    }
  }


  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ---- Visit counter ----
    // GET ?trackVisit=1 — one per browser per day (the page decides that;
    // see index.html), counted into a per-day tally in site_settings
    // rather than a row per visit: the admin wants "how many people came
    // today", not a log of everyone who scrolled past.
    //
    // Sixty days are kept. Nothing about who: no ip, no account, no
    // fingerprint — a count only.
    if (req.query.trackVisit === '1') {
      try {
        const today = new Date().toISOString().slice(0, 10);
        await sql`
          INSERT INTO site_settings (key, value, updated_at)
          VALUES ('visit_counts', jsonb_build_object(${today}::text, 1), now())
          ON CONFLICT (key) DO UPDATE SET
            value = (
              SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
              FROM (
                SELECT k, CASE WHEN k = ${today} THEN v + 1 ELSE v END AS v
                FROM jsonb_each_text(COALESCE(site_settings.value, '{}'::jsonb)) AS t(k, raw)
                CROSS JOIN LATERAL (SELECT COALESCE(raw::int, 0) AS v) n
                WHERE k > to_char(now() - interval '60 days', 'YYYY-MM-DD')
              ) kept
            ) || jsonb_build_object(${today}::text,
                  COALESCE((site_settings.value->>${today})::int, 0) + 1),
            updated_at = now()
        `;
      } catch (err) {
        // A counter must never be why a page fails to load.
        console.error('visit tracking failed (non-fatal):', err);
      }
      return res.status(200).json({ ok: true });
    }

    // ---- Public numbers for the site ----
    // GET ?publicStats=1 — what a visitor may see: how many stays have
    // actually happened, and how many guests arrived this month. Counts
    // only completed, paid bookings, so it can never flatter the platform
    // with bookings that were cancelled or never paid for.
    // ---- A host's public profile ----
    // GET ?hostProfile=<listingId>
    // Opened from "Hosted by" on a listing, by anyone browsing. Looked up
    // through a LIVE listing rather than a host id, so it cannot be used to
    // walk through every account on Aerva.
    //
    // Only the host side of the person, and only what they chose to share:
    // name, photo, year joined, work, hobbies, their answers, the cities
    // they host in, and published reviews of their properties. Never an
    // email, phone, address, where they have stayed as a guest, or what
    // other hosts wrote about them as a guest — those stay behind a
    // shared booking, as before.
    if (req.query.hostProfile !== undefined) {
      // Signed-in users only (guest session token).
      const auth = String(req.headers['authorization'] || '');
      const who = auth.startsWith('Bearer ') ? verifyToken(auth.slice(7)) : null;
      if (!who || who.action !== 'guest-session') return res.status(401).json({ error: 'Please log in to view host profiles.' });
      const listingId = Number(req.query.hostProfile);
      if (!Number.isInteger(listingId) || listingId <= 0) return res.status(400).json({ error: 'Which listing?' });
      try {
        // The host's account can be linked either way round (guests.host_id,
        // or the older hosts.guest_id), and some hosts have no account row
        // at all yet. None of that should break the page: the profile falls
        // back to the host record and the listing's own host name, and
        // simply shows less.
        const rows = await sql`
          SELECT l.host_id, l.host_name AS listing_host_name,
                 h.name AS host_record_name, h.created_at AS host_created_at,
                 g.id AS account_id, g.name AS account_name, g.profile_photo_url, g.created_at AS account_created_at,
                 g.profile_work, g.profile_hobbies, g.profile_about
          FROM listings l
          LEFT JOIN hosts h ON h.id = l.host_id
          LEFT JOIN LATERAL (
            SELECT * FROM guests gg
            WHERE (l.host_id IS NOT NULL AND gg.host_id = l.host_id)
               OR (h.guest_id IS NOT NULL AND gg.id = h.guest_id)
            ORDER BY (gg.host_id = l.host_id) DESC NULLS LAST, gg.id
            LIMIT 1
          ) g ON true
          WHERE l.id = ${listingId} AND l.status = 'approved'
        `;
        const a = rows[0];
        if (!a) return res.status(404).json({ error: 'This host profile is not available.' });
        // Reviews come in pages, the same steps as a listing's own reviews:
        // 5 first, then 15, 20, and 100 at a time (the page asks for each
        // batch; capped here at 100 per request). The rating covers ALL of
        // the host's published stay reviews, not only the page shown.
        const offset = Math.max(0, Math.min(10000, Math.floor(Number(req.query.offset)) || 0));
        const askedLimit = Math.floor(Number(req.query.limit));
        const PAGE = Number.isFinite(askedLimit) && askedLimit >= 1 ? Math.min(100, askedLimit) : 5;
        const reviewPage = a.host_id ? await sql`
          SELECT r.published_at, r.comment, r.hygiene, r.communication, r.services, r.value_rating, r.location,
                 l.property_name
          FROM listing_reviews r JOIN listings l ON l.id = r.listing_id
          WHERE l.host_id = ${a.host_id} AND l.status = 'approved'
            AND COALESCE(l.listing_type, 'stay') = 'stay'
            AND r.published_at IS NOT NULL AND r.admin_reverted_at IS NULL AND r.hygiene IS NOT NULL
          ORDER BY r.published_at DESC, r.id DESC
          OFFSET ${offset} LIMIT ${PAGE + 1}
        ` : [];
        const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };
        const pageReviews = reviewPage.slice(0, PAGE).map(r => ({
          month: r.published_at ? new Date(r.published_at).toISOString().slice(0, 7) : null,
          property: r.property_name,
          score: reviewScore({ hygiene: n(r.hygiene), communication: n(r.communication), services: n(r.services), value: n(r.value_rating), location: n(r.location) }, REVIEW_FACTORS),
          comment: String(r.comment || '')
        }));
        const hasMoreReviews = reviewPage.length > PAGE;
        // Asked for a further page only: send just that.
        if (req.query.reviewsOnly === '1') {
          return res.status(200).json({ reviews: pageReviews, hasMoreReviews });
        }
        let rating = null;
        if (a.host_id) {
          const agg = await sql`
            SELECT COUNT(*)::int AS n, AVG(r.hygiene) AS hygiene, AVG(r.communication) AS communication,
                   AVG(r.services) AS services, AVG(r.value_rating) AS value, AVG(r.location) AS location
            FROM listing_reviews r JOIN listings l ON l.id = r.listing_id
            WHERE l.host_id = ${a.host_id} AND l.status = 'approved'
              AND COALESCE(l.listing_type, 'stay') = 'stay'
              AND r.published_at IS NOT NULL AND r.admin_reverted_at IS NULL AND r.hygiene IS NOT NULL
          `;
          const g = agg[0] || {};
          if (Number(g.n) > 0) {
            rating = {
              count: Number(g.n),
              score: Math.round(reviewScore({ hygiene: n(g.hygiene), communication: n(g.communication), services: n(g.services), value: n(g.value), location: n(g.location) }, REVIEW_FACTORS) * 100) / 100
            };
          }
        }
        const places = a.host_id ? await placesWithAerva(sql, { guestId: a.account_id || null, hostId: a.host_id }) : { hosting: [] };
        // Everything this host runs that a guest can book right now:
        // live stays and experiences, newest first, with just what a small
        // card needs (photo, name, place, price). Up to 24.
        const hostListings = a.host_id ? await sql`
          SELECT id, property_name, city, area, COALESCE(listing_type, 'stay') AS listing_type, property_type,
                 nightly_rate, experience_price_unit,
                 COALESCE(
                   NULLIF(btrim(cover_photo_url), ''),
                   CASE WHEN jsonb_typeof(exterior_photo_urls->0) = 'string'
                        THEN exterior_photo_urls->>0 ELSE exterior_photo_urls->0->>'url' END,
                   CASE WHEN jsonb_typeof(interior_photo_urls->0) = 'string'
                        THEN interior_photo_urls->>0 ELSE interior_photo_urls->0->>'url' END
                 ) AS photo_url
          FROM listings
          WHERE host_id = ${a.host_id} AND status = 'approved'
          ORDER BY (COALESCE(listing_type, 'stay') = 'stay') DESC, created_at DESC NULLS LAST, id DESC
          LIMIT 24
        ` : [];
        const joined = a.account_created_at || a.host_created_at;
        return res.status(200).json({
          profile: {
            name: String(a.account_name || a.host_record_name || a.listing_host_name || '').trim() || 'Aerva host',
            photoUrl: a.profile_photo_url || null,
            memberSince: joined ? String(new Date(joined).getFullYear()) : null,
            work: a.profile_work || null,
            hobbies: a.profile_hobbies || null,
            answers: answeredQuestions(a.profile_about),
            hostingIn: places.hosting || [],
            listings: hostListings.map(l => ({
              id: l.id,
              name: l.property_name,
              place: [l.area, l.city].filter(Boolean).join(', '),
              type: l.listing_type === 'experience' ? 'experience' : 'stay',
              propertyType: l.property_type || null,
              price: Number(l.nightly_rate) || null,
              priceUnit: l.experience_price_unit || null,
              photoUrl: l.photo_url || null
            })),
            rating,
            reviews: pageReviews,
            hasMoreReviews
          }
        });
      } catch (err) {
        console.error('hostProfile failed:', err);
        return res.status(500).json({ error: 'Could not load this profile right now.' });
      }
    }

    if (req.query.publicStats === '1') {
      try {
        // Public numbers, so every one of them has to be literally true.
        // Counted from real bookings only:
        //   - paid, and a stay (experiences are not "stays hosted");
        //   - paid through Razorpay for real: Razorpay payment ids start
        //     "pay_", so seed or test rows (dummy_pay_…) never count;
        //   - one booking once, even if its row was written twice, and a
        //     multi-room resort booking as one stay;
        //   - dates on each property's own calendar, not the server's.
        // "Guests checked in this month" adds up the guests on bookings
        // that have arrived this month — people, not bookings.
        const rows = await sql`
          WITH real_stays AS (
            SELECT DISTINCT ON (o.razorpay_order_id, o.listing_id, o.room_id, o.arrival)
                   o.razorpay_order_id, o.listing_id, o.guest_id, o.guests, o.arrival, o.departure,
                   (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), ${DEFAULT_TIMEZONE}))::date AS local_today
            FROM orders o
            LEFT JOIN listings l ON l.id = o.listing_id
            WHERE o.status = 'paid'
              AND COALESCE(o.order_type, 'stay') = 'stay'
              AND o.razorpay_payment_id LIKE 'pay!_%' ESCAPE '!'
            ORDER BY o.razorpay_order_id, o.listing_id, o.room_id, o.arrival, o.id
          )
          SELECT
            -- A resort booking of two rooms is still one stay.
            COUNT(DISTINCT (razorpay_order_id, listing_id, arrival)) FILTER (WHERE departure <= local_today) AS stays_hosted,
            COALESCE(SUM(guests) FILTER (
              WHERE arrival >= date_trunc('month', local_today)::date AND arrival <= local_today
            ), 0) AS checkins_this_month,
            COUNT(DISTINCT guest_id) AS guests_hosted
          FROM real_stays
        `;
        const r = rows[0] || {};
        return res.status(200).json({
          staysHosted: Number(r.stays_hosted) || 0,
          checkinsThisMonth: Number(r.checkins_this_month) || 0,
          guestsHosted: Number(r.guests_hosted) || 0
        });
      } catch (err) {
        console.error('publicStats failed:', err);
        // An error, not zeros: the page shows 0 when 0 is the true count,
        // so a failed count must never pass itself off as one.
        return res.status(500).json({ error: 'Stats unavailable' });
      }
    }

    // ---- Published reviews for one listing ----
    // GET ?reviewsFor=<listingId>&offset=<n>
    // Public: shown under the photos on the listing page. Only what a guest
    // is meant to see — published, non-reverted reviews of a LIVE listing,
    // with the reviewer's FIRST NAME only and the month of the review.
    // Never an email, surname, guest id or order id.
    //
    // The summary uses exactly the rule the listing card uses, so the
    // stars on the card and the stars on the page always agree: stays are
    // scored on stay reviews only; experiences on their own factor set.
    if (req.query.reviewsFor !== undefined) {
      const listingId = Number(req.query.reviewsFor);
      const offset = Math.max(0, Math.min(10000, Number(req.query.offset) || 0));
      // The page asks for how many it wants: 5 on first load, then a
      // larger batch each time the guest presses View more (see
      // REVIEW_PAGE_STEPS in index.html). Capped so no single request can
      // be asked for an unbounded number of rows.
      const askedLimit = Number(req.query.limit);
      const PAGE = Number.isFinite(askedLimit) && askedLimit >= 1 ? Math.min(100, Math.floor(askedLimit)) : 5;
      if (!listingId) return res.status(400).json({ error: 'Which listing?' });
      try {
        const lr = await sql`
          SELECT id, COALESCE(listing_type, 'stay') AS listing_type
          FROM listings WHERE id = ${listingId} AND status = 'approved'
        `;
        if (!lr.length) return res.status(404).json({ error: 'Listing not found.' });
        const isExperience = lr[0].listing_type === 'experience';
        // Which rows count as "a review of this kind of listing". Stays:
        // rows with the stay factors. Experiences: rows with either set
        // (older experience reviews carry the stay set — same fallback
        // as the card and experienceTier).
        const summaryRows = await sql`
          SELECT COUNT(*) AS n,
                 AVG(hygiene) AS hygiene, AVG(communication) AS communication,
                 AVG(services) AS services, AVG(value_rating) AS value, AVG(location) AS location,
                 AVG(organisation) AS organisation, AVG(guide) AS guide, AVG(safety) AS safety
          FROM listing_reviews
          WHERE listing_id = ${listingId}
            AND published_at IS NOT NULL AND admin_reverted_at IS NULL
            AND (hygiene IS NOT NULL OR (${isExperience} AND organisation IS NOT NULL))
        `;
        const rows = await sql`
          SELECT r.published_at, r.comment,
                 r.hygiene, r.communication, r.services, r.value_rating, r.location,
                 r.organisation, r.guide, r.safety,
                 g.name AS guest_name
          FROM listing_reviews r
          LEFT JOIN guests g ON g.id = r.guest_id
          WHERE r.listing_id = ${listingId}
            AND r.published_at IS NOT NULL AND r.admin_reverted_at IS NULL
            AND (r.hygiene IS NOT NULL OR (${isExperience} AND r.organisation IS NOT NULL))
          ORDER BY r.published_at DESC, r.id DESC
          LIMIT ${PAGE + 1} OFFSET ${offset}
        `;
        const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };
        const setFor = (f) => (f.organisation > 0 ? EXPERIENCE_FACTORS : REVIEW_FACTORS);
        const sr = summaryRows[0] || {};
        const count = Number(sr.n) || 0;
        const sumFactors = {
          hygiene: n(sr.hygiene), communication: n(sr.communication), services: n(sr.services),
          value: n(sr.value), location: n(sr.location),
          organisation: n(sr.organisation), guide: n(sr.guide), safety: n(sr.safety)
        };
        // An experience with any new-style reviews is summarised on the
        // experience set; otherwise the stay set.
        const summarySet = isExperience && sumFactors.organisation > 0 ? EXPERIENCE_FACTORS : REVIEW_FACTORS;
        const pick = (f, set) => set.map(x => ({ key: x.key, label: x.label, value: Number(f[x.key].toFixed(2)) })).filter(x => x.value > 0);
        const firstName = (name) => {
          const first = String(name || '').trim().split(/\s+/)[0];
          return first ? first.slice(0, 40) : 'Guest';
        };
        const reviews = rows.slice(0, PAGE).map(r => {
          const f = {
            hygiene: n(r.hygiene), communication: n(r.communication), services: n(r.services),
            value: n(r.value_rating), location: n(r.location),
            organisation: n(r.organisation), guide: n(r.guide), safety: n(r.safety)
          };
          const set = setFor(f);
          const d = new Date(r.published_at);
          return {
            name: firstName(r.guest_name),
            month: isNaN(d) ? null : d.toISOString().slice(0, 7),
            score: reviewScore(f, set),
            factors: pick(f, set),
            comment: String(r.comment || '')
          };
        });
        return res.status(200).json({
          summary: count ? { count, score: reviewScore(sumFactors, summarySet), factors: pick(sumFactors, summarySet) } : { count: 0 },
          reviews,
          nextOffset: rows.length > PAGE ? offset + PAGE : null
        });
      } catch (err) {
        console.error('reviewsFor error:', err);
        return res.status(500).json({ error: 'Could not load reviews right now.' });
      }
    }

    // ---- Availability lookup for one listing ----
    // Folded into this same endpoint (rather than its own /api file) to
    // stay under Vercel's Hobby-plan serverless function limit — adding a
    // 13th function file failed the build outright. ?availabilityFor=<id>
    // takes over the whole request and skips the normal listings query
    // entirely; it returns only which date ranges are already paid and
    // booked for that listing, never anything about who booked them.
    const availabilityForRaw = typeof req.query.availabilityFor === 'string' ? req.query.availabilityFor.trim() : '';
    if (availabilityForRaw) {
      const listingId = Number(availabilityForRaw);
      if (!listingId) {
        return res.status(400).json({ error: 'Missing or invalid availabilityFor' });
      }
      // A resort room is independently available from every other room
      // in the same resort (and from the resort listing itself, which
      // is never directly booked) — when roomId is present, everything
      // below filters by room_id instead of listing_id.
      const roomIdRaw = typeof req.query.roomId === 'string' ? req.query.roomId.trim() : '';
      const roomId = roomIdRaw ? Number(roomIdRaw) : null;

      const orderRows = roomId
        ? await sql`SELECT arrival, departure FROM orders WHERE room_id = ${roomId} AND status = 'paid' ORDER BY arrival ASC`
        : await sql`SELECT arrival, departure FROM orders WHERE listing_id = ${listingId} AND status = 'paid' ORDER BY arrival ASC`;
      const bookedRanges = orderRows.map(r => ({
        arrival: toDateStr(r.arrival),
        departure: toDateStr(r.departure),
      }));

      // Host-blocked dates (maintenance, personal use, etc.) — shown on
      // the same calendar as booked dates so a guest can't even try to
      // select them, though create-order.js is what actually enforces it.
      const blockedRows = roomId
        ? await sql`SELECT start_date, end_date, reason FROM listing_blocked_dates WHERE room_id = ${roomId} ORDER BY start_date ASC`
        : await sql`SELECT start_date, end_date, reason FROM listing_blocked_dates WHERE listing_id = ${listingId} AND room_id IS NULL ORDER BY start_date ASC`;
      const blockedRanges = blockedRows.map(r => ({
        arrival: toDateStr(r.start_date),
        departure: toDateStr(r.end_date),
        reason: r.reason || null,
      }));

      return res.status(200).json({ bookedRanges, blockedRanges });
    }

    // ---- Homepage background images, chosen by the admin ----
    // Public and read-only, like everything else in this file. Returns
    // whatever admin.html last saved via the POST mode on
    // get-pending-listings.js. An empty array is a normal, expected
    // result (admin hasn't picked any yet) — the homepage itself decides
    // to fall back to listing cover photos in that case, not this endpoint.
    if (req.query.siteBackground === '1') {
      try {
        const rows = await sql`SELECT value FROM site_settings WHERE key = 'homepage_background_images'`;
        const images = rows[0] && Array.isArray(rows[0].value) ? rows[0].value : [];
        return res.status(200).json({ images });
      } catch (settingsErr) {
        // Most likely cause: the site_settings table hasn't been created
        // yet (see the header comment for the CREATE TABLE statement).
        // Treat that the same as "admin hasn't picked any images" rather
        // than failing the request — the homepage's own cover-photo
        // fallback handles an empty list just fine.
        console.error('siteBackground lookup failed (site_settings may not exist yet):', settingsErr);
        return res.status(200).json({ images: [] });
      }
    }

    // ---- Currency display rates ----
    // Public, read-only — returns whatever was last cached by the daily
    // cron refresh below. Never fetches live from here on a guest's own
    // page load; that's exactly the fragility this replaced (a third-
    // party API being slow/down/CORS-blocked no longer affects guests at
    // all, since they're reading from our own database, not the source
    // directly).
    if (req.query.currencyRates === '1') {
      try {
        const rows = await sql`SELECT value, updated_at FROM site_settings WHERE key = 'currency_rates'`;
        if (!rows[0]) return res.status(200).json({ rates: null, updatedAt: null });
        return res.status(200).json({ rates: rows[0].value, updatedAt: rows[0].updated_at });
      } catch (settingsErr) {
        console.error('currencyRates lookup failed (site_settings may not exist yet):', settingsErr);
        return res.status(200).json({ rates: null, updatedAt: null });
      }
    }

    // ---- Daily currency rate refresh (Vercel Cron only) ----
    // Vercel calls this automatically once a day per the schedule in
    // vercel.json, with an Authorization header it generates itself from
    // your CRON_SECRET env var — this check is what stops anyone else
    // from hitting this URL and forcing a refresh (harmless on its own,
    // but still not something a public endpoint should allow arbitrarily).
    if (req.query.refreshCurrencyRates === '1') {
      if (!isCronAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      // Same two free/keyless sources the frontend used to call directly
      // — tried in order, first one to return a real-looking rate table
      // wins. If both fail, the cached rates from the last successful
      // run stay in place rather than being wiped out.
      const sources = [
        { url: 'https://open.er-api.com/v6/latest/INR', extract: (data) => data && data.rates },
        { url: 'https://api.exchangerate-api.com/v4/latest/INR', extract: (data) => data && data.rates },
      ];
      for (const source of sources) {
        try {
          const res2 = await fetch(source.url);
          if (!res2.ok) continue;
          const data = await res2.json();
          const rates = source.extract(data);
          if (rates && rates.USD && rates.GBP) {
            await sql`
              INSERT INTO site_settings (key, value, updated_at)
              VALUES ('currency_rates', ${JSON.stringify(rates)}, now())
              ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(rates)}, updated_at = now()
            `;
            return res.status(200).json({ success: true, source: source.url });
          }
        } catch (fetchErr) {
          console.error('refreshCurrencyRates: source failed, trying next:', source.url, fetchErr);
        }
      }
      return res.status(502).json({ error: 'Both currency rate sources failed — cached rates left unchanged.' });
    }

    // ---- Aerva Experience browsing ----
    // Public, read-only, same pattern as everything else here. Returns
    // every approved experience along with a summary of the property that
    // hosts it — city/photo/whether it has its own bookable stay — so the
    // frontend can show "Hosted at X" and, if that property is itself an
    // approved stay listing, offer the "also book your stay here"
    // cross-sell without a second round trip.
    if (req.query.experiences === '1') {
      // Same lat/lng/radiusKm distance filter stays use — a location
      // search should narrow experiences down exactly the same way it
      // narrows suites, not leave every experience in India showing
      // regardless of where the guest actually searched.
      const expLatRaw = typeof req.query.lat === 'string' ? Number(req.query.lat) : null;
      const expLngRaw = typeof req.query.lng === 'string' ? Number(req.query.lng) : null;
      const expRadiusRaw = typeof req.query.radiusKm === 'string' ? Number(req.query.radiusKm) : null;
      const expDistanceFilter = (expLatRaw != null && !isNaN(expLatRaw) && expLngRaw != null && !isNaN(expLngRaw) && expRadiusRaw != null && !isNaN(expRadiusRaw))
        ? { lat: expLatRaw, lng: expLngRaw, radiusKm: expRadiusRaw }
        : null;
      const expCityRaw = typeof req.query.city === 'string' ? req.query.city.trim() : '';

      // A guest searching specific dates shouldn't see an experience
      // that's actually blocked (or already booked) across the searched
      // span, checked here as a plain overlap the same way stays are
      // below. Whether the experience's own DURATION actually fits
      // inside that span is a separate concern, handled further down
      // (see fitsSearchedRange) — this block is purely about booking
      // conflicts, not duration.
      const expArrivalRaw = typeof req.query.arrival === 'string' ? req.query.arrival.trim() : '';
      const expDepartureRaw = typeof req.query.departure === 'string' ? req.query.departure.trim() : '';
      // Must be a real boolean, not just a truthy value — this gets sent
      // straight into a SQL NOT(...) below, and `&&` on two strings
      // returns the second string itself, not true/false. Sending a raw
      // date string where Postgres expects a boolean is a type error on
      // every single request, which is exactly what was happening here.
      const expDatesFilter = !!(expArrivalRaw && expDepartureRaw);

      const experiences = await sql`
        SELECT
          e.id, e.property_name, e.description, e.experience_category,
          e.nightly_rate AS price, e.experience_price_unit, e.experience_duration_hours, e.experience_duration_days, e.experience_type,
          e.exterior_photo_urls, e.interior_photo_urls, e.cover_photo_url,
          e.host_name, e.created_at,
          e.hosting_listing_id, e.city, e.latitude, e.longitude, e.formatted_address,
          e.experience_arranges_travel, e.experience_travel_details,
          e.experience_meeting_point_type, e.experience_meeting_point_details,
          e.experience_start_time, e.experience_refund_policy,
          e.experience_meeting_point_lat, e.experience_meeting_point_lng, e.experience_meeting_point_address,
          e.experience_instructions, e.experience_special_instructions,
          e.experience_available_from, e.experience_available_until,
          h.property_name AS hosting_property_name, h.city AS hosting_city, h.area AS hosting_area,
          h.nightly_rate AS hosting_nightly_rate, h.cover_photo_url AS hosting_cover_photo_url,
          h.exterior_photo_urls AS hosting_exterior_photo_urls, h.interior_photo_urls AS hosting_interior_photo_urls,
          h.status AS hosting_status,
          (
            NOT ${expDatesFilter} OR (
              NOT EXISTS (
                SELECT 1 FROM orders o
                WHERE o.listing_id = e.id
                  AND o.status = 'paid'
                  AND o.arrival < ${expDatesFilter ? expDepartureRaw : null}::date
                  AND o.departure > ${expDatesFilter ? expArrivalRaw : null}::date
              )
              AND NOT EXISTS (
                SELECT 1 FROM listing_blocked_dates b
                WHERE b.listing_id = e.id
                  AND b.start_date < ${expDatesFilter ? expDepartureRaw : null}::date
                  AND b.end_date > ${expDatesFilter ? expArrivalRaw : null}::date
              )
              -- For a with_stay experience, the searched dates also need
              -- the LINKED PROPERTY itself free, not just the experience
              -- listing row — booking one without checking the other is
              -- exactly how a guest could end up paying for a "stay"
              -- that was already occupied by someone else. Skipped
              -- entirely when there's no hosting_listing_id (a
              -- without_stay experience, or a with_stay one not yet
              -- linked to a real property).
              AND (
                e.hosting_listing_id IS NULL OR (
                  NOT EXISTS (
                    SELECT 1 FROM orders ho
                    WHERE ho.listing_id = e.hosting_listing_id
                      AND ho.status = 'paid'
                      AND ho.arrival < ${expDatesFilter ? expDepartureRaw : null}::date
                      AND ho.departure > ${expDatesFilter ? expArrivalRaw : null}::date
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM listing_blocked_dates hb
                    WHERE hb.listing_id = e.hosting_listing_id
                      AND hb.start_date < ${expDatesFilter ? expDepartureRaw : null}::date
                      AND hb.end_date > ${expDatesFilter ? expArrivalRaw : null}::date
                  )
                )
              )
            )
          ) AS is_available
        FROM listings e
        LEFT JOIN listings h ON h.id = e.hosting_listing_id
        WHERE e.status = 'approved' AND e.listing_type = 'experience'
        ORDER BY e.created_at DESC
      `;

      // Same "no coordinates falls back to city text, otherwise strict
      // distance" rule the suites filter below uses (see the comment
      // there for the reasoning) — kept consistent between the two.
      //
      // Also filters out anything that structurally CAN'T fit the
      // searched date range — e.g. a 15-hour experience genuinely fits a
      // 2-day search window, but not a same-day one. This is separate
      // from is_available above (which only checks for actual booking
      // conflicts): an experience that's simply too long for a short
      // search isn't "unavailable" the way a booked one is — it just
      // isn't a match for THIS particular search, the same way an
      // out-of-radius listing isn't a match. It might work fine for a
      // longer search. Same hours formula create-order.js/index.html use
      // for the equivalent per-experience check on the booking page
      // itself, kept in sync by hand (no shared module between these
      // separate serverless files).
      const searchDays = expDatesFilter
        ? Math.round((new Date(expDepartureRaw) - new Date(expArrivalRaw)) / (1000 * 60 * 60 * 24))
        : null;
      function fitsSearchedRange(e){
        if (!expDatesFilter) return true; // no dates searched — duration doesn't rule anything out
        const requiredHours = (e.experience_duration_days && e.experience_duration_days > 1)
          ? e.experience_duration_days * (Number(e.experience_duration_hours) || 24)
          : (Number(e.experience_duration_hours) || 24);
        return requiredHours <= searchDays * 24;
      }
      const filteredExperiences = experiences.filter(e => {
        if (!fitsSearchedRange(e)) return false;
        if (expDistanceFilter) {
          if (e.latitude == null || e.longitude == null) {
            if (!expCityRaw) return false;
            const needle = expCityRaw.toLowerCase();
            return (e.city && e.city.toLowerCase().includes(needle));
          }
          const km = haversineDistanceKm(expDistanceFilter.lat, expDistanceFilter.lng, Number(e.latitude), Number(e.longitude));
          e.distance_km = km;
          return km <= expDistanceFilter.radiusKm;
        }
        return true;
      });
      // Nearest first — same reasoning as the stays search below.
      if (expDistanceFilter) {
        filteredExperiences.sort((a, b) => {
          const da = a.distance_km == null ? Infinity : a.distance_km;
          const db = b.distance_km == null ? Infinity : b.distance_km;
          return da - db;
        });
      }

      // Same active-promotions teaser data the stays query attaches below
      // — experiences can have their own date-scoped promotions too (see
      // host-dashboard.html's calendar), and this was previously never
      // sent to the frontend at all, so a promoted experience's guest-
      // facing price summary had no way to reflect it.
      if (filteredExperiences.length) {
        const expIds = filteredExperiences.map(e => e.id);
        const expPromoRows = await sql`
          SELECT id, listing_id, name, discount_type, discount_value, min_nights, start_date, end_date
          FROM listing_promotions
          WHERE listing_id = ANY(${expIds}) AND is_active = TRUE AND end_date > CURRENT_DATE
          ORDER BY start_date ASC
        `;
        const expPromotionsByListing = {};
        for (const p of expPromoRows) {
          if (!expPromotionsByListing[p.listing_id]) expPromotionsByListing[p.listing_id] = [];
          expPromotionsByListing[p.listing_id].push({
            id: p.id,
            name: p.name,
            discountType: p.discount_type,
            discountValue: p.discount_value,
            minNights: p.min_nights,
            startDate: toDateStr(p.start_date),
            endDate: toDateStr(p.end_date),
          });
        }
        filteredExperiences.forEach(e => { e.active_promotions = expPromotionsByListing[e.id] || []; });
      }

      // ---- Experience ratings and standing ----
      // Absolute thresholds, no ranking and no pool. An experience earns
      // its badge on its own reviews alone and cannot lose it because
      // another host improved — see EXPERIENCE_TIERS in _tiers.js for why
      // ranking was the wrong fit at this scale.
      try {
        const expIds = [...new Set(filteredExperiences.map(e => e.id).filter(Boolean))];
        if (expIds.length) {
          // Both factor sets are averaged. Experience reviews carry the
          // new four; rows written before those columns existed carry the
          // old five. AVG ignores NULLs, so each set averages only over
          // the rows that actually have it, and experienceTier picks
          // whichever is present.
          const revRows = await sql`
            SELECT r.listing_id,
                   AVG(r.organisation) AS organisation, AVG(r.guide) AS guide,
                   AVG(r.safety) AS safety, AVG(r.value_rating) AS value,
                   AVG(r.hygiene) AS hygiene, AVG(r.communication) AS communication,
                   AVG(r.services) AS services, AVG(r.location) AS location,
                   COUNT(*) AS n
            FROM listing_reviews r
            WHERE r.listing_id = ANY(${expIds})
              AND r.published_at IS NOT NULL AND r.admin_reverted_at IS NULL
            GROUP BY r.listing_id
          `;
          const byExp = {};
          revRows.forEach(r => {
            const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
            const factors = {
              organisation: num(r.organisation), guide: num(r.guide),
              safety: num(r.safety), value: num(r.value),
              hygiene: num(r.hygiene), communication: num(r.communication),
              services: num(r.services), location: num(r.location)
            };
            const set = factors.organisation > 0 ? EXPERIENCE_FACTORS : REVIEW_FACTORS;
            byExp[r.listing_id] = { factors, count: Number(r.n) || 0, rating: reviewScore(factors, set) };
          });

          filteredExperiences.forEach(e => {
            const r = byExp[e.id];
            e.rating = r ? r.rating : null;
            e.review_count = r ? r.count : 0;
            const t = r ? experienceTier({ reviewCount: r.count, factors: r.factors }) : null;
            e.experience_tier = t ? { key: t.key, label: t.label } : null;
          });
        }
      } catch (err) {
        // Standing is decoration; never block the experiences list.
        console.error('experience standing failed (non-fatal):', err);
      }

      await attachLikeCounts(filteredExperiences);
      return res.status(200).json({ experiences: filteredExperiences });
    }

    // ?experiencesFor=<listingId> — every approved experience hosted AT
    // this specific stay listing, for the listing detail page to offer
    // as an add-on. 'with_stay' ones can be booked in the SAME order as
    // this stay (create-order.js already accepts a stays[] and an
    // experiences[] together in one request — no new checkout needed);
    // 'without_stay' ones are just shown as a separate thing to book.
    if (req.query.experiencesFor) {
      const hostingId = Number(req.query.experiencesFor);
      if (!hostingId || isNaN(hostingId)) {
        return res.status(400).json({ error: 'Invalid listing id' });
      }
      const experiencesFor = await sql`
        SELECT id, property_name, description, experience_category, experience_type,
               nightly_rate AS price, experience_price_unit, experience_duration_hours, experience_duration_days,
               exterior_photo_urls, interior_photo_urls, cover_photo_url,
               city, latitude, longitude, formatted_address,
               experience_arranges_travel, experience_travel_details,
               experience_meeting_point_type, experience_meeting_point_details,
               experience_start_time, experience_refund_policy,
               experience_meeting_point_lat, experience_meeting_point_lng, experience_meeting_point_address,
               experience_instructions, experience_special_instructions,
               experience_available_from, experience_available_until
        FROM listings
        WHERE status = 'approved' AND listing_type = 'experience' AND hosting_listing_id = ${hostingId}
        ORDER BY created_at DESC
      `;
      await attachLikeCounts(experiencesFor);
      return res.status(200).json({ experiences: experiencesFor });
    }

    const cityRaw = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const guestsRaw = typeof req.query.guests === 'string' ? req.query.guests.trim() : '';
    const arrivalRaw = typeof req.query.arrival === 'string' ? req.query.arrival.trim() : '';
    const departureRaw = typeof req.query.departure === 'string' ? req.query.departure.trim() : '';
    const roomsNeededRaw = typeof req.query.roomsNeeded === 'string' ? req.query.roomsNeeded.trim() : '';
    const latRaw = typeof req.query.lat === 'string' ? Number(req.query.lat) : null;
    const lngRaw = typeof req.query.lng === 'string' ? Number(req.query.lng) : null;
    const radiusRaw = typeof req.query.radiusKm === 'string' ? Number(req.query.radiusKm) : null;

    const cityFilter = cityRaw ? `%${cityRaw}%` : null;
    const guestsFilter = guestsRaw && !isNaN(Number(guestsRaw)) ? Number(guestsRaw) : null;
    // Optional, and a genuinely different question from guestsFilter
    // above: guestsFilter asks "can this property fit N people at all"
    // (summed across rooms for a Resort); this asks "can I book N
    // SEPARATE rooms within one property" — Airbnb-style whole-unit
    // listings can never answer yes to this, no matter how many people
    // they sleep, since there's nothing separate to book there.
    const roomsNeededFilter = roomsNeededRaw && !isNaN(Number(roomsNeededRaw)) ? Number(roomsNeededRaw) : null;
    // Only a genuine, complete lat/lng/radius triple activates distance
    // filtering — a lone or malformed value is ignored rather than
    // crashing or silently filtering everything out.
    const distanceFilter = (latRaw != null && !isNaN(latRaw) && lngRaw != null && !isNaN(lngRaw) && radiusRaw != null && !isNaN(radiusRaw))
      ? { lat: latRaw, lng: lngRaw, radiusKm: radiusRaw }
      : null;
    // Dates only apply as a pair — a lone arrival or departure is ignored
    // rather than causing a confusing partial filter.
    const datesFilter = arrivalRaw && departureRaw;
    const arrivalFilter = datesFilter ? arrivalRaw : null;
    const departureFilter = datesFilter ? departureRaw : null;

    // When a real distance search is active (a guest typed/picked a
    // place, turned into a 200km radius below), the city/area text is
    // NOT also required — a "Mumbai" search legitimately should surface
    // a nearby Pune listing within range, even though its city field
    // says "Pune," not "Mumbai." That's the actual point of a radius
    // search. (An earlier version of this required both together, which
    // broke exactly that — a Mumbai search stopped finding Pune at all.)
    // Only "Near Me" (no typed place, pure geolocation) has no text
    // filter to begin with, so it's unaffected either way.
    const effectiveCityFilter = distanceFilter ? null : cityFilter;

    // City is filtered in SQL as before. Date-availability used to also
    // be a WHERE exclusion — now it's a SELECT column (is_available)
    // instead, so an unavailable-for-these-dates listing still comes
    // back (the frontend shows it in its own "Unavailable" section,
    // rather than just vanishing with no explanation of why a listing
    // a guest saw a minute ago is suddenly gone).
    const listings = await sql`
      SELECT
        id, property_name, city, area, property_type, bedrooms, max_guests,
        nightly_rate, description, amenities, services, host_name,
        discount_type, discount_value, discount_min_nights, discount_description,
        exterior_photo_urls, interior_photo_urls, cover_photo_url,
        latitude, longitude, formatted_address,
        pet_friendly, max_pets_allowed, allowed_pet_types, pet_fee, security_deposit,
        created_at,
        (
          ${arrivalFilter}::date IS NULL OR (
            NOT EXISTS (
              SELECT 1 FROM orders o
              WHERE o.listing_id = listings.id
                AND o.status = 'paid'
                AND o.arrival < ${departureFilter}::date
                AND o.departure > ${arrivalFilter}::date
            )
            AND NOT EXISTS (
              SELECT 1 FROM listing_blocked_dates b
              WHERE b.listing_id = listings.id
                AND b.start_date < ${departureFilter}::date
                AND b.end_date > ${arrivalFilter}::date
            )
          )
        ) AS is_available,
        host_id
      FROM listings
      WHERE status = 'approved' AND listing_type = 'stay'
        AND (${effectiveCityFilter}::text IS NULL OR city ILIKE ${effectiveCityFilter} OR area ILIKE ${effectiveCityFilter})
      ORDER BY created_at DESC
    `;

    const afterGuestsFilter = guestsFilter
      ? listings.filter(l => {
          const capacity = parseMaxGuests(l.max_guests);
          // A listing with no max_guests set at all isn't excluded by a
          // guest-count search — better to show it and let the guest
          // judge for themselves than to hide it over missing data.
          // Resorts always fall into this "no max_guests" case (their
          // capacity lives per-room, not on the listing itself) — real
          // resort capacity is computed and enforced separately below,
          // this first pass just avoids wrongly excluding one here.
          return capacity === null || capacity >= guestsFilter;
        })
      : listings;

    // A resort's real availability/capacity lives in its ROOMS, not the
    // listing row itself — is_available above only checked for orders/
    // blocks against the LISTING's own id, which would incorrectly mark
    // an entire resort unavailable the moment ANY one of its rooms gets
    // booked (bookings against a resort reference room_id, but still
    // carry the resort's own listing_id too). Recomputed properly here:
    // a resort is available if at least one room is free (for the
    // searched dates, if any) with enough capacity for the searched
    // guest count.
    const resortListings = afterGuestsFilter.filter(l => l.property_type === 'Resort');
    if (resortListings.length) {
      const resortIds = resortListings.map(l => l.id);
      const roomRows = await sql`
        SELECT listing_rooms.id, listing_rooms.listing_id, listing_rooms.max_occupancy,
          (
            ${arrivalFilter}::date IS NULL OR (
              NOT EXISTS (
                SELECT 1 FROM orders o
                WHERE o.room_id = listing_rooms.id AND o.status = 'paid'
                  AND o.arrival < ${departureFilter}::date AND o.departure > ${arrivalFilter}::date
              )
              AND NOT EXISTS (
                SELECT 1 FROM listing_blocked_dates b
                WHERE b.room_id = listing_rooms.id
                  AND b.start_date < ${departureFilter}::date AND b.end_date > ${arrivalFilter}::date
              )
            )
          ) AS is_free
        FROM listing_rooms
        WHERE listing_id = ANY(${resortIds}) AND is_active = TRUE
      `;
      const capacityByListing = {};
      for (const r of roomRows) {
        if (!capacityByListing[r.listing_id]) capacityByListing[r.listing_id] = { total: 0, available: 0, count: 0, availableCount: 0 };
        capacityByListing[r.listing_id].total += r.max_occupancy;
        capacityByListing[r.listing_id].count += 1;
        if (r.is_free) {
          capacityByListing[r.listing_id].available += r.max_occupancy;
          capacityByListing[r.listing_id].availableCount += 1;
        }
      }
      // Attached directly onto each listing object so the frontend can
      // show real room-derived capacity/availability without a second
      // round trip, and so the guest-count re-filter just below can use it.
      resortListings.forEach(l => {
        const cap = capacityByListing[l.id] || { total: 0, available: 0, count: 0, availableCount: 0 };
        l.is_available = datesFilter ? cap.available > 0 : cap.total > 0;
        l.resort_total_capacity = cap.total;
        l.resort_available_capacity = cap.available;
        l.resort_room_count = cap.count;
        l.resort_available_room_count = cap.availableCount;
      });
    }
    const afterResortCapacityFilter = guestsFilter
      ? afterGuestsFilter.filter(l => {
          if (l.property_type !== 'Resort') return true; // already correctly handled above
          const capacity = datesFilter ? l.resort_available_capacity : l.resort_total_capacity;
          return (capacity || 0) >= guestsFilter;
        })
      : afterGuestsFilter;

    // "Number of rooms": at least N rooms in ONE property.
    //   - A home (villa, apartment, cottage…) is booked whole, so its
    //     rooms are its bedrooms.
    //   - A Resort is booked room by room, so it counts its bookable
    //     rooms — only the ones free for the searched dates, if any.
    // This used to answer only for Resorts and drop every home, so a
    // guest asking for 2 rooms lost a 4-bedroom villa from the results.
    const afterRoomsNeededFilter = roomsNeededFilter
      ? afterResortCapacityFilter.filter(l => {
          if (l.property_type === 'Resort') {
            const roomCount = datesFilter ? l.resort_available_room_count : l.resort_room_count;
            return (roomCount || 0) >= roomsNeededFilter;
          }
          // bedrooms is free text on older listings ("3-4"); same
          // largest-number reading max_guests gets.
          return (parseMaxGuests(l.bedrooms) || 0) >= roomsNeededFilter;
        })
      : afterResortCapacityFilter;

    // A listing with no coordinates at all can't have a real distance
    // measured — rather than excluding it outright (punishing a data gap
    // that isn't the guest's problem), it falls back to a plain city/area
    // text match instead, same tolerance as the guest-count case above.
    // A listing WITH coordinates goes strictly by measured distance,
    // regardless of what its city/area text says — that's the actually
    // reliable signal once it exists.
    const filtered = distanceFilter
      ? afterRoomsNeededFilter.filter(l => {
          if (l.latitude == null || l.longitude == null) {
            if (!cityRaw) return false;
            const needle = cityRaw.toLowerCase();
            return (l.city && l.city.toLowerCase().includes(needle)) || (l.area && l.area.toLowerCase().includes(needle));
          }
          const km = haversineDistanceKm(distanceFilter.lat, distanceFilter.lng, Number(l.latitude), Number(l.longitude));
          // Attached here rather than recomputed later — this is the
          // one place the actual distance is known, and both the sort
          // below and the frontend's "X km away" display want the exact
          // same number, not a second, potentially-inconsistent
          // calculation.
          l.distance_km = km;
          return km <= distanceFilter.radiusKm;
        })
      : afterRoomsNeededFilter;

    // Nearest first — a 200km radius is wide enough that "somewhere in
    // range" isn't very useful on its own; a guest wants the closest
    // options surfaced first, not an arbitrary or database-insertion
    // order. Listings without coordinates (matched above by city/area
    // text instead) have no distance_km to sort by, so they're pushed to
    // the end rather than sorted arbitrarily among themselves.
    if (distanceFilter) {
      filtered.sort((a, b) => {
        const da = a.distance_km == null ? Infinity : a.distance_km;
        const db = b.distance_km == null ? Infinity : b.distance_km;
        return da - db;
      });
    }

    // One extra query for all paid amenities across every listing being
    // returned, rather than one query per listing — cheaper, and this
    // endpoint can return many listings at once.
    if (filtered.length > 0) {
      const listingIds = filtered.map(l => l.id);
      const amenityRows = await sql`
        SELECT id, listing_id, name, description, price, available_from, available_until, excluded_weekdays
        FROM listing_amenities
        WHERE listing_id = ANY(${listingIds}) AND is_active = TRUE
        ORDER BY created_at ASC
      `;
      const amenitiesByListing = {};
      for (const a of amenityRows) {
        if (!amenitiesByListing[a.listing_id]) amenitiesByListing[a.listing_id] = [];
        amenitiesByListing[a.listing_id].push({
          id: a.id,
          name: a.name,
          description: a.description,
          price: a.price,
          availableFrom: a.available_from,
          availableUntil: a.available_until,
          excludedWeekdays: Array.isArray(a.excluded_weekdays) ? a.excluded_weekdays : []
        });
      }
      filtered.forEach(l => { l.paid_amenities = amenitiesByListing[l.id] || []; });

      // Full room details for any Resort in this result set — the
      // capacity-only numbers computed above (resort_total_capacity /
      // resort_available_capacity) are just for filtering; the booking
      // page itself needs each room's name, price, and description to
      // actually let a guest pick which ones to book.
      const resortIdsInResults = filtered.filter(l => l.property_type === 'Resort').map(l => l.id);
      if (resortIdsInResults.length) {
        const detailedRoomRows = await sql`
          SELECT id, listing_id, room_name, max_occupancy, nightly_rate, description, cover_photo_url, photo_urls
          FROM listing_rooms
          WHERE listing_id = ANY(${resortIdsInResults}) AND is_active = TRUE
          ORDER BY sort_order ASC, created_at ASC
        `;
        const roomsByListing = {};
        for (const r of detailedRoomRows) {
          if (!roomsByListing[r.listing_id]) roomsByListing[r.listing_id] = [];
          // Cover photo first, then the rest of the room's own gallery,
          // deduplicated — a guest browsing one room's photos shouldn't
          // see its own cover shot appear a second time further down.
          const gallery = Array.isArray(r.photo_urls) ? r.photo_urls : [];
          const photos = r.cover_photo_url
            ? [r.cover_photo_url, ...gallery.filter(u => u !== r.cover_photo_url)]
            : gallery;
          roomsByListing[r.listing_id].push({
            id: r.id,
            roomName: r.room_name,
            maxOccupancy: r.max_occupancy,
            price: r.nightly_rate,
            description: r.description,
            coverPhotoUrl: r.cover_photo_url,
            photos,
          });
        }
        filtered.forEach(l => { if (l.property_type === 'Resort') l.rooms = roomsByListing[l.id] || []; });
      }

      // Active/upcoming promotions — same one-query-for-everyone pattern
      // as paid amenities just above. "Active" here means is_active AND
      // not yet ended (end_date > today), so a currently-running or
      // future-dated promotion shows, but a lapsed one quietly stops
      // appearing without the host needing to delete it. This is
      // teaser/display data only — create-order.js is what actually
      // recalculates and applies the discount at checkout, using the
      // guest's real selected dates, not anything read here.
      const promoRows = await sql`
        SELECT id, listing_id, name, discount_type, discount_value, min_nights, start_date, end_date
        FROM listing_promotions
        WHERE listing_id = ANY(${listingIds}) AND is_active = TRUE AND end_date > CURRENT_DATE
        ORDER BY start_date ASC
      `;
      const promotionsByListing = {};
      for (const p of promoRows) {
        if (!promotionsByListing[p.listing_id]) promotionsByListing[p.listing_id] = [];
        promotionsByListing[p.listing_id].push({
          id: p.id,
          name: p.name,
          discountType: p.discount_type,
          discountValue: p.discount_value,
          minNights: p.min_nights,
          startDate: toDateStr(p.start_date),
          endDate: toDateStr(p.end_date),
        });
      }
      filtered.forEach(l => { l.active_promotions = promotionsByListing[l.id] || []; });
    }

    // ---- Host badge ----
    // One aggregate for the whole page, not one per listing: a results
    // page can carry 50 cards from a dozen hosts, and a per-card query
    // would be a dozen round trips for a decoration.
    //
    // Only the three elite rungs are ever sent. Every other host resolves
    // to Rising Host or nothing, and stamping "Rising Host" on a public
    // card tells a guest nothing useful while quietly disparaging a
    // perfectly good property — the absence of a badge is the correct way
    // to say "not yet outstanding". This also means no badge appears at
    // all until listing_reviews exists, which is the honest state.
    //
    // Payout and reviews are summed over a rolling twelve months, the
    // same window _tiers.js's quarterly review uses, so the badge on a
    // card always agrees with the one on the host's own dashboard.
    // ---- Published review ratings ----
    // Only rows that are actually published and not reverted count. A
    // held review must stay invisible in every sense: showing its effect
    // on a listing's average would leak it before the window closes, which
    // is the whole thing double-blind publication exists to prevent.
    try {
      const listingIds = [...new Set(filtered.map(l => l.id).filter(Boolean))];
      if (listingIds.length) {
        const revRows = await sql`
          SELECT listing_id,
                 AVG(hygiene)       AS hygiene,
                 AVG(communication) AS communication,
                 AVG(services)      AS services,
                 AVG(value_rating)  AS value,
                 AVG(location)      AS location,
                 COUNT(*)           AS n
          FROM listing_reviews
          WHERE listing_id = ANY(${listingIds})
            AND published_at IS NOT NULL AND admin_reverted_at IS NULL
            AND hygiene IS NOT NULL -- stay reviews only
          GROUP BY listing_id
        `;
        const byListing = {};
        revRows.forEach(r => {
          // The same weighted score the host ladder uses, so the number a
          // guest sees on a card and the number a badge rests on can never
          // disagree.
          const factors = {
            hygiene: Number(r.hygiene), communication: Number(r.communication),
            services: Number(r.services), value: Number(r.value), location: Number(r.location)
          };
          byListing[r.listing_id] = {
            rating: reviewScore(factors, REVIEW_FACTORS),
            count: Number(r.n) || 0,
            factors
          };
        });
        // ---- Frozen standing ----
        // Read from tier_current, written by the quarterly snapshot. NOT
        // recomputed here: a badge that moved on every page load would
        // contradict the quarterly cadence, and two guests loading the
        // same listing minutes apart could see different badges if a
        // review landed between them.
        //
        // Also far cheaper — this replaced a per-request cutoff
        // computation over every reviewed listing on the platform.
        const standing = {};
        try {
          const cur = await sql`
            SELECT subject_id, tier_key
            FROM tier_current
            WHERE subject_type = 'listing' AND subject_id = ANY(${listingIds})
          `;
          cur.forEach(r => { standing[r.subject_id] = r.tier_key; });
        } catch (err) {
          console.error('standing lookup failed (non-fatal):', err);
        }
        const TIER_LABELS = {};
        PROPERTY_TIERS.forEach(t => { TIER_LABELS[t.key] = t.label; });

        filtered.forEach(l => {
          const r = byListing[l.id];
          l.rating = r ? r.rating : null;
          l.review_count = r ? r.count : 0;
          // Property standing, from the same published-review aggregate
          // the rating came from — so a card's stars and its badge can
          // never rest on different data.
          const stats = r ? { reviewCount: r.count, factors: r.factors } : null;
          // Tier from the frozen snapshot; flags stay live because they are
          // absolute — Spotless and Hidden Treasure describe the listing
          // alone and need no field to rank against.
          const key = standing[l.id] || null;
          const pf = stats ? propertyFlag(stats) : null;
          l.property_tier = key && TIER_LABELS[key] ? { key, label: TIER_LABELS[key] } : null;
          l.property_flag = pf ? { key: pf.key, label: pf.label } : null;
        });
      }
    } catch (err) {
      // Ratings are decoration on top of a listing; never block the page.
      console.error('review rating lookup failed (non-fatal):', err);
    }

    try {
      const hostIds = [...new Set(filtered.map(l => l.host_id).filter(Boolean))];
      if (hostIds.length) {
        // Read from tier_current, the quarterly snapshot — the same source
        // as the header badge, so a host sees one badge everywhere and it
        // only moves on a review day. Computing it live here disagreed
        // with the header (different review windows) and ignored the
        // one-rung decay cap.
        const cur = await sql`
          SELECT subject_id, tier_key FROM tier_current
          WHERE subject_type = 'host' AND subject_id = ANY(${hostIds})
        `;
        const byHost = {};
        cur.forEach(r => {
          // EVERY rung is shown, Rising Host upward — a badge is
          // recognition, and withholding it from all but the top three
          // meant almost no host ever carried one. Only a host below the
          // lowest rung (no confirmed payout at all) has none.
          const tier = tierByKey(HOST_TIERS, r.tier_key);
          if (tier) byHost[r.subject_id] = { key: tier.key, label: tier.label, icon: tier.icon };
        });
        filtered.forEach(l => { l.host_tier = byHost[l.host_id] || null; });
      }
    } catch (err) {
      // A badge is decoration. If this fails the listings still render.
      console.error('host tier lookup failed (non-fatal):', err);
    }
    // host_id is internal — never send it to a browser.
    filtered.forEach(l => { delete l.host_id; });

    await attachLikeCounts(filtered);
    return res.status(200).json({ listings: filtered });
  } catch (err) {
    console.error('get-listings error:', err);
    return res.status(500).json({ error: 'Could not fetch listings' });
  }
};
