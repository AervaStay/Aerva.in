// /api/_insights.js — Admin → Business insights. Not an endpoint
// (get-pending-listings.js ?insights=1, admins only).
//
//   periods   each commission (or guest fee) rate's time in force, for one
//             property type or all, with what happened while it was in
//             force — bookings, value, Aerva's fees, cancellations, new
//             listings, new guests, ratings, hosts who declined — per day,
//             and the change from the period before it. Rates a while away
//             are shown as scheduled, with the days to go.
//   months    the last 12 months, month by month.
//   ratings   guests' scores by part of the stay (last 90 days), and hosts'
//             scores of guests.
//   support   requests, satisfaction and resolution (last 90 days).
//   feedback  the latest review comments and support feedback.
//
// Money figures count real bookings only (paid through Razorpay), like
// Admin → Accounts. "Aerva's fees" is the commission and guest service fee
// on bookings made, before refunds of either.

const R = require('./_rates');
const DAY = 86400e3;
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const soft = async (q, fallback) => { try { return await q; } catch (e) { return fallback; } };

// What happened between two moments, for a type ('*' = all).
async function metrics(sql, from, to, type) {
  const all = type === '*';
  const t = all ? '' : type;
  const o = (await soft(sql`
    SELECT count(*)::int AS bookings,
           count(*) FILTER (WHERE o.status = 'cancelled')::int AS cancelled,
           COALESCE(sum(o.total - COALESCE((to_jsonb(o)->>'coupon_discount')::numeric, 0) - COALESCE(o.deposit_amount, 0)), 0) AS value,
           COALESCE(sum(COALESCE(o.commission_amount, 0) + COALESCE(o.guest_service_fee, 0)), 0) AS fees,
           count(DISTINCT o.guest_id)::int AS guests,
           count(DISTINCT l.host_id)::int AS hosts
    FROM orders o JOIN listings l ON l.id = o.listing_id
    WHERE o.status IN ('paid', 'cancelled') AND o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.razorpay_order_id ~ '^order_[A-Za-z0-9]{14}$'
      AND o.created_at >= ${from} AND o.created_at < ${to}
      AND (${all} OR (CASE WHEN l.listing_type = 'experience' THEN 'Experience' ELSE COALESCE(l.property_type, 'Other') END) = ${t})`, [{}]))[0] || {};
  const newGuests = (await soft(sql`
    SELECT count(*)::int AS n FROM (
      SELECT o.guest_id, min(o.created_at) AS first FROM orders o
      WHERE o.status IN ('paid', 'cancelled') AND o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.guest_id IS NOT NULL
      GROUP BY o.guest_id) x
    WHERE x.first >= ${from} AND x.first < ${to}`, [{ n: 0 }]))[0].n;
  const listings = (await soft(sql`
    SELECT count(*) FILTER (WHERE l.created_at >= ${from} AND l.created_at < ${to})::int AS created,
           count(*) FILTER (WHERE l.deactivated_at >= ${from} AND l.deactivated_at < ${to})::int AS deactivated
    FROM listings l WHERE (${all} OR (CASE WHEN l.listing_type = 'experience' THEN 'Experience' ELSE COALESCE(l.property_type, 'Other') END) = ${t})`, [{}]))[0] || {};
  const rating = (await soft(sql`
    SELECT count(*)::int AS n,
           avg((SELECT avg(v) FROM unnest(ARRAY[r.hygiene, r.communication, r.services, r.value_rating, r.location, r.organisation, r.guide, r.safety]) v)) AS avg
    FROM listing_reviews r JOIN listings l ON l.id = r.listing_id
    WHERE r.created_at >= ${from} AND r.created_at < ${to} AND r.admin_reverted_at IS NULL
      AND (${all} OR (CASE WHEN l.listing_type = 'experience' THEN 'Experience' ELSE COALESCE(l.property_type, 'Other') END) = ${t})`, [{}]))[0] || {};
  return {
    bookings: o.bookings || 0, cancelled: o.cancelled || 0, value: r2(o.value), fees: r2(o.fees), guests: o.guests || 0, hostsBooked: o.hosts || 0,
    newGuests: newGuests || 0, listingsCreated: listings.created || 0, listingsDeactivated: listings.deactivated || 0,
    reviews: rating.n || 0, rating: rating.avg != null ? r2(rating.avg) : null
  };
}

const pct = (a, b) => (b > 0 ? r1(((a - b) / b) * 100) : null);

async function insights(sql, { audience = 'host', propertyType = '*' } = {}) {
  const type = propertyType === '*' || R.PROPERTY_TYPES.includes(propertyType) ? propertyType : '*';
  const rows = (await R.loadRates(sql, { fresh: true })).filter(r => r.audience === audience && R.validRow(r));
  const now = Date.now();
  // Moments when the rate for this type could change, in order.
  const relevant = rows.filter(r => type === '*' ? r.property_type === '*' : (r.property_type === type || r.property_type === '*'));
  const starts = [...new Set(relevant.map(r => new Date(r.effective_from).getTime()))].sort((a, b) => a - b);
  let notices = {};
  const nrows = await soft(sql`SELECT rate_id, count(*)::int AS sent, count(acknowledged_at)::int AS acknowledged, count(declined_at)::int AS declined, count(ended_at)::int AS ended
                               FROM fee_rate_notices GROUP BY rate_id`, []);
  nrows.forEach(n => { notices[n.rate_id] = n; });
  const periods = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i], until = starts[i + 1] || null;
    const row = R.rowAt(type === '*' ? rows.filter(r => r.property_type === '*') : rows, audience, type === '*' ? 'Other' : type, new Date(from));
    if (!row) continue;
    if (type === '*' && row.property_type !== '*') continue;
    const prev = periods[periods.length - 1];
    if (prev && prev.rate === Number(row.rate) && prev.rateId === row.id) continue;
    const p = { rateId: row.id, rate: Number(row.rate), appliesTo: row.property_type === '*' ? 'All property types' : row.property_type,
      from: new Date(from).toISOString(), until: until ? new Date(until).toISOString() : null, setAt: row.created_at, setBy: row.created_by, note: row.note,
      notices: notices[row.id] || null };
    if (from > now) {
      p.state = 'scheduled'; p.daysToGo = Math.ceil((from - now) / DAY);
    } else {
      const end = until && until < now ? until : now;
      p.state = until && until <= now ? 'ended' : 'in effect';
      p.days = Math.max(1, Math.round((end - from) / DAY));
      p.months = r1(p.days / 30.44);
      p.metrics = await metrics(sql, new Date(from).toISOString(), new Date(end).toISOString(), type);
      const m = p.metrics, d = p.days;
      p.perDay = { bookings: r2(m.bookings / d), value: r2(m.value / d), fees: r2(m.fees / d), newGuests: r2(m.newGuests / d), listingsCreated: r2(m.listingsCreated / d) };
      p.cancellationRate = m.bookings ? r1((m.cancelled / m.bookings) * 100) : null;
    }
    periods.push(p);
  }
  // Change from the period before (per day, so periods of any length compare).
  for (let i = 1; i < periods.length; i++) {
    const a = periods[i], b = periods[i - 1];
    if (!a.perDay || !b.perDay) continue;
    a.change = { bookings: pct(a.perDay.bookings, b.perDay.bookings), value: pct(a.perDay.value, b.perDay.value), fees: pct(a.perDay.fees, b.perDay.fees),
      newGuests: pct(a.perDay.newGuests, b.perDay.newGuests), listingsCreated: pct(a.perDay.listingsCreated, b.perDay.listingsCreated),
      rating: a.metrics.rating != null && b.metrics.rating != null ? r2(a.metrics.rating - b.metrics.rating) : null,
      cancellationRate: a.cancellationRate != null && b.cancellationRate != null ? r1(a.cancellationRate - b.cancellationRate) : null };
  }

  // Last 12 months.
  const months = [];
  const ist = new Date(now + 5.5 * 3600e3);
  for (let k = 11; k >= 0; k--) {
    const y = ist.getUTCFullYear(), m = ist.getUTCMonth() - k;
    const start = new Date(Date.UTC(y, m, 1) - 5.5 * 3600e3), end = new Date(Date.UTC(y, m + 1, 1) - 5.5 * 3600e3);
    const label = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
    const mm = await metrics(sql, start.toISOString(), end.toISOString(), type);
    const sup = (await soft(sql`SELECT count(*)::int AS n, avg(feedback_rating) AS sat FROM support_tickets WHERE created_at >= ${start.toISOString()} AND created_at < ${end.toISOString()}`, [{}]))[0] || {};
    const gr = (await soft(sql`SELECT avg(rating) AS avg, count(*)::int AS n FROM guest_reviews WHERE created_at >= ${start.toISOString()} AND created_at < ${end.toISOString()} AND admin_reverted_at IS NULL`, [{}]))[0] || {};
    const hostsNew = (await soft(sql`SELECT count(*)::int AS n FROM hosts WHERE created_at >= ${start.toISOString()} AND created_at < ${end.toISOString()}`, [{ n: 0 }]))[0].n;
    months.push(Object.assign({ month: label, newHosts: hostsNew || 0, supportRequests: sup.n || 0, supportSatisfaction: sup.sat != null ? r2(sup.sat) : null,
      guestRating: gr.avg != null ? r2(gr.avg) : null }, mm,
      { cancellationRate: mm.bookings ? r1((mm.cancelled / mm.bookings) * 100) : null }));
  }

  // Ratings by part of the stay, last 90 days.
  const since = new Date(now - 90 * DAY).toISOString();
  const parts = (await soft(sql`
    SELECT avg(hygiene) AS hygiene, avg(communication) AS communication, avg(services) AS services, avg(value_rating) AS value, avg(location) AS location,
           avg(organisation) AS organisation, avg(guide) AS guide, avg(safety) AS safety, count(*)::int AS n
    FROM listing_reviews WHERE created_at >= ${since} AND admin_reverted_at IS NULL`, [{}]))[0] || {};
  const guestParts = (await soft(sql`
    SELECT avg(rating) AS overall, avg(cleanliness) AS cleanliness, avg(communication) AS communication, avg(respectful) AS respectful, avg(rules) AS rules, count(*)::int AS n
    FROM guest_reviews WHERE created_at >= ${since} AND admin_reverted_at IS NULL`, [{}]))[0] || {};
  const fix = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'n' ? (v || 0) : (v != null ? r2(v) : null)]));
  const support = (await soft(sql`
    SELECT count(*)::int AS requests, count(*) FILTER (WHERE resolved_at IS NOT NULL OR closed_at IS NOT NULL)::int AS resolved,
           avg(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 3600) FILTER (WHERE first_response_at IS NOT NULL) AS first_reply_hours,
           avg(feedback_rating) AS satisfaction, count(feedback_rating)::int AS rated,
           count(*) FILTER (WHERE feedback_resolved IS TRUE)::int AS said_resolved
    FROM support_tickets WHERE created_at >= ${since}`, [{}]))[0] || {};
  const byCategory = await soft(sql`SELECT category, count(*)::int AS n FROM support_tickets WHERE created_at >= ${since} GROUP BY category ORDER BY n DESC LIMIT 10`, []);

  // Latest comments.
  const reviews = await soft(sql`
    SELECT r.created_at, l.property_name AS listing, r.comment,
           (SELECT avg(v) FROM unnest(ARRAY[r.hygiene, r.communication, r.services, r.value_rating, r.location, r.organisation, r.guide, r.safety]) v) AS rating
    FROM listing_reviews r JOIN listings l ON l.id = r.listing_id
    WHERE r.admin_reverted_at IS NULL AND COALESCE(btrim(r.comment), '') <> '' ORDER BY r.created_at DESC LIMIT 8`, []);
  const supportFeedback = await soft(sql`
    SELECT ref, category, feedback_rating AS rating, feedback_comment AS comment, feedback_at AS at FROM support_tickets
    WHERE feedback_at IS NOT NULL ORDER BY feedback_at DESC LIMIT 8`, []);

  return {
    audience, propertyType: type, types: R.PROPERTY_TYPES, periods: periods.reverse(), months,
    ratings: { stays: fix(parts), guests: fix(guestParts) },
    support: { requests: support.requests || 0, resolved: support.resolved || 0, firstReplyHours: support.first_reply_hours != null ? r1(support.first_reply_hours) : null,
      satisfaction: support.satisfaction != null ? r2(support.satisfaction) : null, rated: support.rated || 0, saidResolved: support.said_resolved || 0, byCategory },
    feedback: {
      reviews: reviews.map(r => ({ at: r.created_at, listing: r.listing, rating: r.rating != null ? r2(r.rating) : null, comment: String(r.comment || '').slice(0, 400) })),
      support: supportFeedback.map(f => ({ at: f.at, ref: f.ref, category: f.category, rating: f.rating, comment: String(f.comment || '').slice(0, 400) }))
    },
    notes: [
      'Only real bookings (paid through Razorpay) are counted. Test and dummy bookings are left out.',
      'Figures per day compare periods of different lengths fairly. A change soon after a new rate may also reflect the season, marketing or new listings.',
      'Aerva’s fees are the commission and guest service fee on bookings made in the period, before any refunds.'
    ]
  };
}

module.exports = { insights };
