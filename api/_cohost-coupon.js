// The Aerva mark on every email (api/_email-shell.js, owner 14 Nov 2026):
// requiring it brands everything this process sends.
require('./_email-shell');
// /api/_cohost-coupon.js — a co-host asks the host to cover the guest's
// cancellation coupon they paid. Not an endpoint (host-listings.js routes
// here; database: migrations/2026-11-10-08-cohost-coupon-requests.sql).
//
// THE RULE (owner, 10 Nov 2026)
//   1. A co-host who cancels within 48 hours of check-in still pays the
//      guest's 10% coupon themselves, before the booking is cancelled
//      (host-listings.js buyCouponOrder → verifyCouponPayment). Unchanged.
//   2. They MAY ask the host to cover it: a tick box on the cancel screen,
//      or later from their earnings view, within ASK_DAYS (30) days of the
//      cancellation. A note to the host (up to 300 characters) is optional;
//      contact details are removed from it, like in messages.
//   3. Only the host's own account answers (never another co-host), within
//      ANSWER_DAYS (7) days. No answer = expired.
//   4. ACCEPTED: Aerva moves the amount between two payouts — no
//      commission and no fee. TDS: nothing changes for the host; the
//      co-host's side carries TDS like their normal share (see below).
//        • host:    a host_penalties row, kind 'cohost_coupon', deducted
//                   from the host's NEXT payout by _payouts.js planPayouts
//                   (after the host's own TDS, whole, when it fits; otherwise
//                   it waits for the next one that it fits in). The host's
//                   TDS base is unchanged;
//        • co-host: when that payout has actually been SENT (the deduction
//                   is 'recovered'), a payout row of its own to the co-host,
//                   payouts.kind 'cohost-coupon', sent like any other payout
//                   (RazorpayX, or by hand in Admin → Payouts): the coupon
//                   amount, less TDS at the co-host's own rate.
//      THE AMOUNT IS FIXED AT CANCELLATION: what the co-host actually paid
//      for the coupon (coupons.amount), copied to the request when they ask
//      (cohost_coupon_requests.amount) and from there to the deduction and
//      the co-host's payout. Nothing later — a refund, a change to the
//      booking, another deduction, the coupon being used or expiring — ever
//      recalculates it. Only the TDS on it depends on the co-host's PAN and
//      year, as for any payout.
//      So money is never paid to the co-host before it is taken from the
//      host. Each step is guarded by a unique index, so nothing is applied
//      twice: one request per booking, one deduction per request, one
//      co-host payout per booking and co-host.
//   5. DECLINED or EXPIRED: nothing moves through Aerva. The co-host is
//      told, and that they can settle with the host directly. A declined or
//      expired request cannot be sent again.
//
// FOR THE CA (TDS) — the owner's rule of 10 Nov 2026 (it replaces the first
// version of the same day, which deducted no TDS on the reimbursement).
//   • Host: the deduction is taken after the host's own TDS, in full, so
//     the host's TDS base stays the booking amount due to them.
//   • Co-host: TDS IS deducted from the reimbursement, by the same rules as
//     their share (_tds.js tdsForPayout): 0.1% with a PAN, 5% with no PAN
//     or an inoperative one; and, only if the ₹5,00,000 exemption for
//     individuals/HUFs is ever switched on (TDS_THRESHOLD_INDIVIDUAL), it
//     counts toward the year's total and the catch-up rules apply. The row
//     carries tds, tds_rate, tds_base (= the coupon amount), tds_reason,
//     tds_catchup_base and tds_fy (the financial year its row is created
//     in), so it is in the TDS return / CSV (Admin → Payouts → TDS), the
//     co-host's yearly total, their monthly statement and Accounts (TDS
//     payable). Like a booking payout, its TDS is worked out again just
//     before it is sent (_payouts.js refreshTds): a PAN added or marked
//     inoperative since counts.
//     Example: coupon ₹1,100, PAN on file → TDS ₹1.10, ₹1,098.90 paid;
//     no PAN → TDS ₹55, ₹1,045 paid. The host is charged ₹1,100 either way.
//
// Before the database update has run every function here answers "not
// available" (ready() is false) and nothing else changes.

const { logAudit } = require('./_audit-log');
const { redactContactInfo } = require('./_redact');
const { tdsForPayout } = require('./_tds');

const ASK_DAYS = 30;          // from the cancellation, to ask
const ANSWER_DAYS = 7;        // for the host to answer
const NOTE_MAX = 300;
const PENALTY_KIND = 'cohost_coupon';     // host_penalties.kind
const PAYOUT_KIND = 'cohost-coupon';      // payouts.kind
const SITE = 'https://aerva.in';
const MIGRATION = '2026-11-10-08-cohost-coupon-requests.sql';

const userError = (message, status = 400, extra) => Object.assign(new Error(message), { isUserFacing: true, status }, extra ? { extra } : {});
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => { const v = Math.round((Number(n) || 0) * 100) / 100; return '₹' + v.toLocaleString('en-IN', Number.isInteger(v) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const firstName = (first, name, fallback) => String(first || '').trim().split(/\s+/)[0] || String(name || '').trim().split(/\s+/)[0] || fallback;
const dayText = (v) => {
  if (!v) return '';
  const d = new Date(String(v instanceof Date ? v.toISOString() : v).slice(0, 10) + 'T00:00:00Z');
  return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

// Has the database update run? True is remembered; false is asked again.
let isReady = false;
// SWITCHED OFF (owner, 11 Nov 2026): for now a host and a co-host settle the
// coupon between themselves, outside Aerva. Nothing new can be asked or
// answered and the pages do not offer it, unless COHOST_COUPON_REQUESTS=1 is
// set in the environment (nothing is processed while it is off; the feature
// had not gone live before the switch, so no request is left half way).
const switchedOn = () => String(process.env.COHOST_COUPON_REQUESTS || '').trim() === '1';
async function ready(sql) {
  if (!switchedOn()) return false;
  if (isReady) return true;
  try { await sql`SELECT id, cohost_payout_id FROM cohost_coupon_requests LIMIT 0`; await sql`SELECT cohost_coupon_request_id FROM host_penalties LIMIT 0`; isReady = true; }
  catch (e) { isReady = false; }
  return isReady;
}

async function email(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return;
  try {
    await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html }) });
  } catch (err) { console.error('email failed:', subject, err.message); }
}
const wrap = (inner) => `<div style="font-family:Helvetica,Arial,sans-serif; max-width:520px; margin:0 auto; color:#1c1a17; font-size:15px; line-height:1.55;">
  <p style="text-align:center; font-size:13px; letter-spacing:0.12em; color:#8a6c39;">AERVA</p>${inner}</div>`;

// The note to the host: trimmed, at most 300 characters, contact details removed.
function cleanNote(note) {
  const raw = String(note == null ? '' : note).replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
  if (!raw) return null;
  const r = redactContactInfo(raw);
  const text = String((r && r.displayText) || '').trim().slice(0, NOTE_MAX);
  return text || null;
}

// Everything shown about one request (to the host, the co-host or the admin).
function view(r) {
  return {
    id: r.id, orderId: r.order_id, booking: r.code, listing: r.suite_name || '', arrival: r.arrival, departure: r.departure,
    guestFirstName: firstName(r.guest_first, r.guest_name, 'Guest'), cancelledAt: r.cancelled_at, reason: r.cancellation_reason || '',
    amount: Number(r.amount), note: r.note || '', status: r.status, askedAt: r.created_at, answerBy: r.expires_at, decidedAt: r.decided_at,
    cohostFirstName: firstName(r.cohost_first, r.cohost_name, 'Your co-host'), hostName: r.host_name || 'the host',
    reimbursedAt: r.reimbursed_at, cohostPayoutId: r.cohost_payout_id || null
  };
}
// where: { id } | { hostId } (waiting, or answered in the last 30 days) |
// { cohostGuestId } | {} (all, newest first; at most 200).
async function load(sql, where = {}) {
  const id = Number(where.id) || null, hostId = Number(where.hostId) || null, co = Number(where.cohostGuestId) || null;
  return sql`
    SELECT r.id, r.order_id, r.host_id, r.cohost_guest_id, r.coupon_id, r.amount, r.note, r.asked_from, r.status, r.created_at, r.expires_at,
           r.decided_at, r.decided_by, r.host_payout_id, r.cohost_payout_id, r.reimbursed_at,
           o.suite_name, o.arrival, o.departure, o.cancelled_at, o.cancellation_reason, COALESCE(to_jsonb(o)->>'confirmation_code', '#' || o.id) AS code,
           to_jsonb(o)->>'guest_first_name' AS guest_first, gg.name AS guest_name,
           to_jsonb(cg)->>'first_name' AS cohost_first, cg.name AS cohost_name, cg.email AS cohost_email, h.name AS host_name
    FROM cohost_coupon_requests r JOIN orders o ON o.id = r.order_id LEFT JOIN guests gg ON gg.id = o.guest_id
    JOIN guests cg ON cg.id = r.cohost_guest_id JOIN hosts h ON h.id = r.host_id
    WHERE (${id}::int IS NULL OR r.id = ${id}::int)
      AND (${hostId}::int IS NULL OR (r.host_id = ${hostId}::int AND (r.status = 'pending' OR COALESCE(r.reimbursed_at, r.decided_at) > now() - interval '30 days')))
      AND (${co}::int IS NULL OR r.cohost_guest_id = ${co}::int)
    ORDER BY (r.status = 'pending') DESC, r.id DESC LIMIT 200`;
}
const rowsOf = (res) => (Array.isArray(res) ? res : (res && res.rows) || []);

// ---------------------------------------------------------------------
// Can this co-host ask the host to cover the coupon of this booking?
// Yes only when: the booking is cancelled; a coupon for it was PAID by this
// account (so a booking the host cancelled themselves, or one cancelled
// more than 48 hours before check-in with no coupon, never qualifies); the
// account is not the host's own, and is (or was) a co-host of that host;
// the cancellation is at most 30 days old; nothing was asked before.
// Returns { ok, why, order, coupon }.
async function eligibility(sql, { orderId, cohostGuestId }) {
  const o = (await sql`
    SELECT o.id, o.status, o.cancelled_at, l.host_id, (o.cancelled_at IS NOT NULL AND o.cancelled_at < now() - make_interval(days => ${ASK_DAYS})) AS too_late,
           (o.cancelled_at + make_interval(days => ${ASK_DAYS})) AS ask_by
    FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${Number(orderId) || 0}`)[0];
  if (!o) return { ok: false, why: 'not_found', message: 'Booking not found.' };
  const me = (await sql`SELECT id, host_id FROM guests WHERE id = ${Number(cohostGuestId) || 0}`)[0];
  if (!me) return { ok: false, why: 'not_found', message: 'Booking not found.' };
  const co = await sql`SELECT 1 FROM cohosts WHERE host_id = ${o.host_id} AND cohost_guest_id = ${me.id} LIMIT 1`;
  if (Number(me.host_id) === Number(o.host_id) || !co.length) return { ok: false, why: 'not_cohost', message: 'Only the co-host who paid the guest’s coupon can ask the host to cover it.' };
  if (o.status !== 'cancelled') return { ok: false, why: 'not_cancelled', message: 'This booking has not been cancelled.' };
  const coupon = (await sql`
    SELECT id, amount FROM coupons
    WHERE source_order_id = ${o.id} AND issuing_host_id = ${o.host_id} AND paid_by_guest_id = ${me.id} AND razorpay_payment_id IS NOT NULL
      AND status NOT IN ('pending_payment', 'abandoned', 'refunded', 'refund_due')
    ORDER BY id DESC LIMIT 1`)[0];
  if (!coupon || !(Number(coupon.amount) > 0)) return { ok: false, why: 'no_coupon', message: 'You did not pay a coupon for this booking, so there is nothing to ask the host to cover.' };
  const asked = (await sql`SELECT id, status FROM cohost_coupon_requests WHERE order_id = ${o.id}`)[0];
  if (asked) return { ok: false, why: 'already_asked', message: 'The host has already been asked about this coupon. It can be asked only once per cancelled booking.', request: asked };
  if (o.too_late) return { ok: false, why: 'too_late', message: `The host can be asked only within ${ASK_DAYS} days of the cancellation. You can still settle it with the host directly.` };
  return { ok: true, order: o, coupon, askBy: o.ask_by };
}

// The co-host asks. from: 'cancel' (the tick box) | 'later'. Returns the request's view.
async function ask(sql, { orderId, cohostGuestId, note, from = 'later' }) {
  if (!switchedOn()) throw userError('A host and a co-host settle the coupon between themselves, outside Aerva.', 409);
  if (!(await ready(sql))) throw userError(`This is not available yet (database update ${MIGRATION}).`, 503);
  const e = await eligibility(sql, { orderId, cohostGuestId });
  if (!e.ok) throw userError(e.message, e.why === 'already_asked' ? 409 : e.why === 'not_found' ? 404 : e.why === 'not_cohost' ? 403 : 400, { why: e.why });
  const text = cleanNote(note);
  const made = await sql`
    INSERT INTO cohost_coupon_requests (order_id, host_id, cohost_guest_id, coupon_id, amount, note, asked_from, expires_at)
    VALUES (${e.order.id}, ${e.order.host_id}, ${Number(cohostGuestId)}, ${e.coupon.id}, ${Number(e.coupon.amount)}, ${text}, ${from === 'cancel' ? 'cancel' : 'later'},
            now() + make_interval(days => ${ANSWER_DAYS}))
    ON CONFLICT (order_id) DO NOTHING RETURNING id`;
  if (!made.length) throw userError('The host has already been asked about this coupon. It can be asked only once per cancelled booking.', 409, { why: 'already_asked' });
  const r = view(rowsOf(await load(sql, { id: made[0].id }))[0]);
  await logAudit(sql, { action: 'cohost_coupon_request_sent', success: true, actorType: 'cohost', actorIdentifier: String(cohostGuestId), targetType: 'order', targetId: r.orderId,
    metadata: { requestId: r.id, amount: r.amount, hostId: e.order.host_id, from, note: !!text } });
  // The host is told: email here; the dashboard card and the bell read the table.
  try {
    const to = ((await sql`SELECT email FROM guests WHERE host_id = ${e.order.host_id} AND deleted_at IS NULL ORDER BY id LIMIT 1`)[0] || {}).email;
    await email(to, `${r.cohostFirstName} asks you to cover a ${inr(r.amount)} cancellation coupon`, wrap(`
      <h2 style="font-size:20px; margin:8px 0 12px;">Your co-host asks you to cover a coupon</h2>
      <p>${esc(r.cohostFirstName)} cancelled a booking for you within 48 hours of check-in and paid the guest’s Aerva coupon themselves. They ask you to cover it.</p>
      <table style="width:100%; border-collapse:collapse; margin:12px 0;">
        <tr><td style="padding:5px 0; color:#6e675d;">Booking</td><td style="padding:5px 0; text-align:right;">${esc(r.booking)} · ${esc(r.listing)}</td></tr>
        <tr><td style="padding:5px 0; color:#6e675d;">Dates</td><td style="padding:5px 0; text-align:right;">${esc(dayText(r.arrival))} – ${esc(dayText(r.departure))}</td></tr>
        <tr><td style="padding:5px 0; color:#6e675d;">Guest</td><td style="padding:5px 0; text-align:right;">${esc(r.guestFirstName)}</td></tr>
        <tr><td style="padding:5px 0; color:#6e675d;">Reason given</td><td style="padding:5px 0; text-align:right;">${esc(r.reason || '—')}</td></tr>
        <tr><td style="padding:5px 0; color:#6e675d;">Coupon</td><td style="padding:5px 0; text-align:right; font-weight:bold;">${esc(inr(r.amount))}</td></tr>
      </table>
      ${r.note ? `<p style="background:#faf6ef; border-radius:10px; padding:12px 14px;"><strong>${esc(r.cohostFirstName)} wrote:</strong> ${esc(r.note)}</p>` : ''}
      <p><strong>If you accept</strong>, ${esc(inr(r.amount))} is deducted from your next payout, after your own TDS (your TDS does not change), and paid to ${esc(r.cohostFirstName)} once that payout has been sent. Aerva charges no commission and no fee on it; TDS is deducted from ${esc(r.cohostFirstName)}’s side at their own rate, as on their share.</p>
      <p><strong>If you decline, or do not answer by ${esc(dayText(r.answerBy))}</strong>, nothing moves through Aerva.</p>
      <p style="text-align:center; margin:22px 0;"><a href="${SITE}/host-dashboard.html?coupon=${r.id}" style="display:inline-block; background:#1c1a17; color:#fff; padding:12px 22px; border-radius:999px; text-decoration:none;">Answer on Aerva</a></p>
      <p style="font-size:12.5px; color:#888;">Only you can answer, from your own account.</p>`));
  } catch (err) { console.error('co-host coupon request: host not emailed:', err.message); }
  return r;
}

// Tell the co-host what became of their request (email; the bell reads the table).
async function tellCohost(r, outcome, sql) {
  // What the co-host can expect to receive: TDS as it stands today (their
  // PAN and year); the payout itself is worked out when it is created.
  let tdsLine = `TDS is deducted from it at your own rate, as on your co-host share: 0.1% with a PAN on file, 5% without one or if your PAN is inoperative. It counts in your Form 26AS like your other payouts.`;
  if (outcome === 'accepted' && sql) {
    try {
      const payee = await require('./_payouts').cohostPayee(sql, r.cohostGuestId);
      const t = await tdsForPayout(sql, { payee: { payeeType: 'cohost', payeeGuestId: r.cohostGuestId }, base: round2(r.amount), pan: (payee && payee.pan) || {} });
      const tds = Math.min(round2(r.amount), t.tds);
      const why = t.reason === 'no_pan' ? `${t.rate}%, no PAN on file` : t.reason === 'inoperative_pan' ? `${t.rate}%, your PAN is not linked to Aadhaar` : t.reason === 'threshold_crossed' ? `${t.rate}%, including this year’s earlier payouts` : `${t.rate}%`;
      tdsLine = tds > 0
        ? `TDS is deducted from it at your own rate, as on your co-host share. As things stand today: ${esc(inr(r.amount))} − TDS ${esc(inr(tds))} (${esc(why)}) = <strong>${esc(inr(round2(r.amount - tds)))}</strong> paid to you. The TDS is worked out when the payout is made, is credited against your PAN and shows in your Form 26AS.`
        : t.reason === 'below_threshold'
        ? `TDS applies to it as to your co-host share. As things stand today no TDS is due on it (your earnings through Aerva this financial year are within ₹5,00,000), so ${esc(inr(r.amount))} is paid to you; it counts toward your year’s total.`
        : tdsLine;
    } catch (e) { /* the general line */ }
  }
  const settle = 'Nothing moves through Aerva for this coupon. You can settle it with the host directly.';
  const text = outcome === 'accepted'
    ? `<p>${esc(r.hostName)} agreed to cover the ${esc(inr(r.amount))} coupon you paid for booking ${esc(r.booking)} (${esc(r.listing)}).</p>
       <p>The full ${esc(inr(r.amount))} is deducted from their next payout and paid to you once that payout has been sent. Aerva takes no commission and no fee on it.</p>
       <p>${tdsLine}</p>
       <p>It shows in your payout summary as “Coupon for booking ${esc(r.booking)} (reimbursed by host)”, with the TDS on its own line.</p>`
    : outcome === 'declined'
    ? `<p>${esc(r.hostName)} declined to cover the ${esc(inr(r.amount))} coupon you paid for booking ${esc(r.booking)} (${esc(r.listing)}).</p><p>${settle}</p>`
    : outcome === 'expired'
    ? `<p>${esc(r.hostName)} did not answer within ${ANSWER_DAYS} days about the ${esc(inr(r.amount))} coupon you paid for booking ${esc(r.booking)} (${esc(r.listing)}), so the request has closed.</p><p>${settle}</p>`
    : `<p>The ${esc(inr(r.amount))} coupon for booking ${esc(r.booking)} (${esc(r.listing)}) will not be deducted from ${esc(r.hostName)}’s payout after all.</p><p>${settle}</p>`;
  const subject = outcome === 'accepted' ? `Your host will cover the ${inr(r.amount)} coupon`
    : outcome === 'declined' ? `Your host declined to cover the ${inr(r.amount)} coupon`
    : outcome === 'expired' ? `No answer from your host about the ${inr(r.amount)} coupon`
    : `The ${inr(r.amount)} coupon will not be covered through Aerva`;
  await email(r.cohostEmail, subject, wrap(`<h2 style="font-size:20px; margin:8px 0 12px;">${esc(subject)}</h2>${text}
    <p style="text-align:center; margin:22px 0;"><a href="${SITE}/host-earnings.html" style="color:#8a6c39;">Open your earnings on Aerva</a></p>`));
}

// Requests left unanswered for 7 days: closed, the co-host told. Runs in
// the scheduled job (get-listings.js JOBS booking_changes_expiry) and before
// every read or answer here, so a late answer can never count.
async function expireDue(sql) {
  const out = { expired: 0 };
  if (!(await ready(sql))) return { ...out, skipped: 'database update not applied' };
  const done = await sql`UPDATE cohost_coupon_requests SET status = 'expired', decided_at = now()
                         WHERE status = 'pending' AND expires_at <= now() RETURNING id`;
  for (const d of done) {
    try {
      const row = rowsOf(await load(sql, { id: d.id }))[0];
      const r = Object.assign(view(row), { cohostEmail: row.cohost_email });
      await logAudit(sql, { action: 'cohost_coupon_request_expired', success: true, actorType: 'system', targetType: 'order', targetId: r.orderId,
        metadata: { requestId: r.id, amount: r.amount, hostName: r.hostName, cohostName: row.cohost_name, cohostEmail: row.cohost_email, listing: r.listing } });
      await tellCohost(r, 'expired');
    } catch (err) { console.error('expired co-host coupon request: co-host not told:', d.id, err.message); }
    out.expired++;
  }
  return out;
}

// The host answers. Only an account of that host — never a co-host, whatever
// their access. Accepting records the deduction in the SAME statement that
// claims the request, so two clicks (or two tabs) can never record two.
async function answer(sql, { requestId, guestId, accept }) {
  if (!switchedOn()) throw userError('A host and a co-host settle the coupon between themselves, outside Aerva.', 409);
  if (!(await ready(sql))) throw userError(`This is not available yet (database update ${MIGRATION}).`, 503);
  await expireDue(sql);
  const row = rowsOf(await load(sql, { id: requestId }))[0];
  const me = (await sql`SELECT id, host_id FROM guests WHERE id = ${Number(guestId) || 0}`)[0];
  if (!row || !me) throw userError('That request could not be found.', 404);
  if (!me.host_id || Number(me.host_id) !== Number(row.host_id)) throw userError('Only the host can answer this, from their own account.', 403);
  const r = Object.assign(view(row), { cohostEmail: row.cohost_email });
  if (row.status === 'expired') throw userError(`This request closed without an answer after ${ANSWER_DAYS} days. Nothing moves through Aerva.`, 409, { status: 'expired' });
  if (row.status !== 'pending') throw userError('This request has already been answered.', 409, { status: row.status });
  if (!accept) {
    const d = await sql`UPDATE cohost_coupon_requests SET status = 'declined', decided_at = now(), decided_by = ${me.id}
                        WHERE id = ${row.id} AND status = 'pending' AND host_id = ${me.host_id} RETURNING id`;
    if (!d.length) throw userError('This request has already been answered.', 409);
    await logAudit(sql, { action: 'cohost_coupon_request_declined', success: true, actorType: 'host', actorIdentifier: String(me.id), targetType: 'order', targetId: r.orderId, metadata: { requestId: r.id, amount: r.amount } });
    try { await tellCohost(r, 'declined'); } catch (err) { /* told by the bell */ }
    return { declined: true, request: Object.assign(r, { status: 'declined' }) };
  }
  const note = `Coupon for booking ${r.booking}, cancelled by co-host ${r.cohostFirstName}: reimbursed to them (request #${r.id})`.slice(0, 300);
  const pen = await sql`
    WITH claimed AS (
      UPDATE cohost_coupon_requests SET status = 'accepted', decided_at = now(), decided_by = ${me.id}
      WHERE id = ${row.id} AND status = 'pending' AND expires_at > now() AND host_id = ${me.host_id}
      RETURNING id, host_id, order_id, amount
    )
    INSERT INTO host_penalties (host_id, order_id, amount, payer_guest_id, kind, note, cohost_coupon_request_id)
    SELECT host_id, order_id, amount, NULL::integer, ${PENALTY_KIND}::text, ${note}::text, id FROM claimed
    ON CONFLICT DO NOTHING RETURNING id`;
  if (!pen.length) throw userError('This request has already been answered.', 409);
  await logAudit(sql, { action: 'cohost_coupon_request_accepted', success: true, actorType: 'host', actorIdentifier: String(me.id), targetType: 'order', targetId: r.orderId,
    metadata: { requestId: r.id, amount: r.amount, penaltyId: pen[0].id, cohostGuestId: row.cohost_guest_id } });
  try { await tellCohost(Object.assign(r, { cohostGuestId: row.cohost_guest_id }), 'accepted', sql); } catch (err) { /* told by the bell */ }
  return { accepted: true, amount: r.amount, request: Object.assign(r, { status: 'accepted' }) };
}

// ---------------------------------------------------------------------
// The co-host's side of the move. Called when a host payout is sent
// (_payouts.js markPayoutSent, right after its deductions are marked
// recovered), by the payouts job (a sweep, for anything left behind) and
// after an admin settles a deduction by hand. For every ACCEPTED request:
//   • its deduction is 'recovered' (taken from the host) → the co-host's
//     payout row is created ('due'), once, and the request is 'reimbursed';
//   • its deduction was written off by Aerva → the request is 'closed':
//     nothing was taken from the host, so nothing is paid to the co-host.
// Never throws. opts.send: false leaves the new payout for the next run.
async function settleDeducted(sql, opts = {}) {
  const out = { reimbursed: 0, closed: 0, payoutIds: [] };
  try {
    if (!(await ready(sql))) return out;
    const rows = await sql`
      SELECT r.id, r.order_id, r.host_id, r.cohost_guest_id, r.amount, hp.id AS penalty_id, hp.status AS penalty_status,
             (SELECT p.id FROM payouts p WHERE p.status = 'sent' AND hp.id = ANY(p.deducted_penalty_ids) ORDER BY p.id LIMIT 1) AS host_payout_id
      FROM cohost_coupon_requests r JOIN host_penalties hp ON hp.cohost_coupon_request_id = r.id
      WHERE r.status = 'accepted' AND hp.status <> 'owed' ORDER BY r.id LIMIT 50`;
    const P = require('./_payouts');
    for (const r of rows) {
      try {
        if (r.penalty_status !== 'recovered' && r.penalty_status !== 'paid') {
          const c = await sql`UPDATE cohost_coupon_requests SET status = 'closed' WHERE id = ${r.id} AND status = 'accepted' RETURNING id`;
          if (c.length) {
            out.closed++;
            const row = rowsOf(await load(sql, { id: r.id }))[0];
            await logAudit(sql, { action: 'cohost_coupon_request_closed', success: true, actorType: 'system', targetType: 'order', targetId: r.order_id, metadata: { requestId: r.id, amount: Number(r.amount), penaltyStatus: r.penalty_status } });
            try { await tellCohost(Object.assign(view(row), { cohostEmail: row.cohost_email }), 'closed'); } catch (e) { /* told by the bell */ }
          }
          continue;
        }
        // Taken from the host: the co-host's own payout row. No commission
        // and no fee; TDS at the co-host's own rate, like their share, on
        // the coupon amount fixed on the request (never worked out again).
        // ON CONFLICT (one per booking, co-host and kind).
        const payee = await P.cohostPayee(sql, r.cohost_guest_id);
        const amount = round2(r.amount);
        const t = await tdsForPayout(sql, { payee: { payeeType: 'cohost', payeeGuestId: r.cohost_guest_id }, base: amount, pan: (payee && payee.pan) || {} });
        const tds = Math.min(amount, t.tds);
        const panOk = t.reason !== 'no_pan' && t.reason !== 'inoperative_pan';
        let made = (await sql`
          INSERT INTO payouts (order_id, payee_type, host_id, payee_guest_id, status, gross, commission, cohost_shares, deductions, deducted_penalty_ids, tds, tds_rate, pan_furnished, net, bank_label, auto_eligible, kind,
                               tds_base, tds_reason, tds_catchup_base, tds_fy)
          VALUES (${r.order_id}, 'cohost', ${r.host_id}, ${r.cohost_guest_id}, 'due', ${amount}, 0, 0, 0, ${[]}, ${tds}, ${t.rate}, ${panOk}, ${round2(amount - tds)},
                  ${(payee && payee.bankLabel) || null}, ${P.razorpayxReady()}, ${PAYOUT_KIND}, ${t.base}, ${t.reason}, ${t.catchupBase}, ${t.fy})
          ON CONFLICT DO NOTHING RETURNING id`)[0];
        const fresh = !!made;
        if (!made) made = (await sql`SELECT id FROM payouts WHERE order_id = ${r.order_id} AND payee_type = 'cohost' AND payee_guest_id = ${r.cohost_guest_id} AND kind = ${PAYOUT_KIND}`)[0];
        if (!made) continue;
        const done = await sql`UPDATE cohost_coupon_requests SET status = 'reimbursed', reimbursed_at = now(), cohost_payout_id = ${made.id}, host_payout_id = ${r.host_payout_id || null}
                               WHERE id = ${r.id} AND status = 'accepted' RETURNING id`;
        if (!done.length) continue;
        out.reimbursed++; out.payoutIds.push(made.id);
        await logAudit(sql, { action: 'cohost_coupon_reimbursement_due', success: true, actorType: 'system', targetType: 'order', targetId: r.order_id,
          metadata: { requestId: r.id, amount, tds, tdsRate: t.rate, tdsReason: t.reason, net: round2(amount - tds), penaltyId: r.penalty_id, hostPayoutId: r.host_payout_id || null, cohostPayoutId: made.id, cohostGuestId: r.cohost_guest_id } });
        if (fresh && opts.send !== false && P.razorpayxReady()) { try { await P.attemptPayout(sql, made.id); } catch (e) { /* retried every 4 hours */ } }
      } catch (err) { console.error('co-host coupon reimbursement not created (retried by the payouts job):', r.id, err.message); }
    }
  } catch (err) { console.error('co-host coupon reimbursements skipped:', err.message); }
  return out;
}

// ---------------------------------------------------------------------
// Reading

// The host's dashboard card: what waits for them, and what they answered lately.
async function forHost(sql, guestId) {
  if (!(await ready(sql))) return { available: false, requests: [] };
  const me = (await sql`SELECT host_id FROM guests WHERE id = ${Number(guestId) || 0}`)[0];
  if (!me || !me.host_id) return { available: true, requests: [] };
  await expireDue(sql);
  return { available: true, answerDays: ANSWER_DAYS, requests: rowsOf(await load(sql, { hostId: me.host_id })).map(view) };
}
// The co-host's own side (earnings view): what they have asked, and the
// coupons they paid that they can still ask about (within 30 days).
async function forCohost(sql, guestId) {
  if (!(await ready(sql))) return { available: false, requests: [], askable: [] };
  await expireDue(sql);
  const gid = Number(guestId) || 0;
  const open = await sql`
    SELECT o.id, o.suite_name, o.arrival, o.departure, o.cancelled_at, o.cancellation_reason, COALESCE(to_jsonb(o)->>'confirmation_code', '#' || o.id) AS code,
           to_jsonb(o)->>'guest_first_name' AS guest_first, gg.name AS guest_name, h.name AS host_name, c.amount,
           (o.cancelled_at + make_interval(days => ${ASK_DAYS})) AS ask_by
    FROM coupons c JOIN orders o ON o.id = c.source_order_id JOIN listings l ON l.id = o.listing_id JOIN hosts h ON h.id = l.host_id
    LEFT JOIN guests gg ON gg.id = o.guest_id
    WHERE c.paid_by_guest_id = ${gid} AND c.issuing_host_id = l.host_id AND c.razorpay_payment_id IS NOT NULL
      AND c.status NOT IN ('pending_payment', 'abandoned', 'refunded', 'refund_due')
      AND o.status = 'cancelled' AND o.cancelled_at > now() - make_interval(days => ${ASK_DAYS})
      AND l.host_id IS DISTINCT FROM (SELECT host_id FROM guests WHERE id = ${gid})
      AND EXISTS (SELECT 1 FROM cohosts ch WHERE ch.host_id = l.host_id AND ch.cohost_guest_id = ${gid})
      AND NOT EXISTS (SELECT 1 FROM cohost_coupon_requests r WHERE r.order_id = o.id)
    ORDER BY o.cancelled_at DESC LIMIT 50`;
  const seen = new Set();
  const askable = open.filter(o => !seen.has(o.id) && seen.add(o.id)).map(o => ({
    orderId: o.id, booking: o.code, listing: o.suite_name || '', arrival: o.arrival, departure: o.departure, cancelledAt: o.cancelled_at,
    guestFirstName: firstName(o.guest_first, o.guest_name, 'Guest'), reason: o.cancellation_reason || '', hostName: o.host_name || 'the host',
    amount: Number(o.amount), askBy: o.ask_by }));
  return { available: true, askDays: ASK_DAYS, answerDays: ANSWER_DAYS, noteMax: NOTE_MAX, askable, requests: (await load(sql, { cohostGuestId: gid })).map(view) };
}

// The bell (guest-auth.js): for the host, requests waiting; for the co-host,
// what became of theirs in the last 30 days.
async function bellNotifications(sql, { hostId, guestId }) {
  const out = [];
  try {
    if (!(await ready(sql))) return out;
    if (hostId) {
      const rows = await sql`SELECT r.id, r.amount, r.expires_at, o.suite_name, to_jsonb(cg)->>'first_name' AS cohost_first, cg.name AS cohost_name
                             FROM cohost_coupon_requests r JOIN orders o ON o.id = r.order_id JOIN guests cg ON cg.id = r.cohost_guest_id
                             WHERE r.host_id = ${hostId} AND r.status = 'pending' AND r.expires_at > now() ORDER BY r.id DESC LIMIT 5`;
      rows.forEach(r => out.push({ id: 'cohost-coupon:' + r.id, kind: 'action',
        title: `${firstName(r.cohost_first, r.cohost_name, 'Your co-host')} asks you to cover a ${inr(r.amount)} coupon`,
        body: `${r.suite_name || 'A cancelled booking'} — accept or decline by ${dayText(r.expires_at)}.`, href: 'host-dashboard.html?coupon=' + r.id }));
    }
    if (guestId) {
      const rows = await sql`SELECT r.id, r.amount, r.status, o.suite_name, h.name AS host_name
                             FROM cohost_coupon_requests r JOIN orders o ON o.id = r.order_id JOIN hosts h ON h.id = r.host_id
                             WHERE r.cohost_guest_id = ${guestId} AND r.status <> 'pending' AND COALESCE(r.reimbursed_at, r.decided_at) > now() - interval '30 days'
                             ORDER BY r.id DESC LIMIT 5`;
      rows.forEach(r => {
        const host = r.host_name || 'Your host', amt = inr(r.amount);
        const t = r.status === 'accepted' ? [`${host} will cover the ${amt} coupon`, 'It is deducted from their next payout and paid to you then.']
          : r.status === 'reimbursed' ? [`${amt} coupon reimbursed by ${host}`, 'Taken from their payout; it is on its way to you as a payout of its own, less TDS at your rate.']
          : r.status === 'declined' ? [`${host} declined to cover the ${amt} coupon`, 'Nothing moves through Aerva. You can settle it with the host directly.']
          : r.status === 'expired' ? [`No answer about the ${amt} coupon`, `${host} did not answer in ${ANSWER_DAYS} days. You can settle it with the host directly.`]
          : [`The ${amt} coupon will not be covered through Aerva`, 'You can settle it with the host directly.'];
        out.push({ id: 'cohost-coupon:' + r.id + ':' + r.status, kind: 'cohost-coupon', title: t[0], body: `${r.suite_name || 'Cancelled booking'} — ${t[1]}`, href: 'host-earnings.html' });
      });
    }
  } catch (err) { /* never blocks the bell */ }
  return out;
}

// Admin → Payouts (read-only): every request and where it stands.
async function adminList(sql) {
  if (!(await ready(sql))) return { available: false, requests: [] };
  await expireDue(sql);
  const rows = rowsOf(await load(sql));
  return { available: true, requests: rows.map(r => Object.assign(view(r), { hostId: r.host_id, cohostName: r.cohost_name || r.cohost_email || 'Co-host', hostPayoutId: r.host_payout_id || null })) };
}

// ---------------------------------------------------------------------
// Payout summaries and statements (_payouts.js, host-listings.js)

// The reimbursements among a host payout's deductions:
// [{ penaltyId, amount, label }] — "Coupon for booking <code>, cancelled by
// co-host <first name>". [] before the database update.
async function deductionLines(sql, penaltyIds) {
  if (!penaltyIds || !penaltyIds.length) return [];
  try {
    const rows = await sql`
      SELECT hp.id, hp.amount, COALESCE(to_jsonb(o)->>'confirmation_code', '#' || o.id) AS code, to_jsonb(cg)->>'first_name' AS cohost_first, cg.name AS cohost_name
      FROM host_penalties hp JOIN cohost_coupon_requests r ON r.id = hp.cohost_coupon_request_id
      JOIN orders o ON o.id = r.order_id JOIN guests cg ON cg.id = r.cohost_guest_id
      WHERE hp.id = ANY(${penaltyIds}) AND hp.kind = ${PENALTY_KIND} ORDER BY hp.id`;
    return rows.map(r => ({ penaltyId: r.id, amount: Number(r.amount), label: `Coupon for booking ${r.code}, cancelled by co-host ${firstName(r.cohost_first, r.cohost_name, '')}`.replace(/ $/, '') }));
  } catch (e) { return []; }
}
const reimbursementLabel = (code) => `Coupon for booking ${code} (reimbursed by host)`;
// Under a payout's lines. The co-host's: with the TDS line's own note (a
// missing PAN, the year's total) when there is one.
const REIMBURSEMENT_NOTE = 'A reimbursement from your host for the guest’s coupon you paid: no commission and no fee. TDS is deducted at your own rate, as on your co-host share, and counts toward your earnings through Aerva for the year.';
const DEDUCTION_NOTE = 'The coupon reimbursement to your co-host is taken in full after your TDS and does not change it. TDS on the reimbursement is deducted from your co-host’s side, not yours.';

module.exports = { ASK_DAYS, ANSWER_DAYS, NOTE_MAX, PENALTY_KIND, PAYOUT_KIND, ready, cleanNote, eligibility, ask, answer, expireDue, settleDeducted,
  forHost, forCohost, bellNotifications, adminList, deductionLines, reimbursementLabel, REIMBURSEMENT_NOTE, DEDUCTION_NOTE };
