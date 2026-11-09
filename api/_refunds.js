// /api/_refunds.js — every refund goes through here. Not an endpoint.
//
// No double refunds, ever:
//   • one refund per booking per purpose (refunds table, unique), claimed
//     atomically, so double-clicks and retries cannot create a second;
//   • before creating one, Razorpay is asked what has ACTUALLY happened:
//     an existing refund for this booking and purpose (tagged in its notes)
//     is adopted instead of creating another, and nothing is refunded
//     beyond what the payment has left;
//   • status is then tracked from Razorpay (pending → processed / failed).
// A FAILED refund is retried only by an admin (Admin → Payouts → Refunds),
// through the same checks.
//   kind: 'cancellation' | 'deposit' | 'deposit_dispute'
//         | 'cancellation:<payment>' | 'change-<id>:<payment>' | 'dispute-<id>:<payment>'
//         | 'change-pay-<id>'   (allowed by sql/migration_refund_kinds.sql)

const ACTIVE = ['pending', 'processed'];

async function razorpayRefundsFor(razorpay, paymentId) {
  try {
    if (razorpay.payments && typeof razorpay.payments.fetchMultipleRefund === 'function') {
      const r = await razorpay.payments.fetchMultipleRefund(paymentId, { count: 100 });
      return (r && r.items) || [];
    }
  } catch (e) { /* fall through: rely on the payment's refunded amount */ }
  return [];
}

// Refund amountSubunit (paise, or the charge currency's subunit) of a
// payment for one booking and purpose. Returns { id, status, adopted, amount }
// (amount: the subunits actually refunded, or adopted).
// Throws a user-facing error if it cannot be done safely.
// The row's amount is the amount of record: a retry of a row where nothing
// was refunded yet may correct it (checked with Razorpay first); once
// something WAS refunded, a different amount is refused, never added.
async function safeRefund(sql, razorpay, { orderId, paymentId, amountSubunit, kind }) {
  if (!paymentId) throw Object.assign(new Error('No payment is recorded for this booking, so it cannot be refunded automatically.'), { isUserFacing: true, status: 400 });
  const amount = Math.round(Number(amountSubunit) || 0);
  if (amount <= 0) return { id: null, status: 'processed', adopted: false, nothing: true, amount: 0 };
  const key = `${kind}:${orderId}`;
  // 1. The one row for this booking and purpose.
  let row = (await sql`
    INSERT INTO refunds (order_id, kind, razorpay_payment_id, amount, status)
    VALUES (${orderId}, ${kind}, ${paymentId}, ${amount}, 'new')
    ON CONFLICT (order_id, kind) DO NOTHING RETURNING *
  `)[0];
  if (!row) row = (await sql`SELECT * FROM refunds WHERE order_id = ${orderId} AND kind = ${kind}`)[0];
  if (ACTIVE.includes(row.status) && row.razorpay_refund_id) {
    if (Number(row.amount) !== amount) {
      throw Object.assign(new Error(`A refund of a different amount has already been made for this booking (${kind}). Nothing more was refunded — please check Admin → Refunds.`), { isUserFacing: true, status: 409 });
    }
    return { id: row.razorpay_refund_id, status: row.status, adopted: true, amount: Number(row.amount) };
  }
  // 2. Claim it (only one request at a time may create the refund).
  const claimed = await sql`UPDATE refunds SET status = 'creating', attempts = attempts + 1, last_checked_at = now()
                            WHERE id = ${row.id} AND (status IN ('new', 'failed')
                              -- stuck mid-way (e.g. a timeout): retryable after 10 minutes; Razorpay is re-checked first
                              OR (status = 'creating' AND last_checked_at < now() - interval '10 minutes')) RETURNING id`;
  if (!claimed.length) throw Object.assign(new Error('This refund is already being processed.'), { isUserFacing: true, status: 409 });
  try {
    // 3. What has actually happened at Razorpay. A refund that went through
    // is adopted at its real amount, whatever amount was asked for now.
    const existing = (await razorpayRefundsFor(razorpay, paymentId)).find(r => r.notes && r.notes.aerva_refund_key === key && r.status !== 'failed');
    if (existing) {
      const got = Math.round(Number(existing.amount)) || Number(row.amount);
      await sql`UPDATE refunds SET status = ${existing.status === 'processed' ? 'processed' : 'pending'}, razorpay_refund_id = ${existing.id}, amount = ${got}, failure_reason = NULL WHERE id = ${row.id}`;
      return { id: existing.id, status: existing.status, adopted: true, amount: got };
    }
    // Nothing refunded yet for this row: the amount asked for now is the one of record.
    if (Number(row.amount) !== amount) await sql`UPDATE refunds SET amount = ${amount} WHERE id = ${row.id} AND status = 'creating'`;
    const payment = await razorpay.payments.fetch(paymentId);
    const left = Number(payment.amount) - Number(payment.amount_refunded || 0);
    if (amount > left) {
      await sql`UPDATE refunds SET status = 'failed', failure_reason = ${`Only ${left} left to refund on this payment; nothing refunded again.`} WHERE id = ${row.id}`;
      throw Object.assign(new Error('This payment has already been refunded.'), { isUserFacing: true, status: 409 });
    }
    // 4. Create it, tagged so a retry can always find it.
    const refund = await razorpay.payments.refund(paymentId, { amount, speed: 'normal', notes: { aerva_refund_key: key } });
    await sql`UPDATE refunds SET status = ${refund.status === 'processed' ? 'processed' : 'pending'}, razorpay_refund_id = ${refund.id}, failure_reason = NULL WHERE id = ${row.id}`;
    return { id: refund.id, status: refund.status, adopted: false, amount };
  } catch (err) {
    // Unknown outcome: mark failed. A retry re-checks Razorpay first, so a
    // refund that did go through is found and adopted, never repeated.
    const why = (err && err.error && err.error.description) || String((err && err.message) || err);
    await sql`UPDATE refunds SET status = 'failed', failure_reason = ${why.slice(0, 300)} WHERE id = ${row.id} AND status = 'creating'`;
    // Razorpay said no (unknown payment, already refunded, a test-mode
    // payment on another key...): say why, instead of a bare "try again".
    if (!err.isUserFacing && (err.error || err.statusCode)) {
      // A cancellation refunds first and cancels only after it: the booking still stands,
      // so it is tried again by cancelling again, not from Admin → Refunds.
      const msg = /^cancellation/.test(String(kind || ''))
        ? `Razorpay could not make the refund: ${why.replace(/\.$/, '')}. No money was refunded, nothing was cancelled and the booking stands. Cancel it again once this is fixed.`
        : `Razorpay could not make the refund: ${why.replace(/\.$/, '')}. No money was refunded. It is listed in Admin → Payouts → Refunds to retry.`;
      throw Object.assign(new Error(msg), { isUserFacing: true, status: 502, cause: err });
    }
    throw err;
  }
}

// Track refunds Razorpay is still processing. Never throws.
async function pollRefunds(sql, razorpay) {
  const out = { checked: 0, processed: 0, failed: 0 };
  try {
    const rows = await sql`SELECT id, razorpay_refund_id, razorpay_payment_id FROM refunds WHERE status = 'pending' AND razorpay_refund_id IS NOT NULL LIMIT 50`;
    for (const r of rows) {
      out.checked++;
      try {
        const rf = razorpay.refunds && typeof razorpay.refunds.fetch === 'function'
          ? await razorpay.refunds.fetch(r.razorpay_refund_id)
          : await razorpay.payments.fetchRefund(r.razorpay_payment_id, r.razorpay_refund_id);
        if (rf.status === 'processed') { await sql`UPDATE refunds SET status = 'processed', last_checked_at = now() WHERE id = ${r.id}`; out.processed++; }
        else if (rf.status === 'failed') { await sql`UPDATE refunds SET status = 'failed', failure_reason = 'Razorpay reported the refund failed', last_checked_at = now() WHERE id = ${r.id}`; out.failed++; }
        else await sql`UPDATE refunds SET last_checked_at = now() WHERE id = ${r.id}`;
      } catch (e) { console.error('refund status check failed:', r.id, e.message); }
    }
  } catch (err) { out.skipped = true; }
  return out;
}

// Refunds spread over every payment of a booking: the original payment
// first, then any payments for earlier changes. Each payment is refunded at
// most once per purpose (kind), never beyond what it has left. Returns the
// rupees refunded; anything that could not be refunded in cash is the
// caller's to return as a coupon.
// Safe to call again for the same purpose (a retry, a double click): what
// was already refunded for kindBase counts towards amountInr, so the total
// is refunded once. Rows written ahead by planRefundAcrossPayments are
// used as they are.
async function paymentsOf(sql, orderId) {
  const o = (await sql`SELECT razorpay_payment_id, razorpay_order_id, charge_currency FROM orders WHERE id = ${orderId}`)[0];
  let extra = [];
  // Change payments of any row of the same purchase: a change to an
  // "Includes a Stay" pair is paid once, for both halves.
  try {
    extra = await sql`SELECT DISTINCT bc.id, bc.razorpay_payment_id FROM booking_changes bc JOIN orders x ON x.id = bc.order_id
                      WHERE x.razorpay_order_id = (SELECT razorpay_order_id FROM orders WHERE id = ${orderId})
                        AND bc.status = 'applied' AND bc.razorpay_payment_id IS NOT NULL ORDER BY bc.id`;
  } catch (e) { /* none */ }
  // Newest change payment first, the original payment last: the original
  // carries the security deposit, which must stay refundable.
  const payments = [...new Set([...extra.map(r => r.razorpay_payment_id).reverse(), o && o.razorpay_payment_id].filter(Boolean))];
  return { o, payments };
}
async function rowsFor(sql, orderId, kindBase) {
  try {
    return await sql`SELECT id, kind, razorpay_payment_id, amount, status, razorpay_refund_id FROM refunds
                     WHERE order_id = ${orderId} AND kind LIKE ${kindBase + ':%'} ORDER BY id`;
  } catch (e) { return []; }
}

// ---- A group booking (_group-bookings.js): several people paid ----
// Each payment's part of the booking: what it paid, less anything refunded
// to it before the booking existed (the excess of a smaller booking). A
// change payment made later counts as the organiser's.
async function groupPaymentsOf(sql, orderId) {
  let gid = null;
  try { gid = ((await sql`SELECT (to_jsonb(orders)->>'group_booking_id')::int AS g FROM orders WHERE id = ${orderId}`)[0] || {}).g || null; } catch (e) { return null; }
  if (!gid) return null;
  const claims = await sql`SELECT razorpay_payment_id, amount, refund_amount, refund_status FROM group_claims
                           WHERE group_id = ${gid} AND status = 'paid' AND razorpay_payment_id IS NOT NULL ORDER BY id`;
  const list = claims.map(c => ({ pid: c.razorpay_payment_id,
    net: Number(c.amount) - (c.refund_status && c.refund_status !== 'failed' ? Math.round(Number(c.refund_amount || 0) / 100) : 0) }));
  try {
    (await sql`SELECT razorpay_payment_id, difference FROM booking_changes WHERE order_id = ${orderId} AND status = 'applied'
               AND razorpay_payment_id IS NOT NULL AND difference > 0 ORDER BY id`).forEach(c => list.push({ pid: c.razorpay_payment_id, net: Number(c.difference) }));
  } catch (e) { /* none */ }
  return list.filter(x => x.net > 0);
}
// Splits a refund over a group's payments in proportion to what each paid,
// in whole rupees that add up exactly (leftover rupees to the last payers).
// Deterministic, so a retry asks each payment for the same amount and
// safeRefund adopts what already went through.
async function refundGroupShares(sql, razorpay, { orderId, amountInr, kindBase, list }) {
  const total = list.reduce((t, x) => t + x.net, 0);
  const want = Math.min(Math.max(0, Math.round(Number(amountInr) || 0)), total);
  const parts = list.map(x => Math.floor(want * x.net / (total || 1)));
  let rem = want - parts.reduce((t, x) => t + x, 0);
  for (let i = parts.length - 1; rem > 0; i = (i - 1 + parts.length) % parts.length) { if (parts[i] < list[i].net) { parts[i]++; rem--; } }
  let refundedInr = 0, firstRefundId = null;
  for (let i = 0; i < list.length; i++) {
    if (!parts[i]) continue;
    const r = await safeRefund(sql, razorpay, { orderId, paymentId: list[i].pid, amountSubunit: parts[i] * 100, kind: `${kindBase}:${list[i].pid}` });
    if (!firstRefundId) firstRefundId = r.id;
    refundedInr += Math.round(Number(r.amount != null ? r.amount : parts[i] * 100) / 100);
  }
  return { refundedInr, shortfallInr: Math.max(0, Math.round(Number(amountInr) || 0) - refundedInr), firstRefundId, shares: list.map((x, i) => ({ paymentId: x.pid, inr: parts[i] })) };
}

async function refundAcrossPayments(sql, razorpay, { orderId, amountInr, kindBase }) {
  let remaining = Math.max(0, Math.round(Number(amountInr) || 0));
  if (!remaining) return { refundedInr: 0, shortfallInr: 0, firstRefundId: null };
  const group = await groupPaymentsOf(sql, orderId);
  if (group && group.length) return refundGroupShares(sql, razorpay, { orderId, amountInr: remaining, kindBase, list: group });
  const { o, payments } = await paymentsOf(sql, orderId);
  // A foreign-currency booking has one payment (changes are INR only): the
  // same share of what was captured, never today's rate (_currency.js).
  if (o && (o.charge_currency || 'INR') !== 'INR') {
    const { refundSubunitForInr } = require('./_currency');
    const want = await refundSubunitForInr(sql, { razorpayOrderId: o.razorpay_order_id, amountInr: remaining, currency: o.charge_currency });
    if (!want) throw Object.assign(new Error(`There is no record of the amount charged in ${o.charge_currency}, so this cannot be refunded automatically.`), { isUserFacing: true, status: 502 });
    const r = await safeRefund(sql, razorpay, { orderId, paymentId: o.razorpay_payment_id, amountSubunit: want, kind: `${kindBase}:${o.razorpay_payment_id}` });
    return { refundedInr: remaining, shortfallInr: 0, firstRefundId: r.id };
  }
  const rows = await rowsFor(sql, orderId, kindBase);
  const rowOf = new Map(rows.map(r => [r.razorpay_payment_id, r]));
  const all = [...new Set([...payments, ...rows.map(r => r.razorpay_payment_id)])];
  let refundedInr = 0, firstRefundId = null;
  for (const pid of all) {
    if (remaining <= 0) break;
    const row = rowOf.get(pid);
    let amount;
    if (row && ACTIVE.includes(row.status) && row.razorpay_refund_id) {
      // Already refunded for this purpose: it counts, and is never made again.
      const got = Math.round(Number(row.amount) / 100);
      if (!firstRefundId) firstRefundId = row.razorpay_refund_id;
      refundedInr += got; remaining -= got;
      continue;
    }
    if (row) {
      // Started before and not finished (failed, or written ahead): Razorpay
      // is asked first, so one that did go through is adopted at its amount.
      const tagged = (await razorpayRefundsFor(razorpay, pid)).find(r => r.notes && r.notes.aerva_refund_key === `${row.kind}:${orderId}` && r.status !== 'failed');
      if (tagged) amount = Math.round(Number(tagged.amount)) || Number(row.amount);
    }
    if (!amount) {
      const pay = await razorpay.payments.fetch(pid);
      const left = Math.floor((Number(pay.amount) - Number(pay.amount_refunded || 0)) / 100);
      const take = Math.min(left, remaining);
      if (take <= 0) continue;
      amount = take * 100;
    }
    const refund = await safeRefund(sql, razorpay, { orderId, paymentId: pid, amountSubunit: amount, kind: `${kindBase}:${pid}` });
    if (!firstRefundId) firstRefundId = refund.id;
    const got = Math.round(Number(refund.amount != null ? refund.amount : amount) / 100);
    refundedInr += got; remaining -= got;
  }
  remaining = Math.max(0, remaining);
  return { refundedInr, shortfallInr: remaining, firstRefundId };
}

// Writes down, BEFORE anything else changes, the refunds a purpose will
// need (one 'new' row per payment, in the order refundAcrossPayments uses).
// If the work that follows is interrupted, the rows are there: Admin →
// Refunds shows them and can retry them, and refundAcrossPayments picks them
// up. Returns { plannedInr, shortfallInr } — the shortfall is the part no
// payment has left in cash (for the caller to return as a coupon).
// INR payments only (a changed booking is always INR).
async function planRefundAcrossPayments(sql, razorpay, { orderId, amountInr, kindBase }) {
  let remaining = Math.max(0, Math.round(Number(amountInr) || 0));
  if (!remaining) return { plannedInr: 0, shortfallInr: 0 };
  // A group booking is refunded in proportion when it happens (refundGroupShares).
  const group = await groupPaymentsOf(sql, orderId);
  if (group && group.length) {
    const total = group.reduce((t, x) => t + x.net, 0);
    return { plannedInr: Math.min(remaining, total), shortfallInr: Math.max(0, remaining - total) };
  }
  const { payments } = await paymentsOf(sql, orderId);
  const rows = await rowsFor(sql, orderId, kindBase);
  const rowOf = new Map(rows.map(r => [r.razorpay_payment_id, r]));
  let plannedInr = 0;
  for (const pid of payments) {
    if (remaining <= 0) break;
    const row = rowOf.get(pid);
    let take;
    if (row) take = Math.min(remaining, Math.round(Number(row.amount) / 100));
    else {
      const pay = await razorpay.payments.fetch(pid);
      take = Math.min(remaining, Math.floor((Number(pay.amount) - Number(pay.amount_refunded || 0)) / 100));
      if (take <= 0) continue;
      // Throws before the migration that allows these kinds: then nothing is changed.
      await sql`INSERT INTO refunds (order_id, kind, razorpay_payment_id, amount, status)
                VALUES (${orderId}, ${`${kindBase}:${pid}`}, ${pid}, ${take * 100}, 'new')
                ON CONFLICT (order_id, kind) DO NOTHING`;
    }
    plannedInr += take; remaining -= take;
  }
  return { plannedInr, shortfallInr: remaining };
}
// Undo a plan whose purpose did not go ahead (only rows nothing was done with).
async function dropPlannedRefunds(sql, { orderId, kindBase }) {
  try { await sql`DELETE FROM refunds WHERE order_id = ${orderId} AND kind LIKE ${kindBase + ':%'} AND status = 'new'`; }
  catch (err) { console.error('planned refunds not removed:', orderId, kindBase, err.message); }
}
async function hasChangePayments(sql, orderId) {
  // A group booking was paid by several payments: always refunded across them.
  try { if (((await sql`SELECT (to_jsonb(orders)->>'group_booking_id') AS g FROM orders WHERE id = ${orderId}`)[0] || {}).g) return true; } catch (e) { /* none */ }
  try {
    return (await sql`SELECT 1 FROM booking_changes bc JOIN orders x ON x.id = bc.order_id
                      WHERE x.razorpay_order_id = (SELECT razorpay_order_id FROM orders WHERE id = ${orderId})
                        AND bc.status = 'applied' AND bc.razorpay_payment_id IS NOT NULL LIMIT 1`).length > 0;
  }
  catch (e) { return false; }
}


module.exports = { safeRefund, pollRefunds, refundAcrossPayments, hasChangePayments, planRefundAcrossPayments, dropPlannedRefunds, groupPaymentsOf };
