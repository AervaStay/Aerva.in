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
//     Bookings → "Refund it now"); and whatever is left when the credit
//     period ends is refunded automatically ('fee_credit_refunds' job).
//     Either way, in full, to the original payment method.
//   • A booking paid partly with credit and later refunded (cancelled,
//     changed, a stay problem upheld) is refunded to the payment first; the
//     part the payment cannot take goes back onto the credit (giveBack), with
//     a fresh credit period. Cancelled by its host, everything the credit
//     paid comes back, and its service fee becomes credit as above.
//
// Only bookings paid in rupees get a credit; one paid in another currency
// has its service fee refunded with the rest, at once.

const FEE_CREDIT_DAYS = 30;
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
                WHERE id = ${u.credit_id} AND status IN ('active', 'used')`; // 'infinity' stays 'infinity'
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
    rows = await sql`SELECT id, guest_id, guest_email, suite_name, razorpay_payment_id, razorpay_order_id, COALESCE(charge_currency, 'INR') AS currency,
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
                           VALUES (${r.guest_id}, ${r.guest_email}, ${r.id}, ${r.razorpay_payment_id}, ${fee}, ${fee}, now() + make_interval(days => ${FEE_CREDIT_DAYS}))
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
        <p>Because your host cancelled, Aerva’s service fee of <strong>${inr(total)}</strong> is not kept. It is held for you as Aerva credit until <strong>${esc(day(list[0].expires_at))}</strong>.</p>
        <p>Book another stay or experience on Aerva by then and the credit is taken off what you pay, automatically. Anything left stays on your credit. If you decide not to book again, you can have it refunded at any time from My Bookings — and anything left on that date is refunded to your original payment method automatically.</p>
        <p style="font-size:12px; opacity:0.6;">Questions: hello@aerva.in</p></div>`);
  }
  made.restored = restored;
  return made;
}

// A stay shortened during the stay (the host agreed, _booking-changes.js):
// what the shorter stay gives back is not refunded to the payment but held
// as Aerva credit, like a host's cancellation — as far as the booking was
// paid in money; a part paid with credit goes back onto that credit.
// Returns { credit: the new credit (₹), back: given back to used credit, expiresAt }.
async function creditForShorterStay(sql, orderId, amount) {
  const want = Math.max(0, Math.round(Number(amount) || 0));
  const out = { credit: 0, back: 0, expiresAt: null };
  if (!want) return out;
  const o = (await sql`SELECT id, guest_id, guest_email, suite_name, razorpay_payment_id, razorpay_order_id, COALESCE(deposit_amount, 0) AS deposit
                       FROM orders WHERE id = ${Number(orderId) || 0}`)[0];
  if (!o) return out;
  // Money the payment can still give back (deposit aside, less refunds so far).
  const { paidByOrderRow } = require('./_booking-rules');
  let room = want;
  try {
    const p = (await paidByOrderRow(sql, o.razorpay_order_id))[o.id];
    const refunded = Number((await sql`SELECT COALESCE(sum(amount), 0) AS v FROM refunds WHERE order_id = ${o.id} AND kind NOT LIKE 'deposit%' AND status <> 'failed'`)[0].v) / 100;
    if (p) room = Math.max(0, Math.floor(p.paid - Math.round(Number(o.deposit) || 0) - refunded));
  } catch (e) { /* the whole amount */ }
  const credit = Math.min(want, room);
  if (want - credit > 0) out.back = await giveBack(sql, o.id, want - credit);
  if (credit > 0) {
    let c;
    const ins = (withReason) => withReason
      ? sql`INSERT INTO fee_credits (guest_id, guest_email, source_order_id, razorpay_payment_id, amount, remaining, expires_at, reason)
            VALUES (${o.guest_id}, ${o.guest_email}, ${o.id}, ${o.razorpay_payment_id}, ${credit}, ${credit}, 'infinity'::timestamptz, 'stay_shortened')
            ON CONFLICT (source_order_id) DO UPDATE SET amount = fee_credits.amount + EXCLUDED.amount, remaining = fee_credits.remaining + EXCLUDED.remaining, status = 'active',
              expires_at = GREATEST(fee_credits.expires_at, EXCLUDED.expires_at)
            WHERE fee_credits.status <> 'refunding' RETURNING *`
      : sql`INSERT INTO fee_credits (guest_id, guest_email, source_order_id, razorpay_payment_id, amount, remaining, expires_at)
            VALUES (${o.guest_id}, ${o.guest_email}, ${o.id}, ${o.razorpay_payment_id}, ${credit}, ${credit}, 'infinity'::timestamptz)
            ON CONFLICT (source_order_id) DO UPDATE SET amount = fee_credits.amount + EXCLUDED.amount, remaining = fee_credits.remaining + EXCLUDED.remaining, status = 'active',
              expires_at = GREATEST(fee_credits.expires_at, EXCLUDED.expires_at)
            WHERE fee_credits.status <> 'refunding' RETURNING *`;
    // Credit for nights not stayed never ends: the guest uses it on a later
    // booking or has it refunded whenever they ask. Never auto-refunded.
    try { c = (await ins(true))[0]; }
    catch (err) { if (err && err.code === '42703') c = (await ins(false))[0]; else throw err; }
    if (!c) throw Object.assign(new Error('Your Aerva credit is being refunded right now. Please try again in a few minutes.'), { isUserFacing: true, status: 409 });
    out.credit = credit; out.expiresAt = null;
    await entry(sql, c.id, 'issued', credit, { orderId: o.id, reference: o.razorpay_payment_id, note: 'Stay shortened: nights not stayed' });
  }
  await email(o.guest_email, `${inr(want)} is back with you as Aerva credit`, `
    <div style="font-family:sans-serif; max-width:520px; color:#1c1a17; line-height:1.6;">
      <p>Your stay at <strong>${esc(o.suite_name)}</strong> was shortened. The <strong>${inr(want)}</strong> for the nights you are no longer staying is held for you as Aerva credit. It does not expire.</p>
      <p>Book another stay or experience and it is taken off what you pay, automatically. Or have it refunded to your original payment method whenever you choose, from My Bookings.</p>
      <p style="font-size:12px; opacity:0.6;">Questions: hello@aerva.in</p></div>`);
  return out;
}

// A host cancels within 48 hours of check-in, or the host of an experience
// that includes a stay cancels it: EVERYTHING the guest paid for the
// booking — price, GST and Aerva's service fee — is held as Aerva credit
// (the deposit is refunded to the payment as usual). The guest uses it on
// another stay or experience, or has it refunded at any time; what is left
// at the end of the credit period is refunded automatically. What the
// booking was paid with credit comes back onto that credit. reason:
// 'host_cancelled_late' | 'experience_cancelled'. Returns { total, back }.
async function creditForWholeBooking(sql, orderIds, reason) {
  const ids = (orderIds || []).map(Number).filter(Boolean);
  const out = { total: 0, back: 0, expiresAt: null };
  if (!ids.length) return out;
  const { paidByOrderRow } = require('./_booking-rules');
  const rows = await sql`SELECT id, guest_id, guest_email, suite_name, razorpay_payment_id, razorpay_order_id, COALESCE(charge_currency, 'INR') AS currency,
                                COALESCE(deposit_amount, 0) AS deposit
                         FROM orders WHERE id = ANY(${ids}) AND status = 'cancelled'`;
  let guestEmail = null, suite = null;
  for (const r of rows) {
    out.back += await giveBack(sql, r.id);
    if (r.currency !== 'INR' || !r.razorpay_payment_id) continue;
    let money = 0;
    try {
      const p = (await paidByOrderRow(sql, r.razorpay_order_id))[r.id];
      // What the payment still holds for this row: paid, less every refund
      // so far — the deposit went back with the cancellation (it is held
      // until after the stay, so it is always refunded with it).
      const refunded = Number((await sql`SELECT COALESCE(sum(amount), 0) AS v FROM refunds WHERE order_id = ${r.id} AND status <> 'failed'`)[0].v) / 100;
      if (p) money = Math.max(0, Math.floor(p.paid - refunded));
    } catch (e) { money = 0; }
    if (money <= 0) continue;
    let c;
    const ins = (withReason) => withReason
      ? sql`INSERT INTO fee_credits (guest_id, guest_email, source_order_id, razorpay_payment_id, amount, remaining, expires_at, reason)
            VALUES (${r.guest_id}, ${r.guest_email}, ${r.id}, ${r.razorpay_payment_id}, ${money}, ${money}, now() + make_interval(days => ${FEE_CREDIT_DAYS}), ${reason})
            ON CONFLICT (source_order_id) DO NOTHING RETURNING *`
      : sql`INSERT INTO fee_credits (guest_id, guest_email, source_order_id, razorpay_payment_id, amount, remaining, expires_at)
            VALUES (${r.guest_id}, ${r.guest_email}, ${r.id}, ${r.razorpay_payment_id}, ${money}, ${money}, now() + make_interval(days => ${FEE_CREDIT_DAYS}))
            ON CONFLICT (source_order_id) DO NOTHING RETURNING *`;
    try { c = (await ins(true))[0]; }
    catch (err) { if (err && err.code === '42703') c = (await ins(false))[0]; else { console.error('credit not made (needs follow-up):', r.id, err.message); continue; } }
    if (!c) continue;
    await entry(sql, c.id, 'issued', money, { orderId: r.id, reference: r.razorpay_payment_id,
      note: reason === 'experience_cancelled' ? 'Experience (with its stay) cancelled by its host: all of it' : 'Host cancelled: all of it' });
    out.total += money; out.expiresAt = c.expires_at; guestEmail = r.guest_email; suite = suite || r.suite_name;
  }
  if (out.total > 0 && guestEmail) {
    await email(guestEmail, `${inr(out.total)} is held for you as Aerva credit`, `
      <div style="font-family:sans-serif; max-width:520px; color:#1c1a17; line-height:1.6;">
        <p>Your booking at <strong>${esc(suite || 'Aerva')}</strong> was cancelled by the host. Everything you paid for it — <strong>${inr(out.total)}</strong>, including GST and Aerva’s service fee — is held for you as Aerva credit until <strong>${esc(day(out.expiresAt))}</strong>.</p>
        <p>Book another stay or experience and it is taken off what you pay, automatically. Or have it refunded to your original payment method at any time from My Bookings — anything left on that date is refunded automatically.</p>
        <p style="font-size:12px; opacity:0.6;">Questions: hello@aerva.in</p></div>`);
  }
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
  const c = (await sql`UPDATE fee_credits SET status = 'refunding' WHERE id = ${Number(creditId) || 0} AND status = 'active' AND remaining > 0 RETURNING *`)[0];
  if (!c) throw Object.assign(new Error('There is nothing left on this credit to refund.'), { isUserFacing: true, status: 409 });
  try {
    const { safeRefund } = require('./_refunds');
    const rf = await safeRefund(sql, razorpay, { orderId: c.source_order_id, paymentId: c.razorpay_payment_id, amountSubunit: c.remaining * 100,
      kind: `cancellation:fee-credit-${c.id}-${c.refunded_amount}` });
    await sql`UPDATE fee_credits SET status = 'refunded', refunded_amount = refunded_amount + remaining, remaining = 0, refunded_at = now(), refund_reason = ${reason} WHERE id = ${c.id}`;
    await entry(sql, c.id, 'refunded', c.remaining, { orderId: c.source_order_id, reference: (rf && rf.id) || null, note: reason === 'expired' ? 'Refunded at the end of the credit period' : 'Refunded at the guest’s request' });
  } catch (err) {
    await sql`UPDATE fee_credits SET status = 'active' WHERE id = ${c.id} AND status = 'refunding'`;
    throw err;
  }
  await email(c.guest_email, `Your Aerva credit of ${inr(c.remaining)} has been refunded`, `
    <div style="font-family:sans-serif; max-width:520px; color:#1c1a17; line-height:1.6;">
      <p>${reason === 'expired' ? 'Your Aerva credit has ended, so' : 'As you asked,'} <strong>${inr(c.remaining)}</strong> has been refunded to your original payment method. It usually appears within 5–7 working days, depending on your bank.</p>
      <p style="font-size:12px; opacity:0.6;">Questions: hello@aerva.in</p></div>`);
  return { refunded: c.remaining };
}

// Scheduler: refunds what is left on credits whose period has ended.
async function runExpired(sql, razorpay, { deadlineMs = 4000 } = {}) {
  const started = Date.now();
  const out = { refunded: 0, failed: 0 };
  if (!razorpay) return Object.assign(out, { skipped: 'Razorpay keys not set' });
  let due;
  try {
    due = await sql`SELECT id FROM fee_credits WHERE status = 'active' AND remaining > 0
                      AND expires_at < now() - make_interval(mins => ${REFUND_GRACE_MINUTES}) ORDER BY expires_at LIMIT 20`;
    await sql`UPDATE fee_credits SET status = 'used' WHERE status = 'active' AND remaining <= 0`;
  } catch (e) { return Object.assign(out, { skipped: 'database update not applied' }); }
  for (const d of due) {
    if (Date.now() - started > deadlineMs) break;
    try { await refundCredit(sql, razorpay, d.id, 'expired'); out.refunded++; }
    catch (e) { out.failed++; console.error('fee credit refund failed:', d.id, e.message); }
  }
  return out;
}

// For the guest: open credits, and ones refunded in the last 60 days.
async function forGuest(sql, guestId) {
  try {
    const rows = await sql`SELECT f.id, f.amount, f.remaining, f.status, CASE WHEN f.expires_at = 'infinity' THEN NULL ELSE f.expires_at END AS expires_at, f.refunded_amount, f.refunded_at, o.suite_name, COALESCE(to_jsonb(f)->>'reason', 'host_cancelled') AS reason
                           FROM fee_credits f LEFT JOIN orders o ON o.id = f.source_order_id
                           WHERE f.guest_id = ${guestId} AND (f.status IN ('active', 'refunding') OR f.refunded_at > now() - interval '60 days')
                           ORDER BY f.created_at DESC LIMIT 20`;
    return rows.map(r => ({ id: r.id, amount: r.amount, remaining: r.remaining, status: r.status, expiresAt: r.expires_at,
      refunded: r.refunded_amount, refundedAt: r.refunded_at, from: r.suite_name || '', reason: r.reason }));
  } catch (e) { return []; }
}

module.exports = { FEE_CREDIT_DAYS, createForHostCancellation, creditForWholeBooking, creditForShorterStay, giveBack, creditOn, available, allocate, spread, claim, unclaim, recordUses, refundCredit, runExpired, forGuest };
