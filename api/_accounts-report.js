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

async function accountsReport(sql, month) {
  const { start, end, label } = monthBounds(month);
  // Bookings recognised in the month: check-in (arrival) for bookings going
  // ahead; the cancellation date (India time) for cancelled ones.
  const orders = await sql`
    SELECT o.id, o.razorpay_order_id, to_jsonb(o)->>'confirmation_code' AS code, o.suite_name, o.status,
           o.arrival, o.departure, o.created_at, o.cancelled_at,
           COALESCE(o.order_type, 'stay') AS order_type,
           o.subtotal, o.gst, o.guest_service_fee, o.deposit_amount, o.total,
           COALESCE((to_jsonb(o)->>'coupon_discount')::numeric, 0) AS coupon_discount,
           o.commission_amount, o.payout_amount, to_jsonb(o)->>'refund_percent' AS refund_percent,
           COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(o)->>'guest_first_name', to_jsonb(o)->>'guest_last_name')), ''), g.name, o.guest_email) AS guest_name,
           h.id AS host_id, h.name AS host_name,
           (SELECT COALESCE(sum(amount), 0) FROM refunds r WHERE r.order_id = o.id AND r.status <> 'failed' AND r.kind NOT LIKE 'deposit%') AS refunded_paise,
           (SELECT COALESCE(sum(amount), 0) FROM order_cohost_shares s WHERE s.order_id = o.id) AS cohost_shares
    FROM orders o
    LEFT JOIN guests g ON g.id = o.guest_id
    LEFT JOIN listings l ON l.id = o.listing_id
    LEFT JOIN hosts h ON h.id = l.host_id
    WHERE o.status IN ('paid', 'cancelled') AND o.razorpay_payment_id IS NOT NULL
      AND (
        (o.status = 'paid' AND o.arrival >= ${start}::date AND o.arrival < ${end}::date)
        OR (o.status = 'cancelled' AND o.cancelled_at IS NOT NULL
            AND (o.cancelled_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (o.cancelled_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp)
      )
    ORDER BY 1`;

  const bookings = orders.map(o => {
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
    const recognisedOn = o.status === 'cancelled' && o.cancelled_at
      ? new Date(new Date(o.cancelled_at).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10)
      : isoDay(o.arrival);
    return {
      bookingId: o.id, reference: o.code || o.razorpay_order_id || ('#' + o.id), event: o.status === 'cancelled' ? 'Cancelled' : 'Check-in',
      recognisedOn, guest: o.guest_name || '', listing: o.suite_name || '', host: o.host_name || '', hostId: o.host_id,
      type: o.order_type, arrival: isoDay(o.arrival), departure: isoDay(o.departure), paidOn: isoDay(o.created_at, true),
      bookingPrice: subtotal, paidByCoupon: r2(o.coupon_discount), gstOnStay: gst, serviceFee: fee, deposit,
      charged: r2(Number(o.total) - Number(o.coupon_discount || 0)),
      refundedToGuest: refunded,
      commissionIncome: commission, serviceFeeIncome: fee,
      hostPayable, cohostShares: r2(o.cohost_shares), gstPayable,
      // Should be 0: what the guest paid (deposit aside), less refunds, less
      // every ledger it went to. Anything else is for the CA to look at
      // (e.g. Aerva refunding its own fee as an exception, or a coupon).
      difference: r2(r2(Number(o.total) - Number(o.coupon_discount || 0)) - deposit - refunded - fee - commission - hostPayable - gstPayable)
    };
  });
  const sum = (list, k) => r2(list.reduce((t, x) => t + (Number(x[k]) || 0), 0));

  // ---- Cash in and out in the month ----
  const receipts = await sql`
    SELECT o.id, to_jsonb(o)->>'confirmation_code' AS code, o.razorpay_order_id, o.created_at, o.total,
           COALESCE((to_jsonb(o)->>'coupon_discount')::numeric, 0) AS coupon_discount, o.deposit_amount, o.gst, o.guest_service_fee
    FROM orders o
    WHERE o.status IN ('paid', 'cancelled') AND o.razorpay_payment_id IS NOT NULL
      AND (o.created_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (o.created_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp
    ORDER BY o.created_at`;
  let changeReceipts = [];
  try {
    changeReceipts = await sql`
      SELECT c.order_id AS id, c.applied_at AS created_at, c.difference AS amount FROM booking_changes c
      WHERE c.status = 'applied' AND c.razorpay_payment_id IS NOT NULL AND c.difference > 0
        AND (c.applied_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (c.applied_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp`;
  } catch (e) { changeReceipts = []; }
  const refunds = await sql`
    SELECT r.order_id, r.kind, r.amount, r.status, r.created_at, r.razorpay_refund_id
    FROM refunds r
    WHERE r.status <> 'failed' AND r.status <> 'new'
      AND (r.created_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (r.created_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp
    ORDER BY r.created_at`;
  const payouts = await sql`
    SELECT p.id, p.order_id, p.payee_type, COALESCE(p.kind, 'booking') AS kind, p.gross, p.commission, p.cohost_shares, p.deductions, p.tds, p.net, p.sent_at, p.reference,
           CASE WHEN p.payee_type = 'host' THEN h.name ELSE g.name END AS payee
    FROM payouts p LEFT JOIN hosts h ON h.id = p.host_id LEFT JOIN guests g ON g.id = p.payee_guest_id
    WHERE p.status = 'sent' AND p.sent_at IS NOT NULL
      AND (p.sent_at AT TIME ZONE 'Asia/Kolkata') >= ${start}::timestamp AND (p.sent_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp
    ORDER BY p.sent_at`;
  const cash = [];
  receipts.forEach(o => cash.push({ date: isoDay(o.created_at, true), type: 'Receipt from guest', bookingId: o.id, reference: o.code || o.razorpay_order_id,
    amountIn: r2(Number(o.total) - Number(o.coupon_discount || 0)), amountOut: 0,
    ledger: 'Advance from guests' + (Number(o.deposit_amount) > 0 ? ' / Security deposits held' : '') }));
  changeReceipts.forEach(c => cash.push({ date: isoDay(c.created_at, true), type: 'Receipt: booking change', bookingId: c.id, reference: '', amountIn: r2(c.amount), amountOut: 0, ledger: 'Advance from guests' }));
  refunds.forEach(r => {
    const k = String(r.kind || '');
    const ledger = k.startsWith('deposit') ? 'Security deposits held' : 'Advance from guests / Payable to hosts';
    cash.push({ date: isoDay(r.created_at, true), type: 'Refund to guest (' + k.split(':')[0] + ')', bookingId: r.order_id, reference: r.razorpay_refund_id || '', amountIn: 0, amountOut: r2(Number(r.amount) / 100), ledger });
  });
  payouts.forEach(p => {
    cash.push({ date: isoDay(p.sent_at, true), type: p.kind === 'deposit' ? 'Payout: deposit compensation' : (p.payee_type === 'cohost' ? 'Payout to co-host' : 'Payout to host'),
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
    WHERE o.razorpay_payment_id IS NOT NULL AND o.status IN ('paid', 'cancelled')
      AND (o.created_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp AND o.arrival >= ${end}::date
      AND (o.status = 'paid' OR (o.cancelled_at AT TIME ZONE 'Asia/Kolkata') >= ${end}::timestamp)`)[0].v;
  // Payable to hosts: shares recognised by month end, less what was paid out by then.
  const recognisedPayable = (await sql`
    SELECT COALESCE(sum(o.payout_amount), 0) AS v FROM orders o
    WHERE o.razorpay_payment_id IS NOT NULL AND (
      (o.status = 'paid' AND o.arrival < ${end}::date)
      OR (o.status = 'cancelled' AND (o.cancelled_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp))`)[0].v;
  const paidOut = (await sql`
    SELECT COALESCE(sum(CASE WHEN p.payee_type = 'host' THEN p.gross - p.commission - p.cohost_shares ELSE p.gross END), 0) AS v
    FROM payouts p WHERE p.status = 'sent' AND COALESCE(p.kind, 'booking') = 'booking'
      AND (p.sent_at AT TIME ZONE 'Asia/Kolkata') < ${end}::timestamp`)[0].v;
  let depositsHeld = 0;
  try { depositsHeld = (await sql`SELECT COALESCE(sum(deposit_amount), 0) AS v FROM orders WHERE deposit_status IN ('held', 'disputed')`)[0].v; } catch (e) { depositsHeld = 0; }

  const tdsDeducted = r2(payouts.reduce((t, p) => t + Number(p.tds || 0), 0));
  const summary = {
    month: label,
    income: { commission: sum(bookings, 'commissionIncome'), serviceFee: sum(bookings, 'serviceFeeIncome') },
    gstOnStaysPayable: sum(bookings, 'gstPayable'),
    tdsDeducted,
    bookingsToCheck: bookings.filter(b => Math.abs(b.difference) >= 1).length,
    received: r2(cash.reduce((t, c) => t + c.amountIn, 0)),
    refunded: r2(cash.filter(c => /^Refund/.test(c.type)).reduce((t, c) => t + c.amountOut, 0)),
    paidOut: r2(cash.filter(c => /^Payout/.test(c.type)).reduce((t, c) => t + c.amountOut, 0)),
    balances: {
      advanceFromGuests: r2(adv),
      payableToHosts: r2(Math.max(0, Number(recognisedPayable) - Number(paidOut))),
      depositsHeldToday: r2(depositsHeld),
      gstPayable: sum(bookings, 'gstPayable'),
      tdsPayable: tdsDeducted
    },
    notes: [
      'Income is Aerva’s commission and guest service fee only. Booking amounts are held for hosts (Aerva is their payment-collection agent).',
      'Recognised at check-in, or on the cancellation date for cancelled bookings. Dates are India time.',
      'GST payable is the GST on stays recognised this month (s.9(5)). GST on Aerva’s own fees is not included here — confirm with your CA.',
      'TDS payable is the TDS deducted from payouts sent this month: deposit by the 7th of next month.',
      'Razorpay’s charges are not known to the site: add them from Razorpay’s settlement report as an expense.',
      'Security deposits held is today’s figure.'
    ]
  };
  summary.income.total = r2(summary.income.commission + summary.income.serviceFee);
  return { month: label, summary, bookings, cash };
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
