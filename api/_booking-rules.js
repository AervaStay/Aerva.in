// /api/_booking-rules.js — money and time rules shared by payment
// confirmation and cancellation. Not an endpoint (leading underscore).
//
// 1. WHAT THE GUEST ACTUALLY PAID FOR EACH ROW
//    One Razorpay payment can cover several order rows (a cart with more
//    than one home, or an experience that includes a stay). A coupon is
//    stored on the first row only (orders.coupon_discount), but it paid for
//    booking prices across the whole cart. orders.total is the price BEFORE
//    the coupon, so refunding `total` asks Razorpay for more than was ever
//    captured, and the refund is refused.
//    allocatePaid() spreads the coupon over the rows in id order, each row
//    absorbing at most its own booking price (subtotal) — the same limit
//    create-order.js applies. The rows' paid amounts always add up to what
//    Razorpay captured.
//
// 2. HOURS UNTIL CHECK-IN, ON THE PROPERTY'S CLOCK
//    orders.arrival is a DATE column; the database driver returns it as a
//    JS Date, and `new Date(date + 'T00:00:00Z')` on that is Invalid Date —
//    which made the 48-hour host cancellation cut-off never apply. Check-in
//    day starts at midnight where the property is (listings.timezone), not
//    at midnight UTC.

const { safeZone } = require('./_timezones');

// 'YYYY-MM-DD' from a DATE value (driver Date = local midnight of that date)
// or from a string.
function dateStr(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function zoneOffsetMs(zone, atMs) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(atMs)).forEach(p => { parts[p.type] = p.value; });
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(atMs / 1000) * 1000;
}

// The instant midnight begins on `day` in `zone`, as epoch milliseconds.
function localMidnightMs(day, zone) {
  const d = dateStr(day);
  if (!d) return NaN;
  const z = safeZone(zone);
  const [y, m, dd] = d.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, dd);
  let t = guess - zoneOffsetMs(z, guess);
  const second = zoneOffsetMs(z, t);
  if (guess - second !== t) t = guess - second;
  return t;
}

// Hours from `nowMs` until check-in day begins at the property (negative
// once it has begun). NaN only for an unusable date — callers must treat
// NaN as "too late", never as "allowed".
function hoursUntilCheckIn(arrival, zone, nowMs = Date.now()) {
  return (localMidnightMs(arrival, zone) - nowMs) / 3600000;
}

// ---- The check-in MOMENT, not just the day ----
// Cancellation brackets and the host's 48-hour limit are counted to the
// listing's check-in time on the property's clock. Check-in tomorrow at
// 1:00 PM: asking today at 12:59:59 PM is still 24 hours or more; asking
// at 2:00 PM is less. listings.check_in_time is free text ("2:00 PM",
// "14:00", "2 pm"); a listing without one is treated as 2:00 PM.
const DEFAULT_CHECK_IN_MINUTES = 14 * 60;
function checkInMinutes(text) {
  const t = String(text || '').trim().toLowerCase();
  const m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/);
  if (!m) return DEFAULT_CHECK_IN_MINUTES;
  let h = Number(m[1]); const min = Number(m[2] || 0);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return DEFAULT_CHECK_IN_MINUTES;
  return h * 60 + min;
}
function checkInMomentMs(arrival, zone, checkInTime) {
  return localMidnightMs(arrival, zone) + checkInMinutes(checkInTime) * 60000;
}
// Hours from now to the check-in moment (negative once it has passed).
function hoursUntilCheckInTime(arrival, zone, checkInTime, nowMs = Date.now()) {
  return (checkInMomentMs(arrival, zone, checkInTime) - nowMs) / 3600000;
}
// Whole days before check-in, as the cancellation brackets count them
// (-1 once check-in time has passed). 47.9 hours → 1 day; 48 hours → 2.
function daysBeforeCheckIn(arrival, zone, checkInTime, nowMs = Date.now()) {
  const h = hoursUntilCheckInTime(arrival, zone, checkInTime, nowMs);
  return h < 0 ? -1 : Math.floor(h / 24);
}

// ---- Late-night bookings ----
// Between 12:00 AM and 6:00 AM on the property's clock, a guest may still
// book "tonight": the night is counted as the previous day's, so arrival is
// yesterday's date and check-out today or later (someone arriving at 2 AM
// to sleep). Once booked, they may check in straight away.
const LATE_NIGHT_UNTIL_HOUR = 6;
function localClock(zone, nowMs = Date.now()) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: safeZone(zone), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
    .formatToParts(new Date(nowMs)).forEach(p => { parts[p.type] = p.value; });
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
// The earliest arrival date a guest may book right now.
function earliestArrival(zone, nowMs = Date.now()) {
  const { date, hour } = localClock(zone, nowMs);
  if (hour >= LATE_NIGHT_UNTIL_HOUR) return date;
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// rows: [{ id, subtotal, total, coupon_discount }] — every row of ONE
// payment, whatever its status. Returns { [id]: { paid, couponAbsorbed } }.
function allocatePaid(rows) {
  const sorted = [...(rows || [])].sort((a, b) => Number(a.id) - Number(b.id));
  let coupon = sorted.reduce((s, r) => s + Math.max(0, Math.round(Number(r.coupon_discount) || 0)), 0);
  const out = {};
  for (const r of sorted) {
    const absorbed = Math.min(coupon, Math.max(0, Math.round(Number(r.subtotal) || 0)));
    coupon -= absorbed;
    out[r.id] = { paid: Math.max(0, Math.round(Number(r.total) || 0) - absorbed), couponAbsorbed: absorbed };
  }
  return out;
}

async function paidByOrderRow(sql, razorpayOrderId) {
  const rows = await sql`SELECT id, subtotal, total, coupon_discount FROM orders WHERE razorpay_order_id = ${razorpayOrderId}`;
  return allocatePaid(rows);
}

module.exports = { dateStr, localMidnightMs, hoursUntilCheckIn, allocatePaid, paidByOrderRow,
  checkInMinutes, checkInMomentMs, hoursUntilCheckInTime, daysBeforeCheckIn, LATE_NIGHT_UNTIL_HOUR, localClock, earliestArrival };

// ---------------------------------------------------------------------
// 3. THE PAYMENT WINDOW (booking_holds) — strict, no exceptions
//    • Starts when the guest taps Continue to payment; lasts 90 seconds.
//    • While it runs, those dates cannot be booked or seen as available by
//      anyone — the same guest included: hidden from search, shown as
//      booked on calendars, and a second checkout is refused.
//    • Paid within the window → the booking takes the dates and the lock
//      goes. Cancelled, closed, failed or timed out → released at once.
//    • A price change by the host closes the window (holdStatus below).
//    • At most 5 payment attempts per guest per listing per 24 hours.
//    The database refuses two live overlapping holds
//    (booking_holds_no_overlap), so two taps in the same instant can never
//    both get one.
const HOLD_SECONDS = 90;
const HOLD_MINUTES = HOLD_SECONDS / 60;          // kept for older callers
const CONFIRM_GRACE_SECONDS = 15;               // network time from Razorpay to our server
const ATTEMPTS_PER_DAY = 5;
const HOLDS_PER_IP_PER_HOUR = 30;

async function holdsReady(sql) {
  try { await sql`SELECT 1 FROM booking_holds LIMIT 0`; return true; } catch (err) { return false; }
}
const userError = (message, status) => Object.assign(new Error(message), { isUserFacing: true, status });

// stays: [{ listingId, roomId, arrival, departure }]. Returns { ids, expiresAt },
// or throws a user-facing error. Before the table exists: no holds, no error.
async function takeHolds(sql, stays, { guestKey, ip }) {
  if (!stays.length || !(await holdsReady(sql))) return { ids: [], expiresAt: null };
  await sql`UPDATE booking_holds SET released = true WHERE released = false AND expires_at < now()`;
  await sql`DELETE FROM booking_holds WHERE released = true AND created_at < now() - interval '2 days'`;

  // 5 attempts per guest per listing per 24 hours.
  for (const lid of [...new Set(stays.map(s => Number(s.listingId)))]) {
    const n = (await sql`SELECT count(*)::int AS n FROM booking_holds
                         WHERE guest_key = ${guestKey} AND listing_id = ${lid} AND created_at > now() - interval '24 hours'`)[0].n;
    if (n >= ATTEMPTS_PER_DAY) {
      throw userError(`You have used all ${ATTEMPTS_PER_DAY} payment attempts for this listing today. Please try again tomorrow, or write to hello@aerva.in.`, 429);
    }
  }
  if (ip) {
    const n = (await sql`SELECT count(*)::int AS n FROM booking_holds WHERE ip = ${ip} AND created_at > now() - interval '1 hour'`)[0].n;
    if (n >= HOLDS_PER_IP_PER_HOUR) throw userError('Too many checkouts started from this connection. Please try again later.', 429);
  }

  const ids = [];
  try {
    for (const s of stays) {
      const r = (await sql`
        INSERT INTO booking_holds (listing_id, room_id, arrival, departure, guest_key, ip, expires_at)
        VALUES (${s.listingId}, ${s.roomId || null}, ${s.arrival}::date, ${s.departure}::date, ${guestKey}, ${ip || null},
                now() + make_interval(secs => ${HOLD_SECONDS}))
        RETURNING id, expires_at`)[0];
      ids.push(r.id);
    }
  } catch (err) {
    if (ids.length) await sql`UPDATE booking_holds SET released = true WHERE id = ANY(${ids})`;
    if (err && err.code === '23P01') {
      // Whose payment is running — this guest's own (another tab or a
      // second tap), or someone else's. Either way: no second checkout.
      const s = stays[0];
      const live = (await sql`SELECT guest_key, GREATEST(0, ceil(extract(epoch FROM expires_at - now())))::int AS secs FROM booking_holds
                              WHERE released = false AND expires_at > now() AND listing_id = ${s.listingId}
                                AND COALESCE(room_id, 0) = ${s.roomId || 0}
                                AND arrival < ${s.departure}::date AND departure > ${s.arrival}::date LIMIT 1`)[0];
      if (live && live.guest_key === guestKey) {
        throw userError(`Your payment for these dates is already open. Finish it there, or wait ${live.secs} seconds and try again.`, 409);
      }
      throw userError('These dates are not available right now. Please choose other dates.', 409);
    }
    throw err;
  }
  const expiresAt = (await sql`SELECT min(expires_at) AS e FROM booking_holds WHERE id = ANY(${ids})`)[0].e;
  return { ids, expiresAt };
}

// Live status of a checkout, polled by the page every few seconds.
// Closes the window (releases the hold) when it has timed out, was
// released, or the host changed a price since it started.
async function holdStatus(sql, razorpayOrderId) {
  if (!(await holdsReady(sql))) return { active: true };
  const rows = await sql`SELECT id, listing_id, released, created_at, expires_at, (expires_at < now()) AS expired,
                                GREATEST(0, ceil(extract(epoch FROM expires_at - now())))::int AS secs
                         FROM booking_holds WHERE razorpay_order_id = ${razorpayOrderId}`;
  if (!rows.length) return { active: false, reason: 'released' };
  if (rows.some(r => r.released)) return { active: false, reason: 'released' };
  if (rows.some(r => r.expired)) { await releaseHolds(sql, { razorpayOrderId }); return { active: false, reason: 'expired' }; }
  let changed = [];
  try {
    const since = rows.reduce((m, r) => (r.created_at < m ? r.created_at : m), rows[0].created_at);
    changed = await sql`SELECT id FROM listings WHERE id = ANY(${rows.map(r => r.listing_id)}) AND price_changed_at > ${since}`;
  } catch (err) { /* price_changed_at not added yet */ }
  if (changed.length) { await releaseHolds(sql, { razorpayOrderId }); return { active: false, reason: 'price_changed' }; }
  return { active: true, secondsLeft: Math.min(...rows.map(r => r.secs)) };
}

// At payment confirmation: was this payment completed inside its window?
// A payment for a window that was cancelled, closed or timed out is not a
// booking. Orders made before windows existed (no hold was ever taken) are
// left to the other checks.
async function holdValidForConfirmation(sql, razorpayOrderId, { heldAtCheckout }) {
  if (!heldAtCheckout || !(await holdsReady(sql))) return { ok: true };
  const rows = await sql`SELECT released, (now() > expires_at + make_interval(secs => ${CONFIRM_GRACE_SECONDS})) AS late
                         FROM booking_holds WHERE razorpay_order_id = ${razorpayOrderId}`;
  if (!rows.length || rows.some(r => r.released)) return { ok: false, reason: 'The payment window had already been closed or cancelled.' };
  if (rows.some(r => r.late)) return { ok: false, reason: `The payment was completed after the ${HOLD_SECONDS}-second payment window had ended.` };
  return { ok: true };
}

async function attachHolds(sql, ids, razorpayOrderId) {
  if (!ids || !ids.length) return;
  await sql`UPDATE booking_holds SET razorpay_order_id = ${razorpayOrderId} WHERE id = ANY(${ids})`;
}
// Never throws.
async function releaseHolds(sql, { ids = null, razorpayOrderId = null }) {
  try {
    if (ids && ids.length) await sql`UPDATE booking_holds SET released = true WHERE id = ANY(${ids}) AND released = false`;
    if (razorpayOrderId) await sql`UPDATE booking_holds SET released = true WHERE razorpay_order_id = ${razorpayOrderId} AND released = false`;
  } catch (err) { /* table not there yet */ }
}
// Homes (not resort rooms) held by someone else for dates overlapping
// [arrival, departure). For search results. Never throws.
async function heldListingIds(sql, arrival, departure) {
  try {
    const rows = await sql`SELECT DISTINCT listing_id FROM booking_holds
                           WHERE released = false AND expires_at > now() AND room_id IS NULL
                             AND arrival < ${departure}::date AND departure > ${arrival}::date`;
    return new Set(rows.map(r => Number(r.listing_id)));
  } catch (err) { return new Set(); }
}
async function heldRoomIds(sql, listingId, arrival, departure) {
  try {
    const rows = await sql`SELECT DISTINCT room_id FROM booking_holds
                           WHERE released = false AND expires_at > now() AND listing_id = ${listingId} AND room_id IS NOT NULL
                             AND arrival < ${departure}::date AND departure > ${arrival}::date`;
    return new Set(rows.map(r => Number(r.room_id)));
  } catch (err) { return new Set(); }
}

module.exports.HOLD_MINUTES = HOLD_MINUTES;
module.exports.HOLD_SECONDS = HOLD_SECONDS;
module.exports.ATTEMPTS_PER_DAY = ATTEMPTS_PER_DAY;
module.exports.holdStatus = holdStatus;
module.exports.holdValidForConfirmation = holdValidForConfirmation;
module.exports.takeHolds = takeHolds;
module.exports.attachHolds = attachHolds;
module.exports.releaseHolds = releaseHolds;
module.exports.heldListingIds = heldListingIds;
module.exports.heldRoomIds = heldRoomIds;
