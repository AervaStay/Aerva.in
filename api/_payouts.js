// /api/_payouts.js — payout summaries. Not an endpoint.
//
// Payouts are created automatically at 5 PM on the day after check-in
// (property's local time; for an experience, the day after its date) by
// runAutoPayouts (get-listings.js ?runSchedules=1, the daily
// cron and site traffic). With RazorpayX set up (RAZORPAYX_ACCOUNT_NUMBER)
// and approved bank details, they are sent there and then; otherwise they
// wait as 'due' for an admin to send by hand and record ("Mark paid").
// When a payout is SENT:
//   • the host or co-host is emailed this summary (sendPayoutEmail), and
//   • it shows as a website notification (guest-auth.js) that opens the
//     same summary (host-listings.js ?payoutDetail=<id>).
// Co-host shares: TDS only, and any amount they were overpaid before.
// A booking that changes after its payout was sent is settled by
// settleAfterPayout: an amount no longer owed is deducted from the payee's
// next payout (host_penalties, kind 'overpaid'); an amount added is paid as
// a payout of its own (payouts.kind 'adjustment-<n>').
// The summary is built from the saved payout row and its booking, so the
// email, the notification and the page always show the same figures.

const SITE = 'https://aerva.in';
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => {
  if (!v) return '';
  const d = new Date(String(v instanceof Date ? v.toISOString() : v).slice(0, 10) + 'T00:00:00Z');
  return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Everything the summary shows, for payout id — or null.
async function loadPayoutSummary(sql, payoutId) {
  const r = (await sql`
    SELECT p.*, o.suite_name, o.arrival, o.departure, o.id AS booking_id, o.razorpay_order_id, g.name AS guest_name,
           CASE WHEN p.payee_type = 'host' THEN h.name ELSE pg.name END AS payee_name
    FROM payouts p JOIN orders o ON o.id = p.order_id LEFT JOIN guests g ON g.id = o.guest_id
    JOIN hosts h ON h.id = p.host_id LEFT JOIN guests pg ON pg.id = p.payee_guest_id
    WHERE p.id = ${Number(payoutId) || 0}
  `)[0];
  if (!r) return null;
  const lines = r.kind === 'deposit'
    ? [['Security deposit compensation', Number(r.gross)]]
    : /^adjustment/.test(r.kind || '')
    ? [['Booking changed after your payout', Number(r.gross)]]
    : /^rest/.test(r.kind || '')
    ? [['Rest of your payout for this booking', Number(r.gross)]]
    : r.payee_type === 'host'
    ? [['Booking earnings', Number(r.gross)], ['Aerva commission', -Number(r.commission)], ['Co-host share', -Number(r.cohost_shares)]]
    : [['Co-host share', Number(r.gross)]]; // co-hosts: TDS only, no other deductions
  if (Number(r.deductions) > 0) {
    // What was deducted: cancellation coupons, and/or an amount paid before
    // on a booking that was reduced after its payout was sent.
    let kinds = ['coupon'];
    try { kinds = (await sql`SELECT DISTINCT COALESCE(to_jsonb(hp)->>'kind', 'coupon') AS k FROM host_penalties hp WHERE hp.id = ANY(${r.deducted_penalty_ids || []})`).map(x => x.k); } catch (e) { /* coupons */ }
    const label = kinds.length === 1 && kinds[0] === 'overpaid' ? 'Overpaid earlier, deducted' : kinds.includes('overpaid') ? 'Coupons and earlier overpayment deducted' : 'Cancellation coupons deducted';
    lines.push([label, -Number(r.deductions)]);
  }
  if (Number(r.tds) > 0) lines.push([tdsLabel(r), -Number(r.tds)]);
  return {
    id: r.id, orderId: r.order_id, status: r.status, payeeType: r.payee_type, payeeName: r.payee_name || '', hostId: r.host_id, payeeGuestId: r.payee_guest_id,
    amount: Number(r.net), sentAt: r.sent_at, arrivingBy: r.arriving_by, bank: r.bank_label || '', reference: r.reference,
    guestName: r.guest_name || 'Guest', listing: r.suite_name || '', arrival: r.arrival, departure: r.departure,
    // Same reference the guest's booking confirmation shows.
    booking: r.razorpay_order_id || ('#' + r.booking_id),
    lines: lines.filter(([, v]) => v !== 0 && !Object.is(v, -0)).map(([label, value]) => ({ label, value })),
    note: tdsNote(r),
    link: `${SITE}/index.html?payout=${r.id}`
  };
}

function payoutEmailHtml(s) {
  const rows = s.lines.map(l => `<tr><td style="padding:6px 0;">${esc(l.label)}</td><td style="padding:6px 0; text-align:right;">${l.value < 0 ? '−' : ''}${inr(Math.abs(l.value))}</td></tr>`).join('');
  return `
  <div style="font-family:Helvetica,Arial,sans-serif; max-width:520px; margin:0 auto; color:#1c1a17;">
    <p style="text-align:center; font-size:13px; letter-spacing:0.12em; color:#8a6c39;">AERVA</p>
    <h1 style="text-align:center; font-size:40px; margin:8px 0 4px;">${inr(s.amount)}</h1>
    <p style="text-align:center; color:#3a7d44; margin:0 0 24px;">● Sent ${esc(day(s.sentAt))}${s.arrivingBy ? ' · Arriving by ' + esc(day(s.arrivingBy)) : ''}</p>
    <div style="border:1px solid #e6dccd; border-radius:14px; padding:18px 20px; margin-bottom:16px;">
      <p style="margin:0 0 4px; font-weight:bold;">Bank account</p><p style="margin:0 0 14px; color:#555;">${esc(s.bank)}</p>
      <p style="margin:0 0 4px; font-weight:bold;">Payout ID</p><p style="margin:0; color:#555;">${esc(s.reference)}</p>
    </div>
    <div style="border:1px solid #e6dccd; border-radius:14px; padding:18px 20px;">
      <p style="margin:0; font-size:20px; font-weight:bold; text-align:center;">${esc(s.guestName)}</p>
      <p style="margin:4px 0 0; text-align:center; color:#555;">${esc(day(s.arrival))} – ${esc(day(s.departure))}<br>${esc(s.listing)}</p>
      <p style="margin:18px 0 4px; font-weight:bold;">Booking</p><p style="margin:0 0 14px; color:#555;">${esc(s.booking)}</p>
      <p style="margin:0 0 6px; font-weight:bold;">Earnings</p>
      <table style="width:100%; border-collapse:collapse; font-size:15px;">${rows}
        <tr><td style="padding:10px 0 0; border-top:1px solid #e6dccd; font-weight:bold;">Total (INR)</td><td style="padding:10px 0 0; border-top:1px solid #e6dccd; text-align:right; font-weight:bold;">${inr(s.amount)}</td></tr>
      </table>
      ${s.note ? `<p style="margin:12px 0 0; font-size:13px; color:#6e675d;">${esc(s.note)}</p>` : ''}
    </div>
    <p style="text-align:center; margin:22px 0 0;"><a href="${s.link}" style="color:#8a6c39;">View this payout on Aerva</a></p>
    <p style="font-size:12px; color:#888; text-align:center; margin-top:18px;">Questions about this payout? Contact hello@aerva.in.</p>
  </div>`;
}

async function sendPayoutEmail(to, s) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject: `Your payout of ${inr(s.amount)} has been sent`, html: payoutEmailHtml(s) })
  });
  return res.ok;
}

// Website notifications: payouts sent to this account in the last 30 days.
async function recentPayoutNotifications(sql, { hostId, guestId }) {
  try {
    const rows = await sql`
      SELECT p.id, p.net, p.arriving_by, o.suite_name FROM payouts p JOIN orders o ON o.id = p.order_id
      WHERE p.status = 'sent' AND p.sent_at > now() - interval '30 days'
        AND ((p.payee_type = 'host' AND p.host_id = ${hostId || 0}) OR (p.payee_type = 'cohost' AND p.payee_guest_id = ${guestId || 0}))
      ORDER BY p.sent_at DESC LIMIT 10
    `;
    return rows.map(r => ({
      id: 'payout:' + r.id, kind: 'payout',
      title: `Payout sent: ${inr(r.net)}`,
      body: `${r.suite_name || 'Booking'}${r.arriving_by ? ' · Arriving by ' + day(r.arriving_by) : ''}`,
      href: `index.html?payout=${r.id}`
    }));
  } catch (err) { return []; } // before migration_payouts.sql
}

// ---------------------------------------------------------------------
// Automatic payouts
// ---------------------------------------------------------------------
const PAYOUT_HOUR = 17;                                  // 5 PM, property's local time
// TDS: the rules are in _tds.js (0.1% with PAN, 5% without or inoperative,
// nothing for an individual/HUF within ₹5 lakh in the financial year).
// Applied to the host (on their part of the booking) and to co-hosts (on
// their share), so no amount is taxed twice.
const { tdsForPayout, tdsLabel, tdsNote } = require('./_tds');
const razorpayxReady = () => !!(process.env.RAZORPAYX_ACCOUNT_NUMBER && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const round2 = (n) => Math.round(n * 100) / 100;

// What each payee of a booking gets. Host: booking earnings − Aerva's
// commission − co-host shares − TDS (on that amount due) − cancellation
// coupons owed (as many whole ones as fit). Co-host: their share − TDS.
// opts.creditAt: the date the payout is credited (its row's creation;
// now for a new one). opts.excludeIds: { host: id, 'cohost:<guestId>': id }
// — a payout's own row, left out when its TDS is worked out again.
// Bank details changed in the last 48 hours: no payout yet (_bank-check.js).
const inChangeHold = (at) => require('./_bank-check').inChangeHold(at);

async function planPayouts(sql, orderId, opts = {}) {
  const creditAt = opts.creditAt || new Date();
  const excludeIds = opts.excludeIds || {};
  const { decryptField, maskAccount } = require('./_secure-fields');
  const o = (await sql`
    SELECT o.id, o.status, (to_jsonb(o)->>'payout_on_cancel')::boolean AS payout_on_cancel, o.commission_amount, o.payout_amount, h.id AS host_id, h.name AS host_name,
           o.nights, to_jsonb(o)->>'payout_rest_held_at' AS rest_held_at,
           h.bank_account_holder_name, h.bank_account_number, h.bank_ifsc, h.bank_status, h.razorpayx_fund_account_id,
           h.pan_number AS host_pan, h.pan_status AS host_pan_status, (to_jsonb(h)->>'pan_inoperative')::boolean AS host_pan_inoperative,
           to_jsonb(h)->>'bank_changed_at' AS host_bank_changed_at
    FROM orders o JOIN listings l ON l.id = o.listing_id JOIN hosts h ON h.id = l.host_id WHERE o.id = ${orderId}
  `)[0];
  // A guest-cancelled booking still pays the host the part the guest was
  // not refunded (payout_amount was reduced to it, _cancellations.js).
  // Host-cancelled and refunded-in-full bookings never have this flag.
  if (!o || !(o.status === 'paid' || (o.status === 'cancelled' && o.payout_on_cancel === true && Number(o.payout_amount) > 0))) return [];
  let shares = [];
  try {
    shares = await sql`SELECT s.cohost_guest_id, s.amount, g.name, g.email, p.account_holder_name, p.bank_account_number, p.bank_ifsc, p.status AS profile_status, p.razorpayx_fund_account_id, p.pan_number AS cohost_pan,
                              (to_jsonb(p)->>'pan_inoperative')::boolean AS cohost_pan_inoperative, to_jsonb(p)->>'bank_changed_at' AS bank_changed_at
                       FROM order_cohost_shares s JOIN guests g ON g.id = s.cohost_guest_id LEFT JOIN cohost_payout_profiles p ON p.guest_id = s.cohost_guest_id
                       WHERE s.order_id = ${orderId}`;
  } catch (e) { shares = []; }
  // While a guest's request made during the stay is open, only the first
  // night is paid (orders.payout_rest_held_at; runAutoPayouts). opts.full:
  // the whole booking, whatever is held.
  const nights = Math.max(1, Number(o.nights) || 1);
  const part = o.rest_held_at && !opts.full && nights > 1 ? 1 / nights : 1;
  if (part < 1) shares.forEach(x => { x.amount = round2(Number(x.amount) * part); });
  const commission = round2((Number(o.commission_amount) || 0) * part);
  const gross = round2(((Number(o.payout_amount) || 0) + (Number(o.commission_amount) || 0)) * part);
  // Co-host shares can never add up to more than the host's part after
  // commission: if they would (shares of 100% or more), they are scaled
  // down to fit, so no one is paid money the booking did not earn.
  const hostPart = Math.max(0, gross - commission);
  const coAsked = shares.reduce((t, x) => t + Number(x.amount), 0);
  if (coAsked > hostPart && coAsked > 0) {
    const f = hostPart / coAsked;
    shares.forEach(x => { x.amount = Math.floor(Number(x.amount) * f * 100) / 100; });
  }
  const coTotal = round2(shares.reduce((t, x) => t + Number(x.amount), 0));
  const hostT = await tdsForPayout(sql, {
    // TDS on the amount due to the host (after Aerva's commission and co-host shares), as the CA advised.
    payee: { payeeType: 'host', hostId: o.host_id }, base: Math.max(0, round2(gross - commission - coTotal)), creditAt, excludePayoutId: excludeIds.host || null,
    pan: { pan: decryptField(o.host_pan), present: !!o.host_pan, status: o.host_pan_status, inoperative: o.host_pan_inoperative === true }
  });
  const hostPan = hostT.reason !== 'no_pan' && hostT.reason !== 'inoperative_pan';
  const hostRate = hostT.rate;
  // The host's net is never below zero: TDS is at most what is left.
  const beforeTds = Math.max(0, round2(gross - commission - coTotal));
  const tds = Math.min(beforeTds, hostT.tds);
  let available = Math.max(0, round2(beforeTds - tds));
  let owed = [];
  // A coupon owed is deducted from ONE payout: those already listed on
  // another booking's payout that has not been sent yet are left out.
  try {
    owed = await sql`SELECT id, amount, COALESCE(to_jsonb(hp)->>'kind', 'coupon') AS kind, order_id FROM host_penalties hp WHERE hp.host_id = ${o.host_id} AND hp.payer_guest_id IS NULL AND hp.status = 'owed'
                       AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.status IN ('due', 'processing', 'failed') AND p.order_id <> ${orderId} AND hp.id = ANY(p.deducted_penalty_ids))
                     ORDER BY hp.created_at`;
  } catch (e) { owed = []; }
  const deducted = [];
  let deductions = 0;
  for (const pn of owed) {
    if (deductions + Number(pn.amount) <= available) { deductions += Number(pn.amount); deducted.push(pn.id); continue; }
    // An amount overpaid earlier that does not fit whole: as much as fits
    // now, the rest stays owed for the payout after (only when a payout is
    // actually being created — opts.splitOverpaid).
    const room = round2(available - deductions);
    if (pn.kind === 'overpaid' && opts.splitOverpaid && room >= 1) {
      const cut = await sql`UPDATE host_penalties SET amount = ${room} WHERE id = ${pn.id} AND status = 'owed' AND amount = ${pn.amount} RETURNING id`;
      if (cut.length) {
        await sql`INSERT INTO host_penalties (host_id, order_id, amount, payer_guest_id, kind, note) VALUES (${o.host_id}, ${pn.order_id}, ${round2(Number(pn.amount) - room)}, NULL, 'overpaid', ${'Rest of #' + pn.id + ', for a later payout'})`;
        deductions += room; deducted.push(pn.id);
      }
    }
  }
  const hostEmail = ((await sql`SELECT email FROM guests WHERE host_id = ${o.host_id} ORDER BY id LIMIT 1`)[0] || {}).email || null;
  const plans = [{
    payeeType: 'host', hostId: o.host_id, payeeGuestId: null, gross, commission, cohostShares: coTotal, deductions, deductedIds: deducted, tds, tdsRate: hostRate, panFurnished: hostPan,
    tdsBase: hostT.base, tdsReason: hostT.reason, tdsCatchupBase: hostT.catchupBase, tdsFy: hostT.fy,
    net: round2(available - deductions), email: hostEmail, name: o.host_name,
    bankLabel: [o.bank_account_holder_name, maskAccount(o.bank_account_number)].filter(Boolean).join(' · '),
    // On hold while the PAN is being reviewed again, or within 48 hours of a change.
    bank: { ready: o.bank_status === 'verified' && !!o.bank_account_number && !!o.bank_ifsc && !inChangeHold(o.host_bank_changed_at) && o.host_pan_status !== 'pending_review',
            changedRecently: inChangeHold(o.host_bank_changed_at) || o.host_pan_status === 'pending_review', holder: o.bank_account_holder_name, account: decryptField(o.bank_account_number), ifsc: o.bank_ifsc, fundAccountId: o.razorpayx_fund_account_id, table: 'hosts', key: o.host_id }
  }];
  for (const x of shares) {
    // Co-host: their share, less TDS only (no other deductions).
    // A PAN on file counts unless the admin rejected it (same rule as hosts).
    const coT = await tdsForPayout(sql, {
      payee: { payeeType: 'cohost', payeeGuestId: x.cohost_guest_id }, base: Number(x.amount), creditAt,
      excludePayoutId: excludeIds['cohost:' + x.cohost_guest_id] || null,
      pan: { pan: decryptField(x.cohost_pan), present: !!x.cohost_pan, status: x.profile_status === 'rejected' ? 'rejected' : (x.profile_status || 'pending_review'), inoperative: x.cohost_pan_inoperative === true }
    });
    const coPan = coT.reason !== 'no_pan' && coT.reason !== 'inoperative_pan';
    const coRate = coT.rate;
    const coTds = Math.min(Number(x.amount), coT.tds);
    // An amount this co-host was overpaid on another booking (reduced after
    // its payout was sent): deducted here, as far as it fits.
    let coOwed = [];
    try {
      coOwed = await sql`SELECT id, amount FROM host_penalties hp WHERE hp.payer_guest_id = ${x.cohost_guest_id} AND hp.status = 'owed' AND COALESCE(to_jsonb(hp)->>'kind', 'coupon') = 'overpaid'
                           AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.status IN ('due', 'processing', 'failed') AND p.order_id <> ${orderId} AND hp.id = ANY(p.deducted_penalty_ids))
                         ORDER BY hp.created_at`;
    } catch (e) { coOwed = []; }
    const coDed = [];
    let coDeductions = 0;
    for (const pn of coOwed) { if (coDeductions + Number(pn.amount) <= Number(x.amount) - coTds) { coDeductions += Number(pn.amount); coDed.push(pn.id); } }
    plans.push({
      payeeType: 'cohost', hostId: o.host_id, payeeGuestId: x.cohost_guest_id, gross: Number(x.amount), commission: 0, cohostShares: 0, deductions: round2(coDeductions), deductedIds: coDed,
      tds: coTds, tdsRate: coRate, panFurnished: coPan,
      tdsBase: coT.base, tdsReason: coT.reason, tdsCatchupBase: coT.catchupBase, tdsFy: coT.fy,
      net: round2(Number(x.amount) - coTds - coDeductions), email: x.email, name: x.name,
      bankLabel: [x.account_holder_name, maskAccount(x.bank_account_number)].filter(Boolean).join(' · '),
      bank: { ready: x.profile_status === 'approved' && !!x.bank_account_number && !!x.bank_ifsc && !inChangeHold(x.bank_changed_at), changedRecently: inChangeHold(x.bank_changed_at), holder: x.account_holder_name, account: decryptField(x.bank_account_number), ifsc: x.bank_ifsc, fundAccountId: x.razorpayx_fund_account_id, table: 'cohost_payout_profiles', key: x.cohost_guest_id }
    });
  }
  return plans;
}

// Create the booking's payout rows ('due') if they do not exist yet.
// Returns [{ row, plan }] for rows created now.
async function createPayoutRows(sql, orderId) {
  const created = [];
  // Not while a cancellation or change holds the booking: its amounts are
  // about to change (_cancellations.js claimForCancellation).
  try {
    const busy = await sql`SELECT 1 FROM orders o WHERE o.id = ${orderId} AND (to_jsonb(o)->>'cancel_claim') IS NOT NULL
                             AND (to_jsonb(o)->>'cancel_claimed_at')::timestamptz > now() - interval '10 minutes'`;
    if (busy.length) return created;
  } catch (e) { /* before migration_cancellation_policy.sql */ }
  for (const plan of await planPayouts(sql, orderId, { splitOverpaid: true })) {
    let r;
    try {
      r = await sql`
        INSERT INTO payouts (order_id, payee_type, host_id, payee_guest_id, status, gross, commission, cohost_shares, deductions, deducted_penalty_ids, tds, tds_rate, pan_furnished, net, bank_label, auto_eligible,
                             tds_base, tds_reason, tds_catchup_base, tds_fy)
        VALUES (${orderId}, ${plan.payeeType}, ${plan.hostId}, ${plan.payeeGuestId}, 'due', ${plan.gross}, ${plan.commission}, ${plan.cohostShares}, ${plan.deductions}, ${plan.deductedIds}, ${plan.tds}, ${plan.tdsRate}, ${plan.panFurnished}, ${plan.net}, ${plan.bankLabel || null}, ${razorpayxReady()},
                ${plan.tdsBase}, ${plan.tdsReason}, ${plan.tdsCatchupBase}, ${plan.tdsFy})
        ON CONFLICT DO NOTHING RETURNING *
      `;
    } catch (err) {
      if (!err || err.code !== '42703') throw err;
      // Before sql/migration_tds.sql: the row without the new TDS columns.
      r = await sql`
        INSERT INTO payouts (order_id, payee_type, host_id, payee_guest_id, status, gross, commission, cohost_shares, deductions, deducted_penalty_ids, tds, tds_rate, pan_furnished, net, bank_label, auto_eligible)
        VALUES (${orderId}, ${plan.payeeType}, ${plan.hostId}, ${plan.payeeGuestId}, 'due', ${plan.gross}, ${plan.commission}, ${plan.cohostShares}, ${plan.deductions}, ${plan.deductedIds}, ${plan.tds}, ${plan.tdsRate}, ${plan.panFurnished}, ${plan.net}, ${plan.bankLabel || null}, ${razorpayxReady()})
        ON CONFLICT DO NOTHING RETURNING *
      `;
    }
    if (r[0]) created.push({ row: r[0], plan });
  }
  return created;
}

// ---------------------------------------------------------------------
// Security deposit compensation (Admin → resolve a disputed deposit).
// The part of a deposit Aerva decides goes to the host is paid as its OWN
// payout row (payouts.kind = 'deposit', sql/migration_payout_kinds.sql),
// next to the booking's payout: the booking's payout may already be sent,
// and its figures (commission, TDS) stay exactly as they were. No
// commission or other deductions; TDS IS deducted, at the host's rate (the
// CA's advice: TDS on every payment Aerva makes, for safety). Sent like any payout: automatically with
// RazorpayX (retried every 4 hours), or by hand (Mark paid, kind 'deposit').
// One per booking (unique index). Returns the row, or null if not created.
async function depositPayee(sql, hostId) {
  const { decryptField, maskAccount } = require('./_secure-fields');
  const h = (await sql`SELECT id, name, bank_account_holder_name, bank_account_number, bank_ifsc, bank_status, razorpayx_fund_account_id, pan_number, pan_status,
                              (to_jsonb(hosts)->>'pan_inoperative')::boolean AS pan_inoperative,
                              to_jsonb(hosts)->>'bank_changed_at' AS bank_changed_at
                       FROM hosts WHERE id = ${hostId}`)[0];
  if (!h) return null;
  const email = ((await sql`SELECT email FROM guests WHERE host_id = ${hostId} ORDER BY id LIMIT 1`)[0] || {}).email || null;
  return {
    payeeType: 'host', hostId: h.id, payeeGuestId: null, email, name: h.name, panFurnished: !!h.pan_number && h.pan_status !== 'rejected',
    pan: { pan: decryptField(h.pan_number), present: !!h.pan_number, status: h.pan_status, inoperative: h.pan_inoperative === true },
    bankLabel: [h.bank_account_holder_name, maskAccount(h.bank_account_number)].filter(Boolean).join(' · '),
    bank: { ready: h.bank_status === 'verified' && !!h.bank_account_number && !!h.bank_ifsc && !inChangeHold(h.bank_changed_at) && h.pan_status !== 'pending_review',
            changedRecently: inChangeHold(h.bank_changed_at) || h.pan_status === 'pending_review', holder: h.bank_account_holder_name, account: decryptField(h.bank_account_number), ifsc: h.bank_ifsc, fundAccountId: h.razorpayx_fund_account_id, table: 'hosts', key: h.id }
  };
}
async function createDepositCompensationPayout(sql, { orderId, amount }) {
  const gross = round2(Number(amount) || 0);
  if (!(gross > 0)) return null;
  const o = (await sql`SELECT o.id, l.host_id FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${orderId}`)[0];
  if (!o) return null;
  const payee = await depositPayee(sql, o.host_id);
  if (!payee) return null;
  // TDS on the compensation, at the host's rate (0.1% with a PAN, 5% without).
  const t = await tdsForPayout(sql, { payee: { payeeType: 'host', hostId: o.host_id }, base: gross, pan: payee.pan });
  const tds = Math.min(gross, t.tds);
  const net = round2(gross - tds);
  const panOk = t.reason !== 'no_pan' && t.reason !== 'inoperative_pan';
  let r;
  try {
    r = await sql`
      INSERT INTO payouts (order_id, payee_type, host_id, payee_guest_id, status, gross, commission, cohost_shares, deductions, deducted_penalty_ids, tds, tds_rate, pan_furnished, net, bank_label, auto_eligible, kind,
                           tds_base, tds_reason, tds_catchup_base, tds_fy)
      VALUES (${orderId}, 'host', ${o.host_id}, NULL, 'due', ${gross}, 0, 0, 0, ${[]}, ${tds}, ${t.rate}, ${panOk}, ${net}, ${payee.bankLabel || null}, ${razorpayxReady()}, 'deposit',
              ${t.base}, ${t.reason}, 0, ${t.fy})
      ON CONFLICT DO NOTHING RETURNING *
    `;
  } catch (err) {
    if (!err || err.code !== '42703') throw err;
    r = await sql`
      INSERT INTO payouts (order_id, payee_type, host_id, payee_guest_id, status, gross, commission, cohost_shares, deductions, deducted_penalty_ids, tds, tds_rate, pan_furnished, net, bank_label, auto_eligible, kind)
      VALUES (${orderId}, 'host', ${o.host_id}, NULL, 'due', ${gross}, 0, 0, 0, ${[]}, ${tds}, ${t.rate}, ${panOk}, ${net}, ${payee.bankLabel || null}, ${razorpayxReady()}, 'deposit')
      ON CONFLICT DO NOTHING RETURNING *
    `;
  }
  return r[0] || (await sql`SELECT * FROM payouts WHERE order_id = ${orderId} AND payee_type = 'host' AND kind = 'deposit'`)[0] || null;
}

// A co-host as a payee of a payout of its own (bank details, PAN).
async function cohostPayee(sql, guestId) {
  const { decryptField, maskAccount } = require('./_secure-fields');
  const x = (await sql`SELECT g.id, g.name, g.email, p.account_holder_name, p.bank_account_number, p.bank_ifsc, p.status AS profile_status, p.razorpayx_fund_account_id,
                              p.pan_number, (to_jsonb(p)->>'pan_inoperative')::boolean AS pan_inoperative, to_jsonb(p)->>'bank_changed_at' AS bank_changed_at
                       FROM guests g LEFT JOIN cohost_payout_profiles p ON p.guest_id = g.id WHERE g.id = ${Number(guestId) || 0}`)[0];
  if (!x) return null;
  return {
    payeeType: 'cohost', hostId: null, payeeGuestId: x.id, email: x.email, name: x.name, panFurnished: !!x.pan_number && x.profile_status !== 'rejected',
    pan: { pan: decryptField(x.pan_number), present: !!x.pan_number, status: x.profile_status === 'rejected' ? 'rejected' : (x.profile_status || 'pending_review'), inoperative: x.pan_inoperative === true },
    bankLabel: [x.account_holder_name, maskAccount(x.bank_account_number)].filter(Boolean).join(' · '),
    bank: { ready: x.profile_status === 'approved' && !!x.bank_account_number && !!x.bank_ifsc && !inChangeHold(x.bank_changed_at), changedRecently: inChangeHold(x.bank_changed_at),
            holder: x.account_holder_name, account: decryptField(x.bank_account_number), ifsc: x.bank_ifsc, fundAccountId: x.razorpayx_fund_account_id, table: 'cohost_payout_profiles', key: x.id }
  };
}

// ---------------------------------------------------------------------
// A booking changed after its payout was sent (payouts go the day after
// check-in, so a stay can still change: a problem upheld, a shorter or
// longer stay, an emergency cancellation). Called after any change to a
// booking's amounts. For each payee (host, co-hosts):
//   • a payout not sent yet ('due'/'failed') is planned again from the new
//     amounts;
//   • against what was already sent: an amount no longer owed is recorded
//     to be deducted from their next payout (host_penalties, kind
//     'overpaid'); an amount added is paid as a payout of its own
//     (kind 'adjustment-<n>'), sent like any other.
// Compared on the amount due before TDS (TDS deducted earlier stays
// deducted). Never throws.
const payeeKey = (type, guestId) => `${type}:${Number(guestId) || 0}`;
// opts.release: the rest of a payout held while a guest's request was open
// (runAutoPayouts) is paid now — as kind 'rest-<n>'. Without it, nothing
// more is paid while the rest is held (only amounts no longer owed are
// recorded).
async function settleAfterPayout(sql, orderId, { reason = 'The booking changed after its payout was sent', release = false } = {}) {
  const out = { recovered: 0, added: 0 };
  try {
    const rows = await sql`SELECT * FROM payouts WHERE order_id = ${Number(orderId) || 0} AND COALESCE(to_jsonb(payouts)->>'kind', 'booking') <> 'deposit'`;
    if (!rows.length) return out;
    const o = (await sql`SELECT o.id, l.host_id, to_jsonb(o)->>'payout_rest_held_at' AS rest_held_at FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${orderId}`)[0];
    if (!o) return out;
    const held = !!o.rest_held_at;
    const plans = await planPayouts(sql, orderId);                       // as paid now (first night only while held)
    const full = held ? await planPayouts(sql, orderId, { full: true }) : plans;
    const due = {};                                         // what each payee is owed in all (before TDS)
    full.forEach(p => { due[payeeKey(p.payeeType, p.payeeGuestId)] = p.payeeType === 'host' ? round2(p.gross - p.commission - p.cohostShares) : round2(p.gross); });
    // A booking payout not sent yet: planned again from the new amounts.
    for (const r of rows.filter(r => (r.kind || 'booking') === 'booking' && ['due', 'failed'].includes(r.status))) {
      const p = plans.find(x => x.payeeType === r.payee_type && (x.payeeGuestId || 0) === (r.payee_guest_id || 0));
      const upd = p
        ? await sql`UPDATE payouts SET gross = ${p.gross}, commission = ${p.commission}, cohost_shares = ${p.cohostShares}, deductions = ${p.deductions}, deducted_penalty_ids = ${p.deductedIds},
                      tds = ${p.tds}, tds_rate = ${p.tdsRate}, net = ${p.net} WHERE id = ${r.id} AND status IN ('due', 'failed') RETURNING *`
        : await sql`UPDATE payouts SET gross = 0, commission = 0, cohost_shares = 0, deductions = 0, deducted_penalty_ids = ${[]}, tds = 0, net = 0, status = 'cancelled'
                    WHERE id = ${r.id} AND status IN ('due', 'failed') RETURNING *`;
      if (upd[0]) Object.assign(r, upd[0]);
    }
    if (!rows.some(r => r.status === 'sent' || r.status === 'processing')) return out;
    const baseOf = (r) => r.payee_type === 'host' && (r.kind || 'booking') === 'booking' ? Number(r.gross) - Number(r.commission) - Number(r.cohost_shares) : Number(r.gross);
    const paid = {};
    rows.filter(r => r.status !== 'cancelled').forEach(r => { const k = payeeKey(r.payee_type, r.payee_guest_id); paid[k] = round2((paid[k] || 0) + baseOf(r)); });
    // Amounts already recorded as overpaid on this booking (not withdrawn).
    let recs = [];
    try {
      recs = await sql`SELECT id, amount, status, payer_guest_id FROM host_penalties WHERE order_id = ${orderId} AND COALESCE(to_jsonb(host_penalties)->>'kind', 'coupon') = 'overpaid' AND status <> 'cancelled' ORDER BY id DESC`;
    } catch (e) { recs = null; }                             // database update not applied
    const keys = new Set([...Object.keys(due), ...Object.keys(paid)]);
    for (const k of keys) {
      const [type, gid] = k.split(':');
      const mine = (recs || []).filter(x => (Number(x.payer_guest_id) || 0) === Number(gid) && (type === 'host' ? !x.payer_guest_id : true));
      const settled = round2((paid[k] || 0) - mine.reduce((t, x) => t + Number(x.amount), 0));
      let diff = round2((due[k] || 0) - settled);
      if (Math.abs(diff) < 1) continue;
      if (diff < 0) {
        if (recs === null) { console.error('overpaid amount not recorded (apply the database update):', orderId, k, -diff); continue; }
        await sql`INSERT INTO host_penalties (host_id, order_id, amount, payer_guest_id, kind, note)
                  VALUES (${o.host_id}, ${orderId}, ${-diff}, ${type === 'cohost' ? Number(gid) : null}, 'overpaid', ${reason.slice(0, 300)})`;
        out.recovered = round2(out.recovered - diff);
        if (type === 'host') out.hostRecovered = round2((out.hostRecovered || 0) - diff);
        continue;
      }
      // Owed more: first withdraw what is still waiting to be deducted.
      for (const x of mine.filter(x => x.status === 'owed')) {
        if (diff <= 0) break;
        const amt = Number(x.amount);
        if (amt <= diff) {
          const w = await sql`UPDATE host_penalties SET status = 'cancelled', settled_at = now(), settled_by = 'automatic', note = 'Withdrawn: the booking changed again'
                              WHERE id = ${x.id} AND status = 'owed' AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.status IN ('due', 'processing', 'failed', 'sent') AND ${x.id} = ANY(p.deducted_penalty_ids)) RETURNING id`;
          if (w.length) diff = round2(diff - amt);
        } else {
          const w = await sql`UPDATE host_penalties SET amount = ${round2(amt - diff)} WHERE id = ${x.id} AND status = 'owed'
                                AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.status IN ('due', 'processing', 'failed', 'sent') AND ${x.id} = ANY(p.deducted_penalty_ids)) RETURNING id`;
          if (w.length) diff = 0;
        }
      }
      if (diff < 1) continue;
      // More is owed: nothing more is paid while the rest is held.
      if (held && !release) continue;
      // The rest: a payout of its own.
      const payee = type === 'host' ? await depositPayee(sql, o.host_id) : await cohostPayee(sql, gid);
      if (!payee) continue;
      const t = await tdsForPayout(sql, { payee: type === 'host' ? { payeeType: 'host', hostId: o.host_id } : { payeeType: 'cohost', payeeGuestId: Number(gid) }, base: diff, pan: payee.pan });
      const tds = Math.min(diff, t.tds);
      const prefix = release ? 'rest' : 'adjustment';
      const n = rows.filter(r => (r.kind || '').startsWith(prefix + '-')).length + 1;
      let made = null;
      for (let i = 0; i < 5 && !made; i++) {
        made = (await sql`
          INSERT INTO payouts (order_id, payee_type, host_id, payee_guest_id, status, gross, commission, cohost_shares, deductions, deducted_penalty_ids, tds, tds_rate, pan_furnished, net, bank_label, auto_eligible, kind,
                               tds_base, tds_reason, tds_catchup_base, tds_fy)
          VALUES (${orderId}, ${type}, ${o.host_id}, ${type === 'cohost' ? Number(gid) : null}, 'due', ${diff}, 0, 0, 0, ${[]}, ${tds}, ${t.rate}, ${t.reason !== 'no_pan' && t.reason !== 'inoperative_pan'}, ${round2(diff - tds)},
                  ${payee.bankLabel || null}, ${razorpayxReady()}, ${prefix + '-' + (n + i)}, ${t.base}, ${t.reason}, 0, ${t.fy})
          ON CONFLICT DO NOTHING RETURNING *`)[0] || null;
      }
      if (made) {
        rows.push(made);
        out.added = round2(out.added + diff);
        if (type === 'host') out.hostAdded = round2((out.hostAdded || 0) + diff);
        if (razorpayxReady()) { try { await attemptPayout(sql, made.id); } catch (e) { /* retried every 4 hours */ } }
      }
    }
  } catch (err) {
    console.error('payout not settled after a change (needs follow-up):', orderId, err.message);
    out.error = err.message;
  }
  return out;
}

async function razorpayx(method, path, body, idempotencyKey) {
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['X-Payout-Idempotency'] = idempotencyKey;
  const res = await fetch(`https://api.razorpay.com/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.description) || `RazorpayX ${res.status}`);
  return data;
}

const DEAD = ['failed', 'reversed', 'rejected', 'cancelled'];

// Try to send one payout through RazorpayX. Safe to call any number of
// times, from the scheduler or an admin's Retry:
//   1. claim it (only 'due' or 'failed' can be claimed, one caller at a time);
//   2. ask RazorpayX what ACTUALLY exists for it (reference_id) — a live or
//      processed payout is adopted, never duplicated;
//   3. only then create one (idempotency key per attempt).
// A payout that cannot be sent now goes back to 'due' (retried every 4
// hours); one the bank fails or reverses becomes 'failed' (admin retries).
// A payout's TDS worked out again just before it is sent: a PAN added,
// approved, rejected or marked inoperative since the row was created
// counts. Only 'due' or 'failed' booking payouts change; the year's other
// payouts are taken as they are. Returns the row (updated or not).
async function refreshTds(sql, row) {
  if (!row || (row.kind && row.kind !== 'booking') || !['due', 'failed'].includes(row.status)) return row;
  try {
    const key = row.payee_type === 'host' ? 'host' : 'cohost:' + row.payee_guest_id;
    const plan = (await planPayouts(sql, row.order_id, { creditAt: row.created_at, excludeIds: { [key]: row.id } }))
      .find(p => p.payeeType === row.payee_type && (p.payeeGuestId || 0) === (row.payee_guest_id || 0));
    if (!plan) return row;
    const same = Number(plan.tds) === Number(row.tds) && Number(plan.tdsRate) === Number(row.tds_rate) && plan.tdsReason === row.tds_reason;
    if (same) return row;
    const net = row.payee_type === 'host'
      ? round2(Number(row.gross) - Number(row.commission) - Number(row.cohost_shares) - Number(row.deductions) - plan.tds)
      : round2(Number(row.gross) - Number(row.deductions || 0) - plan.tds);
    if (net < 0) return row;
    let upd;
    try {
      upd = await sql`
        UPDATE payouts SET tds = ${plan.tds}, tds_rate = ${plan.tdsRate}, pan_furnished = ${plan.panFurnished}, tds_base = ${plan.tdsBase},
                           tds_reason = ${plan.tdsReason}, tds_catchup_base = ${plan.tdsCatchupBase}, tds_fy = ${plan.tdsFy}, net = ${net}
        WHERE id = ${row.id} AND status IN ('due', 'failed') RETURNING *`;
    } catch (err) {
      if (!err || err.code !== '42703') throw err;
      upd = await sql`UPDATE payouts SET tds = ${plan.tds}, tds_rate = ${plan.tdsRate}, pan_furnished = ${plan.panFurnished}, net = ${net}
                      WHERE id = ${row.id} AND status IN ('due', 'failed') RETURNING *`;
    }
    return upd[0] || row;
  } catch (err) {
    console.error('TDS refresh failed for payout', row.id, err.message || err);
    return row;
  }
}

async function attemptPayout(sql, payoutId, { by = 'automatic' } = {}) {
  if (!razorpayxReady()) return 'not_configured';
  const current = (await sql`SELECT * FROM payouts WHERE id = ${payoutId}`)[0];
  if (current) await refreshTds(sql, current);
  const claim = await sql`
    UPDATE payouts SET status = 'processing', attempts = attempts + 1, last_attempt_at = now(), failure_reason = NULL
    WHERE id = ${payoutId} AND status IN ('due', 'failed') RETURNING *
  `;
  const row = claim[0];
  if (!row) return 'busy';
  const back = async (status, reason) => { await sql`UPDATE payouts SET status = ${status}, failure_reason = ${String(reason).slice(0, 300)} WHERE id = ${row.id} AND status = 'processing'`; return status; };
  try {
    const ref = `aerva-payout-${row.id}`;
    const found = await razorpayx('GET', `/payouts?account_number=${encodeURIComponent(process.env.RAZORPAYX_ACCOUNT_NUMBER)}&reference_id=${encodeURIComponent(ref)}`);
    const live = ((found && found.items) || []).find(p => !DEAD.includes(p.status));
    if (live) {
      await sql`UPDATE payouts SET razorpayx_payout_id = ${live.id} WHERE id = ${row.id}`;
      if (live.status === 'processed') await markPayoutSent(sql, row.id, { reference: live.utr || live.id, by: 'RazorpayX' });
      return 'adopted';
    }
    const plan = (row.kind && row.kind !== 'booking')
      ? (row.payee_type === 'host' ? await depositPayee(sql, row.host_id) : await cohostPayee(sql, row.payee_guest_id))
      : (await planPayouts(sql, row.order_id)).find(p => p.payeeType === row.payee_type && (p.payeeGuestId || 0) === (row.payee_guest_id || 0));
    if (!plan || !plan.bank.ready) return back('due', plan && plan.bank.changedRecently ? 'Payout details changed recently (PAN or bank being checked, or within 48 hours): waiting' : 'Waiting for approved bank details');
    let fa = plan.bank.fundAccountId;
    if (!fa) {
      const contact = await razorpayx('POST', '/contacts', { name: plan.bank.holder || plan.name || 'Aerva payee', email: plan.email || undefined, type: 'vendor', reference_id: `${plan.bank.table}-${plan.bank.key}` });
      const acct = await razorpayx('POST', '/fund_accounts', { contact_id: contact.id, account_type: 'bank_account', bank_account: { name: plan.bank.holder, ifsc: plan.bank.ifsc, account_number: plan.bank.account } });
      fa = acct.id;
      if (plan.bank.table === 'hosts') await sql`UPDATE hosts SET razorpayx_fund_account_id = ${fa} WHERE id = ${plan.bank.key}`;
      else await sql`UPDATE cohost_payout_profiles SET razorpayx_fund_account_id = ${fa} WHERE guest_id = ${plan.bank.key}`;
    }
    const po = await razorpayx('POST', '/payouts', {
      account_number: process.env.RAZORPAYX_ACCOUNT_NUMBER, fund_account_id: fa, amount: Math.round(Number(row.net) * 100), currency: 'INR',
      mode: Number(row.net) <= 500000 ? 'IMPS' : 'NEFT', purpose: 'payout', queue_if_low_balance: true, reference_id: ref, narration: 'Aerva payout'
    }, `${ref}-${row.attempts}`);
    await sql`UPDATE payouts SET razorpayx_payout_id = ${po.id} WHERE id = ${row.id}`;
    return 'processing';
  } catch (err) {
    // Not sent (or unknown): back to 'due' for the 4-hourly retry, which
    // checks RazorpayX first, so a payout that did go through is adopted.
    return back('due', 'Last attempt: ' + (err.message || err));
  }
}

// A payout is SENT: record it, recover the coupons it deducted, and tell
// the payee (email + website notification).
async function markPayoutSent(sql, payoutId, { reference, arrivingBy = null, by = 'automatic' }) {
  const upd = await sql`
    UPDATE payouts SET status = 'sent', reference = ${reference}, arriving_by = COALESCE(${arrivingBy}::date, arriving_by, (now() AT TIME ZONE 'Asia/Kolkata')::date),
                       sent_at = now(), recorded_by = ${by}, failure_reason = NULL
    WHERE id = ${payoutId} AND status IN ('due', 'processing', 'failed') RETURNING *
  `;
  const row = upd[0];
  if (!row) return null;
  if ((row.deducted_penalty_ids || []).length) {
    try { await sql`UPDATE host_penalties SET status = 'recovered', settled_at = now(), settled_by = ${by}, note = ${'Deducted from payout #' + row.id} WHERE id = ANY(${row.deducted_penalty_ids}) AND status = 'owed'`; }
    catch (e) { console.error('penalty recovery failed:', e.message); }
  }
  const summary = await loadPayoutSummary(sql, row.id);
  const to = row.payee_type === 'host'
    ? ((await sql`SELECT email FROM guests WHERE host_id = ${row.host_id} ORDER BY id LIMIT 1`)[0] || {}).email
    : ((await sql`SELECT email FROM guests WHERE id = ${row.payee_guest_id}`)[0] || {}).email;
  let emailed = false;
  if (Number(row.net) > 0) {
    try { emailed = await sendPayoutEmail(to, summary); } catch (e) { console.error('payout email failed:', e.message); }
  }
  return { row, summary, emailed };
}

// Check payouts RazorpayX is still sending.
async function pollRazorpayX(sql) {
  if (!razorpayxReady()) return { checked: 0 };
  const rows = await sql`SELECT id, razorpayx_payout_id FROM payouts WHERE status = 'processing' AND razorpayx_payout_id IS NOT NULL LIMIT 50`;
  for (const r of rows) {
    try {
      const po = await razorpayx('GET', `/payouts/${r.razorpayx_payout_id}`);
      if (po.status === 'processed') await markPayoutSent(sql, r.id, { reference: po.utr || po.id, by: 'RazorpayX' });
      else if (DEAD.includes(po.status)) {
        await sql`UPDATE payouts SET status = 'failed', failure_reason = ${(po.status_details && po.status_details.description) || po.status} WHERE id = ${r.id} AND status = 'processing'`;
      }
    } catch (e) { console.error('RazorpayX status check failed:', r.id, e.message); }
  }
  return { checked: rows.length };
}

// Bookings (of ids) with a guest's request open: a change waiting for the
// host or for payment, or a reported problem waiting for Aerva.
async function openGuestRequests(sql, ids) {
  const set = new Set();
  if (!ids || !ids.length) return set;
  try { (await sql`SELECT order_id FROM stay_disputes WHERE order_id = ANY(${ids}) AND status IN ('open', 'host_responded')`).forEach(r => set.add(r.order_id)); } catch (e) { /* not created yet */ }
  try { (await sql`SELECT order_id FROM booking_changes WHERE order_id = ANY(${ids}) AND status IN ('pending', 'awaiting_payment')`).forEach(r => set.add(r.order_id)); } catch (e) { /* not created yet */ }
  return set;
}

// The scheduler (every run of get-listings ?runSchedules=1, the daily cron
// and site traffic). Throws when something failed, so the run is recorded
// as failed (Admin → Scheduled jobs) — after doing everything it could.
//   • bookings whose day after check-in has reached 5 PM locally get
//     their payouts, sent at once;
//   • payouts left behind ('due') are retried every 4 hours;
//   • payouts and refunds in progress are checked with Razorpay.
const RETRY_HOURS = 4;
async function runAutoPayouts(sql, { deadlineMs = 7000, razorpay = null } = {}) {
  const started = Date.now();
  const out = { created: 0, attempted: 0, retried: 0, due: 0, failed: 0 };
  const errors = [];
  // A booking's payout (not a deposit compensation) — before
  // migration_payout_kinds.sql every row is one.
  const orders = await sql`
    SELECT o.id FROM orders o JOIN listings l ON l.id = o.listing_id
    CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata')) AS local_now) lt
    WHERE (o.status = 'paid' OR (o.status = 'cancelled' AND (to_jsonb(o)->>'payout_on_cancel')::boolean IS TRUE AND o.payout_amount > 0))
      AND o.arrival IS NOT NULL
      AND o.arrival >= lt.local_now::date - 60
      AND (o.arrival + 1 < lt.local_now::date OR (o.arrival + 1 = lt.local_now::date AND extract(hour from lt.local_now) >= ${PAYOUT_HOUR}))
      AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.order_id = o.id AND p.payee_type = 'host' AND COALESCE(to_jsonb(p)->>'kind', 'booking') = 'booking')
    ORDER BY o.arrival LIMIT 100
  `;
  // A guest's request made in the stay window still open — a change asked
  // for (_booking-changes.js) or a problem reported (_stay-disputes.js):
  // only the first night is paid now; the rest once it is settled (below).
  const held = await openGuestRequests(sql, orders.map(o => o.id));
  let canHoldRest = true;
  try { await sql`SELECT payout_rest_held_at FROM orders LIMIT 0`; } catch (e) { canHoldRest = false; }
  // Each booking on its own: one that fails never holds back the others,
  // and is reported (Admin → Scheduled jobs) instead of passing as done.
  for (const o of orders) {
    if (Date.now() - started > deadlineMs) break;
    if (held.has(o.id)) {
      if (!canHoldRest) continue;                         // database update not applied: all of it waits, as before
      await sql`UPDATE orders SET payout_rest_held_at = COALESCE(payout_rest_held_at, now()) WHERE id = ${o.id}`;
    }
    try {
      for (const { row } of await createPayoutRows(sql, o.id)) {
        out.created++;
        if (Number(row.net) === 0) { await markPayoutSent(sql, row.id, { reference: 'Nothing to pay', by: 'automatic' }); continue; }
        if (!razorpayxReady()) { out.due++; continue; }
        await attemptPayout(sql, row.id); out.attempted++;
      }
    } catch (err) {
      out.failed++;
      errors.push(`booking #${o.id}: ${String(err.message || err).slice(0, 120)}`);
      console.error('payout not created for booking', o.id, err);
    }
  }
  // The rest of a payout held for a guest's request, once nothing is open
  // and a declined request can no longer be taken to Aerva.
  if (canHoldRest) {
    const { DECLINED_GRACE_HOURS } = require('./_booking-changes');
    const waiting = await sql`SELECT o.id FROM orders o WHERE o.payout_rest_held_at IS NOT NULL ORDER BY o.payout_rest_held_at LIMIT 50`;
    const still = await openGuestRequests(sql, waiting.map(r => r.id));
    for (const w of waiting) {
      if (Date.now() - started > deadlineMs) break;
      if (still.has(w.id)) continue;
      let recent = [];
      try {
        recent = await sql`SELECT 1 FROM booking_changes WHERE order_id = ${w.id} AND status IN ('declined', 'expired') AND decided_at > now() - make_interval(hours => ${DECLINED_GRACE_HOURS}) LIMIT 1`;
      } catch (e) { recent = []; }
      if (recent.length) continue;
      try {
        const cleared = await sql`UPDATE orders SET payout_rest_held_at = NULL WHERE id = ${w.id} AND payout_rest_held_at IS NOT NULL RETURNING id`;
        if (!cleared.length) continue;
        const r = await settleAfterPayout(sql, w.id, { release: true, reason: 'Rest of the payout, held while a guest’s request was open' });
        if (r.error) { await sql`UPDATE orders SET payout_rest_held_at = now() WHERE id = ${w.id}`; throw new Error(r.error); }
        out.released = (out.released || 0) + 1;
      } catch (err) { out.failed++; errors.push(`booking #${w.id} (rest): ${String(err.message || err).slice(0, 120)}`); }
    }
  }
  // Left behind: retried every 4 hours (only payouts created while
  // automatic payouts were on; others may have been paid by hand).
  if (razorpayxReady()) {
    const left = await sql`SELECT id FROM payouts WHERE status = 'due' AND auto_eligible = true
                             AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(hours => ${RETRY_HOURS})) ORDER BY id LIMIT 50`;
    for (const r of left) { if (Date.now() - started > deadlineMs) break; await attemptPayout(sql, r.id); out.retried++; }
  }
  Object.assign(out, await pollRazorpayX(sql));
  if (razorpay) out.refunds = await require('./_refunds').pollRefunds(sql, razorpay);
  // Recorded as a failed run, with the bookings it could not pay.
  if (errors.length) throw new Error(`Payouts could not be created for ${errors.length} booking${errors.length === 1 ? '' : 's'} (${out.created} created): ${errors.join('; ')}`.slice(0, 480));
  return out;
}

module.exports = { loadPayoutSummary, payoutEmailHtml, sendPayoutEmail, recentPayoutNotifications, inr,
  planPayouts, createPayoutRows, refreshTds, markPayoutSent, runAutoPayouts, attemptPayout, settleAfterPayout, pollRazorpayX, razorpayxReady, PAYOUT_HOUR, RETRY_HOURS,
  createDepositCompensationPayout };
