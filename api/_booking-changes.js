// /api/_booking-changes.js — a guest changes a booking. Not an endpoint.
//
// WHAT CAN CHANGE: dates (move, extend, shorten), number of guests, paid
// add-ons and pets. Stays only (homes and resort rooms); an experience, or
// an experience that includes a stay, cannot be changed here.
//
// WHEN: any time before check-in, and during the stay, until 12:00 AM at the
// start of check-out day on the property's clock. During a stay check-in
// cannot move (the guest is already there) and check-out must stay at least
// tomorrow. The limit is checked when asking, when the host answers, when
// paying and when applying.
//
// HOW:
//   1. The guest sees the new price and the difference (priced by
//      _pricing.js, exactly as a new booking) and sends a request; it
//      appears in the booking's Messages thread.
//   2. The host accepts or rejects (only this change is shown).
//   3. Accepted, new total lower or equal → applied at once; the FULL
//      difference is refunded.
//      Accepted, new total higher → the guest pays the difference through
//      the same strict 90-second payment window; the change is applied only
//      when that payment is confirmed.
//   Rejected → nothing changes.
//
// NOTHING TWICE: one open change per booking (database index); every step
// moves the status forward with a guarded UPDATE, so a double click or two
// requests at once act once; applying a change claims the booking the same
// way a cancellation does, so a change and a cancellation can never run
// together; refunds go through _refunds.js (one per booking, payment and
// purpose, checked with Razorpay).

const { priceStay, priceExperience, parseMaxGuests } = require('./_pricing');
const { localMidnightMs, dateStr, takeHolds, attachHolds, releaseHolds, holdValidForConfirmation, HOLD_SECONDS } = require('./_booking-rules');
const { claimForCancellation, releaseClaim, postThreadMessage, returnCouponValue } = require('./_cancellations');
const { safeRefund, refundAcrossPayments, hasChangePayments, planRefundAcrossPayments, dropPlannedRefunds } = require('./_refunds');
const { logAudit } = require('./_audit-log');

const AWAITING_PAYMENT_HOURS = 24;
const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const niceDate = (d) => { const x = new Date(dateStr(d) + 'T00:00:00Z'); return x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };

async function email(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return;
  try {
    await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html: `<div style="font-family:sans-serif; max-width:480px;">${html}</div>` }) });
  } catch (err) { console.error('change email failed:', err.message); }
}

// ---------------------------------------------------------------------
// The booking as it is now. Three kinds:
//   'stay'       — a home or resort room;
//   'experience' — an experience on its own;
//   'pair'       — an "Includes a Stay" experience and the nights at the home
//                  that hosts it, bought as one: ALWAYS changed together. A
//                  change asked for from either half is made on the pair.
// For a pair the booking returned is the experience row, with .stayRow.
async function loadBooking(sql, orderId) {
  const load = async (id) => (await sql`
    SELECT o.*, l.property_name, l.property_type, l.host_id, l.timezone, l.max_guests, l.pet_friendly, l.max_pets_allowed,
           l.allowed_pet_types, l.pet_fee, l.listing_type, l.experience_type, l.hosting_listing_id,
           (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date AS local_today
    FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${id}`)[0];
  let o = await load(orderId);
  if (!o) return null;
  // The stay half of a pair: work on the pair through its experience.
  if ((o.order_type || 'stay') === 'stay') {
    const ex = (await sql`SELECT o2.id FROM orders o2 JOIN listings e ON e.id = o2.listing_id
                          WHERE o2.razorpay_order_id = ${o.razorpay_order_id} AND o2.id <> ${o.id} AND o2.order_type = 'experience'
                            AND e.experience_type = 'with_stay' AND e.hosting_listing_id = ${o.listing_id} AND o2.arrival = ${o.arrival}
                            AND o2.status = ${o.status} LIMIT 1`)[0];
    if (ex) o = await load(ex.id);
  }
  o.kind = (o.order_type || 'stay') === 'stay' ? 'stay' : 'experience';
  if (o.kind === 'experience' && o.experience_type === 'with_stay') {
    const st = (await sql`SELECT o2.* FROM orders o2
                          WHERE o2.razorpay_order_id = ${o.razorpay_order_id} AND o2.id <> ${o.id} AND COALESCE(o2.order_type, 'stay') = 'stay'
                            AND o2.listing_id = ${o.hosting_listing_id} AND o2.arrival = ${o.arrival} LIMIT 1`)[0];
    if (st) { o.kind = 'pair'; o.stayRow = st; }
  }
  o.arrivalStr = dateStr(o.arrival);
  o.departureStr = dateStr(o.departure);
  o.todayStr = dateStr(o.local_today);
  o.started = o.arrivalStr <= o.todayStr;
  const amenityOrder = o.kind === 'pair' ? o.stayRow.id : o.id;
  let amenities = [];
  try { amenities = await sql`SELECT listing_amenity_id FROM order_amenities WHERE order_id = ${amenityOrder}`; } catch (e) { /* none */ }
  o.amenityIds = amenities.map(a => Number(a.listing_amenity_id)).filter(Boolean);
  o.totalNow = Number(o.total) + (o.stayRow ? Number(o.stayRow.total) : 0);
  return o;
}

// A fresh quote still matches the saved change. Compared in whole rupees
// on both sides (the columns are integers; a deposit may have paise).
function sameTotals(fresh, saved) {
  return Math.round(Number(fresh.newTotal)) === Math.round(Number(saved.new_total))
    && Math.round(Number(fresh.oldTotal)) === Math.round(Number(saved.old_total));
}

// Midnight at the start of check-out day (for an experience, its last day),
// on the property's clock.
function beforeCutoff(o) {
  return Date.now() < localMidnightMs(o.departureStr, o.timezone);
}

async function assertChangeable(sql, o, guestId) {
  if (!o || (guestId != null && o.guest_id !== guestId)) throw userError('Booking not found.', 404);
  if (o.status !== 'paid' || (o.stayRow && o.stayRow.status !== 'paid')) throw userError('Only a confirmed booking can be changed.');
  if ((o.charge_currency || 'INR') !== 'INR') throw userError('This booking cannot be changed online. Please write to hello@aerva.in.');
  if (!beforeCutoff(o)) throw userError('Changes are no longer possible — the last moment was midnight at the start of your check-out day.');
}

// What the change screen offers: the booking now and what can change.
async function changeOptions(sql, orderId, guestId) {
  const o = await loadBooking(sql, orderId);
  await assertChangeable(sql, o, guestId);
  const open = (await sql`SELECT id, status, summary, difference FROM booking_changes WHERE order_id = ${o.id} AND status IN ('pending', 'awaiting_payment') LIMIT 1`)[0] || null;
  let amenities = [];
  if (o.kind === 'stay') {
    try { amenities = await sql`SELECT id, name, price FROM listing_amenities WHERE listing_id = ${o.listing_id} AND is_active = TRUE ORDER BY created_at`; } catch (e) { /* none */ }
  }
  return {
    orderId: o.id, kind: o.kind, listing: o.property_name, started: o.started, today: o.todayStr,
    current: {
      arrival: o.arrivalStr, departure: o.departureStr, guests: o.guests,
      pets: Array.isArray(o.pet_types) ? o.pet_types.length : 0, petTypes: Array.isArray(o.pet_types) ? o.pet_types : [],
      amenityIds: o.amenityIds, total: o.totalNow
    },
    limits: o.kind === 'stay' ? {
      // max_guests is text ("3–4", "12+"): the highest number is the cap.
      maxGuests: parseMaxGuests(o.max_guests) > 0 ? parseMaxGuests(o.max_guests) : null,
      petFriendly: o.pet_friendly === true, maxPets: o.max_pets_allowed != null ? Number(o.max_pets_allowed) : null,
      petTypes: Array.isArray(o.allowed_pet_types) ? o.allowed_pet_types : [], petFee: Number(o.pet_fee) || 0,
      amenities: amenities.map(a => ({ id: a.id, name: a.name, price: Number(a.price) }))
    } : { maxGuests: null, petFriendly: false, maxPets: 0, petTypes: [], petFee: 0, amenities: [] },
    openChange: open
  };
}

// Prices the requested booking. input: { arrival (the date, for an
// experience), departure (stays only), adults, children, infants, pets,
// petTypes, amenityIds }.
async function quoteChange(sql, orderId, guestId, input) {
  const o = await loadBooking(sql, orderId);
  await assertChangeable(sql, o, guestId);
  const arrival = o.started ? o.arrivalStr : String(input.arrival || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arrival)) throw userError('Choose your new date.');
  if (o.started && input.arrival && String(input.arrival).slice(0, 10) !== o.arrivalStr) throw userError('You have already checked in, so check-in cannot move. You can still change check-out, guests and add-ons.');
  if (!o.started && arrival < o.todayStr) throw userError('The date cannot be in the past.');
  const adults = Math.max(0, Math.floor(Number(input.adults) || 0));
  const children = Math.max(0, Math.floor(Number(input.children) || 0));
  const guests = adults + children;
  const keep = o.started && arrival === o.arrivalStr;
  const parts = [];

  if (o.kind !== 'stay') {
    // Experience (and, for a pair, the nights that come with it): the date
    // and the number of guests can change.
    const xp = await priceExperience(sql, { listingId: o.listing_id, date: arrival, guests: guests || 1, keepDate: keep }, 0);
    if (xp.error) throw userError(xp.error.replace(/^Experience 1: /, ''));
    const x = xp.detail;
    let st = null;
    if (o.kind === 'pair') {
      const sp = await priceStay(sql, { listingId: o.hosting_listing_id, roomId: null, arrival, departure: x.endDate, guests: x.guests, adults: Math.max(1, adults),
        pets: 0, petTypes: [], serviceAnimals: [], youngLitterCount: 0, selectedAmenities: [], includedWithExperienceId: o.listing_id, keepArrival: keep },
        0, { excludeOrderId: o.stayRow.id });
      if (sp.error) throw userError(sp.error.replace(/^Stay 1: /, ''));
      st = sp.detail;
    }
    // Whole rupees, as stored (a listing's deposit may have paise).
    const newTotal = Math.round(x.subtotal + x.gst + x.guestServiceFee + (st ? st.subtotal + st.gst + st.guestServiceFee + Number(st.depositAmount) : 0));
    if (arrival !== o.arrivalStr) parts.push(`Date: ${niceDate(o.arrivalStr)} → ${niceDate(arrival)}${o.kind === 'pair' ? ' (with the included stay)' : ''}`);
    if (x.guests !== Number(o.guests)) parts.push(`Guests: ${o.guests} → ${x.guests}`);
    return { booking: o, kind: o.kind,
             input: { arrival, departure: x.endDate, adults, children, infants: Math.max(0, Math.floor(Number(input.infants) || 0)), pets: 0, petTypes: [], amenityIds: [] },
             quote: { kind: o.kind, experience: x, stay: st, stayOrderId: o.stayRow ? o.stayRow.id : null },
             oldTotal: o.totalNow, newTotal, difference: newTotal - o.totalNow, summary: parts.join('; ') };
  }

  const departure = String(input.departure || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(departure)) throw userError('Choose your new dates.');
  if (departure <= arrival) throw userError('Check-out must be after check-in.');
  if (departure <= o.todayStr) throw userError('Check-out must be tomorrow or later.');
  const nights = [];
  for (let d = new Date(arrival + 'T00:00:00Z'); d < new Date(departure + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) nights.push(d.toISOString().slice(0, 10));
  const amenityIds = [...new Set((Array.isArray(input.amenityIds) ? input.amenityIds : []).map(Number).filter(Boolean))];
  const s = {
    listingId: o.listing_id, roomId: o.room_id || null, arrival, departure, guests, adults, keepArrival: keep,
    pets: Math.max(0, Math.floor(Number(input.pets) || 0)), petTypes: Array.isArray(input.petTypes) ? input.petTypes : [],
    serviceAnimals: Array.isArray(o.service_animal_types) ? o.service_animal_types : [], youngLitterCount: 0,
    selectedAmenities: amenityIds.map(id => ({ amenityId: id, dates: nights }))
  };
  const priced = await priceStay(sql, s, 0, { excludeOrderId: o.id });
  if (priced.error) throw userError(priced.error.replace(/^Stay 1: /, ''));
  const q = priced.detail;
  // Whole rupees, as stored (a listing's deposit may have paise).
  const newTotal = Math.round(q.subtotal + q.gst + q.guestServiceFee + Number(q.depositAmount));
  if (arrival !== o.arrivalStr || departure !== o.departureStr) parts.push(`Dates: ${niceDate(o.arrivalStr)} – ${niceDate(o.departureStr)} → ${niceDate(arrival)} – ${niceDate(departure)}`);
  if (guests !== Number(o.guests)) parts.push(`Guests: ${o.guests} → ${guests}`);
  const oldPets = Array.isArray(o.pet_types) ? o.pet_types.length : 0;
  if (s.pets !== oldPets) parts.push(`Pets: ${oldPets} → ${s.pets}`);
  const added = q.amenities.filter(a => !o.amenityIds.includes(Number(a.id))).map(a => a.name);
  const removed = o.amenityIds.filter(id => !amenityIds.includes(id)).length;
  if (added.length) parts.push(`Added: ${added.join(', ')}`);
  if (removed) parts.push(`Removed ${removed} add-on${removed === 1 ? '' : 's'}`);
  return { booking: o, kind: 'stay', input: { arrival, departure, adults, children, infants: Math.max(0, Math.floor(Number(input.infants) || 0)), pets: s.pets, petTypes: s.petTypes, amenityIds },
           quote: Object.assign({ kind: 'stay' }, q), oldTotal: o.totalNow, newTotal, difference: newTotal - o.totalNow, summary: parts.join('; ') };
}

// ---------------------------------------------------------------------
// The guest asks.
async function requestChange(sql, { orderId, guestId, input }) {
  const qc = await quoteChange(sql, orderId, guestId, input);
  if (!qc.summary) throw userError('Nothing has changed yet — choose new dates, guests or add-ons.');
  let row;
  try {
    row = (await sql`INSERT INTO booking_changes (order_id, guest_id, requested, quote, old_total, new_total, difference, summary)
                     VALUES (${qc.booking.id}, ${guestId}, ${JSON.stringify(qc.input)}, ${JSON.stringify(qc.quote)}, ${qc.oldTotal}, ${qc.newTotal}, ${qc.difference}, ${qc.summary})
                     RETURNING *`)[0];
  } catch (err) {
    if (/idx_booking_changes_open|duplicate key/.test(err.message)) throw userError('You already have a change waiting for your host.', 409);
    throw err;
  }
  const o = qc.booking;
  await logAudit(sql, { action: 'booking_change_requested', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'order', targetId: orderId,
    metadata: { changeId: row.id, difference: qc.difference, summary: qc.summary } });
  const money = qc.difference > 0 ? `I will pay the difference of ${inr(qc.difference)}.` : qc.difference < 0 ? `The new total is ${inr(-qc.difference)} lower.` : 'The total stays the same.';
  await postThreadMessage(sql, orderId, 'guest', `I’d like to change this booking. ${qc.summary}. ${money}`);
  const host = (await sql`SELECT email FROM guests WHERE host_id = ${o.host_id} ORDER BY id LIMIT 1`)[0];
  await email(host && host.email, `Change request for ${o.property_name}`,
    `<h2 style="font-family:Georgia,serif;">A guest has asked to change a booking</h2><p><strong>${esc(o.property_name)}</strong></p><p>${esc(qc.summary)}</p>
     <p>Please accept or reject it in Messages.</p><p><a href="https://aerva.in/index.html?view=messages" style="color:#8a6c39;">Open Messages</a></p>`);
  return row;
}

async function withdrawChange(sql, { changeId, guestId }) {
  const r = await sql`UPDATE booking_changes SET status = 'withdrawn', decided_at = now()
                      WHERE id = ${changeId} AND guest_id = ${guestId} AND status IN ('pending', 'awaiting_payment') RETURNING order_id, razorpay_order_id`;
  if (!r.length) throw userError('This change can no longer be withdrawn.', 409);
  if (r[0].razorpay_order_id) await releaseHolds(sql, { razorpayOrderId: r[0].razorpay_order_id, reason: 'closed' });
  await postThreadMessage(sql, r[0].order_id, 'guest', 'I have withdrawn my change request.');
  return { ok: true };
}

// ---------------------------------------------------------------------
// Writes the change onto the booking. The booking is claimed first (as a
// cancellation claims it), so a change and a cancellation can never run
// together. The database refuses the new dates if another paid stay holds
// them (orders_no_double_booking).
async function applyChange(sql, razorpay, change, { paymentId = null } = {}) {
  const o = await loadBooking(sql, change.order_id);
  if (!o || o.status !== 'paid') throw userError('This booking is no longer active.', 409);
  if (!beforeCutoff(o)) throw userError('Changes are no longer possible — the last moment was midnight at the start of check-out day.');
  const q = change.quote;
  const input = change.requested;
  const ids = [o.id].concat(o.stayRow ? [o.stayRow.id] : []);
  const claim = await claimForCancellation(sql, ids);
  const refundOwed = Number(change.difference) < 0 ? Math.round(-Number(change.difference)) : 0;
  const kindBase = `change-${change.id}`;
  // The values one stay row takes from a priced stay detail.
  const stayValues = (d) => {
    const commission = Number(d.baseCommission) + Number(d.amenityCommission);
    let releaseAt = null;
    if (d.depositAmount > 0) { const x = new Date(input.departure + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 7); releaseAt = x.toISOString().slice(0, 10); }
    return { commission, releaseAt, total: Math.round(d.subtotal + d.gst + d.guestServiceFee + Number(d.depositAmount)),
             rate: d.subtotal > 0 ? Number(((commission / d.subtotal) * 100).toFixed(2)) : 0 };
  };
  // What follows the stay row itself: its add-ons and co-host shares.
  const afterStay = async (orderId, d, commission) => {
    try {
      await sql`DELETE FROM order_amenities WHERE order_id = ${orderId}`;
      for (const a of (d.amenities || [])) {
        await sql`INSERT INTO order_amenities (order_id, listing_amenity_id, name, price_per_night, selected_dates, total_price)
                  VALUES (${orderId}, ${a.id || null}, ${a.name}, ${a.pricePerNight}, ${JSON.stringify(a.dates)}, ${a.total})`;
      }
    } catch (err) { console.error('order_amenities not updated:', err.message); }
    try { await sql`UPDATE order_cohost_shares SET amount = round(${d.subtotal - commission}::numeric * percent / 100) WHERE order_id = ${orderId}`; } catch (e) { /* none */ }
  };
  let plan = null;
  try {
    // Lower total: the refund owed is written down BEFORE the booking
    // changes (refunds rows, _refunds.js). If anything stops after the
    // change is made, the refund is still on record for Admin → Refunds.
    if (refundOwed > 0) {
      plan = await planRefundAcrossPayments(sql, razorpay, { orderId: o.id, amountInr: refundOwed, kindBase });
      await logAudit(sql, { action: 'booking_change_refund_planned', success: true, actorType: 'system', targetType: 'order', targetId: o.id,
        metadata: { changeId: change.id, refundOwed, cashPlanned: plan.plannedInr, couponPart: plan.shortfallInr } });
    }
    try {
      if (q.kind === 'pair') {
        // Both halves in ONE statement: either both change or neither does.
        // The nights are the part another booking could have taken
        // (orders_no_double_booking); if they are gone, nothing changes.
        const d = q.stay, x = q.experience, v = stayValues(d);
        const up = (await sql`
          WITH ok AS (SELECT count(*) = 2 AS ok FROM orders WHERE id IN (${q.stayOrderId}, ${o.id}) AND status = 'paid' AND cancel_claim IS NOT DISTINCT FROM ${claim}),
          s AS (
            UPDATE orders SET arrival = ${input.arrival}, departure = ${input.departure}, nights = ${d.nights}, guests = ${d.guests},
              subtotal = ${d.subtotal}, discount_amount = ${d.discountAmount || 0}, gst = ${d.gst}, guest_service_fee = ${d.guestServiceFee},
              total = ${v.total}, commission_rate = ${v.rate}, commission_amount = ${v.commission}, payout_amount = ${d.subtotal - v.commission},
              deposit_amount = ${d.depositAmount}, deposit_status = ${d.depositAmount > 0 ? 'held' : 'none'}, deposit_release_at = ${v.releaseAt},
              pet_types = ${JSON.stringify(d.petTypes || [])}, service_animal_types = ${JSON.stringify(d.serviceAnimals || [])}, young_litter_count = ${Number(d.youngLitterCount) || 0},
              cancel_claim = NULL, cancel_claimed_at = NULL
            WHERE id = ${q.stayOrderId} AND status = 'paid' AND cancel_claim IS NOT DISTINCT FROM ${claim} AND (SELECT ok FROM ok)
            RETURNING id),
          e AS (
            UPDATE orders SET arrival = ${x.date}, departure = ${x.endDate}, nights = ${x.durationDays}, guests = ${x.guests},
              subtotal = ${x.subtotal}, gst = ${x.gst}, guest_service_fee = ${x.guestServiceFee}, total = ${Math.round(x.subtotal + x.gst + x.guestServiceFee)},
              commission_rate = ${x.commissionRate}, commission_amount = ${x.commissionAmount}, payout_amount = ${x.subtotal - x.commissionAmount},
              cancel_claim = NULL, cancel_claimed_at = NULL
            WHERE id = ${o.id} AND status = 'paid' AND cancel_claim IS NOT DISTINCT FROM ${claim} AND (SELECT ok FROM ok)
            RETURNING id)
          SELECT (SELECT count(*) FROM s)::int AS s, (SELECT count(*) FROM e)::int AS e`)[0];
        if (!up || (up.s === 0 && up.e === 0)) throw userError('This booking changed while the change was being made. Please try again.', 409);
        if (up.s !== 1 || up.e !== 1) {
          // Cannot happen while the claim is held; recorded loudly if it ever does.
          await logAudit(sql, { action: 'booking_change_half_applied', success: false, actorType: 'system', targetType: 'order', targetId: o.id,
            metadata: { changeId: change.id, stayUpdated: up.s, experienceUpdated: up.e } });
        }
        await afterStay(q.stayOrderId, d, v.commission);
        try { await sql`UPDATE order_cohost_shares SET amount = round(${x.subtotal - x.commissionAmount}::numeric * percent / 100) WHERE order_id = ${o.id}`; } catch (e) { /* none */ }
      } else if (q.kind === 'experience') {
        const x = q.experience;
        const up = await sql`
          UPDATE orders SET arrival = ${x.date}, departure = ${x.endDate}, nights = ${x.durationDays}, guests = ${x.guests},
            subtotal = ${x.subtotal}, gst = ${x.gst}, guest_service_fee = ${x.guestServiceFee}, total = ${Math.round(x.subtotal + x.gst + x.guestServiceFee)},
            commission_rate = ${x.commissionRate}, commission_amount = ${x.commissionAmount}, payout_amount = ${x.subtotal - x.commissionAmount},
            cancel_claim = NULL, cancel_claimed_at = NULL
          WHERE id = ${o.id} AND status = 'paid' AND cancel_claim IS NOT DISTINCT FROM ${claim}
          RETURNING id`;
        if (!up.length) throw userError('This booking changed while the change was being made. Please try again.', 409);
        try { await sql`UPDATE order_cohost_shares SET amount = round(${x.subtotal - x.commissionAmount}::numeric * percent / 100) WHERE order_id = ${o.id}`; } catch (e) { /* none */ }
      } else {
        const d = q, v = stayValues(d);
        const up = await sql`
          UPDATE orders SET arrival = ${input.arrival}, departure = ${input.departure}, nights = ${d.nights}, guests = ${d.guests},
            subtotal = ${d.subtotal}, discount_amount = ${d.discountAmount || 0}, gst = ${d.gst}, guest_service_fee = ${d.guestServiceFee},
            total = ${v.total}, commission_rate = ${v.rate}, commission_amount = ${v.commission}, payout_amount = ${d.subtotal - v.commission},
            deposit_amount = ${d.depositAmount}, deposit_status = ${d.depositAmount > 0 ? 'held' : 'none'}, deposit_release_at = ${v.releaseAt},
            pet_types = ${JSON.stringify(d.petTypes || [])}, service_animal_types = ${JSON.stringify(d.serviceAnimals || [])}, young_litter_count = ${Number(d.youngLitterCount) || 0},
            cancel_claim = NULL, cancel_claimed_at = NULL
          WHERE id = ${o.id} AND status = 'paid' AND cancel_claim IS NOT DISTINCT FROM ${claim}
          RETURNING id`;
        if (!up.length) throw userError('This booking changed while the change was being made. Please try again.', 409);
        await afterStay(o.id, d, v.commission);
      }
    } catch (err) {
      if (err && err.code === '23P01') throw userError('The new dates are no longer available.', 409);
      throw err;
    }
    const applied = await sql`UPDATE booking_changes SET status = 'applied', applied_at = now(), razorpay_payment_id = COALESCE(${paymentId}, razorpay_payment_id)
                              WHERE id = ${change.id} AND status IN ('pending', 'awaiting_payment') RETURNING id`;
    if (!applied.length) throw userError('This change has already been handled.', 409);
  } catch (err) {
    await releaseClaim(sql, ids, claim);
    // The change was not made: the refund written down for it is not owed.
    if (plan) await dropPlannedRefunds(sql, { orderId: o.id, kindBase });
    throw err;
  }
  await releaseClaim(sql, ids, claim);

  // Lower total: the full difference back — in cash as far as the booking's
  // payments allow, the rest (a part that was paid by coupon) as a coupon.
  // A refund that fails now stays on record as failed in Admin → Refunds.
  let refundedInr = 0, couponBack = 0, refundFailed = false;
  if (refundOwed > 0) {
    try {
      const r = await refundAcrossPayments(sql, razorpay, { orderId: o.id, amountInr: refundOwed, kindBase });
      refundedInr = r.refundedInr;
      couponBack = r.shortfallInr;
    } catch (err) {
      refundFailed = true;
      couponBack = plan ? plan.shortfallInr : 0;
      refundedInr = refundOwed - couponBack;
      console.error('change refund failed (Admin → Refunds can retry):', change.id, err.message);
      await logAudit(sql, { action: 'booking_change_refund_failed', success: false, actorType: 'system', targetType: 'order', targetId: o.id,
        metadata: { changeId: change.id, refundOwed, error: String(err.message || err).slice(0, 300) } });
    }
    if (couponBack > 0) await returnCouponValue(sql, { razorpayOrderId: o.razorpay_order_id, amount: couponBack, sourceOrderId: o.id, guestEmail: o.guest_email, suiteName: o.suite_name });
  }
  await logAudit(sql, { action: 'booking_change_applied', success: true, actorType: 'system', targetType: 'order', targetId: o.id,
    metadata: { changeId: change.id, difference: change.difference, refundedInr, couponBack, refundFailed, paymentId, summary: change.summary } });
  const money = change.difference > 0 ? `Paid: ${inr(change.difference)}.`
    : change.difference < 0 ? `Refund: ${inr(refundedInr)}${couponBack ? ` plus ${inr(couponBack)} as a coupon` : ''}.${refundFailed ? ' The refund is delayed; Aerva is sending it and will follow up.' : ''}` : '';
  await postThreadMessage(sql, o.id, 'host', `Booking changed. ${change.summary}. ${money}`.trim());
  const host = (await sql`SELECT email FROM guests WHERE host_id = ${o.host_id} ORDER BY id LIMIT 1`)[0];
  const body = `<p><strong>${esc(o.property_name)}</strong></p><p>${esc(change.summary)}</p><p>New ${o.kind === 'stay' ? 'dates' : 'date'}: ${esc(niceDate(input.arrival))}${o.kind === 'stay' ? ' – ' + esc(niceDate(input.departure)) : ''}</p>`;
  await email(o.guest_email, `Your booking at ${o.property_name} has been changed`, `<h2 style="font-family:Georgia,serif;">Your booking has been changed</h2>${body}${money ? `<p>${esc(money)}</p>` : ''}`);
  await email(host && host.email, `Booking changed: ${o.property_name}`, `<h2 style="font-family:Georgia,serif;">A booking has been changed</h2>${body}`);
  if (refundFailed) await email(process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in', `Change refund failed: booking #${o.id}`, `<p>Change #${change.id} was applied, but the refund of ${inr(refundOwed - couponBack)} failed. Retry it in Admin → Refunds.</p>`);
  return { ok: true, refundedInr, couponBack, refundFailed };
}

// ---------------------------------------------------------------------
// The host answers. Only this change is shown to them.
async function respondChange(sql, razorpay, { changeId, accept, hostId, accountId, note = '' }) {
  const c = (await sql`SELECT c.*, l.host_id FROM booking_changes c JOIN orders o ON o.id = c.order_id JOIN listings l ON l.id = o.listing_id WHERE c.id = ${changeId}`)[0];
  if (!c || c.host_id !== hostId) throw userError('Change not found.', 404);
  // Answered once: claimed by stamping decided_at while pending.
  const mine = await sql`UPDATE booking_changes SET decided_at = now(), decided_by = ${accountId}, note = ${note || null}
                         WHERE id = ${changeId} AND status = 'pending' AND decided_at IS NULL RETURNING *`;
  if (!mine.length) throw userError('This change has already been answered.', 409);
  const change = mine[0];
  const o = await loadBooking(sql, change.order_id);
  const guestTo = o && o.guest_email;
  if (accept !== true) {
    await sql`UPDATE booking_changes SET status = 'declined' WHERE id = ${changeId}`;
    await postThreadMessage(sql, change.order_id, 'host', `Change request declined. Your booking stays as it was.${note ? ' ' + note : ''}`);
    await email(guestTo, `Your change request for ${o.property_name}`, `<h2 style="font-family:Georgia,serif;">Your change request was declined</h2><p>Your booking at <strong>${esc(o.property_name)}</strong> stays as it was.</p>${note ? `<p><strong>Host’s note:</strong> ${esc(note)}</p>` : ''}`);
    return { accepted: false };
  }
  // Re-priced now: if anything moved since the guest asked, the guest asks again.
  let fresh;
  try { fresh = await quoteChange(sql, change.order_id, null, change.requested); }
  catch (err) {
    await sql`UPDATE booking_changes SET status = 'expired' WHERE id = ${changeId}`;
    await postThreadMessage(sql, change.order_id, 'host', `This change can no longer be made (${err.message}). Please send a new request if you still need it.`);
    throw userError(`This change can no longer be made: ${err.message}`, 409);
  }
  if (!sameTotals(fresh, change)) {
    await sql`UPDATE booking_changes SET status = 'expired' WHERE id = ${changeId}`;
    await postThreadMessage(sql, change.order_id, 'host', 'Prices have changed since this request was sent, so it has closed. Please send a new change request to see the new price.');
    throw userError('Prices have changed since the guest asked, so this request has closed. The guest has been asked to send a new one.', 409);
  }
  if (change.difference <= 0) {
    try { return { accepted: true, applied: true, ...(await applyChange(sql, razorpay, change)) }; }
    catch (err) { await sql`UPDATE booking_changes SET status = 'failed' WHERE id = ${changeId} AND status = 'pending'`; throw err; }
  }
  await sql`UPDATE booking_changes SET status = 'awaiting_payment', accepted_at = now() WHERE id = ${changeId} AND status = 'pending'`;
  await postThreadMessage(sql, change.order_id, 'host', `Change accepted. To confirm it, please pay the difference of ${inr(change.difference)} within ${AWAITING_PAYMENT_HOURS} hours (My Bookings).`);
  await email(guestTo, `Your change was accepted — pay ${inr(change.difference)} to confirm`,
    `<h2 style="font-family:Georgia,serif;">Your change was accepted</h2><p><strong>${esc(o.property_name)}</strong></p><p>${esc(change.summary)}</p>
     <p>To confirm it, pay the difference of <strong>${inr(change.difference)}</strong> in My Bookings within ${AWAITING_PAYMENT_HOURS} hours. Until then your booking stays as it was.</p>
     <p><a href="https://aerva.in/index.html?view=my-bookings" style="color:#8a6c39;">Open My Bookings</a></p>`);
  return { accepted: true, applied: false, awaitingPayment: change.difference };
}

// ---------------------------------------------------------------------
// The guest pays the difference: same strict 90-second window as a booking.
async function startChangePayment(sql, razorpay, { changeId, guestId, ip }) {
  const c = (await sql`SELECT * FROM booking_changes WHERE id = ${changeId}`)[0];
  if (!c || c.guest_id !== guestId) throw userError('Change not found.', 404);
  if (c.status !== 'awaiting_payment') throw userError('This change is not waiting for payment.', 409);
  if (c.accepted_at && Date.now() - new Date(c.accepted_at).getTime() > AWAITING_PAYMENT_HOURS * 3600e3) {
    await sql`UPDATE booking_changes SET status = 'expired' WHERE id = ${changeId} AND status = 'awaiting_payment'`;
    throw userError(`The ${AWAITING_PAYMENT_HOURS} hours to pay for this change have passed. Please send a new change request.`, 409);
  }
  const fresh = await quoteChange(sql, c.order_id, guestId, c.requested);
  if (!sameTotals(fresh, c)) {
    await sql`UPDATE booking_changes SET status = 'expired' WHERE id = ${changeId} AND status = 'awaiting_payment'`;
    throw userError('Prices have been changed recently, so this change has closed. Please send a new change request to see the new price.', 409);
  }
  const o = fresh.booking;
  // The payment window holds the nights (a stay, or the stay of a pair).
  // An experience on its own is not date-exclusive, as at checkout.
  const holdStays = o.kind === 'stay' ? [{ listingId: o.listing_id, roomId: o.room_id, arrival: c.requested.arrival, departure: c.requested.departure }]
    : o.kind === 'pair' ? [{ listingId: o.hosting_listing_id, roomId: null, arrival: c.requested.arrival, departure: c.requested.departure }] : [];
  const held = await takeHolds(sql, holdStays, { guestKey: 'g:' + guestId, ip });
  let order;
  try {
    order = await razorpay.orders.create({
      amount: c.difference * 100, currency: 'INR', receipt: `aerva_change_${c.id}_${Date.now()}`,
      notes: { type: 'booking_change', changeId: String(c.id), orderId: String(o.id), email: o.guest_email, guestId: String(guestId), held: held.ids.length ? '1' : '' }
    });
  } catch (err) { await releaseHolds(sql, { ids: held.ids, reason: 'error' }); throw err; }
  await attachHolds(sql, held.ids, order.id);
  await sql`UPDATE booking_changes SET razorpay_order_id = ${order.id} WHERE id = ${c.id}`;
  await logAudit(sql, { action: 'booking_change_order_created', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'order', targetId: o.id,
    metadata: { razorpayOrderId: order.id, changeId: c.id, amount: c.difference } });
  return { orderId: order.id, amount: order.amount, currency: 'INR', holdSeconds: held.ids.length ? HOLD_SECONDS : null, description: `Change to ${o.property_name}` };
}

// Called by _confirm-booking.js for a payment whose order is a change.
// The payment has already been confirmed as captured and claimed once.
async function confirmChangePayment(sql, razorpay, { order, payment, razorpayOrderId, razorpayPaymentId }) {
  const changeId = Number(order.notes.changeId);
  const c = (await sql`SELECT * FROM booking_changes WHERE id = ${changeId}`)[0];
  const refundNow = async (reason) => {
    const orderId = c ? c.order_id : (Number(order.notes && order.notes.orderId) || null);
    const o = orderId ? (await sql`SELECT id FROM orders WHERE id = ${orderId}`)[0] : null;
    const kind = `change-pay-${changeId}`;
    let refunded = false, error = null;
    if (o) {
      try {
        await safeRefund(sql, razorpay, { orderId: o.id, paymentId: razorpayPaymentId, amountSubunit: Number(payment.amount), kind });
        refunded = true;
      } catch (e) {
        error = String(e.message || e).slice(0, 300);
        console.error('change refund failed (Admin → Refunds can retry):', error);
        // safeRefund leaves its row as failed; if it could not even write
        // one, it is written here, so Admin → Refunds always shows it.
        try {
          await sql`INSERT INTO refunds (order_id, kind, razorpay_payment_id, amount, status, failure_reason)
                    VALUES (${o.id}, ${kind}, ${razorpayPaymentId}, ${Math.round(Number(payment.amount))}, 'failed', ${error})
                    ON CONFLICT (order_id, kind) DO NOTHING`;
        } catch (e2) { console.error('failed change refund not recorded:', e2.message); }
      }
    } else error = 'No booking found for this change payment.';
    if (c) await sql`UPDATE booking_changes SET status = 'failed', razorpay_payment_id = ${razorpayPaymentId} WHERE id = ${changeId} AND status = 'awaiting_payment'`;
    await releaseHolds(sql, { razorpayOrderId, reason: 'conflict' });
    await logAudit(sql, { action: refunded ? 'booking_change_payment_refunded' : 'booking_change_payment_refund_failed', success: refunded, actorType: 'system',
      targetType: 'order', targetId: orderId, metadata: { changeId, reason, razorpayPaymentId, amount: Number(payment.amount), error } });
    if (!refunded) await email(process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in', `Change payment refund failed: ${razorpayPaymentId}`,
      `<p>Change #${changeId} was not made and its payment (${esc(razorpayPaymentId)}) could not be refunded automatically: ${esc(error)}</p><p>Retry it in Admin → Refunds.</p>`);
    const how = refunded ? 'your payment is being refunded in full.' : 'your payment will be refunded in full. The refund is delayed; Aerva has been alerted and will follow up.';
    if (c) await postThreadMessage(sql, c.order_id, 'host', `The change was not made: ${reason} ${refunded ? 'The payment is being refunded in full.' : 'The payment will be refunded in full; the refund is delayed and Aerva is following up.'}`);
    return { status: 'conflict', message: `${reason} The change was not made, and ${how}` };
  };
  if (!c || c.status !== 'awaiting_payment') return refundNow('This change was no longer waiting for payment.');
  // Amount paid must equal the difference, and prices must not have moved.
  if (Number(payment.amount) !== Number(order.amount) || Number(order.amount) !== c.difference * 100) {
    return scheduleChangeRefund(sql, { c, razorpayOrderId, razorpayPaymentId, amountInr: Math.round(Number(payment.amount) / 100), reason: 'The amount paid did not match the amount due for this change.', holdReason: 'error' });
  }
  let fresh;
  try { fresh = await quoteChange(sql, c.order_id, null, c.requested); }
  catch (err) { return refundNow(err.message); }
  if (!sameTotals(fresh, c)) {
    return scheduleChangeRefund(sql, { c, razorpayOrderId, razorpayPaymentId, amountInr: c.difference, reason: 'The price changed while the payment was being made, so the amount paid no longer matches.', holdReason: 'price_changed' });
  }
  const win = await holdValidForConfirmation(sql, razorpayOrderId, { heldAtCheckout: order.notes.held === '1' });
  if (!win.ok) return refundNow(win.reason);
  try {
    await applyChange(sql, razorpay, c, { paymentId: razorpayPaymentId });
  } catch (err) {
    return refundNow(err.isUserFacing ? err.message : 'The change could not be applied.');
  }
  await releaseHolds(sql, { razorpayOrderId, reason: 'paid' });
  return { status: 'confirmed', change: true };
}

async function scheduleChangeRefund(sql, { c, razorpayOrderId, razorpayPaymentId, amountInr, reason, holdReason = 'conflict' }) {
  try {
    await sql`INSERT INTO scheduled_refunds (razorpay_order_id, razorpay_payment_id, order_ids, charge_currency, amount_inr, reason, due_at, refund_kind)
              VALUES (${razorpayOrderId}, ${razorpayPaymentId}, ${[c.order_id]}, 'INR', ${amountInr}, ${reason}, now() + interval '1 day', ${'change-pay-' + c.id})
              ON CONFLICT (razorpay_order_id) DO NOTHING`;
  } catch (err) { console.error('change refund not scheduled:', err.message); }
  await sql`UPDATE booking_changes SET status = 'failed', razorpay_payment_id = ${razorpayPaymentId} WHERE id = ${c.id} AND status = 'awaiting_payment'`;
  await releaseHolds(sql, { razorpayOrderId, reason: holdReason });
  await postThreadMessage(sql, c.order_id, 'host', `The change was not made: ${reason} The payment will be refunded in full tomorrow.`);
  return { status: 'conflict', message: `${reason} The change was not made, and ${inr(amountInr)} will be refunded in full tomorrow.` };
}

// ---------------------------------------------------------------------
// For the thread card and My Bookings: the open change on a booking.
async function openChangeFor(sql, orderId) {
  try {
    return (await sql`SELECT id, status, summary, difference, old_total, new_total, created_at, accepted_at FROM booking_changes
                      WHERE order_id = ${orderId} AND status IN ('pending', 'awaiting_payment') ORDER BY id DESC LIMIT 1`)[0] || null;
  } catch (e) { return null; }
}

// Scheduler: close changes that can no longer happen (check-out day has
// begun, or 24 hours to pay have passed). Returns guests affected.
async function expireChanges(sql) {
  const out = { expired: 0 };
  let rows = [];
  try {
    rows = await sql`SELECT c.id, c.order_id, c.status, c.accepted_at, o.departure, l.timezone, c.razorpay_order_id
                     FROM booking_changes c JOIN orders o ON o.id = c.order_id JOIN listings l ON l.id = o.listing_id
                     WHERE c.status IN ('pending', 'awaiting_payment') LIMIT 200`;
  } catch (e) { return { ...out, skipped: 'table not ready' }; }
  for (const r of rows) {
    const pastCutoff = Date.now() >= localMidnightMs(dateStr(r.departure), r.timezone);
    const payLapsed = r.status === 'awaiting_payment' && r.accepted_at && Date.now() - new Date(r.accepted_at).getTime() > AWAITING_PAYMENT_HOURS * 3600e3;
    if (!pastCutoff && !payLapsed) continue;
    const done = await sql`UPDATE booking_changes SET status = 'expired' WHERE id = ${r.id} AND status = ${r.status} RETURNING id`;
    if (!done.length) continue;
    if (r.razorpay_order_id) await releaseHolds(sql, { razorpayOrderId: r.razorpay_order_id, reason: 'expired' });
    await postThreadMessage(sql, r.order_id, 'host', pastCutoff ? 'The change request has closed: check-out day has begun.' : `The change request has closed: the difference was not paid within ${AWAITING_PAYMENT_HOURS} hours. The booking stays as it was.`);
    out.expired++;
  }
  return out;
}

module.exports = {
  loadBooking, AWAITING_PAYMENT_HOURS, changeOptions, quoteChange, requestChange, withdrawChange, respondChange,
  startChangePayment, confirmChangePayment, applyChange, refundAcrossPayments, hasChangePayments, openChangeFor, expireChanges, beforeCutoff
};
