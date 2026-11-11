// /api/_money-ledger.js — every rupee in and out, in one list. Not an endpoint.
//
// Admin → Transactions (GET /api/get-listings?transactions=1) reads this. It
// is for matching Aerva's own records against the Razorpay dashboard, so
// every row carries the Razorpay id that row would be found under:
//   money in   — razorpay_payment_id  (a guest's payment)
//   money out  — razorpay_refund_id   (a refund to a guest)
//              — razorpayx_payout_id  (a payout to a host or co-host)
// Nothing here changes anything; it only reads.
//
// Where each row comes from, and why that is the whole of it:
//   orders          — a guest's payment for a booking. One payment can pay
//                     for several bookings (a cart), so the rows are grouped
//                     by payment id and the amounts added up.
//   group_claims    — one payment per person in a group booking. The order
//                     row for a group carries the organiser's payment id, so
//                     group orders are left out above to avoid counting twice.
//   booking_changes — the extra payment when a booking grew.
//   refunds         — every refund made against a booking, group bookings
//                     included (one row per payment refunded).
//   group_claims    — refunds of group payments made before there was a
//                     booking (the group fell through), which have no
//                     refunds row because there is no booking to hang it on.
//   payouts         — what Aerva pays hosts and co-hosts.
//
// Units, so the figures are right: orders.total, payouts.net and
// group_claims.amount are in rupees; refunds.amount and
// group_claims.refund_amount are in paise.

const PAGE = 200;
const MAX = 500;

const inr = (n) => Math.round(Number(n) || 0);
const paise = (n) => Math.round(Number(n) || 0) / 100;
const name = (first, last, fallback) => (`${first || ''} ${last || ''}`.trim() || fallback || '');

// A booking's name for the list: its code if it has one, else #id.
const bookingLabel = (id, code) => (code ? String(code) : id ? '#' + id : '');

// What a refund was for, from refunds.kind. The kind carries the payment id
// after a colon when a refund was split over a group's payments.
function refundFor(kind) {
  const k = String(kind || '');
  if (/^deposit/.test(k)) return 'Security deposit back';
  if (/^cancellation/.test(k)) return 'Cancellation refund';
  if (/^change-pay-/.test(k)) return 'Extra payment refunded';
  if (/^change-/.test(k)) return 'Booking changed — difference back';
  if (/^dispute-/.test(k)) return 'Decided on a deposit dispute';
  if (/^goodwill-/.test(k)) return 'Goodwill refund';
  return 'Refund';
}
const PAYOUT_FOR = {
  booking: 'Booking payout',
  deposit: 'Paid from a guest’s deposit',
  'cohost-coupon': 'Co-host’s cancellation coupon'
};

// Refund status in plain words. 'new' and 'creating' mean Aerva has decided
// to refund it but Razorpay has not been asked yet (or the ask is in flight).
const REFUND_STATE = {
  new: 'Starting', creating: 'Starting', pending: 'With Razorpay', processed: 'Refunded', failed: 'Failed'
};
const PAYOUT_STATE = { due: 'Not sent yet', sent: 'Sent', failed: 'Failed' };

// Why a payout has not gone out yet, in the order that matters
// (owner, 12 Nov 2026: "provide reason why not sent"). Read only.
const razorpayxReady = () => !!(process.env.RAZORPAYX_ACCOUNT_NUMBER && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
function whyNotSent(r) {
  if (r.status === 'sent') return '';
  if (r.failure_reason) return 'The bank refused it: ' + String(r.failure_reason).slice(0, 120);
  if (r.status === 'failed') return 'The last attempt failed — retry it on the Payouts tab';
  if (Number(r.net) <= 0) return 'Nothing to pay on this one';
  if (r.bank_not_ready) return 'Their bank details are not approved yet';
  if (r.arriving_by && String(r.arriving_by).slice(0, 10) > new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)) {
    return 'Due on ' + String(r.arriving_by).slice(0, 10);
  }
  if (!r.auto_eligible || !razorpayxReady()) return 'Automatic payouts are off — send it by hand, then Mark paid on the Payouts tab';
  return 'Waiting for the next payout run (every 4 hours)';
}

function ready(sql) { return !!sql; }

// ---------------------------------------------------------------------
// The list. opts: { from, to, before, direction: 'in'|'out', q, limit }
// 'before' pages backwards in time: pass the last row's `at`.
// ---------------------------------------------------------------------
async function ledger(sql, opts = {}) {
  const limit = Math.max(1, Math.min(MAX, Math.floor(Number(opts.limit)) || PAGE));
  const from = opts.from ? String(opts.from).slice(0, 40) : null;
  const to = opts.to ? String(opts.to).slice(0, 40) : null;
  const before = opts.before ? String(opts.before).slice(0, 40) : null;
  const want = opts.direction === 'in' || opts.direction === 'out' ? opts.direction : null;
  const q = String(opts.q || '').trim().slice(0, 120);
  const like = q ? '%' + q.toLowerCase() + '%' : null;
  // One extra row tells us whether there is another page.
  const take = limit + 1;

  const rows = [];
  const skipped = [];
  // A source that cannot be read (an older database without a table or
  // column) leaves the rest of the list alone and is named in the answer.
  const part = async (label, fn) => {
    try { (await fn()).forEach(r => rows.push(r)); }
    catch (err) { skipped.push(label); console.error('transactions: ' + label + ' not read:', err.message); }
  };

  // ---- Money in: a guest's payment for one or more bookings ----
  if (want !== 'out') await part('booking payments', async () => {
    const got = await sql`
      SELECT o.razorpay_payment_id AS pid, min(o.razorpay_order_id) AS rz_order,
             min(o.created_at) AS at, count(*)::int AS bookings,
             sum(o.total)::numeric AS total, sum(o.fee_credit_used)::numeric AS credit,
             min(o.id)::int AS order_id, min(o.confirmation_code) AS code,
             min(o.suite_name) AS listing, min(o.guest_email) AS email,
             min(o.guest_first_name) AS first_name, min(o.guest_last_name) AS last_name,
             min(o.charge_currency) AS currency, min(o.charge_amount)::numeric AS charge_amount,
             bool_or(o.status = 'cancelled') AS any_cancelled
        FROM orders o
       WHERE o.razorpay_payment_id IS NOT NULL
         AND o.group_booking_id IS NULL
         AND (${from}::timestamptz IS NULL OR o.created_at >= ${from}::timestamptz)
         AND (${to}::timestamptz IS NULL OR o.created_at < ${to}::timestamptz)
         AND (${before}::timestamptz IS NULL OR o.created_at < ${before}::timestamptz)
         AND (${like}::text IS NULL OR lower(o.guest_email) LIKE ${like} OR lower(o.suite_name) LIKE ${like}
              OR lower(coalesce(o.confirmation_code, '')) LIKE ${like} OR lower(o.razorpay_payment_id) LIKE ${like}
              OR lower(o.razorpay_order_id) LIKE ${like} OR lower(coalesce(o.guest_first_name, '') || ' ' || coalesce(o.guest_last_name, '')) LIKE ${like})
       GROUP BY o.razorpay_payment_id
       ORDER BY min(o.created_at) DESC
       LIMIT ${take}`;
    return got.map(r => ({
      at: r.at, direction: 'in', what: r.bookings > 1 ? `Payment for ${r.bookings} bookings` : 'Payment for a booking',
      who: name(r.first_name, r.last_name, r.email), whoEmail: r.email || '', whoIs: 'Guest',
      bookingId: Number(r.order_id) || null, booking: bookingLabel(r.order_id, r.code), listing: r.listing || '',
      // What actually reached Razorpay: the quote less any Aerva credit used.
      amount: inr(Number(r.total) - Number(r.credit || 0)),
      status: 'Received', why: r.any_cancelled ? 'A booking paid for by this payment was later cancelled' : '',
      paymentId: r.pid || '', refundId: '', payoutId: '', rzOrder: r.rz_order || '',
      note: [
        Number(r.credit) > 0 ? `₹${inr(r.credit)} of it paid with Aerva credit` : '',
        r.currency && r.currency !== 'INR' && r.charge_amount ? `charged ${r.currency} ${Number(r.charge_amount)}` : ''
      ].filter(Boolean).join(' · ')
    }));
  });

  // ---- Money in: one person's place in a group booking ----
  if (want !== 'out') await part('group payments', async () => {
    const got = await sql`
      SELECT c.id, c.amount::numeric AS amount, c.razorpay_payment_id AS pid, c.razorpay_order_id AS rz_order,
             c.paid_at AS at, c.first_name, c.last_name, c.email, c.places, c.kind,
             g.order_id::int AS order_id, g.token, o.confirmation_code AS code, l.property_name AS listing,
             g.organiser_guest_id, c.guest_id
        FROM group_claims c
        JOIN group_bookings g ON g.id = c.group_id
        LEFT JOIN orders o ON o.id = g.order_id
        LEFT JOIN listings l ON l.id = g.listing_id
       WHERE c.status = 'paid' AND c.razorpay_payment_id IS NOT NULL
         AND (${from}::timestamptz IS NULL OR c.paid_at >= ${from}::timestamptz)
         AND (${to}::timestamptz IS NULL OR c.paid_at < ${to}::timestamptz)
         AND (${before}::timestamptz IS NULL OR c.paid_at < ${before}::timestamptz)
         AND (${like}::text IS NULL OR lower(coalesce(c.email, '')) LIKE ${like} OR lower(coalesce(l.property_name, '')) LIKE ${like}
              OR lower(c.razorpay_payment_id) LIKE ${like} OR lower(coalesce(c.razorpay_order_id, '')) LIKE ${like}
              OR lower(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) LIKE ${like}
              OR lower(coalesce(o.confirmation_code, '')) LIKE ${like})
       ORDER BY c.paid_at DESC
       LIMIT ${take}`;
    return got.map(r => ({
      at: r.at, direction: 'in',
      what: r.kind === 'gap' ? 'Group booking — the organiser paid the rest'
        : Number(r.organiser_guest_id) === Number(r.guest_id) ? 'Group booking — the organiser’s payment'
        : 'Group booking — one person’s payment',
      who: name(r.first_name, r.last_name, r.email), whoEmail: r.email || '', whoIs: 'Guest',
      bookingId: Number(r.order_id) || null, booking: bookingLabel(r.order_id, r.code), listing: r.listing || '',
      amount: inr(r.amount), status: r.order_id ? 'Received' : 'Received (booking not confirmed yet)',
      paymentId: r.pid || '', refundId: '', payoutId: '', rzOrder: r.rz_order || '',
      note: Number(r.places) ? `${Number(r.places)} place${Number(r.places) === 1 ? '' : 's'}` : ''
    }));
  });

  // ---- Money in: the extra payment when a booking grew ----
  if (want !== 'out') await part('change payments', async () => {
    const got = await sql`
      SELECT ch.id, ch.difference::numeric AS amount, ch.razorpay_payment_id AS pid, ch.razorpay_order_id AS rz_order,
             COALESCE(ch.applied_at, ch.accepted_at, ch.created_at) AS at, ch.summary,
             o.id::int AS order_id, o.confirmation_code AS code, o.suite_name AS listing,
             o.guest_email AS email, o.guest_first_name AS first_name, o.guest_last_name AS last_name
        FROM booking_changes ch
        JOIN orders o ON o.id = ch.order_id
       WHERE ch.razorpay_payment_id IS NOT NULL AND ch.difference > 0
         AND (${from}::timestamptz IS NULL OR COALESCE(ch.applied_at, ch.accepted_at, ch.created_at) >= ${from}::timestamptz)
         AND (${to}::timestamptz IS NULL OR COALESCE(ch.applied_at, ch.accepted_at, ch.created_at) < ${to}::timestamptz)
         AND (${before}::timestamptz IS NULL OR COALESCE(ch.applied_at, ch.accepted_at, ch.created_at) < ${before}::timestamptz)
         AND (${like}::text IS NULL OR lower(o.guest_email) LIKE ${like} OR lower(o.suite_name) LIKE ${like}
              OR lower(ch.razorpay_payment_id) LIKE ${like} OR lower(coalesce(o.confirmation_code, '')) LIKE ${like})
       ORDER BY COALESCE(ch.applied_at, ch.accepted_at, ch.created_at) DESC
       LIMIT ${take}`;
    return got.map(r => ({
      at: r.at, direction: 'in', what: 'Booking changed — the guest paid the difference',
      who: name(r.first_name, r.last_name, r.email), whoEmail: r.email || '', whoIs: 'Guest',
      bookingId: Number(r.order_id) || null, booking: bookingLabel(r.order_id, r.code), listing: r.listing || '',
      amount: inr(r.amount), status: 'Received',
      paymentId: r.pid || '', refundId: '', payoutId: '', rzOrder: r.rz_order || '',
      note: String(r.summary || '').slice(0, 90)
    }));
  });

  // ---- Money out: refunds against a booking ----
  if (want !== 'in') await part('refunds', async () => {
    const got = await sql`
      SELECT r.id, r.kind, r.amount::numeric AS paise, r.status, r.razorpay_refund_id AS refund_id,
             r.razorpay_payment_id AS pid, r.created_at AS at, r.failure_reason,
             o.id::int AS order_id, o.confirmation_code AS code, o.suite_name AS listing,
             o.guest_email AS email, o.guest_first_name AS first_name, o.guest_last_name AS last_name,
             c.first_name AS payer_first, c.last_name AS payer_last, c.email AS payer_email
        FROM refunds r
        JOIN orders o ON o.id = r.order_id
        LEFT JOIN group_claims c ON c.razorpay_payment_id = r.razorpay_payment_id AND c.status = 'paid'
       WHERE (${from}::timestamptz IS NULL OR r.created_at >= ${from}::timestamptz)
         AND (${to}::timestamptz IS NULL OR r.created_at < ${to}::timestamptz)
         AND (${before}::timestamptz IS NULL OR r.created_at < ${before}::timestamptz)
         AND (${like}::text IS NULL OR lower(o.guest_email) LIKE ${like} OR lower(o.suite_name) LIKE ${like}
              OR lower(coalesce(r.razorpay_refund_id, '')) LIKE ${like} OR lower(r.razorpay_payment_id) LIKE ${like}
              OR lower(coalesce(o.confirmation_code, '')) LIKE ${like} OR lower(coalesce(c.email, '')) LIKE ${like})
       ORDER BY r.created_at DESC
       LIMIT ${take}`;
    return got.map(r => ({
      at: r.at, direction: 'out', what: refundFor(r.kind),
      who: name(r.payer_first || r.first_name, r.payer_last || r.last_name, r.payer_email || r.email),
      whoEmail: r.payer_email || r.email || '', whoIs: 'Guest',
      bookingId: Number(r.order_id) || null, booking: bookingLabel(r.order_id, r.code), listing: r.listing || '',
      amount: Math.round(paise(r.paise)), status: REFUND_STATE[r.status] || String(r.status || ''),
      why: r.failure_reason ? 'Razorpay refused it: ' + String(r.failure_reason).slice(0, 120)
        : r.status === 'new' || r.status === 'creating' ? 'Decided — Razorpay is being asked now (the refunds job runs every 15 minutes)'
        : r.status === 'pending' ? 'With Razorpay — usually in the guest’s account in 5–7 working days' : '',
      paymentId: r.pid || '', refundId: r.refund_id || '', payoutId: '', rzOrder: '',
      note: ''
    }));
  });

  // ---- Money out: refunds of group payments with no booking behind them ----
  if (want !== 'in') await part('group refunds', async () => {
    const got = await sql`
      SELECT c.id, c.refund_amount::numeric AS paise, c.refund_status AS status, c.razorpay_refund_id AS refund_id,
             c.razorpay_payment_id AS pid, COALESCE(c.refunded_at, c.refund_claimed_at) AS at, c.refund_reason,
             c.first_name, c.last_name, c.email, g.order_id::int AS order_id, l.property_name AS listing
        FROM group_claims c
        JOIN group_bookings g ON g.id = c.group_id
        LEFT JOIN listings l ON l.id = g.listing_id
       WHERE c.refund_amount > 0 AND c.refund_status IS NOT NULL AND c.refund_status <> 'failed'
         AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.razorpay_payment_id = c.razorpay_payment_id)
         AND (${from}::timestamptz IS NULL OR COALESCE(c.refunded_at, c.refund_claimed_at) >= ${from}::timestamptz)
         AND (${to}::timestamptz IS NULL OR COALESCE(c.refunded_at, c.refund_claimed_at) < ${to}::timestamptz)
         AND (${before}::timestamptz IS NULL OR COALESCE(c.refunded_at, c.refund_claimed_at) < ${before}::timestamptz)
         AND (${like}::text IS NULL OR lower(coalesce(c.email, '')) LIKE ${like} OR lower(coalesce(l.property_name, '')) LIKE ${like}
              OR lower(coalesce(c.razorpay_refund_id, '')) LIKE ${like} OR lower(coalesce(c.razorpay_payment_id, '')) LIKE ${like})
       ORDER BY COALESCE(c.refunded_at, c.refund_claimed_at) DESC
       LIMIT ${take}`;
    return got.map(r => ({
      at: r.at, direction: 'out', what: 'Group payment refunded',
      who: name(r.first_name, r.last_name, r.email), whoEmail: r.email || '', whoIs: 'Guest',
      bookingId: Number(r.order_id) || null, booking: bookingLabel(r.order_id, null), listing: r.listing || '',
      amount: Math.round(paise(r.paise)), status: REFUND_STATE[r.status] || String(r.status || ''),
      paymentId: r.pid || '', refundId: r.refund_id || '', payoutId: '', rzOrder: '',
      note: r.refund_reason ? String(r.refund_reason).slice(0, 90) : ''
    }));
  });

  // ---- Money out: payouts to hosts and co-hosts ----
  if (want !== 'in') await part('payouts', async () => {
    const got = await sql`
      SELECT p.id, p.kind, p.payee_type, p.net::numeric AS net, p.gross::numeric AS gross, p.tds::numeric AS tds,
             p.status, p.razorpayx_payout_id AS payout_id, p.reference, p.failure_reason, p.bank_label,
             p.auto_eligible, to_jsonb(p)->>'arriving_by' AS arriving_by,
             -- Not paid until the bank details are approved (api/_payouts.js).
             (p.payee_type = 'host' AND COALESCE(h.bank_status, '') <> 'verified') AS bank_not_ready,
             COALESCE(p.sent_at, p.created_at) AS at,
             o.id::int AS order_id, o.confirmation_code AS code, o.suite_name AS listing,
             h.name AS host_name, h.email AS host_email,
             gu.first_name AS co_first, gu.last_name AS co_last, gu.email AS co_email
        FROM payouts p
        LEFT JOIN orders o ON o.id = p.order_id
        LEFT JOIN hosts h ON h.id = p.host_id
        LEFT JOIN guests gu ON gu.id = p.payee_guest_id
       WHERE (${from}::timestamptz IS NULL OR COALESCE(p.sent_at, p.created_at) >= ${from}::timestamptz)
         AND (${to}::timestamptz IS NULL OR COALESCE(p.sent_at, p.created_at) < ${to}::timestamptz)
         AND (${before}::timestamptz IS NULL OR COALESCE(p.sent_at, p.created_at) < ${before}::timestamptz)
         AND (${like}::text IS NULL OR lower(coalesce(h.email, '')) LIKE ${like} OR lower(coalesce(h.name, '')) LIKE ${like}
              OR lower(coalesce(gu.email, '')) LIKE ${like} OR lower(coalesce(o.suite_name, '')) LIKE ${like}
              OR lower(coalesce(p.razorpayx_payout_id, '')) LIKE ${like} OR lower(coalesce(p.reference, '')) LIKE ${like}
              OR lower(coalesce(o.confirmation_code, '')) LIKE ${like})
       ORDER BY COALESCE(p.sent_at, p.created_at) DESC
       LIMIT ${take}`;
    return got.map(r => ({
      at: r.at, direction: 'out',
      what: r.payee_type === 'cohost' && r.kind === 'booking' ? 'Co-host’s share of a booking' : (PAYOUT_FOR[r.kind] || 'Payout'),
      who: r.payee_type === 'cohost' ? name(r.co_first, r.co_last, r.co_email) : (r.host_name || r.host_email || ''),
      whoEmail: (r.payee_type === 'cohost' ? r.co_email : r.host_email) || '',
      whoIs: r.payee_type === 'cohost' ? 'Co-host' : 'Host',
      bookingId: Number(r.order_id) || null, booking: bookingLabel(r.order_id, r.code), listing: r.listing || '',
      amount: inr(r.net), status: PAYOUT_STATE[r.status] || String(r.status || ''),
      why: whyNotSent(r),
      paymentId: '', refundId: '', payoutId: r.payout_id || r.reference || '', rzOrder: '',
      note: [
        Number(r.tds) > 0 ? `₹${inr(r.tds)} TDS held back from ₹${inr(r.gross)}` : '',
        r.bank_label || ''
      ].filter(Boolean).join(' · ')
    }));
  });

  rows.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  const page = rows.slice(0, limit);
  const more = rows.length > limit;
  return {
    rows: page,
    more,
    nextBefore: more && page.length ? page[page.length - 1].at : null,
    skipped,
    totals: await totals(sql, { from, to, q, like })
  };
}

// ---------------------------------------------------------------------
// The four figures above the list, over the whole range asked for (not
// only the page shown). 'Paid out' counts payouts actually sent; what is
// decided but not sent yet is its own figure, so the two are never added
// together by mistake.
// ---------------------------------------------------------------------
async function totals(sql, { from, to, like }) {
  const one = async (fn) => { try { return Number((await fn())[0].n) || 0; } catch (err) { return 0; } };
  const inPaid = await one(() => sql`
    SELECT COALESCE(sum(t.n), 0) AS n FROM (
      SELECT sum(o.total - o.fee_credit_used)::numeric AS n FROM orders o
       WHERE o.razorpay_payment_id IS NOT NULL AND o.group_booking_id IS NULL
         AND (${from}::timestamptz IS NULL OR o.created_at >= ${from}::timestamptz)
         AND (${to}::timestamptz IS NULL OR o.created_at < ${to}::timestamptz)
         AND (${like}::text IS NULL OR lower(o.guest_email) LIKE ${like} OR lower(o.suite_name) LIKE ${like}
              OR lower(coalesce(o.confirmation_code, '')) LIKE ${like} OR lower(o.razorpay_payment_id) LIKE ${like})
      UNION ALL
      SELECT sum(c.amount)::numeric FROM group_claims c
       WHERE c.status = 'paid' AND c.razorpay_payment_id IS NOT NULL
         AND (${from}::timestamptz IS NULL OR c.paid_at >= ${from}::timestamptz)
         AND (${to}::timestamptz IS NULL OR c.paid_at < ${to}::timestamptz)
         AND (${like}::text IS NULL OR lower(coalesce(c.email, '')) LIKE ${like} OR lower(c.razorpay_payment_id) LIKE ${like})
      UNION ALL
      SELECT sum(ch.difference)::numeric FROM booking_changes ch JOIN orders o2 ON o2.id = ch.order_id
       WHERE ch.razorpay_payment_id IS NOT NULL AND ch.difference > 0
         AND (${from}::timestamptz IS NULL OR COALESCE(ch.applied_at, ch.accepted_at, ch.created_at) >= ${from}::timestamptz)
         AND (${to}::timestamptz IS NULL OR COALESCE(ch.applied_at, ch.accepted_at, ch.created_at) < ${to}::timestamptz)
         AND (${like}::text IS NULL OR lower(o2.guest_email) LIKE ${like} OR lower(ch.razorpay_payment_id) LIKE ${like})
    ) t`);
  const refunded = await one(() => sql`
    SELECT COALESCE(sum(r.amount), 0) / 100 AS n FROM refunds r JOIN orders o ON o.id = r.order_id
     WHERE r.status IN ('new', 'creating', 'pending', 'processed')
       AND (${from}::timestamptz IS NULL OR r.created_at >= ${from}::timestamptz)
       AND (${to}::timestamptz IS NULL OR r.created_at < ${to}::timestamptz)
       AND (${like}::text IS NULL OR lower(o.guest_email) LIKE ${like} OR lower(o.suite_name) LIKE ${like}
            OR lower(coalesce(r.razorpay_refund_id, '')) LIKE ${like} OR lower(r.razorpay_payment_id) LIKE ${like}
            OR lower(coalesce(o.confirmation_code, '')) LIKE ${like})`);
  const groupRefunded = await one(() => sql`
    SELECT COALESCE(sum(c.refund_amount), 0) / 100 AS n FROM group_claims c
     WHERE c.refund_amount > 0 AND c.refund_status IS NOT NULL AND c.refund_status <> 'failed'
       AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.razorpay_payment_id = c.razorpay_payment_id)
       AND (${from}::timestamptz IS NULL OR COALESCE(c.refunded_at, c.refund_claimed_at) >= ${from}::timestamptz)
       AND (${to}::timestamptz IS NULL OR COALESCE(c.refunded_at, c.refund_claimed_at) < ${to}::timestamptz)
       AND (${like}::text IS NULL OR lower(coalesce(c.email, '')) LIKE ${like} OR lower(coalesce(c.razorpay_refund_id, '')) LIKE ${like})`);
  const paidOut = await one(() => sql`
    SELECT COALESCE(sum(p.net), 0) AS n FROM payouts p LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN hosts h ON h.id = p.host_id
     WHERE p.status = 'sent'
       AND (${from}::timestamptz IS NULL OR COALESCE(p.sent_at, p.created_at) >= ${from}::timestamptz)
       AND (${to}::timestamptz IS NULL OR COALESCE(p.sent_at, p.created_at) < ${to}::timestamptz)
       AND (${like}::text IS NULL OR lower(coalesce(h.email, '')) LIKE ${like} OR lower(coalesce(h.name, '')) LIKE ${like}
            OR lower(coalesce(o.suite_name, '')) LIKE ${like} OR lower(coalesce(p.razorpayx_payout_id, '')) LIKE ${like})`);
  const dueOut = await one(() => sql`
    SELECT COALESCE(sum(p.net), 0) AS n FROM payouts p LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN hosts h ON h.id = p.host_id
     WHERE p.status = 'due'
       AND (${from}::timestamptz IS NULL OR COALESCE(p.sent_at, p.created_at) >= ${from}::timestamptz)
       AND (${to}::timestamptz IS NULL OR COALESCE(p.sent_at, p.created_at) < ${to}::timestamptz)
       AND (${like}::text IS NULL OR lower(coalesce(h.email, '')) LIKE ${like} OR lower(coalesce(h.name, '')) LIKE ${like}
            OR lower(coalesce(o.suite_name, '')) LIKE ${like} OR lower(coalesce(p.razorpayx_payout_id, '')) LIKE ${like})`);
  const out = Math.round(refunded + groupRefunded + paidOut);
  return { in: Math.round(inPaid), out, refunded: Math.round(refunded + groupRefunded), paidOut: Math.round(paidOut),
           dueOut: Math.round(dueOut), net: Math.round(inPaid) - out };
}

module.exports = { ledger, totals, ready, refundFor };
