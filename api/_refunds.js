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
// payment for one booking and purpose. Returns { id, status, adopted }.
// Throws a user-facing error if it cannot be done safely.
async function safeRefund(sql, razorpay, { orderId, paymentId, amountSubunit, kind }) {
  if (!paymentId) throw Object.assign(new Error('No payment is recorded for this booking, so it cannot be refunded automatically.'), { isUserFacing: true, status: 400 });
  const amount = Math.round(Number(amountSubunit) || 0);
  if (amount <= 0) return { id: null, status: 'processed', adopted: false, nothing: true };
  const key = `${kind}:${orderId}`;
  // 1. The one row for this booking and purpose.
  let row = (await sql`
    INSERT INTO refunds (order_id, kind, razorpay_payment_id, amount, status)
    VALUES (${orderId}, ${kind}, ${paymentId}, ${amount}, 'new')
    ON CONFLICT (order_id, kind) DO NOTHING RETURNING *
  `)[0];
  if (!row) row = (await sql`SELECT * FROM refunds WHERE order_id = ${orderId} AND kind = ${kind}`)[0];
  if (ACTIVE.includes(row.status) && row.razorpay_refund_id) return { id: row.razorpay_refund_id, status: row.status, adopted: true };
  // 2. Claim it (only one request at a time may create the refund).
  const claimed = await sql`UPDATE refunds SET status = 'creating', attempts = attempts + 1, last_checked_at = now()
                            WHERE id = ${row.id} AND (status IN ('new', 'failed')
                              -- stuck mid-way (e.g. a timeout): retryable after 10 minutes; Razorpay is re-checked first
                              OR (status = 'creating' AND last_checked_at < now() - interval '10 minutes')) RETURNING id`;
  if (!claimed.length) throw Object.assign(new Error('This refund is already being processed.'), { isUserFacing: true, status: 409 });
  try {
    // 3. What has actually happened at Razorpay.
    const existing = (await razorpayRefundsFor(razorpay, paymentId)).find(r => r.notes && r.notes.aerva_refund_key === key && r.status !== 'failed');
    if (existing) {
      await sql`UPDATE refunds SET status = ${existing.status === 'processed' ? 'processed' : 'pending'}, razorpay_refund_id = ${existing.id}, failure_reason = NULL WHERE id = ${row.id}`;
      return { id: existing.id, status: existing.status, adopted: true };
    }
    const payment = await razorpay.payments.fetch(paymentId);
    const left = Number(payment.amount) - Number(payment.amount_refunded || 0);
    if (amount > left) {
      await sql`UPDATE refunds SET status = 'failed', failure_reason = ${`Only ${left} left to refund on this payment; nothing refunded again.`} WHERE id = ${row.id}`;
      throw Object.assign(new Error('This payment has already been refunded.'), { isUserFacing: true, status: 409 });
    }
    // 4. Create it, tagged so a retry can always find it.
    const refund = await razorpay.payments.refund(paymentId, { amount, speed: 'normal', notes: { aerva_refund_key: key } });
    await sql`UPDATE refunds SET status = ${refund.status === 'processed' ? 'processed' : 'pending'}, razorpay_refund_id = ${refund.id}, failure_reason = NULL WHERE id = ${row.id}`;
    return { id: refund.id, status: refund.status, adopted: false };
  } catch (err) {
    // Unknown outcome: mark failed. A retry re-checks Razorpay first, so a
    // refund that did go through is found and adopted, never repeated.
    await sql`UPDATE refunds SET status = 'failed', failure_reason = ${String(err.message || err).slice(0, 300)} WHERE id = ${row.id} AND status = 'creating'`;
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
async function refundAcrossPayments(sql, razorpay, { orderId, amountInr, kindBase }) {
  let remaining = Math.max(0, Math.round(Number(amountInr) || 0));
  if (!remaining) return { refundedInr: 0, shortfallInr: 0, firstRefundId: null };
  const o = (await sql`SELECT razorpay_payment_id FROM orders WHERE id = ${orderId}`)[0];
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
  const payments = [...extra.map(r => r.razorpay_payment_id).reverse(), o && o.razorpay_payment_id].filter(Boolean);
  let refundedInr = 0, firstRefundId = null;
  for (const pid of payments) {
    if (!remaining) break;
    const pay = await razorpay.payments.fetch(pid);
    const left = Math.floor((Number(pay.amount) - Number(pay.amount_refunded || 0)) / 100);
    const take = Math.min(left, remaining);
    if (take <= 0) continue;
    const refund = await safeRefund(sql, razorpay, { orderId, paymentId: pid, amountSubunit: take * 100, kind: `${kindBase}:${pid}` });
    if (!firstRefundId) firstRefundId = refund.id;
    refundedInr += take; remaining -= take;
  }
  return { refundedInr, shortfallInr: remaining, firstRefundId };
}
async function hasChangePayments(sql, orderId) {
  try {
    return (await sql`SELECT 1 FROM booking_changes bc JOIN orders x ON x.id = bc.order_id
                      WHERE x.razorpay_order_id = (SELECT razorpay_order_id FROM orders WHERE id = ${orderId})
                        AND bc.status = 'applied' AND bc.razorpay_payment_id IS NOT NULL LIMIT 1`).length > 0;
  }
  catch (e) { return false; }
}


module.exports = { safeRefund, pollRefunds, refundAcrossPayments, hasChangePayments };
