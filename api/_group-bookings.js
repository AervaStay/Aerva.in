// /api/_group-bookings.js — group bookings: "Split the payment with friends".
// Not an endpoint (leading underscore). The owner's FINAL rules of 10 Nov
// 2026 (01:08–01:25); needs migrations/2026-11-10-04-group-final.sql.
//
// STARTING. At checkout the organiser chooses to split. The total — stay,
// GST, service fee and deposit, exactly the normal quote — is split equally
// by the number of guests: one share per place, whole rupees, any remainder
// on the last places (splitShares). The organiser MUST tick "I'll pay for
// any places my friends don't pay within 2 hours" (commitment_at) and the
// non-refundable notice, and pays for at least one place inside the normal
// 3-minute checkout window. Once paid, the group is OPEN for 2 hours.
//
// DATES ARE NOT HELD while the money is collected: anyone else can still book
// those dates. Payments made meanwhile wait.
//
// THE PLACE GETS BOOKED BY SOMEONE ELSE before the group completes: every
// payer is refunded their FULL amount to their own payment, automatically,
// with the reason BOOKED ("This place got booked by someone else. Try
// another listing."), and the group ends. Detected when an outside booking
// is confirmed (onOutsideBooking, from _confirm-booking.js), whenever the
// group is looked at or paid (tick), and by the 5-minute job (safety net).
//
// THE LAST SHARE. The payment that pays the last unpaid amount (the last
// places, the balance after a guest was added, or the organiser's "pay the
// rest") holds the place for the normal 3-minute payment window only
// (takeFinalHold → booking_holds), so it cannot be taken mid-payment. When
// the full amount is paid the booking is confirmed — one booking, one code —
// and it is NON-REFUNDABLE from that moment. Every payer ticks "I understand:
// once the booking is confirmed it is non-refundable…" (NONREF_TICK) before
// paying (create-order.js), and the emails say it. Two people paying the last
// places at once: the places are claimed in group_seats (primary key), so
// one gets them and the other is told they are taken.
//
// JOINING. The share link (index.html?group=<token>) shows the stay, the
// per-place amount and the live status. A friend signs in, gives their name
// and phone, picks how many places (never more than are left) and pays.
// A payment that does not count — late, at an old price, mismatched, over
// the places left, after the group closed or ended — is refunded in full at
// once and the person is told why (rejectPayment).
//
// AT 2 HOURS with places unpaid: the organiser gets "Pay the remaining ₹X to
// confirm" (page, email and notice) with 30 minutes to pay (status
// 'awaiting_gap'; the place is still not held — if it gets booked meanwhile,
// BOOKED applies). Paid → confirmed, everyone told. Not paid in 30 minutes
// → no booking: every payer refunded in full with NOT_COMPLETED, and the
// organiser's unpaid commitment is recorded on their account
// (commitment_unpaid) and shown to admin (adminList, commitmentsOf).
// There is no "confirm for fewer guests" any more.
//
// ADD A GUEST (places only go up, flow22 rules): capacity first, the whole
// stay priced again for the new count, paid places keep what they paid, a
// rise is one "balance to pay"; at the 2-hour mark the organiser may add
// guests once (30-minute extra window). Before confirmation adding guests
// holds no dates either. After confirmation it changes the SAME booking
// (same code) and is confirmed once paid (_booking-changes.js).
//
// AFTER CONFIRMATION (the booking row; the organiser manages it):
//   • a cancellation for any reason but a disaster: no refund of the price,
//     GST or fee whatever the listing's policy (the deposit, as always, goes
//     back to the payments); the host is paid as for a normal stay
//     (_cancellations.js, by 'group_no_refund');
//   • natural disaster / government order approved by Aerva, or the host
//     cancels: each payer's own share becomes Aerva credit in their own
//     account, refundable to their own payment (_fee-credits.js
//     creditForGroupPayers); no host payout;
//   • check-in promise not kept: full refund to each payer's own payment.
//
// Money: group_bookings.total / shares / group_claims.amount are whole
// rupees (as orders); group_claims.refund_amount is paise (as refunds.amount).

const { helpLine } = require('./_help-link');
const crypto = require('crypto');
const { logAudit } = require('./_audit-log');
const { HOLD_SECONDS, releaseHolds, holdValidForConfirmation, dateStr } = require('./_booking-rules');

const OPEN_MINUTES = 120;
const CONFIRM_MINUTES = 30;
const REMIND_BEFORE_MINUTES = 30;
const GRACE_SECONDS = 15;
const MAX_CLAIMS_PER_PERSON = 6;
const NOT_ON = 'Split payments are not switched on yet. Please pay for the whole stay, or try again later.';
const LIVE = ['open', 'awaiting_confirm', 'awaiting_gap'];
// The owner's words (10 Nov 2026).
const BOOKED = 'This place got booked by someone else. Try another listing.';
const UNAVAILABLE = 'This place is no longer available for these dates. Try another listing.';
const NOT_COMPLETED = 'The group’s booking wasn’t completed.';
const COMMIT_TICK = 'I’ll pay for any places my friends don’t pay within 2 hours.';
const NONREF_TICK = 'I understand: once the booking is confirmed it is non-refundable. If plans change, nothing is refunded, whatever the listing’s cancellation policy (any deposit is still refunded). Only a natural disaster or government order approved by Aerva, a cancellation by the host, or Aerva’s check-in promise changes that.';

const userError = (message, status = 400, extra = {}) => Object.assign(new Error(message), { isUserFacing: true, status }, extra);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const sum = (a) => a.reduce((t, x) => t + (Number(x) || 0), 0);

// Everything the final rules need: the gift/group update, "Add a guest"
// (2026-11-10-03) and the final rules (2026-11-10-04).
async function ready(sql) {
  try {
    await sql`SELECT 1 FROM group_claims LIMIT 0`;
    await sql`SELECT price_version, topup_due, extensions, notices, commitment_at, commitment_unpaid FROM group_bookings LIMIT 0`;
    await sql`SELECT price_version, change_id, hold_id, nonrefundable_ack_at FROM group_claims LIMIT 0`;
    return true;
  } catch (err) { return false; }
}
// "Add a guest" is part of the same update now.
const ADD_WINDOW_MINUTES = 30;
const ADD_NOT_ON = 'Adding guests to a group booking is not switched on yet. Please try again later.';
const addReady = ready;
// The normal quote's total for a priced stay (as create-order.js charges it).
const quoteTotal = (d) => Math.round(Number(d.subtotal) + Number(d.gst || 0) + Number(d.guestServiceFee || 0) + Number(d.depositAmount || 0));
const versionOf = (x) => Number(x && x.price_version) || 1;
// The balance the paid places still owe at the group's current prices.
function topupOwed(g, claims) {
  const due = Number(g.topup_due) || 0;
  if (!due) return 0;
  const paid = sum(claims.filter(c => c.kind === 'topup' && c.status === 'paid' && versionOf(c) === versionOf(g)).map(c => c.amount));
  return Math.max(0, due - paid);
}
// Paid toward the group's total: places, balances and the organiser's rest.
const paidToward = (claims) => sum(claims.filter(c => c.status === 'paid' && ['places', 'topup', 'gap'].includes(c.kind)).map(c => c.amount));
// What is still to pay for the whole stay (the organiser's "rest").
const restOf = (g, claims) => Math.max(0, Number(g.total) - paidToward(claims));
const isComplete = (g, claims) => (paidPlaces(claims) >= g.places && topupOwed(g, claims) <= 0) || (claims.some(c => c.kind === 'gap' && c.status === 'paid') && restOf(g, claims) <= 0);

// Equal shares in whole rupees; the remainder goes one rupee each on the
// last places, so the shares always add up to the total exactly.
function splitShares(total, places) {
  const t = Math.round(Number(total) || 0), n = Math.max(1, Math.round(Number(places) || 1));
  const base = Math.floor(t / n), rem = t - base * n;
  return Array.from({ length: n }, (_, i) => base + (i >= n - rem ? 1 : 0));
}
// Splits `amount` in proportion to `weights`, in whole units that add up
// exactly; leftover units go to the last entries. No part ever exceeds its
// weight while amount ≤ the weights' total.
function allocate(amount, weights) {
  const a = Math.max(0, Math.round(Number(amount) || 0));
  const W = sum(weights);
  if (!W || !a) return weights.map(() => 0);
  const parts = weights.map(w => Math.floor(a * Number(w) / W));
  let rem = a - sum(parts);
  for (let i = parts.length - 1; rem > 0; i = (i - 1 + parts.length) % parts.length) {
    if (parts[i] < Number(weights[i])) { parts[i]++; rem--; }
  }
  return parts;
}

// ---- Email ----
async function sendMail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html })
    });
    return !!(r && r.ok);
  } catch (err) { console.error('group email failed:', err.message); return false; }
}
const frame = (title, body) => `<div style="font-family:sans-serif; max-width:520px;"><h2 style="font-family:Georgia,serif;">${title}</h2>${body}
  <p style="font-size:12px; opacity:0.6; margin-top:24px;">${helpLine({}, 'Questions?')}</p></div>`;
const groupLink = (token) => `https://aerva.in/index.html?group=${encodeURIComponent(token)}`;
const button = (href, label) => `<p><a href="${href}" style="display:inline-block; background:#1C1B19; color:#fff; padding:12px 20px; border-radius:8px; text-decoration:none;">${label}</a></p>`;
const niceDate = (d) => { const s = dateStr(d); return s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : ''; };
const stayLine = (g) => `<strong>${esc(g.stay.detail.suite)}</strong> · ${esc(niceDate(g.arrival))} → ${esc(niceDate(g.departure))}`;

// ---- Loading ----
async function load(sql, { token = null, id = null }) {
  const rows = token
    ? (/^[a-f0-9]{24}$/.test(String(token)) ? await sql`SELECT * FROM group_bookings WHERE token = ${String(token)}` : [])
    : await sql`SELECT * FROM group_bookings WHERE id = ${Number(id) || 0}`;
  const g = rows[0] || null;
  if (g && typeof g.stay === 'string') g.stay = JSON.parse(g.stay);
  if (g && typeof g.requote === 'string') g.requote = JSON.parse(g.requote);
  if (g && typeof g.notices === 'string') g.notices = JSON.parse(g.notices);
  return g;
}
const claimsOf = (sql, gid) => sql`SELECT * FROM group_claims WHERE group_id = ${gid} ORDER BY id`;
const paidPlaces = (claims) => sum(claims.filter(c => c.status === 'paid' && c.kind === 'places').map(c => c.places));
const paidSum = (claims) => sum(claims.filter(c => c.status === 'paid').map(c => c.amount));
// What each paid payment still holds after any refund made before the
// booking (the excess of a smaller booking): rupees.
const netOf = (c) => Number(c.amount) - Math.round(Number(c.refund_status && c.refund_status !== 'failed' ? c.refund_amount || 0 : 0) / 100);
// Payment windows that ran out are given back (their places free again, and
// a last-share hold, if any, released).
async function sweepClaims(sql, groupId = null) {
  const rows = await sql`
    UPDATE group_claims SET status = 'released', failed_reason = COALESCE(failed_reason, 'The payment window ended before the payment was completed.')
    WHERE status = 'open' AND expires_at + make_interval(secs => ${GRACE_SECONDS}) < now() AND (${groupId}::int IS NULL OR group_id = ${groupId})
    RETURNING id, group_id, hold_id`;
  if (rows.length) {
    await sql`DELETE FROM group_seats WHERE claim_id = ANY(${rows.map(r => r.id)})`;
    const holds = rows.map(r => Number(r.hold_id)).filter(Boolean);
    if (holds.length) await releaseHolds(sql, { ids: holds, reason: 'expired' });
  }
  return rows;
}

// Takes the k lowest free places for a claim; all or none.
async function takeSeats(sql, g, claimId, k) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = await sql`
      INSERT INTO group_seats (group_id, seat, claim_id)
      SELECT ${g.id}, s, ${claimId} FROM generate_series(1, ${g.places}) s
      WHERE NOT EXISTS (SELECT 1 FROM group_seats x WHERE x.group_id = ${g.id} AND x.seat = s)
      ORDER BY s LIMIT ${k}
      ON CONFLICT DO NOTHING RETURNING seat`;
    if (got.length === k) return got.map(r => Number(r.seat)).sort((a, b) => a - b);
    await sql`DELETE FROM group_seats WHERE claim_id = ${claimId}`;
    const free = (await sql`SELECT ${g.places}::int - count(*)::int AS n FROM group_seats WHERE group_id = ${g.id}`)[0].n;
    if (free < k) return null;
  }
  return null;
}

// ---- Razorpay orders for a claim ----
async function razorpayOrderFor(razorpay, claim, g, assertNotesFit) {
  const notes = { type: 'group_share', groupId: String(g.id), claimId: String(claim.id), guestId: String(claim.guest_id), kind: claim.kind };
  return razorpay.orders.create({ amount: claim.amount * 100, currency: 'INR', receipt: `aerva_g${g.id}_${claim.id}`,
    notes: assertNotesFit ? assertNotesFit(notes) : notes });
}
// ---- Is the place still free? (not held: anyone may book it meanwhile) ----
// → null, or the reason the group can no longer be booked.
async function placeTaken(sql, g) {
  const detail = g.stay && g.stay.detail ? g.stay.detail : {};
  const s = { listingId: g.listing_id, roomId: g.room_id || null, arrival: dateStr(g.arrival), departure: dateStr(g.departure), suite: detail.suite };
  const booked = s.roomId
    ? await sql`SELECT 1 FROM orders WHERE room_id = ${s.roomId} AND status = 'paid' AND COALESCE(order_type, 'stay') = 'stay'
                  AND arrival < ${s.departure}::date AND departure > ${s.arrival}::date AND (group_booking_id IS NULL OR group_booking_id <> ${g.id}) LIMIT 1`
    : await sql`SELECT 1 FROM orders WHERE listing_id = ${s.listingId} AND status = 'paid' AND COALESCE(order_type, 'stay') = 'stay'
                  AND arrival < ${s.departure}::date AND departure > ${s.arrival}::date AND (group_booking_id IS NULL OR group_booking_id <> ${g.id}) LIMIT 1`;
  if (booked.length) return BOOKED;
  const blocked = await sql`SELECT 1 FROM listing_blocked_dates WHERE listing_id = ${s.listingId} AND (room_id IS NULL OR room_id = ${s.roomId})
                              AND start_date < ${s.departure}::date AND end_date > ${s.arrival}::date LIMIT 1`;
  return blocked.length ? UNAVAILABLE : null;
}

// The LAST unpaid amount is being paid: the place is held for this payment's
// own window (as any checkout), so nobody can take it mid-payment. The
// database refuses the hold while someone else's checkout holds the dates.
// Throws a user-facing error (the claim already given back) when it cannot.
async function takeFinalHold(sql, razorpay, g, claim) {
  const taken = await placeTaken(sql, g);
  if (taken) {
    await releaseClaim(sql, claim.id, 'released', taken);
    await cancelGroup(sql, razorpay, g, taken);
    throw userError(`${taken} Everyone who paid is refunded in full.`, 409, { closed: true });
  }
  try { await sql`UPDATE booking_holds SET released = true, released_reason = COALESCE(released_reason, 'expired') WHERE released = false AND expires_at < now()`; } catch (e) { /* older table */ }
  let hold;
  try {
    hold = (await sql`INSERT INTO booking_holds (listing_id, room_id, arrival, departure, guest_key, ip, expires_at)
                      VALUES (${g.listing_id}, ${g.room_id || null}, ${g.arrival}, ${g.departure}, ${'grp:' + g.id + ':' + claim.id}, null, ${claim.expires_at}::timestamptz)
                      RETURNING id`)[0];
  } catch (err) {
    if (err && err.code === '23P01') {
      await releaseClaim(sql, claim.id, 'released', 'Someone else was paying for these dates at that moment.');
      throw userError('Someone else is paying for these dates right now, so the last payment can’t start. Please try again in 3 minutes. If their booking goes through, this group can’t be completed and everyone is refunded in full.', 409);
    }
    throw err;
  }
  await sql`UPDATE group_claims SET hold_id = ${hold.id} WHERE id = ${claim.id}`;
  await logAudit(sql, { action: 'group_final_hold', success: true, actorType: 'system', targetType: 'group_booking', targetId: g.id,
    metadata: { claimId: claim.id, kind: claim.kind, holdId: hold.id, until: claim.expires_at } });
  return hold.id;
}
// After this claim, is every place paid or being paid, and the balance covered?
async function coversTheRest(sql, g, claim) {
  const claims = await claimsOf(sql, g.id);
  const taken = (await sql`SELECT count(*)::int AS n FROM group_seats WHERE group_id = ${g.id}`)[0].n;
  const owed = topupOwed(g, claims);
  const topupOpen = sum(claims.filter(c => c.kind === 'topup' && c.status === 'open' && versionOf(c) === versionOf(g)).map(c => c.amount));
  return taken >= g.places && owed - topupOpen <= 0 && !!claim;
}
async function attachOrder(sql, claim, orderId) {
  await sql`UPDATE group_claims SET razorpay_order_id = ${orderId} WHERE id = ${claim.id}`;
  const h = (await sql`SELECT hold_id FROM group_claims WHERE id = ${claim.id}`)[0];
  if (h && h.hold_id) await sql`UPDATE booking_holds SET razorpay_order_id = ${orderId} WHERE id = ${h.hold_id}`;
}

// The organiser's checkout (create-order.js, after the stay is priced and
// its 3-minute checkout hold taken). input: the stay as asked; detail: the
// priced stay; total: the normal quote. commitment: the organiser ticked
// COMMIT_TICK; nonRefundable: NONREF_TICK (both checked by create-order.js).
async function startGroup(sql, razorpay, { guestId, email, firstName, lastName, phone, input, detail, total, payNow, agreement, prices, holdIds, assertNotesFit, commitment = false, nonRefundable = false }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  if (commitment !== true) throw userError(`Please tick “${COMMIT_TICK}” to split the payment.`, 400, { needs: ['groupCommitment'] });
  if (nonRefundable !== true) throw userError('Please tick that you understand a confirmed group booking is non-refundable.', 400, { needs: ['groupNonRefundable'] });
  const places = Math.round(Number(detail.guests) || 0);
  if (places < 2) throw userError('Splitting the payment needs at least 2 guests.');
  const k = Math.round(Number(payNow) || 0);
  if (!(k >= 1 && k <= places - 1)) throw userError(`Choose how many places you pay for now: from 1 to ${places - 1}.`);
  const shares = splitShares(total, places);
  const token = crypto.randomBytes(12).toString('hex');
  const g = (await sql`
    INSERT INTO group_bookings (token, organiser_guest_id, organiser_first_name, organiser_last_name, organiser_email, listing_id, room_id, arrival, departure,
                                places, stay, total, shares, agreement, prices, status, commitment_at)
    VALUES (${token}, ${guestId}, ${firstName}, ${lastName}, ${email}, ${detail.listingId}, ${detail.roomId || null}, ${detail.arrival}::date, ${detail.departure}::date,
            ${places}, ${JSON.stringify({ input, detail })}::jsonb, ${total}, ${shares}, ${agreement || null}, ${prices ? JSON.stringify(prices) : null}::jsonb, 'starting', now())
    RETURNING *`)[0];
  g.stay = { input, detail };
  const amount = sum(shares.slice(0, k));
  const claim = (await sql`
    INSERT INTO group_claims (group_id, guest_id, first_name, last_name, email, phone, kind, places, seats, amount, expires_at, nonrefundable_ack_at)
    VALUES (${g.id}, ${guestId}, ${firstName}, ${lastName}, ${email}, ${phone || null}, 'places', ${k}, ${Array.from({ length: k }, (_, i) => i + 1)}, ${amount},
            now() + make_interval(secs => ${HOLD_SECONDS}), now())
    RETURNING *`)[0];
  const seats = await takeSeats(sql, g, claim.id, k);
  if (!seats) throw new Error('could not take the organiser’s places in a new group');
  const order = await razorpayOrderFor(razorpay, claim, g, assertNotesFit);
  await sql`UPDATE group_claims SET razorpay_order_id = ${order.id} WHERE id = ${claim.id}`;
  await sql`UPDATE group_bookings SET hold_order_id = ${order.id} WHERE id = ${g.id}`;
  await logAudit(sql, { action: 'booking_order_created', success: true, actorType: 'guest', actorIdentifier: email || null, targetType: 'group_booking', targetId: g.id,
    metadata: { razorpayOrderId: order.id, group: true, groupId: g.id, claimId: claim.id, places, payNow: k, amount, total, holdIds, commitment: true, nonRefundable: true } });
  return { order, group: g, claim: { ...claim, razorpay_order_id: order.id }, token, shares, amount };
}

// A friend (or the organiser again) pays for more places.
async function startPayment(sql, razorpay, { token, guestId, places, firstName, lastName, email, phone, assertNotesFit }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  let g = await load(sql, { token });
  if (!g) throw userError('This group booking link is not valid.', 404);
  g = await tick(sql, razorpay, g);
  // Confirmed with guests added since: this pays for them (same booking).
  if (g.status === 'confirmed') return startAddedPayment(sql, razorpay, { g, guestId, firstName, lastName, email, phone, assertNotesFit });
  if (g.status === 'cancelled' || g.status === 'failed') throw userError(g.outcome || 'This group booking did not go ahead.', 409, { closed: true });
  if (g.status !== 'open' || !(new Date(g.closes_at) > new Date())) throw userError('This group booking is closed to new payments.', 409, { closed: true });
  const k = Math.round(Number(places) || 0);
  if (!(k >= 1)) throw userError('Choose how many places you are paying for.');
  const taken = (await sql`SELECT count(*)::int AS n FROM group_seats WHERE group_id = ${g.id}`)[0].n;
  const left = g.places - taken;
  if (k > left) throw userError(left <= 0 ? 'All places are paid for, or being paid for right now. If a payment does not go through, places open again in a few minutes.' : `Only ${left} place${left === 1 ? ' is' : 's are'} left. Please choose ${left} or fewer.`, 409, { placesLeft: Math.max(0, left) });
  const mine = await sql`SELECT status, expires_at FROM group_claims WHERE group_id = ${g.id} AND guest_id = ${guestId}`;
  if (mine.some(c => c.status === 'open')) throw userError('Your payment for this group is already open. Finish it there, or wait 3 minutes and try again.', 409);
  if (mine.length >= MAX_CLAIMS_PER_PERSON) throw userError('Too many payment attempts for this group from your account. Please raise a request in Aerva Support (Help → Raise a request).', 429);
  // amount is set from the places actually taken, below.
  const claim = (await sql`
    INSERT INTO group_claims (group_id, guest_id, first_name, last_name, email, phone, kind, places, amount, expires_at, nonrefundable_ack_at)
    VALUES (${g.id}, ${guestId}, ${firstName}, ${lastName}, ${email}, ${phone || null}, 'places', ${k}, ${Math.max(...g.shares) * k},
            LEAST(now() + make_interval(secs => ${HOLD_SECONDS}), ${g.closes_at}::timestamptz), now())
    RETURNING *`)[0];
  const seats = await takeSeats(sql, g, claim.id, k);
  if (!seats) {
    await sql`UPDATE group_claims SET status = 'released', failed_reason = 'Those places were just taken by someone else.' WHERE id = ${claim.id}`;
    throw userError('Those places were just taken by someone else. Please check how many are left and try again.', 409);
  }
  const amount = sum(seats.map(s => g.shares[s - 1]));
  await sql`UPDATE group_claims SET seats = ${seats}, amount = ${amount}, price_version = ${versionOf(g)} WHERE id = ${claim.id}`;
  // The prices this payment was worked out at. A guest added meanwhile
  // changes them: give the places back at once and ask to try again (a
  // payment made anyway is not counted and is refunded in full).
  const now = (await sql`SELECT price_version FROM group_bookings WHERE id = ${g.id}`)[0];
  if (versionOf(now) !== versionOf(g)) {
    await releaseClaim(sql, claim.id, 'released', 'A guest was added while the payment was being started, so the price per place changed.');
    throw userError('A guest was just added to this group, so the price per place changed. Please check the new amount and try again.', 409);
  }
  // The last places: the place is held for this payment's window.
  let last = false;
  if (await coversTheRest(sql, g, claim)) { await takeFinalHold(sql, razorpay, g, claim); last = true; }
  let order;
  try { order = await razorpayOrderFor(razorpay, { ...claim, amount }, g, assertNotesFit); }
  catch (err) {
    await releaseClaim(sql, claim.id, 'released', 'The payment could not be started.');
    throw err;
  }
  await attachOrder(sql, claim, order.id);
  const secs = (await sql`SELECT GREATEST(0, ceil(extract(epoch FROM expires_at - now())))::int AS s FROM group_claims WHERE id = ${claim.id}`)[0].s;
  await logAudit(sql, { action: 'booking_order_created', success: true, actorType: 'guest', actorIdentifier: email || null, targetType: 'group_booking', targetId: g.id,
    metadata: { razorpayOrderId: order.id, group: true, groupId: g.id, claimId: claim.id, places: k, seats, amount, last, nonRefundable: true } });
  return { order, amount, seats, holdSeconds: secs, claimId: claim.id, last };
}

// At 2 hours with places unpaid: the organiser pays the rest (their commitment).
async function startGapPayment(sql, razorpay, { token, guestId, assertNotesFit }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  let g = await load(sql, { token });
  if (!g || Number(g.organiser_guest_id) !== Number(guestId)) throw userError('Group booking not found.', 404);
  g = await tick(sql, razorpay, g);
  if (g.status === 'cancelled' || g.status === 'failed') throw userError(g.outcome || 'This group booking did not go ahead.', 409, { closed: true });
  if (g.status !== 'awaiting_gap' || !(new Date(g.confirm_by) > new Date())) throw userError('There is nothing to pay for this group booking now.', 409);
  const open = await sql`SELECT 1 FROM group_claims WHERE group_id = ${g.id} AND kind = 'gap' AND status IN ('open', 'paid')`;
  if (open.length) throw userError('Your payment for the rest is already open or done.', 409);
  const rest = restOf(g, await claimsOf(sql, g.id));
  if (!(rest > 0)) throw userError('There is nothing left to pay.', 409);
  const claim = (await sql`
    INSERT INTO group_claims (group_id, guest_id, first_name, last_name, email, kind, places, amount, expires_at, nonrefundable_ack_at, price_version)
    VALUES (${g.id}, ${guestId}, ${g.organiser_first_name}, ${g.organiser_last_name}, ${g.organiser_email}, 'gap', 0, ${rest},
            LEAST(now() + make_interval(secs => ${HOLD_SECONDS}), ${g.confirm_by}::timestamptz), now(), ${versionOf(g)})
    RETURNING *`)[0];
  // Always the last amount: the place is held for its window.
  await takeFinalHold(sql, razorpay, g, claim);
  let order;
  try { order = await razorpayOrderFor(razorpay, claim, g, assertNotesFit); }
  catch (err) { await releaseClaim(sql, claim.id, 'released', 'The payment could not be started.'); throw err; }
  await attachOrder(sql, claim, order.id);
  const secs = (await sql`SELECT GREATEST(0, ceil(extract(epoch FROM expires_at - now())))::int AS s FROM group_claims WHERE id = ${claim.id}`)[0].s;
  await logAudit(sql, { action: 'booking_order_created', success: true, actorType: 'guest', actorIdentifier: g.organiser_email, targetType: 'group_booking', targetId: g.id,
    metadata: { razorpayOrderId: order.id, group: true, groupId: g.id, claimId: claim.id, rest, nonRefundable: true } });
  return { order, amount: rest, holdSeconds: secs, claimId: claim.id };
}

async function releaseClaim(sql, claimId, status, reason) {
  const r = await sql`UPDATE group_claims SET status = ${status}, failed_reason = COALESCE(failed_reason, ${reason}) WHERE id = ${claimId} AND status = 'open' RETURNING id, group_id, hold_id`;
  if (r.length) {
    await sql`DELETE FROM group_seats WHERE claim_id = ${claimId}`;
    if (r[0].hold_id) await releaseHolds(sql, { ids: [Number(r[0].hold_id)], reason: 'closed' });
  }
  return r[0] || null;
}

// create-order.js { releaseHold } for a group payment window: the payment
// failed or was closed. Returns null when the order is not a group payment.
// The window's own dates (the organiser's checkout, or a last-share hold)
// are released with it — a group never holds dates otherwise.
async function releaseByOrder(sql, razorpayOrderId, reason) {
  if (!(await ready(sql))) return null;
  const c = (await sql`SELECT * FROM group_claims WHERE razorpay_order_id = ${razorpayOrderId}`)[0];
  if (!c) return null;
  const failed = reason === 'failed';
  await releaseClaim(sql, c.id, failed ? 'failed' : 'released', failed ? 'The payment did not go through.' : 'The payment window was closed before paying.');
  const g = await load(sql, { id: c.group_id });
  if (g && g.status === 'starting' && g.hold_order_id === razorpayOrderId) {
    await sql`UPDATE group_bookings SET status = 'failed', outcome = 'The first payment did not go through, so the group was not opened.' WHERE id = ${g.id} AND status = 'starting'`;
  }
  return { keepHold: false };
}

// ---- Refunds of payments made before (or instead of) a booking ----
// One per payment, claimed on the row, checked with Razorpay first (tagged
// aerva_refund_key = group-claim-<id>), never beyond what the payment has left.
async function refundClaim(sql, razorpay, claimId, paise, reason) {
  const want = Math.max(0, Math.round(Number(paise) || 0));
  if (!want) return { nothing: true };
  const c = (await sql`
    UPDATE group_claims SET refund_status = 'creating', refund_amount = COALESCE(CASE WHEN refund_status = 'failed' THEN refund_amount END, ${want}),
                            refund_reason = COALESCE(refund_reason, ${reason}), refund_claimed_at = now()
    WHERE id = ${claimId} AND razorpay_payment_id IS NOT NULL
      AND (refund_status IS NULL OR refund_status = 'failed' OR (refund_status = 'creating' AND refund_claimed_at < now() - interval '10 minutes'))
    RETURNING *`)[0];
  if (!c) return { already: true };
  const key = `group-claim-${c.id}`;
  try {
    let existing = null;
    try {
      const list = await razorpay.payments.fetchMultipleRefund(c.razorpay_payment_id, { count: 100 });
      existing = ((list && list.items) || []).find(r => r.notes && r.notes.aerva_refund_key === key && r.status !== 'failed') || null;
    } catch (e) { /* rely on the payment's refunded amount */ }
    let refund = existing;
    if (!refund) {
      const p = await razorpay.payments.fetch(c.razorpay_payment_id);
      const left = Number(p.amount) - Number(p.amount_refunded || 0);
      const amount = Math.min(Number(c.refund_amount), left);
      if (amount <= 0) {
        await sql`UPDATE group_claims SET refund_status = 'failed', refund_reason = ${'Nothing left to refund on this payment. ' + (c.refund_reason || '')} WHERE id = ${c.id}`;
        return { failed: true };
      }
      refund = await razorpay.payments.refund(c.razorpay_payment_id, { amount, speed: 'normal', notes: { aerva_refund_key: key } });
    }
    await sql`UPDATE group_claims SET refund_status = ${refund.status === 'processed' ? 'processed' : 'pending'}, razorpay_refund_id = ${refund.id},
                                      refund_amount = ${Math.round(Number(refund.amount))}, refunded_at = now() WHERE id = ${c.id}`;
    await logAudit(sql, { action: 'group_payment_refunded', success: true, actorType: 'system', targetType: 'group_booking', targetId: c.group_id,
      metadata: { claimId: c.id, email: c.email, firstName: c.first_name, paymentId: c.razorpay_payment_id, refundId: refund.id, amountPaise: Math.round(Number(refund.amount)), reason: c.refund_reason, adopted: !!existing } });
    return { id: refund.id, amount: Math.round(Number(refund.amount)) };
  } catch (err) {
    const why = (err && err.error && err.error.description) || String((err && err.message) || err);
    await sql`UPDATE group_claims SET refund_status = 'failed', refund_reason = ${String((c.refund_reason || '') + ' — ' + why).slice(0, 400)} WHERE id = ${c.id} AND refund_status = 'creating'`;
    await logAudit(sql, { action: 'group_payment_refund_failed', success: false, actorType: 'system', targetType: 'group_booking', targetId: c.group_id, metadata: { claimId: c.id, error: why.slice(0, 200) } });
    return { failed: true, error: why };
  }
}

// A payment that does not count: not a place, refunded in full, told why.
async function rejectPayment(sql, razorpay, claim, payment, reason) {
  await sql`UPDATE group_claims SET status = CASE WHEN status IN ('open', 'paid') THEN 'rejected' ELSE status END,
                                    razorpay_payment_id = COALESCE(razorpay_payment_id, ${payment.id}), failed_reason = ${reason}
            WHERE id = ${claim.id}`;
  await sql`DELETE FROM group_seats WHERE claim_id = ${claim.id}`;
  const refund = await refundClaim(sql, razorpay, claim.id, Number(payment.amount) - Number(payment.amount_refunded || 0), reason);
  const g = await load(sql, { id: claim.group_id });
  if (g && g.status === 'starting' && g.hold_order_id === claim.razorpay_order_id) {
    await sql`UPDATE group_bookings SET status = 'failed', outcome = ${reason} WHERE id = ${g.id} AND status = 'starting'`;
    await releaseHolds(sql, { razorpayOrderId: g.hold_order_id, reason: 'conflict' });
  }
  const amt = Math.round((Number(payment.amount) || 0) / 100);
  await sendMail(claim.email, 'Your Aerva group payment was not counted — full refund', frame('Your payment was not counted',
    `<p>Hello ${esc(claim.first_name || '')},</p><p>${esc(reason)}</p><p>Your payment of <strong>${inr(amt)}</strong> ${refund.failed ? 'is being refunded in full; our team is completing it and will confirm by email.' : 'is being refunded in full to your original payment method. Refunds usually arrive in 5–7 working days.'}</p>
     ${g ? `<p>${stayLine(g)}</p>` : ''}`));
  await logAudit(sql, { action: 'group_payment_rejected', success: true, actorType: 'system', targetType: 'group_booking', targetId: claim.group_id,
    metadata: { claimId: claim.id, email: claim.email, firstName: claim.first_name, paymentId: payment.id, reason, amount: amt } });
  return { status: 'conflict', group: g ? { token: g.token } : null, message: `${reason} Your payment of ${inr(amt)} is being refunded in full — we have emailed you.` };
}
// ---- A payment arrived (from _confirm-booking.js confirmBooking, which has
// already claimed payment_confirmations for this Razorpay order and checked
// the payment is captured and belongs to the order). ----
async function confirmGroupPayment(sql, razorpay, { order, payment, razorpayOrderId }) {
  const claim = (await sql`SELECT * FROM group_claims WHERE razorpay_order_id = ${razorpayOrderId}`)[0];
  if (!claim) return { status: 'error', retry: true, message: 'Group payment not found yet.' };
  if (claim.status === 'paid' && claim.razorpay_payment_id === payment.id) return { status: 'duplicate', group: { token: (await load(sql, { id: claim.group_id })).token } };
  let g = await load(sql, { id: claim.group_id });
  // Windows that have run out are given back first.
  await sweepClaims(sql, g.id);
  const fresh = (await sql`SELECT * FROM group_claims WHERE id = ${claim.id}`)[0];
  const late = (await sql`SELECT (now() > ${fresh.expires_at}::timestamptz + make_interval(secs => ${GRACE_SECONDS})) AS late`)[0].late;
  const isFirst = g.hold_order_id === razorpayOrderId && fresh.kind === 'places';
  // Guests added after confirmation: paid and applied to the same booking.
  if (fresh.kind === 'change') return confirmAddedPayment(sql, razorpay, { g, claim: fresh, payment, order, late });
  const ended = (st) => st === 'confirmed' || st === 'confirming' ? 'The group booking was already complete when this payment arrived.'
    : st === 'cancelled' || st === 'failed' ? `The group booking had already ended when this payment arrived${g.outcome ? ': ' + g.outcome.replace(/\.$/, '') : ''}.`
    : 'The group booking had already closed when this payment arrived.';
  let reason = null;
  if (Number(payment.amount) !== Number(order.amount) || Number(order.amount) !== fresh.amount * 100 || (payment.currency || 'INR') !== 'INR') {
    reason = 'The amount paid did not match the amount for the places chosen, so it was not counted.';
  } else if (!isFirst && (fresh.kind === 'places' || fresh.kind === 'topup') && g.status !== 'open') {
    reason = ended(g.status);
  } else if (fresh.status === 'failed' || (fresh.status === 'released' && !late)) {
    reason = 'This payment attempt had already been closed, and its places were given back.';
  } else if (fresh.status === 'released' || late) {
    reason = 'The payment was completed after its 3-minute payment window had ended, and its places had been given back.';
  } else if (fresh.status !== 'open') {
    reason = 'This payment attempt had already been closed.';
  } else if (isFirst) {
    if (g.status !== 'starting') reason = 'This group booking was no longer open.';
    else {
      const win = await holdValidForConfirmation(sql, razorpayOrderId, { heldAtCheckout: true });
      if (!win.ok) reason = win.reason;
    }
  } else if (fresh.kind === 'gap') {
    if (g.status !== 'awaiting_gap') reason = ended(g.status);
  }
  // Worked out at prices that changed since (a guest was added): not counted.
  if (!reason && !isFirst && (fresh.kind === 'places' || fresh.kind === 'topup') && versionOf(fresh) !== versionOf(g)) {
    reason = 'A guest was added to the group while this payment was open, so the price per place changed and this payment was not counted.';
  }
  if (!reason && fresh.kind === 'topup' && Number(fresh.amount) > topupOwed(g, await claimsOf(sql, g.id))) {
    reason = 'The balance to pay had already been paid, so this payment was not needed.';
  }
  if (!reason && fresh.kind === 'gap' && Number(fresh.amount) !== restOf(g, await claimsOf(sql, g.id))) {
    reason = 'The amount still to pay changed while this payment was open, so it was not counted.';
  }
  if (reason) return rejectPayment(sql, razorpay, fresh, payment, reason);
  const marked = await sql`UPDATE group_claims SET status = 'paid', razorpay_payment_id = ${payment.id}, paid_at = now()
                           WHERE id = ${fresh.id} AND status = 'open' RETURNING id`;
  if (!marked.length) return rejectPayment(sql, razorpay, fresh, payment, 'This payment attempt had already been closed, and its places were given back.');
  await logAudit(sql, { action: 'group_payment_counted', success: true, actorType: 'guest', actorIdentifier: fresh.email, targetType: 'group_booking', targetId: g.id,
    metadata: { claimId: fresh.id, kind: fresh.kind, places: fresh.places, seats: fresh.seats, amount: fresh.amount, paymentId: payment.id, email: fresh.email, firstName: fresh.first_name } });

  if (isFirst) return openGroup(sql, razorpay, g, fresh);
  if (fresh.kind === 'gap') {
    const done = await finalize(sql, razorpay, g, ['awaiting_gap']);
    const now = await load(sql, { id: g.id });
    return { status: 'confirmed', group: { token: g.token, kind: 'gap', complete: now.status === 'confirmed', outcome: (done && done.outcome) || now.outcome } };
  }
  if (fresh.kind === 'topup') {
    const all = await claimsOf(sql, g.id);
    await sendMail(fresh.email, 'Payment received: the balance for your group booking', frame('The balance is paid',
      `<p>Hello ${esc(fresh.first_name || '')},</p><p>We received <strong>${inr(fresh.amount)}</strong>, the balance the places already paid owed after a guest was added, for ${stayLine(g)}.</p>${nonRefundableNote()}${button(groupLink(g.token), 'See the group')}`));
    await addNotice(sql, g, `${fresh.first_name || 'A member'} paid the balance of ${inr(fresh.amount)}.`);
    if (isComplete(g, all)) {
      const done = await finalize(sql, razorpay, g, ['open']);
      return { status: 'confirmed', group: { token: g.token, kind: 'topup', complete: true, outcome: done && done.outcome } };
    }
    return { status: 'confirmed', group: { token: g.token, kind: 'topup' } };
  }
  // A friend's places: the organiser is told, the payer gets a receipt.
  const claims = await claimsOf(sql, g.id);
  const paid = paidPlaces(claims);
  const left = g.places - paid;
  const owed = topupOwed(g, claims);
  await sendMail(fresh.email, `Payment received: ${fresh.places} place${fresh.places === 1 ? '' : 's'} in ${g.organiser_first_name || 'your friend'}’s group booking`, frame('Your payment is in',
    `<p>Hello ${esc(fresh.first_name || '')},</p><p>We received <strong>${inr(fresh.amount)}</strong> for ${fresh.places} place${fresh.places === 1 ? '' : 's'} in ${esc(g.organiser_first_name || 'your friend')}’s group booking: ${stayLine(g)}.</p>
     <p>${left > 0 || owed > 0 ? `${paid} of ${g.places} places are paid${owed > 0 ? ` (and a balance of ${inr(owed)} is still to pay)` : ''}. The place is not held until the last payment: if someone else books it first, everyone is refunded in full. ${esc(g.organiser_first_name || 'The organiser')} pays for any places still unpaid at 2 hours.` : 'Every place is paid — the booking is being confirmed.'}</p>
     ${nonRefundableNote()}${button(groupLink(g.token), 'See the group')}`));
  if (Number(fresh.guest_id) !== Number(g.organiser_guest_id)) {
    await sendMail(g.organiser_email, `${fresh.first_name || 'A friend'} paid for ${fresh.places} place${fresh.places === 1 ? '' : 's'}`, frame(`${esc(fresh.first_name || 'A friend')} paid`,
      `<p>${esc(fresh.first_name || 'A friend')} paid for ${fresh.places} place${fresh.places === 1 ? '' : 's'} in your group booking: ${stayLine(g)}.</p><p><strong>${paid} of ${g.places}</strong> places are paid${left > 0 ? `; ${left} left` : ' — every place is paid'}${owed > 0 ? `; a balance of ${inr(owed)} is still to pay` : ''}.</p>${button(groupLink(g.token), 'See the group')}`));
  }
  if (left <= 0 && owed <= 0) {
    const done = await finalize(sql, razorpay, g, ['open']);
    const now = await load(sql, { id: g.id });
    return { status: 'confirmed', group: { token: g.token, kind: 'places', complete: now.status === 'confirmed', outcome: (done && done.outcome) || now.outcome } };
  }
  return { status: 'confirmed', group: { token: g.token, kind: 'places', paidPlaces: paid, places: g.places } };
}
const nonRefundableNote = () => `<p style="background:#fff4e5; border:1px solid #e8c48a; border-radius:8px; padding:10px 12px; font-size:13px;"><strong>Non-refundable once confirmed.</strong> ${esc(NONREF_TICK.replace(/^I understand: /, '').replace(/^o/, 'O'))}</p>`;

// The organiser's first payment counted: the group opens for 2 hours. The
// checkout's 3-minute hold is released — the dates are NOT held meanwhile.
async function openGroup(sql, razorpay, g, claim) {
  const opened = (await sql`UPDATE group_bookings SET status = 'open', opened_at = now(), closes_at = now() + make_interval(mins => ${OPEN_MINUTES})
                            WHERE id = ${g.id} AND status = 'starting' RETURNING *`)[0];
  if (!opened) return rejectPayment(sql, razorpay, claim, { id: claim.razorpay_payment_id || null, amount: claim.amount * 100 }, 'This group booking was no longer open.');
  await releaseHolds(sql, { razorpayOrderId: g.hold_order_id, reason: 'paid' });
  // The checkout window ran out in the grace seconds and someone booked the dates meanwhile.
  const taken = await placeTaken(sql, Object.assign({}, g, opened, { stay: g.stay }));
  if (taken) {
    await cancelGroup(sql, razorpay, Object.assign({}, g, opened, { stay: g.stay }), taken);
    return { status: 'conflict', group: { token: g.token }, message: `${taken} Your payment is being refunded in full — we have emailed you.` };
  }
  const rest = sum(g.shares) - claim.amount;
  await sendMail(g.organiser_email, 'Your group booking is open: share the link', frame('Your group booking is open for 2 hours',
    `<p>Hello ${esc(g.organiser_first_name || '')},</p><p>You paid for ${claim.places} of ${g.places} places (${inr(claim.amount)}) for ${stayLine(g)}.</p>
     <p>Each place is <strong>${inr(g.shares[0])}</strong>${g.shares[g.shares.length - 1] !== g.shares[0] ? ` (the last place${g.shares.filter(s => s !== g.shares[0]).length === 1 ? '' : 's'} ${inr(g.shares[g.shares.length - 1])})` : ''}. Send this link to your friends so each can pay for their own place:</p>
     ${button(groupLink(g.token), 'Open the group page')}<p style="font-size:13px; word-break:break-all;">${esc(groupLink(g.token))}</p>
     <p><strong>The place is not held until the last payment.</strong> Anyone else can still book these dates; if that happens, everyone who paid is refunded in full and the group ends. The last payment holds the place for its 3 minutes and confirms the booking.</p>
     <p><strong>Your commitment:</strong> you agreed to pay for any places your friends don’t pay within 2 hours (up to ${inr(rest)} now). If places are unpaid at 2 hours, you have 30 minutes to pay the rest; if you don’t, nothing is booked, everyone is refunded and the unpaid commitment is recorded on your account.</p>
     ${nonRefundableNote()}`));
  return { status: 'confirmed', group: { token: g.token, kind: 'first', opened: true } };
}

// ---- Turning the group into the booking ----
async function finalize(sql, razorpay, g, fromStatuses) {
  const got = (await sql`UPDATE group_bookings SET status = 'confirming', decided_at = now() WHERE id = ${g.id} AND status = ANY(${fromStatuses}) RETURNING *`)[0];
  if (!got) return null;
  return completeConfirm(sql, razorpay, await load(sql, { id: g.id }));
}
// Every last-share hold of the group (and the organiser's checkout hold).
async function releaseGroupHolds(sql, g, reason) {
  const ids = (await sql`SELECT hold_id FROM group_claims WHERE group_id = ${g.id} AND hold_id IS NOT NULL`).map(r => Number(r.hold_id));
  if (ids.length) await releaseHolds(sql, { ids, reason });
  if (g.hold_order_id) await releaseHolds(sql, { razorpayOrderId: g.hold_order_id, reason });
}

async function completeConfirm(sql, razorpay, g) {
  const CB = require('./_confirm-booking');
  const claims = (await claimsOf(sql, g.id)).filter(c => c.status === 'paid');
  const detail = g.stay.detail;
  const total = Number(g.total);
  const org = claims.find(c => c.razorpay_order_id === g.hold_order_id) || claims[0];
  let orderId = ((await sql`SELECT id FROM orders WHERE group_booking_id = ${g.id} ORDER BY id LIMIT 1`)[0] || {}).id || null;
  let fresh = false;
  const [ver, at, ip] = String(g.agreement || '').split('|');
  const ctx = { source: 'group', razorpayOrderId: org.razorpay_order_id, razorpayPaymentId: org.razorpay_payment_id, email: g.organiser_email,
    guestId: Number(g.organiser_guest_id), firstName: g.organiser_first_name, lastName: g.organiser_last_name, stays: [detail], experiences: [],
    chargeCurrency: 'INR', chargeAmount: null, couponId: null, couponDiscount: 0, couponForfeited: 0, feeCredits: [],
    agreement: { version: ver || null, acceptedAt: at && !isNaN(Date.parse(at)) ? new Date(at).toISOString() : null, ip: ip || null } };
  const rows = CB.planRows(ctx);
  if (!orderId) {
    // Booked or blocked by someone else before the last payment: everyone refunded in full.
    const taken = await placeTaken(sql, g);
    if (taken) return cancelGroup(sql, razorpay, g, taken, { from: ['confirming'] });
    try { orderId = await CB.insertRow(sql, ctx, rows[0], null); fresh = true; }
    catch (err) {
      if (err && err.code === '23P01') return cancelGroup(sql, razorpay, g, BOOKED, { from: ['confirming'] });
      throw err;
    }
    await sql`UPDATE orders SET group_booking_id = ${g.id} WHERE id = ${orderId}`;
  }
  let code = ((await sql`SELECT confirmation_code FROM orders WHERE id = ${orderId}`)[0] || {}).confirmation_code || null;
  if (!code) {
    const c = await CB.issueConfirmationCode(sql, orderId);
    if (c) code = ((await sql`UPDATE orders SET confirmation_code = ${c} WHERE id = ${orderId} AND confirmation_code IS NULL RETURNING confirmation_code`)[0] || {}).confirmation_code || c;
  }
  try { await sql`UPDATE orders o SET cancellation_policy = l.cancellation_policy FROM listings l WHERE o.id = ${orderId} AND l.id = o.listing_id AND o.cancellation_policy IS NULL`; } catch (e) { /* treated as Flexible */ }
  const codes = code ? [{ item: detail.suite, code }] : [];
  if (fresh) {
    try { await CB.afterPaidRow(sql, ctx, rows[0], orderId); } catch (err) { console.error('group: post-booking step failed (booking kept):', orderId, err.message); }
    try {
      let phone = null; try { phone = ((await sql`SELECT phone FROM guests WHERE id = ${ctx.guestId}`)[0] || {}).phone || null; } catch (e) { /* none */ }
      await CB.sendHostBookingEmails(sql, ctx.stays, [], ctx.agreement.version, codes,
        { firstName: ctx.firstName, lastName: ctx.lastName, phone, note: `Group booking: ${detail.guests} guests, paid by ${new Set(claims.map(c => c.guest_id)).size} people. ${esc(ctx.firstName || 'The organiser')} manages the booking. It is non-refundable for the guests: if they cancel you are paid as for a normal stay.` });
    } catch (err) { console.error('group host email failed:', err.message); }
  }
  await releaseGroupHolds(sql, g, 'paid');
  const byRest = claims.some(c => c.kind === 'gap');
  const outcome = byRest ? `Confirmed: ${g.organiser_first_name || 'the organiser'} paid the rest, so all ${g.places} places are paid.` : `Confirmed: all ${g.places} places paid.`;
  const done = (await sql`UPDATE group_bookings SET status = 'confirmed', order_id = ${orderId}, outcome = ${outcome} WHERE id = ${g.id} AND status = 'confirming' RETURNING id`)[0];
  if (!done) return { outcome, orderId };
  // Everyone who paid: the confirmation email, with the non-refundable warning.
  const warning = `<p style="background:#fff4e5; border:1px solid #e8c48a; border-radius:8px; padding:10px 12px; font-size:13px;"><strong>This group booking is non-refundable.</strong> If plans change, nothing is refunded, whatever the listing’s cancellation policy (any deposit is still refunded to each payer). If Aerva approves a cancellation for a natural disaster or government order, or the host cancels, each person gets their own share as Aerva credit (refundable to their payment any time); if Aerva’s check-in promise is not kept, each person is refunded in full.</p>`;
  const byPerson = new Map();
  claims.forEach(c => { const p = byPerson.get(c.guest_id) || { email: c.email, first: c.first_name, places: 0, paid: 0 }; p.places += c.places; p.paid += c.amount; byPerson.set(c.guest_id, p); });
  let pdf = null;
  try { pdf = await CB.generateBookingConfirmationPdf(ctx.stays, [], ctx.razorpayOrderId, 'INR', 0, codes); } catch (e) { pdf = null; }
  for (const [gid, p] of byPerson) {
    const isOrg = Number(gid) === Number(g.organiser_guest_id);
    const extra = `<p><strong>Group booking</strong> — ${detail.guests} guest${detail.guests === 1 ? '' : 's'}, organised by ${esc(g.organiser_first_name || 'your friend')}. Your share: you paid <strong>${inr(p.paid)}</strong>${p.places ? ` for ${p.places} place${p.places === 1 ? '' : 's'}` : ''}${isOrg && byRest ? ' (including the rest you paid at 2 hours)' : ''}.</p>
      ${isOrg ? '<p>You manage this booking from My Bookings.</p>' : `<p>${esc(g.organiser_first_name || 'The organiser')} manages this booking. It is in your My Bookings with the check-in details and the group’s messages with the host.</p>`}
      ${warning}`;
    try { await CB.sendBookingConfirmationEmail(p.email, ctx.stays, [], isOrg ? pdf : null, ctx.agreement.version, codes, extra); }
    catch (err) { console.error('group confirmation email failed:', err.message); }
  }
  // The group's notices (guests added) go into the booking's Messages first.
  for (const n of (Array.isArray(g.notices) ? g.notices : [])) if (n && n.text) await threadNotice(sql, orderId, String(n.text));
  await threadNotice(sql, orderId, byRest ? `Group booking confirmed: ${g.organiser_first_name || 'the organiser'} paid the rest at 2 hours; all ${g.places} places are paid. Non-refundable.` : `Group booking confirmed: all ${g.places} places paid by ${byPerson.size} people. Non-refundable.`);
  await logAudit(sql, { action: 'group_booking_confirmed', success: true, actorType: 'system', targetType: 'order', targetId: orderId,
    metadata: { groupId: g.id, places: g.places, guests: detail.guests, total, paid: paidToward(claims), byRest, payers: [...byPerson.values()].map(p => ({ email: p.email, places: p.places, paid: p.paid })) } });
  return { outcome, orderId };
}

// A notice from Aerva in the booking's Messages (everyone in the group sees it).
async function threadNotice(sql, orderId, text) {
  try {
    const o = (await sql`SELECT o.id, o.listing_id, o.guest_id, o.guest_email, l.host_id FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${orderId}`)[0];
    if (!o) return;
    let conv = (await sql`SELECT id FROM conversations WHERE order_id = ${orderId}`)[0];
    if (!conv) conv = (await sql`INSERT INTO conversations (order_id, listing_id, guest_id, guest_email, host_id) VALUES (${orderId}, ${o.listing_id}, ${o.guest_id}, ${o.guest_email}, ${o.host_id}) RETURNING id`)[0];
    await sql`INSERT INTO messages (conversation_id, sender_type, original_text, display_text) VALUES (${conv.id}, 'system', ${text}, ${text})`;
  } catch (err) { console.error('group thread notice not posted:', err.message); }
}

// Ended before it became a booking: every payment refunded in full, to its
// own payment method. opts.commitment: the organiser's unpaid rest (rupees),
// recorded on their account.
async function cancelGroup(sql, razorpay, g, reason, { from = LIVE.concat(['confirming']), commitment = null } = {}) {
  const got = (await sql`UPDATE group_bookings SET status = 'cancelled', outcome = ${reason}, decided_at = now(),
                           commitment_unpaid = COALESCE(${commitment}::int, commitment_unpaid), commitment_unpaid_at = CASE WHEN ${commitment}::int IS NULL THEN commitment_unpaid_at ELSE now() END
                         WHERE id = ${g.id} AND status = ANY(${from}) RETURNING id`)[0];
  if (!got) return null;
  // Open payment windows can no longer count.
  const open = await sql`UPDATE group_claims SET status = 'released', failed_reason = 'The group booking ended.' WHERE group_id = ${g.id} AND status = 'open' RETURNING id`;
  if (open.length) await sql`DELETE FROM group_seats WHERE claim_id = ANY(${open.map(r => r.id)})`;
  const claims = (await claimsOf(sql, g.id)).filter(c => c.status === 'paid');
  for (const c of claims) await refundClaim(sql, razorpay, c.id, c.amount * 100, reason);
  // A booking row written in the same moment (completeConfirm crashed) is cancelled too.
  try { await sql`UPDATE orders SET status = 'cancelled', cancellation_reason = ${'Group booking cancelled: ' + reason}, cancelled_at = now(), deposit_status = 'none' WHERE group_booking_id = ${g.id} AND status = 'paid'`; } catch (e) { /* none */ }
  await releaseGroupHolds(sql, g, 'closed');
  const people = new Map();
  claims.forEach(c => { const p = people.get(c.guest_id) || { email: c.email, first: c.first_name, paid: 0 }; p.paid += c.amount; people.set(c.guest_id, p); });
  const subject = reason === BOOKED ? 'This place got booked by someone else — full refund' : reason === NOT_COMPLETED ? 'Your group booking wasn’t completed — full refund' : 'Your Aerva group booking did not go ahead — full refund';
  for (const p of people.values()) {
    await sendMail(p.email, subject, frame(reason === BOOKED ? 'This place got booked by someone else' : 'The group booking did not go ahead',
      `<p>Hello ${esc(p.first || '')},</p><p>${esc(reason)}${reason === NOT_COMPLETED ? ` ${esc(g.organiser_first_name || 'The organiser')} did not pay the rest within 30 minutes of the 2-hour mark, so nothing was booked.` : ''}</p><p>${stayLine(g)}</p><p>Your payment of <strong>${inr(p.paid)}</strong> is being refunded in full to your original payment method. Refunds usually arrive in 5–7 working days.</p>
       ${reason === BOOKED || reason === UNAVAILABLE ? button('https://aerva.in/index.html', 'Find another stay') : ''}`));
  }
  if (commitment != null && !people.has(Number(g.organiser_guest_id)) && g.organiser_email) {
    await sendMail(g.organiser_email, subject, frame('The group booking did not go ahead', `<p>${esc(reason)}</p><p>${stayLine(g)}</p>`));
  }
  if (commitment != null) {
    await logAudit(sql, { action: 'group_commitment_unpaid', success: false, actorType: 'guest', actorIdentifier: g.organiser_email, targetType: 'guest', targetId: Number(g.organiser_guest_id),
      metadata: { groupId: g.id, token: g.token, unpaid: commitment, places: g.places, total: g.total } });
  }
  await logAudit(sql, { action: 'group_booking_cancelled', success: true, actorType: 'system', targetType: 'group_booking', targetId: g.id,
    metadata: { reason, refunded: [...people.values()].map(p => ({ email: p.email, amount: p.paid })), commitmentUnpaid: commitment } });
  return { outcome: reason };
}

// Two hours are up and not every place is paid: the organiser pays the rest
// (their commitment) within 30 minutes. The place is still not held.
async function askRest(sql, razorpay, g) {
  const claims = await claimsOf(sql, g.id);
  const P = paidPlaces(claims), rest = restOf(g, claims);
  const got = (await sql`
    UPDATE group_bookings SET status = 'awaiting_gap', paid_places = ${P}, gap = ${rest}, confirm_by = now() + make_interval(mins => ${CONFIRM_MINUTES}),
      requote = NULL, requote_total = NULL
    WHERE id = ${g.id} AND status = 'open' RETURNING *`)[0];
  if (!got) return null;
  const text = `2 hours are up: ${P} of ${g.places} places are paid. ${g.organiser_first_name || 'The organiser'} has 30 minutes to pay the remaining ${inr(rest)} to confirm the booking.`;
  await addNotice(sql, g, text);
  await sendMail(g.organiser_email, `Pay the remaining ${inr(rest)} to confirm your group booking`, frame(`Pay the remaining ${inr(rest)} to confirm`,
    `<p>Hello ${esc(g.organiser_first_name || '')},</p><p>${P} of ${g.places} places were paid for ${stayLine(g)}${topupOwed(g, claims) > 0 ? ', and the balance owed after a guest was added was not paid' : ''}.</p>
     <p>As you agreed when you started the group, please pay the remaining <strong>${inr(rest)}</strong> within <strong>30 minutes</strong> to confirm the booking for all ${g.places} guests.</p>
     <p>The place is not held meanwhile: if someone else books it first, everyone is refunded in full. If you don’t pay in time, nothing is booked, everyone is refunded in full, and the unpaid commitment is recorded on your account.</p>
     ${nonRefundableNote()}${button(groupLink(g.token), `Pay ${inr(rest)}`)}`));
  for (const c of claims.filter(x => x.status === 'paid' && Number(x.guest_id) !== Number(g.organiser_guest_id))) {
    await sendMail(c.email, 'Your group booking: waiting for the organiser to pay the rest', frame('Waiting for the organiser',
      `<p>Hello ${esc(c.first_name || '')},</p><p>Not every place was paid in 2 hours for ${stayLine(g)}. ${esc(g.organiser_first_name || 'The organiser')} has 30 minutes to pay the rest and confirm the booking. If it isn’t paid, you are refunded in full; we will email you either way.</p>`));
  }
  await logAudit(sql, { action: 'group_booking_short', success: true, actorType: 'system', targetType: 'group_booking', targetId: g.id,
    metadata: { places: g.places, paidPlaces: P, paid: paidToward(claims), rest, email: g.organiser_email } });
  return { rest };
}

// ---- Add a guest ----
// A notice for everyone in the group (shown on the group page; posted to
// the booking's Messages once it exists).
async function addNotice(sql, g, text) {
  if (!(await addReady(sql))) return;
  await sql`UPDATE group_bookings SET notices = COALESCE(notices, '[]'::jsonb) || ${JSON.stringify([{ at: new Date().toISOString(), text }])}::jsonb WHERE id = ${g.id}`;
}
// Everyone in the group: the organiser and each person who paid.
async function members(sql, g) {
  const rows = await sql`SELECT DISTINCT ON (guest_id) guest_id, email, first_name FROM group_claims WHERE group_id = ${g.id} AND status = 'paid' ORDER BY guest_id, id`;
  const out = new Map([[Number(g.organiser_guest_id), { email: g.organiser_email, first: g.organiser_first_name }]]);
  rows.forEach(r => { if (!out.has(Number(r.guest_id))) out.set(Number(r.guest_id), { email: r.email, first: r.first_name }); });
  return out;
}
const isMember = async (sql, g, guestId) => Number(g.organiser_guest_id) === Number(guestId)
  || (await sql`SELECT 1 FROM group_claims WHERE group_id = ${g.id} AND guest_id = ${guestId} AND status = 'paid' LIMIT 1`).length > 0;
async function tellMembers(sql, g, subject, title, html) {
  for (const p of (await members(sql, g)).values()) {
    await sendMail(p.email, subject, frame(esc(title), `<p>Hello ${esc(p.first || '')},</p>${html}<p>${stayLine(g)}</p>${button(groupLink(g.token), 'See the group')}`));
  }
}
// Guests added after confirmation, waiting to be paid (a booking change).
async function pendingAdd(sql, g) {
  if (!g.order_id) return null;
  try {
    return (await sql`SELECT * FROM booking_changes WHERE order_id = ${g.order_id} AND status = 'awaiting_payment' AND requested ? 'groupAdd' ORDER BY id DESC LIMIT 1`)[0] || null;
  } catch (e) { return null; }
}
async function capacityOf(sql, listingId) {
  const l = (await sql`SELECT max_guests FROM listings WHERE id = ${listingId}`)[0] || {};
  const cap = require('./_pricing').parseMaxGuests(l.max_guests);
  return cap > 0 ? cap : null;
}
const capacityMessage = (cap, now) => `This place takes at most ${cap} guests. Your group already has ${now}, so ${cap - now <= 0 ? 'no more guests can be added' : `you can add at most ${cap - now}`}.`;

// The new prices after adding places (see the rule at the top). Pure.
function repriceShares(g, { total, newPlaces, paidSeats, paid }) {
  const S = splitShares(total, newPlaces);
  const P = paidSeats.length;
  const F = sum(S.slice(0, P));
  const topup = Math.max(0, F - paid);
  const rest = total - Math.max(F, paid);
  const U = newPlaces - P;
  if (U < 1 || rest < U) return null;
  const open = splitShares(rest, U);
  const isPaid = new Set(paidSeats);
  let j = 0;
  const shares = Array.from({ length: newPlaces }, (_, i) => isPaid.has(i + 1) ? Number(g.shares[i]) : open[j++]);
  return { shares, topup, perPlace: open[0], lastPlace: open[open.length - 1], equalShare: S[0] };
}

// The organiser (or, while open or after confirmation, any member) adds k places.
async function addGuests(sql, razorpay, { token, guestId, places }) {
  if (!(await ready(sql)) || !(await addReady(sql))) throw userError(ADD_NOT_ON, 503);
  let g = await load(sql, { token });
  if (!g) throw userError('This group booking link is not valid.', 404);
  const k = Number(places);
  if (!Number.isInteger(k) || k < 1) throw userError('Places can only be added (choose 1 or more). Nobody can remove a place once it is added.');
  if (!(await isMember(sql, g, guestId))) throw userError('Only the organiser or someone who has paid for a place can add guests.', 403);
  g = await tick(sql, razorpay, g);
  const isOrg = Number(g.organiser_guest_id) === Number(guestId);
  const atDecision = g.status === 'awaiting_gap';
  if (g.status === 'confirmed') return addAfterConfirm(sql, razorpay, g, { guestId, k });
  if (g.status === 'open') {
    if (!(new Date(g.closes_at) > new Date())) throw userError('This group has closed. Please wait a moment for the next step.', 409);
  } else if (atDecision) {
    if (!isOrg) throw userError(`Only ${g.organiser_first_name || 'the organiser'} can add guests at this point.`, 403);
    if (Number(g.extensions) > 0) throw userError('Guests were already added once at this point. Please pay the rest to confirm the booking.', 409);
  } else throw userError('Guests can no longer be added to this group booking.', 409);
  // Capacity first.
  const cap = await capacityOf(sql, g.listing_id);
  if (cap && g.places + k > cap) throw userError(capacityMessage(cap, g.places), 400, { maxGuests: cap });
  const claims = await claimsOf(sql, g.id);
  if (claims.some(c => c.status === 'open')) throw userError('Someone in the group is paying right now. Please try again in a few minutes, once that payment is done.', 409);
  // The normal quote for the new number of guests (the added guests are adults).
  const N = g.places + k;
  const input = Object.assign({}, g.stay.input, { guests: N, adults: Math.max(1, Math.min(N, (Number(g.stay.input.adults) || g.places) + k)), includedWithExperienceId: undefined });
  const priced = await require('./_pricing').priceStay(sql, input, 0);
  if (priced.error) throw userError(String(priced.error).replace(/^Stay 1: /, ''));
  const d = priced.detail;
  const total = quoteTotal(d);
  const paidSeats = (await sql`SELECT s.seat FROM group_seats s JOIN group_claims c ON c.id = s.claim_id WHERE s.group_id = ${g.id} AND c.status = 'paid' AND c.kind = 'places' ORDER BY s.seat`).map(r => Number(r.seat));
  const paid = sum(claims.filter(c => c.status === 'paid' && (c.kind === 'places' || c.kind === 'topup')).map(c => c.amount));
  const r = repriceShares(g, { total, newPlaces: N, paidSeats, paid });
  if (!r) throw userError('The stay could not be priced for that many guests. Please raise a request in Aerva Support (Help → Raise a request).');
  const text = `Guest${k === 1 ? '' : 's'} added — now ${N} places, ${inr(r.perPlace)} each${r.lastPlace !== r.perPlace ? ` (last place ${inr(r.lastPlace)})` : ''}. The whole stay is ${inr(total)} for ${N} guests.${r.topup ? ` The places already paid now owe a balance of ${inr(r.topup)}, which anyone in the group can pay.` : ''}`;
  const notice = JSON.stringify([{ at: new Date().toISOString(), text }]);
  const stay = JSON.stringify({ input, detail: d });
  const got = atDecision
    ? (await sql`
        UPDATE group_bookings SET places = ${N}, total = ${total}, shares = ${r.shares}, stay = ${stay}::jsonb, price_version = price_version + 1, topup_due = ${r.topup},
          notices = COALESCE(notices, '[]'::jsonb) || ${notice}::jsonb, status = 'open', closes_at = now() + make_interval(mins => ${ADD_WINDOW_MINUTES}), reminded_at = now(),
          requote = NULL, requote_total = NULL, paid_places = NULL, gap = NULL, confirm_by = NULL, extensions = extensions + 1
        WHERE id = ${g.id} AND status = ${g.status} AND price_version = ${versionOf(g)} AND places = ${g.places}
          AND NOT EXISTS (SELECT 1 FROM group_claims x WHERE x.group_id = ${g.id} AND x.status = 'open')
        RETURNING *`)[0]
    : (await sql`
        UPDATE group_bookings SET places = ${N}, total = ${total}, shares = ${r.shares}, stay = ${stay}::jsonb, price_version = price_version + 1, topup_due = ${r.topup},
          notices = COALESCE(notices, '[]'::jsonb) || ${notice}::jsonb
        WHERE id = ${g.id} AND status = 'open' AND closes_at > now() AND price_version = ${versionOf(g)} AND places = ${g.places}
          AND NOT EXISTS (SELECT 1 FROM group_claims x WHERE x.group_id = ${g.id} AND x.status = 'open')
        RETURNING *`)[0];
  if (!got) throw userError('The group changed just now (a payment started or another guest was added). Please look again and retry.', 409);
  // No dates are held for the extra window either (the final rules).
  const fresh = await load(sql, { id: g.id });
  await logAudit(sql, { action: 'group_guests_added', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'group_booking', targetId: g.id,
    metadata: { added: k, places: N, before: g.places, total, totalBefore: g.total, shares: r.shares, topup: r.topup, paid, paidSeats, priceVersion: versionOf(fresh), atDecision } });
  await tellMembers(sql, fresh, `Guest added — now ${N} places, ${inr(r.perPlace)} each`, 'A guest was added to your group',
    `<p>${esc(text)}</p>${atDecision ? `<p>The group is open again for ${ADD_WINDOW_MINUTES} minutes so the new place${k === 1 ? '' : 's'} can be paid. The place is not held until the last payment; anything still unpaid then is for ${esc(g.organiser_first_name || 'the organiser')} to pay within 30 minutes.</p>` : '<p>The place is not held until the last payment.</p>'}`);
  return Object.assign(await status(sql, razorpay, g.token, guestId), { added: k });
}

// Guests added to the confirmed booking: a change to the SAME booking,
// accepted at once (no host step), waiting for its difference.
async function addAfterConfirm(sql, razorpay, g, { guestId, k }) {
  const BC = require('./_booking-changes');
  const o = (await sql`SELECT * FROM orders WHERE id = ${g.order_id}`)[0];
  if (!o || o.status !== 'paid') throw userError('This booking is no longer active, so guests cannot be added.', 409);
  const waiting = await pendingAdd(sql, g);
  if (waiting) throw userError(`${waiting.requested.groupAdd} guest${Number(waiting.requested.groupAdd) === 1 ? ' is' : 's are'} already added and waiting for payment (${inr(waiting.difference)}). Pay that first, then add more.`, 409);
  const cap = await capacityOf(sql, o.listing_id);
  if (cap && Number(o.guests) + k > cap) throw userError(capacityMessage(cap, Number(o.guests)), 400, { maxGuests: cap });
  const ob = await BC.loadBooking(sql, o.id);
  const input = { arrival: ob.arrivalStr, departure: ob.departureStr, adults: Number(o.guests) + k, children: 0, infants: 0,
    pets: Array.isArray(o.pet_types) ? o.pet_types.length : 0, petTypes: Array.isArray(o.pet_types) ? o.pet_types : [], amenityIds: ob.amenityIds };
  const qc = await BC.quoteChange(sql, o.id, null, input);
  const requested = Object.assign({}, qc.input, { groupAdd: k, groupId: g.id, addedBy: Number(guestId) });
  let c;
  try {
    c = (await sql`INSERT INTO booking_changes (order_id, guest_id, requested, quote, old_total, new_total, difference, summary, status, accepted_at, decided_at, note)
                   VALUES (${o.id}, ${g.organiser_guest_id}, ${JSON.stringify(requested)}, ${JSON.stringify(qc.quote)}, ${qc.oldTotal}, ${qc.newTotal}, ${qc.difference}, ${qc.summary},
                           'awaiting_payment', now(), now(), 'Group booking: guests added (no host approval needed)') RETURNING *`)[0];
  } catch (err) {
    if (/idx_booking_changes_open|duplicate key/.test(err.message)) throw userError('This booking already has a change waiting. Please finish or withdraw it first.', 409);
    throw err;
  }
  const N = Number(o.guests) + k;
  if (!(Number(c.difference) > 0)) {
    // Nothing more to pay (a home priced per stay): applied at once.
    await BC.applyChange(sql, razorpay, c);
    await sql`UPDATE group_bookings SET places = ${N}, total = ${c.new_total} WHERE id = ${g.id}`;
  }
  const text = Number(c.difference) > 0
    ? `Guest${k === 1 ? '' : 's'} added — now ${N} guests. The booking is now ${inr(c.new_total)}; the extra ${inr(c.difference)} is to pay (by the organiser or anyone with the link) within 24 hours.`
    : `Guest${k === 1 ? '' : 's'} added — now ${N} guests, at no extra cost.`;
  await addNotice(sql, g, text);
  await threadNotice(sql, o.id, text);
  await logAudit(sql, { action: 'group_guests_added', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'order', targetId: o.id,
    metadata: { groupId: g.id, added: k, guests: N, changeId: c.id, oldTotal: c.old_total, newTotal: c.new_total, difference: c.difference, afterConfirm: true } });
  await tellMembers(sql, g, `Guest added — now ${N} guests`, 'A guest was added to your booking', `<p>${esc(text)}</p>`);
  return Object.assign(await status(sql, razorpay, g.token, guestId), { added: k, changeId: c.id, pay: Math.max(0, Number(c.difference) || 0) });
}

// Paying for the guests added after confirmation: anyone with the link.
async function startAddedPayment(sql, razorpay, { g, guestId, firstName, lastName, email, phone, assertNotesFit }) {
  const BC = require('./_booking-changes');
  const c = await pendingAdd(sql, g);
  if (!c) throw userError('There is nothing to pay for this group booking now.', 409, { closed: true });
  if (c.accepted_at && Date.now() - new Date(c.accepted_at).getTime() > 24 * 3600e3) throw userError('The time to pay for the added guests has passed. Please add them again.', 409);
  let fresh;
  try { fresh = await BC.quoteChange(sql, c.order_id, null, c.requested, c.created_at); }
  catch (err) { await sql`UPDATE booking_changes SET status = 'expired' WHERE id = ${c.id} AND status = 'awaiting_payment'`; throw userError(`The guests can no longer be added: ${err.message}`, 409); }
  if (Math.round(fresh.newTotal) !== Number(c.new_total) || Math.round(fresh.oldTotal) !== Number(c.old_total)) {
    await sql`UPDATE booking_changes SET status = 'expired' WHERE id = ${c.id} AND status = 'awaiting_payment'`;
    throw userError('Prices have been changed recently, so the added guests were not kept. Please add them again to see the new price.', 409);
  }
  const mine = await sql`SELECT status FROM group_claims WHERE group_id = ${g.id} AND guest_id = ${guestId}`;
  if (mine.some(x => x.status === 'open')) throw userError('Your payment for this group is already open. Finish it there, or wait 3 minutes and try again.', 409);
  if (mine.length >= MAX_CLAIMS_PER_PERSON) throw userError('Too many payment attempts for this group from your account. Please raise a request in Aerva Support (Help → Raise a request).', 429);
  let claim;
  try {
    claim = (await sql`
      INSERT INTO group_claims (group_id, guest_id, first_name, last_name, email, phone, kind, places, amount, expires_at, change_id, nonrefundable_ack_at)
      VALUES (${g.id}, ${guestId}, ${firstName}, ${lastName}, ${email}, ${phone || null}, 'change', ${Number(c.requested.groupAdd) || 0}, ${c.difference},
              now() + make_interval(secs => ${HOLD_SECONDS}), ${c.id}, now())
      RETURNING *`)[0];
  } catch (err) {
    if (/idx_group_claims_one_open_extra|duplicate key/.test(err.message)) throw userError('Someone in the group is paying for the added guests right now. If that payment does not go through, try again in a few minutes.', 409);
    throw err;
  }
  let order;
  try { order = await razorpayOrderFor(razorpay, claim, g, assertNotesFit); }
  catch (err) { await releaseClaim(sql, claim.id, 'released', 'The payment could not be started.'); throw err; }
  await sql`UPDATE group_claims SET razorpay_order_id = ${order.id} WHERE id = ${claim.id}`;
  await logAudit(sql, { action: 'booking_order_created', success: true, actorType: 'guest', actorIdentifier: email || null, targetType: 'group_booking', targetId: g.id,
    metadata: { razorpayOrderId: order.id, group: true, groupId: g.id, claimId: claim.id, kind: 'change', changeId: c.id, amount: c.difference } });
  return { order, amount: Number(c.difference), seats: [], holdSeconds: HOLD_SECONDS, claimId: claim.id };
}

async function confirmAddedPayment(sql, razorpay, { g, claim, payment, order, late }) {
  const BC = require('./_booking-changes');
  const c = claim.change_id ? (await sql`SELECT * FROM booking_changes WHERE id = ${claim.change_id}`)[0] : null;
  let reason = null;
  if (Number(payment.amount) !== Number(order.amount) || Number(order.amount) !== claim.amount * 100 || (payment.currency || 'INR') !== 'INR') reason = 'The amount paid did not match the amount for the added guests, so it was not counted.';
  else if (claim.status === 'released' || late) reason = 'The payment was completed after its 3-minute payment window had ended.';
  else if (claim.status !== 'open') reason = 'This payment attempt had already been closed.';
  else if (!c || c.status !== 'awaiting_payment' || Number(c.difference) !== Number(claim.amount)) reason = 'The added guests had already been paid for, or were no longer waiting for payment.';
  if (reason) return rejectPayment(sql, razorpay, claim, payment, reason);
  const marked = await sql`UPDATE group_claims SET status = 'paid', razorpay_payment_id = ${payment.id}, paid_at = now() WHERE id = ${claim.id} AND status = 'open' RETURNING id`;
  if (!marked.length) return rejectPayment(sql, razorpay, claim, payment, 'This payment attempt had already been closed.');
  // Priced again now: the same total as when the guests were added.
  try {
    const fresh = await BC.quoteChange(sql, c.order_id, null, c.requested, c.created_at);
    if (Math.round(fresh.newTotal) !== Number(c.new_total) || Math.round(fresh.oldTotal) !== Number(c.old_total)) throw userError('The price changed while the payment was being made, so the guests were not added.');
    // Applied to the same booking straight away. The payment is kept on the
    // group's claim (not on the change), so refunds and Accounts count it once.
    await BC.applyChange(sql, razorpay, c, { paymentId: null });
  } catch (err) {
    await sql`UPDATE booking_changes SET status = 'failed' WHERE id = ${c.id} AND status = 'awaiting_payment'`;
    return rejectPayment(sql, razorpay, claim, payment, err.isUserFacing ? err.message : 'The guests could not be added to the booking.');
  }
  const k = Number(c.requested.groupAdd) || 0;
  const N = Number(c.requested.adults || 0) + Number(c.requested.children || 0);
  await sql`UPDATE group_bookings SET places = ${N}, total = ${c.new_total} WHERE id = ${g.id}`;
  const text = `${claim.first_name || 'A member'} paid ${inr(claim.amount)} for ${k} added guest${k === 1 ? '' : 's'}: the booking is now for ${N} guests (${inr(c.new_total)}), confirmed.`;
  await addNotice(sql, g, text);
  await threadNotice(sql, c.order_id, text);
  await logAudit(sql, { action: 'group_guests_paid', success: true, actorType: 'guest', actorIdentifier: claim.email, targetType: 'order', targetId: c.order_id,
    metadata: { groupId: g.id, claimId: claim.id, changeId: c.id, amount: claim.amount, paymentId: payment.id, guests: N, newTotal: c.new_total } });
  await tellMembers(sql, g, `Booking updated — now ${N} guests`, 'The added guests are confirmed', `<p>${esc(text)}</p>`);
  return { status: 'confirmed', group: { token: g.token, kind: 'change', guests: N } };
}

// The balance the paid places owe after a guest was added: the organiser or
// any member pays it, in one payment.
async function startTopupPayment(sql, razorpay, { token, guestId, firstName, lastName, email, phone, assertNotesFit }) {
  if (!(await ready(sql)) || !(await addReady(sql))) throw userError(ADD_NOT_ON, 503);
  let g = await load(sql, { token });
  if (!g) throw userError('This group booking link is not valid.', 404);
  if (!(await isMember(sql, g, guestId))) throw userError('Only the organiser or someone who has paid for a place can pay the balance.', 403);
  g = await tick(sql, razorpay, g);
  if (g.status !== 'open' || !(new Date(g.closes_at) > new Date())) throw userError('This group booking is closed to new payments.', 409, { closed: true });
  const owed = topupOwed(g, await claimsOf(sql, g.id));
  if (!(owed > 0)) throw userError('There is no balance to pay.', 409);
  const mine = await sql`SELECT status FROM group_claims WHERE group_id = ${g.id} AND guest_id = ${guestId}`;
  if (mine.some(x => x.status === 'open')) throw userError('Your payment for this group is already open. Finish it there, or wait 3 minutes and try again.', 409);
  if (mine.length >= MAX_CLAIMS_PER_PERSON) throw userError('Too many payment attempts for this group from your account. Please raise a request in Aerva Support (Help → Raise a request).', 429);
  let claim;
  try {
    claim = (await sql`
      INSERT INTO group_claims (group_id, guest_id, first_name, last_name, email, phone, kind, places, amount, expires_at, price_version, nonrefundable_ack_at)
      VALUES (${g.id}, ${guestId}, ${firstName}, ${lastName}, ${email}, ${phone || null}, 'topup', 0, ${owed},
              LEAST(now() + make_interval(secs => ${HOLD_SECONDS}), ${g.closes_at}::timestamptz), ${versionOf(g)}, now())
      RETURNING *`)[0];
  } catch (err) {
    if (/idx_group_claims_one_open_extra|duplicate key/.test(err.message)) throw userError('Someone in the group is paying the balance right now. If that payment does not go through, try again in a few minutes.', 409);
    throw err;
  }
  const now = (await sql`SELECT price_version FROM group_bookings WHERE id = ${g.id}`)[0];
  if (versionOf(now) !== versionOf(g)) {
    await releaseClaim(sql, claim.id, 'released', 'A guest was added while the payment was being started.');
    throw userError('A guest was just added to this group, so the balance changed. Please check the new amount and try again.', 409);
  }
  // The last amount (every place paid or being paid): the place is held for its window.
  if (await coversTheRest(sql, g, claim)) await takeFinalHold(sql, razorpay, g, claim);
  let order;
  try { order = await razorpayOrderFor(razorpay, claim, g, assertNotesFit); }
  catch (err) { await releaseClaim(sql, claim.id, 'released', 'The payment could not be started.'); throw err; }
  await attachOrder(sql, claim, order.id);
  const secs = (await sql`SELECT GREATEST(0, ceil(extract(epoch FROM expires_at - now())))::int AS s FROM group_claims WHERE id = ${claim.id}`)[0].s;
  await logAudit(sql, { action: 'booking_order_created', success: true, actorType: 'guest', actorIdentifier: email || null, targetType: 'group_booking', targetId: g.id,
    metadata: { razorpayOrderId: order.id, group: true, groupId: g.id, claimId: claim.id, kind: 'topup', amount: owed } });
  return { order, amount: owed, seats: [], holdSeconds: secs, claimId: claim.id };
}
// ---- Moving a group along: called by the job, and whenever it is looked at ----
async function tick(sql, razorpay, g) {
  if (!g) return g;
  await sweepClaims(sql, g.id);
  const now = Date.now();
  if (g.status === 'starting') {
    // The organiser's first window ended without a payment.
    const open = await sql`SELECT 1 FROM group_claims WHERE group_id = ${g.id} AND status IN ('open', 'paid')`;
    if (!open.length) await sql`UPDATE group_bookings SET status = 'failed', outcome = 'The first payment was not completed, so the group was not opened.' WHERE id = ${g.id} AND status = 'starting'`;
  } else if (g.status === 'open' || g.status === 'awaiting_gap' || g.status === 'awaiting_confirm') {
    const claims = await claimsOf(sql, g.id);
    // Booked (or closed) by someone else meanwhile: everyone refunded in full.
    // (While a last-share payment holds the place nobody else can book it.)
    const taken = razorpay ? await placeTaken(sql, g) : null;
    if (taken) await cancelGroup(sql, razorpay, g, taken);
    else if (g.status === 'open') {
      if (isComplete(g, claims)) await finalize(sql, razorpay, g, ['open']);
      else if (now >= new Date(g.closes_at).getTime()) {
        if (!claims.some(c => c.status === 'open')) await askRest(sql, razorpay, g);
      } else if (!g.reminded_at && now >= new Date(g.closes_at).getTime() - REMIND_BEFORE_MINUTES * 60e3) {
        const claimed = await sql`UPDATE group_bookings SET reminded_at = now() WHERE id = ${g.id} AND reminded_at IS NULL RETURNING id`;
        if (claimed.length) {
          const P = paidPlaces(claims);
          await sendMail(g.organiser_email, '30 minutes left for your group booking', frame('30 minutes left',
            `<p>Hello ${esc(g.organiser_first_name || '')},</p><p>${P} of ${g.places} places are paid for ${stayLine(g)}. Your group closes in about 30 minutes. Remind your friends to pay for their places — as you agreed, any places still unpaid then (${inr(restOf(g, claims))} now) are yours to pay within 30 minutes.</p>${button(groupLink(g.token), 'Open the group page')}`));
          await logAudit(sql, { action: 'group_booking_reminder', success: true, actorType: 'system', targetType: 'group_booking', targetId: g.id, metadata: { email: g.organiser_email, paidPlaces: P, places: g.places } });
        }
      }
    } else {
      // Waiting for the organiser's rest (an older 'awaiting_confirm' row is treated the same).
      if (claims.some(c => c.kind === 'gap' && c.status === 'paid')) await finalize(sql, razorpay, g, ['awaiting_gap', 'awaiting_confirm']);
      else if (now >= new Date(g.confirm_by).getTime() + GRACE_SECONDS * 1000 && !claims.some(c => c.kind === 'gap' && c.status === 'open')) {
        await cancelGroup(sql, razorpay, g, NOT_COMPLETED, { from: ['awaiting_gap', 'awaiting_confirm'], commitment: restOf(g, claims) });
      }
    }
  } else if (g.status === 'confirming' && g.decided_at && now - new Date(g.decided_at).getTime() > 2 * 60e3) {
    // A confirmation that stopped half-way: finished (never written twice).
    await completeConfirm(sql, razorpay, g);
  }
  return load(sql, { id: g.id });
}

// An outside booking was just confirmed (_confirm-booking.js): any group still
// collecting money for those dates ends at once, everyone refunded in full.
// Never throws.
async function onOutsideBooking(sql, razorpay, stays) {
  const out = [];
  try {
    if (!razorpay || !(await ready(sql))) return out;
    for (const s of (stays || [])) {
      if (!s || !s.listingId || !s.arrival || !s.departure) continue;
      const rows = await sql`SELECT id FROM group_bookings WHERE status IN ('open', 'awaiting_gap', 'awaiting_confirm') AND listing_id = ${s.listingId}
                               AND COALESCE(room_id, 0) = ${s.roomId || 0} AND arrival < ${s.departure}::date AND departure > ${s.arrival}::date`;
      for (const r of rows) {
        const g = await load(sql, { id: r.id });
        if ((await placeTaken(sql, g)) !== BOOKED) continue;
        if (await cancelGroup(sql, razorpay, g, BOOKED)) out.push(g.id);
      }
    }
  } catch (err) { console.error('group check after an outside booking failed (the job checks again):', err.message); }
  return out;
}

// Job 'group_bookings' (get-listings.js), every 5 minutes.
async function runJob(sql, razorpay, { deadlineMs = 4000 } = {}) {
  const started = Date.now();
  const out = { checked: 0, confirmed: 0, payTheRest: 0, cancelled: 0, bookedElsewhere: 0, notCompleted: 0, reminded: 0, refundRetries: 0, affected: [] };
  if (!(await ready(sql))) return { ...out, skipped: 'database update not applied yet' };
  if (!razorpay) return { ...out, skipped: 'Razorpay keys not set' };
  await sweepClaims(sql);
  const groups = await sql`SELECT id, status FROM group_bookings WHERE status IN ('starting', 'open', 'awaiting_confirm', 'awaiting_gap', 'confirming') ORDER BY closes_at NULLS FIRST LIMIT 30`;
  for (const r of groups) {
    if (Date.now() - started > deadlineMs) break;
    out.checked++;
    try {
      const before = await load(sql, { id: r.id });
      const after = await tick(sql, razorpay, before);
      if (after.status === 'confirmed' && before.status !== 'confirmed') out.confirmed++;
      else if (after.status === 'cancelled' && before.status !== 'cancelled') {
        out.cancelled++;
        if (after.outcome === BOOKED || after.outcome === UNAVAILABLE) out.bookedElsewhere++;
        if (after.outcome === NOT_COMPLETED) out.notCompleted++;
        out.affected.push({ groupId: after.id, organiser: after.organiser_email, outcome: after.outcome });
      }
      else if (after.status === 'awaiting_gap' && before.status === 'open') { out.payTheRest++; out.affected.push({ groupId: after.id, organiser: after.organiser_email, rest: after.gap }); }
      if (after.reminded_at && !before.reminded_at) out.reminded++;
    } catch (err) { console.error('group tick failed:', r.id, err.message); }
  }
  // Refunds that failed (a Razorpay hiccup) are tried again after 15 minutes.
  const retry = await sql`SELECT id, refund_amount, refund_reason FROM group_claims WHERE refund_status = 'failed' AND refund_claimed_at < now() - interval '15 minutes' LIMIT 10`;
  for (const c of retry) {
    if (Date.now() - started > deadlineMs) break;
    const r = await refundClaim(sql, razorpay, c.id, c.refund_amount, c.refund_reason);
    if (r && r.id) out.refundRetries++;
  }
  return out;
}

// ---- What the group page shows ----
async function status(sql, razorpay, token, viewerGuestId = null) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  let g = await load(sql, { token });
  if (!g) throw userError('This group booking link is not valid.', 404);
  if (razorpay) g = await tick(sql, razorpay, g);
  const claims = await claimsOf(sql, g.id);
  const seatsTaken = (await sql`SELECT count(*)::int AS n FROM group_seats s JOIN group_claims c ON c.id = s.claim_id WHERE s.group_id = ${g.id}`)[0].n;
  const l = (await sql`SELECT property_name, city, to_jsonb(listings)->>'area' AS area, cover_photo_url, check_in_time, check_out_time, cancellation_policy, max_guests FROM listings WHERE id = ${g.listing_id}`)[0] || {};
  const P = paidPlaces(claims);
  const v2 = await addReady(sql);
  // The places nobody holds, lowest first (as takeSeats takes them): their prices.
  const held = new Set((await sql`SELECT seat FROM group_seats WHERE group_id = ${g.id}`).map(r => Number(r.seat)));
  const freeShares = g.shares.map((x, i) => ({ seat: i + 1, x: Number(x) })).filter(s => !held.has(s.seat)).map(s => s.x);
  const secs = (t) => t ? Math.max(0, Math.ceil((new Date(t).getTime() - Date.now()) / 1000)) : null;
  const isOrg = viewerGuestId != null && Number(viewerGuestId) === Number(g.organiser_guest_id);
  const mineClaims = claims.filter(c => viewerGuestId != null && Number(c.guest_id) === Number(viewerGuestId));
  const payers = [];
  claims.filter(c => c.status === 'paid' && (c.kind === 'places' || c.kind === 'change')).forEach(c => {
    const p = payers.find(x => x.guestId === c.guest_id);
    if (p) p.places += c.places; else payers.push({ guestId: c.guest_id, firstName: c.first_name || 'Guest', places: c.places, organiser: Number(c.guest_id) === Number(g.organiser_guest_id) });
  });
  const failed = claims.filter(c => (c.status === 'failed' || (c.status === 'released' && c.failed_reason && !/cancelled/.test(c.failed_reason))) && c.kind === 'places' && c.razorpay_order_id)
    .slice(-5).map(c => ({ firstName: c.first_name || 'Someone', places: c.places, note: c.status === 'failed' ? 'Payment didn’t go through — place still open' : 'Payment not completed in time — place still open', at: c.created_at }));
  const rejected = claims.filter(c => c.status === 'rejected').map(c => ({ firstName: c.first_name || 'Someone', note: 'Payment not counted — refunded in full', reason: c.failed_reason }));
  const out = {
    token: g.token, status: g.status, outcome: g.outcome || null,
    stay: { listingId: g.listing_id, name: l.property_name || g.stay.detail.suite, city: l.city || null, area: l.area || null, photo: l.cover_photo_url || null,
            arrival: dateStr(g.arrival), departure: dateStr(g.departure), nights: g.stay.detail.nights, checkIn: l.check_in_time || null, checkOut: l.check_out_time || null },
    places: g.places, total: g.total, shares: g.shares, freeShares,
    // What a place still to pay costs now (paid places keep what they paid).
    perPlace: freeShares.length ? freeShares[0] : g.shares[0], lastPlace: freeShares.length ? freeShares[freeShares.length - 1] : g.shares[g.shares.length - 1],
    paidPlaces: P, placesLeft: Math.max(0, g.places - seatsTaken), beingPaid: Math.max(0, seatsTaken - P),
    payers: payers.map(p => ({ firstName: p.firstName, places: p.places, organiser: p.organiser })), failed, rejected,
    secondsLeft: g.status === 'open' ? secs(g.closes_at) : null, closesAt: g.closes_at, confirmSecondsLeft: ['awaiting_confirm', 'awaiting_gap'].includes(g.status) ? secs(g.confirm_by) : null,
    // The final rules (10 Nov 2026): not held until the last payment; non-refundable once confirmed.
    datesHeld: claims.some(c => c.status === 'open' && c.hold_id), notHeldNotice: 'The place is not held until the last payment. Anyone else can still book these dates; if that happens, everyone who paid is refunded in full.',
    nonRefundable: true, nonRefundableText: NONREF_TICK, commitmentText: COMMIT_TICK,
    outcomeKind: g.outcome === BOOKED ? 'booked' : g.outcome === UNAVAILABLE ? 'unavailable' : g.outcome === NOT_COMPLETED ? 'not_completed' : null,
    paidSoFar: paidToward(claims), restNow: ['open', 'awaiting_gap', 'awaiting_confirm'].includes(g.status) ? restOf(g, claims) : 0,
    organiserFirstName: g.organiser_first_name || null, isOrganiser: isOrg, signedIn: viewerGuestId != null,
    myPlaces: sum(mineClaims.filter(c => c.status === 'paid' && (c.kind === 'places' || c.kind === 'change')).map(c => c.places)),
    myPaid: sum(mineClaims.filter(c => c.status === 'paid').map(c => c.amount)),
    myRefunded: sum(mineClaims.filter(c => c.status === 'paid' && c.refund_status && c.refund_status !== 'failed').map(c => Math.round(Number(c.refund_amount || 0) / 100))),
    myOpenPayment: mineClaims.some(c => c.status === 'open'),
    policy: 'Non-refundable group booking: no refund if plans change, whatever the listing’s policy (any deposit is refunded).',
    orderId: g.order_id && (isOrg || mineClaims.some(c => c.status === 'paid')) ? g.order_id : null
  };
  // Add a guest.
  out.addOn = v2;
  out.notices = v2 && Array.isArray(g.notices) ? g.notices.slice(-10).map(n => ({ at: n.at || null, text: String(n.text || '') })) : [];
  if (v2) {
    const cap = require('./_pricing').parseMaxGuests(l.max_guests);
    const member = isOrg || claims.some(c => viewerGuestId != null && Number(c.guest_id) === Number(viewerGuestId) && c.status === 'paid');
    const pend = g.status === 'confirmed' ? await pendingAdd(sql, g) : null;
    const guestsNow = g.status === 'confirmed' && g.order_id ? Number(((await sql`SELECT guests FROM orders WHERE id = ${g.order_id}`)[0] || {}).guests || g.places) : g.places;
    const atDecision = g.status === 'awaiting_gap' && !claims.some(c => c.kind === 'gap' && c.status === 'open');
    out.maxGuests = cap > 0 ? cap : null;
    out.guestsNow = guestsNow;
    out.canAddMax = out.maxGuests ? Math.max(0, out.maxGuests - guestsNow) : 10;
    out.extraWindow = g.status === 'open' && Number(g.extensions) > 0;
    out.canAdd = !!member && !pend && ((g.status === 'open' && out.secondsLeft > 0) || (atDecision && isOrg && !(Number(g.extensions) > 0))
      || (g.status === 'confirmed' && g.order_id && ((await sql`SELECT status FROM orders WHERE id = ${g.order_id}`)[0] || {}).status === 'paid'));
    const owed = topupOwed(g, claims);
    out.topup = owed > 0 || Number(g.topup_due) > 0 ? { due: Number(g.topup_due) || 0, owed, beingPaid: claims.some(c => c.kind === 'topup' && c.status === 'open'), canPay: !!member && owed > 0 && g.status === 'open' } : null;
    out.pendingAdd = pend ? { guests: Number(pend.requested.groupAdd) || 0, amount: Number(pend.difference), newTotal: Number(pend.new_total), oldTotal: Number(pend.old_total),
      beingPaid: claims.some(c => c.kind === 'change' && c.status === 'open'), payBy: new Date(new Date(pend.accepted_at || pend.created_at).getTime() + 24 * 3600e3).toISOString() } : null;
  }
  // At 2 hours: the organiser pays the rest within 30 minutes.
  if (g.status === 'awaiting_gap' || g.status === 'awaiting_confirm') {
    out.rest = { amount: restOf(g, claims), paidPlaces: P, secondsLeft: secs(g.confirm_by), beingPaid: claims.some(c => c.kind === 'gap' && c.status === 'open'), canPay: isOrg };
  }
  return out;
}
// Before sign-in: the stay and the per-place amount only (no names).
async function publicPreview(sql, token) {
  if (!(await ready(sql))) return { error: NOT_ON, status: 503 };
  const g = await load(sql, { token });
  if (!g) return { error: 'This group booking link is not valid.', status: 404 };
  const l = (await sql`SELECT property_name, city, cover_photo_url FROM listings WHERE id = ${g.listing_id}`)[0] || {};
  return { token: g.token, status: g.status, organiserFirstName: g.organiser_first_name || null,
    stay: { name: l.property_name || g.stay.detail.suite, city: l.city || null, photo: l.cover_photo_url || null, arrival: dateStr(g.arrival), departure: dateStr(g.departure), nights: g.stay.detail.nights },
    places: g.places, perPlace: g.shares[0], lastPlace: g.shares[g.shares.length - 1],
    ...(await (async () => {
      if (!(await addReady(sql))) return {};
      const held = new Set((await sql`SELECT seat FROM group_seats WHERE group_id = ${g.id}`).map(r => Number(r.seat)));
      const free = g.shares.filter((x, i) => !held.has(i + 1)).map(Number);
      const pend = g.status === 'confirmed' ? await pendingAdd(sql, g) : null;
      return Object.assign(free.length && g.status === 'open' ? { perPlace: free[0], lastPlace: free[free.length - 1] } : {},
        pend ? { pendingAdd: { guests: Number(pend.requested.groupAdd) || 0, amount: Number(pend.difference) } } : {});
    })()),
    secondsLeft: g.status === 'open' && g.closes_at ? Math.max(0, Math.ceil((new Date(g.closes_at).getTime() - Date.now()) / 1000)) : null };
}

// ---- My Bookings ----
// The organiser's booking row gets its group; friends get "Group booking —
// you paid for N places" (check-in info and Messages, no actions); groups
// still collecting or waiting, and recent ones that did not go ahead, show
// as notices with a link to the group page.
async function decorateBookings(sql, guestId, bookings) {
  if (!(await ready(sql))) return bookings;
  try {
    const mine = await sql`
      SELECT g.*, (SELECT COALESCE(sum(c.places), 0)::int FROM group_claims c WHERE c.group_id = g.id AND c.guest_id = ${guestId} AND c.status = 'paid' AND c.kind IN ('places', 'change')) AS my_places,
             (SELECT COALESCE(sum(c.amount), 0)::int FROM group_claims c WHERE c.group_id = g.id AND c.guest_id = ${guestId} AND c.status = 'paid') AS my_paid,
             (SELECT COALESCE(sum(c.places), 0)::int FROM group_claims c WHERE c.group_id = g.id AND c.status = 'paid' AND c.kind IN ('places', 'change')) AS paid_total
      FROM group_bookings g
      WHERE g.status <> 'starting' AND (g.organiser_guest_id = ${guestId} OR EXISTS (SELECT 1 FROM group_claims c WHERE c.group_id = g.id AND c.guest_id = ${guestId} AND c.status IN ('paid', 'rejected')))
        AND (g.status IN ('open', 'awaiting_confirm', 'awaiting_gap', 'confirming', 'confirmed') OR g.decided_at > now() - interval '14 days')
      ORDER BY g.id DESC LIMIT 30`;
    for (const g of mine) {
      const isOrg = Number(g.organiser_guest_id) === Number(guestId);
      const b = g.order_id ? bookings.find(x => Number(x.id) === Number(g.order_id)) : null;
      // Non-refundable group booking: each person's own share is shown.
      if (b) { b.group = { token: g.token, places: g.places, paidPlaces: g.paid_total, organiser: isOrg, myPlaces: g.my_places, myPaid: g.my_paid, nonRefundable: true, label: 'Non-refundable group booking' }; continue; }
      if (g.status === 'confirmed' && g.order_id && !isOrg && g.my_paid > 0) {
        const o = (await sql`SELECT o.id, o.suite_name, o.listing_id, o.arrival, o.departure, o.nights, o.guests, o.status, to_jsonb(o)->>'confirmation_code' AS confirmation_code,
                                    l.property_name, l.city, to_jsonb(l)->>'area' AS area, l.formatted_address, l.check_in_time, l.check_out_time, COALESCE(l.listing_type, 'stay') AS listing_type,
                                    (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date AS local_today
                             FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${g.order_id}`)[0];
        if (!o) continue;
        bookings.push({ id: o.id, shared: 'group', group: { token: g.token, places: g.places, myPlaces: g.my_places, myPaid: g.my_paid, organiser: false, organiserFirstName: g.organiser_first_name, nonRefundable: true, label: 'Non-refundable group booking' },
          you_paid: g.my_paid, suite_name: o.suite_name, listing_id: o.listing_id, listing_type: o.listing_type, arrival: dateStr(o.arrival), departure: dateStr(o.departure),
          nights: o.nights, guests: o.guests, status: o.status, confirmation_code: o.status === 'paid' ? o.confirmation_code : null, listing_name: o.property_name,
          listing_city: o.city, listing_area: o.area, listing_address: o.status === 'paid' ? o.formatted_address : null, check_in_time: o.check_in_time, check_out_time: o.check_out_time,
          local_today: dateStr(o.local_today), can_change: false, can_cancel_request: false, can_report: false, review_state: null });
        continue;
      }
      if (g.status === 'confirmed') continue;
      const st = typeof g.stay === 'string' ? JSON.parse(g.stay) : g.stay;
      const note = g.status === 'open' ? `Group booking open — ${g.paid_total} of ${g.places} places paid. Not held until the last payment.`
        : g.status === 'awaiting_confirm' || g.status === 'awaiting_gap' ? (isOrg ? `Action needed: pay the remaining ₹${Number(g.gap || 0).toLocaleString('en-IN')} to confirm` : `Waiting for ${g.organiser_first_name || 'the organiser'} to pay the rest`)
        : g.status === 'confirming' ? 'Being confirmed…'
        : (g.outcome || 'Did not go ahead') + (g.my_paid ? ` Your ${'₹' + Number(g.my_paid).toLocaleString('en-IN')} is refunded in full.` : '');
      bookings.push({ id: 'g' + g.id, pending_group: true, group: { token: g.token, places: g.places, paidPlaces: g.paid_total, organiser: isOrg, myPlaces: g.my_places, status: g.status, note },
        suite_name: st && st.detail ? st.detail.suite : 'Group booking', listing_id: g.listing_id, arrival: dateStr(g.arrival), departure: dateStr(g.departure),
        guests: g.places, status: g.status === 'cancelled' || g.status === 'failed' ? 'cancelled' : 'group_pending', you_paid: g.my_paid, can_change: false, can_cancel_request: false });
    }
  } catch (err) { console.error('group bookings not added:', err.message); }
  return bookings;
}

// ---- Admin: the groups list, and organisers' unpaid commitments ----
async function adminList(sql, { limit = 100 } = {}) {
  if (!(await ready(sql))) return { notReady: true, groups: [], commitments: [] };
  const rows = await sql`
    SELECT g.id, g.token, g.status, g.places, g.total, g.listing_id, g.arrival, g.departure, g.organiser_guest_id, g.organiser_first_name, g.organiser_last_name, g.organiser_email,
           g.outcome, g.order_id, g.created_at, g.closes_at, g.confirm_by, g.gap, g.commitment_at, g.commitment_unpaid, g.commitment_unpaid_at, l.property_name,
           (SELECT COALESCE(sum(c.amount), 0)::int FROM group_claims c WHERE c.group_id = g.id AND c.status = 'paid') AS paid,
           (SELECT COALESCE(sum(c.places), 0)::int FROM group_claims c WHERE c.group_id = g.id AND c.status = 'paid' AND c.kind = 'places') AS paid_places,
           (SELECT count(DISTINCT c.guest_id)::int FROM group_claims c WHERE c.group_id = g.id AND c.status = 'paid') AS payers,
           (SELECT COALESCE(sum(c.refund_amount), 0)::int FROM group_claims c WHERE c.group_id = g.id AND c.refund_status IN ('processed', 'pending')) AS refunded_paise
    FROM group_bookings g LEFT JOIN listings l ON l.id = g.listing_id
    ORDER BY g.id DESC LIMIT ${Math.min(500, Math.max(1, Number(limit) || 100))}`;
  const groups = rows.map(r => ({ id: r.id, token: r.token, status: r.status, listing: r.property_name || '', listingId: r.listing_id, arrival: dateStr(r.arrival), departure: dateStr(r.departure),
    places: r.places, paidPlaces: r.paid_places, payers: r.payers, total: Number(r.total), paid: Number(r.paid), refunded: Math.round(Number(r.refunded_paise) / 100),
    organiser: { guestId: r.organiser_guest_id, name: [r.organiser_first_name, r.organiser_last_name].filter(Boolean).join(' '), email: r.organiser_email },
    committedAt: r.commitment_at, rest: ['awaiting_gap', 'awaiting_confirm'].includes(r.status) ? Number(r.gap) || 0 : null, payBy: r.confirm_by, closesAt: r.closes_at,
    outcome: r.outcome, bookingId: r.order_id, createdAt: r.created_at,
    commitmentUnpaid: r.commitment_unpaid != null ? Number(r.commitment_unpaid) : null, commitmentUnpaidAt: r.commitment_unpaid_at }));
  return { groups, commitments: groups.filter(x => x.commitmentUnpaid != null) };
}
// One organiser's unpaid commitments (Admin → Lookup → guest).
async function commitmentsOf(sql, guestId) {
  try {
    if (!(await ready(sql))) return [];
    return (await sql`SELECT g.id, g.token, g.places, g.total, g.arrival, g.departure, g.commitment_unpaid, g.commitment_unpaid_at, l.property_name
                      FROM group_bookings g LEFT JOIN listings l ON l.id = g.listing_id
                      WHERE g.organiser_guest_id = ${Number(guestId) || 0} AND g.commitment_unpaid IS NOT NULL ORDER BY g.id DESC LIMIT 20`)
      .map(r => ({ groupId: r.id, token: r.token, listing: r.property_name || '', arrival: dateStr(r.arrival), departure: dateStr(r.departure), places: r.places, total: Number(r.total),
        unpaid: Number(r.commitment_unpaid), at: r.commitment_unpaid_at }));
  } catch (e) { return []; }
}
// After confirmation: the organiser cancelled, Aerva approved a natural
// disaster, or the host cancelled — every member is told what happens to
// their own share. Never throws.
async function tellMembersAfterCancel(sql, orderId, text) {
  try {
    if (!(await ready(sql))) return;
    const g = (await sql`SELECT * FROM group_bookings WHERE order_id = ${Number(orderId) || 0}`)[0];
    if (!g) return;
    const full = await load(sql, { id: g.id });
    for (const [gid, p] of (await members(sql, full))) {
      if (Number(gid) === Number(g.organiser_guest_id)) continue;
      await sendMail(p.email, `Your group booking at ${full.stay.detail.suite} is cancelled`, frame('The group booking is cancelled',
        `<p>Hello ${esc(p.first || '')},</p><p>${esc(text)}</p><p>${stayLine(full)}</p>`));
    }
    await addNotice(sql, full, text);
  } catch (err) { console.error('group members not told of the cancellation:', err.message); }
}

// ---- Admin → Accounts: a group booking's money arrives as one receipt per
// payment, and refunds made before the booking existed are listed too. ----
async function accountsCash(sql, start, end) {
  if (!(await ready(sql))) return { receipts: [], refunds: [] };
  const real = (p) => /^pay_[A-Za-z0-9]{14}$/.test(String(p || ''));
  const receipts = (await sql`
    SELECT c.id, c.group_id, c.email, c.first_name, c.amount, c.razorpay_payment_id, c.razorpay_order_id, c.paid_at, c.created_at, c.status, g.order_id
    FROM group_claims c JOIN group_bookings g ON g.id = c.group_id
    WHERE c.razorpay_payment_id IS NOT NULL
      AND (COALESCE(c.paid_at, c.created_at) AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (COALESCE(c.paid_at, c.created_at) AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp`.catch(() => [])).filter(c => real(c.razorpay_payment_id));
  const refunds = (await sql`
    SELECT c.id, c.group_id, c.email, c.refund_amount, c.razorpay_refund_id, c.refunded_at, c.refund_reason, g.order_id
    FROM group_claims c JOIN group_bookings g ON g.id = c.group_id
    WHERE c.refund_status = 'processed' AND c.razorpay_refund_id IS NOT NULL
      AND (c.refunded_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (c.refunded_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp`)
    .filter(r => /^rfnd_[A-Za-z0-9]{14}$/.test(String(r.razorpay_refund_id || '')));
  return { receipts, refunds };
}
module.exports = { ready, addReady, splitShares, allocate, repriceShares, addGuests, startTopupPayment, startGroup, startPayment, startGapPayment, releaseByOrder, confirmGroupPayment, tick, runJob,
  status, publicPreview, decorateBookings, accountsCash, refundClaim, load, sweepClaims, onOutsideBooking, adminList, commitmentsOf, tellMembersAfterCancel, placeTaken,
  NOT_ON, ADD_NOT_ON, OPEN_MINUTES, CONFIRM_MINUTES, ADD_WINDOW_MINUTES, BOOKED, UNAVAILABLE, NOT_COMPLETED, COMMIT_TICK, NONREF_TICK };
