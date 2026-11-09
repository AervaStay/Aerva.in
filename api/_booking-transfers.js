// /api/_booking-transfers.js — a guest moves some (or all) nights of a stay
// to another property of the same host. Not an endpoint.
//
// THE OWNER'S RULES (9 Nov 2026):
//   • Only the guest asks; the host or a co-host accepts or declines.
//   • The other property must have the same host AND the same co-hosts as
//     the booked one. The guest first chooses the nights to move, then sees
//     only those properties (and resort rooms) that are free for them.
//   • Any nights may move — the start, the end or the middle — but at
//     least ONE night stays at the booked property. Check-in and check-out
//     never change: the nights are split, not moved in time. The booking
//     becomes up to three linked bookings on the same payment: the nights
//     before, the moved nights, the nights after. A booking whose dates
//     were changed earlier can be transferred too (the fee applies).
//   • When: before check-in, or until 10 AM on the day after check-in
//     (property's clock); never once the host has been paid out; nights
//     that have passed never move.
//   • Valid only once the host or a co-host accepts AND the guest then
//     confirms: by paying the difference, or by accepting the refund
//     (after the transfer fee). Nothing changes until then.
//   • Aerva works out the new price: the nights that stay are priced as
//     before (the booking's own rates, from when it was made); the moved
//     nights at the other property's rates now.
//   • Aerva's transfer fee: 5% of what the moved nights cost at the booked
//     property, ALWAYS charged when a transfer is made.
//   • What the guest owes = new total − old total (the fee included):
//     more → paid after the host accepts (same 24 hours and 3-minute window
//     as any change); less → held as Aerva credit (_fee-credits.js
//     creditForTransfer): used on another booking, or refunded to the
//     original payment whenever the guest asks, with every movement in the
//     credit ledger for the CA.
//   • Each part is its own booking: its own booking code, payout and TDS
//     (on that part's own amount), and its own cancellation.
//   • Once transferred, the guest cannot change, move, split again, shorten
//     or cancel any part (orders.transfer_change_id) — even if unhappy. The
//     guest can contact Aerva Support; Aerva decides (admin tools still
//     work). The guest is shown all of this before sending and confirming.
//   • Declined (or never paid) → nothing is charged, no fee, no change.
//   • The moved nights take the other property's cancellation policy (it
//     applies only to a cancellation by the host or by Aerva: the guest can
//     no longer cancel); the nights that stay keep the booking's own.
//
// HOW IT RUNS: a transfer is a booking change (_booking-changes.js) whose
// requested.kind is 'transfer' — the same request, answer, payment, expiry
// and refund steps; only the pricing (quoteTransfer) and the writing
// (applyTransfer) are different.
//
// WHAT IS KEPT WHERE: the original booking row stays the first part still
// at the booked property. New parts are new rows on the same payment (razorpay_order_id),
// each with its own confirmation code, payout and cancellation. The
// security deposit and pet fee of the booked property are charged once
// (on the first part there); the other property's own deposit and pet fee
// apply to the moved nights. Add-ons stay with their nights at the booked
// property; they are not carried to the other property. The transfer fee
// is Aerva's: it sits in the moved part's service fee (never refunded).

const { priceStay } = require('./_pricing');
const { dateStr, localDateAt, localMidnightMs } = require('./_booking-rules');
const { logAudit } = require('./_audit-log');

const TRANSFER_FEE_PERCENT = 5;
const MAX_TARGETS = 40;

const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const niceDate = (d) => new Date(dateStr(d) + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
function nightsBetween(a, b) {
  const out = [];
  for (let d = new Date(a + 'T00:00:00Z'); d < new Date(b + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const policyName = (p) => (p === 'firm' ? 'Firm' : 'Flexible');

async function email(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return;
  try {
    await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html: `<div style="font-family:sans-serif; max-width:480px;">${html}</div>` }) });
  } catch (err) { console.error('transfer email failed:', err.message); }
}

// The active co-hosts of a listing, as a sorted key ('' = none).
async function cohostKey(sql, listingId) {
  try {
    const rows = await sql`SELECT c.cohost_guest_id FROM cohosts c JOIN listings l ON l.host_id = c.host_id
                           WHERE l.id = ${listingId} AND c.status = 'active' AND c.cohost_guest_id IS NOT NULL AND ${listingId} = ANY(c.listing_ids)`;
    return rows.map(r => Number(r.cohost_guest_id)).sort((a, b) => a - b).join(',');
  } catch (e) { return ''; }
}

// WHEN (the owner's rule): any time before check-in; once the stay has
// started, only until 10 AM (the property's clock) on the day after
// check-in — after that the option is not offered at all. Never once the
// host has been paid out for the booking (a first-night payout sent while
// a request is open does not count: the rest is held for the outcome).
const WINDOW_HOUR = 10;   // the same hard deadline as every other change (owner, 9 Nov 2026)
function transferWindowEndMs(arrivalStr, zone) {
  const d = new Date(arrivalStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
  return localMidnightMs(d.toISOString().slice(0, 10), zone) + WINDOW_HOUR * 3600e3;
}
function transferOpen(o, at = null) {
  const t = at ? new Date(at).getTime() : Date.now();
  return Date.now() < localMidnightMs(o.departureStr, o.timezone) && t < transferWindowEndMs(o.arrivalStr, o.timezone);
}
async function payoutSent(sql, orderId) {
  try {
    return (await sql`SELECT 1 FROM payouts p JOIN orders o ON o.id = p.order_id
                      WHERE p.order_id = ${orderId} AND p.status IN ('sent', 'processing')
                        AND (to_jsonb(o)->>'payout_rest_held_at') IS NULL LIMIT 1`).length > 0;
  } catch (e) { return false; }
}
const WINDOW_CLOSED = 'This booking can no longer be moved to another property. Once a stay has started, a transfer can be asked for until 10 AM on the day after check-in.';
const PAID_OUT = 'This booking can no longer be moved to another property: the host has already been paid for it.';
const LOCKED = 'This booking was transferred, so it cannot be changed, moved, split again, shortened or cancelled. If something is not working, contact Aerva Support; Aerva will look at it and decide.';
async function transfersReady(sql) {
  try { await sql`SELECT transfer_change_id FROM orders LIMIT 0`; return true; } catch (e) { return false; }
}
async function assertTransferable(sql, o, guestId, at = null) {
  if (!o || (guestId != null && o.guest_id !== guestId)) throw userError('Booking not found.', 404);
  if (o.transfer_change_id) throw userError(LOCKED);
  if (!(await transfersReady(sql))) throw userError('Moving a booking to another property is not switched on yet. Please try again later.', 503);
  if (o.status !== 'paid') throw userError('Only a confirmed booking can be moved.');
  if ((o.charge_currency || 'INR') !== 'INR') throw userError('This booking cannot be moved online. Please write to hello@aerva.in.');
  if (o.kind !== 'stay') throw userError('Only a stay can be moved to another property.');
  if (!transferOpen(o, at)) throw userError(WINDOW_CLOSED);
  if (await payoutSent(sql, o.id)) throw userError(PAID_OUT);
}

// The booking, checked as transferable, and the nights asked for.
async function loadForTransfer(sql, orderId, guestId, moveFrom, moveTo, requestedAt = null) {
  const bc = require('./_booking-changes');
  const o = await bc.loadBooking(sql, orderId);
  await assertTransferable(sql, o, guestId, requestedAt);
  const from = String(moveFrom || '').slice(0, 10), to = String(moveTo || '').slice(0, 10);
  if (!isDay(from) || !isDay(to)) throw userError('Choose the nights to move.');
  if (to <= from) throw userError('The last night must be after the first.');
  if (from < o.arrivalStr || to > o.departureStr) throw userError('Choose nights within your booking.');
  // The day the guest asked, on the property's clock. Nights already spent
  // cannot move; during the stay the check-in night always stays.
  const askedOn = requestedAt ? localDateAt(requestedAt, o.timezone) : o.todayStr;
  if (from < askedOn) throw userError('Nights that have already passed cannot be moved.');
  if (o.started && from === o.arrivalStr) throw userError('You have checked in, so the check-in night stays where it is. Choose nights from tomorrow.');
  // At least one night stays at the booked property (the owner's rule).
  if (from === o.arrivalStr && to === o.departureStr) throw userError(`At least one night must stay at ${o.property_name}. Choose fewer nights to move.`);
  return { o, from, to, askedOn };
}

// The add-ons of the booking with the nights they were chosen for.
async function bookedAmenities(sql, orderId) {
  try {
    return (await sql`SELECT listing_amenity_id, selected_dates FROM order_amenities WHERE order_id = ${orderId}`)
      .map(a => ({ id: Number(a.listing_amenity_id), dates: Array.isArray(a.selected_dates) ? a.selected_dates.map(String) : [] }))
      .filter(a => a.id);
  } catch (e) { return []; }
}

// Prices a part of the stay. keep: a part still at the booked property
// (its own rates from when the booking was made; its add-ons on its nights;
// pets charged only on the first such part). Throws a user-facing error.
async function pricePart(sql, o, part, { first, amenities }) {
  const nights = nightsBetween(part.arrival, part.departure);
  const keep = part.role === 'keep';
  const petTypes = Array.isArray(o.pet_types) ? o.pet_types : [];
  const pets = keep && !first ? 0 : petTypes.length;
  const s = {
    listingId: part.listingId, roomId: part.roomId || null, arrival: part.arrival, departure: part.departure,
    guests: Number(o.guests), adults: Number(o.guests),
    // Already under way: arrival keeps its day (and a move tonight is the host's call, not the same-day cut-off).
    keepArrival: o.started && part.arrival <= o.todayStr,
    pets, petTypes: pets ? petTypes : [],
    serviceAnimals: keep && !first ? [] : (Array.isArray(o.service_animal_types) ? o.service_animal_types : []),
    youngLitterCount: pets ? Number(o.young_litter_count) || 0 : 0,
    selectedAmenities: keep ? amenities.map(a => ({ amenityId: a.id, dates: a.dates.filter(d => nights.includes(d)) })).filter(a => a.dates.length) : []
  };
  const priced = await priceStay(sql, s, 0, keep ? { excludeOrderId: o.id, at: o.created_at || null } : {});
  if (priced.error) throw userError(priced.error.replace(/^Stay 1: /, ''));
  const d = priced.detail;
  if (keep && !first) d.depositAmount = 0;           // the booked property's deposit is held once
  // Kept on the row as booked, even where not charged again.
  d.petTypes = petTypes; d.serviceAnimals = Array.isArray(o.service_animal_types) ? o.service_animal_types : [];
  return d;
}
const partTotal = (d) => Math.round(d.subtotal + d.gst + d.guestServiceFee + Number(d.depositAmount || 0));

// ---------------------------------------------------------------------
// The properties the nights could move to: same host, same co-hosts,
// free for those nights, able to take this party (guests, pets).
async function transferTargets(sql, orderId, guestId, { moveFrom, moveTo }) {
  const { o, from, to } = await loadForTransfer(sql, orderId, guestId, moveFrom, moveTo);
  const mine = await cohostKey(sql, o.listing_id);
  let listings = [];
  listings = await sql`
    SELECT l.id, l.property_name, l.property_type, l.city, COALESCE(l.cancellation_policy, 'flexible') AS cancellation_policy,
           COALESCE(NULLIF(btrim(l.cover_photo_url), ''),
                    CASE WHEN jsonb_typeof(l.exterior_photo_urls->0) = 'string' THEN l.exterior_photo_urls->>0 ELSE l.exterior_photo_urls->0->>'url' END) AS photo
    FROM listings l
    WHERE l.host_id = ${o.host_id} AND l.status = 'approved' AND COALESCE(l.listing_type, 'stay') <> 'experience' AND l.id <> ${o.listing_id}
    ORDER BY l.property_name LIMIT 60`;
  const out = [];
  const unavailable = [];
  for (const l of listings) {
    if ((await cohostKey(sql, l.id)) !== mine) continue;     // different co-hosts: not offered
    let rooms = [{ id: null, name: null }];
    if (l.property_type === 'Resort') {
      try { rooms = (await sql`SELECT id, room_name FROM listing_rooms WHERE listing_id = ${l.id} AND is_active = TRUE ORDER BY id`).map(r => ({ id: r.id, name: r.room_name || 'Room' })); }
      catch (e) { rooms = []; }
    }
    for (const r of rooms) {
      try {
        const d = await pricePart(sql, o, { role: 'move', listingId: l.id, roomId: r.id, arrival: from, departure: to }, { first: false, amenities: [] });
        out.push({ listingId: l.id, roomId: r.id, name: r.name ? `${l.property_name} — ${r.name}` : l.property_name, city: l.city || null,
                   photo: l.photo || null, cancellationPolicy: policyName(l.cancellation_policy), priceForNights: partTotal(d) });
      } catch (err) {
        if (err.isUserFacing) unavailable.push({ name: r.name ? `${l.property_name} — ${r.name}` : l.property_name, why: err.message });
        else throw err;
      }
      if (out.length >= MAX_TARGETS) break;
    }
    if (out.length >= MAX_TARGETS) break;
  }
  return { orderId: o.id, moveFrom: from, moveTo: to, nights: nightsBetween(from, to).length, targets: out, unavailableCount: unavailable.length };
}

// ---------------------------------------------------------------------
// The full price of a transfer: every part, the fee, old and new totals.
// Same shape as quoteChange in _booking-changes.js (kind 'transfer').
async function quoteTransfer(sql, orderId, guestId, input, requestedAt = null) {
  const { o, from, to } = await loadForTransfer(sql, orderId, guestId, input.moveFrom, input.moveTo, requestedAt);
  const targetId = Number(input.targetListingId) || 0;
  const targetRoomId = input.targetRoomId ? Number(input.targetRoomId) : null;
  const t = (await sql`SELECT id, host_id, property_name, status, property_type, COALESCE(listing_type, 'stay') AS listing_type,
                              COALESCE(cancellation_policy, 'flexible') AS cancellation_policy
                       FROM listings WHERE id = ${targetId}`)[0];
  if (!t || t.status !== 'approved' || t.listing_type === 'experience') throw userError('That property cannot be booked right now.');
  if (t.id === o.listing_id) throw userError('Choose a different property.');
  if (Number(t.host_id) !== Number(o.host_id)) throw userError('A booking can only move to another property of the same host.');
  if ((await cohostKey(sql, t.id)) !== (await cohostKey(sql, o.listing_id))) throw userError('A booking can only move to a property with the same host and co-hosts.');

  // The parts, in date order.
  const parts = [];
  if (from > o.arrivalStr) parts.push({ role: 'keep', listingId: o.listing_id, roomId: o.room_id || null, arrival: o.arrivalStr, departure: from });
  parts.push({ role: 'move', listingId: t.id, roomId: targetRoomId, arrival: from, departure: to });
  if (to < o.departureStr) parts.push({ role: 'keep', listingId: o.listing_id, roomId: o.room_id || null, arrival: to, departure: o.departureStr });

  const amenities = await bookedAmenities(sql, o.id);
  let firstKeep = true;
  for (const p of parts) {
    p.detail = await pricePart(sql, o, p, { first: p.role === 'keep' ? firstKeep : false, amenities });
    if (p.role === 'keep') firstKeep = false;
    p.policy = p.role === 'keep' ? (o.cancellation_policy || null) : t.cancellation_policy;
  }
  // Aerva's service fee is never refunded: the parts together keep at least
  // what was charged (any shortfall stays on the first part).
  const feeSum = parts.reduce((s, p) => s + p.detail.guestServiceFee, 0);
  const paidFee = Math.round(Number(o.guest_service_fee) || 0);
  if (feeSum < paidFee) parts[0].detail.guestServiceFee += paidFee - feeSum;

  // The transfer fee: 5% of what the moved nights cost at the booked property.
  const atBooked = await pricePart(sql, o, { role: 'keep', listingId: o.listing_id, roomId: o.room_id || null, arrival: from, departure: to }, { first: false, amenities: [] });
  const movedValue = Math.round(atBooked.subtotal);
  const transferFee = Math.round(movedValue * TRANSFER_FEE_PERCENT / 100);
  const moved = parts.find(p => p.role === 'move');
  moved.transferFee = transferFee;
  // The free cancellation add-on (_pricing.js) stays on the booking row (the
  // first part at the booked property, or the moved part when every night
  // moves — the same part applyTransfer writes onto the row). It is not
  // refunded or charged again; a transferred booking cannot be cancelled,
  // so its window no longer applies.
  const fc = require('./_pricing').addOnOf(o);
  const rowPart = parts[Math.max(0, parts.findIndex(p => p.role === 'keep'))];
  if (fc.fee > 0 && !fc.refunded) rowPart.addOn = { fee: fc.fee, gst: fc.gst, commission: fc.commission };
  parts.forEach(p => { p.total = partTotal(p.detail) + (p.transferFee || 0) + (p.addOn ? p.addOn.fee + p.addOn.gst : 0); });

  const newTotal = parts.reduce((s, p) => s + p.total, 0);
  const oldTotal = Math.round(Number(o.totalNow));
  const n = moved.detail.nights;
  const summary = `Move ${plural(n, 'night')} (${niceDate(from)} – ${niceDate(to)}) from ${o.property_name} to ${moved.detail.suite}`;
  // Coupon: the part of a price cut that was paid by coupon is not returned (as for any change).
  const bc = require('./_booking-changes');
  const refundOwed = Math.max(0, oldTotal - newTotal);
  const couponNotReturned = await bc.couponShareOfCut(sql, o, { kind: 'stay', subtotal: parts.reduce((s, p) => s + p.detail.subtotal, 0) }, refundOwed, [o.id]);
  return {
    booking: o, kind: 'transfer',
    input: { kind: 'transfer', moveFrom: from, moveTo: to, targetListingId: t.id, targetRoomId },
    quote: { kind: 'transfer', parts: parts.map(p => ({ role: p.role, listingId: p.listingId, roomId: p.roomId, arrival: p.arrival, departure: p.departure,
                                                         policy: p.policy, transferFee: p.transferFee || 0, addOn: p.addOn || null, total: p.total, detail: p.detail })),
             transferFee, transferFeePercent: TRANSFER_FEE_PERCENT, movedValue, fromName: o.property_name, toName: moved.detail.suite, targetPolicy: t.cancellation_policy },
    oldTotal, newTotal, difference: newTotal - oldTotal, summary, couponNotReturned
  };
}

// What the guest is shown (guest-profile.js changeView).
function transferView(qc) {
  const q = qc.quote;
  const lines = [];
  for (const p of q.parts) {
    const d = p.detail;
    const where = p.role === 'move' ? d.suite : q.fromName;
    lines.push({ label: `${where}: ${niceDate(p.arrival)} – ${niceDate(p.departure)} (${plural(d.nights, 'night')})`, amount: Math.round(d.subtotal) });
    if (d.gst) lines.push({ label: '– GST', amount: d.gst });
    lines.push({ label: '– Guest service fee', amount: d.guestServiceFee });
    if (d.depositAmount) lines.push({ label: '– Refundable deposit', amount: Number(d.depositAmount) });
    if (p.addOn) lines.push({ label: '– Free cancellation add-on, as paid (kept; with its GST)', amount: p.addOn.fee + p.addOn.gst });
  }
  lines.push({ label: `Aerva transfer fee (${q.transferFeePercent}% of ${inr(q.movedValue)}, the moved nights at ${q.fromName})`, amount: q.transferFee });
  return { summary: qc.summary, lines, oldTotal: qc.oldTotal, newTotal: qc.newTotal, difference: qc.difference, couponNotReturned: qc.couponNotReturned || 0,
           transfer: { fromName: q.fromName, toName: q.toName, newPolicy: policyName(q.targetPolicy), transferFee: q.transferFee } };
}

// The payment window holds the moved nights at the other property.
function transferHolds(c) {
  const r = c.requested || {};
  return [{ listingId: Number(r.targetListingId), roomId: r.targetRoomId ? Number(r.targetRoomId) : null, arrival: r.moveFrom, departure: r.moveTo }];
}

// ---------------------------------------------------------------------
// Writes the transfer: the booking row becomes one part, new rows the
// others, all in ONE transaction. The booking is claimed first (as a
// cancellation claims it), so a transfer and a cancellation never run
// together; the database refuses nights another paid stay holds.
async function applyTransfer(sql, razorpay, change, { paymentId = null } = {}) {
  const bc = require('./_booking-changes');
  const { claimForCancellation, releaseClaim, postThreadMessage, returnValue } = require('./_cancellations');
  const o = await bc.loadBooking(sql, change.order_id);
  if (!o || o.status !== 'paid') throw userError('This booking is no longer active.', 409);
  await assertTransferable(sql, o, null, change.created_at);
  // Nights that have passed by now cannot move (the host may have answered late).
  if (String(change.requested.moveFrom) < o.todayStr) throw userError('The first night to move has already passed. Please send a new request.', 409);
  const q = change.quote;
  const parts = q.parts;
  // The booking row stays the first part at the booked property; if every
  // night moved, it becomes the moved part.
  const mainIdx = Math.max(0, parts.findIndex(p => p.role === 'keep'));
  const ids = [o.id];
  const claim = await claimForCancellation(sql, ids);
  const refundOwedFull = Number(change.difference) < 0 ? Math.round(-Number(change.difference)) : 0;
  const couponLost = await bc.couponShareOfCut(sql, o, { kind: 'stay', subtotal: parts.reduce((s, p) => s + p.detail.subtotal, 0) }, refundOwedFull, ids);
  const refundOwed = refundOwedFull - couponLost;
  const values = (p) => {
    const d = p.detail;
    const stayCommission = Number(d.baseCommission) + Number(d.amenityCommission);
    // The add-on on the row's part: in its commission and payout, as at booking.
    const a = p.addOn || { fee: 0, gst: 0, commission: 0 };
    const commission = stayCommission + Math.round(Number(a.commission) || 0);
    let releaseAt = null;
    if (Number(d.depositAmount) > 0) { const x = new Date(p.departure + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 7); releaseAt = x.toISOString().slice(0, 10); }
    return { commission, releaseAt, fee: Math.round(d.guestServiceFee + (p.transferFee || 0)), total: p.total,
             rate: d.subtotal > 0 ? Number(((stayCommission / d.subtotal) * 100).toFixed(2)) : 0, payout: Math.round(d.subtotal + (Number(a.fee) || 0) - commission) };
  };
  let newIds = [];
  try {
    const main = parts[mainIdx], mv = values(main), md = main.detail;
    const steps = [];
    // 1. The booking row becomes its part (still claimed, so step 2 can check the claim).
    steps.push(sql`
      UPDATE orders SET listing_id = ${main.listingId}, room_id = ${main.roomId}, suite_name = ${md.suite},
        arrival = ${main.arrival}, departure = ${main.departure}, nights = ${md.nights}, guests = ${md.guests},
        subtotal = ${md.subtotal}, discount_amount = ${md.discountAmount || 0}, gst = ${md.gst}, guest_service_fee = ${mv.fee},
        total = ${mv.total}, commission_rate = ${mv.rate}, commission_amount = ${mv.commission}, payout_amount = ${mv.payout},
        deposit_amount = ${md.depositAmount}, deposit_status = ${Number(md.depositAmount) > 0 ? 'held' : 'none'}, deposit_release_at = ${mv.releaseAt},
        cancellation_policy = ${main.policy}, transfer_change_id = ${change.id}
      WHERE id = ${o.id} AND status = 'paid' AND cancel_claim IS NOT DISTINCT FROM ${claim}`);
    // 2. The other parts: new rows on the same payment, copied from the booking.
    parts.forEach((p, i) => {
      if (i === mainIdx) return;
      const v = values(p), d = p.detail;
      steps.push(sql`
        INSERT INTO orders (suite_name, listing_id, room_id, guest_email, guest_id, arrival, departure, guests, nights, subtotal, discount_amount, gst, total,
          commission_rate, commission_amount, payout_amount, razorpay_order_id, razorpay_payment_id, status, guest_service_fee,
          deposit_amount, deposit_status, deposit_release_at, order_type, charge_currency, pet_types, service_animal_types, young_litter_count,
          agreement_version, agreement_accepted_at, agreement_ip, cancellation_policy, guest_first_name, guest_last_name, transfer_change_id)
        SELECT ${d.suite}, ${p.listingId}, ${p.roomId}, guest_email, guest_id, ${p.arrival}, ${p.departure}, ${d.guests}, ${d.nights}, ${d.subtotal}, ${d.discountAmount || 0}, ${d.gst}, ${v.total},
          ${v.rate}, ${v.commission}, ${v.payout}, razorpay_order_id, razorpay_payment_id, 'paid', ${v.fee},
          ${d.depositAmount}, ${Number(d.depositAmount) > 0 ? 'held' : 'none'}, ${v.releaseAt}, 'stay', charge_currency, pet_types, service_animal_types, young_litter_count,
          agreement_version, agreement_accepted_at, agreement_ip, ${p.policy}, guest_first_name, guest_last_name, ${change.id}
        FROM orders WHERE id = ${o.id} AND status = 'paid' AND cancel_claim IS NOT DISTINCT FROM ${claim}
        RETURNING id`);
    });
    // 3. The change is recorded as made — in the same transaction.
    steps.push(sql`UPDATE booking_changes SET status = 'applied', applied_at = now(), razorpay_payment_id = COALESCE(${paymentId}, razorpay_payment_id)
                   WHERE id = ${change.id} AND status IN ('pending', 'awaiting_payment') RETURNING id`);
    let res;
    try { res = await sql.transaction(steps); }
    catch (err) {
      if (err && err.code === '23P01') throw userError('Those nights are no longer available at the other property.', 409);
      throw err;
    }
    newIds = res.slice(1, -1).map(r => (r && r[0] ? Number(r[0].id) : null)).filter(Boolean);
    const appliedRow = res[res.length - 1];
    if (newIds.length !== parts.length - 1 || !appliedRow || !appliedRow.length) {
      // The claim was lost (cannot happen while it is held) or the change was already handled:
      // undo the new rows so nothing is half made.
      if (newIds.length) await sql`DELETE FROM orders WHERE id = ANY(${newIds}) AND status = 'paid'`;
      throw userError('This booking changed while the transfer was being made. Please try again.', 409);
    }
  } catch (err) {
    await releaseClaim(sql, ids, claim);
    throw err;
  }
  await releaseClaim(sql, ids, claim);

  // Everything that follows a booking row: add-ons, co-host shares, codes,
  // and Aerva credit used that no longer fits the smaller first part.
  const rowIds = parts.map((p, i) => (i === mainIdx ? o.id : newIds[i < mainIdx ? i : i - 1]));
  const { recordCohostShares } = require('./_cohosts');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], id = rowIds[i], v = values(p);
    try {
      await sql`DELETE FROM order_amenities WHERE order_id = ${id}`;
      for (const a of (p.detail.amenities || [])) {
        await sql`INSERT INTO order_amenities (order_id, listing_amenity_id, name, price_per_night, selected_dates, total_price)
                  VALUES (${id}, ${a.id || null}, ${a.name}, ${a.pricePerNight}, ${JSON.stringify(a.dates)}, ${a.total})`;
      }
    } catch (err) { console.error('transfer add-ons not written:', id, err.message); }
    try {
      if (id === o.id) {
        await sql`DELETE FROM order_cohost_shares WHERE order_id = ${id}`;
      }
      await recordCohostShares(sql, id, p.listingId, v.payout);
    } catch (err) { console.error('transfer co-host shares not written:', id, err.message); }
    if (id !== o.id) {
      try {
        const code = await require('./_confirm-booking').issueConfirmationCode(sql, id);
        if (code) await sql`UPDATE orders SET confirmation_code = ${code} WHERE id = ${id} AND confirmation_code IS NULL`;
      } catch (err) { console.error('transfer confirmation code not issued:', id, err.message); }
    }
  }
  try {
    const credit = Math.round(Number(o.fee_credit_used) || 0);
    if (credit > 0) {
      let left = credit;
      for (let i = 0; i < rowIds.length && left >= 0; i++) {
        const take = Math.min(left, parts[i].total);
        await sql`UPDATE orders SET fee_credit_used = ${take} WHERE id = ${rowIds[i]}`;
        left -= take;
      }
    }
  } catch (err) { console.error('transfer credit split not written:', err.message); }
  // Every night moved: the booking's thread now belongs to the other property.
  if (mainIdx === parts.findIndex(p => p.role === 'move')) {
    try { await sql`UPDATE conversations SET listing_id = ${parts[mainIdx].listingId} WHERE order_id = ${o.id}`; } catch (e) { /* none */ }
  }
  // A payout already sent for the booking (during the stay) is settled against it.
  let settled = { hostRecovered: 0, hostAdded: 0 };
  try { settled = await require('./_payouts').settleAfterPayout(sql, o.id, { reason: 'Booking transferred after its payout was sent' }); } catch (e) { /* none */ }

  // Less owed: held for the guest as Aerva credit (the owner's rule) — used
  // on another booking, or refunded to the original payment whenever the
  // guest asks from My Bookings; refunded automatically when it ends. A part
  // paid with earlier credit goes back onto that credit. Every movement is in
  // the credit ledger (fee_credit_entries) for the accounts.
  let heldAsCredit = 0, backOnCredit = 0, creditFailed = false, creditEnds = null;
  if (refundOwed > 0) {
    try {
      const r = await require('./_fee-credits').creditForTransfer(sql, o.id, refundOwed, {
        changeId: change.id, transferFee: q.transferFee, summary: change.summary });
      heldAsCredit = r.credit; backOnCredit = r.back; creditEnds = r.expiresAt;
    } catch (err) {
      creditFailed = true;
      console.error('transfer credit not made (needs follow-up):', change.id, err.message);
      await logAudit(sql, { action: 'booking_transfer_credit_failed', success: false, actorType: 'system', targetType: 'order', targetId: o.id,
        metadata: { changeId: change.id, refundOwed, error: String(err.message || err).slice(0, 300) } });
    }
  }
  await logAudit(sql, { action: 'booking_transfer_applied', success: true, actorType: 'system', targetType: 'order', targetId: o.id,
    metadata: { changeId: change.id, parts: rowIds, difference: change.difference, transferFee: q.transferFee, heldAsCredit, backOnCredit, couponNotReturned: couponLost, creditFailed, paymentId } });

  // Messages and emails.
  const codes = await sql`SELECT id, confirmation_code FROM orders WHERE id = ANY(${rowIds})`;
  const codeOf = new Map(codes.map(r => [Number(r.id), r.confirmation_code]));
  const partsHtml = parts.map((p, i) => `<li><strong>${esc(p.detail.suite)}</strong>: ${esc(niceDate(p.arrival))} – ${esc(niceDate(p.departure))} (${plural(p.detail.nights, 'night')})${codeOf.get(rowIds[i]) ? ` · booking ${esc(codeOf.get(rowIds[i]))}` : ''}${p.role === 'move' ? ` · ${esc(policyName(p.policy))} cancellation policy` : ''}</li>`).join('');
  const creditTotal = heldAsCredit + backOnCredit;
  const money = change.difference > 0 ? `Paid: ${inr(change.difference)} (includes Aerva's transfer fee of ${inr(q.transferFee)}).`
    : change.difference < 0 ? (creditFailed ? `${inr(refundOwed)} is being added to your Aerva credit; Aerva will follow up.`
      : `${inr(creditTotal)} is held for you as Aerva credit${creditEnds ? ` until ${new Date(creditEnds).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })}` : ''}, after Aerva's transfer fee of ${inr(q.transferFee)}${couponLost > 0 ? ` (the ${inr(couponLost)} paid by coupon is not returned)` : ''}. Use it on another booking, or have it refunded to your original payment method at any time from My Bookings.`)
    : `Aerva's transfer fee of ${inr(q.transferFee)} is covered by the price difference.`;
  for (const id of rowIds) await postThreadMessage(sql, id, 'host', `Booking transferred. ${change.summary}. ${money}`);
  await email(o.guest_email, `Your booking has been moved to ${q.toName}`,
    `<h2 style="font-family:Georgia,serif;">Your booking has been moved</h2><p>${esc(change.summary)}.</p><p>Your stay is now:</p><ul>${partsHtml}</ul><p>${esc(money)}</p>
     <p>Each part has its own booking code in My Bookings. As agreed, a transferred booking can no longer be changed, split again, shortened or cancelled. If something is not working, contact Aerva Support — Aerva will look at it and decide.</p>`);
  const host = (await sql`SELECT email FROM guests WHERE host_id = ${o.host_id} ORDER BY id LIMIT 1`)[0];
  const payNote = settled.hostRecovered > 0 ? `<p>Your payout for this booking had already been sent, so the ${inr(settled.hostRecovered)} no longer owed will be deducted from your next payout.</p>`
    : settled.hostAdded > 0 ? `<p>Your payout for this booking had already been sent, so the extra ${inr(settled.hostAdded)} (before TDS) is paid to you separately.</p>` : '';
  await email(host && host.email, `Booking transferred: ${q.fromName} → ${q.toName}`,
    `<h2 style="font-family:Georgia,serif;">A booking has been transferred</h2><p>${esc(change.summary)}.</p><ul>${partsHtml}</ul>${payNote}`);
  if (creditFailed) await email(process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in', `Transfer credit failed: booking #${o.id}`,
    `<p>Transfer #${change.id} was made, but the ${inr(refundOwed)} could not be held as the guest’s Aerva credit. Add it by hand or refund it.</p>`);
  return { ok: true, heldAsCredit: creditTotal, creditFailed, orderIds: rowIds };
}

module.exports = { LOCKED, transferOpen, payoutSent, transferWindowEndMs, TRANSFER_FEE_PERCENT, transferTargets, quoteTransfer, transferView, transferHolds, applyTransfer, cohostKey };
