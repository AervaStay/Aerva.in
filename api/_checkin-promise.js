// The Aerva mark on every email (api/_email-shell.js, owner 14 Nov 2026):
// requiring it brands everything this process sends.
require('./_email-shell');
// /api/_checkin-promise.js — Aerva's check-in promise. Not an endpoint.
//
// THE OWNER'S RULES (9 Nov 2026, as revised the same evening):
//   • On arrival the guest reports, in My Bookings → Report a problem, with
//     at least one photo (_stay-disputes.js, in the stay window: check-in
//     until 10 AM on the day after check-in), one of:
//       – 'arrival_fake':   the property does not exist (a fake listing);
//       – 'arrival_failed': not as listed, or not available, on arrival.
//     The report is URGENT: a support request for the guest and for the
//     host, an email to Aerva support, a line in the booking's thread and
//     an alert to the host.
//   • A FAKE report hides THAT LISTING at once (status 'blocked': out of
//     search, cannot be booked) and holds its unsent payouts. Aerva then:
//       – confirms → the listing stays blocked (listings.checkin_blocked_at;
//         the host cannot reactivate it, only Aerva can unblock), and its
//         future bookings go to Admin, where Aerva rebooks or refunds each
//         guest;
//       – clears → the listing goes back live; the holds lift.
//     Only that listing — never the host's other listings, never the host.
//   • A NOT-AS-LISTED report blocks nothing; the booking's payout is held
//     until Aerva decides.
//   • Confirmed (either reason) → rebook first, refund otherwise:
//       – Aerva sends the guest up to 3 places: live, approved listings in
//         the same city, free for the nights left and fitting the party
//         (guests, pets), nearest first, then closest in price;
//       – the guest pays only the difference: the new place priced for
//         those nights the normal way (_pricing.js: GST, service fee,
//         deposit) − what the guest paid for the original booking. More:
//         paid first (the change-payment window, _booking-changes.js).
//         Less: Aerva credit (_fee-credits.js, reason 'checkin_rebook').
//       – the original booking is closed with nothing left on it, and the
//         new one (its own row and code, orders.checkin_rebook_of) carries
//         the money: the guest sees ONE booking and one amount;
//       – declines every option (or none fits) → refunded in full: price,
//         GST, deposit and Aerva's service fee.
//     The original host is never paid for that booking; anything already
//     paid out is recorded against them (host_penalties 'overpaid',
//     _payouts.js settleAfterPayout) and deducted from later payouts.
//   • A listing's FIRST stay is paid out after that guest's check-out time
//     (owner, 10 Nov 2026), then released if no report is open on it. Later
//     bookings pay out as usual. Guests are still asked from check-in
//     whether the place is real (listings.checkin_verified_at); that answer
//     no longer affects payouts.
//     This payout timing changes hosts' terms, so it applies only to stays
//     arriving on or after the effective date of the host notice
//     '2026-11-10-checkin-promise' (aerva-policies.js updates; 30 days'
//     notice, _policy-updates.js) — read from that entry, see holdFrom().
//     Everything else here (blocking a fake listing, holds while a report
//     is open, recovering money Aerva refunded or rebooked) applies at once.
//
// Nothing twice: every step moves checkin_reports.status forward with a
// guarded UPDATE; money goes through the existing guarded paths
// (claimForCancellation, executePolicyCancellation, _refunds.js, the
// change-payment window).

const { logAudit } = require('./_audit-log');
const { dateStr, localMidnightMs, checkInMomentMs, checkInMinutes, localDateAt } = require('./_booking-rules');

const REASONS = {
  arrival_fake: 'On arrival: the property does not exist (fake listing)',
  arrival_failed: 'On arrival: not as listed, or not available'
};
const REPORT_REASON = { arrival_fake: 'fake', arrival_failed: 'not_as_listed' };
const MAX_OFFERS = 3;
const MAX_CANDIDATES = 20;
const CONFIRM_AFTER_CHECKOUT_HOURS = 24;   // a guest may still confirm a listing is real until then
const ACTIVE = ['open', 'confirmed', 'rebooking', 'refunding'];
const NOT_READY = 'The check-in promise is not switched on yet. Please try again later, or raise a request in the Resolution Center (Help → Raise a request).';
// The host notice that announces the payout timing; its `effective` date is
// the first arrival date the "until check-out" hold applies to.
const HOLD_NOTICE_ID = '2026-11-10-checkin-promise';
const HOLD_FROM_FALLBACK = '2026-12-10';   // same date, used only if aerva-policies.js cannot be read
function holdFrom() {
  const u = require('./_policy-updates').loadUpdates().find(x => x.id === HOLD_NOTICE_ID);
  if (u) return u.effective;
  if (!holdFrom.warned) { holdFrom.warned = true; console.error(`check-in promise: notice ${HOLD_NOTICE_ID} not found in aerva-policies.js; payout hold from ${HOLD_FROM_FALLBACK}`); }
  return HOLD_FROM_FALLBACK;
}

const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const niceDate = (d) => new Date(dateStr(d) + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isArrivalReason = (r) => !!REASONS[r];
const supportTo = () => process.env.SUPPORT_EMAIL || process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in';

async function email(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html: `<div style="font-family:sans-serif; max-width:520px; color:#1c1a17; line-height:1.6;">${html}</div>` }) });
    return r.ok;
  } catch (e) { return false; }
}

// The database update (migrations/2026-11-09-07-checkin-promise.sql) is in.
// Only a positive answer is remembered: the update may be applied while
// this instance is running.
let readyCache = false;
async function ready(sql) {
  if (readyCache) return true;
  try {
    await sql`SELECT id, offers FROM checkin_reports LIMIT 0`;
    await sql`SELECT checkin_blocked_at, checkin_verified_at FROM listings LIMIT 0`;
    await sql`SELECT guest_confirmed_stay_at, checkin_rebook_of FROM orders LIMIT 0`;
    readyCache = true;
  } catch (e) { return false; }
  return true;
}
async function assertReady(sql) { if (!(await ready(sql))) throw userError(NOT_READY, 503); }

function checkoutMs(departure, zone, checkOutTime) {
  return localMidnightMs(dateStr(departure), zone) + checkInMinutes(checkOutTime || '11:00') * 60000;
}
// The guest staying on a gift: they are the one at the door, so they are
// kept informed (owner, 12 Nov 2026). The person who PAID still makes every
// decision and receives any money — this is news, not a choice.
async function giftGuest(sql, orderId) {
  try {
    // The account that ACCEPTED it is the one staying and the one with the
    // booking in My Bookings; the address it was sent to may be another.
    const g = (await sql`SELECT COALESCE(g.accepted_first_name, g.recipient_first_name) AS first_name,
                                COALESCE(gu.email, g.recipient_email) AS recipient_email, g.buyer_first_name
                         FROM booking_gifts g LEFT JOIN guests gu ON gu.id = g.accepted_guest_id
                         WHERE g.order_id = ${Number(orderId) || 0} AND g.status = 'accepted' ORDER BY g.id DESC LIMIT 1`)[0];
    return g && g.recipient_email ? { email: g.recipient_email, firstName: g.first_name || 'there', buyer: g.buyer_first_name || 'the person who booked it' } : null;
  } catch (err) { return null; }
}
// One line of news for the guest staying. Never an action, never an amount.
async function tellGiftGuest(sql, orderId, subject, lead, body) {
  const who = await giftGuest(sql, orderId);
  if (!who) return false;
  await email(who.email, subject,
    `<h2 style="font-family:Georgia,serif;">${esc(lead)}</h2>
     <p>Hello ${esc(who.firstName)},</p>
     ${body}
     <p style="font-size:13px; color:#6e675d;">${esc(who.buyer)} booked this stay, so Aerva settles any new place or refund with them. You can follow where it stands in My Bookings.</p>
     <p><a href="https://aerva.in/index.html?view=my-bookings" style="color:#8a6c39;">Open My Bookings</a></p>`);
  return true;
}

async function hostAccount(sql, hostId) {
  return (await sql`SELECT id, email, phone FROM guests WHERE host_id = ${hostId} ORDER BY id LIMIT 1`)[0] || null;
}
async function loadOrder(sql, orderId) {
  return (await sql`
    SELECT o.*, l.property_name, l.city, l.host_id, l.status AS listing_status, l.latitude, l.longitude,
           COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata') AS tz,
           to_jsonb(l)->>'check_in_time' AS check_in_time, to_jsonb(l)->>'check_out_time' AS check_out_time,
           COALESCE(o.confirmation_code, '#' || o.id) AS code,
           (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date AS local_today
    FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${Number(orderId) || 0}`)[0] || null;
}
async function loadReport(sql, reportId) {
  return (await sql`SELECT * FROM checkin_reports WHERE id = ${Number(reportId) || 0}`)[0] || null;
}
function stayLine(o) { return `${o.property_name || o.suite_name} (${niceDate(o.arrival)} → ${niceDate(o.departure)}, booking ${o.code || '#' + o.id})`; }

// The booking as the guest paid for it — kept on the report, so the guest's
// one summary can show it after the original row is closed.
function snapshot(o) {
  return {
    orderId: o.id, code: o.confirmation_code || null, listingId: o.listing_id, suite: o.suite_name, arrival: dateStr(o.arrival), departure: dateStr(o.departure),
    nights: Number(o.nights) || 0, guests: Number(o.guests) || 0, subtotal: Math.round(Number(o.subtotal) || 0), gst: Math.round(Number(o.gst) || 0),
    fee: Math.round(Number(o.guest_service_fee) || 0), deposit: Math.round(Number(o.deposit_amount) || 0), total: Math.round(Number(o.total) || 0),
    coupon: Math.round(Number(o.coupon_discount) || 0), creditUsed: Math.round(Number(o.fee_credit_used) || 0), paymentId: o.razorpay_payment_id || null
  };
}

// ---------------------------------------------------------------------
// PAYOUT HOLDS. Map orderId → why its payout is held (absent: not held).
// Used by _payouts.js (createPayoutRows, attemptPayout) and Admin → Mark
// paid. Before the database update: nothing is held.
async function payoutHolds(sql, orderIds) {
  const out = new Map();
  const ids = [...new Set((orderIds || []).map(Number).filter(Boolean))];
  if (!ids.length || !(await ready(sql))) return out;
  let rows = [];
  try {
    rows = await sql`
      SELECT o.id, o.arrival, o.departure, COALESCE(o.order_type, 'stay') AS order_type, o.guest_confirmed_stay_at,
             COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata') AS tz, to_jsonb(l)->>'check_out_time' AS check_out_time,
             l.checkin_blocked_at, l.checkin_verified_at,
             EXISTS (SELECT 1 FROM checkin_reports r WHERE r.order_id = o.id AND r.status = ANY(${ACTIVE})) AS reported,
             EXISTS (SELECT 1 FROM checkin_reports r WHERE r.listing_id = o.listing_id AND r.reason = 'fake' AND r.status = 'open') AS fake_open,
             NOT EXISTS (SELECT 1 FROM orders p WHERE p.listing_id = o.listing_id AND p.status = 'paid' AND COALESCE(p.order_type, 'stay') = 'stay'
                           AND (p.arrival < o.arrival OR (p.arrival = o.arrival AND p.id < o.id))) AS first_stay
      FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ANY(${ids})`;
  } catch (e) { return out; }
  const now = Date.now();
  const from = holdFrom();
  for (const r of rows) {
    if (r.reported) { out.set(r.id, 'A report made on arrival is being settled by Aerva'); continue; }
    if (r.fake_open) { out.set(r.id, 'A guest reported this listing as not existing; held until Aerva decides'); continue; }
    if (r.checkin_blocked_at) { out.set(r.id, 'The listing is blocked by Aerva (check-in promise)'); continue; }
    // A listing's FIRST stay (owner, 10 Nov 2026: "first payout would be
    // after guest check-out"): its payout is sent after that guest's
    // check-out time. Later bookings are paid as usual. For stays arriving
    // on or after the notice's effective date only (holdFrom). Guests are
    // still asked whether the place is real; that no longer holds payouts.
    if (r.order_type === 'stay' && dateStr(r.arrival) >= from && r.first_stay) {
      const until = checkoutMs(r.departure, r.tz, r.check_out_time);
      if (now < until) out.set(r.id, `Held until check-out (${new Date(until).toISOString()}): the first stay at this listing`);
    }
  }
  return out;
}
async function holdFor(sql, orderId) { return (await payoutHolds(sql, [orderId])).get(Number(orderId)) || null; }

// ---------------------------------------------------------------------
// 1. THE GUEST REPORTS (called by _stay-disputes.js raiseDispute, after the
// stay_disputes row is written).
async function openReport(sql, { dispute, order }) {
  const o = await loadOrder(sql, order.id);
  const reason = REPORT_REASON[dispute.reason];
  let before = null;
  const report = (await sql`INSERT INTO checkin_reports (order_id, dispute_id, listing_id, host_id, guest_id, reason)
                            VALUES (${o.id}, ${dispute.id}, ${o.listing_id}, ${o.host_id}, ${o.guest_id}, ${reason}) RETURNING *`)[0];
  // A fake listing is hidden at once: out of search, cannot be booked.
  if (reason === 'fake' && ['approved', 'deactivated'].includes(o.listing_status)) {
    const hid = await sql`UPDATE listings SET status = 'blocked', admin_status_reason = 'Hidden while Aerva checks a guest report (check-in promise)'
                          WHERE id = ${o.listing_id} AND status = ${o.listing_status} RETURNING id`;
    if (hid.length) {
      before = o.listing_status;
      await sql`UPDATE checkin_reports SET listing_status_before = ${before} WHERE id = ${report.id}`;
    }
  }
  const S = require('./_support');
  const host = await hostAccount(sql, o.host_id);
  const what = REASONS[dispute.reason];
  // A gift: the guest staying reported it, not the person who paid, so say so.
  const staying = await giftGuest(sql, o.id);
  const who = staying ? `${staying.firstName}, the guest staying,` : 'You';
  const guestTicket = o.guest_id ? await S.openSystemRequest(sql, { guestId: o.guest_id, role: 'guest', category: 'stay_problem', orderId: o.id, urgent: true,
    subject: staying ? 'A problem on arrival at your gifted stay: Aerva is on it' : 'Your report on arrival: Aerva is on it',
    body: `${who} reported ${stayLine(o)}: ${what}.\n\nAerva is on it, and will come back to you within 24 hours — sooner if we can. You will be offered other places nearby for the rest of your stay: you pay only the difference in price and GST, and if a place costs less the difference comes back to you as Aerva credit. If none of them suits you, everything you paid is refunded in full, including Aerva’s service fee.\n\nYou will see the places in My Bookings and by email. Add anything that helps (photos, a message) by replying here.` }) : null;
  const hostTicket = host ? await S.openSystemRequest(sql, { guestId: host.id, role: 'host', category: 'stay_problem', orderId: o.id, urgent: true,
    subject: 'Urgent: your guest reported a problem on arrival',
    body: `Your guest reported ${stayLine(o)}: ${what}.\n\n${reason === 'fake' ? 'The listing is hidden from search while Aerva checks this. ' : ''}Your payout for this booking is on hold until Aerva decides. Please reply in Messages now with your side and photos.\n\nIf Aerva confirms the report, the guest is moved to another place or refunded in full, and you are not paid for this booking (anything already paid out is deducted from your later payouts).${reason === 'fake' ? ' The listing then stays blocked and only Aerva can unblock it.' : ''}` }) : null;
  await sql`UPDATE checkin_reports SET guest_ticket_id = ${guestTicket ? guestTicket.id : null}, host_ticket_id = ${hostTicket ? hostTicket.id : null} WHERE id = ${report.id}`;
  // The guest staying hears straight away that it is in hand. News only:
  // the person who paid makes every choice and receives any money.
  if (staying) await tellGiftGuest(sql, o.id, `Aerva is on it: ${o.property_name}`, 'Aerva is looking into it now',
    `<p>You reported <strong>${esc(stayLine(o))}</strong>: ${esc(what)}.</p>
     <p>Aerva is on it and will be in touch within 24 hours, and sooner if we can.</p>`);
  const { postThreadMessage } = require('./_cancellations');
  await postThreadMessage(sql, o.id, 'system', `Aerva has been alerted (urgent): ${what}. ${reason === 'fake' ? 'The listing is hidden from search while Aerva checks. ' : ''}Your payout for this booking is on hold. Please reply here with your side and photos. Aerva decides; if the report is confirmed, the guest is offered another place or refunded in full.`, { audience: 'host' });
  await postThreadMessage(sql, o.id, 'system', `Reported to Aerva: ${what}. Aerva is on it and will come back to you within 24 hours, sooner if we can. Anything that helps — photos, a message — can go here.`, { audience: 'guest' });
  await email(supportTo(), `URGENT — check-in promise: ${what} (${o.code})`,
    `<p><strong>${esc(stayLine(o))}</strong></p><p>${esc(what)}: ${esc(dispute.details || '')}</p>
     <p>Host: ${esc(host && host.email || 'no email')} · ${esc(host && host.phone || 'no phone')}</p>
     <p>Decide it in Admin → Approvals → Check-in promise.${reason === 'fake' ? ' The listing is hidden until then.' : ''}</p>`);
  await email(host && host.email, `Urgent: your guest reported a problem on arrival at ${o.property_name}`,
    `<h2 style="font-family:Georgia,serif;">Your guest reported a problem on arrival</h2><p><strong>${esc(stayLine(o))}</strong></p><p>${esc(what)}: ${esc(dispute.details || '')}</p>
     <p>${reason === 'fake' ? 'The listing is hidden from search while Aerva checks this. ' : ''}Your payout for this booking is on hold until Aerva decides. Please reply in Messages now with your side and photos.</p>
     <p><a href="https://aerva.in/index.html?view=messages" style="color:#8a6c39;">Open Messages</a></p>`);
  await email(o.guest_email, `We are on it: your report about ${o.property_name}`,
    `<h2 style="font-family:Georgia,serif;">Aerva is on it</h2><p>${esc(what)}.</p><p>You will hear from Aerva within 24 hours, sooner if we can. You will be offered other places for the rest of your stay — you pay only the difference in price and GST — or everything you paid is refunded in full, including Aerva’s service fee.</p>`);
  await require('./_alerts').alertHost(sql, o.host_id, `Aerva URGENT: your guest at ${o.property_name} reported a problem on arrival. Reply in Messages now.`);
  await logAudit(sql, { action: 'checkin_report_opened', success: true, actorType: 'guest', actorIdentifier: String(o.guest_id || ''), targetType: 'order', targetId: o.id,
    metadata: { reportId: report.id, reason, listingHidden: !!before, guestTicket: guestTicket && guestTicket.ref, hostTicket: hostTicket && hostTicket.ref } });
  return report;
}

// ---------------------------------------------------------------------
// 2. AERVA DECIDES. Three ways out (the third added by the owner on
// 13 Nov 2026):
//   'confirmed' — the report stands; rebook or refund follows.
//   'cleared'   — it does not stand; the booking is unchanged.
//   'corrected' — the place is real and the guest can stay, but the
//                 listing was wrong on some point. The payout hold lifts
//                 (this status is not in ACTIVE), the host keeps every
//                 rupee and has nothing held against them, and a
//                 correction is filed so they are asked to put the
//                 listing right. No money moves.
// 'corrected' exists for the guest who reached for the heavy option over
// something small — which will happen however carefully the card is
// worded. Clearing the report would tell a truthful guest they were
// wrong; confirming it would cost the host the whole booking over paint.
// `upheld` is still accepted on its own, and still means confirmed.
async function decideReport(sql, { reportId, upheld, outcome, note = '', adminLabel = 'admin' }) {
  await assertReady(sql);
  const text = String(note || '').trim().slice(0, 1000);
  const how = ['confirmed', 'cleared', 'corrected'].includes(String(outcome || '')) ? String(outcome) : (upheld ? 'confirmed' : 'cleared');
  if (how === 'cleared' && text.length < 5) throw userError('Write why the report is not upheld — the guest is told.');
  if (how === 'corrected' && text.length < 5) throw userError('Write what the listing has wrong — the guest and the host are both told.');
  const got = await sql`UPDATE checkin_reports SET status = ${how}, decided_at = now(), decided_by = ${adminLabel}, decision_note = ${text || null},
                          closed_at = ${how === 'confirmed' ? null : new Date().toISOString()}
                        WHERE id = ${Number(reportId) || 0} AND status = 'open' RETURNING *`;
  if (!got.length) throw userError('This report has already been decided.', 409);
  const r = got[0];
  const o = await loadOrder(sql, r.order_id);
  const S = require('./_support');
  const { postThreadMessage } = require('./_cancellations');
  const host = await hostAccount(sql, r.host_id);
  if (r.dispute_id) {
    try { await sql`UPDATE stay_disputes SET status = ${how === 'confirmed' ? 'upheld' : 'no_refund'}, decided_at = now(), decided_by = ${adminLabel}, decision_note = ${text || null} WHERE id = ${r.dispute_id}`; }
    catch (e) { console.error('dispute not closed:', r.dispute_id, e.message); }
  }
  if (how === 'corrected') {
    // Put a hidden listing back first: a fake report that turns out to be
    // a correction means the place is plainly real.
    let restored = false;
    if (r.reason === 'fake' && r.listing_status_before) {
      const other = await sql`SELECT 1 FROM checkin_reports WHERE listing_id = ${r.listing_id} AND reason = 'fake' AND status = 'open' AND id <> ${r.id} LIMIT 1`;
      if (!other.length) {
        restored = (await sql`UPDATE listings SET status = ${r.listing_status_before}, admin_status_reason = NULL
                              WHERE id = ${r.listing_id} AND status = 'blocked' AND checkin_blocked_at IS NULL RETURNING id`).length > 0;
      }
    }
    // The place is real — the guest is in it — so the listing gets its check.
    await sql`UPDATE orders SET guest_confirmed_stay_at = COALESCE(guest_confirmed_stay_at, now()) WHERE id = ${r.order_id}`;
    let correctionId = null;
    try {
      const LC = require('./_listing-corrections');
      if (await LC.ready(sql)) {
        const saved = await LC.create(sql, { orderId: r.order_id, guestId: r.guest_id, what: text, photos: [], source: 'stepped_down', reportId: r.id, adminLabel });
        correctionId = saved.id;
      }
    } catch (e) { console.error('correction not filed from report:', r.id, e.message); }
    await S.systemUpdate(sql, r.guest_ticket_id, `Aerva has looked at this. The place is real and your booking stands, so there is no refund — but you were right that the listing does not match on this point, and Aerva has asked your host to put it right: ${text}`, { resolve: true });
    // The host already knows a report was made — they were told when it
    // was opened and their payout was held — so the outcome has to reach
    // them. What it does NOT do is hand them the guest's words back
    // (owner, 14 Nov 2026): Aerva speaks in its own voice, about the
    // listing, as something to improve.
    await S.systemUpdate(sql, r.host_ticket_id, `Aerva has looked at this and is not upholding it. You keep this booking, the payout hold is lifted, and nothing is held against you. One thing on the listing itself is worth updating, so the photos and the description show the place as it is today: ${text}`, { resolve: true });
    // Guest side only: the thread belongs to the booking, and a host who
    // reads a line there knows exactly whose stay it came from.
    await postThreadMessage(sql, r.order_id, 'system', 'Aerva has looked at the report made on arrival. The place is real and the booking stands, and Aerva has asked the host to put the listing right.', { audience: 'guest' });
    await email(o.guest_email, `Your report about ${o.property_name}`,
      `<h2 style="font-family:Georgia,serif;">Aerva has looked at your report</h2>
       <p>The place is real and your booking stands, so nothing is refunded — but you were right that the listing does not match:</p>
       <p style="padding:10px 12px; background:#f4eadc; border-radius:8px;">${esc(text)}</p>
       <p>Aerva has asked your host to put the listing right, so the next guest sees the real thing. Thank you for telling us.</p>`);
    await email(host && host.email, `Not upheld — and one update for ${o.property_name}`,
      `<p>Aerva has reviewed the report made on arrival and is <strong>not</strong> upholding it.${restored ? ' Your listing is live again.' : ''} You keep this booking, the hold on its payout is lifted, and nothing is held against you.</p>
       <p>Checking the place against the listing did turn up one detail worth updating, so that what guests expect and what they walk into are the same thing:</p>
       <p style="padding:10px 12px; background:#f4eadc; border-radius:8px;">${esc(text)}</p>
       <p>There is no deadline and no penalty — it is so the next guest sees the real thing.</p>`);
    await logAudit(sql, { action: 'checkin_report_corrected', success: true, actorType: 'admin', actorIdentifier: adminLabel, targetType: 'order', targetId: r.order_id,
      metadata: { reportId: r.id, reason: r.reason, listingRestored: restored, correctionId, note: text } });
    return { status: 'corrected', listingRestored: restored, correctionId };
  }
  if (how !== 'confirmed') {
    // Back live, unless Aerva blocked the listing or another fake report on it is open.
    let restored = false;
    if (r.reason === 'fake' && r.listing_status_before) {
      const other = await sql`SELECT 1 FROM checkin_reports WHERE listing_id = ${r.listing_id} AND reason = 'fake' AND status = 'open' AND id <> ${r.id} LIMIT 1`;
      if (!other.length) {
        restored = (await sql`UPDATE listings SET status = ${r.listing_status_before}, admin_status_reason = NULL
                              WHERE id = ${r.listing_id} AND status = 'blocked' AND checkin_blocked_at IS NULL RETURNING id`).length > 0;
      }
    }
    await S.systemUpdate(sql, r.guest_ticket_id, `Aerva has reviewed your report and did not uphold it: ${text}. Your booking stays as it is.`, { resolve: true });
    await S.systemUpdate(sql, r.host_ticket_id, `Aerva has reviewed the report and did not uphold it.${restored ? ' Your listing is live again.' : ''} The hold on this booking’s payout is lifted.`, { resolve: true });
    await postThreadMessage(sql, r.order_id, 'system', 'Aerva has reviewed the report made on arrival and did not uphold it. The booking stays as it is.');
    await email(o.guest_email, `Your report about ${o.property_name}`, `<h2 style="font-family:Georgia,serif;">Aerva has reviewed your report</h2><p>After checking with your host, Aerva did not uphold it: ${esc(text)}</p><p>Your booking stays as it is. Aerva’s decision is final.</p>`);
    await email(host && host.email, `Report not upheld: ${o.property_name}`, `<p>Aerva reviewed your guest’s report on arrival and did not uphold it.${restored ? ' Your listing is live again.' : ''} The hold on this booking’s payout is lifted.</p>`);
    await tellGiftGuest(sql, r.order_id, `Your report about ${o.property_name}`, 'Aerva has reviewed the report',
      `<p>After checking with the host, Aerva did not uphold the report about <strong>${esc(stayLine(o))}</strong>. The booking stays as it is.</p>
       <p style="background:#f6f1ea; border-left:3px solid #a9884f; padding:10px 14px; white-space:pre-wrap;">${esc(text)}</p>`);
    await logAudit(sql, { action: 'checkin_report_cleared', success: true, actorType: 'admin', actorIdentifier: adminLabel, targetType: 'order', targetId: r.order_id, metadata: { reportId: r.id, reason: r.reason, listingRestored: restored, note: text } });
    return { status: 'cleared', listingRestored: restored };
  }
  // Confirmed.
  await sql`UPDATE checkin_reports SET original = ${JSON.stringify(snapshot(o))}::jsonb WHERE id = ${r.id}`;
  if (r.reason === 'fake') {
    await sql`UPDATE listings SET status = CASE WHEN status = 'removed' THEN status ELSE 'blocked' END, checkin_blocked_at = COALESCE(checkin_blocked_at, now()),
                admin_status_reason = 'Blocked by Aerva: a guest found the property does not exist (check-in promise). Only Aerva can unblock it.'
              WHERE id = ${r.listing_id}`;
  }
  // A change the guest had asked for on this booking can no longer go ahead.
  try {
    const closed = await sql`UPDATE booking_changes SET status = 'expired' WHERE order_id = ${r.order_id} AND status IN ('pending', 'awaiting_payment') RETURNING razorpay_order_id`;
    for (const c of closed) if (c.razorpay_order_id) await require('./_booking-rules').releaseHolds(sql, { razorpayOrderId: c.razorpay_order_id, reason: 'closed' });
  } catch (e) { /* booking_changes not created yet */ }
  const nightsLeft = rebookRange(o).nights;
  await S.systemUpdate(sql, r.guest_ticket_id, `Aerva has confirmed your report. ${nightsLeft ? 'We are finding you another place nearby for the rest of your stay; the options will appear in My Bookings shortly. You pay only the difference in price and GST.' : 'There are no nights left to move, so'} If none suits you, you can decline them and everything you paid is refunded in full, including Aerva’s service fee.`);
  await S.systemUpdate(sql, r.host_ticket_id, `Aerva has confirmed the guest’s report. You are not paid for this booking; anything already paid out for it is deducted from your later payouts.${r.reason === 'fake' ? ' The listing is blocked: only Aerva can unblock it, and its future bookings are reviewed by Aerva.' : ''}`, { resolve: true });
  await postThreadMessage(sql, r.order_id, 'system', `Aerva has confirmed the report made on arrival. The guest is offered another place or a full refund, and you are not paid for this booking.`, { audience: 'host' });
  await postThreadMessage(sql, r.order_id, 'system', 'Aerva confirmed your report. You will be offered other places for the rest of your stay — you pay only the difference in price and GST — or everything you paid is refunded in full.', { audience: 'guest' });
  await email(o.guest_email, `Aerva confirmed your report — we are finding you another place`,
    `<h2 style="font-family:Georgia,serif;">Aerva confirmed your report</h2><p><strong>${esc(stayLine(o))}</strong></p>
     <p>We are finding you another place nearby for the rest of your stay. The options will appear in My Bookings shortly: you pay only the difference in price and GST, and if a place costs less the difference comes back to you as Aerva credit. If none suits you, decline them and everything you paid is refunded in full, including Aerva’s service fee.</p>
     <p><a href="https://aerva.in/index.html?view=my-bookings" style="color:#8a6c39;">Open My Bookings</a></p>`);
  await email(host && host.email, `Decision on the report at ${o.property_name}`,
    `<h2 style="font-family:Georgia,serif;">Aerva confirmed your guest’s report</h2><p><strong>${esc(stayLine(o))}</strong></p>
     <p>You are not paid for this booking; anything already paid out for it is deducted from your later payouts.${r.reason === 'fake' ? ' The listing is blocked: you cannot reactivate it, and only Aerva can unblock it. Its future bookings are reviewed by Aerva, and those guests are moved or refunded.' : ''}</p>${text ? `<p>${esc(text)}</p>` : ''}`);
  await tellGiftGuest(sql, r.order_id, `Aerva confirmed the report about ${o.property_name}`, 'Aerva confirmed the report',
    `<p><strong>${esc(stayLine(o))}</strong></p>
     <p>Aerva has confirmed what was reported on arrival.${nightsLeft ? ' Aerva is finding another place nearby for the rest of the stay.' : ''} The host is not paid for this booking.</p>`);
  // Places go out at once, without waiting for someone at a desk: a guest
  // is standing outside at midnight (owner, 12 Nov 2026). Aerva picks the
  // nearest, then the closest in price — the same list the admin sees, and
  // an admin can replace them at any time with Send places.
  let autoOffers = 0;
  if (nightsLeft) {
    try {
      const all = await candidates(sql, { reportId: r.id });
      const pick = (all.candidates || []).slice(0, MAX_OFFERS);
      if (pick.length) {
        const sent = await sendOffers(sql, { reportId: r.id, options: pick.map(k => ({ listingId: k.listingId, roomId: k.roomId })), adminLabel: 'Aerva (automatic)' });
        autoOffers = (sent.offers || []).length;
      }
    } catch (err) {
      // A group booking, nothing free nearby, or the list could not be
      // priced: the guest keeps "Refund me in full", and the email below
      // asks an admin to look.
      console.error('check-in promise: places not offered automatically:', err.message);
    }
  }
  if (!autoOffers) {
    await S.systemUpdate(sql, r.guest_ticket_id, 'Aerva has not found another place nearby that is free for the rest of your stay. You can ask to be refunded in full at any time, and we will keep looking meanwhile.');
    await tellGiftGuest(sql, r.order_id, `No other place yet near ${o.property_name}`, 'Aerva has not found another place yet',
      `<p>Aerva is still looking for somewhere nearby for the rest of the stay. The person who booked it can ask for a full refund instead at any time.</p>`);
  }
  await email(supportTo(), autoOffers ? `Check-in promise confirmed — ${autoOffers} place(s) offered automatically (${o.code})` : `Check-in promise confirmed — NO place offered, look now (${o.code})`, `<p>${esc(stayLine(o))}: choose up to ${MAX_OFFERS} places in Admin → Approvals → Check-in promise and send them, or refund in full.</p>`);
  await logAudit(sql, { action: 'checkin_report_confirmed', success: true, actorType: 'admin', actorIdentifier: adminLabel, targetType: 'order', targetId: r.order_id,
    metadata: { reportId: r.id, reason: r.reason, listingBlocked: r.reason === 'fake', note: text } });
  return { status: 'confirmed', nightsLeft };
}

// A future booking of a listing Aerva blocked as fake: Aerva starts the
// rebook-or-refund for its guest (Admin → Check-in promise).
async function startListingReview(sql, { orderId, adminLabel = 'admin', note = '' }) {
  await assertReady(sql);
  const o = await loadOrder(sql, orderId);
  if (!o || o.status !== 'paid') throw userError('Only a confirmed booking can be moved or refunded.', 409);
  const l = (await sql`SELECT checkin_blocked_at FROM listings WHERE id = ${o.listing_id}`)[0];
  if (!l || !l.checkin_blocked_at) throw userError('This listing is not blocked under the check-in promise.', 409);
  let r;
  try {
    r = (await sql`INSERT INTO checkin_reports (order_id, listing_id, host_id, guest_id, reason, source, status, decided_at, decided_by, decision_note, original)
                   VALUES (${o.id}, ${o.listing_id}, ${o.host_id}, ${o.guest_id}, 'fake', 'listing_review', 'confirmed', now(), ${adminLabel}, ${String(note || '').slice(0, 1000) || null}, ${JSON.stringify(snapshot(o))}::jsonb)
                   RETURNING *`)[0];
  } catch (err) {
    if (/idx_checkin_reports_active|duplicate key/.test(err.message)) throw userError('This booking is already being handled.', 409);
    throw err;
  }
  try {
    const closed = await sql`UPDATE booking_changes SET status = 'expired' WHERE order_id = ${o.id} AND status IN ('pending', 'awaiting_payment') RETURNING razorpay_order_id`;
    for (const c of closed) if (c.razorpay_order_id) await require('./_booking-rules').releaseHolds(sql, { razorpayOrderId: c.razorpay_order_id, reason: 'closed' });
  } catch (e) { /* none */ }
  const S = require('./_support');
  const t = o.guest_id ? await S.openSystemRequest(sql, { guestId: o.guest_id, role: 'guest', category: 'stay_problem', orderId: o.id, urgent: true,
    subject: 'Your booking: Aerva will move you or refund you in full',
    body: `Aerva could not confirm that ${stayLine(o)} exists as listed, so your stay there cannot go ahead.\n\nAerva will offer you other places nearby for the same nights — you pay only the difference in price and GST, and if a place costs less the difference comes back as Aerva credit. If none suits you, everything you paid is refunded in full, including Aerva’s service fee. You will see the options in My Bookings.` }) : null;
  if (t) await sql`UPDATE checkin_reports SET guest_ticket_id = ${t.id} WHERE id = ${r.id}`;
  await require('./_cancellations').postThreadMessage(sql, o.id, 'system', 'Aerva could not confirm this listing exists as listed, so this booking is moved to another place or refunded in full. You are not paid for it.', { audience: 'host' });
  await require('./_cancellations').postThreadMessage(sql, o.id, 'system', 'This stay cannot go ahead as booked. Aerva will offer you other places for the same nights — you pay only the difference in price and GST — or refund everything you paid in full.', { audience: 'guest' });
  await email(o.guest_email, `Your booking at ${o.property_name}: Aerva will move you or refund you`,
    `<h2 style="font-family:Georgia,serif;">Your stay cannot go ahead as booked</h2><p>Aerva could not confirm that <strong>${esc(o.property_name)}</strong> exists as listed. We will offer you other places for the same nights (you pay only the difference in price and GST), or refund everything you paid, including Aerva’s service fee.</p>
     <p><a href="https://aerva.in/index.html?view=my-bookings" style="color:#8a6c39;">Open My Bookings</a></p>`);
  await logAudit(sql, { action: 'checkin_listing_review_started', success: true, actorType: 'admin', actorIdentifier: adminLabel, targetType: 'order', targetId: o.id, metadata: { reportId: r.id } });
  return { reportId: r.id };
}

// ---------------------------------------------------------------------
// 3. REBOOK FIRST. The nights still to come: from today (or check-in, if
// later) to check-out.
function rebookRange(o) {
  const arr = dateStr(o.arrival), dep = dateStr(o.departure), today = dateStr(o.local_today) || arr;
  const from = today > arr ? today : arr;
  const nights = Math.max(0, Math.round((new Date(dep + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000));
  return { from, to: dep, nights, started: from > arr || today >= arr };
}
function km(a, b) {
  const la1 = Number(a.latitude), lo1 = Number(a.longitude), la2 = Number(b.latitude), lo2 = Number(b.longitude);
  if (![la1, lo1, la2, lo2].every(Number.isFinite)) return null;
  const R = 6371, rad = (x) => x * Math.PI / 180;
  const h = Math.sin(rad(la2 - la1) / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(rad(lo2 - lo1) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}
// The place priced for the nights the normal way. Throws a user-facing error.
async function priceFor(sql, o, { listingId, roomId, from, to }) {
  const pets = Array.isArray(o.pet_types) ? o.pet_types : [];
  const priced = await require('./_pricing').priceStay(sql, {
    listingId, roomId: roomId || null, arrival: from, departure: to, guests: Number(o.guests), adults: Number(o.guests),
    keepArrival: from <= dateStr(o.local_today), pets: pets.length, petTypes: pets,
    serviceAnimals: Array.isArray(o.service_animal_types) ? o.service_animal_types : [], youngLitterCount: pets.length ? Number(o.young_litter_count) || 0 : 0,
    selectedAmenities: []
  }, 0);
  if (priced.error) throw userError(priced.error.replace(/^Stay 1: /, ''));
  const d = priced.detail;
  // NO AERVA SERVICE FEE ON A RESCUE BOOKING (owner, 14 Nov 2026). The
  // guest already paid Aerva's fee on the stay their host failed to
  // provide; charging it again on the replacement would push the gap they
  // have to find ABOVE the plain difference in price between the two
  // places — the owner's words: "otherwise guest might have ended up with
  // more than 3000". Aerva keeps what it earned on the original booking
  // and takes nothing further for moving them, which is the compensation.
  // The commission the failed host would have been paid is not Aerva's to
  // keep either way: that booking is cancelled and they are paid nothing.
  return { detail: d, feeWaived: Math.round(Number(d.guestServiceFee) || 0),
           total: Math.round(Number(d.subtotal) + Number(d.gst) + Number(d.depositAmount || 0)) };
}
function paidTotal(r, o) { return Math.round(Number((r.original || {}).total != null ? r.original.total : o.total) || 0); }

// AERVA'S COMMISSION ON A RESCUE BOOKING (owner, 14 Nov 2026: "Aerva will
// keep 600 - previous commission").
//
// Aerva never earns more commission on a replacement than it was already
// going to earn on the booking that failed. Moving a stranded guest
// somewhere dearer is not an opportunity to earn more: the extra the guest
// pays is for the better place, and it belongs to the host providing it.
//
// The cap is the ORIGINAL booking's commission in rupees, not a rate
// applied to the lower subtotal. The two give the same answer while every
// listing is on the same rate, but listings.commission_rate is per-listing,
// so a rupee cap is the one that still holds if those rates ever differ.
//
// Worked example, the owner's own case: original ₹12,000 subtotal at 5% =
// ₹600 commission; rescue ₹16,000 at 5% would be ₹800. Aerva takes ₹600 and
// the rescuing host keeps ₹15,400 rather than ₹15,200. Aerva still keeps
// the ₹600 service fee from the original booking, so it earns ₹1,200 on the
// move — it is not doing this for nothing, it is simply not profiting from
// its own host's failure.
//
// A replacement that costs the same or less is unaffected: its own
// commission is already at or below the cap.
//
// `o` is the original order, read before it is zeroed by the move.
function rescueCommission(d, o) {
  const own = Math.round(Number(d.baseCommission) + Number(d.amenityCommission));
  // A missing figure is a data problem, not a decision to charge nothing —
  // fall back to the replacement's own commission rather than silently
  // handing away Aerva's margin. A genuine zero IS honoured.
  const prev = o == null || o.commission_amount == null ? null : Math.round(Number(o.commission_amount));
  if (prev == null || !Number.isFinite(prev) || prev < 0) return own;
  return Math.min(own, prev);
}

// Admin: the places the guest could move to, nearest first, then closest in price.
async function candidates(sql, { reportId }) {
  await assertReady(sql);
  const r = await loadReport(sql, reportId);
  if (!r || r.status !== 'confirmed') throw userError('Places can be offered once Aerva has confirmed the report.', 409);
  const o = await loadOrder(sql, r.order_id);
  const range = rebookRange(o);
  if (!range.nights) return { reportId: r.id, from: range.from, to: range.to, nights: 0, oldTotal: paidTotal(r, o), candidates: [], unavailable: 0 };
  const oldTotal = paidTotal(r, o);
  const listings = await sql`
    SELECT l.id, l.property_name, l.property_type, l.city, to_jsonb(l)->>'area' AS area, l.latitude, l.longitude,
           COALESCE(l.cancellation_policy, 'flexible') AS policy,
           COALESCE(NULLIF(btrim(l.cover_photo_url), ''), CASE WHEN jsonb_typeof(l.exterior_photo_urls->0) = 'string' THEN l.exterior_photo_urls->>0 ELSE l.exterior_photo_urls->0->>'url' END) AS photo
    FROM listings l
    WHERE l.status = 'approved' AND COALESCE(l.listing_type, 'stay') <> 'experience' AND l.id <> ${o.listing_id}
      AND l.checkin_blocked_at IS NULL AND lower(btrim(COALESCE(l.city, ''))) = lower(btrim(${o.city || ''}))
      AND NOT EXISTS (SELECT 1 FROM checkin_reports x WHERE x.listing_id = l.id AND x.reason = 'fake' AND x.status = 'open')
    LIMIT 80`;
  const out = [];
  let unavailable = 0;
  for (const l of listings) {
    let rooms = [{ id: null, name: null }];
    if (l.property_type === 'Resort') {
      try { rooms = (await sql`SELECT id, room_name FROM listing_rooms WHERE listing_id = ${l.id} AND is_active = TRUE ORDER BY id`).map(x => ({ id: x.id, name: x.room_name || 'Room' })); }
      catch (e) { rooms = []; }
    }
    for (const rm of rooms) {
      try {
        const p = await priceFor(sql, o, { listingId: l.id, roomId: rm.id, from: range.from, to: range.to });
        const d = p.detail;
        out.push({ listingId: l.id, roomId: rm.id, name: rm.name ? `${l.property_name} — ${rm.name}` : l.property_name, city: l.city, area: l.area || null, photo: l.photo || null,
          policy: l.policy, distanceKm: km(o, l), from: range.from, to: range.to, nights: range.nights,
          // fee 0, and what was waived shown beside it: Aerva charges no
          // service fee for moving a guest its host let down (owner,
          // 14 Nov 2026). p.total already leaves it out.
          subtotal: Math.round(Number(d.subtotal)), gst: Math.round(Number(d.gst)), fee: 0, feeWaived: p.feeWaived,
          deposit: Math.round(Number(d.depositAmount || 0)),
          total: p.total, oldTotal, difference: p.total - oldTotal });
      } catch (err) { if (err.isUserFacing) unavailable++; else throw err; }
    }
  }
  out.sort((a, b) => ((a.distanceKm == null ? 1e9 : a.distanceKm) - (b.distanceKm == null ? 1e9 : b.distanceKm)) || (Math.abs(a.difference) - Math.abs(b.difference)));
  return { reportId: r.id, from: range.from, to: range.to, nights: range.nights, oldTotal, candidates: out.slice(0, MAX_CANDIDATES), unavailable };
}

// Admin sends up to 3 of them to the guest (sending again replaces them).
async function sendOffers(sql, { reportId, options, adminLabel = 'admin' }) {
  await assertReady(sql);
  const r = await loadReport(sql, reportId);
  if (!r || r.status !== 'confirmed') throw userError('Places can be offered only while the report is confirmed and the guest has not been moved or refunded.', 409);
  // A group booking (paid by several people): the check-in promise refunds
  // each payer in full to their own payment (owner, 10 Nov 2026) — no rebooking.
  if ((await sql`SELECT 1 FROM orders WHERE id = ${r.order_id} AND (to_jsonb(orders)->>'group_booking_id') IS NOT NULL`).length) {
    throw userError('This is a group booking: under the check-in promise each payer is refunded in full to their own payment. Use “Refund in full”.', 409);
  }
  const list = (Array.isArray(options) ? options : []).slice(0, MAX_OFFERS + 1);
  if (!list.length) throw userError('Choose at least one place.');
  if (list.length > MAX_OFFERS) throw userError(`Send at most ${MAX_OFFERS} places.`);
  const all = await candidates(sql, { reportId });
  const offers = [];
  for (const x of list) {
    const c = all.candidates.find(k => Number(k.listingId) === Number(x.listingId) && (Number(k.roomId) || 0) === (Number(x.roomId) || 0));
    if (!c) throw userError('One of the places chosen is no longer free for those nights. Refresh the list.', 409);
    if (offers.some(k => k.listingId === c.listingId && (k.roomId || 0) === (c.roomId || 0))) continue;
    offers.push({ n: offers.length, ...c });
  }
  const got = await sql`UPDATE checkin_reports SET offers = ${JSON.stringify(offers)}::jsonb, offers_sent_at = now() WHERE id = ${r.id} AND status = 'confirmed' RETURNING id`;
  if (!got.length) throw userError('This booking is no longer waiting for places.', 409);
  const o = await loadOrder(sql, r.order_id);
  await require('./_support').systemUpdate(sql, r.guest_ticket_id, `Aerva has sent you ${plural(offers.length, 'place')} to choose from in My Bookings. Accept one, or decline them all for a full refund.`);
  await email(o.guest_email, `Choose your new place (${plural(offers.length, 'option')})`,
    `<h2 style="font-family:Georgia,serif;">Choose where to stay</h2><p>For ${esc(niceDate(offers[0].from))} – ${esc(niceDate(offers[0].to))}:</p>
     <ul>${offers.map(k => `<li><strong>${esc(k.name)}</strong>${k.distanceKm != null ? ` · ${k.distanceKm} km away` : ''} · ${k.difference > 0 ? `you pay ${inr(k.difference)} more` : k.difference < 0 ? `${inr(-k.difference)} back as Aerva credit` : 'no difference to pay'}</li>`).join('')}</ul>
     <p>Accept one in My Bookings, or decline them all and everything you paid is refunded in full, including Aerva’s service fee.</p>
     <p><a href="https://aerva.in/index.html?view=my-bookings" style="color:#8a6c39;">Open My Bookings</a></p>`);
  await logAudit(sql, { action: 'checkin_rebook_offers_sent', success: true, actorType: 'admin', actorIdentifier: adminLabel, targetType: 'order', targetId: r.order_id,
    metadata: { reportId: r.id, offers: offers.map(k => ({ listingId: k.listingId, roomId: k.roomId, total: k.total, difference: k.difference })) } });
  return { offers };
}

// The rebook priced now — the same shape as quoteChange in
// _booking-changes.js (kind 'rebook'), so the change-payment window
// (startChangePayment / confirmChangePayment) works on it unchanged.
async function quoteRebook(sql, orderId, guestId, input) {
  await assertReady(sql);
  const r = await loadReport(sql, input && input.reportId);
  if (!r || Number(r.order_id) !== Number(orderId)) throw userError('Booking not found.', 404);
  if (!['confirmed', 'rebooking'].includes(r.status)) throw userError('This booking is no longer waiting for a new place.', 409);
  const o = await require('./_booking-changes').loadBooking(sql, orderId);
  if (!o || (guestId != null && o.guest_id !== guestId)) throw userError('Booking not found.', 404);
  if (o.status !== 'paid') throw userError('This booking is no longer active.', 409);
  const offer = (Array.isArray(r.offers) ? r.offers : [])[Number(input.option)];
  if (!offer) throw userError('Choose one of the places Aerva sent.');
  const lo = await loadOrder(sql, orderId);
  const range = rebookRange(lo);
  if (!range.nights) throw userError('There are no nights left to move. Decline to have everything refunded in full.', 409);
  const p = await priceFor(sql, lo, { listingId: offer.listingId, roomId: offer.roomId, from: range.from, to: range.to });
  const oldTotal = paidTotal(r, o);
  const newTotal = p.total;
  return {
    booking: o, kind: 'rebook',
    input: { kind: 'rebook', reportId: r.id, option: Number(input.option), listingId: offer.listingId, roomId: offer.roomId || null },
    quote: { kind: 'rebook', reportId: r.id, listingId: offer.listingId, roomId: offer.roomId || null, name: p.detail.suite, from: range.from, to: range.to, detail: p.detail,
             policy: offer.policy || null, fromName: (r.original || {}).suite || o.suite_name },
    oldTotal, newTotal, difference: newTotal - oldTotal,
    // What Aerva is not charging them for moving, so the guest can be told.
    feeWaived: Number(p.feeWaived) || 0,
    summary: `Moved under Aerva’s check-in promise to ${p.detail.suite}, ${niceDate(range.from)} – ${niceDate(range.to)} (${plural(p.detail.nights, 'night')})`
  };
}
// The payment window holds the new place's nights.
function rebookHolds(c) {
  const q = c.quote || {};
  return [{ listingId: Number(q.listingId), roomId: q.roomId ? Number(q.roomId) : null, arrival: q.from, departure: q.to }];
}

// The guest accepts one of the places (My Bookings).
async function acceptOffer(sql, razorpay, { orderId, guestId, option }) {
  await assertReady(sql);
  const r = (await sql`SELECT * FROM checkin_reports WHERE order_id = ${Number(orderId) || 0} AND status = ANY(${ACTIVE}) ORDER BY id DESC LIMIT 1`)[0];
  if (!r || r.guest_id !== guestId) throw userError('Booking not found.', 404);
  if (r.status !== 'confirmed' || !(r.offers || []).length) throw userError('There is nothing to choose on this booking right now.', 409);
  const open = (await sql`SELECT * FROM booking_changes WHERE order_id = ${r.order_id} AND status IN ('pending', 'awaiting_payment') ORDER BY id DESC LIMIT 1`)[0];
  if (open) {
    const same = open.requested && open.requested.kind === 'rebook' && Number(open.requested.option) === Number(option) && open.status === 'awaiting_payment';
    if (same) return { changeId: open.id, pay: Number(open.difference) };
    if (open.requested && open.requested.kind === 'rebook') await sql`UPDATE booking_changes SET status = 'withdrawn', decided_at = now() WHERE id = ${open.id} AND status IN ('pending', 'awaiting_payment')`;
    else throw userError('Another change is open on this booking. Please raise a request in the Resolution Center (Help → Raise a request).', 409);
  }
  const qc = await quoteRebook(sql, r.order_id, guestId, { reportId: r.id, option });
  const row = (await sql`INSERT INTO booking_changes (order_id, guest_id, requested, quote, old_total, new_total, difference, summary)
                         VALUES (${r.order_id}, ${guestId}, ${JSON.stringify(qc.input)}, ${JSON.stringify(qc.quote)}, ${qc.oldTotal}, ${qc.newTotal}, ${qc.difference}, ${qc.summary})
                         RETURNING *`)[0];
  await logAudit(sql, { action: 'checkin_rebook_accepted', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'order', targetId: r.order_id,
    metadata: { reportId: r.id, changeId: row.id, option: Number(option), difference: qc.difference } });
  if (qc.difference > 0) {
    await sql`UPDATE booking_changes SET status = 'awaiting_payment', accepted_at = now() WHERE id = ${row.id} AND status = 'pending'`;
    return { changeId: row.id, pay: qc.difference };
  }
  try { return { changeId: row.id, applied: true, ...(await applyRebook(sql, razorpay, row)) }; }
  catch (err) { await sql`UPDATE booking_changes SET status = 'failed' WHERE id = ${row.id} AND status = 'pending'`; throw err; }
}

// Writes the move: the original booking is closed with nothing left on it,
// and the new booking on the new place carries the money (same payment,
// plus the difference paid, if any). Called by acceptOffer (costs the same
// or less) or by the change-payment confirmation (costs more).
async function applyRebook(sql, razorpay, change, { paymentId = null } = {}) {
  const reportId = Number((change.requested || {}).reportId) || 0;
  const claimRep = await sql`UPDATE checkin_reports SET status = 'rebooking', rebook_change_id = ${change.id} WHERE id = ${reportId} AND status = 'confirmed' RETURNING *`;
  if (!claimRep.length) throw userError('This booking is no longer waiting for a new place.', 409);
  const r = claimRep[0];
  const C = require('./_cancellations');
  let newId = null, claim = null, o = null;
  try {
    o = await loadOrder(sql, change.order_id);
    if (!o || o.status !== 'paid') throw userError('This booking is no longer active.', 409);
    const q = change.quote, d = q.detail;
    const subtotal = Math.round(Number(d.subtotal));
    const commission = rescueCommission(d, o);
    const payout = subtotal - commission;
    const rate = subtotal > 0 ? Number(((commission / subtotal) * 100).toFixed(2)) : 0;
    const total = Math.round(Number(change.new_total));
    const deposit = Number(d.depositAmount || 0);
    let releaseAt = null;
    if (deposit > 0) { const x = new Date(q.to + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 7); releaseAt = x.toISOString().slice(0, 10); }
    const used = Math.round(Number(o.fee_credit_used) || 0);
    const creditTake = Math.min(used, total);
    claim = await C.claimForCancellation(sql, [o.id]);
    await C.clearUnsentPayouts(sql, [o.id]);
    const reason = `Moved under Aerva’s check-in promise to ${q.name}`;
    let res;
    try {
      res = await sql.transaction([
        // 1. The new booking, on the same payment (copied while the original is claimed).
        sql`INSERT INTO orders (suite_name, listing_id, room_id, guest_email, guest_id, arrival, departure, guests, nights, subtotal, discount_amount, gst, total,
              commission_rate, commission_amount, payout_amount, razorpay_order_id, razorpay_payment_id, status, guest_service_fee,
              deposit_amount, deposit_status, deposit_release_at, order_type, charge_currency, pet_types, service_animal_types, young_litter_count,
              agreement_version, agreement_accepted_at, agreement_ip, cancellation_policy, guest_first_name, guest_last_name, fee_credit_used, created_at, checkin_rebook_of)
            SELECT ${d.suite}, ${q.listingId}, ${q.roomId || null}, guest_email, guest_id, ${q.from}, ${q.to}, ${d.guests}, ${d.nights}, ${subtotal}, ${d.discountAmount || 0}, ${d.gst}, ${total},
              -- No service fee on a rescue booking, so the row adds up to the
              -- total the guest was quoted (owner, 14 Nov 2026).
              ${rate}, ${commission}, ${payout}, razorpay_order_id, razorpay_payment_id, 'paid', 0,
              ${deposit}, ${deposit > 0 ? 'held' : 'none'}, ${releaseAt}, 'stay', charge_currency, pet_types, service_animal_types, young_litter_count,
              agreement_version, agreement_accepted_at, agreement_ip, ${q.policy || 'flexible'}, guest_first_name, guest_last_name, ${creditTake}, created_at, id
            FROM orders WHERE id = ${o.id} AND status = 'paid' AND cancel_claim IS NOT DISTINCT FROM ${claim}
            RETURNING id`,
        // 2. The original booking: closed, nothing left on it (the money is on the new one).
        sql`UPDATE orders SET status = 'cancelled', cancellation_reason = ${reason}, cancelled_at = now(),
              subtotal = 0, discount_amount = 0, gst = 0, guest_service_fee = 0, total = 0, commission_amount = 0, payout_amount = 0,
              deposit_amount = 0, deposit_status = 'none', deposit_release_at = NULL, refund_percent = 100, payout_on_cancel = false, fee_credit_used = 0,
              cancel_claim = NULL, cancel_claimed_at = NULL
            WHERE id = ${o.id} AND status = 'paid' AND cancel_claim IS NOT DISTINCT FROM ${claim} RETURNING id`,
        // 3. The change is recorded as made.
        sql`UPDATE booking_changes SET status = 'applied', applied_at = now(), razorpay_payment_id = COALESCE(${paymentId}, razorpay_payment_id)
            WHERE id = ${change.id} AND status IN ('pending', 'awaiting_payment') RETURNING id`
      ]);
    } catch (err) {
      if (err && err.code === '23P01') throw userError('That place is no longer free for those nights. Please choose another, or decline for a full refund.', 409);
      throw err;
    }
    newId = res[0] && res[0][0] ? Number(res[0][0].id) : null;
    if (!newId || !res[1].length || !res[2].length) {
      if (newId) await sql`DELETE FROM orders WHERE id = ${newId} AND status = 'paid'`;
      if (res[1].length) await sql`UPDATE orders SET status = 'paid' WHERE id = ${o.id}`;   // cannot happen while claimed
      throw userError('This booking changed while it was being moved. Please try again.', 409);
    }
  } catch (err) {
    if (claim && o) await C.releaseClaim(sql, [o.id], claim);
    await sql`UPDATE checkin_reports SET status = 'confirmed', rebook_change_id = NULL WHERE id = ${reportId} AND status = 'rebooking'`;
    throw err;
  }
  const q = change.quote, d = q.detail;
  // The original row is closed with nothing left on it (total 0): so are its
  // free cancellation add-on columns (_pricing.js). Its value was in the
  // paid total the new place is priced against, so it comes back to the
  // guest in the difference — the host was at fault.
  try {
    if (await require('./_pricing').orderMoneyColumnsReady(sql)) {
      await sql`UPDATE orders SET free_cancel_fee = 0, free_cancel_gst = 0, free_cancel_commission = 0 WHERE id = ${o.id} AND status = 'cancelled'`;
    }
  } catch (err) { console.error('rebook: add-on columns not cleared (needs follow-up):', o.id, err.message); }
  // What follows a booking row: its code, co-host shares, the credit it used.
  let code = null;
  try {
    code = await require('./_confirm-booking').issueConfirmationCode(sql, newId);
    if (code) await sql`UPDATE orders SET confirmation_code = ${code} WHERE id = ${newId} AND confirmation_code IS NULL`;
  } catch (err) { console.error('rebook confirmation code not issued:', newId, err.message); }
  // The same capped commission as the order row, or the co-hosts would be
  // split a payout that does not match what the booking actually pays out.
  // `o` still holds the original's figures here: the move zeroed the row in
  // the database, not this object.
  try { await require('./_cohosts').recordCohostShares(sql, newId, q.listingId, Math.round(Number(d.subtotal)) - rescueCommission(d, o)); }
  catch (err) { console.error('rebook co-host shares not written:', newId, err.message); }
  try { await sql`DELETE FROM order_cohost_shares WHERE order_id = ${o.id}`; } catch (e) { /* none */ }
  try { await sql`UPDATE fee_credit_uses SET order_id = ${newId} WHERE order_id = ${o.id}`; } catch (e) { /* none */ }
  try { await C.markCancelledByHost(sql, o.id); } catch (e) { /* none */ }
  // The original host is not paid for it: anything already paid out is
  // recorded to come off their later payouts.
  const settled = await require('./_payouts').settleAfterPayout(sql, o.id, { reason: 'Check-in promise: the guest was moved to another place after the payout was sent' });
  // Cheaper: the difference is Aerva credit. The part of the original paid
  // by coupon that the new booking does not take comes back as a coupon;
  // the part paid with earlier Aerva credit goes back onto that credit.
  const diff = Math.round(Number(change.difference));
  let credit = 0, couponBack = 0, creditBack = 0, expiresAt = null, depositBack = 0;
  if (diff < 0) {
    // A smaller deposit at the new place: that part of the difference is the
    // guest's deposit, refunded to the payment — a deposit is never Aerva
    // credit (owner, 10 Nov 2026 01:29).
    const oldDep = ['held', 'disputed'].includes(String(o.deposit_status || '')) ? Math.round(Number(o.deposit_amount) || 0) : 0;
    depositBack = Math.min(-diff, Math.max(0, oldDep - Math.round(Number(d.depositAmount) || 0)));
    if (depositBack > 0 && razorpay && o.razorpay_payment_id) {
      try { await require('./_refunds').safeRefund(sql, razorpay, { orderId: o.id, paymentId: o.razorpay_payment_id, amountSubunit: depositBack * 100, kind: 'deposit' }); }   // the old row keeps no deposit after the move
      catch (err) {
        console.error('check-in promise deposit refund failed (needs follow-up):', o.id, err.message);
        await email(process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in', `Check-in promise deposit refund failed: booking #${o.id}`, `<p>The guest was moved; ${inr(depositBack)} of their deposit could not be refunded automatically. Refund it from Admin → Refunds.</p>`);
      }
    } else depositBack = 0;
    const orig = r.original || {};
    const used = Math.round(Number(orig.creditUsed) || 0);
    creditBack = Math.max(0, used - Math.min(used, Math.round(Number(change.new_total))));
    if (creditBack) creditBack = await require('./_fee-credits').giveBack(sql, newId, creditBack);
    couponBack = Math.max(0, Math.round(Number(orig.coupon) || 0) - Math.min(Math.round(Number(orig.coupon) || 0), Math.round(Number(d.subtotal))));
    if (couponBack) await C.returnCouponValue(sql, { razorpayOrderId: o.razorpay_order_id, amount: couponBack, sourceOrderId: o.id, guestEmail: o.guest_email, suiteName: o.suite_name });
    const money = Math.max(0, -diff - couponBack - creditBack - depositBack);
    if (money > 0) {
      try {
        const c = await require('./_fee-credits').creditForCheckinRebook(sql, o.id, money, { newOrderId: newId, toName: q.name });
        credit = c.credit; expiresAt = c.expiresAt;
      } catch (err) {
        console.error('check-in promise credit not made (needs follow-up):', o.id, err.message);
        await email(process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in', `Check-in promise credit failed: booking #${o.id}`, `<p>The guest was moved, but ${inr(money)} could not be held as Aerva credit. Add it by hand or refund it.</p>`);
      }
    }
  }
  await sql`UPDATE checkin_reports SET status = 'rebooked', rebook_order_id = ${newId}, difference = ${diff}, credit_amount = ${credit + creditBack},
              recovered_from_host = ${settled.hostRecovered || 0}, closed_at = now() WHERE id = ${r.id} AND status = 'rebooking'`;
  const S = require('./_support');
  const { postThreadMessage } = C;
  const money = diff > 0 ? `You paid the difference of ${inr(diff)}.` : diff < 0 ? `${inr(-diff)} comes back to you${credit ? ` (${inr(credit)} as Aerva credit${expiresAt ? ` until ${new Date(expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })}` : ''})` : ''}${couponBack ? `, ${inr(couponBack)} as a coupon` : ''}${creditBack ? `, ${inr(creditBack)} back on your earlier Aerva credit` : ''}${depositBack ? `, ${inr(depositBack)} of your deposit refunded to your original payment` : ''}.` : 'There is no difference to pay.';
  await S.systemUpdate(sql, r.guest_ticket_id, `You are now booked at ${q.name}, ${niceDate(q.from)} – ${niceDate(q.to)}${code ? ` (booking ${code})` : ''}. ${money}`, { resolve: true });
  await postThreadMessage(sql, o.id, 'system', `The guest has been moved to another place under Aerva’s check-in promise. You are not paid for this booking.`, { audience: 'host' });
  await postThreadMessage(sql, newId, 'system', `Booking made by Aerva under its check-in promise: ${q.name}, ${niceDate(q.from)} – ${niceDate(q.to)}, ${plural(Number(d.guests), 'guest')}.`);
  const orig = r.original || {};
  await email(o.guest_email, `You are booked at ${q.name}`,
    `<h2 style="font-family:Georgia,serif;">Your new place is booked</h2><p><strong>${esc(q.name)}</strong> · ${esc(niceDate(q.from))} – ${esc(niceDate(q.to))} (${plural(Number(d.nights), 'night')})${code ? ` · booking ${esc(code)}` : ''}</p>
     <table style="border-collapse:collapse; font-size:14px;">
       <tr><td>Paid for your original booking</td><td style="text-align:right; padding-left:18px;">${inr(orig.total)}</td></tr>
       <tr><td>${diff > 0 ? 'Difference paid' : diff < 0 ? 'Difference back to you' : 'Difference'}</td><td style="text-align:right; padding-left:18px;">${diff > 0 ? '+' : diff < 0 ? '−' : ''}${inr(Math.abs(diff))}</td></tr>
       <tr><td><strong>Your booking now</strong> (stay ${inr(d.subtotal)}, GST ${inr(d.gst)}, service fee ${inr(d.guestServiceFee)}${Number(d.depositAmount) ? `, refundable deposit ${inr(d.depositAmount)}` : ''})</td><td style="text-align:right; padding-left:18px;"><strong>${inr(change.new_total)}</strong></td></tr>
     </table><p>${esc(money)}</p><p>It shows as one booking in My Bookings.</p>`);
  const newHost = (await sql`SELECT l.host_id FROM listings l WHERE l.id = ${q.listingId}`)[0];
  const nh = newHost && await hostAccount(sql, newHost.host_id);
  await email(nh && nh.email, `New booking: ${q.name}`,
    `<h2 style="font-family:Georgia,serif;">You have a new booking</h2><p><strong>${esc(q.name)}</strong> · ${esc(niceDate(q.from))} – ${esc(niceDate(q.to))} · ${plural(Number(d.guests), 'guest')}${code ? ` · booking ${esc(code)}` : ''}</p>
     <p>Aerva booked this guest with you at short notice. It is paid, and your payout follows the usual rules.</p><p><a href="https://aerva.in/index.html?view=messages" style="color:#8a6c39;">Open Messages</a></p>`);
  const oh = await hostAccount(sql, o.host_id);
  await email(oh && oh.email, `Booking closed: ${o.property_name}`,
    `<p>Your guest for ${esc(stayLine(o))} was moved to another place under Aerva’s check-in promise. You are not paid for this booking.${settled.hostRecovered > 0 ? ` Your payout for it had already been sent, so ${inr(settled.hostRecovered)} will be deducted from your later payouts.` : ''}</p>`);
  await tellGiftGuest(sql, o.id, `You are booked at ${q.name}`, 'You have a new place for the rest of the stay',
    `<p>Under Aerva's check-in promise you are now booked at <strong>${esc(q.name)}</strong>, ${esc(niceDate(q.from))} – ${esc(niceDate(q.to))}${code ? ` (booking ${esc(code)})` : ''}.</p>
     <p>The address and check-in details are in My Bookings.</p>`);
  await logAudit(sql, { action: 'checkin_rebook_applied', success: true, actorType: 'system', targetType: 'order', targetId: o.id,
    metadata: { reportId: r.id, changeId: change.id, newOrderId: newId, oldTotal: change.old_total, newTotal: change.new_total, difference: diff, credit, couponBack, creditBack, depositBack, recovered: settled.hostRecovered || 0, paymentId } });
  return { ok: true, newOrderId: newId, difference: diff, credit: credit + creditBack, couponBack };
}

// ---------------------------------------------------------------------
// 4. REFUND OTHERWISE: everything the guest paid, in full — price, GST,
// deposit and Aerva's service fee. The host is not paid for the booking.
async function refundInFull(sql, razorpay, { reportId, by = 'admin', guestId = null, adminLabel = 'admin', note = '' }) {
  await assertReady(sql);
  const got = await sql`UPDATE checkin_reports SET status = 'refunding' WHERE id = ${Number(reportId) || 0} AND status = 'confirmed'
                          AND (${guestId}::int IS NULL OR guest_id = ${guestId}::int) RETURNING *`;
  if (!got.length) throw userError('This booking is not waiting for a decision (it may already have been moved or refunded).', 409);
  const r = got[0];
  let out;
  try {
    try {
      const closed = await sql`UPDATE booking_changes SET status = 'withdrawn', decided_at = now() WHERE order_id = ${r.order_id} AND status IN ('pending', 'awaiting_payment') RETURNING razorpay_order_id`;
      for (const c of closed) if (c.razorpay_order_id) await require('./_booking-rules').releaseHolds(sql, { razorpayOrderId: c.razorpay_order_id, reason: 'closed' });
    } catch (e) { /* none */ }
    out = await require('./_cancellations').executePolicyCancellation(sql, razorpay, {
      orderId: r.order_id, pct: 100, by: 'admin', adminLabel: by === 'guest' ? `guest #${guestId}` : adminLabel,
      note: `Aerva’s check-in promise${by === 'guest' ? ': the guest declined the places offered' : ''}${note ? ' — ' + String(note).slice(0, 300) : ''}`,
      refundFee: true, feeReason: 'Check-in promise (owner’s rule, 9 Nov 2026): the place was not as listed or not available on arrival, so everything is refunded, including Aerva’s service fee.',
      countAgainstHost: true });
  } catch (err) {
    await sql`UPDATE checkin_reports SET status = 'confirmed' WHERE id = ${r.id} AND status = 'refunding'`;
    throw err;
  }
  let recovered = 0;
  try { recovered = Number((await sql`SELECT COALESCE(sum(amount), 0) AS v FROM host_penalties WHERE order_id = ${r.order_id} AND kind = 'overpaid' AND payer_guest_id IS NULL AND status <> 'cancelled'`)[0].v) || 0; } catch (e) { /* none */ }
  const total = Math.round((out.refundCash || 0) + (out.couponBack || 0) + (out.creditBack || 0));
  await sql`UPDATE checkin_reports SET status = 'refunded', refund_amount = ${total}, recovered_from_host = ${recovered}, closed_at = now() WHERE id = ${r.id} AND status = 'refunding'`;
  const o = await loadOrder(sql, r.order_id);
  const S = require('./_support');
  await S.systemUpdate(sql, r.guest_ticket_id, `Everything you paid is being refunded in full: ${inr(total)}, including Aerva’s service fee. Refunds usually arrive in 5–7 working days.`, { resolve: true });
  if (r.host_ticket_id) await S.systemUpdate(sql, r.host_ticket_id, `The guest was refunded in full. You are not paid for this booking.${recovered ? ` ${inr(recovered)} already paid out for it will be deducted from your later payouts.` : ''}`);
  await email(o.guest_email, `Full refund: ${o.property_name}`, `<h2 style="font-family:Georgia,serif;">You are refunded in full</h2><p>${esc(stayLine(o))}: <strong>${inr(total)}</strong> — the booking price, GST, deposit and Aerva’s service fee — is refunded to your original payment method${out.couponBack ? ' (the part paid by coupon comes back as a coupon)' : ''}. Refunds usually arrive in 5–7 working days.</p>`);
  const h = await hostAccount(sql, o.host_id);
  if (recovered) await email(h && h.email, `Amount to be deducted: ${o.property_name}`, `<p>The guest for ${esc(stayLine(o))} was refunded in full under Aerva’s check-in promise. Your payout for this booking had already been sent, so ${inr(recovered)} will be deducted from your later payouts. You can see it in My Earnings → Payout details.</p>`);
  await tellGiftGuest(sql, r.order_id, `The stay at ${o.property_name} is cancelled and refunded`, 'The stay is refunded in full',
    `<p><strong>${esc(stayLine(o))}</strong> is cancelled under Aerva's check-in promise, and everything paid for it has been refunded.</p>`);
  await logAudit(sql, { action: 'checkin_refunded_in_full', success: true, actorType: by === 'guest' ? 'guest' : 'admin', actorIdentifier: by === 'guest' ? String(guestId) : adminLabel, targetType: 'order', targetId: r.order_id,
    metadata: { reportId: r.id, refundCash: out.refundCash, couponBack: out.couponBack, creditBack: out.creditBack, recovered } });
  return { refunded: total, refundCash: out.refundCash, couponBack: out.couponBack || 0, creditBack: out.creditBack || 0, recovered };
}
async function declineOffers(sql, razorpay, { orderId, guestId }) {
  const r = (await sql`SELECT id FROM checkin_reports WHERE order_id = ${Number(orderId) || 0} AND status = 'confirmed' AND guest_id = ${guestId} ORDER BY id DESC LIMIT 1`)[0];
  if (!r) throw userError('There is nothing to decline on this booking.', 409);
  return refundInFull(sql, razorpay, { reportId: r.id, by: 'guest', guestId });
}

// ---------------------------------------------------------------------
// 5. "THIS PLACE IS REAL AND AS LISTED". Asked of every guest of a listing
// no guest has confirmed yet, from check-in until a day after check-out.
function confirmWindow(o) {
  const start = checkInMomentMs(dateStr(o.arrival), o.tz, o.check_in_time);
  const end = checkoutMs(o.departure, o.tz, o.check_out_time) + CONFIRM_AFTER_CHECKOUT_HOURS * 3600e3;
  return { start, end, open: Date.now() >= start && Date.now() < end };
}
async function confirmStay(sql, { orderId, guestId }) {
  await assertReady(sql);
  const o = await loadOrder(sql, orderId);
  if (!o || o.guest_id !== guestId) throw userError('Booking not found.', 404);
  if (o.status !== 'paid' || (o.order_type || 'stay') !== 'stay') throw userError('Only a confirmed stay can be confirmed.', 409);
  const w = confirmWindow(o);
  if (Date.now() < w.start) throw userError('You can confirm this once you have checked in.', 409);
  if (Date.now() >= w.end) throw userError('This stay ended too long ago to confirm.', 409);
  const open = await sql`SELECT 1 FROM checkin_reports WHERE order_id = ${o.id} AND status = ANY(${ACTIVE}) LIMIT 1`;
  if (open.length) throw userError('You have reported a problem on this stay; Aerva is looking into it.', 409);
  const done = await sql`UPDATE orders SET guest_confirmed_stay_at = now() WHERE id = ${o.id} AND guest_confirmed_stay_at IS NULL RETURNING id`;
  if (!done.length) return { ok: true, already: true };
  const first = await sql`UPDATE listings SET checkin_verified_at = now(), checkin_verified_order_id = ${o.id}
                          WHERE id = ${o.listing_id} AND checkin_verified_at IS NULL AND checkin_blocked_at IS NULL RETURNING id`;
  // The guest's own receipt, and nobody else's business (owner,
  // 14 Nov 2026). Shared with the host it read as "your guest was asked
  // to vouch for you" — a host who has done nothing wrong learns only
  // that Aerva was checking up on them. There is nothing here the host
  // needs: the check costs them nothing and changes nothing.
  await require('./_cancellations').postThreadMessage(sql, o.id, 'system', 'You confirmed this place is real and as listed. Thank you.', { audience: 'guest' });
  await logAudit(sql, { action: 'checkin_stay_confirmed', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'order', targetId: o.id,
    metadata: { listingId: o.listing_id, listingChecked: first.length > 0 } });
  return { ok: true, listingChecked: first.length > 0 };
}

// "It's here, but something's different" — the middle answer on the
// check-in card (owner, 13 Nov 2026). The guest is standing in the right
// house and is staying, so this confirms the place exactly as the button
// above does; it only also files a correction against the listing. No
// money, no payout hold, nothing held against the host — the rules are in
// _listing-corrections.js. The heavy path is untouched: a guest who
// cannot stay still goes to Report a problem.
async function reportDifference(sql, { orderId, guestId, what, photos }) {
  const LC = require('./_listing-corrections');
  if (!(await LC.ready(sql))) throw userError('Aerva cannot take this just now. Please use Report a problem instead.', 503);
  const confirmed = await confirmStay(sql, { orderId, guestId });
  const saved = await LC.create(sql, { orderId, guestId, what, photos });
  return { ok: true, correctionId: saved.id, listingChecked: confirmed.listingChecked === true };
}

// ---------------------------------------------------------------------
// GUEST VIEW (guest-profile.js My Bookings). Changes `bookings` in place:
//   • a booking moved under the promise shows ONCE — the new booking, with
//     the one summary (b.checkin_summary); the closed original is dropped;
//   • a booking with a report: b.checkin (where it stands, the places);
//   • b.can_confirm_real: the "This place is real and as listed" button.
async function decorateGuestBookings(sql, bookings) {
  if (!bookings || !bookings.length || !(await ready(sql))) return bookings;
  try {
    const ids = bookings.map(b => Number(b.id));
    const reps = await sql`SELECT DISTINCT ON (order_id) * FROM checkin_reports WHERE order_id = ANY(${ids}) ORDER BY order_id, id DESC`;
    const byOrder = new Map(reps.map(r => [Number(r.order_id), r]));
    const extra = await sql`SELECT o.id, o.checkin_rebook_of, o.guest_confirmed_stay_at, l.checkin_verified_at, l.checkin_blocked_at, to_jsonb(o)->>'group_booking_id' AS group_booking_id,
                                   COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata') AS tz, to_jsonb(l)->>'check_in_time' AS check_in_time, to_jsonb(l)->>'check_out_time' AS check_out_time
                            FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ANY(${ids})`;
    const ex = new Map(extra.map(x => [Number(x.id), x]));
    const moved = await sql`SELECT * FROM checkin_reports WHERE rebook_order_id = ANY(${ids}) AND status = 'rebooked'`;
    const movedTo = new Map(moved.map(r => [Number(r.rebook_order_id), r]));
    const STATUS = {
      open: 'Reported on arrival · Aerva is checking it now (urgent)',
      confirmed: 'Aerva confirmed your report · choose a new place, or decline for a full refund',
      rebooking: 'Moving you to your new place…', refunding: 'Your full refund is being made…',
      cleared: 'Aerva reviewed your report and did not uphold it', refunded: 'Refunded in full under Aerva’s check-in promise'
    };
    for (const b of bookings) {
      const r = byOrder.get(Number(b.id));
      const x = ex.get(Number(b.id)) || {};
      if (r && r.status === 'rebooked') { b._hide = true; continue; }
      if (r) {
        // A booking that is no longer live (cancelled, refunded, moved) has
        // nothing left to choose: offering a place that cannot be taken is a
        // dead end (owner, 12 Nov 2026). Say what happened instead.
        const live = b.status === 'paid';
        b.checkin = { reportId: r.id, reason: r.reason, status: r.status, statusText: !live && ACTIVE.includes(r.status)
            ? 'Aerva confirmed your report. This booking has since been cancelled, so there is nothing to choose here — anything owed to you comes back to the payment you used.'
            : r.status === 'confirmed' && !(r.offers || []).length
            // A group booking is never moved (sendOffers refuses it): every payer is refunded in full.
            ? (x.group_booking_id ? 'Aerva confirmed your report · a group booking is not moved to another place: every payer is refunded in full to their own payment' : 'Aerva confirmed your report · no other place nearby is free for these nights yet. Aerva is still looking — or ask for a full refund now.')
            : STATUS[r.status] || '',
          note: r.status === 'cleared' ? r.decision_note : null,
          offers: live && r.status === 'confirmed' ? (r.offers || []).map(k => ({ n: k.n, name: k.name, city: k.city, area: k.area, photo: k.photo, distanceKm: k.distanceKm, from: k.from, to: k.to, nights: k.nights,
            subtotal: k.subtotal, gst: k.gst, fee: k.fee, feeWaived: k.feeWaived || 0, deposit: k.deposit, total: k.total, oldTotal: k.oldTotal, difference: k.difference })) : [],
          canDecline: live && r.status === 'confirmed' };
        if (ACTIVE.includes(r.status)) { b.can_change = false; b.can_cancel_request = false; b.can_report = false; }
      }
      const m = movedTo.get(Number(b.id));
      if (m) {
        const orig = m.original || {};
        // What Aerva gave up to move them: its service fee on the new
        // booking. The new host's commission is untouched and still shows on
        // the booking — Aerva reduces its OWN take, not the host's money
        // (owner, 14 Nov 2026).
        // The rescue booking stores a zero fee, so what Aerva gave up is
        // what that fee would have been on it, at the published rate.
        const FEE_RATE = require('./_pricing').GUEST_SERVICE_FEE_RATE || 5;
        const gaveUp = Math.round(Number(b.guest_service_fee) || 0) === 0
          ? Math.round((Number(b.subtotal) || 0) * FEE_RATE / 100) : 0;
        b.checkin_summary = { from: orig.suite || '', fromCode: orig.code || null, originalTotal: Math.round(Number(orig.total) || 0), difference: Math.round(Number(m.difference) || 0),
          credit: Math.round(Number(m.credit_amount) || 0), total: Math.round(Number(b.total) || 0), arrival: orig.arrival, departure: orig.departure,
          aervaGaveUp: gaveUp };
      }
      // "Is this place real and as listed?" — until one guest of the listing confirms.
      if (b.status === 'paid' && (b.listing_type || 'stay') === 'stay' && x.tz && !x.checkin_blocked_at && !(r && ACTIVE.includes(r.status))) {
        const w = confirmWindow({ arrival: b.arrival, departure: b.departure, tz: x.tz, check_in_time: x.check_in_time, check_out_time: x.check_out_time });
        b.confirmed_real = !!x.guest_confirmed_stay_at;
        b.can_confirm_real = !x.guest_confirmed_stay_at && !x.checkin_verified_at && w.open;
        // "It's here, but something's different" is open to EVERY guest in
        // their own stay window, not only the one who first verifies the
        // listing — a listing drifts from its photos over time, and the
        // tenth guest is as entitled to say so as the first (owner,
        // 13 Nov 2026). Nothing nags them: on an already-checked listing
        // this shows as a quiet line, not the full card.
        b.can_report_difference = w.open;
      }
    }
    // One correction already filed on this stay: show it rather than the
    // buttons, so nobody files the same thing twice.
    try {
      const LC = require('./_listing-corrections');
      if (await LC.ready(sql)) {
        const byOrder = await LC.forGuest(sql, bookings.map(b => Number(b.id)));
        bookings.forEach(b => {
          const c = byOrder.get(Number(b.id));
          if (c) { b.correction = { what: c.what, status: c.status, at: c.created_at }; if (c.status === 'open') b.can_report_difference = false; }
        });
      }
    } catch (err) { console.error('corrections view failed:', err.message); }
    for (let i = bookings.length - 1; i >= 0; i--) if (bookings[i]._hide) bookings.splice(i, 1);
  } catch (err) { console.error('check-in promise view failed:', err.message); }
  return bookings;
}

// The guest staying on a gift sees where the report stands on their own
// copy of the booking — read only. Every choice and every rupee belongs to
// the person who paid, so there are no offers and no buttons here.
// Called AFTER _gifts.js has added their rows.
const SHARED_STATUS = {
  open: 'Reported on arrival · Aerva is checking it now',
  confirmed: 'Aerva confirmed the report · Aerva is settling a new place or a refund',
  rebooking: 'Moving to the new place…',
  refunding: 'The refund is being made…',
  cleared: 'Aerva reviewed the report and did not uphold it',
  refunded: 'Cancelled and refunded in full under Aerva’s check-in promise',
  rebooked: 'Moved to another place under Aerva’s check-in promise'
};
async function decorateSharedBookings(sql, bookings) {
  const rows = (bookings || []).filter(b => b && b.shared === 'gift' && !b.checkin);
  if (!rows.length || !(await ready(sql))) return bookings;
  try {
    const ids = [...new Set(rows.map(b => Number(b.id)))];
    const reps = await sql`SELECT DISTINCT ON (order_id) order_id, id, reason, status, decision_note FROM checkin_reports WHERE order_id = ANY(${ids}) ORDER BY order_id, id DESC`;
    const byOrder = new Map(reps.map(r => [Number(r.order_id), r]));
    for (const b of rows) {
      const r = byOrder.get(Number(b.id));
      if (!r) continue;
      b.checkin = { reportId: null, reason: r.reason, status: r.status, statusText: SHARED_STATUS[r.status] || '',
        note: r.status === 'cleared' ? r.decision_note : null, offers: [], canDecline: false,
        readOnly: true, byBuyer: b.gift_from || null };
      if (ACTIVE.includes(r.status)) b.can_report_arrival = false;
    }
  } catch (err) { console.error('check-in promise (shared) view failed:', err.message); }
  return bookings;
}

// ---------------------------------------------------------------------
// ADMIN (get-pending-listings.js ?checkinPromise=1).
async function adminView(sql) {
  if (!(await ready(sql))) return { ready: false, reports: [], listingBookings: [], blockedListings: [], balances: [] };
  const reports = await sql`
    SELECT r.*, o.suite_name, o.arrival, o.departure, o.nights, o.guests, o.total, o.guest_email, COALESCE(o.confirmation_code, '#' || o.id) AS code,
           l.property_name, l.city, h.name AS host_name, g.name AS guest_name,
           (SELECT email FROM guests x WHERE x.host_id = r.host_id ORDER BY x.id LIMIT 1) AS host_email,
           (SELECT phone FROM guests x WHERE x.host_id = r.host_id ORDER BY x.id LIMIT 1) AS host_phone,
           d.details, d.evidence, d.host_response, d.host_evidence, d.raised_at
    FROM checkin_reports r JOIN orders o ON o.id = r.order_id JOIN listings l ON l.id = r.listing_id
    LEFT JOIN hosts h ON h.id = r.host_id LEFT JOIN guests g ON g.id = r.guest_id LEFT JOIN stay_disputes d ON d.id = r.dispute_id
    WHERE r.status = ANY(${ACTIVE}) OR r.closed_at > now() - interval '14 days'
    ORDER BY (r.status = 'open') DESC, (r.status = ANY(${ACTIVE})) DESC, r.created_at DESC LIMIT 100`;
  // Future bookings of a listing blocked as fake: each guest to be moved or refunded.
  const listingBookings = await sql`
    SELECT o.id, o.suite_name, o.arrival, o.departure, o.guests, o.total, o.guest_email, COALESCE(o.confirmation_code, '#' || o.id) AS code, l.property_name, l.id AS listing_id
    FROM orders o JOIN listings l ON l.id = o.listing_id
    WHERE l.checkin_blocked_at IS NOT NULL AND o.status = 'paid'
      AND o.departure > (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date
      AND NOT EXISTS (SELECT 1 FROM checkin_reports r WHERE r.order_id = o.id AND r.status = ANY(${ACTIVE}))
    ORDER BY o.arrival LIMIT 100`;
  const blockedListings = await sql`SELECT l.id, l.property_name, l.city, l.status, l.checkin_blocked_at, h.name AS host_name FROM listings l LEFT JOIN hosts h ON h.id = l.host_id
                                    WHERE l.checkin_blocked_at IS NOT NULL ORDER BY l.checkin_blocked_at DESC LIMIT 100`;
  // HAS THE GUEST DONE ANYTHING? (owner, 14 Nov 2026: "where I see the
  // guest has taken any action.")
  //
  // Between "places offered" and a finished move or refund the card read
  // the same whether the guest had not opened it, had picked a place and
  // was halfway through paying, or had tried and the payment had failed.
  // All of it was already recorded — in booking_changes, and in when the
  // offers went out — and none of it reached the screen. One query turns a
  // silent wait into a visible one.
  try {
    const waiting = reports.filter(r => r.status === 'confirmed' && (r.offers || []).length).map(r => Number(r.order_id));
    if (waiting.length) {
      const picks = await sql`SELECT DISTINCT ON (order_id) order_id, id, status, requested, difference, created_at, accepted_at
                                FROM booking_changes
                               WHERE order_id = ANY(${waiting}) AND requested->>'kind' = 'rebook'
                               ORDER BY order_id, id DESC`;
      const by = new Map(picks.map(p => [Number(p.order_id), p]));
      for (const r of reports) {
        const p = by.get(Number(r.order_id));
        if (!p) continue;
        const n = Number((p.requested || {}).option);
        const chosen = (r.offers || []).find(o => Number(o.n) === n) || null;
        r.guest_pick = { option: n, name: chosen ? chosen.name : null, difference: Number(p.difference) || 0,
                         status: p.status, at: p.accepted_at || p.created_at };
      }
    }
  } catch (e) { /* booking_changes not there yet: the card simply says nothing */ }
  return { ready: true, maxOffers: MAX_OFFERS, reasons: { fake: REASONS.arrival_fake, not_as_listed: REASONS.arrival_failed }, reports, listingBookings, blockedListings, balances: await balances(sql) };
}
// What hosts owe Aerva (paid out, then no longer owed): deducted from their later payouts.
async function balances(sql, hostId = null) {
  try {
    return await sql`SELECT hp.host_id, h.name AS host_name, COALESCE(sum(hp.amount), 0)::numeric(12,2) AS owed, count(*)::int AS items,
                            json_agg(json_build_object('id', hp.id, 'orderId', hp.order_id, 'amount', hp.amount, 'note', hp.note, 'at', hp.created_at) ORDER BY hp.id) AS list
                     FROM host_penalties hp LEFT JOIN hosts h ON h.id = hp.host_id
                     WHERE hp.status = 'owed' AND hp.payer_guest_id IS NULL AND COALESCE(to_jsonb(hp)->>'kind', 'coupon') = 'overpaid'
                       AND (${hostId}::int IS NULL OR hp.host_id = ${hostId}::int)
                     GROUP BY hp.host_id, h.name ORDER BY owed DESC`;
  } catch (e) { return []; }
}
async function unblockListing(sql, { listingId, adminLabel = 'admin', note = '' }) {
  await assertReady(sql);
  const got = await sql`UPDATE listings SET status = CASE WHEN status = 'blocked' THEN 'approved' ELSE status END, checkin_blocked_at = NULL, admin_status_reason = NULL
                        WHERE id = ${Number(listingId) || 0} AND checkin_blocked_at IS NOT NULL RETURNING id, status`;
  if (!got.length) throw userError('This listing is not blocked under the check-in promise.', 409);
  await logAudit(sql, { action: 'checkin_listing_unblocked', success: true, actorType: 'admin', actorIdentifier: adminLabel, targetType: 'listing', targetId: Number(listingId), metadata: { note: String(note || '').slice(0, 500) } });
  return { status: got[0].status };
}

// HOST VIEW (host-listings.js ?checkinPromise=1): balance owed to Aerva,
// payouts on hold and why, reports open on their listings.
async function hostView(sql, hostId) {
  const out = { owed: 0, owedItems: [], held: [], reports: [], blocked: [] };
  if (!(await ready(sql))) return out;
  const b = (await balances(sql, hostId))[0];
  if (b) { out.owed = Number(b.owed); out.owedItems = b.list || []; }
  const rows = await sql`
    SELECT o.id, o.suite_name, o.arrival, o.departure, COALESCE(o.confirmation_code, '#' || o.id) AS code
    FROM orders o JOIN listings l ON l.id = o.listing_id
    WHERE l.host_id = ${hostId} AND o.status = 'paid'
      AND o.arrival <= (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date + 1
      AND o.arrival >= (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date - 60
      AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.order_id = o.id AND p.payee_type = 'host' AND p.status = 'sent')
    ORDER BY o.arrival LIMIT 60`;
  const holds = await payoutHolds(sql, rows.map(r => r.id));
  out.held = rows.filter(r => holds.has(r.id)).map(r => ({ orderId: r.id, listing: r.suite_name, code: r.code, arrival: dateStr(r.arrival), departure: dateStr(r.departure),
    why: holds.get(r.id).replace(/ \(\d{4}-[^)]*\)/, '') }));
  out.reports = (await sql`SELECT r.id, r.reason, r.status, l.property_name, o.arrival, COALESCE(o.confirmation_code, '#' || o.id) AS code FROM checkin_reports r JOIN listings l ON l.id = r.listing_id JOIN orders o ON o.id = r.order_id
                           WHERE r.host_id = ${hostId} AND r.status = ANY(${ACTIVE}) ORDER BY r.id`).map(r => ({ id: r.id, reason: r.reason === 'fake' ? REASONS.arrival_fake : REASONS.arrival_failed, status: r.status, listing: r.property_name, code: r.code, arrival: dateStr(r.arrival) }));
  out.blocked = (await sql`SELECT id, property_name FROM listings WHERE host_id = ${hostId} AND checkin_blocked_at IS NOT NULL`).map(l => ({ id: l.id, name: l.property_name }));
  return out;
}

// ---------------------------------------------------------------------
// SCHEDULER (get-listings.js JOBS 'checkin_promise', every 15 minutes):
//   • at check-in, the email asking "Is this place real and as listed?" to
//     guests of listings no guest has confirmed yet;
//   • payouts left 'due' because they were on hold: planned again (with
//     the host's balance owed deducted) and sent once the hold has ended.
async function runJob(sql, { deadlineMs = 4000 } = {}) {
  const started = Date.now();
  const out = { asked: 0, released: 0, guests: [] };
  if (!(await ready(sql))) return { ...out, skipped: 'database update not applied yet' };
  const due = await sql`
    SELECT o.id, o.guest_email, o.guest_id, o.suite_name, o.arrival, o.departure, COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata') AS tz,
           to_jsonb(l)->>'check_in_time' AS check_in_time, to_jsonb(l)->>'check_out_time' AS check_out_time
    FROM orders o JOIN listings l ON l.id = o.listing_id
    WHERE o.status = 'paid' AND COALESCE(o.order_type, 'stay') = 'stay' AND l.checkin_verified_at IS NULL AND l.checkin_blocked_at IS NULL
      AND o.stay_confirm_emailed_at IS NULL AND o.guest_confirmed_stay_at IS NULL
      AND o.arrival <= (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date
      AND o.departure >= (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date
    ORDER BY o.arrival LIMIT 50`;
  for (const o of due) {
    if (Date.now() - started > deadlineMs) break;
    if (Date.now() < checkInMomentMs(dateStr(o.arrival), o.tz, o.check_in_time)) continue;
    const got = await sql`UPDATE orders SET stay_confirm_emailed_at = now() WHERE id = ${o.id} AND stay_confirm_emailed_at IS NULL RETURNING id`;
    if (!got.length) continue;
    await email(o.guest_email, `Is ${o.suite_name} real and as listed?`,
      `<h2 style="font-family:Georgia,serif;">Welcome — one quick question</h2><p>Is <strong>${esc(o.suite_name)}</strong> real and as listed?</p>
       <p>Tap <strong>“This place is real and as listed”</strong> in My Bookings. If it does not exist, or is not as listed or not available, use <strong>Report a problem</strong> there (with a photo) by 10 AM tomorrow: Aerva will move you to another place or refund you in full.</p>
       <p><a href="https://aerva.in/index.html?view=my-bookings" style="color:#8a6c39;">Open My Bookings</a></p>`);
    out.asked++; out.guests.push(o.guest_email);
  }
  // Held payouts whose hold has ended.
  let rows = [];
  try { rows = await sql`SELECT id, order_id FROM payouts WHERE status IN ('due', 'failed') AND failure_reason LIKE 'On hold:%' ORDER BY id LIMIT 50`; } catch (e) { rows = []; }
  const holds = await payoutHolds(sql, rows.map(r => r.order_id));
  const P = require('./_payouts');
  const done = new Set();
  for (const p of rows) {
    if (Date.now() - started > deadlineMs) break;
    if (holds.has(p.order_id)) continue;
    if (!done.has(p.order_id)) { await P.settleAfterPayout(sql, p.order_id, { reason: 'Planned again after a check-in promise hold' }); done.add(p.order_id); }
    await sql`UPDATE payouts SET failure_reason = NULL WHERE id = ${p.id} AND status IN ('due', 'failed') AND failure_reason LIKE 'On hold:%'`;
    if (P.razorpayxReady()) { try { await P.attemptPayout(sql, p.id); } catch (e) { /* retried */ } }
    out.released++;
  }
  return out;
}

module.exports = {
  REASONS, MAX_OFFERS, NOT_READY, HOLD_NOTICE_ID, holdFrom, isArrivalReason, ready, payoutHolds, holdFor, openReport, decideReport, startListingReview, candidates, sendOffers,
  quoteRebook, rebookHolds, acceptOffer, applyRebook, refundInFull, declineOffers, confirmStay, reportDifference, decorateGuestBookings, decorateSharedBookings, adminView, balances, unblockListing, hostView, runJob, rebookRange,
  _internals: { rescueCommission }
};
