// /api/_job-impact.js — who each scheduled job run affected. Not an endpoint.
//
// When a job finishes, _scheduler.js asks its impact function what it
// touched since the moment it started, and records the answer with the run
// (job_run_log) for Admin → Batch Jobs. Each lookup only reads, and only
// what that job itself writes, so the list is exact rather than a guess.
//
// Every entry: { who: 'Guest' | 'Host' | 'Co-host', name, email, what }.
// Capped at 500 people per run.

const CAP = 500;
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');

// Runs one lookup; a missing table or column means "nothing to report",
// never a failed job.
async function safe(fn) {
  try { return (await fn()) || []; } catch (err) { console.error('job impact lookup skipped:', err.message); return []; }
}
function dedupe(list) {
  const seen = new Set();
  return list.filter(p => { const k = [p.who, p.email || p.name, p.what].join('|'); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, CAP);
}
const guestOf = (r) => ({ who: 'Guest', name: r.guest_name || 'Guest', email: r.guest_email || '' });

const IMPACT = {
  // Bookings recorded (or refunded because the dates were taken) for
  // payments whose browser never came back.
  payment_reconcile: (sql, since) => safe(async () => {
    const rows = await sql`
      SELECT a.action, o.suite_name, o.guest_email, g.name AS guest_name
      FROM audit_log a JOIN orders o ON o.id = a.target_id LEFT JOIN guests g ON g.id = o.guest_id
      WHERE a.created_at >= ${since} AND a.action IN ('booking_confirmed', 'booking_conflict_refunded')
        AND a.metadata->>'source' = 'reconcile'`;
    return rows.map(r => ({ ...guestOf(r), what: r.action === 'booking_confirmed' ? `Booking recorded: ${r.suite_name}` : `Refunded in full (dates taken): ${r.suite_name}` }));
  }),

  // Cancellation requests the host left unanswered for 24 hours.
  unanswered_cancellations: (sql, since) => safe(async () => {
    const rows = await sql`
      SELECT a.metadata, o.suite_name, o.guest_email, g.name AS guest_name, l.host_id, h.name AS host_name, hg.email AS host_email
      FROM audit_log a JOIN orders o ON o.id = a.target_id JOIN listings l ON l.id = o.listing_id
      LEFT JOIN guests g ON g.id = o.guest_id LEFT JOIN hosts h ON h.id = l.host_id
      LEFT JOIN LATERAL (SELECT email FROM guests WHERE host_id = l.host_id ORDER BY id LIMIT 1) hg ON true
      WHERE a.created_at >= ${since} AND a.action = 'booking_cancelled_by_guest'
        AND a.metadata->>'by' IN ('timeout_policy', 'timeout_no_refund')`;
    const out = [];
    rows.forEach(r => {
      const m = r.metadata || {};
      out.push({ ...guestOf(r), what: `Cancelled with ${m.percent}% refund (${inr(m.refundCash)}): ${r.suite_name}` });
      out.push({ who: 'Host', name: r.host_name || 'Host', email: r.host_email || '', what: `Request settled automatically after 24 hours: ${r.suite_name}` });
    });
    return out;
  }),

  // Cancellation coupons released to guests.
  coupon_release: (sql, since) => safe(async () => {
    const rows = await sql`
      SELECT c.amount, g.name AS guest_name, g.email AS guest_email
      FROM audit_log a JOIN coupons c ON c.id = a.target_id LEFT JOIN guests g ON g.id = c.guest_id
      WHERE a.created_at >= ${since} AND a.action = 'cancellation_coupon_released'`;
    return rows.map(r => ({ ...guestOf(r), what: `Coupon of ${inr(r.amount)} released` }));
  }),

  // Everything one payouts run does: payouts created, sent or attempted
  // (first try or a 4-hourly retry), payouts the bank failed (found by
  // polling RazorpayX — the status changed since the snapshot taken before
  // the run), and refunds whose status Razorpay confirmed or failed.
  payouts: (sql, since, before) => safe(async () => {
    const was = (before && before.payouts) || {};
    const openIds = Object.keys(was).map(Number);
    const rows = await sql`
      SELECT p.id, p.payee_type, p.net, p.status, p.failure_reason, p.attempts, p.created_at, p.last_attempt_at, p.sent_at,
             o.suite_name, h.name AS host_name, hg.email AS host_email, cg.name AS co_name, cg.email AS co_email
      FROM payouts p JOIN orders o ON o.id = p.order_id JOIN hosts h ON h.id = p.host_id
      LEFT JOIN LATERAL (SELECT email FROM guests WHERE host_id = p.host_id ORDER BY id LIMIT 1) hg ON true
      LEFT JOIN guests cg ON cg.id = p.payee_guest_id
      WHERE p.created_at >= ${since} OR p.sent_at >= ${since} OR p.last_attempt_at >= ${since}
         OR p.id = ANY(${openIds}::int[])`;
    const label = { due: 'waiting to be sent', processing: 'being sent', sent: 'sent', failed: 'FAILED at the bank', cancelled: 'cancelled' };
    const out = [];
    rows.forEach(r => {
      const prior = was[r.id];
      const touched = new Date(r.created_at) >= new Date(since) || (r.sent_at && new Date(r.sent_at) >= new Date(since))
        || (r.last_attempt_at && new Date(r.last_attempt_at) >= new Date(since));
      if (!touched && (prior === undefined || prior === r.status)) return; // untouched and unchanged
      const retried = r.last_attempt_at && new Date(r.last_attempt_at) >= new Date(since) && Number(r.attempts) > 1;
      const what = `Payout ${inr(r.net)} ${label[r.status] || r.status}${retried ? ` (attempt ${Number(r.attempts)})` : ''}`
        + `${r.status === 'failed' && r.failure_reason ? ' — ' + r.failure_reason : ''}: ${r.suite_name}`;
      out.push(r.payee_type === 'cohost'
        ? { who: 'Co-host', name: r.co_name || 'Co-host', email: r.co_email || '', what }
        : { who: 'Host', name: r.host_name || 'Host', email: r.host_email || '', what });
    });
    // Refunds Razorpay settled during this run (pollRefunds stamps
    // last_checked_at on every check; only a changed status is news).
    const wasRefund = (before && before.refunds) || null;
    const refunds = await sql`
      SELECT r.id, r.kind, r.amount, r.status, r.failure_reason, o.suite_name, o.guest_email, g.name AS guest_name
      FROM refunds r JOIN orders o ON o.id = r.order_id LEFT JOIN guests g ON g.id = o.guest_id
      WHERE r.last_checked_at >= ${since} AND r.status IN ('processed', 'failed')`;
    const kind = { cancellation: 'Cancellation refund', deposit: 'Deposit refund', deposit_dispute: 'Deposit refund (dispute)' };
    refunds.forEach(r => {
      if (wasRefund && wasRefund[r.id] === r.status) return; // already settled before this run
      out.push({ ...guestOf(r), what: `${kind[r.kind] || 'Refund'} of ${inr(Number(r.amount) / 100)} ${r.status === 'processed' ? 'confirmed by Razorpay' : 'FAILED — retry in Refunds'}: ${r.suite_name}` });
    });
    return out;
  }),

  // Scheduled host messages sent to guests.
  template_messages: (sql, since) => safe(async () => {
    const rows = await sql`
      SELECT t.title, o.suite_name, o.guest_email, g.name AS guest_name
      FROM template_sends s JOIN orders o ON o.id = s.order_id LEFT JOIN guests g ON g.id = o.guest_id
      LEFT JOIN message_templates t ON t.id = s.template_id
      WHERE s.sent_at >= ${since}`;
    return rows.map(r => ({ ...guestOf(r), what: `Message sent${r.title ? ' (' + r.title + ')' : ''}: ${r.suite_name}` }));
  }),

  // Security deposits refunded (or attempted) after the hold ended.
  deposit_refunds: (sql, since) => safe(async () => {
    const rows = await sql`
      SELECT r.amount, r.status, o.suite_name, o.guest_email, g.name AS guest_name
      FROM refunds r JOIN orders o ON o.id = r.order_id LEFT JOIN guests g ON g.id = o.guest_id
      WHERE r.kind = 'deposit' AND (r.created_at >= ${since} OR r.last_checked_at >= ${since})`;
    return rows.map(r => ({ ...guestOf(r), what: `Deposit ${inr(Number(r.amount) / 100)} ${r.status === 'failed' ? 'refund FAILED — retry in Refunds' : 'refunded'}: ${r.suite_name}` }));
  }),

  // Reviews published.
  review_publish: (sql, since) => IMPACT._reviews(sql, since),
  _reviews: (sql, since) => safe(async () => {
    const lr = await sql`
      SELECT l.property_name, g.name AS guest_name, g.email AS guest_email, h.name AS host_name, hg.email AS host_email
      FROM listing_reviews r JOIN listings l ON l.id = r.listing_id LEFT JOIN guests g ON g.id = r.guest_id LEFT JOIN hosts h ON h.id = l.host_id
      LEFT JOIN LATERAL (SELECT email FROM guests WHERE host_id = l.host_id ORDER BY id LIMIT 1) hg ON true
      WHERE r.published_at >= ${since}`;
    const gr = await sql`
      SELECT g.name AS guest_name, g.email AS guest_email, l.property_name
      FROM guest_reviews r LEFT JOIN guests g ON g.id = r.guest_id LEFT JOIN listings l ON l.id = r.listing_id
      WHERE r.published_at >= ${since}`;
    return [
      ...lr.map(r => ({ ...guestOf(r), what: `Their review of ${r.property_name} is now live` })),
      ...lr.map(r => ({ who: 'Host', name: r.host_name || 'Host', email: r.host_email || '', what: `New review on ${r.property_name} is now live` })),
      ...gr.map(r => ({ ...guestOf(r), what: `Host’s review of them is now live (${r.property_name})` }))
    ];
  }),

  // External calendars synced (hosts whose listings were updated).
  calendar_sync: (sql, since) => safe(async () => {
    const rows = await sql`
      SELECT f.name, f.last_status, f.event_count, f.last_error, l.property_name, h.name AS host_name, hg.email AS host_email
      FROM calendar_feeds f JOIN listings l ON l.id = f.listing_id LEFT JOIN hosts h ON h.id = l.host_id
      LEFT JOIN LATERAL (SELECT email FROM guests WHERE host_id = l.host_id ORDER BY id LIMIT 1) hg ON true
      WHERE f.last_synced_at >= ${since}`;
    return rows.map(r => ({ who: 'Host', name: r.host_name || 'Host', email: r.host_email || '',
      what: r.last_status === 'ok' ? `${r.property_name}: ${r.name || 'calendar'} synced (${Number(r.event_count) || 0} dates)` : `${r.property_name}: ${r.name || 'calendar'} FAILED — ${r.last_error || 'error'}` }));
  }),

  // The daily job: review prompts, compliance flags and blocks, badges.
  daily_reviews_compliance_tiers: (sql, since) => safe(async () => {
    const out = [];
    out.push(...await IMPACT._reviews(sql, since));
    const prompts = await sql`
      SELECT o.suite_name, o.guest_email, g.name AS guest_name FROM orders o LEFT JOIN guests g ON g.id = o.guest_id
      WHERE o.review_prompt_sent_at >= ${since}`;
    prompts.forEach(r => out.push({ ...guestOf(r), what: `Asked to review ${r.suite_name}` }));
    const flags = await sql`
      SELECT f.requirement_key, l.property_name, h.name AS host_name, hg.email AS host_email
      FROM compliance_flags f JOIN listings l ON l.id = f.listing_id LEFT JOIN hosts h ON h.id = l.host_id
      LEFT JOIN LATERAL (SELECT email FROM guests WHERE host_id = l.host_id ORDER BY id LIMIT 1) hg ON true
      WHERE f.created_at >= ${since}`;
    flags.forEach(r => out.push({ who: 'Host', name: r.host_name || 'Host', email: r.host_email || '', what: `Action needed on ${r.property_name} (${r.requirement_key.replace(/_/g, ' ')})` }));
    const blocked = await sql`
      SELECT l.property_name, h.name AS host_name, hg.email AS host_email
      FROM audit_log a JOIN listings l ON l.id = a.target_id LEFT JOIN hosts h ON h.id = l.host_id
      LEFT JOIN LATERAL (SELECT email FROM guests WHERE host_id = l.host_id ORDER BY id LIMIT 1) hg ON true
      WHERE a.created_at >= ${since} AND a.action = 'compliance_deadline_enforced' AND (a.metadata->>'wasBlocked')::boolean IS TRUE`;
    blocked.forEach(r => out.push({ who: 'Host', name: r.host_name || 'Host', email: r.host_email || '', what: `${r.property_name} hidden until fixed (deadline passed)` }));
    const tiers = await sql`
      SELECT t.subject_type, t.subject_id, t.tier_label, t.previous_key,
             CASE t.subject_type WHEN 'guest' THEN gg.name WHEN 'host' THEN hh.name ELSE lh.name END AS person,
             CASE t.subject_type WHEN 'guest' THEN gg.email ELSE hgm.email END AS email,
             ll.property_name
      FROM tier_history t
      LEFT JOIN guests gg ON t.subject_type = 'guest' AND gg.id = t.subject_id
      LEFT JOIN hosts hh ON t.subject_type = 'host' AND hh.id = t.subject_id
      LEFT JOIN listings ll ON t.subject_type = 'listing' AND ll.id = t.subject_id
      LEFT JOIN hosts lh ON lh.id = ll.host_id
      LEFT JOIN LATERAL (SELECT email FROM guests WHERE host_id = COALESCE(hh.id, lh.id) ORDER BY id LIMIT 1) hgm ON true
      WHERE t.changed_at >= ${since}`;
    tiers.forEach(r => out.push({ who: r.subject_type === 'guest' ? 'Guest' : 'Host', name: r.person || '—', email: r.email || '',
      what: `${r.subject_type === 'listing' ? (r.property_name || 'Listing') + ' badge' : 'Badge'}: ${r.tier_label || 'none'}${r.previous_key ? ' (was ' + r.previous_key.replace(/_/g, ' ') + ')' : ''}` }));
    return out;
  }),

  // Next-day refunds for payments that did not match the booking amount.
  scheduled_refunds: (sql, since) => safe(async () => {
    const rows = await sql`
      SELECT s.amount_inr, s.status, o.suite_name, o.guest_email, g.name AS guest_name
      FROM scheduled_refunds s JOIN orders o ON o.id = s.order_ids[1] LEFT JOIN guests g ON g.id = o.guest_id
      WHERE s.processed_at >= ${since}`;
    return rows.map(r => ({ ...guestOf(r), what: `Refund of ${inr(r.amount_inr)} ${r.status === 'done' ? 'sent' : 'FAILED — retry in Refunds'} (amount mismatch): ${r.suite_name}` }));
  }),

  // Booking changes closed because their time ran out.
  booking_changes_expiry: (sql, since) => safe(async () => {
    const rows = await sql`
      SELECT c.summary, o.suite_name, o.guest_email, g.name AS guest_name
      FROM booking_changes c JOIN orders o ON o.id = c.order_id LEFT JOIN guests g ON g.id = o.guest_id
      JOIN messages m ON m.conversation_id = (SELECT id FROM conversations WHERE order_id = o.id LIMIT 1)
      WHERE c.status = 'expired' AND m.created_at >= ${since} AND m.display_text LIKE 'The change request has closed%'`;
    return rows.map(r => ({ ...guestOf(r), what: `Change request closed (time limit): ${r.suite_name}` }));
  }),

  currency_rates: async () => []
};

// State some jobs need from just BEFORE they run, to tell what changed.
// Only payouts: a payout the bank fails is marked failed by polling with
// no timestamp of its own, so it is found by comparing statuses.
const BEFORE = {
  payouts: async (sql) => {
    const payouts = {}, refunds = {};
    const p = await sql`SELECT id, status FROM payouts WHERE status IN ('due', 'processing', 'failed')`;
    p.forEach(r => { payouts[r.id] = r.status; });
    const f = await sql`SELECT id, status FROM refunds WHERE status IN ('new', 'creating', 'pending', 'failed')`;
    f.forEach(r => { refunds[r.id] = r.status; });
    return { payouts, refunds };
  }
};
async function impactBefore(sql, jobName) {
  const fn = BEFORE[jobName];
  if (!fn) return null;
  try { return await fn(sql); } catch (err) { console.error('job impact snapshot skipped:', err.message); return null; }
}

async function impactFor(sql, jobName, since, before = null) {
  const fn = IMPACT[jobName];
  return fn ? dedupe(await fn(sql, since, before)) : [];
}

module.exports = { impactFor, impactBefore, IMPACT_JOBS: () => Object.keys(IMPACT).filter(k => !k.startsWith('_')) };
