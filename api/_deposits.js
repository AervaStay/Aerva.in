// /api/_deposits.js — refund security deposits whose hold has ended. Not an endpoint.
//
// Runs on the scheduler (every 15 minutes) and from Admin's "Process
// Eligible Refunds". Each deposit is claimed ('held' → 'refunding') so two
// runs never both refund it; the refund itself goes through safeRefund
// (_refunds.js), which checks Razorpay first. A deposit whose refund has
// FAILED is skipped here: it waits in Admin → Refunds for a person to
// retry, so a failing refund is never retried automatically.

const { safeRefund } = require('./_refunds');
const { refundSubunitForInr } = require('./_currency');

async function releaseDueDeposits(sql, razorpay, { deadlineMs = 6000 } = {}) {
  const started = Date.now();
  const results = [];
  let eligible = [];
  try {
    eligible = await sql`
      SELECT o.id, o.razorpay_payment_id, o.razorpay_order_id, o.deposit_amount, o.charge_currency
      FROM orders o LEFT JOIN listings l ON l.id = o.listing_id
      -- Refunded only once the host's last day to report damage (the release
      -- date itself, on the property's own calendar) has fully passed.
      WHERE o.deposit_status = 'held' AND o.deposit_amount > 0
        AND o.deposit_release_at < (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date
        AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = o.id AND r.kind = 'deposit' AND r.status = 'failed')
      ORDER BY o.deposit_release_at LIMIT 50
    `;
  } catch (err) {
    // refunds table not there yet (before migration_refunds.sql): old rule.
    eligible = await sql`SELECT id, razorpay_payment_id, razorpay_order_id, deposit_amount, charge_currency FROM orders
                         WHERE deposit_status = 'held' AND deposit_release_at < (now() AT TIME ZONE 'Asia/Kolkata')::date AND deposit_amount > 0 LIMIT 50`;
  }
  for (const order of eligible) {
    if (Date.now() - started > deadlineMs) break;
    const claimed = await sql`UPDATE orders SET deposit_status = 'refunding' WHERE id = ${order.id} AND deposit_status = 'held' RETURNING id`;
    if (!claimed.length) { results.push({ orderId: order.id, success: false, error: 'Already being processed, or no longer held.' }); continue; }
    let refund;
    try {
      if (!order.razorpay_payment_id) throw new Error('No Razorpay payment is recorded for this booking, so the deposit cannot be refunded automatically.');
      const currency = order.charge_currency || 'INR';
      // A foreign-currency deposit: the same share of what was captured, never today's rate (_currency.js).
      const amount = currency === 'INR'
        ? Math.round(Number(order.deposit_amount) * 100)
        : await refundSubunitForInr(sql, { razorpayOrderId: order.razorpay_order_id, amountInr: Number(order.deposit_amount), currency });
      if (!amount) throw new Error(`No record of the amount charged in ${currency} for this booking — left 'held' for manual review.`);
      refund = await safeRefund(sql, razorpay, { orderId: order.id, paymentId: order.razorpay_payment_id, amountSubunit: amount, kind: 'deposit' });
    } catch (err) {
      await sql`UPDATE orders SET deposit_status = 'held' WHERE id = ${order.id} AND deposit_status = 'refunding'`;
      const msg = (err && err.error && err.error.description) ? 'Razorpay: ' + err.error.description : String((err && err.message) || err);
      results.push({ orderId: order.id, success: false, error: msg });
      continue;
    }
    try {
      await sql`UPDATE orders SET deposit_status = 'refunded', deposit_refund_id = ${refund.id} WHERE id = ${order.id}`;
      results.push({ orderId: order.id, success: true });
    } catch (saveErr) {
      // Locked as 'refunding' so nothing refunds it again; the refund is on record in refunds.
      results.push({ orderId: order.id, success: false, error: `Refund ${refund.id} was issued, but saving it failed. The booking is locked as 'refunding'.` });
    }
  }
  return { processed: results.length, refunded: results.filter(r => r.success).length, results };
}

module.exports = { releaseDueDeposits };
