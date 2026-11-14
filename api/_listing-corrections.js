// /api/_listing-corrections.js — "the place is real, but something is
// different". Not an endpoint.
//
// THE OWNER'S RULES (13 Nov 2026):
//   • This is the lightest thing in the system, and deliberately so. A
//     guest standing in the right house, who can stay the night, but who
//     found the listing wrong on some point — the bedroom wall is green,
//     not white — has had nowhere honest to say so. The check-in card
//     offered one button ("This place is real and as listed") that they
//     could not truthfully press, so they went to Report a problem, where
//     the first option is the check-in promise: payout held, and if Aerva
//     confirms it the host is paid nothing for the booking. A wall could
//     cost a host a booking.
//   • So: NO money moves, in either direction. The payout is NOT held.
//     NOTHING is held against the host — they are ADVISED to put the
//     listing right, with no deadline and no penalty.
//   • Aerva reads it and either advises the host, drops it, or escalates
//     it by hand if it turns out to be serious. No automatic escalation,
//     and no count of corrections that trips anything: case by case.
//   • Filing one still confirms the place is real, because it is — the
//     guest is standing in it. It sets orders.guest_confirmed_stay_at
//     exactly as the confirm button does, so the listing still gets its
//     check and the host's payout still runs.
//
// The dividing line the guest is asked to apply is NOT "is anything
// different?" but "does the difference stop you staying as booked?" —
// the only test someone can apply honestly at the door at 9pm. Paint, a
// sofa, a missing cushion: they can still stay. No water, a different
// flat, half the bedrooms, someone already living there: they cannot,
// and that is the check-in promise, not this.
//
// A guest is never punished for choosing this one when the problem was
// serious: Aerva escalates it for them. And a guest who chose the heavy
// path over something small is not told they were wrong — Aerva steps
// that report down to a correction (status 'corrected' on the report).

const { logAudit } = require('./_audit-log');
// Deliberately no thread posting here: see create() — nothing about a
// correction goes into a booking's thread.

const MAX_FILES = 8;
const MAX_WHAT = 1200;
const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });
// No HTML escaping helper and no email() here any more, deliberately: this
// flow sends the host nothing (owner, 14 Nov 2026 — a listing that needs
// updating is a recommendation on the listing, not a message to the host).
// Anything that needs either of those has been added back by mistake.

// Same rule as the other reports: only our own blob storage, capped.
function cleanFiles(list) {
  return (Array.isArray(list) ? list : []).map(String)
    .filter(u => /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(u) && u.length <= 600).slice(0, MAX_FILES);
}

// The table arrives with 2026-11-13-01. Until that has been run, every
// path here does nothing rather than throwing: the check-in card falls
// back to its two answers (see ready() in the guest view).
let tableReady = null;
async function ready(sql) {
  if (tableReady !== null) return tableReady;
  try {
    const r = await sql`SELECT 1 FROM information_schema.tables WHERE table_name = 'listing_corrections' LIMIT 1`;
    tableReady = r.length > 0;
  } catch (err) { tableReady = false; }
  return tableReady;
}

// ---------------------------------------------------------------------
// THE GUEST FILES ONE
// Called from the check-in card, so the window and ownership checks are
// the check-in promise's own (confirmStay) — this runs after them.
async function create(sql, { orderId, guestId, what, photos, source = 'guest', reportId = null, adminLabel = null }) {
  if (!(await ready(sql))) throw userError('Aerva cannot take this just now. Please use Report a problem instead.', 503);
  const text = String(what == null ? '' : what).trim().slice(0, MAX_WHAT);
  if (text.length < 10) throw userError('Please say in a line or two what is different.', 400);
  const files = cleanFiles(photos);

  // host_id lives on the listing, not on the order.
  const rows = await sql`SELECT o.id, o.listing_id, o.guest_id, o.suite_name, o.confirmation_code,
                                l.host_id, l.property_name, l.host_email, l.host_name
                         FROM orders o LEFT JOIN listings l ON l.id = o.listing_id WHERE o.id = ${orderId}`;
  const o = rows[0];
  if (!o) throw userError('Booking not found.', 404);
  if (source === 'guest' && Number(o.guest_id) !== Number(guestId)) throw userError('Booking not found.', 404);

  let saved;
  try {
    saved = (await sql`INSERT INTO listing_corrections (order_id, listing_id, host_id, guest_id, what, photos, source, report_id)
                       VALUES (${o.id}, ${o.listing_id}, ${o.host_id || null}, ${o.guest_id || null}, ${text},
                               ${JSON.stringify(files)}::jsonb, ${source}, ${reportId})
                       RETURNING *`)[0];
  } catch (err) {
    // The unique index on one open correction per booking.
    if (String(err.message || '').includes('idx_listing_corrections_open'))
      throw userError('You have already told Aerva about something on this stay. Aerva is looking at it.', 409);
    throw err;
  }

  // NOTHING goes into the booking thread (owner, 14 Nov 2026). A line in
  // that thread is tied to that booking, so however it is worded the host
  // can see which guest it came from — and a guest still sleeping in their
  // house should not be identifiable as the one who said something.
  //
  // AND NO EMAIL EITHER (owner, 14 Nov 2026): "If there is some changes
  // required in the listing, email to host won't be send but a
  // recommendation to update the listing and photos as per the listing."
  // An email goes only where the place could not be found as listed, which
  // is the report flow in _checkin-promise.js, not this one.
  //
  // So a listing that merely needs updating produces a RECOMMENDATION and
  // nothing else: the bell notice on the listing (bellNotifications below),
  // which appears once Aerva has reviewed the correction and agreed with
  // it. That also closes a gap this flow had — the email used to carry the
  // guest's own sentence, unreviewed, to the host over Aerva's name.
  // Nothing a guest writes now reaches a host from here at all.

  await logAudit(sql, { action: 'listing_correction_filed', success: true,
    actorType: source === 'guest' ? 'guest' : 'admin', actorIdentifier: source === 'guest' ? String(guestId) : String(adminLabel || 'admin'),
    targetType: 'listing', targetId: o.listing_id, metadata: { orderId: o.id, correctionId: saved.id, source, reportId } });
  return saved;
}

// ---------------------------------------------------------------------
// WHAT THE HOST AND THE GUEST SEE
async function forGuest(sql, orderIds) {
  if (!(await ready(sql)) || !orderIds || !orderIds.length) return new Map();
  try {
    const rows = await sql`SELECT DISTINCT ON (order_id) id, order_id, what, status, created_at, decided_at
                           FROM listing_corrections WHERE order_id = ANY(${orderIds.map(Number)})
                           ORDER BY order_id, id DESC`;
    return new Map(rows.map(r => [Number(r.order_id), r]));
  } catch (err) { return new Map(); }
}

// ---------------------------------------------------------------------
// AERVA LOOKS AT IT
async function forAdmin(sql, { status = 'open', limit = 100 } = {}) {
  if (!(await ready(sql))) return { ready: false, rows: [] };
  const rows = await sql`SELECT c.*, o.confirmation_code, o.arrival, o.departure, o.suite_name,
                                l.property_name, l.city, l.host_name, l.host_email,
                                g.first_name AS guest_first, g.last_name AS guest_last, g.email AS guest_email
                         FROM listing_corrections c
                         LEFT JOIN orders o ON o.id = c.order_id
                         LEFT JOIN listings l ON l.id = c.listing_id
                         LEFT JOIN guests g ON g.id = c.guest_id
                         WHERE (${status}::text IS NULL OR c.status = ${status})
                         ORDER BY c.created_at DESC LIMIT ${Math.min(Number(limit) || 100, 300)}`;
  return { ready: true, rows: rows.map(r => ({
    id: r.id, orderId: r.order_id, listingId: r.listing_id, code: r.confirmation_code,
    listing: r.property_name || r.suite_name, city: r.city, host: r.host_name, hostEmail: r.host_email,
    guest: [r.guest_first, r.guest_last].filter(Boolean).join(' '), guestEmail: r.guest_email,
    what: r.what, photos: r.photos || [], status: r.status, source: r.source,
    createdAt: r.created_at, decidedAt: r.decided_at, decidedBy: r.decided_by, note: r.decision_note })) };
}

// Aerva's decision. 'advised' tells the host to put it right; 'dropped'
// closes it; 'escalated' is recorded here while Aerva opens the heavier
// report by hand. No money, no penalty, no deadline — by the owner's
// rule of 13 Nov 2026, this tier never costs the host anything.
async function decide(sql, { id, action, note, adminLabel }) {
  if (!(await ready(sql))) throw userError('Corrections are not switched on yet.', 503);
  if (!['advised', 'dropped', 'escalated'].includes(action)) throw userError('Unknown decision.', 400);
  const got = await sql`UPDATE listing_corrections
                        SET status = ${action}, decided_at = now(), decided_by = ${adminLabel || 'admin'},
                            decision_note = ${note ? String(note).slice(0, 1000) : null}
                        WHERE id = ${Number(id) || 0} AND status = 'open' RETURNING *`;
  if (!got.length) throw userError('That correction has already been dealt with.', 409);
  const c = got[0];

  // 'advised' sends NO email either (owner, 14 Nov 2026). A listing that
  // needs updating is a recommendation, not a message: deciding 'advised'
  // is what makes the bell notice on the listing appear (bellNotifications
  // reads the decided row), and that notice is the whole of how the host
  // hears. An email goes only where the place could not be found as
  // listed, which is the report flow in _checkin-promise.js.
  //
  // The admin's note still matters — it is what the bell notice shows, in
  // Aerva's words rather than the guest's.

  await logAudit(sql, { action: 'listing_correction_' + action, success: true, actorType: 'admin', actorIdentifier: adminLabel || 'admin',
    targetType: 'listing', targetId: c.listing_id, metadata: { correctionId: c.id, orderId: c.order_id, note: note || null } });
  return c;
}

// The host's bell, and since the emails went, the ONLY way a host hears
// that a listing has drifted out of date.
//
// Deliberately on the LISTING, never on a booking (owner, 14 Nov 2026): a
// host should be told what to update without being able to work out which
// guest mentioned it. Only corrections Aerva has looked at and agreed with
// are shown — an open one is still Aerva's to judge, and a host should not
// be chased over something that may yet be dropped.
//
// AND ONLY WHERE AERVA WROTE THE WORDING (owner, 14 Nov 2026: "No
// notification in that case"). The notice used to fall back to the guest's
// own sentence when an admin advised without writing a note, which put the
// guest's words — and whatever identified them — in front of the host by
// the back door. There is no fallback now: no note, no notice. The admin's
// note is the only text a host ever sees, so what reaches them is always
// Aerva's own words.
//
// The cost of that is silence: advising without a note tells the host
// nothing at all. The admin form says so where the note is typed.
async function bellNotifications(sql, { hostId }) {
  const out = [];
  if (!hostId || !(await ready(sql))) return out;
  try {
    const rows = await sql`SELECT c.id, c.listing_id, c.decision_note, l.property_name
                           FROM listing_corrections c JOIN listings l ON l.id = c.listing_id
                           WHERE l.host_id = ${hostId} AND c.status = 'advised'
                             AND c.decision_note IS NOT NULL AND btrim(c.decision_note) <> ''
                             AND c.decided_at > now() - interval '45 days'
                           ORDER BY c.decided_at DESC LIMIT 5`;
    rows.forEach(r => out.push({ id: 'listing-correction:' + r.id, kind: 'action',
      title: `One update for ${r.property_name || 'your listing'}`,
      body: `${String(r.decision_note).slice(0, 140)} — update the photos or the description so they show the place as it is.`,
      href: 'host-dashboard.html?listing=' + r.listing_id }));
  } catch (err) { /* the bell never blocks */ }
  return out;
}

// How many are waiting, for the admin badge.
async function openCount(sql) {
  if (!(await ready(sql))) return 0;
  try { return Number((await sql`SELECT count(*)::int AS n FROM listing_corrections WHERE status = 'open'`)[0].n) || 0; }
  catch (err) { return 0; }
}

module.exports = { create, forGuest, forAdmin, decide, bellNotifications, openCount, ready, cleanFiles };
