// /api/_payouts.js — payout summaries. Not an endpoint.
//
// Payouts are created automatically at 5 PM on check-out day (property's
// local time) by runAutoPayouts (get-listings.js ?runSchedules=1, the daily
// cron and site traffic). With RazorpayX set up (RAZORPAYX_ACCOUNT_NUMBER)
// and approved bank details, they are sent there and then; otherwise they
// wait as 'due' for an admin to send by hand and record ("Mark paid").
// When a payout is SENT:
//   • the host or co-host is emailed this summary (sendPayoutEmail), and
//   • it shows as a website notification (guest-auth.js) that opens the
//     same summary (host-listings.js ?payoutDetail=<id>).
// Co-host shares are paid in full: no TDS and no deductions.
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
    : r.payee_type === 'host'
    ? [['Booking earnings', Number(r.gross)], ['Aerva commission', -Number(r.commission)], ['Co-host share', -Number(r.cohost_shares)]]
    : [['Co-host share', Number(r.gross)]]; // co-hosts: TDS only, no other deductions
  if (Number(r.deductions) > 0) lines.push(['Cancellation coupons deducted', -Number(r.deductions)]);
  if (Number(r.tds) > 0) lines.push([`TDS (${Number(r.tds_rate || 0)}%${r.pan_furnished ? '' : ', no PAN'})`, -Number(r.tds)]);
  return {
    id: r.id, orderId: r.order_id, status: r.status, payeeType: r.payee_type, payeeName: r.payee_name || '', hostId: r.host_id, payeeGuestId: r.payee_guest_id,
    amount: Number(r.net), sentAt: r.sent_at, arrivingBy: r.arriving_by, bank: r.bank_label || '', reference: r.reference,
    guestName: r.guest_name || 'Guest', listing: r.suite_name || '', arrival: r.arrival, departure: r.departure,
    // Same reference the guest's booking confirmation shows.
    booking: r.razorpay_order_id || ('#' + r.booking_id),
    lines: lines.filter(([, v]) => v !== 0 && !Object.is(v, -0)).map(([label, value]) => ({ label, value })),
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
// TDS, Income-tax Act 2025 s.393(1) Table 8(v) (formerly s.194-O): 0.1% of
// the gross amount when PAN is furnished, 5% when not. Applied to the host
// (on their part of the booking) and to co-hosts (on their share), so no
// amount is taxed twice. Overridable in Vercel if the CA advises otherwise.
const TDS_WITH_PAN = () => Number(process.env.TDS_RATE_WITH_PAN || 0.1);
const TDS_WITHOUT_PAN = () => Number(process.env.TDS_RATE_WITHOUT_PAN || 5);
const razorpayxReady = () => !!(process.env.RAZORPAYX_ACCOUNT_NUMBER && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const round2 = (n) => Math.round(n * 100) / 100;

// What each payee of a booking gets. Host: booking earnings − Aerva's
// commission − co-host shares − cancellation coupons owed (as many whole
// ones as fit) − TDS. Co-host: their share, in full.
async function planPayouts(sql, orderId) {
  const { decryptField, maskAccount } = require('./_secure-fields');
  const o = (await sql`
    SELECT o.id, o.status, (to_jsonb(o)->>'payout_on_cancel')::boolean AS payout_on_cancel, o.commission_amount, o.payout_amount, h.id AS host_id, h.name AS host_name,
           h.bank_account_holder_name, h.bank_account_number, h.bank_ifsc, h.bank_status, h.razorpayx_fund_account_id,
           h.pan_number AS host_pan, h.pan_status AS host_pan_status
    FROM orders o JOIN listings l ON l.id = o.listing_id JOIN hosts h ON h.id = l.host_id WHERE o.id = ${orderId}
  `)[0];
  // A guest-cancelled booking still pays the host the part the guest was
  // not refunded (payout_amount was reduced to it, _cancellations.js).
  // Host-cancelled and refunded-in-full bookings never have this flag.
  if (!o || !(o.status === 'paid' || (o.status === 'cancelled' && o.payout_on_cancel === true && Number(o.payout_amount) > 0))) return [];
  let shares = [];
  try {
    shares = await sql`SELECT s.cohost_guest_id, s.amount, g.name, g.email, p.account_holder_name, p.bank_account_number, p.bank_ifsc, p.status AS profile_status, p.razorpayx_fund_account_id, p.pan_number AS cohost_pan
                       FROM order_cohost_shares s JOIN guests g ON g.id = s.cohost_guest_id LEFT JOIN cohost_payout_profiles p ON p.guest_id = s.cohost_guest_id
                       WHERE s.order_id = ${orderId}`;
  } catch (e) { shares = []; }
  const commission = Number(o.commission_amount) || 0;
  const gross = (Number(o.payout_amount) || 0) + commission;
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
  const hostPan = !!o.host_pan && o.host_pan_status !== 'rejected';
  const hostRate = hostPan ? TDS_WITH_PAN() : TDS_WITHOUT_PAN();
  // The host's net is never below zero: TDS is at most what is left.
  const beforeTds = Math.max(0, round2(gross - commission - coTotal));
  const tds = Math.min(beforeTds, round2(Math.max(0, gross - coTotal) * hostRate / 100));
  let available = Math.max(0, round2(beforeTds - tds));
  let owed = [];
  // A coupon owed is deducted from ONE payout: those already listed on
  // another booking's payout that has not been sent yet are left out.
  try {
    owed = await sql`SELECT id, amount FROM host_penalties hp WHERE hp.host_id = ${o.host_id} AND hp.payer_guest_id IS NULL AND hp.status = 'owed'
                       AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.status IN ('due', 'processing', 'failed') AND p.order_id <> ${orderId} AND hp.id = ANY(p.deducted_penalty_ids))
                     ORDER BY hp.created_at`;
  } catch (e) { owed = []; }
  const deducted = [];
  let deductions = 0;
  for (const pn of owed) { if (deductions + Number(pn.amount) <= available) { deductions += Number(pn.amount); deducted.push(pn.id); } }
  const hostEmail = ((await sql`SELECT email FROM guests WHERE host_id = ${o.host_id} ORDER BY id LIMIT 1`)[0] || {}).email || null;
  const plans = [{
    payeeType: 'host', hostId: o.host_id, payeeGuestId: null, gross, commission, cohostShares: coTotal, deductions, deductedIds: deducted, tds, tdsRate: hostRate, panFurnished: hostPan,
    net: round2(available - deductions), email: hostEmail, name: o.host_name,
    bankLabel: [o.bank_account_holder_name, maskAccount(o.bank_account_number)].filter(Boolean).join(' · '),
    bank: { ready: o.bank_status === 'verified' && !!o.bank_account_number && !!o.bank_ifsc, holder: o.bank_account_holder_name, account: decryptField(o.bank_account_number), ifsc: o.bank_ifsc, fundAccountId: o.razorpayx_fund_account_id, table: 'hosts', key: o.host_id }
  }];
  for (const x of shares) {
    // Co-host: their share, less TDS only (no other deductions).
    const coPan = !!x.cohost_pan && x.profile_status === 'approved';
    const coRate = coPan ? TDS_WITH_PAN() : TDS_WITHOUT_PAN();
    const coTds = round2(Number(x.amount) * coRate / 100);
    plans.push({
      payeeType: 'cohost', hostId: o.host_id, payeeGuestId: x.cohost_guest_id, gross: Number(x.amount), commission: 0, cohostShares: 0, deductions: 0, deductedIds: [],
      tds: coTds, tdsRate: coRate, panFurnished: coPan,
      net: round2(Number(x.amount) - coTds), email: x.email, name: x.name,
      bankLabel: [x.account_holder_name, maskAccount(x.bank_account_number)].filter(Boolean).join(' · '),
      bank: { ready: x.profile_status === 'approved' && !!x.bank_account_number && !!x.bank_ifsc, holder: x.account_holder_name, account: decryptField(x.bank_account_number), ifsc: x.bank_ifsc, fundAccountId: x.razorpayx_fund_account_id, table: 'cohost_payout_profiles', key: x.cohost_guest_id }
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
  for (const plan of await planPayouts(sql, orderId)) {
    const r = await sql`
      INSERT INTO payouts (order_id, payee_type, host_id, payee_guest_id, status, gross, commission, cohost_shares, deductions, deducted_penalty_ids, tds, tds_rate, pan_furnished, net, bank_label, auto_eligible)
      VALUES (${orderId}, ${plan.payeeType}, ${plan.hostId}, ${plan.payeeGuestId}, 'due', ${plan.gross}, ${plan.commission}, ${plan.cohostShares}, ${plan.deductions}, ${plan.deductedIds}, ${plan.tds}, ${plan.tdsRate}, ${plan.panFurnished}, ${plan.net}, ${plan.bankLabel || null}, ${razorpayxReady()})
      ON CONFLICT DO NOTHING RETURNING *
    `;
    if (r[0]) created.push({ row: r[0], plan });
  }
  return created;
}

// ---------------------------------------------------------------------
// Security deposit compensation (Admin → resolve a disputed deposit).
// The part of a deposit Aerva decides goes to the host is paid as its OWN
// payout row (payouts.kind = 'deposit', sql/migration_payout_kinds.sql),
// next to the booking's payout: the booking's payout may already be sent,
// and its figures (commission, TDS) stay exactly as they were. Paid in full:
// no commission, no deductions, no TDS (it is compensation for damage, not
// a sale; see OWNER DECISIONS). Sent like any payout: automatically with
// RazorpayX (retried every 4 hours), or by hand (Mark paid, kind 'deposit').
// One per booking (unique index). Returns the row, or null if not created.
async function depositPayee(sql, hostId) {
  const { decryptField, maskAccount } = require('./_secure-fields');
  const h = (await sql`SELECT id, name, bank_account_holder_name, bank_account_number, bank_ifsc, bank_status, razorpayx_fund_account_id, pan_number, pan_status
                       FROM hosts WHERE id = ${hostId}`)[0];
  if (!h) return null;
  const email = ((await sql`SELECT email FROM guests WHERE host_id = ${hostId} ORDER BY id LIMIT 1`)[0] || {}).email || null;
  return {
    payeeType: 'host', hostId: h.id, payeeGuestId: null, email, name: h.name, panFurnished: !!h.pan_number && h.pan_status !== 'rejected',
    bankLabel: [h.bank_account_holder_name, maskAccount(h.bank_account_number)].filter(Boolean).join(' · '),
    bank: { ready: h.bank_status === 'verified' && !!h.bank_account_number && !!h.bank_ifsc, holder: h.bank_account_holder_name, account: decryptField(h.bank_account_number), ifsc: h.bank_ifsc, fundAccountId: h.razorpayx_fund_account_id, table: 'hosts', key: h.id }
  };
}
async function createDepositCompensationPayout(sql, { orderId, amount }) {
  const net = round2(Number(amount) || 0);
  if (!(net > 0)) return null;
  const o = (await sql`SELECT o.id, l.host_id FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${orderId}`)[0];
  if (!o) return null;
  const payee = await depositPayee(sql, o.host_id);
  if (!payee) return null;
  const r = await sql`
    INSERT INTO payouts (order_id, payee_type, host_id, payee_guest_id, status, gross, commission, cohost_shares, deductions, deducted_penalty_ids, tds, tds_rate, pan_furnished, net, bank_label, auto_eligible, kind)
    VALUES (${orderId}, 'host', ${o.host_id}, NULL, 'due', ${net}, 0, 0, 0, ${[]}, 0, 0, ${payee.panFurnished}, ${net}, ${payee.bankLabel || null}, ${razorpayxReady()}, 'deposit')
    ON CONFLICT DO NOTHING RETURNING *
  `;
  return r[0] || (await sql`SELECT * FROM payouts WHERE order_id = ${orderId} AND payee_type = 'host' AND kind = 'deposit'`)[0] || null;
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
async function attemptPayout(sql, payoutId, { by = 'automatic' } = {}) {
  if (!razorpayxReady()) return 'not_configured';
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
    const plan = row.kind === 'deposit'
      ? await depositPayee(sql, row.host_id)
      : (await planPayouts(sql, row.order_id)).find(p => p.payeeType === row.payee_type && (p.payeeGuestId || 0) === (row.payee_guest_id || 0));
    if (!plan || !plan.bank.ready) return back('due', 'Waiting for approved bank details');
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

// The scheduler (every run of get-listings ?runSchedules=1, the daily cron
// and site traffic). Throws when something failed, so the run is recorded
// as failed (Admin → Scheduled jobs) — after doing everything it could.
//   • bookings whose check-out day has reached 5 PM locally get their
//     payouts, sent at once;
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
      AND o.departure IS NOT NULL
      AND o.departure >= lt.local_now::date - 30
      AND (o.departure < lt.local_now::date OR (o.departure = lt.local_now::date AND extract(hour from lt.local_now) >= ${PAYOUT_HOUR}))
      AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.order_id = o.id AND p.payee_type = 'host' AND COALESCE(to_jsonb(p)->>'kind', 'booking') = 'booking')
    ORDER BY o.departure LIMIT 100
  `;
  // A booking with an open stay dispute is held until Aerva decides
  // (_stay-disputes.js): its payout may shrink to the nights used.
  let held = new Set();
  try {
    const ids = orders.map(o => o.id);
    if (ids.length) held = new Set((await sql`SELECT order_id FROM stay_disputes WHERE order_id = ANY(${ids}) AND status IN ('open', 'host_responded')`).map(r => r.order_id));
  } catch (err) { /* stay_disputes not created yet */ }
  // Each booking on its own: one that fails never holds back the others,
  // and is reported (Admin → Scheduled jobs) instead of passing as done.
  for (const o of orders) {
    if (Date.now() - started > deadlineMs) break;
    if (held.has(o.id)) continue;
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
  planPayouts, createPayoutRows, markPayoutSent, runAutoPayouts, attemptPayout, pollRazorpayX, razorpayxReady, PAYOUT_HOUR, RETRY_HOURS,
  createDepositCompensationPayout };
