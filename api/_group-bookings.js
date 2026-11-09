// /api/_group-bookings.js — group bookings: "Split the payment with friends".
// Not an endpoint (leading underscore). Owner's rules, 9 Nov 2026.
//
// STARTING. At checkout the organiser chooses to split. The total — stay,
// GST, service fee and deposit, exactly the normal quote — is split equally
// by the number of guests: one share per place, whole rupees, any remainder
// on the last places, so the shares add up exactly (splitShares). The
// organiser pays for at least one place (a couple can pay for 2) inside the
// normal 3-minute payment window. Once paid, the group is OPEN for 2 hours,
// and the dates stay held for the whole group (the checkout's booking_holds
// row is extended), so nobody else can book them.
//
// JOINING. The share link (index.html?group=<token>) shows the stay, the
// per-place amount and the live status: places paid / total, who paid (first
// names), places left, failed attempts and a countdown. A friend signs in,
// gives their first and last name and phone, picks how many places (never
// more than are left) and pays through the normal Razorpay checkout.
//
// NO DOUBLE OR OVER-PAYMENT. Each payment is for specific places, claimed in
// group_seats (one row per place, primary key → a place can be held by one
// live claim only) for a 3-minute window. A failed or abandoned payment
// releases its places. Verification is idempotent (payment_confirmations,
// then a guarded open → paid update). A payment whose amount does not match
// its claim, or that arrives after its window, after the group closed or
// after its places were released, is not counted and is refunded in full at
// once, and the person is told why.
//
// AT 2 HOURS (the scheduled job 'group_bookings' every 5 minutes, and any
// look at the group page in between):
//   • all places paid → one normal booking row (guests = all). This happens
//     as soon as the last place is paid — nothing is left to wait for.
//   • not all paid → re-quoted for the places paid (guests = paid places; a
//     listing priced per stay may not get cheaper). The organiser has 30
//     minutes to confirm the smaller booking; the dates stay held.
//       new total ≤ paid  → booked; each payer gets their share of the excess
//       new total > paid  → the organiser pays the gap to confirm
//       declined / no answer → cancelled, everyone refunded in full.
//
// AFTER CONFIRMATION it is a normal booking: the organiser's account manages
// it. A cancellation refunds each payer their share under the host's policy
// (_refunds.js refundAcrossPayments, which spreads a group booking's refunds
// over its payments in proportion). Payouts and TDS follow the booking row as
// usual, so nothing is paid out before confirmation.
//
// ADD A GUEST (owner's rules, 10 Nov 2026, 00:50 / 00:51; needs the update
// 2026-11-10-03-group-add-guest.sql). Places only ever go up: nobody can
// remove a place once added (the system's own 2-hour re-price for the people
// who paid stays as above). Capacity first: never above the listing's
// max_guests (parseMaxGuests) — "This place takes at most N guests" — and
// the quote's own pet / adult rules.
//   • While the group is open (organiser or any member who paid), and at the
//     2-hour decision (organiser; once, with a 30-minute extra window, the
//     dates held throughout): the whole stay is priced again for the new
//     guest count with the normal quote, T'. The rule, in whole rupees:
//         S  = T' split equally over the N' places (remainder on the last)
//         F  = what the P paid places are worth now = the first P of S
//         Paid = everything already paid for places (and earlier balances)
//         balance to pay ("top-up")   = max(0, F − Paid)   — one payment,
//                                       by the organiser or any member
//         each place still to pay     = (T' − max(F, Paid)) split equally
//                                       over the unpaid places
//     Paid places keep what they paid; Paid + top-up + unpaid places = T'
//     exactly. If the per-place price falls, the places still to pay are
//     cheaper (nothing is refunded); if it rises, the paid places owe the
//     top-up. The group is complete when every place AND the top-up is
//     paid. A payment started before a change (older price_version) is not
//     counted and is refunded in full.
//   • After confirmation (the booking exists; organiser or member): the SAME
//     booking is changed (same confirmation code) through _booking-changes.js
//     — a 'guests' change written as already accepted (no host step) and
//     waiting for its difference. Anyone with the link pays it here (kind
//     'change'); on payment it is applied at once (applyChange: new total,
//     commission, payout; the host is emailed and told in Messages). From
//     then on the whole booking follows the host's cancellation policy, the
//     refund spread over every payment (_refunds.js groupPaymentsOf).
//
// Money: group_bookings.total / shares / group_claims.amount are whole
// rupees (as orders); group_claims.refund_amount is paise (as refunds.amount).

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

const userError = (message, status = 400, extra = {}) => Object.assign(new Error(message), { isUserFacing: true, status }, extra);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const sum = (a) => a.reduce((t, x) => t + (Number(x) || 0), 0);

async function ready(sql) {
  try { await sql`SELECT 1 FROM group_claims LIMIT 0`; return true; } catch (err) { return false; }
}
// "Add a guest" needs 2026-11-10-03-group-add-guest.sql.
const ADD_WINDOW_MINUTES = 30;
const ADD_NOT_ON = 'Adding guests to a group booking is not switched on yet. Please try again later.';
async function addReady(sql) {
  try { await sql`SELECT price_version, topup_due, extensions, notices FROM group_bookings LIMIT 0`; await sql`SELECT price_version, change_id FROM group_claims LIMIT 0`; return true; }
  catch (err) { return false; }
}
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
const isComplete = (g, claims) => paidPlaces(claims) >= g.places && topupOwed(g, claims) <= 0;

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
  <p style="font-size:12px; opacity:0.6; margin-top:24px;">Questions? Reply to this email or write to hello@aerva.in.</p></div>`;
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

// Payment windows that ran out are given back (their places free again).
async function sweepClaims(sql, groupId = null) {
  const rows = await sql`
    UPDATE group_claims SET status = 'released', failed_reason = COALESCE(failed_reason, 'The payment window ended before the payment was completed.')
    WHERE status = 'open' AND expires_at + make_interval(secs => ${GRACE_SECONDS}) < now() AND (${groupId}::int IS NULL OR group_id = ${groupId})
    RETURNING id, group_id`;
  if (rows.length) await sql`DELETE FROM group_seats WHERE claim_id = ANY(${rows.map(r => r.id)})`;
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

// The organiser's checkout (create-order.js, after the stay is priced and
// its 3-minute hold taken). input: the stay as asked (to re-price it for
// fewer guests later); detail: the priced stay; total: the normal quote.
async function startGroup(sql, razorpay, { guestId, email, firstName, lastName, phone, input, detail, total, payNow, agreement, prices, holdIds, assertNotesFit }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  const places = Math.round(Number(detail.guests) || 0);
  if (places < 2) throw userError('Splitting the payment needs at least 2 guests.');
  const k = Math.round(Number(payNow) || 0);
  if (!(k >= 1 && k <= places - 1)) throw userError(`Choose how many places you pay for now: from 1 to ${places - 1}.`);
  const shares = splitShares(total, places);
  const token = crypto.randomBytes(12).toString('hex');
  const g = (await sql`
    INSERT INTO group_bookings (token, organiser_guest_id, organiser_first_name, organiser_last_name, organiser_email, listing_id, room_id, arrival, departure,
                                places, stay, total, shares, agreement, prices, status)
    VALUES (${token}, ${guestId}, ${firstName}, ${lastName}, ${email}, ${detail.listingId}, ${detail.roomId || null}, ${detail.arrival}::date, ${detail.departure}::date,
            ${places}, ${JSON.stringify({ input, detail })}::jsonb, ${total}, ${shares}, ${agreement || null}, ${prices ? JSON.stringify(prices) : null}::jsonb, 'starting')
    RETURNING *`)[0];
  g.stay = { input, detail };
  const amount = sum(shares.slice(0, k));
  const claim = (await sql`
    INSERT INTO group_claims (group_id, guest_id, first_name, last_name, email, phone, kind, places, seats, amount, expires_at)
    VALUES (${g.id}, ${guestId}, ${firstName}, ${lastName}, ${email}, ${phone || null}, 'places', ${k}, ${Array.from({ length: k }, (_, i) => i + 1)}, ${amount},
            now() + make_interval(secs => ${HOLD_SECONDS}))
    RETURNING *`)[0];
  const seats = await takeSeats(sql, g, claim.id, k);
  if (!seats) throw new Error('could not take the organiser’s places in a new group');
  const order = await razorpayOrderFor(razorpay, claim, g, assertNotesFit);
  await sql`UPDATE group_claims SET razorpay_order_id = ${order.id} WHERE id = ${claim.id}`;
  await sql`UPDATE group_bookings SET hold_order_id = ${order.id} WHERE id = ${g.id}`;
  await logAudit(sql, { action: 'booking_order_created', success: true, actorType: 'guest', actorIdentifier: email || null, targetType: 'group_booking', targetId: g.id,
    metadata: { razorpayOrderId: order.id, group: true, groupId: g.id, claimId: claim.id, places, payNow: k, amount, total, holdIds } });
  return { order, group: g, claim: { ...claim, razorpay_order_id: order.id }, token, shares, amount };
}

// A friend (or the organiser again) pays for more places.
async function startPayment(sql, razorpay, { token, guestId, places, firstName, lastName, email, phone, assertNotesFit }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  let g = await load(sql, { token });
  if (!g) throw userError('This group booking link is not valid.', 404);
  g = await tick(sql, razorpay, g);
  // Confirmed with guests added since: this pays for them (same booking).
  if (g.status === 'confirmed' && await addReady(sql)) return startAddedPayment(sql, razorpay, { g, guestId, firstName, lastName, email, phone, assertNotesFit });
  if (g.status !== 'open' || !(new Date(g.closes_at) > new Date())) throw userError('This group booking is closed to new payments.', 409, { closed: true });
  const k = Math.round(Number(places) || 0);
  if (!(k >= 1)) throw userError('Choose how many places you are paying for.');
  const taken = (await sql`SELECT count(*)::int AS n FROM group_seats WHERE group_id = ${g.id}`)[0].n;
  const left = g.places - taken;
  if (k > left) throw userError(left <= 0 ? 'All places are paid for, or being paid for right now. If a payment does not go through, places open again in a few minutes.' : `Only ${left} place${left === 1 ? ' is' : 's are'} left. Please choose ${left} or fewer.`, 409, { placesLeft: Math.max(0, left) });
  const mine = await sql`SELECT status, expires_at FROM group_claims WHERE group_id = ${g.id} AND guest_id = ${guestId}`;
  if (mine.some(c => c.status === 'open')) throw userError('Your payment for this group is already open. Finish it there, or wait 3 minutes and try again.', 409);
  if (mine.length >= MAX_CLAIMS_PER_PERSON) throw userError('Too many payment attempts for this group from your account. Please write to hello@aerva.in.', 429);
  // amount is set from the places actually taken, below.
  const claim = (await sql`
    INSERT INTO group_claims (group_id, guest_id, first_name, last_name, email, phone, kind, places, amount, expires_at)
    VALUES (${g.id}, ${guestId}, ${firstName}, ${lastName}, ${email}, ${phone || null}, 'places', ${k}, ${Math.max(...g.shares) * k},
            LEAST(now() + make_interval(secs => ${HOLD_SECONDS}), ${g.closes_at}::timestamptz))
    RETURNING *`)[0];
  const seats = await takeSeats(sql, g, claim.id, k);
  if (!seats) {
    await sql`UPDATE group_claims SET status = 'released', failed_reason = 'Those places were just taken by someone else.' WHERE id = ${claim.id}`;
    throw userError('Those places were just taken by someone else. Please check how many are left and try again.', 409);
  }
  const amount = sum(seats.map(s => g.shares[s - 1]));
  await sql`UPDATE group_claims SET seats = ${seats}, amount = ${amount} WHERE id = ${claim.id}`;
  // The prices this payment was worked out at. A guest added meanwhile
  // changes them: give the places back at once and ask to try again (a
  // payment made anyway is not counted and is refunded in full).
  if (await addReady(sql)) {
    await sql`UPDATE group_claims SET price_version = ${versionOf(g)} WHERE id = ${claim.id}`;
    const now = (await sql`SELECT price_version, places FROM group_bookings WHERE id = ${g.id}`)[0];
    if (versionOf(now) !== versionOf(g)) {
      await releaseClaim(sql, claim.id, 'released', 'A guest was added while the payment was being started, so the price per place changed.');
      throw userError('A guest was just added to this group, so the price per place changed. Please check the new amount and try again.', 409);
    }
  }
  let order;
  try { order = await razorpayOrderFor(razorpay, { ...claim, amount }, g, assertNotesFit); }
  catch (err) {
    await releaseClaim(sql, claim.id, 'released', 'The payment could not be started.');
    throw err;
  }
  await sql`UPDATE group_claims SET razorpay_order_id = ${order.id} WHERE id = ${claim.id}`;
  const secs = (await sql`SELECT GREATEST(0, ceil(extract(epoch FROM expires_at - now())))::int AS s FROM group_claims WHERE id = ${claim.id}`)[0].s;
  await logAudit(sql, { action: 'booking_order_created', success: true, actorType: 'guest', actorIdentifier: email || null, targetType: 'group_booking', targetId: g.id,
    metadata: { razorpayOrderId: order.id, group: true, groupId: g.id, claimId: claim.id, places: k, seats, amount } });
  return { order, amount, seats, holdSeconds: secs, claimId: claim.id };
}

// The organiser pays what a smaller, dearer booking still needs.
async function startGapPayment(sql, razorpay, { token, guestId, assertNotesFit }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  let g = await load(sql, { token });
  if (!g || Number(g.organiser_guest_id) !== Number(guestId)) throw userError('Group booking not found.', 404);
  g = await tick(sql, razorpay, g);
  if (g.status !== 'awaiting_gap' || !(new Date(g.confirm_by) > new Date())) throw userError('There is nothing to pay for this group booking now.', 409);
  const open = await sql`SELECT 1 FROM group_claims WHERE group_id = ${g.id} AND kind = 'gap' AND status IN ('open', 'paid')`;
  if (open.length) throw userError('Your payment for the difference is already open or done.', 409);
  const claim = (await sql`
    INSERT INTO group_claims (group_id, guest_id, first_name, last_name, email, kind, places, amount, expires_at)
    VALUES (${g.id}, ${guestId}, ${g.organiser_first_name}, ${g.organiser_last_name}, ${g.organiser_email}, 'gap', 0, ${g.gap},
            LEAST(now() + make_interval(secs => ${HOLD_SECONDS}), ${g.confirm_by}::timestamptz))
    RETURNING *`)[0];
  const order = await razorpayOrderFor(razorpay, claim, g, assertNotesFit);
  await sql`UPDATE group_claims SET razorpay_order_id = ${order.id} WHERE id = ${claim.id}`;
  const secs = (await sql`SELECT GREATEST(0, ceil(extract(epoch FROM expires_at - now())))::int AS s FROM group_claims WHERE id = ${claim.id}`)[0].s;
  await logAudit(sql, { action: 'booking_order_created', success: true, actorType: 'guest', actorIdentifier: g.organiser_email, targetType: 'group_booking', targetId: g.id,
    metadata: { razorpayOrderId: order.id, group: true, groupId: g.id, claimId: claim.id, gap: g.gap } });
  return { order, amount: g.gap, holdSeconds: secs, claimId: claim.id };
}

async function releaseClaim(sql, claimId, status, reason) {
  const r = await sql`UPDATE group_claims SET status = ${status}, failed_reason = COALESCE(failed_reason, ${reason}) WHERE id = ${claimId} AND status = 'open' RETURNING id, group_id`;
  if (r.length) await sql`DELETE FROM group_seats WHERE claim_id = ${claimId}`;
  return r[0] || null;
}

// create-order.js { releaseHold } for a group payment window: the payment
// failed or was closed. Returns null when the order is not a group payment;
// keepHold tells the caller not to free the dates (the group holds them).
async function releaseByOrder(sql, razorpayOrderId, reason) {
  if (!(await ready(sql))) return null;
  const c = (await sql`SELECT * FROM group_claims WHERE razorpay_order_id = ${razorpayOrderId}`)[0];
  if (!c) return null;
  const failed = reason === 'failed';
  await releaseClaim(sql, c.id, failed ? 'failed' : 'released', failed ? 'The payment did not go through.' : 'The payment window was closed before paying.');
  const g = await load(sql, { id: c.group_id });
  if (g && g.status === 'starting' && g.hold_order_id === razorpayOrderId) {
    await sql`UPDATE group_bookings SET status = 'failed', outcome = 'The first payment did not go through, so the group was not opened.' WHERE id = ${g.id} AND status = 'starting'`;
    return { keepHold: false };
  }
  return { keepHold: true };
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
  let reason = null;
  if (Number(payment.amount) !== Number(order.amount) || Number(order.amount) !== fresh.amount * 100 || (payment.currency || 'INR') !== 'INR') {
    reason = 'The amount paid did not match the amount for the places chosen, so it was not counted.';
  } else if (!isFirst && fresh.kind === 'places' && g.status !== 'open') {
    reason = g.status === 'confirmed' || g.status === 'confirming' ? 'The group booking was already complete when this payment arrived.' : 'The group booking had already closed when this payment arrived.';
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
    if (g.status !== 'awaiting_gap') reason = 'This group booking was already settled, so the payment for the difference was not needed.';
  } else if (g.status !== 'open') {
    reason = g.status === 'confirmed' || g.status === 'confirming' ? 'The group booking was already complete when this payment arrived.' : 'The group booking had already closed when this payment arrived.';
  }
  // Worked out at prices that changed since (a guest was added): not counted.
  if (!reason && !isFirst && (fresh.kind === 'places' || fresh.kind === 'topup') && versionOf(fresh) !== versionOf(g)) {
    reason = 'A guest was added to the group while this payment was open, so the price per place changed and this payment was not counted.';
  }
  if (!reason && fresh.kind === 'topup' && Number(fresh.amount) > topupOwed(g, await claimsOf(sql, g.id))) {
    reason = 'The balance to pay had already been paid, so this payment was not needed.';
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
    return { status: 'confirmed', group: { token: g.token, kind: 'gap', outcome: done && done.outcome } };
  }
  if (fresh.kind === 'topup') {
    const all = await claimsOf(sql, g.id);
    await sendMail(fresh.email, 'Payment received: the balance for your group booking', frame('The balance is paid',
      `<p>Hello ${esc(fresh.first_name || '')},</p><p>We received <strong>${inr(fresh.amount)}</strong>, the balance the places already paid owed after a guest was added, for ${stayLine(g)}.</p>${button(groupLink(g.token), 'See the group')}`));
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
     <p>${left > 0 || owed > 0 ? `${paid} of ${g.places} places are paid${owed > 0 ? ` (and a balance of ${inr(owed)} is still to pay)` : ''}. The booking is confirmed once every place is paid, or the organiser confirms it for fewer guests. If it does not go ahead, you are refunded in full.` : 'Every place is paid — the booking is being confirmed.'}</p>
     ${button(groupLink(g.token), 'See the group')}`));
  if (Number(fresh.guest_id) !== Number(g.organiser_guest_id)) {
    await sendMail(g.organiser_email, `${fresh.first_name || 'A friend'} paid for ${fresh.places} place${fresh.places === 1 ? '' : 's'}`, frame(`${esc(fresh.first_name || 'A friend')} paid`,
      `<p>${esc(fresh.first_name || 'A friend')} paid for ${fresh.places} place${fresh.places === 1 ? '' : 's'} in your group booking: ${stayLine(g)}.</p><p><strong>${paid} of ${g.places}</strong> places are paid${left > 0 ? `; ${left} left` : ' — every place is paid'}${owed > 0 ? `; a balance of ${inr(owed)} is still to pay` : ''}.</p>${button(groupLink(g.token), 'See the group')}`));
  }
  if (left <= 0 && owed <= 0) {
    const done = await finalize(sql, razorpay, g, ['open']);
    return { status: 'confirmed', group: { token: g.token, kind: 'places', complete: true, outcome: done && done.outcome } };
  }
  return { status: 'confirmed', group: { token: g.token, kind: 'places', paidPlaces: paid, places: g.places } };
}

// The organiser's first payment counted: the group opens for 2 hours and
// the checkout's hold is stretched over them.
async function openGroup(sql, razorpay, g, claim) {
  const opened = (await sql`UPDATE group_bookings SET status = 'open', opened_at = now(), closes_at = now() + make_interval(mins => ${OPEN_MINUTES})
                            WHERE id = ${g.id} AND status = 'starting' RETURNING *`)[0];
  if (!opened) return rejectPayment(sql, razorpay, claim, { id: claim.razorpay_payment_id || null, amount: claim.amount * 100 }, 'This group booking was no longer open.');
  const held = await holdDates(sql, opened, opened.closes_at);
  if (!held) {
    // The window had run out and someone else took the dates meanwhile.
    await sql`UPDATE group_bookings SET status = 'failed', outcome = 'The dates were taken while the first payment was completed.' WHERE id = ${g.id}`;
    const pay = (await sql`SELECT razorpay_payment_id FROM group_claims WHERE id = ${claim.id}`)[0];
    return rejectPayment(sql, razorpay, claim, await razorpay.payments.fetch(pay.razorpay_payment_id), 'These dates were booked by someone else while your payment was being completed.');
  }
  await sendMail(g.organiser_email, 'Your group booking is open: share the link', frame('Your group booking is open for 2 hours',
    `<p>Hello ${esc(g.organiser_first_name || '')},</p><p>You paid for ${claim.places} of ${g.places} places (${inr(claim.amount)}) for ${stayLine(g)}. The dates are held for your group for the next 2 hours.</p>
     <p>Each place is <strong>${inr(g.shares[0])}</strong>${g.shares[g.shares.length - 1] !== g.shares[0] ? ` (the last place${g.shares.filter(s => s !== g.shares[0]).length === 1 ? '' : 's'} ${inr(g.shares[g.shares.length - 1])})` : ''}. Send this link to your friends so each can pay for their own place:</p>
     ${button(groupLink(g.token), 'Open the group page')}<p style="font-size:13px; word-break:break-all;">${esc(groupLink(g.token))}</p>
     <p style="font-size:13px;">If not every place is paid in 2 hours, we will ask you to confirm the booking for the people who paid (the price is worked out again for that number of guests), or cancel it and refund everyone in full.</p>`));
  return { status: 'confirmed', group: { token: g.token, kind: 'first', opened: true } };
}

// Stretches the group's hold to `until`. The checkout's own hold row when it
// is still live; otherwise (it ran out in the grace seconds) a new hold for
// the group, which the database refuses if anyone else holds the dates.
async function holdDates(sql, g, until) {
  const ext = await sql`UPDATE booking_holds SET expires_at = ${until}::timestamptz + make_interval(secs => ${GRACE_SECONDS})
                        WHERE razorpay_order_id = ${g.hold_order_id} AND released = false RETURNING id`;
  if (ext.length) return true;
  try {
    const r = await sql`INSERT INTO booking_holds (listing_id, room_id, arrival, departure, guest_key, ip, expires_at, razorpay_order_id)
                        VALUES (${g.listing_id}, ${g.room_id || null}, ${g.arrival}, ${g.departure}, ${'grp:' + g.id}, null,
                                ${until}::timestamptz + make_interval(secs => ${GRACE_SECONDS}), ${g.hold_order_id}) RETURNING id`;
    return r.length > 0;
  } catch (err) {
    if (err && err.code === '23P01') return false;
    throw err;
  }
}

// ---- Turning the group into the booking ----
async function finalize(sql, razorpay, g, fromStatuses) {
  const got = (await sql`UPDATE group_bookings SET status = 'confirming', decided_at = now() WHERE id = ${g.id} AND status = ANY(${fromStatuses}) RETURNING *`)[0];
  if (!got) return null;
  return completeConfirm(sql, razorpay, await load(sql, { id: g.id }));
}

async function completeConfirm(sql, razorpay, g) {
  const CB = require('./_confirm-booking');
  const claims = (await claimsOf(sql, g.id)).filter(c => c.status === 'paid');
  const useRequote = !!(g.requote && g.requote_total != null);
  const detail = useRequote ? g.requote.detail : g.stay.detail;
  const total = useRequote ? Number(g.requote_total) : Number(g.total);
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
    const clash = await CB.findDateConflicts(sql, [detail]);
    if (clash.length) return cancelGroup(sql, razorpay, g, 'The dates were no longer available (blocked or booked), so the group booking could not be confirmed.', { from: ['confirming'] });
    try { orderId = await CB.insertRow(sql, ctx, rows[0], null); fresh = true; }
    catch (err) {
      if (err && err.code === '23P01') return cancelGroup(sql, razorpay, g, 'These dates were booked by someone else, so the group booking could not be confirmed.', { from: ['confirming'] });
      throw err;
    }
    await sql`UPDATE orders SET group_booking_id = ${g.id} WHERE id = ${orderId}`;
  }
  // A smaller booking that costs less than was paid: each payer gets back
  // their share of the excess, in proportion to what they paid.
  const paid = sum(claims.map(c => c.amount));
  const excess = Math.max(0, paid - total);
  const back = new Map();
  if (excess > 0) {
    const parts = allocate(excess, claims.map(c => c.amount));
    for (let i = 0; i < claims.length; i++) {
      if (!parts[i]) continue;
      back.set(claims[i].id, parts[i]);
      await refundClaim(sql, razorpay, claims[i].id, parts[i] * 100, `The booking was confirmed for ${detail.guests} guests at ${inr(total)}; your share of the ${inr(excess)} paid above that.`);
    }
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
        { firstName: ctx.firstName, lastName: ctx.lastName, phone, note: `Group booking: ${detail.guests} guests, paid by ${new Set(claims.map(c => c.guest_id)).size} people. ${esc(ctx.firstName || 'The organiser')} manages the booking.` });
    } catch (err) { console.error('group host email failed:', err.message); }
  }
  await releaseHolds(sql, { razorpayOrderId: g.hold_order_id, reason: 'paid' });
  const outcome = useRequote
    ? `Confirmed for ${detail.guests} of ${g.places} guests at ${inr(total)}${excess ? `; ${inr(excess)} refunded to the payers` : ''}.`
    : `Confirmed: all ${g.places} places paid.`;
  const done = (await sql`UPDATE group_bookings SET status = 'confirmed', order_id = ${orderId}, outcome = ${outcome} WHERE id = ${g.id} AND status = 'confirming' RETURNING id`)[0];
  if (!done) return { outcome, orderId };
  // Everyone who paid: the confirmation email, with the refund warning.
  const policy = await policyText(sql, orderId);
  const warning = `<p style="background:#fff4e5; border:1px solid #e8c48a; border-radius:8px; padding:10px 12px; font-size:13px;"><strong>Refunds follow the host’s cancellation policy (${esc(policy)})</strong>; if the booking is cancelled, each person is refunded their share under that policy.</p>`;
  const byPerson = new Map();
  claims.forEach(c => { const p = byPerson.get(c.guest_id) || { email: c.email, first: c.first_name, places: 0, paid: 0, back: 0 }; p.places += c.places; p.paid += c.amount; p.back += back.get(c.id) || 0; byPerson.set(c.guest_id, p); });
  let pdf = null;
  try { pdf = await CB.generateBookingConfirmationPdf(ctx.stays, [], ctx.razorpayOrderId, 'INR', 0, codes); } catch (e) { pdf = null; }
  for (const [gid, p] of byPerson) {
    const isOrg = Number(gid) === Number(g.organiser_guest_id);
    const extra = `<p><strong>Group booking</strong> — ${detail.guests} guest${detail.guests === 1 ? '' : 's'}, organised by ${esc(g.organiser_first_name || 'your friend')}. You paid <strong>${inr(p.paid)}</strong> for ${p.places} place${p.places === 1 ? '' : 's'}${p.back ? `; ${inr(p.back)} of it is being refunded (the booking cost less for ${detail.guests} guests)` : ''}.</p>
      ${isOrg ? '<p>You manage this booking (changes and cancellations) from My Bookings.</p>' : `<p>${esc(g.organiser_first_name || 'The organiser')} manages this booking. It is in your My Bookings with the check-in details and the group’s messages with the host.</p>`}
      ${warning}`;
    try { await CB.sendBookingConfirmationEmail(p.email, ctx.stays, [], isOrg ? pdf : null, ctx.agreement.version, codes, extra); }
    catch (err) { console.error('group confirmation email failed:', err.message); }
  }
  // The group's notices (guests added) go into the booking's Messages first.
  for (const n of (Array.isArray(g.notices) ? g.notices : [])) if (n && n.text) await threadNotice(sql, orderId, String(n.text));
  await threadNotice(sql, orderId, useRequote ? `Group booking confirmed for ${detail.guests} guests (${paidPlaces(claims)} of ${g.places} places paid).` : `Group booking confirmed: all ${g.places} places paid by ${byPerson.size} people.`);
  await logAudit(sql, { action: 'group_booking_confirmed', success: true, actorType: 'system', targetType: 'order', targetId: orderId,
    metadata: { groupId: g.id, places: g.places, guests: detail.guests, total, paid, excess, payers: [...byPerson.values()].map(p => ({ email: p.email, places: p.places, paid: p.paid, refunded: p.back })) } });
  return { outcome, orderId };
}

async function policyText(sql, orderId) {
  try {
    const p = (await sql`SELECT COALESCE(o.cancellation_policy, l.cancellation_policy, 'flexible') AS p FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${orderId}`)[0];
    return require('./_cancellations').policySummary(p && p.p).replace(/\.$/, '');
  } catch (err) { return 'see the listing'; }
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

// Cancelled before it became a booking: every payment refunded in full.
async function cancelGroup(sql, razorpay, g, reason, { from = LIVE.concat(['confirming']) } = {}) {
  const got = (await sql`UPDATE group_bookings SET status = 'cancelled', outcome = ${reason}, decided_at = now() WHERE id = ${g.id} AND status = ANY(${from}) RETURNING id`)[0];
  if (!got) return null;
  // Open payment windows can no longer count.
  const open = await sql`UPDATE group_claims SET status = 'released', failed_reason = 'The group booking was cancelled.' WHERE group_id = ${g.id} AND status = 'open' RETURNING id`;
  if (open.length) await sql`DELETE FROM group_seats WHERE claim_id = ANY(${open.map(r => r.id)})`;
  const claims = (await claimsOf(sql, g.id)).filter(c => c.status === 'paid');
  for (const c of claims) await refundClaim(sql, razorpay, c.id, c.amount * 100, reason);
  // A booking row written in the same moment (completeConfirm crashed) is cancelled too.
  try { await sql`UPDATE orders SET status = 'cancelled', cancellation_reason = ${'Group booking cancelled: ' + reason}, cancelled_at = now(), deposit_status = 'none' WHERE group_booking_id = ${g.id} AND status = 'paid'`; } catch (e) { /* none */ }
  await releaseHolds(sql, { razorpayOrderId: g.hold_order_id, reason: 'closed' });
  const people = new Map();
  claims.forEach(c => { const p = people.get(c.guest_id) || { email: c.email, first: c.first_name, paid: 0 }; p.paid += c.amount; people.set(c.guest_id, p); });
  for (const p of people.values()) {
    await sendMail(p.email, 'Your Aerva group booking did not go ahead — full refund', frame('The group booking did not go ahead',
      `<p>Hello ${esc(p.first || '')},</p><p>${esc(reason)}</p><p>${stayLine(g)}</p><p>Your payment of <strong>${inr(p.paid)}</strong> is being refunded in full to your original payment method. Refunds usually arrive in 5–7 working days.</p>`));
  }
  await logAudit(sql, { action: 'group_booking_cancelled', success: true, actorType: 'system', targetType: 'group_booking', targetId: g.id,
    metadata: { reason, refunded: [...people.values()].map(p => ({ email: p.email, amount: p.paid })) } });
  return { outcome: reason };
}

// Two hours are up and not every place is paid: re-priced for the places
// paid; the organiser confirms (or not) within 30 minutes.
async function shortfall(sql, razorpay, g) {
  const claims = await claimsOf(sql, g.id);
  const P = paidPlaces(claims), paid = paidSum(claims);
  const input = Object.assign({}, g.stay.input);
  const adults = Math.max(1, Math.min(Number(input.adults) || P, P));
  const priced = await require('./_pricing').priceStay(sql, Object.assign(input, { guests: P, adults, children: P - adults, includedWithExperienceId: undefined }), 0);
  if (priced.error) return cancelGroup(sql, razorpay, g, `Not every place was paid in 2 hours, and the stay could not be priced for ${P} guest${P === 1 ? '' : 's'} (${priced.error}).`, { from: ['open'] });
  const d = priced.detail;
  const total = Math.round(Number(d.subtotal) + Number(d.gst || 0) + Number(d.guestServiceFee || 0) + Number(d.depositAmount || 0));
  const gap = Math.max(0, total - paid);
  const got = (await sql`
    UPDATE group_bookings SET status = 'awaiting_confirm', requote = ${JSON.stringify({ input, detail: d })}::jsonb, requote_total = ${total}, paid_places = ${P}, gap = ${gap},
      confirm_by = now() + make_interval(mins => ${CONFIRM_MINUTES})
    WHERE id = ${g.id} AND status = 'open' RETURNING *`)[0];
  if (!got) return null;
  if (!(await holdDates(sql, got, got.confirm_by))) return cancelGroup(sql, razorpay, got, 'The dates could not be held any longer, so the group booking did not go ahead.', { from: ['awaiting_confirm'] });
  const canAdd = (await addReady(sql)) && !(Number(got.extensions) > 0);
  await sendMail(g.organiser_email, P >= g.places ? 'Action needed: confirm your group booking' : 'Action needed: confirm your group booking for fewer guests', frame(P >= g.places ? 'The balance was not paid' : 'Not every place was paid',
    `<p>Hello ${esc(g.organiser_first_name || '')},</p><p>${P} of ${g.places} places were paid for ${stayLine(g)} (${inr(paid)} in all)${P >= g.places ? ', but not the balance owed after a guest was added' : ''}.</p>
     <p>For ${P} guest${P === 1 ? '' : 's'} the stay costs <strong>${inr(total)}</strong>. ${gap > 0 ? `To book it, you pay the remaining <strong>${inr(gap)}</strong>.` : total < paid ? `If you confirm, ${inr(paid - total)} is refunded to the people who paid, each their share.` : ''}</p>
     ${canAdd ? '<p>You can also add guests and pay for them: the group then reopens for 30 more minutes.</p>' : ''}
     <p><strong>Please confirm or cancel within 30 minutes.</strong> If you do not answer, the booking is cancelled and everyone is refunded in full. The dates stay held until then.</p>
     ${button(groupLink(g.token), 'Confirm or cancel')}`));
  for (const c of claims.filter(x => x.status === 'paid' && Number(x.guest_id) !== Number(g.organiser_guest_id))) {
    await sendMail(c.email, 'Your group booking: waiting for the organiser', frame('Waiting for the organiser',
      `<p>Hello ${esc(c.first_name || '')},</p><p>Not every place was paid in 2 hours for ${stayLine(g)}. ${esc(g.organiser_first_name || 'The organiser')} has 30 minutes to confirm the booking for the ${P} guests who paid, or cancel it. If it is cancelled, you are refunded in full; we will email you either way.</p>`));
  }
  await logAudit(sql, { action: 'group_booking_short', success: true, actorType: 'system', targetType: 'group_booking', targetId: g.id,
    metadata: { places: g.places, paidPlaces: P, paid, requoteTotal: total, gap, email: g.organiser_email } });
  return { requote: true };
}

// The organiser's answer: { accept: true | false }.
async function decide(sql, razorpay, { token, guestId, accept }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  let g = await load(sql, { token });
  if (!g || Number(g.organiser_guest_id) !== Number(guestId)) throw userError('Group booking not found.', 404);
  g = await tick(sql, razorpay, g);
  if (!accept) {
    if (!['awaiting_confirm', 'awaiting_gap'].includes(g.status)) throw userError('There is nothing to decide for this group booking now.', 409);
    const gapOpen = await sql`SELECT 1 FROM group_claims WHERE group_id = ${g.id} AND kind = 'gap' AND status = 'open' AND expires_at > now() - interval '15 seconds'`;
    if (gapOpen.length) throw userError('Your payment for the difference is in progress. Wait for it to finish, or close it first.', 409);
    await cancelGroup(sql, razorpay, g, `${g.organiser_first_name || 'The organiser'} chose not to book for fewer guests, so the group booking was cancelled.`, { from: ['awaiting_confirm', 'awaiting_gap'] });
    return status(sql, razorpay, g.token, guestId);
  }
  if (g.status !== 'awaiting_confirm') throw userError(g.status === 'awaiting_gap' ? 'Pay the difference to confirm the booking.' : 'There is nothing to confirm for this group booking now.', 409);
  const claims = await claimsOf(sql, g.id);
  if (Number(g.requote_total) <= paidSum(claims)) {
    await finalize(sql, razorpay, g, ['awaiting_confirm']);
    return status(sql, razorpay, g.token, guestId);
  }
  await sql`UPDATE group_bookings SET status = 'awaiting_gap' WHERE id = ${g.id} AND status = 'awaiting_confirm'`;
  const out = await status(sql, razorpay, g.token, guestId);
  return Object.assign(out, { payGap: Number(g.gap) });
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
  const atDecision = ['awaiting_confirm', 'awaiting_gap'].includes(g.status);
  if (g.status === 'confirmed') return addAfterConfirm(sql, razorpay, g, { guestId, k });
  if (g.status === 'open') {
    if (!(new Date(g.closes_at) > new Date())) throw userError('This group has closed. Please wait a moment for the next step.', 409);
  } else if (atDecision) {
    if (!isOrg) throw userError(`Only ${g.organiser_first_name || 'the organiser'} can add guests at this point.`, 403);
    if (Number(g.extensions) > 0) throw userError('Guests were already added once at this point. Please confirm the booking for the people who paid, or cancel it.', 409);
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
  if (!r) throw userError('The stay could not be priced for that many guests. Please write to hello@aerva.in.');
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
  // The dates stay held for the extra window.
  if (atDecision && !(await holdDates(sql, got, got.closes_at))) {
    await cancelGroup(sql, razorpay, got, 'The dates could not be held any longer, so the group booking did not go ahead.', { from: ['open'] });
    throw userError('The dates could not be held any longer, so the group booking did not go ahead. Everyone is refunded in full.', 409);
  }
  const fresh = await load(sql, { id: g.id });
  await logAudit(sql, { action: 'group_guests_added', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'group_booking', targetId: g.id,
    metadata: { added: k, places: N, before: g.places, total, totalBefore: g.total, shares: r.shares, topup: r.topup, paid, paidSeats, priceVersion: versionOf(fresh), atDecision } });
  await tellMembers(sql, fresh, `Guest added — now ${N} places, ${inr(r.perPlace)} each`, 'A guest was added to your group',
    `<p>${esc(text)}</p>${atDecision ? `<p>The group is open again for ${ADD_WINDOW_MINUTES} minutes so the new place${k === 1 ? '' : 's'} can be paid. The dates stay held.</p>` : ''}`);
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
  if (mine.length >= MAX_CLAIMS_PER_PERSON) throw userError('Too many payment attempts for this group from your account. Please write to hello@aerva.in.', 429);
  let claim;
  try {
    claim = (await sql`
      INSERT INTO group_claims (group_id, guest_id, first_name, last_name, email, phone, kind, places, amount, expires_at, change_id)
      VALUES (${g.id}, ${guestId}, ${firstName}, ${lastName}, ${email}, ${phone || null}, 'change', ${Number(c.requested.groupAdd) || 0}, ${c.difference},
              now() + make_interval(secs => ${HOLD_SECONDS}), ${c.id})
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
  if (mine.length >= MAX_CLAIMS_PER_PERSON) throw userError('Too many payment attempts for this group from your account. Please write to hello@aerva.in.', 429);
  let claim;
  try {
    claim = (await sql`
      INSERT INTO group_claims (group_id, guest_id, first_name, last_name, email, phone, kind, places, amount, expires_at, price_version)
      VALUES (${g.id}, ${guestId}, ${firstName}, ${lastName}, ${email}, ${phone || null}, 'topup', 0, ${owed},
              LEAST(now() + make_interval(secs => ${HOLD_SECONDS}), ${g.closes_at}::timestamptz), ${versionOf(g)})
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
  let order;
  try { order = await razorpayOrderFor(razorpay, claim, g, assertNotesFit); }
  catch (err) { await releaseClaim(sql, claim.id, 'released', 'The payment could not be started.'); throw err; }
  await sql`UPDATE group_claims SET razorpay_order_id = ${order.id} WHERE id = ${claim.id}`;
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
  } else if (g.status === 'open') {
    const claims = await claimsOf(sql, g.id);
    if (isComplete(g, claims)) await finalize(sql, razorpay, g, ['open']);
    else if (now >= new Date(g.closes_at).getTime()) {
      const live = claims.some(c => c.status === 'open');
      if (!live) await shortfall(sql, razorpay, g);
    } else if (!g.reminded_at && now >= new Date(g.closes_at).getTime() - REMIND_BEFORE_MINUTES * 60e3) {
      const claimed = await sql`UPDATE group_bookings SET reminded_at = now() WHERE id = ${g.id} AND reminded_at IS NULL RETURNING id`;
      if (claimed.length) {
        const P = paidPlaces(claims);
        await sendMail(g.organiser_email, '30 minutes left for your group booking', frame('30 minutes left',
          `<p>Hello ${esc(g.organiser_first_name || '')},</p><p>${P} of ${g.places} places are paid for ${stayLine(g)}. Your group closes in about 30 minutes. Remind your friends to pay for their places:</p>${button(groupLink(g.token), 'Open the group page')}`));
        await logAudit(sql, { action: 'group_booking_reminder', success: true, actorType: 'system', targetType: 'group_booking', targetId: g.id, metadata: { email: g.organiser_email, paidPlaces: P, places: g.places } });
      }
    }
  } else if (g.status === 'awaiting_confirm' || g.status === 'awaiting_gap') {
    if (now >= new Date(g.confirm_by).getTime() + GRACE_SECONDS * 1000) {
      const gapOpen = await sql`SELECT 1 FROM group_claims WHERE group_id = ${g.id} AND kind = 'gap' AND status = 'open'`;
      if (!gapOpen.length) {
        await cancelGroup(sql, razorpay, g, `${g.organiser_first_name || 'The organiser'} did not confirm the smaller booking within 30 minutes, so the group booking was cancelled.`, { from: ['awaiting_confirm', 'awaiting_gap'] });
      }
    }
  } else if (g.status === 'confirming' && g.decided_at && now - new Date(g.decided_at).getTime() > 2 * 60e3) {
    // A confirmation that stopped half-way: finished (never written twice).
    await completeConfirm(sql, razorpay, g);
  }
  return load(sql, { id: g.id });
}

// Job 'group_bookings' (get-listings.js), every 5 minutes.
async function runJob(sql, razorpay, { deadlineMs = 4000 } = {}) {
  const started = Date.now();
  const out = { checked: 0, confirmed: 0, shortfalls: 0, cancelled: 0, reminded: 0, refundRetries: 0 };
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
      else if (after.status === 'cancelled' && before.status !== 'cancelled') out.cancelled++;
      else if (after.status === 'awaiting_confirm' && before.status === 'open') out.shortfalls++;
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
    organiserFirstName: g.organiser_first_name || null, isOrganiser: isOrg, signedIn: viewerGuestId != null,
    myPlaces: sum(mineClaims.filter(c => c.status === 'paid' && (c.kind === 'places' || c.kind === 'change')).map(c => c.places)),
    myPaid: sum(mineClaims.filter(c => c.status === 'paid').map(c => c.amount)),
    myOpenPayment: mineClaims.some(c => c.status === 'open'),
    policy: (() => { try { return require('./_cancellations').policySummary(l.cancellation_policy); } catch (e) { return null; } })(),
    orderId: g.order_id && (isOrg || mineClaims.some(c => c.status === 'paid')) ? g.order_id : null
  };
  // Add a guest (2026-11-10-03-group-add-guest.sql).
  out.addOn = v2;
  out.notices = v2 && Array.isArray(g.notices) ? g.notices.slice(-10).map(n => ({ at: n.at || null, text: String(n.text || '') })) : [];
  if (v2) {
    const cap = require('./_pricing').parseMaxGuests(l.max_guests);
    const member = isOrg || claims.some(c => viewerGuestId != null && Number(c.guest_id) === Number(viewerGuestId) && c.status === 'paid');
    const pend = g.status === 'confirmed' ? await pendingAdd(sql, g) : null;
    const guestsNow = g.status === 'confirmed' && g.order_id ? Number(((await sql`SELECT guests FROM orders WHERE id = ${g.order_id}`)[0] || {}).guests || g.places) : g.places;
    const atDecision = ['awaiting_confirm', 'awaiting_gap'].includes(g.status);
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
  if (isOrg && g.requote_total != null) {
    const paid = paidSum(claims.filter(c => c.kind !== 'gap'));
    out.requote = { places: g.paid_places, total: g.requote_total, paid, gap: Number(g.gap) || 0, excess: Math.max(0, paid - g.requote_total) };
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
      if (b) { b.group = { token: g.token, places: g.places, paidPlaces: g.paid_total, organiser: isOrg, myPlaces: g.my_places }; continue; }
      if (g.status === 'confirmed' && g.order_id && !isOrg && g.my_places > 0) {
        const o = (await sql`SELECT o.id, o.suite_name, o.listing_id, o.arrival, o.departure, o.nights, o.guests, o.status, to_jsonb(o)->>'confirmation_code' AS confirmation_code,
                                    l.property_name, l.city, to_jsonb(l)->>'area' AS area, l.formatted_address, l.check_in_time, l.check_out_time, COALESCE(l.listing_type, 'stay') AS listing_type,
                                    (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date AS local_today
                             FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${g.order_id}`)[0];
        if (!o) continue;
        bookings.push({ id: o.id, shared: 'group', group: { token: g.token, places: g.places, myPlaces: g.my_places, organiser: false, organiserFirstName: g.organiser_first_name },
          you_paid: g.my_paid, suite_name: o.suite_name, listing_id: o.listing_id, listing_type: o.listing_type, arrival: dateStr(o.arrival), departure: dateStr(o.departure),
          nights: o.nights, guests: o.guests, status: o.status, confirmation_code: o.status === 'paid' ? o.confirmation_code : null, listing_name: o.property_name,
          listing_city: o.city, listing_area: o.area, listing_address: o.status === 'paid' ? o.formatted_address : null, check_in_time: o.check_in_time, check_out_time: o.check_out_time,
          local_today: dateStr(o.local_today), can_change: false, can_cancel_request: false, can_report: false, review_state: null });
        continue;
      }
      if (g.status === 'confirmed') continue;
      const st = typeof g.stay === 'string' ? JSON.parse(g.stay) : g.stay;
      const note = g.status === 'open' ? `Group booking open — ${g.paid_total} of ${g.places} places paid`
        : g.status === 'awaiting_confirm' || g.status === 'awaiting_gap' ? (isOrg ? 'Action needed: confirm the booking for fewer guests' : `Waiting for ${g.organiser_first_name || 'the organiser'} to confirm`)
        : g.status === 'confirming' ? 'Being confirmed…'
        : (g.outcome || 'Did not go ahead') + (g.my_paid ? ` Your ${'₹' + Number(g.my_paid).toLocaleString('en-IN')} is refunded in full.` : '');
      bookings.push({ id: 'g' + g.id, pending_group: true, group: { token: g.token, places: g.places, paidPlaces: g.paid_total, organiser: isOrg, myPlaces: g.my_places, status: g.status, note },
        suite_name: st && st.detail ? st.detail.suite : 'Group booking', listing_id: g.listing_id, arrival: dateStr(g.arrival), departure: dateStr(g.departure),
        guests: g.places, status: g.status === 'cancelled' || g.status === 'failed' ? 'cancelled' : 'group_pending', you_paid: g.my_paid, can_change: false, can_cancel_request: false });
    }
  } catch (err) { console.error('group bookings not added:', err.message); }
  return bookings;
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

module.exports = { ready, addReady, splitShares, allocate, repriceShares, addGuests, startTopupPayment, startGroup, startPayment, startGapPayment, releaseByOrder, confirmGroupPayment, decide, tick, runJob,
  status, publicPreview, decorateBookings, accountsCash, refundClaim, load, sweepClaims, NOT_ON, ADD_NOT_ON, OPEN_MINUTES, CONFIRM_MINUTES, ADD_WINDOW_MINUTES };
