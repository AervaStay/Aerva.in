// /api/_accounts-report.js — Admin → Accounts: one month in the shape the
// CA books it. Not an endpoint (get-pending-listings.js ?accountsReport=1).
//
// Aerva collects guests' money as the hosts' payment-collection agent, so
// only Aerva's own fees are income. Everything else is held for someone
// and sits in liability ledgers until paid:
//
//   Advance from guests      a booking's payment, from payment until check-in
//   Payable to hosts         the host's (and co-hosts') share, from check-in
//                            (or cancellation) until the payout is sent
//   Security deposits held   until refunded, or paid to the host
//   GST payable (s.9(5))     GST on stays, until deposited
//   TDS payable (194-O)      TDS deducted from payouts, until deposited
//   Commission income        Aerva's commission from hosts      ┐ P&L
//   Guest service fee income Aerva's fee from guests            ┘
//
// Recognition (income and the host's payable) happens at CHECK-IN for a
// booking that goes ahead, and on the CANCELLATION date for one that is
// cancelled (Aerva keeps its service fee; the host may keep part of the
// price). Dates are Indian time. Razorpay's own charges are not known to
// the site: take them from Razorpay's settlement report.
//
// Three parts:
//   bookings — every booking recognised in the month, with its split
//   cash     — money in and out of Aerva's accounts in the month
//   balances — the liabilities at the end of the month (deposits held is
//              today's figure: their history is not kept)
//
// Only money that really moved counts: a booking paid through Razorpay
// (real Razorpay order and payment ids: "order_"/"pay_" + 14 characters),
// a refund Razorpay has processed, and a payout sent on a real booking.
// Seed, test and dummy rows are left out everywhere (summary.leftOut).

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });

function monthBounds(month) {
  const m = String(month || '').match(/^(\d{4})-(\d{2})$/);
  if (!m || +m[2] < 1 || +m[2] > 12) throw userError('Choose a month, like 2026-10.');
  const y = +m[1], mo = +m[2];
  const start = `${m[1]}-${m[2]}-01`;
  const nextY = mo === 12 ? y + 1 : y, nextM = mo === 12 ? 1 : mo + 1;
  const end = `${nextY}-${String(nextM).padStart(2, '0')}-01`;          // exclusive
  return { start, end, label: `${m[1]}-${m[2]}` };
}

// Bookings recognised between two days (from inclusive, end exclusive;
// from '1970-01-01' for everything so far): check-in for bookings going
// ahead, the cancellation date (India time) for cancelled ones.
async function recognisedBookings(sql, from, end) {
  const orders = await sql`
    SELECT o.id, o.razorpay_order_id, to_jsonb(o)->>'confirmation_code' AS code, o.suite_name, o.status,
           o.arrival, o.departure, o.created_at, o.cancelled_at,
           COALESCE(o.order_type, 'stay') AS order_type,
           o.subtotal, o.gst, o.guest_service_fee, o.deposit_amount, o.total,
           COALESCE((to_jsonb(o)->>'coupon_discount')::numeric, 0) AS coupon_discount,
           COALESCE((to_jsonb(o)->>'fee_credit_used')::numeric, 0) AS credit_used,
           -- Cancelled with nothing kept for the host (a host cancelled, or all
           -- refunded): no commission and no host share, whatever the row still holds.
           CASE WHEN (o.status = 'paid' OR (to_jsonb(o)->>'payout_on_cancel')::boolean IS TRUE) THEN o.commission_amount ELSE 0 END AS commission_amount,
           CASE WHEN (o.status = 'paid' OR (to_jsonb(o)->>'payout_on_cancel')::boolean IS TRUE) THEN o.payout_amount ELSE 0 END AS payout_amount, to_jsonb(o)->>'refund_percent' AS refund_percent,
           COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(o)->>'guest_first_name', to_jsonb(o)->>'guest_last_name')), ''), g.name, o.guest_email) AS guest_name,
           h.id AS host_id, h.name AS host_name,
           (SELECT COALESCE(sum(amount), 0) FROM refunds r WHERE r.order_id = o.id AND r.status = 'processed' AND r.kind NOT LIKE 'deposit%' AND r.kind NOT LIKE '%fee-credit-%' AND r.razorpay_refund_id ~ '^rfnd_[A-Za-z0-9]{14}$') AS refunded_paise,
           CASE WHEN (o.status = 'paid' OR (to_jsonb(o)->>'payout_on_cancel')::boolean IS TRUE) THEN (SELECT COALESCE(sum(amount), 0) FROM order_cohost_shares s WHERE s.order_id = o.id) ELSE 0 END AS cohost_shares
    FROM orders o
    LEFT JOIN guests g ON g.id = o.guest_id
    LEFT JOIN listings l ON l.id = o.listing_id
    LEFT JOIN hosts h ON h.id = l.host_id
    WHERE o.status IN ('paid', 'cancelled') AND (o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.razorpay_order_id ~ '^order_[A-Za-z0-9]{14}$')
      AND (
        (o.status = 'paid' AND o.arrival >= ${from}::date AND o.arrival < ${end}::date)
        OR (o.status = 'cancelled' AND o.cancelled_at IS NOT NULL
            AND (o.cancelled_at AT TIME ZONE 'Asia/Kolkata') >= ${from}::timestamp AND (o.cancelled_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp)
      )
    ORDER BY 1`;
  // Moved to Aerva credit (_fee-credits.js): a host cancelled (the service
  // fee), or the stay was shortened (the nights not stayed). That money
  // leaves the booking for the guest's credit — a liability of its own
  // (Aerva credits, below), whatever later happens to the credit.
  const held = {};
  if (orders.length) {
    try {
      (await sql`SELECT source_order_id AS id, sum(amount) AS v FROM fee_credits
                 WHERE source_order_id = ANY(${orders.map(o => o.id)}) GROUP BY source_order_id`)
        .forEach(r => { held[r.id] = Number(r.v) || 0; });
    } catch (e) { /* database update not applied yet */ }
  }
  // Where the credit a booking used came from: the bookings and Razorpay
  // payments that first paid it.
  const creditFrom = {};
  if (orders.some(o => Number(o.credit_used) > 0)) {
    try {
      (await sql`SELECT u.order_id AS id, string_agg(DISTINCT COALESCE(to_jsonb(src)->>'confirmation_code', src.razorpay_order_id, '#' || src.id) || ' (' || COALESCE(f.razorpay_payment_id, '') || ')', '; ') AS v
                 FROM fee_credit_uses u JOIN fee_credits f ON f.id = u.credit_id LEFT JOIN orders src ON src.id = f.source_order_id
                 WHERE u.order_id = ANY(${orders.map(o => o.id)}) GROUP BY u.order_id`)
        .forEach(r => { creditFrom[r.id] = r.v || ''; });
    } catch (e) { /* database update not applied yet */ }
  }
  // Paid with Aerva credit and not given back on a refund (_fee-credits.js).
  const back = {};
  if (orders.some(o => Number(o.credit_used) > 0)) {
    try {
      (await sql`SELECT order_id AS id, sum(COALESCE(restored_amount, 0)) AS v FROM fee_credit_uses WHERE order_id = ANY(${orders.map(o => o.id)}) GROUP BY order_id`)
        .forEach(r => { back[r.id] = Number(r.v) || 0; });
    } catch (e) { /* database update not applied yet */ }
  }
  orders.forEach(o => { o.fee_credit_held = held[o.id] || 0; o.credit_from = creditFrom[o.id] || ''; o.paid_by_credit = Math.max(0, Number(o.credit_used) - (back[o.id] || 0)); });
  return orders.map(o => {
    const subtotal = r2(o.subtotal), gst = r2(o.gst), fee = r2(o.guest_service_fee), deposit = r2(o.deposit_amount);
    const commission = r2(o.commission_amount), hostPayable = r2(o.payout_amount);
    // GST stays payable on the part of the price the host keeps (the rest was refunded with it).
    const kept = r2(commission + hostPayable);
    // GST is refunded at the cancellation's refund percentage; without one
    // (a host cancelling refunds everything), in proportion to what is kept.
    const pct = o.refund_percent != null && o.refund_percent !== '' ? Math.max(0, Math.min(100, Number(o.refund_percent))) : null;
    const gstPayable = o.status === 'paid' ? gst
      : (pct != null ? r2(gst * (1 - pct / 100)) : (subtotal > 0 ? r2(gst * Math.min(1, kept / subtotal)) : 0));
    const refunded = r2(Number(o.refunded_paise) / 100);
    // Charged in money: the coupon and any Aerva credit are not money.
    const charged = r2(Number(o.total) - Number(o.coupon_discount || 0) - Number(o.credit_used || 0));
    // Paid with Aerva credit (and kept): money the guest had already paid
    // Aerva on an earlier booking, held as credit until now.
    const paidByCredit = r2(o.paid_by_credit);
    // What stayed with Aerva after refunds (deposit aside), split in order:
    // GST, the host's share, Aerva's commission, then Aerva's service fee.
    // On a cancellation the service fee is income only as far as it was
    // actually kept: a host's cancellation or an admin exception returns it.
    const keptAll = r2(charged - deposit - refunded + paidByCredit);
    // Moved to the guest's Aerva credit: not income of this booking.
    const feeCreditHeld = r2(o.fee_credit_held);
    const feeIncome = o.status === 'paid' ? fee : r2(Math.max(0, Math.min(fee, keptAll - commission - hostPayable - gstPayable - feeCreditHeld)));
    const recognisedOn = o.status === 'cancelled' && o.cancelled_at
      ? new Date(new Date(o.cancelled_at).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10)
      : isoDay(o.arrival);
    return {
      bookingId: o.id, reference: o.code || o.razorpay_order_id || ('#' + o.id), event: o.status === 'cancelled' ? 'Cancelled' : 'Check-in',
      recognisedOn, guest: o.guest_name || '', listing: o.suite_name || '', host: o.host_name || '', hostId: o.host_id,
      type: o.order_type, arrival: isoDay(o.arrival), departure: isoDay(o.departure), paidOn: isoDay(o.created_at, true),
      bookingPrice: subtotal, paidByCoupon: r2(o.coupon_discount), paidByCredit, creditFrom: o.credit_from, gstOnStay: gst, serviceFee: fee, deposit,
      charged,
      refundedToGuest: refunded,
      commissionIncome: commission, serviceFeeIncome: feeIncome,
      hostPayable, cohostShares: r2(o.cohost_shares), gstPayable,
      // Should be 0: what the guest paid (deposit aside), less refunds, less
      // every ledger it went to. Anything else is for the CA to look at
      // (e.g. Aerva refunding its own fee as an exception, or a coupon).
      feeCreditHeld,
      difference: r2(keptAll - feeIncome - commission - hostPayable - gstPayable - feeCreditHeld)
    };
  });
}

async function accountsReport(sql, month) {
  const { start, end, label } = monthBounds(month);
  const bookings = await recognisedBookings(sql, start, end);
  const sum = (list, k) => r2(list.reduce((t, x) => t + (Number(x[k]) || 0), 0));

  // ---- Cash in and out in the month ----
  const receipts = await sql`
    SELECT o.id, to_jsonb(o)->>'confirmation_code' AS code, o.razorpay_order_id, o.razorpay_payment_id, o.created_at, o.total,
           COALESCE((to_jsonb(o)->>'coupon_discount')::numeric, 0) AS coupon_discount,
           COALESCE((to_jsonb(o)->>'fee_credit_used')::numeric, 0) AS credit_used, o.deposit_amount, o.gst, o.guest_service_fee
    FROM orders o
    WHERE o.status IN ('paid', 'cancelled') AND (o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.razorpay_order_id ~ '^order_[A-Za-z0-9]{14}$')
      AND (o.created_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (o.created_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp
    ORDER BY o.created_at`;
  // For receipts paid partly with Aerva credit: the bookings and Razorpay
  // payments the credit first came from.
  const receiptCreditFrom = {};
  if (receipts.some(o => Number(o.credit_used) > 0)) {
    try {
      (await sql`SELECT u.order_id AS id, string_agg(DISTINCT COALESCE(to_jsonb(src)->>'confirmation_code', src.razorpay_order_id, '#' || src.id) || ' (' || COALESCE(f.razorpay_payment_id, '') || ')', '; ') AS v
                 FROM fee_credit_uses u JOIN fee_credits f ON f.id = u.credit_id LEFT JOIN orders src ON src.id = f.source_order_id
                 WHERE u.order_id = ANY(${receipts.map(o => o.id)}) GROUP BY u.order_id`).forEach(r => { receiptCreditFrom[r.id] = r.v || ''; });
    } catch (e) { /* database update not applied yet */ }
  }
  // The Aerva credit ledger for the month (fee_credit_entries): every
  // credit made, used, given back or refunded, with the booking and the
  // Razorpay payment or refund behind it.
  let credits = [];
  try {
    credits = (await sql`
      SELECT e.id, e.created_at, e.kind, e.amount, e.reference, e.note, e.credit_id, f.guest_email, COALESCE(to_jsonb(f)->>'reason', 'host_cancelled') AS reason,
             COALESCE(to_jsonb(o)->>'confirmation_code', o.razorpay_order_id, CASE WHEN o.id IS NULL THEN '' ELSE '#' || o.id END) AS booking,
             COALESCE(to_jsonb(src)->>'confirmation_code', src.razorpay_order_id, '#' || src.id) AS source_booking, f.razorpay_payment_id AS source_payment
      FROM fee_credit_entries e JOIN fee_credits f ON f.id = e.credit_id
      LEFT JOIN orders o ON o.id = e.order_id LEFT JOIN orders src ON src.id = f.source_order_id
      WHERE (e.created_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (e.created_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp
      ORDER BY e.created_at, e.id`).map(e => ({
        date: isoDay(e.created_at, true), credit: 'C-' + e.credit_id, guest: e.guest_email || '',
        movement: { issued: 'Credit made', used: 'Used on a booking', given_back: 'Given back to the credit', refunded: 'Refunded to the guest' }[e.kind] || e.kind,
        why: e.kind === 'issued' ? (e.reason === 'stay_shortened' ? 'Stay shortened' : 'Host cancelled') : (e.note || ''),
        booking: e.booking || '', reference: e.reference || '',
        creditIn: e.kind === 'issued' || e.kind === 'given_back' ? Number(e.amount) : 0,
        creditOut: e.kind === 'used' || e.kind === 'refunded' ? Number(e.amount) : 0,
        originallyPaidBy: (e.source_booking || '') + (e.source_payment ? ' (' + e.source_payment + ')' : ''),
        ledger: e.kind === 'issued' ? 'Advance from guests → Aerva credits' : e.kind === 'used' ? 'Aerva credits → Advance from guests' : e.kind === 'given_back' ? 'Advance from guests → Aerva credits' : 'Aerva credits → Razorpay (refund)'
      }));
  } catch (e) { credits = []; }
  let changeReceipts = [];
  try {
    changeReceipts = await sql`
      SELECT c.order_id AS id, c.applied_at AS created_at, c.difference AS amount, c.razorpay_payment_id FROM booking_changes c
      WHERE c.status = 'applied' AND c.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND c.difference > 0
        AND (c.applied_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (c.applied_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp`;
  } catch (e) { changeReceipts = []; }
  const refunds = await sql`
    SELECT r.order_id, r.kind, r.amount, r.status, r.created_at, r.razorpay_refund_id
    FROM refunds r
    WHERE r.status = 'processed' AND r.razorpay_refund_id ~ '^rfnd_[A-Za-z0-9]{14}$'
      AND (r.created_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (r.created_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp
    ORDER BY r.created_at`;
  const payouts = await sql`
    SELECT p.id, p.order_id, p.payee_type, COALESCE(p.kind, 'booking') AS kind, p.gross, p.commission, p.cohost_shares, p.deductions, p.tds, p.net, p.sent_at, p.reference, to_jsonb(p)->>'razorpayx_payout_id' AS pout_id,
           CASE WHEN p.payee_type = 'host' THEN h.name ELSE g.name END AS payee
    FROM payouts p LEFT JOIN hosts h ON h.id = p.host_id LEFT JOIN guests g ON g.id = p.payee_guest_id
    WHERE p.status = 'sent' AND p.sent_at IS NOT NULL AND p.net > 0
      AND EXISTS (SELECT 1 FROM orders o WHERE o.id = p.order_id AND (o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.razorpay_order_id ~ '^order_[A-Za-z0-9]{14}$'))
      AND (p.sent_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (p.sent_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp
    ORDER BY p.sent_at`;
  // Razorpay's charges on each payment and payout (fee incl. GST, and the GST).
  const feeOf = await razorpayFees(sql, [
    ...receipts.map(o => ({ ref: o.razorpay_payment_id, kind: 'payment', orderId: o.id })),
    ...changeReceipts.map(c => ({ ref: c.razorpay_payment_id, kind: 'payment', orderId: c.id })),
    ...payouts.filter(p => /^pout_/.test(p.pout_id || '')).map(p => ({ ref: p.pout_id, kind: 'payout', orderId: p.order_id }))
  ]);
  const feeCols = (ref) => { const f = feeOf.map[ref]; return f ? { razorpayFee: r2(f.fee / 100), razorpayFeeGst: r2(f.tax / 100) } : { razorpayFee: '', razorpayFeeGst: '' }; };
  const cash = [];
  receipts.forEach(o => cash.push({ ...feeCols(o.razorpay_payment_id), date: isoDay(o.created_at, true), type: 'Receipt from guest', bookingId: o.id, reference: o.code || o.razorpay_order_id,
    // Received through Razorpay: the coupon and any Aerva credit are not money.
    amountIn: r2(Number(o.total) - Number(o.coupon_discount || 0) - Number(o.credit_used || 0)), amountOut: 0,
    ...(Number(o.credit_used) > 0 ? { paidWithCredit: r2(o.credit_used), creditFrom: receiptCreditFrom[o.id] || '' } : {}),
    payment: o.razorpay_payment_id || '',
    ledger: 'Advance from guests' + (Number(o.deposit_amount) > 0 ? ' / Security deposits held' : '') + (Number(o.credit_used) > 0 ? ' (credit part: from Aerva credits)' : '') }));
  changeReceipts.forEach(c => cash.push({ ...feeCols(c.razorpay_payment_id), date: isoDay(c.created_at, true), type: 'Receipt: booking change', bookingId: c.id, reference: '', amountIn: r2(c.amount), amountOut: 0, ledger: 'Advance from guests' }));
  refunds.forEach(r => {
    const k = String(r.kind || '');
    const isCredit = /fee-credit-/.test(k);
    const ledger = k.startsWith('deposit') ? 'Security deposits held' : isCredit ? 'Aerva credits (guests)' : 'Advance from guests / Payable to hosts';
    cash.push({ date: isoDay(r.created_at, true), type: isCredit ? 'Refund of Aerva credit' : 'Refund to guest (' + k.split(':')[0] + ')', bookingId: r.order_id, reference: r.razorpay_refund_id || '', amountIn: 0, amountOut: r2(Number(r.amount) / 100), ledger });
  });
  payouts.forEach(p => {
    cash.push({ ...feeCols(p.pout_id), date: isoDay(p.sent_at, true), type: p.kind === 'deposit' ? 'Payout: deposit compensation' : (p.payee_type === 'cohost' ? 'Payout to co-host' : 'Payout to host'),
      bookingId: p.order_id, reference: p.reference || '', payee: p.payee || '', amountIn: 0, amountOut: r2(p.net),
      tds: r2(p.tds), couponRecovered: r2(p.deductions),
      ledger: p.kind === 'deposit' ? 'Security deposits held (TDS → TDS payable)' : 'Payable to hosts (TDS → TDS payable)' });
  });
  cash.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // ---- Liabilities at the end of the month ----
  // Advance from guests: paid before month end, check-in after it, not cancelled by then.
  const adv = (await sql`
    SELECT COALESCE(sum(o.total - COALESCE((to_jsonb(o)->>'coupon_discount')::numeric, 0) - COALESCE(o.deposit_amount, 0)), 0) AS v
    FROM orders o
    WHERE (o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.razorpay_order_id ~ '^order_[A-Za-z0-9]{14}$') AND o.status IN ('paid', 'cancelled')
      AND (o.created_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp AND o.arrival >= ${end}::date
      AND (o.status = 'paid' OR (o.cancelled_at AT TIME ZONE 'Asia/Kolkata') >= ${end}::timestamp)`)[0].v;
  // Payable to hosts: shares recognised by month end, less what was paid out by then.
  // payout_amount is the hosts' side in full; co-hosts' part of it is in
  // order_cohost_shares, so the two are split here.
  const recognised = (await sql`
    SELECT COALESCE(sum(CASE WHEN (o.status = 'paid' OR (to_jsonb(o)->>'payout_on_cancel')::boolean IS TRUE) THEN o.payout_amount ELSE 0 END), 0) AS v,
           COALESCE(sum(CASE WHEN (o.status = 'paid' OR (to_jsonb(o)->>'payout_on_cancel')::boolean IS TRUE) THEN (SELECT COALESCE(sum(s.amount), 0) FROM order_cohost_shares s WHERE s.order_id = o.id) ELSE 0 END), 0) AS co
    FROM orders o
    WHERE (o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.razorpay_order_id ~ '^order_[A-Za-z0-9]{14}$') AND (
      (o.status = 'paid' AND o.arrival < ${end}::date)
      OR (o.status = 'cancelled' AND (o.cancelled_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp))`)[0];
  const recognisedCo = Number(recognised.co) || 0, recognisedHost = (Number(recognised.v) || 0) - recognisedCo;
  const paid = (await sql`
    SELECT COALESCE(sum(p.gross - p.commission - p.cohost_shares) FILTER (WHERE p.payee_type = 'host'), 0) AS host,
           COALESCE(sum(p.gross) FILTER (WHERE p.payee_type <> 'host'), 0) AS co
    FROM payouts p WHERE p.status = 'sent' AND COALESCE(p.kind, 'booking') <> 'deposit'
      AND EXISTS (SELECT 1 FROM orders o WHERE o.id = p.order_id AND (o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.razorpay_order_id ~ '^order_[A-Za-z0-9]{14}$'))
      AND (p.sent_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp`)[0];
  const payableHost = r2(Math.max(0, recognisedHost - Number(paid.host))), payableCo = r2(Math.max(0, recognisedCo - Number(paid.co)));
  let depositsHeld = 0;
  try { depositsHeld = (await sql`SELECT COALESCE(sum(deposit_amount), 0) AS v FROM orders o WHERE deposit_status IN ('held', 'disputed') AND (o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.razorpay_order_id ~ '^order_[A-Za-z0-9]{14}$')`)[0].v; } catch (e) { depositsHeld = 0; }

  // Test or dummy bookings left out (no real Razorpay payment behind them)
  // that would otherwise have shown in this month.
  let leftOut = 0;
  try {
    leftOut = Number((await sql`
      SELECT count(*) AS n FROM orders o
      WHERE o.status IN ('paid', 'cancelled') AND NOT COALESCE((o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.razorpay_order_id ~ '^order_[A-Za-z0-9]{14}$'), false)
        AND ((o.status = 'paid' AND o.arrival >= ${start}::date AND o.arrival < ${end}::date)
          OR (o.status = 'cancelled' AND (o.cancelled_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (o.cancelled_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp)
          OR ((o.created_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (o.created_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp))`)[0].n) || 0;
  } catch (e) { leftOut = 0; }
  const tdsDeducted = r2(payouts.reduce((t, p) => t + Number(p.tds || 0), 0));
  const summary = {
    month: label,
    income: { commission: sum(bookings, 'commissionIncome'), serviceFee: sum(bookings, 'serviceFeeIncome') },
    gstOnStaysPayable: sum(bookings, 'gstPayable'),
    tdsDeducted,
    leftOut,
    razorpay: {
      charges: r2(cash.reduce((t, c) => t + (Number(c.razorpayFee) || 0) - (Number(c.razorpayFeeGst) || 0), 0)),   // expense, before GST
      gst: r2(cash.reduce((t, c) => t + (Number(c.razorpayFeeGst) || 0), 0)),                                       // input tax credit
      total: r2(cash.reduce((t, c) => t + (Number(c.razorpayFee) || 0), 0)),
      notYetKnown: feeOf.unknown
    },
    bookingsToCheck: bookings.filter(b => Math.abs(b.difference) >= 1).length,
    received: r2(cash.reduce((t, c) => t + c.amountIn, 0)),
    refunded: r2(cash.filter(c => /^Refund/.test(c.type)).reduce((t, c) => t + c.amountOut, 0)),
    paidOut: r2(cash.filter(c => /^Payout/.test(c.type)).reduce((t, c) => t + c.amountOut, 0)),
    paidOutHosts: r2(cash.filter(c => /^Payout/.test(c.type) && c.type !== 'Payout to co-host').reduce((t, c) => t + c.amountOut, 0)),
    paidOutCohosts: r2(cash.filter(c => c.type === 'Payout to co-host').reduce((t, c) => t + c.amountOut, 0)),
    tdsHosts: r2(payouts.filter(p => p.payee_type === 'host').reduce((t, p) => t + Number(p.tds || 0), 0)),
    tdsCohosts: r2(payouts.filter(p => p.payee_type !== 'host').reduce((t, p) => t + Number(p.tds || 0), 0)),
    balances: {
      advanceFromGuests: r2(adv),
      payableToHosts: r2(payableHost + payableCo),     // hosts and co-hosts together
      payableHostsOnly: payableHost,
      payableCohosts: payableCo,
      depositsHeldToday: r2(depositsHeld),
      gstPayable: sum(bookings, 'gstPayable'),
      tdsPayable: tdsDeducted
    },
    notes: [
      'When a host cancels, Aerva’s service fee is held as the guest’s credit: it is not income while open; used on a new booking it becomes income, refunded it does not.',
      'Only real money is counted: payments made through Razorpay, refunds Razorpay has processed and payouts actually sent. Test or dummy bookings are left out.',
      'Income is Aerva’s commission and guest service fee only. Booking amounts are held for hosts (Aerva is their payment-collection agent).',
      'Recognised at check-in, or on the cancellation date for cancelled bookings. Dates are India time.',
      'GST payable is the GST on stays recognised this month (s.9(5)). GST on Aerva’s own fees is not included here — confirm with your CA.',
      'TDS payable is the TDS deducted from payouts sent this month: deposit by the 7th of next month.',
      'Razorpay’s charges are taken from Razorpay for each payment and payout (Aerva pays them). The charge before GST is an expense; the GST on it can be claimed as input tax credit. Razorpay deducts them from its settlements, so the bank receives the payments less these charges.',
      'Security deposits held is today’s figure.'
    ]
  };
  summary.income.total = r2(summary.income.commission + summary.income.serviceFee);
  summary.income.afterRazorpay = r2(summary.income.total - summary.razorpay.charges);
  if (feeOf.unknown) summary.notes.unshift(`Razorpay’s charges are not known yet for ${feeOf.unknown} transaction${feeOf.unknown === 1 ? '' : 's'}${feeOf.setupNeeded ? ' — apply the database update “razorpay-fees” in Admin → Database updates' : ' — open this month again in a little while'}.`);
  summary.statement = await buildStatement(sql, { start, end, label, bookings, cash, payouts, receipts0: receipts, summary, credits });
  return { month: label, summary, bookings, cash, credits };
}

// ---------------------------------------------------------------------------
// The statement: the month as the CA posts it in Tally, ledger by ledger.
// Each liability or receivable is shown as opening + in − out = closing, so
// the closing figures carry straight into next month's opening.
// ---------------------------------------------------------------------------
// Balances at the START of a day (India time): everything before it.
async function balancesAt(sql, day) {
  const one = async (q) => { try { return (await q)[0] || {}; } catch (e) { return { failed: true }; } };
  const ord = await one(sql`
    SELECT COALESCE(sum(o.total - COALESCE((to_jsonb(o)->>'coupon_discount')::numeric, 0) - COALESCE((to_jsonb(o)->>'fee_credit_used')::numeric, 0)), 0) AS received,
           COALESCE(sum(COALESCE(o.deposit_amount, 0)), 0) AS deposits
    FROM orders o
    WHERE o.status IN ('paid', 'cancelled') AND o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.razorpay_order_id ~ '^order_[A-Za-z0-9]{14}$'
      AND (o.created_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp`);
  const chg = await one(sql`
    SELECT COALESCE(sum(c.difference), 0) AS received FROM booking_changes c
    WHERE c.status = 'applied' AND c.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND c.difference > 0
      AND (c.applied_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp`);
  const ref = await one(sql`
    SELECT COALESCE(sum(r.amount) FILTER (WHERE r.kind LIKE 'deposit%'), 0) / 100.0 AS deposit,
           COALESCE(sum(r.amount) FILTER (WHERE r.kind NOT LIKE 'deposit%'), 0) / 100.0 AS other
    FROM refunds r
    WHERE r.status = 'processed' AND r.razorpay_refund_id ~ '^rfnd_[A-Za-z0-9]{14}$'
      AND (r.created_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp`);
  const fees = await one(sql`
    SELECT COALESCE(sum(f.fee_paise), 0) / 100.0 AS fee FROM razorpay_fees f
    WHERE f.kind = 'payment' AND (
      EXISTS (SELECT 1 FROM orders o WHERE o.razorpay_payment_id = f.ref_id AND (o.created_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp)
      OR EXISTS (SELECT 1 FROM booking_changes c WHERE c.razorpay_payment_id = f.ref_id AND (c.applied_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp))`);
  const setl = await one(sql`
    SELECT COALESCE(sum(amount_paise), 0) / 100.0 AS settled FROM razorpay_settlements
    WHERE (settled_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp`);
  const rec = await one(sql`
    SELECT COALESCE(sum(CASE WHEN (o.status = 'paid' OR (to_jsonb(o)->>'payout_on_cancel')::boolean IS TRUE) THEN o.payout_amount ELSE 0 END), 0) AS hostside,
           COALESCE(sum(CASE WHEN (o.status = 'paid' OR (to_jsonb(o)->>'payout_on_cancel')::boolean IS TRUE) THEN (SELECT COALESCE(sum(s.amount), 0) FROM order_cohost_shares s WHERE s.order_id = o.id) ELSE 0 END), 0) AS co
    FROM orders o
    WHERE o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.razorpay_order_id ~ '^order_[A-Za-z0-9]{14}$' AND (
      (o.status = 'paid' AND o.arrival < ${day}::date)
      OR (o.status = 'cancelled' AND (o.cancelled_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp))`);
  const paid = await one(sql`
    SELECT COALESCE(sum(p.gross - p.commission - p.cohost_shares) FILTER (WHERE p.payee_type = 'host' AND COALESCE(p.kind, 'booking') <> 'deposit'), 0) AS host,
           COALESCE(sum(p.gross) FILTER (WHERE p.payee_type <> 'host' AND COALESCE(p.kind, 'booking') <> 'deposit'), 0) AS co,
           COALESCE(sum(p.gross) FILTER (WHERE p.kind = 'deposit'), 0) AS deposit
    FROM payouts p
    WHERE p.status = 'sent' AND EXISTS (SELECT 1 FROM orders o WHERE o.id = p.order_id AND o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.razorpay_order_id ~ '^order_[A-Za-z0-9]{14}$')
      AND (p.sent_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp`);
  const adv = await one(sql`
    SELECT COALESCE(sum(o.total - COALESCE((to_jsonb(o)->>'coupon_discount')::numeric, 0) - COALESCE(o.deposit_amount, 0)
             - (SELECT COALESCE(sum(r.amount), 0) / 100.0 FROM refunds r WHERE r.order_id = o.id AND r.status = 'processed' AND r.kind NOT LIKE 'deposit%'
                  AND r.razorpay_refund_id ~ '^rfnd_[A-Za-z0-9]{14}$' AND (r.created_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp)), 0) AS v
    FROM orders o
    WHERE o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.razorpay_order_id ~ '^order_[A-Za-z0-9]{14}$' AND o.status IN ('paid', 'cancelled')
      AND (o.created_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp AND o.arrival >= ${day}::date
      AND (o.status = 'paid' OR (o.cancelled_at AT TIME ZONE 'Asia/Kolkata') >= ${day}::timestamp)`);
  const feesCum = await one(sql`
    SELECT COALESCE(sum(f.fee_paise), 0) / 100.0 AS fee, COALESCE(sum(f.tax_paise), 0) / 100.0 AS tax FROM razorpay_fees f
    WHERE (f.kind = 'payment' AND (
             EXISTS (SELECT 1 FROM orders o WHERE o.razorpay_payment_id = f.ref_id AND (o.created_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp)
             OR EXISTS (SELECT 1 FROM booking_changes c WHERE c.razorpay_payment_id = f.ref_id AND (c.applied_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp)))
       OR (f.kind = 'payout' AND EXISTS (SELECT 1 FROM payouts p WHERE to_jsonb(p)->>'razorpayx_payout_id' = f.ref_id AND p.status = 'sent' AND (p.sent_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp))`);
  const poutCum = await one(sql`
    SELECT COALESCE(sum(p.net), 0) AS net, COALESCE(sum(p.tds), 0) AS tds FROM payouts p
    WHERE p.status = 'sent' AND EXISTS (SELECT 1 FROM orders o WHERE o.id = p.order_id AND o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.razorpay_order_id ~ '^order_[A-Za-z0-9]{14}$')
      AND (p.sent_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp`);
  const poutFees = await one(sql`
    SELECT COALESCE(sum(f.fee_paise), 0) / 100.0 AS fee FROM razorpay_fees f
    WHERE f.kind = 'payout' AND EXISTS (SELECT 1 FROM payouts p WHERE to_jsonb(p)->>'razorpayx_payout_id' = f.ref_id AND p.status = 'sent' AND (p.sent_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp)`);
  // Aerva credits held: every credit movement before the day (the ledger,
  // fee_credit_entries); without it, today's balance.
  let credits = null;
  try {
    credits = Number((await sql`SELECT COALESCE(sum(CASE WHEN kind IN ('issued', 'given_back') THEN amount ELSE -amount END), 0) AS v FROM fee_credit_entries
                               WHERE (created_at AT TIME ZONE 'Asia/Kolkata') < ${day}::timestamp`)[0].v) || 0;
  } catch (e) {
    try { credits = Number((await sql`SELECT COALESCE(sum(remaining), 0) AS v FROM fee_credits WHERE status IN ('active', 'refunding')`)[0].v) || 0; } catch (e2) { credits = 0; }
  }
  const co = Number(rec.co) || 0;
  return {
    credits: r2(credits),
    cum: {
      settled: r2(setl.settled), payoutsNet: r2(poutCum.net), tds: r2(poutCum.tds), payoutFees: r2(poutFees.fee),
      fees: r2(feesCum.fee), feesGst: r2(feesCum.tax)
    },
    receivable: r2((Number(ord.received) || 0) + (Number(chg.received) || 0) - (Number(ref.deposit) || 0) - (Number(ref.other) || 0) - (Number(fees.fee) || 0) - (Number(setl.settled) || 0)),
    settlementsKnown: !setl.failed,
    advance: r2(adv.v),
    host: r2((Number(rec.hostside) || 0) - co - (Number(paid.host) || 0)),
    cohost: r2(co - (Number(paid.co) || 0)),
    deposits: r2((Number(ord.deposits) || 0) - (Number(ref.deposit) || 0) - (Number(paid.deposit) || 0))
  };
}

// Razorpay settlements (money Razorpay moved to Aerva's bank), kept in
// razorpay_settlements. New ones are fetched from Razorpay each time.
async function syncSettlements(sql) {
  const keyId = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
  let last;
  try { last = (await sql`SELECT max(settled_at) AS t FROM razorpay_settlements`)[0].t; } catch (e) { return { ok: false, setupNeeded: true }; }
  if (!keyId || !secret) return { ok: false };
  const auth = 'Basic ' + Buffer.from(`${keyId}:${secret}`).toString('base64');
  const from = last ? Math.floor(new Date(last).getTime() / 1000) - 86400 : Math.floor(Date.UTC(2026, 0, 1) / 1000);
  const started = Date.now();
  try {
    for (let skip = 0; skip < 1000 && Date.now() - started < 5000; skip += 100) {
      const res = await fetch(`https://api.razorpay.com/v1/settlements?from=${from}&count=100&skip=${skip}`, { headers: { Authorization: auth } });
      if (!res.ok) return { ok: false };
      const d = await res.json();
      const items = (d && d.items) || [];
      for (const st of items) {
        if (st.status !== 'processed') continue;
        await sql`INSERT INTO razorpay_settlements (id, amount_paise, fees_paise, tax_paise, utr, settled_at)
                  VALUES (${st.id}, ${Math.round(Number(st.amount) || 0)}, ${Math.round(Number(st.fees) || 0)}, ${Math.round(Number(st.tax) || 0)}, ${st.utr || null}, to_timestamp(${Number(st.created_at) || 0}))
                  ON CONFLICT (id) DO NOTHING`;
      }
      if (items.length < 100) break;
    }
    return { ok: true };
  } catch (e) { return { ok: false }; }
}

async function buildStatement(sql, { start, end, label, bookings, cash, payouts, receipts0, summary, credits = [] }) {
  const sum = (list, f) => r2(list.reduce((t, x) => t + (Number(f(x)) || 0), 0));
  // Razorpay's fee on earlier payments too (for the opening receivable).
  try {
    const older = await sql`
      SELECT o.id, o.razorpay_payment_id AS ref FROM orders o
      WHERE o.status IN ('paid', 'cancelled') AND o.razorpay_payment_id ~ '^pay_[A-Za-z0-9]{14}$' AND o.razorpay_order_id ~ '^order_[A-Za-z0-9]{14}$'
        AND (o.created_at AT TIME ZONE 'Asia/Kolkata') < ${start}::timestamp
        AND NOT EXISTS (SELECT 1 FROM razorpay_fees f WHERE f.ref_id = o.razorpay_payment_id)
      ORDER BY o.created_at DESC LIMIT 40`;
    if (older.length) await razorpayFees(sql, older.map(o => ({ ref: o.ref, kind: 'payment', orderId: o.id })));
  } catch (e) { /* table not created yet */ }
  const sync = await syncSettlements(sql);
  const [open, close] = [await balancesAt(sql, start), await balancesAt(sql, end)];
  let settledIn = 0;
  try { settledIn = r2(Number((await sql`SELECT COALESCE(sum(amount_paise), 0) / 100.0 AS v FROM razorpay_settlements
      WHERE (settled_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (settled_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp`)[0].v)); } catch (e) { settledIn = 0; }

  const receipts = cash.filter(c => /^Receipt/.test(c.type));
  const receivedAll = sum(receipts, c => c.amountIn);
  const isDepRefund = (c) => /^Refund/.test(c.type) && /deposit/i.test(c.type);
  const refundsDeposit = sum(cash.filter(isDepRefund), c => c.amountOut);
  const isCreditRefund = (c) => c.type === 'Refund of Aerva credit';
  const refundsCredit = sum(cash.filter(isCreditRefund), c => c.amountOut);
  const refundsBooking = sum(cash.filter(c => /^Refund/.test(c.type) && !isDepRefund(c) && !isCreditRefund(c)), c => c.amountOut);
  const payFees = sum(receipts, c => c.razorpayFee), payFeesGst = sum(receipts, c => c.razorpayFeeGst);
  const pouts = cash.filter(c => /^Payout/.test(c.type));
  const poutFees = sum(pouts, c => c.razorpayFee), poutFeesGst = sum(pouts, c => c.razorpayFeeGst);

  const depReceived = sum(receipts0, o => o.deposit_amount);
  const depPaidHost = sum(payouts.filter(p => p.kind === 'deposit'), p => p.gross);

  const hostP = payouts.filter(p => p.payee_type === 'host' && p.kind !== 'deposit');
  const coP = payouts.filter(p => p.payee_type !== 'host' && p.kind !== 'deposit');
  const earnedHost = sum(bookings, b => b.hostPayable - b.cohostShares), earnedCo = sum(bookings, b => b.cohostShares);

  const income = summary.income;
  const gstOut = summary.gstOnStaysPayable;
  const tdsHost = sum(payouts.filter(p => p.payee_type === 'host'), p => p.tds), tdsCo = sum(payouts.filter(p => p.payee_type !== 'host'), p => p.tds);
  const transferred = sum(bookings, b => b.serviceFeeIncome + b.commissionIncome + b.hostPayable + b.gstPayable + (b.feeCreditHeld || 0));
  const bookingDiff = sum(bookings, b => b.difference);
  const advIn = r2(receivedAll - depReceived);
  // Bookings made this month and paid partly with Aerva credit: that part is an advance too.
  // Aerva credits this month (the credit ledger; without it, the bookings).
  const cr = (k) => sum(credits.filter(e => e.movement === k), e => e.creditIn + e.creditOut);
  const creditIn = credits.length ? cr('Used on a booking') : sum(receipts0, o => o.credit_used);
  const creditBack = cr('Given back to the credit');
  const creditMade = cr('Credit made'), creditRefunded = cr('Refunded to the guest');

  const L = (k, v, g, m, o = {}) => Object.assign({ k, v: r2(v), g, m }, o);
  const check = (label, opening, moves, closing) => {
    const diff = r2(opening + moves.reduce((t, x) => t + x, 0) - closing);
    return Math.abs(diff) >= 1 ? [L('Not matched (for the CA to look at)', -diff, '', 'Opening plus this month’s movements differs from the closing balance by this amount — usually a refund or payout processed in a different month from its booking.')] : [];
  };

  const sections = [
    { title: 'Receivable from Razorpay', note: 'Guests pay through Razorpay; Razorpay pays Aerva’s bank a day or two later. Until then the money is a receivable (Razorpay is a debtor in Tally).', lines: [
      L('Opening receivable', open.receivable, 'Sundry debtors: Razorpay', 'Collected by Razorpay but not yet in the bank at the start of the month'),
      L('Received from guests (incl. deposits)', receivedAll, 'Sundry debtors: Razorpay', 'Every payment guests made this month through Razorpay', { sign: '+' }),
      L('Refunded to guests', -(refundsBooking + refundsDeposit + refundsCredit), 'Sundry debtors: Razorpay', 'Refunds Razorpay processed this month (booking refunds, deposit refunds and Aerva credits refunded)', { sign: '−' }),
      L('Razorpay charges on payments (incl. GST)', -payFees, 'Sundry debtors: Razorpay', 'Razorpay keeps its fee out of the settlement', { sign: '−' }),
      L('Settled to Aerva’s bank', -settledIn, 'Bank', sync.ok ? 'Money Razorpay paid into the bank this month' : 'Razorpay’s settlements could not be read just now — take them from the bank statement', { sign: '−' }),
      ...check('rzp', open.receivable, [receivedAll, -(refundsBooking + refundsDeposit + refundsCredit), -payFees, -settledIn], close.receivable),
      L('Closing receivable', close.receivable, 'Sundry debtors: Razorpay', 'Still with Razorpay at month end — should match Razorpay’s dashboard balance', { strong: true })
    ] },
    { title: 'Advance from guests (liability)', note: 'When a guest pays, the money is not yet Aerva’s or the host’s — it is an advance held for the stay. On the day the guest checks in (or the booking is cancelled), it leaves this ledger: Aerva’s commission and fee become income, GST becomes payable to the government, and the rest becomes payable to the host and co-hosts.', lines: [
      L('Opening advance', open.advance, 'Current liabilities: Advance from guests', 'Held at the start of the month for stays not yet started'),
      L('Paid by guests this month', advIn, 'Current liabilities: Advance from guests', 'Booking payments received this month (security deposits are kept separately, below)', { sign: '+' }),
      ...(creditIn ? [L('Paid with Aerva credit this month', creditIn, 'Current liabilities: Advance from guests', 'The part of this month’s bookings paid with a guest’s Aerva credit — money first received through Razorpay on the booking the credit came from (see the Aerva credits CSV)', { sign: '+' })] : []),
      ...(creditBack ? [L('Returned to Aerva credit', -creditBack, 'Current liabilities: Advance from guests', 'The credit part of bookings refunded this month, back onto the guest’s credit', { sign: '−' })] : []),
      L('Refunded to guests this month', -refundsBooking, 'Current liabilities: Advance from guests', 'Booking money returned (cancellations, changes) — deposits not included', { sign: '−' }),
      L('Moved out: stays checked in or cancelled', -transferred, 'Current liabilities: Advance from guests', 'Went to Aerva’s income, GST payable, the host’s and co-hosts’ share, and Aerva credits held for guests — see those sections', { sign: '−' }),
      ...(Math.abs(bookingDiff) >= 1 ? [L('Bookings that do not add up', -bookingDiff, 'Current liabilities: Advance from guests', 'See “Difference to check” in the Bookings CSV', { sign: '−' })] : []),
      ...check('adv', open.advance, [advIn, creditIn, -creditBack, -refundsBooking, -transferred, -bookingDiff], close.advance),
      L('Closing advance', close.advance, 'Current liabilities: Advance from guests', 'Held at month end for stays that start later', { strong: true })
    ] },
    { title: 'Aerva’s income and expenses (profit and loss)', lines: [
      L('Commission from hosts', income.commission, 'Income: Commission', 'Aerva’s commission on stays checked in or cancelled this month'),
      L('Guest service fees', income.serviceFee, 'Income: Service fees', 'Aerva’s fee from guests on the same stays'),
      L('Total income', income.total, 'Income', 'Aerva’s revenue for the month', { strong: true }),
      L('Razorpay charges (before GST)', -r2(payFees - payFeesGst + poutFees - poutFeesGst), 'Indirect expenses: Bank charges', 'Razorpay’s fees on payments and payouts — an expense', { sign: '−' }),
      L('Income after Razorpay charges', r2(income.total - (payFees - payFeesGst + poutFees - poutFeesGst)), 'Profit and loss', 'Before Aerva’s other expenses', { strong: true })
    ] },
    { title: 'GST', note: 'GST on Aerva’s own commission and service fee is not shown here — confirm with your CA.', lines: [
      L('GST on bookings (s.9(5))', gstOut, 'Duties & taxes: Output GST', 'GST on stays checked in or cancelled this month — Aerva pays it to the government'),
      L('GST on Razorpay charges', -r2(payFeesGst + poutFeesGst), 'Duties & taxes: Input GST', 'Can be claimed as input tax credit', { sign: '−' }),
      L('Net GST payable', r2(gstOut - payFeesGst - poutFeesGst), 'Duties & taxes', 'Before GST on Aerva’s own fees', { strong: true })
    ] },
    { title: 'TDS (194-O)', note: 'Deposit with the government by the 7th of next month.', lines: [
      L('TDS on hosts', tdsHost, 'Duties & taxes: TDS payable', 'Cut from payouts to hosts this month'),
      L('TDS on co-hosts', tdsCo, 'Duties & taxes: TDS payable', 'Cut from payouts to co-hosts this month'),
      L('Total TDS payable', r2(tdsHost + tdsCo), 'Duties & taxes: TDS payable', '', { strong: true })
    ] },
    { title: 'Payable to hosts (liability)', lines: [
      L('Opening payable', open.host, 'Sundry creditors: Hosts', 'Owed to hosts at the start of the month'),
      L('Hosts’ share of stays this month', earnedHost, 'Sundry creditors: Hosts', 'From stays checked in or cancelled this month (after Aerva’s commission and co-hosts’ share)', { sign: '+' }),
      L('Money sent to hosts', -sum(hostP, p => p.net), 'Bank', 'Payouts sent this month', { sign: '−' }),
      L('TDS on hosts', -sum(hostP, p => p.tds), 'Duties & taxes: TDS payable', 'Part of the host’s money, paid to the government instead', { sign: '−' }),
      L('Deducted from hosts’ payouts', -sum(hostP, p => p.deductions), 'Sundry creditors: Hosts', 'Host-funded cancellation coupons, and amounts paid before on bookings reduced after their payout was sent', { sign: '−' }),
      ...check('host', open.host, [earnedHost, -sum(hostP, p => p.net), -sum(hostP, p => p.tds), -sum(hostP, p => p.deductions)], close.host),
      L('Closing payable', close.host, 'Sundry creditors: Hosts', 'Owed to hosts at month end', { strong: true })
    ] },
    { title: 'Payable to co-hosts (liability)', note: 'Co-hosts are paid from the host’s share, not from Aerva’s income.', lines: [
      L('Opening payable', open.cohost, 'Sundry creditors: Co-hosts', 'Owed to co-hosts at the start of the month'),
      L('Co-hosts’ share of stays this month', earnedCo, 'Sundry creditors: Co-hosts', 'From stays checked in or cancelled this month', { sign: '+' }),
      L('Money sent to co-hosts', -sum(coP, p => p.net), 'Bank', 'Payouts sent this month', { sign: '−' }),
      L('TDS on co-hosts', -sum(coP, p => p.tds), 'Duties & taxes: TDS payable', '', { sign: '−' }),
      ...(sum(coP, p => p.deductions) ? [L('Deducted from co-hosts’ payouts', -sum(coP, p => p.deductions), 'Sundry creditors: Co-hosts', 'Amounts paid before on bookings reduced after their payout was sent', { sign: '−' })] : []),
      ...check('co', open.cohost, [earnedCo, -sum(coP, p => p.net), -sum(coP, p => p.tds), -sum(coP, p => p.deductions)], close.cohost),
      L('Closing payable', close.cohost, 'Sundry creditors: Co-hosts', 'Owed to co-hosts at month end', { strong: true })
    ] },
    { title: 'Aerva credits (liability)', note: 'Credit held for guests: Aerva’s service fee when a host cancels, and the nights not stayed when a stay is shortened. No money moves when a credit is made or used — it was received through Razorpay on the booking it came from. Every movement, with that booking and Razorpay payment, is in the Aerva credits CSV.', lines: [
      L('Opening credits held', open.credits, 'Current liabilities: Aerva credits (guests)', 'Held for guests at the start of the month'),
      L('Credits made', creditMade, 'Current liabilities: Aerva credits (guests)', 'From bookings a host cancelled, or stays shortened during the stay (from Advance from guests)', { sign: '+' }),
      ...(creditBack ? [L('Given back to credits', creditBack, 'Current liabilities: Aerva credits (guests)', 'The credit part of bookings refunded this month', { sign: '+' })] : []),
      L('Used on new bookings', -creditIn, 'Current liabilities: Aerva credits (guests)', 'Taken off new bookings (to Advance from guests)', { sign: '−' }),
      L('Refunded to guests', -creditRefunded, 'Current liabilities: Aerva credits (guests)', 'Refunded through Razorpay to the original payment, at the guest’s request or when the credit period ended', { sign: '−' }),
      ...check('credits', open.credits, [creditMade, creditBack, -creditIn, -creditRefunded], close.credits),
      L('Closing credits held', close.credits, 'Current liabilities: Aerva credits (guests)', 'Held for guests at month end', { strong: true })
    ] },
    { title: 'Security deposits (liability)', note: 'Refundable deposits are the guest’s money until returned, or paid to the host for damage.', lines: [
      L('Opening deposits held', open.deposits, 'Current liabilities: Security deposits', 'Held at the start of the month'),
      L('Deposits received', depReceived, 'Current liabilities: Security deposits', 'Collected with bookings this month', { sign: '+' }),
      L('Deposits refunded to guests', -refundsDeposit, 'Current liabilities: Security deposits', 'Returned after check-out', { sign: '−' }),
      L('Deposits paid to hosts (damage)', -depPaidHost, 'Current liabilities: Security deposits', 'Paid to hosts for damage claims, before TDS', { sign: '−' }),
      L('Closing deposits held', close.deposits, 'Current liabilities: Security deposits', 'Held at month end', { strong: true })
    ] }
  ];
  // ---- Balance sheet at month end (booking money only) ----
  const all = await recognisedBookings(sql, '1970-01-01', end);
  const cumIncome = sum(all, b => b.commissionIncome + b.serviceFeeIncome);
  const cumGst = sum(all, b => b.gstPayable);
  const c = close.cum;
  const bank = r2(c.settled - c.payoutsNet - c.payoutFees);
  const feesExGst = r2(c.fees - c.feesGst);
  const assets = r2(close.receivable + bank + c.feesGst);
  const earnings = r2(cumIncome - feesExGst);
  const creditsHeld = close.credits;
  const liab = r2(close.advance + close.host + close.cohost + close.deposits + cumGst + c.tds + creditsHeld);
  const bsDiff = r2(assets - liab - earnings);
  sections.unshift({ title: 'Balance sheet at ' + endLabel(end), note: 'Booking money only, since Aerva’s first booking. GST and TDS are shown in full: subtract what has already been deposited with the government from both “GST/TDS payable” and “Bank”. Aerva’s capital, other income and other expenses are not on the site — your CA adds them.', balanceSheet: true, lines: [
    L('EQUITY AND LIABILITIES', null, '', '', { head: true }),
    L('Owner’s funds', null, '', '', { head: true, sub: true }),
    L('Reserves and surplus (Aerva’s earnings so far)', earnings, 'Capital account / Reserves and surplus: Profit and loss', 'Belongs to Aerva’s owners: commission and service fees since the first booking, less Razorpay’s charges (before GST). Not owed to anyone.'),
    L('Current liabilities', null, '', '', { head: true, sub: true }),
    L('Advance from guests', close.advance, 'Current liabilities: Advance from guests', 'Paid for stays that have not started'),
    L('Payable to hosts', close.host, 'Current liabilities: Sundry creditors — Hosts', 'Hosts’ share of completed stays, not yet paid'),
    L('Payable to co-hosts', close.cohost, 'Current liabilities: Sundry creditors — Co-hosts', 'Co-hosts’ share of completed stays, not yet paid'),
    L('Security deposits held', close.deposits, 'Current liabilities: Security deposits', 'To be returned to guests or paid to hosts'),
    L('Aerva credits held', creditsHeld, 'Current liabilities: Aerva credits (guests)', 'Guests’ Aerva credit not yet used or refunded: Aerva’s service fee on bookings a host cancelled, and the nights not stayed on stays shortened during the stay. Money first received through Razorpay; see the Aerva credits CSV.'),
    L('GST payable on bookings (s.9(5))', cumGst, 'Current liabilities: Duties & taxes — Output GST', 'Since the first booking — less what has been deposited'),
    L('TDS payable (194-O)', c.tds, 'Current liabilities: Duties & taxes — TDS payable', 'Since the first payout — less what has been deposited'),
    L('Total equity and liabilities', r2(liab + earnings), '', '', { strong: true }),
    L('ASSETS', null, '', '', { head: true }),
    L('Current assets', null, '', '', { head: true, sub: true }),
    L('Receivable from Razorpay', close.receivable, 'Current assets: Sundry debtors — Razorpay', 'Collected from guests, not yet paid into the bank'),
    L('Bank (booking money)', bank, 'Current assets: Bank', 'Settled by Razorpay into the bank, less payouts sent to hosts and co-hosts and RazorpayX’s charges'),
    L('Input GST (ITC) on Razorpay charges', c.feesGst, 'Current assets: Duties & taxes — Input GST', 'Claimable against GST payable, if Aerva is GST-registered and Razorpay’s invoice shows Aerva’s GSTIN'),
    L('Total assets', assets, '', 'Equals total equity and liabilities', { strong: true }),
    ...(Math.abs(bsDiff) >= 1 ? [L('Not matched (for the CA to look at)', bsDiff, '', 'Assets differ from equity and liabilities by this amount — see “Difference to check” in the Bookings CSV and any “Not matched” lines below.')] : [])
  ] });
  return { month: label, sections, balanced: Math.abs(bsDiff) < 1, settlementsKnown: sync.ok, settlementsSetupNeeded: !!sync.setupNeeded };
}

// Razorpay's fee and the GST on it, per payment (pay_…) or payout (pout_…).
// Kept in razorpay_fees once known, so Razorpay is asked only once per
// transaction; at most a few dozen are fetched each time the report opens.
async function razorpayFees(sql, items) {
  const out = { map: {}, unknown: 0, setupNeeded: false };
  const list = items.filter(i => i.ref && /^(pay|pout)_[A-Za-z0-9]{14}$/.test(i.ref));
  if (!list.length) return out;
  const refs = [...new Set(list.map(i => i.ref))];
  try {
    (await sql`SELECT ref_id, fee_paise, tax_paise FROM razorpay_fees WHERE ref_id = ANY(${refs})`)
      .forEach(r => { out.map[r.ref_id] = { fee: Number(r.fee_paise), tax: Number(r.tax_paise) }; });
  } catch (e) { out.unknown = refs.length; out.setupNeeded = true; return out; }
  const missing = list.filter((i, n) => !out.map[i.ref] && list.findIndex(x => x.ref === i.ref) === n);
  const keyId = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
  if (missing.length && keyId && secret) {
    const auth = 'Basic ' + Buffer.from(`${keyId}:${secret}`).toString('base64');
    const started = Date.now();
    const todo = missing.slice(0, 40);
    for (let i = 0; i < todo.length && Date.now() - started < 6000; i += 8) {
      await Promise.all(todo.slice(i, i + 8).map(async (it) => {
        try {
          const res = await fetch(`https://api.razorpay.com/v1/${it.kind === 'payout' ? 'payouts' : 'payments'}/${it.ref}`, { headers: { Authorization: auth } });
          if (!res.ok) return;
          const d = await res.json();
          const fee = it.kind === 'payout' ? d.fees : d.fee;
          if (fee == null) return;              // not settled yet: try again next time
          const row = { fee: Math.round(Number(fee) || 0), tax: Math.round(Number(d.tax) || 0) };
          await sql`INSERT INTO razorpay_fees (ref_id, kind, order_id, fee_paise, tax_paise) VALUES (${it.ref}, ${it.kind}, ${it.orderId || null}, ${row.fee}, ${row.tax})
                    ON CONFLICT (ref_id) DO NOTHING`;
          out.map[it.ref] = row;
        } catch (e) { /* try again next time */ }
      }));
    }
  }
  out.unknown = refs.filter(r => !out.map[r]).length;
  return out;
}

// The last day of the month whose (exclusive) end is `end`, e.g. "31 October 2026".
function endLabel(end) {
  const d = new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function isoDay(v, ist = false) {
  if (!v) return '';
  if (v instanceof Date) {
    if (isNaN(v)) return '';
    if (ist) return new Date(v.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const p = (n) => String(n).padStart(2, '0');
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
  }
  return String(v).slice(0, 10);
}

module.exports = { accountsReport, monthBounds };
