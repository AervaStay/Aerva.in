// /api/_fee-credits.js — Aerva credit, made when a HOST cancels. Not an
// endpoint.
//
// When a host (or co-host) cancels a booking, the guest is refunded the
// booking price, GST and deposit at once, and gets the 10% Aerva coupon
// (host-listings.js). Aerva's guest service fee is not kept: it becomes
// Aerva credit for FEE_CREDIT_DAYS (migrations/2026-10-27-01-fee-credits.sql).
//
//   • Booking again on Aerva while the credit is open, the credit pays
//     toward that booking — its price, GST and service fee — as far as it
//     goes (create-order.js applies it automatically; the payment
//     confirmation claims it — _confirm-booking.js). The rest is paid by
//     card; whatever is left stays on the credit.
//   • Not booking again, the guest can ask for it back at any time (My
//     Bookings → "Refund it now"), in full, to the original payment method.
//     Credit lasts 6 months from the day it is issued (creditEnd); what is
//     left then is refunded automatically ('fee_credit_refunds'). While
//     unused, the guest is reminded by a pop-up when they sign in
//     (remindOnSignIn), by email once a quarter on the 15th of its 2nd month
//     (remindQuarterly), and by email 7 days before it ends (remindEnding). Only a credit given an end
//     date before 2026-10-28 is refunded when it ends ('fee_credit_refunds').
//   • A booking paid partly with credit and later refunded (cancelled,
//     changed, a stay problem upheld) is refunded to the payment first; the
//     part the payment cannot take goes back onto the credit (giveBack), with
//     a fresh credit period. Cancelled by its host, everything the credit
//     paid comes back, and its service fee becomes credit as above.
//
// Only bookings paid in rupees get a credit; one paid in another currency
// has its service fee refunded with the rest, at once.
//
// NATURAL DISASTER / GOVERNMENT ORDER (owner, 10 Nov 2026, 01:25): a
// cancellation Aerva approves for a natural disaster or a government order
// turns what the guest paid (price, GST, Aerva's fee and any free
// cancellation add-on) into ORDINARY Aerva credit with reason
// 'natural_disaster' (kept for reporting): used on any booking, refunded to
// the original payment whenever the guest asks (My Bookings → "Refund to
// original payment"), reminded like any credit, and refunded automatically
// when its period ends. The earlier "credit for new dates only" and the
// admin switch that allowed its refund are gone. cash_refundable stays on
// the row (true); a row ever marked false is not refunded (nonCash).
const { helpLine } = require('./_help-link');
function nonCash(c) {
  if (!c) return false;
  return c.cash_refundable === false || String(c.cash_refundable) === 'false';
}
// May this credit go back to the original payment now?
function refundableNow(c) { return !nonCash(c); }

const FEE_CREDIT_DAYS = 30;            // a credit given back after it ended gets at least this long
// Every credit lasts CREDIT_MONTHS from the day it is issued; what is left
// then is refunded to the original payment (runExpired). Banks refuse
// refunds on payments more than about 6 months old, so when the payment is
// older, the credit ends when that window closes (BANK_WINDOW_DAYS after
// payment) — unless that leaves under MIN_CREDIT_DAYS, when it keeps the
// full period and a refused refund is paid from Admin → Refunds.
const CREDIT_MONTHS = 6;
const BANK_WINDOW_DAYS = 175;
const MIN_CREDIT_DAYS = 30;
function creditEnd(paidAt, now = new Date()) {
  const full = new Date(now.getTime());
  full.setUTCMonth(full.getUTCMonth() + CREDIT_MONTHS);
  const paid = paidAt ? new Date(paidAt) : null;
  if (paid && !isNaN(paid)) {
    const window = new Date(paid.getTime() + BANK_WINDOW_DAYS * 86400e3);
    if (window < full && window.getTime() - now.getTime() >= MIN_CREDIT_DAYS * 86400e3) return window.toISOString();
  }
  return full.toISOString();
}
const MIN_LEFT_MINUTES = 10;           // not applied at checkout when about to end
const REFUND_GRACE_MINUTES = 15;       // a payment begun just before the end can still claim it
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const day = (v) => new Date(v).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });

async function email(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html }) });
    return r.ok;
  } catch (e) { return false; }
}

// The credit ledger (fee_credit_entries): one row per movement, for the
// accounts — where each credit came from and went. Never throws.
async function entry(sql, creditId, kind, amount, { orderId = null, reference = null, note = null } = {}) {
  const a = Math.round(Number(amount) || 0);
  if (!a || !creditId) return;
  try {
    await sql`INSERT INTO fee_credit_entries (credit_id, kind, amount, order_id, reference, note)
              VALUES (${Number(creditId)}, ${kind}, ${a}, ${orderId ? Number(orderId) : null}, ${reference || null}, ${note || null})`;
  } catch (e) { /* database update not applied yet */ }
}

// Gives back to the credits a booking used (orders.fee_credit_used), up to
// `amount` (₹; Infinity = all of it), with at least a fresh credit period.
// Returns the rupees given back. Never throws.
async function giveBack(sql, orderId, amount = Infinity) {
  let left = amount === Infinity ? Infinity : Math.max(0, Math.round(Number(amount) || 0));
  let back = 0;
  if (!left) return 0;
  try {
    const uses = await sql`SELECT id, credit_id, amount, COALESCE(restored_amount, 0) AS restored FROM fee_credit_uses
                           WHERE order_id = ${Number(orderId) || 0} AND amount > COALESCE(restored_amount, 0) ORDER BY id`;
    for (const u of uses) {
      if (left <= 0) break;
      const take = Math.min(left, Number(u.amount) - Number(u.restored));
      const got = await sql`UPDATE fee_credit_uses SET restored_amount = COALESCE(restored_amount, 0) + ${take},
                              restored_at = CASE WHEN COALESCE(restored_amount, 0) + ${take} >= amount THEN now() ELSE restored_at END
                            WHERE id = ${u.id} AND COALESCE(restored_amount, 0) + ${take} <= amount RETURNING id`;
      if (!got.length) continue;
      await sql`UPDATE fee_credits SET remaining = remaining + ${take}, status = 'active',
                  expires_at = GREATEST(expires_at, now() + make_interval(days => ${FEE_CREDIT_DAYS}))
                WHERE id = ${u.credit_id} AND status IN ('active', 'used')`;
      await entry(sql, u.credit_id, 'given_back', take, { orderId });
      back += take; left -= take;
    }
  } catch (e) { console.error('Aerva credit not given back (needs follow-up):', orderId, e.message); }
  return back;
}
// Rupees of a booking paid with credit and not given back yet.
async function creditOn(sql, orderId) {
  try {
    const r = (await sql`SELECT COALESCE(sum(amount - COALESCE(restored_amount, 0)), 0)::int AS v FROM fee_credit_uses WHERE order_id = ${Number(orderId) || 0}`)[0];
    return Number(r.v) || 0;
  } catch (e) { return 0; }
}

// After a host cancellation: everything the bookings paid with credit comes
// back, and each rupee row's service fee becomes a new credit — as far as
// the row was paid in money (the money the refund did not return).
// Returns the credits made (new ones), and how much came back.
async function createForHostCancellation(sql, orderIds) {
  const ids = (orderIds || []).map(Number).filter(Boolean);
  if (!ids.length) return [];
  let rows;
  try {
    rows = await sql`SELECT id, guest_id, guest_email, suite_name, razorpay_payment_id, razorpay_order_id, created_at AS paid_at, COALESCE(charge_currency, 'INR') AS currency,
                            COALESCE(guest_service_fee, 0) AS fee, COALESCE(deposit_amount, 0) AS deposit
                     FROM orders WHERE id = ANY(${ids}) AND status = 'cancelled'`;
  } catch (e) { return []; }
  const { paidByOrderRow } = require('./_booking-rules');
  const made = [];
  let restored = 0;
  for (const r of rows) {
    restored += await giveBack(sql, r.id);
    if (r.currency !== 'INR' || !r.razorpay_payment_id) continue;
    let card = Infinity;
    try { const p = (await paidByOrderRow(sql, r.razorpay_order_id))[r.id]; if (p) card = Math.max(0, p.paid - Math.round(Number(r.deposit) || 0)); } catch (e) { /* the fee as it is */ }
    const fee = Math.min(Math.round(Number(r.fee) || 0), card);
    if (fee <= 0) continue;
    try {
      const c = (await sql`INSERT INTO fee_credits (guest_id, guest_email, source_order_id, razorpay_payment_id, amount, remaining, expires_at)
                           VALUES (${r.guest_id}, ${r.guest_email}, ${r.id}, ${r.razorpay_payment_id}, ${fee}, ${fee}, ${creditEnd(r.paid_at)}::timestamptz)
                           ON CONFLICT (source_order_id) DO NOTHING RETURNING *`)[0];
      if (c) {
        made.push(Object.assign(c, { suite: r.suite_name }));
        await entry(sql, c.id, 'issued', fee, { orderId: r.id, reference: r.razorpay_payment_id, note: 'Host cancelled: Aerva’s service fee' });
      }
    } catch (e) { /* database update not applied: the fee stays with Aerva, as before */ }
  }
  // One email to each guest.
  const byGuest = {};
  made.forEach(c => { (byGuest[c.guest_email] = byGuest[c.guest_email] || []).push(c); });
  for (const [to, list] of Object.entries(byGuest)) {
    const total = list.reduce((t, c) => t + c.amount, 0);
    await email(to, `${inr(total)} is held for you as Aerva credit`, `
      <div style="font-family:sans-serif; max-width:520px; color:#1c1a17; line-height:1.6;">
        <p>Because your host cancelled, Aerva’s service fee of <strong>${inr(total)}</strong> is not kept. It is held for you as Aerva credit until <strong>${day(list.reduce((d, c) => (!d || new Date(c.expires_at) < new Date(d)) ? c.expires_at : d, null))}</strong>.</p>
        <p>Book another stay or experience on Aerva by then and the credit is taken off what you pay, automatically. Anything left stays on your credit. You can have it refunded to your original payment method at any time from My Bookings, and whatever is left on that date is refunded to it automatically.</p>
        <p style="font-size:12px; opacity:0.6;">${helpLine({}, 'Questions?')}</p></div>`);
  }
  made.restored = restored;
  return made;
}

// (creditForShorterStay — the nights not stayed back as credit — was removed
// on 10 Nov 2026, 01:28: leaving early gives nothing back. Old credits with
// reason 'stay_shortened' stay as they are: ordinary credit, refundable.)

// A booking moved in part to another property of the same host for less
// (_booking-transfers.js): the difference, after Aerva's transfer fee, is
// held as Aerva credit (owner's rule, 9 Nov 2026) — never refunded to the
// payment at once. The guest uses it on another booking, or has it refunded
// to the original payment whenever they ask from My Bookings; what is left
// when it ends is refunded automatically. A booking paid wholly with earlier
// credit gets it back onto that credit. The ledger entry names the transfer,
// its fee and the booking, for the CA.
// Returns { credit, back, expiresAt }.
async function creditForTransfer(sql, orderId, amount, { changeId = null, transferFee = 0, summary = '' } = {}) {
  const want = Math.max(0, Math.round(Number(amount) || 0));
  const out = { credit: 0, back: 0, expiresAt: null };
  if (!want) return out;
  const o = (await sql`SELECT id, guest_id, guest_email, suite_name, razorpay_payment_id, created_at AS paid_at, to_jsonb(orders)->>'confirmation_code' AS code
                       FROM orders WHERE id = ${Number(orderId) || 0}`)[0];
  if (!o) return out;
  // Paid with no money at all (credit only): it goes back onto that credit.
  if (!o.razorpay_payment_id || !/^pay_/.test(String(o.razorpay_payment_id))) {
    out.back = await giveBack(sql, o.id, want);
    if (out.back >= want) return out;
  }
  const credit = want - out.back;
  const note = `Booking transferred${o.code ? ` (booking ${o.code})` : ''}${changeId ? `, change #${changeId}` : ''}: price difference after Aerva’s transfer fee of ${inr(transferFee)}${summary ? ` — ${String(summary).slice(0, 200)}` : ''}`;
  const c = (await sql`INSERT INTO fee_credits (guest_id, guest_email, source_order_id, razorpay_payment_id, amount, remaining, expires_at, reason)
            VALUES (${o.guest_id}, ${o.guest_email}, ${o.id}, ${o.razorpay_payment_id}, ${credit}, ${credit}, ${creditEnd(o.paid_at)}::timestamptz, 'booking_transfer')
            ON CONFLICT (source_order_id) DO UPDATE SET amount = fee_credits.amount + EXCLUDED.amount, remaining = fee_credits.remaining + EXCLUDED.remaining, status = 'active',
              expires_at = GREATEST(fee_credits.expires_at, EXCLUDED.expires_at)
            WHERE fee_credits.status <> 'refunding' RETURNING *`)[0];
  if (!c) throw Object.assign(new Error('Your Aerva credit is being refunded right now. Please try again in a few minutes.'), { isUserFacing: true, status: 409 });
  out.credit = credit; out.expiresAt = c.expires_at;
  await entry(sql, c.id, 'issued', credit, { orderId: o.id, reference: o.razorpay_payment_id, note });
  await email(o.guest_email, `${inr(want)} is with you as Aerva credit`, `
    <div style="font-family:sans-serif; max-width:520px; color:#1c1a17; line-height:1.6;">
      <p>Part of your booking at <strong>${esc(o.suite_name)}</strong> moved to another property for less. After Aerva’s transfer fee of ${inr(transferFee)}, the <strong>${inr(want)}</strong> difference is held for you as Aerva credit${out.expiresAt ? ` until <strong>${day(out.expiresAt)}</strong>` : ''}.</p>
      <p>Book another stay or experience by then and it is taken off what you pay, automatically. Or have it refunded to your original payment method at any time from My Bookings — whatever is left on that date is refunded to it automatically.</p>
      <p style="font-size:12px; opacity:0.6;">${helpLine({}, 'Questions?')}</p></div>`);
  return out;
}

// Aerva's check-in promise (_checkin-promise.js): the guest was moved to a
// cheaper place, so the difference is held as Aerva credit (owner, 9 Nov
// 2026) — used on another booking, or refunded whenever the guest asks.
// orderId: the original booking (its payment paid it). Returns { credit, expiresAt }.
async function creditForCheckinRebook(sql, orderId, amount, { newOrderId = null, toName = '' } = {}) {
  const want = Math.max(0, Math.round(Number(amount) || 0));
  const out = { credit: 0, expiresAt: null };
  if (!want) return out;
  const o = (await sql`SELECT id, guest_id, guest_email, suite_name, razorpay_payment_id, created_at AS paid_at, to_jsonb(orders)->>'confirmation_code' AS code
                       FROM orders WHERE id = ${Number(orderId) || 0}`)[0];
  if (!o) return out;
  const c = (await sql`INSERT INTO fee_credits (guest_id, guest_email, source_order_id, razorpay_payment_id, amount, remaining, expires_at, reason)
            VALUES (${o.guest_id}, ${o.guest_email}, ${o.id}, ${o.razorpay_payment_id}, ${want}, ${want}, ${creditEnd(o.paid_at)}::timestamptz, 'checkin_rebook')
            ON CONFLICT (source_order_id) DO UPDATE SET amount = fee_credits.amount + EXCLUDED.amount, remaining = fee_credits.remaining + EXCLUDED.remaining, status = 'active',
              expires_at = GREATEST(fee_credits.expires_at, EXCLUDED.expires_at)
            WHERE fee_credits.status <> 'refunding' RETURNING *`)[0];
  if (!c) throw Object.assign(new Error('Your Aerva credit is being refunded right now. Please try again in a few minutes.'), { isUserFacing: true, status: 409 });
  out.credit = want; out.expiresAt = c.expires_at;
  await entry(sql, c.id, 'issued', want, { orderId: o.id, reference: o.razorpay_payment_id,
    note: `Check-in promise${o.code ? ` (booking ${o.code})` : ''}: moved to a cheaper place${toName ? ` (${String(toName).slice(0, 120)})` : ''}${newOrderId ? `, new booking #${newOrderId}` : ''} — the difference` });
  await email(o.guest_email, `${inr(want)} is with you as Aerva credit`, `
    <div style="font-family:sans-serif; max-width:520px; color:#1c1a17; line-height:1.6;">
      <p>Your new place costs less than your original booking at <strong>${esc(o.suite_name)}</strong>, so the <strong>${inr(want)}</strong> difference is held for you as Aerva credit${out.expiresAt ? ` until <strong>${day(out.expiresAt)}</strong>` : ''}.</p>
      <p>Book another stay or experience by then and it is taken off what you pay, automatically. Or have it refunded to your original payment method at any time from My Bookings — whatever is left on that date is refunded to it automatically.</p>
      <p style="font-size:12px; opacity:0.6;">${helpLine({}, 'Questions?')}</p></div>`);
  return out;
}

// (creditForEmergencyFee — the service fee back as credit on a proven
// emergency — was removed on 10 Nov 2026. Its old credits, reason
// 'emergency_fee', stay as they are: ordinary credit, refundable.)

// A host cancels (at any time; within 48 hours of check-in the host also
// pays the guest a 10% coupon — owner's rule, 29 Oct 2026), the host of an
// experience that includes a stay cancels it, or Aerva approves a natural
// disaster / government order: what the guest paid for the booking — price,
// GST, Aerva's service fee (and any add-on) — is held as ordinary Aerva
// credit. The security deposit is never part of it: it is always refunded
// to the payment (owner, 10 Nov 2026 01:29). The guest uses it on another stay or
// experience, or has it refunded at any time; what is left at the end of the
// credit period is refunded automatically. What the booking was paid with
// credit comes back onto that credit.
// reason: 'host_cancelled_late' | 'experience_cancelled' | 'natural_disaster'.
// A natural disaster also turns rows paid in another currency into credit
// (the credit is in rupees). Returns { total, back, expiresAt }.
async function creditForWholeBooking(sql, orderIds, reason) {
  const disaster = reason === 'natural_disaster';
  const ids = (orderIds || []).map(Number).filter(Boolean);
  const out = { total: 0, back: 0, expiresAt: null };
  if (!ids.length) return out;
  const { paidByOrderRow } = require('./_booking-rules');
  const rows = await sql`SELECT id, guest_id, guest_email, suite_name, razorpay_payment_id, razorpay_order_id, created_at AS paid_at, COALESCE(charge_currency, 'INR') AS currency,
                                COALESCE(deposit_amount, 0) AS deposit
                         FROM orders WHERE id = ANY(${ids}) AND status = 'cancelled'`;
  let guestEmail = null, suite = null;
  for (const r of rows) {
    out.back += await giveBack(sql, r.id);
    if ((r.currency !== 'INR' && !disaster) || !r.razorpay_payment_id) continue;
    let money = 0;
    try {
      const p = (await paidByOrderRow(sql, r.razorpay_order_id))[r.id];
      // What the payment still holds for this row: paid, less every refund
      // so far — the deposit went back to the payment with the cancellation.
      const refunded = Number((await sql`SELECT COALESCE(sum(amount), 0) AS v FROM refunds WHERE order_id = ${r.id} AND status <> 'failed'`)[0].v) / 100;
      if (p) money = Math.max(0, Math.floor(p.paid - refunded));
    } catch (e) { money = 0; }
    if (money <= 0) continue;
    let c;
    const ins = (withReason) => withReason
      ? sql`INSERT INTO fee_credits (guest_id, guest_email, source_order_id, razorpay_payment_id, amount, remaining, expires_at, reason)
            VALUES (${r.guest_id}, ${r.guest_email}, ${r.id}, ${r.razorpay_payment_id}, ${money}, ${money}, ${creditEnd(r.paid_at)}::timestamptz, ${reason})
            ON CONFLICT (source_order_id) DO NOTHING RETURNING *`
      : sql`INSERT INTO fee_credits (guest_id, guest_email, source_order_id, razorpay_payment_id, amount, remaining, expires_at)
            VALUES (${r.guest_id}, ${r.guest_email}, ${r.id}, ${r.razorpay_payment_id}, ${money}, ${money}, ${creditEnd(r.paid_at)}::timestamptz)
            ON CONFLICT (source_order_id) DO NOTHING RETURNING *`;
    try { c = (await ins(true))[0]; }
    catch (err) { if (err && err.code === '42703') c = (await ins(false))[0]; else { console.error('credit not made (needs follow-up):', r.id, err.message); continue; } }
    if (!c) {
      // One credit per booking: an earlier credit from this booking (of
      // another kind) is never merged into this one — flagged for Aerva.
      const had = (await sql`SELECT id, to_jsonb(fee_credits)->>'reason' AS reason FROM fee_credits WHERE source_order_id = ${r.id}`)[0];
      if (!had || had.reason !== reason) {
        const { logAudit } = require('./_audit-log');
        await logAudit(sql, { action: 'whole_booking_credit_not_made', success: false, actorType: 'system', targetType: 'order', targetId: r.id,
          metadata: { amount: money, reason, existingCredit: had ? had.id : null, error: 'this booking already has an Aerva credit of another kind — make it by hand' } });
      }
      continue;
    }
    await entry(sql, c.id, 'issued', money, { orderId: r.id, reference: r.razorpay_payment_id,
      note: disaster ? 'Natural disaster / government order (approved by Aerva): price, GST, service fee and any add-on — refundable Aerva credit'
        : reason === 'experience_cancelled' ? 'Experience (with its stay) cancelled by its host: all of it' : 'Host cancelled: all of it' });
    out.total += money; out.expiresAt = (!out.expiresAt || new Date(c.expires_at) < new Date(out.expiresAt)) ? c.expires_at : out.expiresAt; guestEmail = r.guest_email; suite = suite || r.suite_name;
  }
  if (out.total > 0 && guestEmail) await creditEmail(guestEmail, { amount: out.total, suite, expiresAt: out.expiresAt, reason });
  return out;
}
// The email for a whole booking (or one payer's share of it) held as credit.
async function creditEmail(to, { amount, suite, expiresAt, reason, share = false }) {
  const why = reason === 'natural_disaster'
    ? `Aerva approved the cancellation of your booking at <strong>${esc(suite || 'Aerva')}</strong> (natural disaster or government order).`
    : `Your booking at <strong>${esc(suite || 'Aerva')}</strong> was cancelled by the host.`;
  await email(to, `${inr(amount)} is held for you as Aerva credit`, `
    <div style="font-family:sans-serif; max-width:520px; color:#1c1a17; line-height:1.6;">
      <p>${why} ${share ? 'Your share of what the group paid' : 'What you paid for it'} — <strong>${inr(amount)}</strong>, including GST and Aerva’s service fee — is held for you as Aerva credit${expiresAt ? ` until <strong>${day(expiresAt)}</strong>` : ''}. Any security deposit is refunded to your original payment method — never kept as credit.</p>
      <p>Use it for new dates on any stay or experience on Aerva and it is taken off what you pay, automatically. Or have it refunded to your original payment method at any time from My Bookings — whatever is left on that date is refunded to it automatically.</p>
      <p style="font-size:12px; opacity:0.6;">${helpLine({}, 'Questions?')}</p></div>`);
}

// A GROUP booking (split payment, _group-bookings.js) cancelled after
// confirmation by a natural disaster / government order Aerva approved, by
// its host, or by Aerva for the host (owner, 10 Nov 2026): EACH PAYER gets
// their own share as ordinary Aerva credit in their own account — one credit
// per payment (group_claim_id), refundable to that payment any time; what is
// left at the end of its period is refunded to it automatically. A payer's
// share is what their payment still holds for the booking after the
// cancellation's own refunds (the deposit, spread over the payments).
// reason: 'natural_disaster' | 'host_cancelled_late'. Returns { total, back, credits }.
async function creditForGroupPayers(sql, orderId, reason) {
  const out = { total: 0, back: 0, credits: [], expiresAt: null };
  const o = (await sql`SELECT id, suite_name, (to_jsonb(orders)->>'group_booking_id')::int AS gid FROM orders WHERE id = ${Number(orderId) || 0}`)[0];
  if (!o || !o.gid) return out;
  const claims = await sql`SELECT id, guest_id, email, first_name, amount, razorpay_payment_id, paid_at, refund_amount, refund_status FROM group_claims
                           WHERE group_id = ${o.gid} AND status = 'paid' AND razorpay_payment_id IS NOT NULL ORDER BY id`;
  const { logAudit } = require('./_audit-log');
  const byPerson = new Map();
  for (const c of claims) {
    const before = c.refund_status && c.refund_status !== 'failed' ? Math.round(Number(c.refund_amount || 0) / 100) : 0;
    const refunded = Number((await sql`SELECT COALESCE(sum(amount), 0) AS v FROM refunds WHERE order_id = ${o.id} AND razorpay_payment_id = ${c.razorpay_payment_id} AND status <> 'failed'`)[0].v) / 100;
    const money = Math.max(0, Math.floor(Number(c.amount) - before - refunded));
    if (money <= 0) continue;
    let row;
    try {
      row = (await sql`INSERT INTO fee_credits (guest_id, guest_email, source_order_id, razorpay_payment_id, amount, remaining, expires_at, reason, group_claim_id, group_order_id)
                       VALUES (${c.guest_id}, ${c.email}, NULL, ${c.razorpay_payment_id}, ${money}, ${money}, ${creditEnd(c.paid_at)}::timestamptz, ${reason}, ${c.id}, ${o.id})
                       ON CONFLICT (group_claim_id) DO NOTHING RETURNING *`)[0];
    } catch (err) {
      console.error('group credit not made (needs follow-up):', o.id, c.id, err.message);
      await logAudit(sql, { action: 'group_credit_failed', success: false, actorType: 'system', targetType: 'order', targetId: o.id, metadata: { claimId: c.id, amount: money, error: String(err.message || err).slice(0, 200) } });
      continue;
    }
    if (!row) continue;
    await entry(sql, row.id, 'issued', money, { orderId: o.id, reference: c.razorpay_payment_id,
      note: `${reason === 'natural_disaster' ? 'Natural disaster / government order (approved by Aerva)' : 'Host cancelled'}: group booking, this payer’s own share` });
    out.total += money; out.credits.push({ id: row.id, guestId: c.guest_id, email: c.email, amount: money, paymentId: c.razorpay_payment_id });
    out.expiresAt = (!out.expiresAt || new Date(row.expires_at) < new Date(out.expiresAt)) ? row.expires_at : out.expiresAt;
    const p = byPerson.get(c.guest_id) || { email: c.email, amount: 0, expiresAt: row.expires_at };
    p.amount += money; byPerson.set(c.guest_id, p);
  }
  // What was paid on top after confirmation — the difference of a change to
  // the booking (longer dates, add-ons), paid by the organiser on its own
  // payment, not a group place — is that payer's too: without this it was
  // neither refunded nor credited when the booking was cancelled.
  try {
    const claimPays = new Set(claims.map(c => c.razorpay_payment_id));
    const extras = await sql`SELECT bc.id, bc.guest_id, bc.difference, bc.razorpay_payment_id, bc.applied_at, g.email FROM booking_changes bc JOIN guests g ON g.id = bc.guest_id
                             WHERE bc.order_id = ${o.id} AND bc.status = 'applied' AND bc.difference > 0 AND bc.razorpay_payment_id IS NOT NULL ORDER BY bc.id`;
    for (const x of extras) {
      if (claimPays.has(x.razorpay_payment_id)) continue;
      if ((await sql`SELECT 1 FROM fee_credits WHERE group_order_id = ${o.id} AND razorpay_payment_id = ${x.razorpay_payment_id} AND group_claim_id IS NULL`).length) continue;
      const refunded = Number((await sql`SELECT COALESCE(sum(amount), 0) AS v FROM refunds WHERE order_id = ${o.id} AND razorpay_payment_id = ${x.razorpay_payment_id} AND status <> 'failed'`)[0].v) / 100;
      const money = Math.max(0, Math.floor(Number(x.difference) - refunded));
      if (money <= 0) continue;
      const row = (await sql`INSERT INTO fee_credits (guest_id, guest_email, source_order_id, razorpay_payment_id, amount, remaining, expires_at, reason, group_order_id)
                             VALUES (${x.guest_id}, ${x.email}, NULL, ${x.razorpay_payment_id}, ${money}, ${money}, ${creditEnd(x.applied_at)}::timestamptz, ${reason}, ${o.id}) RETURNING *`)[0];
      await entry(sql, row.id, 'issued', money, { orderId: o.id, reference: x.razorpay_payment_id,
        note: `${reason === 'natural_disaster' ? 'Natural disaster / government order (approved by Aerva)' : 'Host cancelled'}: group booking, the difference this payer paid for a change` });
      out.total += money; out.credits.push({ id: row.id, guestId: x.guest_id, email: x.email, amount: money, paymentId: x.razorpay_payment_id });
      out.expiresAt = (!out.expiresAt || new Date(row.expires_at) < new Date(out.expiresAt)) ? row.expires_at : out.expiresAt;
      const p = byPerson.get(x.guest_id) || { email: x.email, amount: 0, expiresAt: row.expires_at };
      p.amount += money; byPerson.set(x.guest_id, p);
    }
  } catch (err) {
    console.error('group credit for a change payment not made (needs follow-up):', o.id, err.message);
    await logAudit(sql, { action: 'group_credit_failed', success: false, actorType: 'system', targetType: 'order', targetId: o.id, metadata: { changePayment: true, error: String(err.message || err).slice(0, 200) } });
  }
  for (const p of byPerson.values()) await creditEmail(p.email, { amount: p.amount, suite: o.suite_name, expiresAt: p.expiresAt, reason, share: true });
  return out;
}

// Open credits a guest can use now, oldest ending first.
async function available(sql, guestId) {
  if (!guestId) return [];
  try {
    return await sql`SELECT id, remaining, expires_at FROM fee_credits
                     WHERE guest_id = ${guestId} AND status = 'active' AND remaining > 0
                       AND expires_at > now() + make_interval(mins => ${MIN_LEFT_MINUTES})
                     ORDER BY expires_at, id`;
  } catch (e) { return []; }
}
// Up to `fee` (₹) from the credits: [{ creditId, amount }].
function allocate(credits, fee) {
  let left = Math.max(0, Math.round(Number(fee) || 0));
  const out = [];
  for (const c of credits || []) {
    if (left <= 0) break;
    const take = Math.min(left, Math.round(Number(c.remaining) || 0));
    if (take > 0) { out.push({ creditId: Number(c.id), amount: take }); left -= take; }
  }
  return out;
}
// Spreads `total` over the items' amounts, in order: [credit per item].
function spread(fees, total) {
  let left = Math.max(0, Math.round(Number(total) || 0));
  return fees.map(f => { const t = Math.min(left, Math.max(0, Math.round(Number(f) || 0))); left -= t; return t; });
}

// At payment: takes the amounts, all or none. true when taken.
async function claim(sql, allocations) {
  const done = [];
  for (const a of allocations || []) {
    const got = await sql`UPDATE fee_credits SET remaining = remaining - ${a.amount},
                            status = CASE WHEN remaining - ${a.amount} <= 0 THEN 'used' ELSE status END
                          WHERE id = ${a.creditId} AND status = 'active' AND remaining >= ${a.amount} RETURNING id`;
    if (!got.length) { await unclaim(sql, done); return false; }
    done.push(a);
  }
  return true;
}
async function unclaim(sql, allocations) {
  for (const a of allocations || []) {
    try {
      await sql`UPDATE fee_credits SET remaining = remaining + ${a.amount}, status = 'active'
                WHERE id = ${a.creditId} AND status IN ('active', 'used')`;
    } catch (e) { console.error('fee credit not given back:', a.creditId, e.message); }
  }
}
// Which booking row each part of the credit paid for (for giving it back).
async function recordUses(sql, allocations, rows) {
  const queue = (allocations || []).map(a => Object.assign({}, a));
  for (const r of rows || []) {
    let need = Math.round(Number(r.feeCreditUsed) || 0);
    while (need > 0 && queue.length) {
      const a = queue[0];
      const take = Math.min(need, a.amount);
      try { await sql`INSERT INTO fee_credit_uses (credit_id, order_id, amount) VALUES (${a.creditId}, ${r.id}, ${take})`; } catch (e) { /* none */ }
      let pay = null;
      try { pay = ((await sql`SELECT razorpay_payment_id FROM orders WHERE id = ${r.id}`)[0] || {}).razorpay_payment_id || null; } catch (e) { pay = null; }
      await entry(sql, a.creditId, 'used', take, { orderId: r.id, reference: pay });
      a.amount -= take; need -= take;
      if (a.amount <= 0) queue.shift();
    }
  }
}

// Refunds what is left of a credit to the original payment. reason:
// 'asked' | 'expired'. Returns { refunded: ₹ } or throws a user-facing error.
async function refundCredit(sql, razorpay, creditId, reason) {
  // Every Aerva credit can go back to its original payment, natural-disaster
  // credit included (owner, 10 Nov 2026 01:25). Claimed once (guarded UPDATE).
  const c = (await sql`UPDATE fee_credits f SET status = 'refunding' WHERE id = ${Number(creditId) || 0} AND status = 'active' AND remaining > 0
                         AND COALESCE((to_jsonb(f)->>'cash_refundable')::boolean, true)
                       RETURNING *`)[0];
  if (!c) throw Object.assign(new Error('There is nothing left on this credit to refund.'), { isUserFacing: true, status: 409 });
  try {
    const { safeRefund } = require('./_refunds');
    // A group payer's credit belongs to the booking through group_order_id.
    const rf = await safeRefund(sql, razorpay, { orderId: c.source_order_id || c.group_order_id, paymentId: c.razorpay_payment_id, amountSubunit: c.remaining * 100,
      kind: `cancellation:fee-credit-${c.id}-${c.refunded_amount}` });
    await sql`UPDATE fee_credits SET status = 'refunded', refunded_amount = refunded_amount + remaining, remaining = 0, refunded_at = now(), refund_reason = ${reason} WHERE id = ${c.id}`;
    await entry(sql, c.id, 'refunded', c.remaining, { orderId: c.source_order_id || c.group_order_id, reference: (rf && rf.id) || null, note: reason === 'expired' ? 'Refunded at the end of the credit period' : 'Refunded at the guest’s request' });
  } catch (err) {
    await sql`UPDATE fee_credits SET status = 'active' WHERE id = ${c.id} AND status = 'refunding'`;
    throw err;
  }
  await email(c.guest_email, `Your Aerva credit of ${inr(c.remaining)} has been refunded`, `
    <div style="font-family:sans-serif; max-width:520px; color:#1c1a17; line-height:1.6;">
      <p>${reason === 'expired' ? 'Your Aerva credit has ended, so' : 'As you asked,'} <strong>${inr(c.remaining)}</strong> has been refunded to your original payment method. It usually appears within 5–7 working days, depending on your bank.</p>
      <p style="font-size:12px; opacity:0.6;">${helpLine({}, 'Questions?')}</p></div>`);
  return { refunded: c.remaining };
}

// Scheduler: refunds what is left on credits whose period has ended.
async function runExpired(sql, razorpay, { deadlineMs = 4000 } = {}) {
  const started = Date.now();
  const out = { refunded: 0, failed: 0 };
  if (!razorpay) return Object.assign(out, { skipped: 'Razorpay keys not set' });
  let due;
  try {
    try {
      // A refund the bank refused is tried again after a day, not every hour
      // (it stays listed in Admin → Refunds meanwhile).
      due = await sql`SELECT id FROM fee_credits f WHERE status = 'active' AND remaining > 0
                        AND expires_at < now() - make_interval(mins => ${REFUND_GRACE_MINUTES})
                        AND COALESCE((to_jsonb(f)->>'cash_refundable')::boolean, true)
                        AND (refund_failed_at IS NULL OR refund_failed_at < now() - interval '1 day') ORDER BY expires_at LIMIT 20`;
    } catch (e) {
      if (!e || e.code !== '42703') throw e;
      due = await sql`SELECT id FROM fee_credits WHERE status = 'active' AND remaining > 0
                        AND expires_at < now() - make_interval(mins => ${REFUND_GRACE_MINUTES}) ORDER BY expires_at LIMIT 20`;
    }
    await sql`UPDATE fee_credits SET status = 'used' WHERE status = 'active' AND remaining <= 0`;
  } catch (e) { return Object.assign(out, { skipped: 'database update not applied' }); }
  for (const d of due) {
    if (Date.now() - started > deadlineMs) break;
    try { await refundCredit(sql, razorpay, d.id, 'expired'); out.refunded++; }
    catch (e) {
      out.failed++; console.error('fee credit refund failed:', d.id, e.message);
      try { await sql`UPDATE fee_credits SET refund_failed_at = now() WHERE id = ${d.id}`; } catch (e2) { /* column not there yet */ }
    }
  }
  return out;
}

// ---- Reminders while a credit is unused ----
// 1) On the site, at sign-in (remindOnSignIn) — a pop-up, never an email.
//    The count runs from the newest unused credit (a new credit starts it
//    again): its first 3 months allow 3 pop-ups, one per sign-in; every
//    later 3 months allows 1, on the first sign-in in it. Claimed with a
//    conditional UPDATE on that credit's own row, so two sign-ins at the
//    same moment never count twice.
// 2) By email, once a quarter, signed in or not (remindQuarterly): on the
//    15th of the quarter's 2nd month — 15 Feb, 15 May, 15 Aug, 15 Nov — in
//    the daytime (10 am–7 pm India time). If the job could not run that
//    day it catches up until the 21st. One email per guest per quarter.
const REMINDER_PERIOD_DAYS = 90;
const REMINDERS_FIRST_PERIOD = 3;
const EMAIL_MONTHS = [2, 5, 8, 11];    // 2nd month of each quarter
const EMAIL_DAY = 15, EMAIL_LAST_DAY = 21;
const TAGLINES = [
  { subject: (a) => `Your next getaway is already ${a} closer`, line: (a) => `You have <strong>${a}</strong> of Aerva credit waiting. Pick a stay — it comes off the price automatically.` },
  { subject: (a) => `${a} of Aerva credit is waiting for you`, line: (a) => `Somewhere beautiful is waiting, and <strong>${a}</strong> of it is already paid for.` },
  { subject: (a) => `Plan a weekend away: your ${a} of Aerva credit is waiting`, line: (a) => `Your <strong>${a}</strong> Aerva credit is ready to use on any stay or experience in India.` },
  { subject: (a) => `Don’t let ${a} sit idle — plan your escape`, line: (a) => `Hills, beaches or a quiet villa: use your <strong>${a}</strong> credit on your next booking.` }
];
async function remindOnSignIn(sql, guestId) {
  try {
    const open = await sql`SELECT id FROM fee_credits WHERE guest_id = ${guestId} AND status = 'active' AND remaining > 0
                           ORDER BY created_at DESC, id DESC`;
    if (!open.length) return false;
    const secs = REMINDER_PERIOD_DAYS * 86400;
    const claimed = await sql`
      UPDATE fee_credits SET last_reminder_at = now(), reminders_sent = COALESCE(reminders_sent, 0) + 1
      WHERE id = ${open[0].id} AND status = 'active' AND remaining > 0
        AND (
          (now() < created_at + make_interval(days => ${REMINDER_PERIOD_DAYS}) AND COALESCE(reminders_sent, 0) < ${REMINDERS_FIRST_PERIOD})
          OR (now() >= created_at + make_interval(days => ${REMINDER_PERIOD_DAYS}) AND (last_reminder_at IS NULL
              OR floor(extract(epoch FROM last_reminder_at - created_at) / ${secs}) < floor(extract(epoch FROM now() - created_at) / ${secs})))
        )
      RETURNING id`;
    if (!claimed.length) return false;
    // Older credits move with it, so if the newest is used up first the
    // next one carries on from the same count rather than starting over.
    const others = open.slice(1).map(c => c.id);
    if (others.length) await sql`UPDATE fee_credits SET last_reminder_at = now(), reminders_sent = COALESCE(reminders_sent, 0) + 1 WHERE id = ANY(${others})`;
    return true;
  } catch (e) { console.error('credit reminder failed (non-fatal):', e.message); return false; }
}

// India date parts for "now" (or a given time).
function indiaNow(at) {
  const d = new Date((at ? new Date(at).getTime() : Date.now()) + 5.5 * 3600e3);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours() };
}
async function remindQuarterly(sql, { deadlineMs = 4000, at } = {}) {
  const started = Date.now();
  const n = indiaNow(at);
  if (!EMAIL_MONTHS.includes(n.m) || n.d < EMAIL_DAY || n.d > EMAIL_LAST_DAY) return { waiting: 'sends on 15 Feb, 15 May, 15 Aug and 15 Nov' };
  if (n.h < 10 || n.h >= 19) return { waiting: 'runs between 10 am and 7 pm' };
  // 15th of this month, 00:00 India time.
  const since = new Date(Date.UTC(n.y, n.m - 1, EMAIL_DAY) - 5.5 * 3600e3).toISOString();
  const out = { emailed: 0, affected: [] };
  let due;
  try {
    // Only guests with an open account and an email address are claimed,
    // so Batch Jobs lists exactly the people who were sent one.
    // ends / cash: credit that can go back to the payment (every credit today).
    due = await sql`SELECT f.guest_id, sum(f.remaining)::int AS balance, array_agg(f.id) AS ids,
                           min(f.expires_at) FILTER (WHERE COALESCE((to_jsonb(f)->>'cash_refundable')::boolean, true)) AS ends,
                           COALESCE(sum(f.remaining) FILTER (WHERE COALESCE((to_jsonb(f)->>'cash_refundable')::boolean, true)), 0)::int AS cash
                    FROM fee_credits f JOIN guests g ON g.id = f.guest_id
                    WHERE f.status = 'active' AND f.remaining > 0 AND g.deleted_at IS NULL AND COALESCE(g.email, '') <> ''
                    GROUP BY f.guest_id
                    HAVING bool_and(f.last_email_at IS NULL OR f.last_email_at < ${since})
                    LIMIT 50`;
  } catch (e) { return Object.assign(out, { skipped: 'database update not applied' }); }
  for (const g of due) {
    if (Date.now() - started > deadlineMs) break;
    // Claimed first, so two runs never send twice.
    const claimed = await sql`UPDATE fee_credits SET last_email_at = COALESCE(${at ? new Date(at).toISOString() : null}::timestamptz, now())
                              WHERE id = ANY(${g.ids}) AND (last_email_at IS NULL OR last_email_at < ${since}) RETURNING id`;
    if (claimed.length !== g.ids.length) continue;
    const who = (await sql`SELECT name, email, deleted_at FROM guests WHERE id = ${g.guest_id}`)[0];
    if (!who || who.deleted_at || !who.email) continue;
    const t = TAGLINES[Math.floor((n.m - 2) / 3) % TAGLINES.length];
    const amount = inr(g.balance);
    await email(who.email, t.subject(amount), `
      <div style="font-family:sans-serif; max-width:520px; color:#1c1a17; line-height:1.6;">
        <p style="font-size:13px; letter-spacing:0.12em; text-transform:uppercase; color:#8a6c39; margin:0 0 6px;">Your Aerva credit</p>
        <h2 style="font-family:Georgia,serif; font-weight:normal; margin:0 0 12px;">${amount} is ready when you are</h2>
        <p>Hi ${esc(String(who.name || '').split(' ')[0] || 'there')}, ${t.line(amount)}</p>
        <p style="margin:22px 0;"><a href="https://aerva.in/index.html" style="background:#1c1a17; color:#f4eadc; padding:12px 22px; text-decoration:none; display:inline-block;">Find a stay</a></p>
        <p style="font-size:13px; color:#6e675d;">It is taken off your next booking automatically${g.ends && isFinite(new Date(g.ends)) ? `. Use it by <strong>${day(g.ends)}</strong> — anything left then is refunded to your original payment method` : ''}.${Number(g.cash) > 0 ? ` Prefer the money back? Have ${Number(g.cash) < Number(g.balance) ? inr(g.cash) + ' of it' : 'it'} refunded to your original payment method at any time from <a href="https://aerva.in/index.html?view=wallet" style="color:#8a6c39;">your Aerva wallet</a>.` : ''}</p>
      </div>`);
    out.emailed++;
    out.affected.push({ guestId: g.guest_id, email: who.email, balance: g.balance });
  }
  return out;
}

// ---- Final reminder: 7 days before a credit ends (email only) ----
// One email per guest for credits ending within the next 7 days, in the
// daytime. Claimed per credit (ending_reminded_at), so it is sent once.
const ENDING_NOTICE_DAYS = 7;
async function remindEnding(sql, { deadlineMs = 4000, at } = {}) {
  const started = Date.now();
  const h = indiaNow(at).h;
  if (h < 10 || h >= 19) return { waiting: 'runs between 10 am and 7 pm' };
  const out = { emailed: 0 };
  let due;
  try {
    due = await sql`SELECT f.guest_id, sum(f.remaining)::int AS balance, array_agg(f.id) AS ids, min(f.expires_at) AS ends
                    FROM fee_credits f JOIN guests g ON g.id = f.guest_id
                    WHERE f.status = 'active' AND f.remaining > 0 AND f.ending_reminded_at IS NULL
                      AND COALESCE((to_jsonb(f)->>'cash_refundable')::boolean, true)
                      AND f.expires_at > now() AND f.expires_at <= now() + make_interval(days => ${ENDING_NOTICE_DAYS})
                      AND g.deleted_at IS NULL AND COALESCE(g.email, '') <> ''
                    GROUP BY f.guest_id LIMIT 50`;
  } catch (e) { return Object.assign(out, { skipped: 'database update not applied' }); }
  for (const g of due) {
    if (Date.now() - started > deadlineMs) break;
    const claimed = await sql`UPDATE fee_credits SET ending_reminded_at = now() WHERE id = ANY(${g.ids}) AND ending_reminded_at IS NULL RETURNING id`;
    if (claimed.length !== g.ids.length) continue;
    const who = (await sql`SELECT name, email FROM guests WHERE id = ${g.guest_id}`)[0];
    if (!who || !who.email) continue;
    const amount = inr(g.balance);
    await email(who.email, `Your ${amount} Aerva credit ends on ${day(g.ends)}`, `
      <div style="font-family:sans-serif; max-width:520px; color:#1c1a17; line-height:1.6;">
        <p style="font-size:13px; letter-spacing:0.12em; text-transform:uppercase; color:#8a6c39; margin:0 0 6px;">Your Aerva credit</p>
        <h2 style="font-family:Georgia,serif; font-weight:normal; margin:0 0 12px;">${amount} — use it by ${day(g.ends)}</h2>
        <p>Hi ${esc(String(who.name || '').split(' ')[0] || 'there')}, your <strong>${amount}</strong> of Aerva credit ends on <strong>${day(g.ends)}</strong>. Book a stay or experience before then and it comes off the price automatically.</p>
        <p style="margin:22px 0;"><a href="https://aerva.in/index.html" style="background:#1c1a17; color:#f4eadc; padding:12px 22px; text-decoration:none; display:inline-block;">Find a stay</a></p>
        <p style="font-size:13px; color:#6e675d;">Not booking? Anything left on that date is refunded to your original payment method automatically, or you can have it refunded now from <a href="https://aerva.in/index.html?view=wallet" style="color:#8a6c39;">your Aerva wallet</a>.</p>
      </div>`);
    out.emailed++;
  }
  return out;
}

// For the sign-in reminder: the credit balance and coupons ready to use,
// with the days left on each coupon (by its own expiry date).
async function wallet(sql, guestId) {
  const out = { credit: 0, coupons: [] };
  try {
    const r = (await sql`SELECT COALESCE(sum(remaining), 0)::int AS balance,
                                min(expires_at) FILTER (WHERE COALESCE((to_jsonb(f)->>'cash_refundable')::boolean, true)) AS ends
                         FROM fee_credits f WHERE guest_id = ${guestId} AND status = 'active' AND remaining > 0`)[0];
    out.credit = r ? r.balance : 0;
    out.creditEndsAt = r && r.ends && isFinite(new Date(r.ends)) ? new Date(r.ends).toISOString() : null;
  } catch (e) { /* not there yet */ }
  try {
    const cps = await sql`SELECT code, amount, expires_at FROM coupons WHERE guest_id = ${guestId} AND status = 'active' AND expires_at > now() ORDER BY expires_at LIMIT 5`;
    out.coupons = cps.map(c => ({ code: c.code, amount: Number(c.amount), expiresAt: c.expires_at,
      daysLeft: Math.max(0, Math.ceil((new Date(c.expires_at).getTime() - Date.now()) / 86400e3)) }));
  } catch (e) { /* not there yet */ }
  // Money on its way back to the card. A guest should not have to open each
  // booking to find out what is coming (owner, 12 Nov 2026 — one place that
  // answers "where is my money?").
  try {
    const rs = await sql`
      SELECT r.id, r.amount, r.status, r.created_at, r.kind,
             o.id AS order_id, o.confirmation_code, o.suite_name
        FROM refunds r JOIN orders o ON o.id = r.order_id
       WHERE o.guest_id = ${guestId} AND r.status IN ('new', 'creating', 'pending')
       ORDER BY r.created_at DESC LIMIT 10`;
    out.refunds = rs.map(r => ({
      orderId: Number(r.order_id), code: r.confirmation_code || null, listing: r.suite_name || '',
      amount: Math.round(Number(r.amount) / 100),
      what: /^deposit/.test(String(r.kind || '')) ? 'Security deposit' : /^change/.test(String(r.kind || '')) ? 'Booking changed' : 'Cancellation refund',
      // Razorpay's own guidance: 5 to 7 working days once it is made.
      byDate: new Date(new Date(r.created_at).getTime() + 7 * 86400e3).toISOString().slice(0, 10)
    }));
    out.refundsTotal = out.refunds.reduce((t, x) => t + x.amount, 0);
  } catch (e) { out.refunds = []; out.refundsTotal = 0; }
  return out;
}

// For the bell: the guest's unused credit, as a nudge to use it.
async function bellNotice(sql, guestId) {
  try {
    const out = [];
    const r = (await sql`SELECT COALESCE(sum(remaining), 0)::int AS balance, max(created_at) AS at,
                                min(expires_at) FILTER (WHERE COALESCE((to_jsonb(f)->>'cash_refundable')::boolean, true)) AS ends,
                                COALESCE(sum(remaining) FILTER (WHERE COALESCE((to_jsonb(f)->>'cash_refundable')::boolean, true)), 0)::int AS cash
                         FROM fee_credits f WHERE guest_id = ${guestId} AND status = 'active' AND remaining > 0`)[0];
    if (r && r.balance > 0) {
      const a = inr(r.balance);
      const ends = r.ends && isFinite(new Date(r.ends)) ? ` Use it by ${day(r.ends)}; anything left then is refunded automatically.` : '';
      out.push({ id: 'aerva-credit:' + r.balance, kind: 'action', title: `${a} of Aerva credit is waiting for you`,
                 body: (Number(r.cash) > 0 ? 'Your next getaway is partly paid for. It comes off your next booking automatically — or have it refunded any time.' + ends
                   : 'Your next getaway is partly paid for. It comes off your next booking automatically.'),
                 href: 'index.html?view=wallet' });
    }
    try {
      const cps = await sql`SELECT code, amount, expires_at FROM coupons WHERE guest_id = ${guestId} AND status = 'active' AND expires_at > now() ORDER BY expires_at LIMIT 3`;
      cps.forEach(c => out.push({ id: 'aerva-coupon:' + c.code, kind: 'action', title: `Your ${inr(c.amount)} Aerva coupon: ${c.code}`,
        body: `Use it at checkout by ${day(c.expires_at)}. It covers the booking price and works with your Aerva credit.`, href: 'index.html?view=wallet' }));
    } catch (e) { /* coupons table not there */ }
    // A refund on its way, and by when it should land (owner, 12 Nov 2026,
    // suggestion 16: the bell should carry the money too, not only the
    // credit). The same figures the money panel shows.
    try {
      const w = await wallet(sql, guestId);
      (w.refunds || []).slice(0, 3).forEach(x => out.push({
        id: 'refund-on-way:' + x.orderId + ':' + x.amount, kind: 'info',
        title: `${inr(x.amount)} is on its way back to your card`,
        body: `${x.what}${x.listing ? ' · ' + x.listing : ''} — your bank should show it by ${day(x.byDate)}. Nothing for you to do.`,
        href: 'index.html?view=wallet' }));
    } catch (e) { /* refunds table not there */ }
    return out;
  } catch (e) { return []; }
}

// For the guest: open credits, and ones refunded in the last 60 days.
async function forGuest(sql, guestId) {
  try {
    const rows = await sql`SELECT f.id, f.amount, f.remaining, f.status, CASE WHEN f.expires_at = 'infinity' THEN NULL ELSE f.expires_at END AS expires_at, f.refunded_amount, f.refunded_at, o.suite_name, COALESCE(to_jsonb(f)->>'reason', 'host_cancelled') AS reason,
                                  (to_jsonb(f)->>'cash_refundable')::boolean AS cash_refundable
                           FROM fee_credits f LEFT JOIN orders o ON o.id = COALESCE(f.source_order_id, (to_jsonb(f)->>'group_order_id')::int)
                           WHERE f.guest_id = ${guestId} AND (f.status IN ('active', 'refunding') OR f.refunded_at > now() - interval '60 days')
                           ORDER BY f.created_at DESC LIMIT 20`;
    // canRefund: the guest may have it refunded to the original payment now
    // (every open credit, natural-disaster credit included).
    return rows.map(r => Object.assign({ id: r.id, amount: r.amount, remaining: r.remaining, status: r.status, expiresAt: r.expires_at,
      refunded: r.refunded_amount, refundedAt: r.refunded_at, from: r.suite_name || '', reason: r.reason },
      r.reason === 'natural_disaster' ? { disaster: true } : {},
      refundableNow(r) && r.status === 'active' && r.remaining > 0 ? { canRefund: true } : {}));
  } catch (e) { return []; }
}

module.exports = { nonCash, refundableNow, FEE_CREDIT_DAYS, createForHostCancellation, creditForWholeBooking, creditForGroupPayers, creditForTransfer, creditForCheckinRebook, giveBack, creditOn, available, allocate, spread, claim, unclaim, recordUses, refundCredit, runExpired, forGuest, remindOnSignIn, remindQuarterly, remindEnding, creditEnd, bellNotice, wallet };
