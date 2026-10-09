// /api/_support-actions.js — the support team's roles, and actions that need
// a second person's approval. Not an endpoint (get-pending-listings.js).
//
// ROLES (admins.role):
//   agent    — customer representative: answers requests (Support), looks up
//              bookings and accounts (Lookup, read only), and PROPOSES actions.
//   reviewer — everything an agent can, plus approves or rejects proposals.
//   admin    — everything, including acting directly and managing the team.
//
// PROPOSED ACTIONS (support_actions): an agent proposes, with a reason; the
// conversation is summarised for the reviewer and the effect worked out in
// advance (how much is refunded, who pays). Nothing happens until a reviewer
// or admin — never the person who proposed it — approves. Approval runs the
// action through the same code Admin uses directly, so every money rule
// (no double refunds, payouts already sent, deposits) still applies.
//   cancel_refund       cancel the booking with a refund %, optionally the service fee
//   partial_refund      refund an amount without cancelling (Aerva or the host pays)
//   deposit_refund      refund the security deposit (all, or part — the rest to the host)
//   report_guest / report_host   put a report on record
//   block_guest_listing keep one guest away from one listing

const { logAudit } = require('./_audit-log');
const { executePolicyCancellation } = require('./_cancellations');
const lookup = require('./_admin-lookup');
const { safeRefund } = require('./_refunds');
const { refundSubunitForInr } = require('./_currency');
const { createDepositCompensationPayout } = require('./_payouts');
const { notifyDepositDispute } = require('./_deposits');

const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const soft = async (q, fb = []) => { try { return await q; } catch (e) { return fb; } };

const ROLES = { admin: 'Admin', reviewer: 'Reviewer', agent: 'Customer representative' };
const KINDS = {
  cancel_refund: 'Cancel the booking with a refund',
  partial_refund: 'Refund without cancelling',
  deposit_refund: 'Refund the security deposit',
  report_guest: 'Report the guest',
  report_host: 'Report the host',
  block_guest_listing: 'Block the guest from this listing'
};

// ---------------------------------------------------------------- roles

async function roleOf(sql, sessionPayload, hasValidSecret) {
  if (!sessionPayload) return hasValidSecret ? 'admin' : null;
  const r = (await soft(sql`SELECT to_jsonb(a)->>'role' AS role FROM admins a WHERE a.id = ${Number(sessionPayload.listingId) || 0}`))[0];
  const role = r && r.role;
  return ROLES[role] ? role : 'admin';      // before the migration: everyone is an admin
}

// What each role may call on get-pending-listings.js. Admin: everything.
// Others: only these request keys (a GET's query keys, a POST's body keys).
const MODIFIERS = new Set(['q', 'status', 'subject', 'limit', 'offset', 'before', 'ref', 'mine']);
const AGENT_GET = new Set(['adminSummary', 'adminMe', 'supportTickets', 'supportTicket', 'lookup', 'lookupBooking', 'lookupGuest', 'lookupListing', 'supportActions', 'priceReviews']);
const AGENT_POST = new Set(['supportReply', 'supportCase', 'proposeAction', 'withdrawAction', 'adminSignOutEverywhere']);
const REVIEWER_POST = new Set([...AGENT_POST, 'reviewAction', 'decidePriceReview']);
function allowed(role, req) {
  if (role === 'admin') return true;
  if (!ROLES[role]) return false;
  if (req.method === 'GET' || req.method === 'OPTIONS') {
    const keys = Object.keys(req.query || {}).filter(k => !MODIFIERS.has(k));
    return keys.length > 0 && keys.every(k => AGENT_GET.has(k));
  }
  const keys = Object.keys(req.body || {});
  const set = role === 'reviewer' ? REVIEWER_POST : AGENT_POST;
  return keys.length > 0 && keys.every(k => set.has(k));
}

async function me(sql, sessionPayload, role) {
  const a = sessionPayload ? (await soft(sql`SELECT id, email, name FROM admins WHERE id = ${Number(sessionPayload.listingId) || 0}`))[0] : null;
  return { id: a ? a.id : null, email: a ? a.email : 'master secret', name: a ? a.name : null, role, roleLabel: ROLES[role] || role, kinds: KINDS };
}

async function team(sql) {
  return { roles: ROLES, team: await sql`SELECT id, email, name, created_at, COALESCE(to_jsonb(a)->>'role', 'admin') AS role FROM admins a ORDER BY id` };
}
async function setRole(sql, { adminId, role, byId, audit }) {
  if (!ROLES[role]) throw userError('Choose a role.');
  const target = (await sql`SELECT id, email, COALESCE(to_jsonb(a)->>'role', 'admin') AS role FROM admins a WHERE id = ${Number(adminId) || 0}`)[0];
  if (!target) throw userError('Team member not found.', 404);
  if (target.role === 'admin' && role !== 'admin') {
    const admins = (await sql`SELECT count(*)::int AS n FROM admins a WHERE COALESCE(to_jsonb(a)->>'role', 'admin') = 'admin'`)[0].n;
    if (admins <= 1) throw userError('There must always be at least one admin.', 409);
  }
  try { await sql`UPDATE admins SET role = ${role} WHERE id = ${target.id}`; }
  catch (err) { throw userError('Run the roles database update first (Admin → Database updates).', 503); }
  // A changed role takes effect at once: their sessions end.
  if (Number(target.id) !== Number(byId)) await soft(sql`UPDATE admins SET session_version = COALESCE(session_version, 0) + 1 WHERE id = ${target.id}`);
  await logAudit(sql, { action: 'admin_role_changed', success: true, actorType: 'admin', ...audit, targetType: 'admin', targetId: target.id, metadata: { email: target.email, from: target.role, to: role } });
  return team(sql);
}

// ---------------------------------------------------------------- the summary for the reviewer

async function summarise(sql, { ticketId, orderId, reason, kind }) {
  let timeline = '';
  if (ticketId) {
    const t = (await soft(sql`SELECT ref, subject, category, created_at FROM support_tickets WHERE id = ${ticketId}`))[0];
    const msgs = await soft(sql`SELECT sender, internal, body, created_at FROM support_messages WHERE ticket_id = ${ticketId} ORDER BY created_at, id`);
    const notes = await soft(sql`SELECT summary, outcome FROM support_case_notes WHERE ticket_id = ${ticketId} ORDER BY created_at DESC LIMIT 1`);
    if (t) timeline = `Request ${t.ref} (${t.category}): ${t.subject}\n` + msgs.map(m => `${m.sender === 'user' ? 'Customer' : m.sender === 'support' ? (m.internal ? 'Agent note' : 'Agent') : 'System'}: ${String(m.body).slice(0, 1500)}`).join('\n')
      + (notes[0] ? `\nCase record — issue: ${notes[0].summary || '—'}; outcome: ${notes[0].outcome || '—'}` : '');
  }
  const fallback = (timeline ? timeline.split('\n').slice(0, 1).join(' ') + '. ' : '') + `Agent's reason: ${reason}`;
  if (!process.env.ANTHROPIC_API_KEY || !timeline) return fallback;
  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.SUPPORT_CHAT_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 400,
        system: 'You summarise an Aerva customer-support conversation for a reviewer who must approve or reject an action. Be neutral and factual, at most 120 words, plain text. Cover: what the customer reported, what evidence or facts appear in the conversation, what was already tried, and what the customer is asking for. Do not recommend a decision.',
        messages: [{ role: 'user', content: `Proposed action: ${KINDS[kind]}${orderId ? ' on booking ' + orderId : ''}.\nAgent's reason: ${reason}\n\nConversation:\n${timeline.slice(0, 24000)}` }] }) });
    clearTimeout(timer);
    const d = await r.json().catch(() => ({}));
    const text = (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    return r.ok && text ? text : fallback;
  } catch (e) { return fallback; }
}

// ---------------------------------------------------------------- proposing

async function checkAndPreview(sql, kind, p) {
  const order = p.orderId ? (await sql`SELECT o.*, l.host_id, l.property_name FROM orders o LEFT JOIN listings l ON l.id = o.listing_id WHERE o.id = ${Number(p.orderId)}`)[0] : null;
  if (['cancel_refund', 'partial_refund', 'deposit_refund'].includes(kind) && !order) throw userError('Choose the booking.');
  if (kind === 'cancel_refund') {
    const pct = Number(p.refundPercent);
    if (!(pct >= 0 && pct <= 100)) throw userError('Refund must be 0 to 100%.');
    if (order.status !== 'paid') throw userError('Only a confirmed booking can be cancelled.');
    const pv = await executePolicyCancellation(sql, null, { orderId: order.id, pct, by: 'admin', note: '', refundFee: !!p.refundFee, preview: true });
    return { order, params: { orderId: order.id, refundPercent: pct, refundFee: !!p.refundFee, countAgainstHost: !!p.countAgainstHost },
             preview: { refundCash: pv.refundCash, couponBack: pv.couponBack, feeRefunded: pv.feeRefunded, alreadyRefunded: pv.alreadyRefunded, hostPayout: pv.hostPayout, items: pv.items } };
  }
  if (kind === 'partial_refund') {
    const amount = Math.round(Number(p.amount) || 0);
    const money = await lookup.moneyState(sql, order.id);
    if (amount <= 0) throw userError('Enter the amount to refund.');
    if (amount > money.refundable) throw userError(`At most ${inr(money.refundable)} can be refunded on this booking.`);
    if (p.hostPays && amount > Number(order.payout_amount)) throw userError(`The host's payout for this booking is ${inr(order.payout_amount)} — less than the refund.`);
    return { order, params: { orderId: order.id, amount, hostPays: !!p.hostPays }, preview: { refund: amount, paidBy: p.hostPays ? 'host' : 'Aerva', refundableBefore: money.refundable } };
  }
  if (kind === 'deposit_refund') {
    const deposit = Math.round(Number(order.deposit_amount) || 0);
    if (!deposit || !['held', 'disputed'].includes(order.deposit_status)) throw userError('This booking has no deposit still held.');
    const amount = p.amount === '' || p.amount == null ? deposit : Math.round(Number(p.amount));
    if (!(amount >= 0 && amount <= deposit)) throw userError(`The guest can get back 0 to ${inr(deposit)}.`);
    return { order, params: { orderId: order.id, amount }, preview: { toGuest: amount, toHost: deposit - amount, deposit } };
  }
  if (kind === 'report_guest' || kind === 'report_host' || kind === 'block_guest_listing') {
    let guestId = Number(p.guestId) || null, listingId = Number(p.listingId) || null;
    if (!guestId && p.guestEmail) guestId = await guestByEmail(sql, p.guestEmail);
    if (order) { if (!listingId) listingId = order.listing_id; if (!guestId && kind !== 'report_host') guestId = order.guest_id; }
    if (kind === 'report_host') {
      if (!listingId) throw userError('Choose the listing (or booking) the host is reported for.');
      const host = (await sql`SELECT g.id FROM listings l JOIN guests g ON g.host_id = l.host_id WHERE l.id = ${listingId} ORDER BY g.id LIMIT 1`)[0];
      guestId = host ? host.id : null;
    }
    if (kind !== 'report_host' && !guestId) throw userError('Choose the guest.');
    if (kind === 'block_guest_listing' && !listingId) throw userError('Choose the listing.');
    const g = guestId ? (await sql`SELECT id, name, email FROM guests WHERE id = ${guestId}`)[0] : null;
    const l = listingId ? (await sql`SELECT id, property_name FROM listings WHERE id = ${listingId}`)[0] : null;
    return { order, params: { orderId: order ? order.id : null, guestId, listingId }, preview: { person: g ? `${g.name || ''} (${g.email || 'no email'})` : null, listing: l ? l.property_name : null } };
  }
  throw userError('Unknown action.');
}

async function propose(sql, { kind, params = {}, reason, ticketId = null, admin, audit }) {
  if (!KINDS[kind]) throw userError('Choose what should be done.');
  const why = String(reason || '').trim().slice(0, 1500);
  if (why.length < 10) throw userError('Explain why, in a sentence or two — the reviewer decides on it.');
  const tid = Number(ticketId) || null;
  if (tid && !(await sql`SELECT 1 FROM support_tickets WHERE id = ${tid}`).length) throw userError('Support request not found.', 404);
  const c = await checkAndPreview(sql, kind, params);
  const dup = c.params.orderId ? (await sql`SELECT id FROM support_actions WHERE kind = ${kind} AND order_id = ${c.params.orderId} AND status IN ('pending', 'approving')`)[0] : null;
  if (dup) throw userError(`This is already waiting for approval (#${dup.id}).`, 409);
  const summary = await summarise(sql, { ticketId: tid, orderId: c.params.orderId, reason: why, kind });
  const row = (await sql`INSERT INTO support_actions (kind, ticket_id, order_id, guest_id, listing_id, params, reason, summary, preview, proposed_by, proposed_by_email)
    VALUES (${kind}, ${tid}, ${c.params.orderId || null}, ${c.params.guestId || (c.order ? c.order.guest_id : null) || null}, ${c.params.listingId || (c.order ? c.order.listing_id : null) || null},
            ${JSON.stringify(c.params)}::jsonb, ${why}, ${summary}, ${JSON.stringify(c.preview)}::jsonb, ${admin.id}, ${admin.email}) RETURNING *`)[0];
  if (tid) await sql`INSERT INTO support_messages (ticket_id, sender, internal, admin_email, body) VALUES (${tid}, 'support', true, ${admin.email},
                      ${`Proposed for approval (#${row.id}): ${KINDS[kind]}. ${describe(kind, c.params, c.preview)} Reason: ${why}`})`;
  await logAudit(sql, { action: 'support_action_proposed', success: true, actorType: 'admin', ...audit, targetType: 'support_action', targetId: row.id,
    metadata: { kind, orderId: row.order_id, ticketId: tid, params: c.params } });
  await notifyReviewers(sql, row);
  return row;
}
function describe(kind, p, pv = {}) {
  if (kind === 'cancel_refund') return `${p.refundPercent}% of the booking price${p.refundFee ? ' plus the service fee' : ''} — guest gets ${inr(pv.refundCash)}${pv.couponBack ? ' + ' + inr(pv.couponBack) + ' coupon' : ''}, host ${inr(pv.hostPayout)}.`;
  if (kind === 'partial_refund') return `${inr(p.amount)} back to the guest, paid by ${p.hostPays ? 'the host' : 'Aerva'}; the booking stays.`;
  if (kind === 'deposit_refund') return `${inr(pv.toGuest)} of the ${inr(pv.deposit)} deposit back to the guest${pv.toHost ? `, ${inr(pv.toHost)} to the host` : ''}.`;
  if (kind === 'block_guest_listing') return `${pv.person || 'The guest'} would no longer see or book ${pv.listing || 'the listing'}.`;
  return pv.person ? `About ${pv.person}${pv.listing ? ' at ' + pv.listing : ''}.` : '';
}
async function notifyReviewers(sql, row) {
  if (!process.env.RESEND_API_KEY) return;
  const to = (await soft(sql`SELECT email FROM admins a WHERE COALESCE(to_jsonb(a)->>'role', 'admin') IN ('reviewer', 'admin') AND id <> ${row.proposed_by || 0}`)).map(r => r.email).filter(Boolean);
  if (!to.length) return;
  try {
    await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva Admin <hello@aerva.in>', to, subject: `Approval needed #${row.id}: ${KINDS[row.kind]}`,
        html: `<div style="font-family:sans-serif; max-width:520px;"><p><strong>${KINDS[row.kind]}</strong> — proposed by ${String(row.proposed_by_email || '').replace(/</g, '&lt;')}</p><p>${String(row.reason).replace(/</g, '&lt;')}</p><p>Review it in Admin → Approvals.</p></div>` }) });
  } catch (e) { /* the list in Admin is the record */ }
}

async function withdraw(sql, { id, admin, audit }) {
  const r = await sql`UPDATE support_actions SET status = 'withdrawn', reviewed_at = now(), reviewed_by_email = ${admin.email} WHERE id = ${Number(id) || 0} AND status = 'pending' AND proposed_by = ${admin.id} RETURNING id`;
  if (!r.length) throw userError('Only your own proposals still waiting for approval can be withdrawn.', 409);
  await logAudit(sql, { action: 'support_action_withdrawn', success: true, actorType: 'admin', ...audit, targetType: 'support_action', targetId: Number(id) });
  return { ok: true };
}

async function list(sql, { status = 'pending' } = {}) {
  const want = status === 'all' ? null : status === 'done' ? ['done', 'failed', 'rejected', 'withdrawn'] : ['pending', 'approving'];
  const rows = await sql`
    SELECT a.*, t.ref AS ticket_ref, o.suite_name, o.arrival, o.departure, o.status AS booking_status, o.total, to_jsonb(o)->>'confirmation_code' AS code,
           g.name AS guest_name, g.email AS guest_email, l.property_name
    FROM support_actions a
    LEFT JOIN support_tickets t ON t.id = a.ticket_id LEFT JOIN orders o ON o.id = a.order_id
    LEFT JOIN guests g ON g.id = a.guest_id LEFT JOIN listings l ON l.id = a.listing_id
    WHERE (${want}::text[] IS NULL OR a.status = ANY(${want}::text[]))
    ORDER BY (a.status IN ('pending', 'approving')) DESC, a.proposed_at DESC LIMIT 200`;
  const counts = await sql`SELECT status, count(*)::int AS n FROM support_actions GROUP BY status`;
  return { kinds: KINDS, actions: rows.map(r => ({ ...r, kindLabel: KINDS[r.kind], description: describe(r.kind, r.params || {}, r.preview || {}) })), counts: Object.fromEntries(counts.map(c => [c.status, c.n])) };
}

// ---------------------------------------------------------------- approving

async function refundDeposit(sql, razorpay, { orderId, amount, adminLabel }) {
  const o = (await sql`SELECT id, razorpay_payment_id, razorpay_order_id, deposit_amount, deposit_status, charge_currency FROM orders WHERE id = ${orderId}`)[0];
  if (!o || !['held', 'disputed'].includes(o.deposit_status)) throw userError('The deposit is no longer held — it may have been refunded already.', 409);
  const deposit = Math.round(Number(o.deposit_amount) || 0);
  const toGuest = Math.max(0, Math.min(deposit, Math.round(Number(amount) || 0)));
  const toHost = deposit - toGuest;
  const claim = await sql`UPDATE orders SET deposit_status = 'resolving' WHERE id = ${o.id} AND deposit_status IN ('held', 'disputed') RETURNING id`;
  if (!claim.length) throw userError('The deposit is already being handled.', 409);
  let refundId = null;
  try {
    if (toGuest > 0) {
      if (!o.razorpay_payment_id) throw userError('No payment is recorded for this booking, so the deposit cannot be refunded automatically.');
      const currency = o.charge_currency || 'INR';
      const sub = currency === 'INR' ? toGuest * 100 : await refundSubunitForInr(sql, { razorpayOrderId: o.razorpay_order_id, amountInr: toGuest, currency });
      if (!sub) throw userError(`There is no record of the amount charged in ${currency}.`, 502);
      refundId = (await safeRefund(sql, razorpay, { orderId: o.id, paymentId: o.razorpay_payment_id, amountSubunit: sub, kind: toHost ? 'deposit_dispute' : 'deposit' })).id;
    }
  } catch (err) {
    await sql`UPDATE orders SET deposit_status = ${o.deposit_status} WHERE id = ${o.id} AND deposit_status = 'resolving'`;
    throw err.isUserFacing ? err : userError('Razorpay could not refund the deposit: ' + String(err.error && err.error.description || err.message), 502);
  }
  await sql`UPDATE orders SET deposit_status = ${toHost ? 'resolved' : 'refunded'}, deposit_resolution_amount = ${toHost}, deposit_refund_id = ${refundId} WHERE id = ${o.id}`;
  let payoutId = null;
  if (toHost > 0) { try { const p = await createDepositCompensationPayout(sql, { orderId: o.id, amount: toHost }); payoutId = p ? p.id : null; } catch (e) { console.error('deposit compensation payout not created:', e.message); } }
  try { await notifyDepositDispute(sql, o.id, 'resolved', { compensation: toHost, refunded: toGuest }); } catch (e) { /* email is a courtesy */ }
  await logAudit(sql, { action: 'deposit_refunded_by_admin', success: true, actorType: 'admin', actorIdentifier: adminLabel, targetType: 'order', targetId: o.id, metadata: { toGuest, toHost, refundId, payoutId } });
  return { toGuest, toHost, refundId, payoutId };
}

async function addReport(sql, { kind, guestId, listingId, orderId, ticketId, actionId, reason, by }) {
  const r = (await sql`INSERT INTO user_reports (kind, guest_id, listing_id, order_id, ticket_id, action_id, reason, created_by)
                       VALUES (${kind}, ${guestId || null}, ${listingId || null}, ${orderId || null}, ${ticketId || null}, ${actionId || null}, ${reason}, ${by}) RETURNING id`)[0];
  return { reportId: r.id };
}

async function guestByEmail(sql, email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e.includes('@')) return null;
  const g = (await sql`SELECT id FROM guests WHERE lower(email) = ${e} AND deleted_at IS NULL ORDER BY id LIMIT 1`)[0];
  if (!g) throw userError(`No Aerva account uses ${e}.`, 404);
  return g.id;
}

async function blockGuest(sql, { listingId, guestId, guestEmail, reason, by, audit }) {
  if (!guestId && guestEmail) guestId = await guestByEmail(sql, guestEmail);
  const l = (await sql`SELECT id FROM listings WHERE id = ${Number(listingId) || 0}`)[0];
  const g = (await sql`SELECT id FROM guests WHERE id = ${Number(guestId) || 0}`)[0];
  if (!l || !g) throw userError('Choose an existing listing and guest.', 404);
  await sql`INSERT INTO listing_guest_blocks (listing_id, guest_id, reason, created_by) VALUES (${l.id}, ${g.id}, ${reason || null}, ${by})
            ON CONFLICT (listing_id, guest_id) DO UPDATE SET reason = EXCLUDED.reason`;
  await logAudit(sql, { action: 'listing_guest_blocked', success: true, actorType: 'admin', ...(audit || { actorIdentifier: by }), targetType: 'listing', targetId: l.id, metadata: { guestId: g.id, reason } });
  return { listingId: l.id, guestId: g.id };
}
async function unblockGuest(sql, { listingId, guestId, audit }) {
  const r = await sql`DELETE FROM listing_guest_blocks WHERE listing_id = ${Number(listingId) || 0} AND guest_id = ${Number(guestId) || 0} RETURNING listing_id`;
  if (!r.length) throw userError('That guest is not blocked from this listing.', 404);
  await logAudit(sql, { action: 'listing_guest_unblocked', success: true, actorType: 'admin', ...audit, targetType: 'listing', targetId: Number(listingId), metadata: { guestId: Number(guestId) } });
  return { ok: true };
}

async function review(sql, razorpay, { id, approve, note, admin, audit }) {
  const a = (await sql`SELECT * FROM support_actions WHERE id = ${Number(id) || 0}`)[0];
  if (!a) throw userError('Proposal not found.', 404);
  if (Number(a.proposed_by) === Number(admin.id)) throw userError('Someone else has to approve your own proposal.', 403);
  const why = String(note || '').trim().slice(0, 1000);
  if (!approve) {
    if (why.length < 5) throw userError('Say why it is rejected — the representative sees it.');
    const r = await sql`UPDATE support_actions SET status = 'rejected', reviewed_by = ${admin.id}, reviewed_by_email = ${admin.email}, reviewed_at = now(), review_note = ${why}
                        WHERE id = ${a.id} AND status = 'pending' RETURNING id`;
    if (!r.length) throw userError('This proposal has already been decided.', 409);
    if (a.ticket_id) await sql`INSERT INTO support_messages (ticket_id, sender, internal, admin_email, body) VALUES (${a.ticket_id}, 'support', true, ${admin.email}, ${`Proposal #${a.id} rejected: ${why}`})`;
    await logAudit(sql, { action: 'support_action_rejected', success: true, actorType: 'admin', ...audit, targetType: 'support_action', targetId: a.id, metadata: { kind: a.kind, note: why } });
    return { status: 'rejected' };
  }
  // Only one approval runs: pending → approving in one statement.
  const claim = await sql`UPDATE support_actions SET status = 'approving', reviewed_by = ${admin.id}, reviewed_by_email = ${admin.email}, reviewed_at = now(), review_note = ${why || null}
                          WHERE id = ${a.id} AND status = 'pending' RETURNING id`;
  if (!claim.length) throw userError('This proposal has already been decided.', 409);
  const p = a.params || {};
  const label = `${admin.email} (approved #${a.id}, proposed by ${a.proposed_by_email})`;
  let result;
  try {
    if (a.kind === 'cancel_refund') {
      result = await executePolicyCancellation(sql, razorpay, { orderId: p.orderId, pct: p.refundPercent, by: 'admin', note: a.reason.slice(0, 300), refundFee: !!p.refundFee, countAgainstHost: !!p.countAgainstHost, adminLabel: label });
    } else if (a.kind === 'partial_refund') {
      result = await lookup.partialRefund(sql, razorpay, { orderId: p.orderId, amount: p.amount, reason: a.reason.slice(0, 400), hostPays: !!p.hostPays, adminLabel: label });
    } else if (a.kind === 'deposit_refund') {
      result = await refundDeposit(sql, razorpay, { orderId: p.orderId, amount: p.amount, adminLabel: label });
    } else if (a.kind === 'report_guest' || a.kind === 'report_host') {
      result = await addReport(sql, { kind: a.kind === 'report_guest' ? 'guest' : 'host', guestId: p.guestId, listingId: p.listingId, orderId: p.orderId, ticketId: a.ticket_id, actionId: a.id, reason: a.reason, by: label });
    } else if (a.kind === 'block_guest_listing') {
      result = await blockGuest(sql, { listingId: p.listingId, guestId: p.guestId, reason: a.reason, by: label });
    }
  } catch (err) {
    const msg = String(err.message || err).slice(0, 500);
    await sql`UPDATE support_actions SET status = 'failed', error = ${msg} WHERE id = ${a.id}`;
    if (a.ticket_id) await sql`INSERT INTO support_messages (ticket_id, sender, internal, admin_email, body) VALUES (${a.ticket_id}, 'support', true, ${admin.email}, ${`Proposal #${a.id} approved, but it could not be carried out: ${msg}`})`;
    await logAudit(sql, { action: 'support_action_failed', success: false, actorType: 'admin', ...audit, targetType: 'support_action', targetId: a.id, metadata: { kind: a.kind, error: msg } });
    throw userError(`Approved, but it could not be carried out: ${msg}`, err.status || 502);
  }
  await sql`UPDATE support_actions SET status = 'done', result = ${JSON.stringify(result || {})}::jsonb WHERE id = ${a.id}`;
  if (a.ticket_id) await sql`INSERT INTO support_messages (ticket_id, sender, internal, admin_email, body) VALUES (${a.ticket_id}, 'support', true, ${admin.email}, ${`Proposal #${a.id} approved and done: ${KINDS[a.kind]}.`})`;
  await logAudit(sql, { action: 'support_action_approved', success: true, actorType: 'admin', ...audit, targetType: 'support_action', targetId: a.id, metadata: { kind: a.kind, proposedBy: a.proposed_by_email, result } });
  return { status: 'done', result };
}

// ---------------------------------------------------------------- for Lookup and the site

async function recordsFor(sql, { guestId = null, listingId = null, orderId = null }) {
  const [reports, blocks, actions] = await Promise.all([
    soft(sql`SELECT r.*, g.name AS guest_name, l.property_name FROM user_reports r LEFT JOIN guests g ON g.id = r.guest_id LEFT JOIN listings l ON l.id = r.listing_id
             WHERE (${guestId}::int IS NOT NULL AND r.guest_id = ${guestId}) OR (${listingId}::int IS NOT NULL AND r.listing_id = ${listingId}) ORDER BY r.created_at DESC LIMIT 50`),
    soft(sql`SELECT b.*, g.name AS guest_name, g.email AS guest_email, l.property_name FROM listing_guest_blocks b JOIN guests g ON g.id = b.guest_id JOIN listings l ON l.id = b.listing_id
             WHERE (${guestId}::int IS NOT NULL AND b.guest_id = ${guestId}) OR (${listingId}::int IS NOT NULL AND b.listing_id = ${listingId}) ORDER BY b.created_at DESC`),
    soft(sql`SELECT id, kind, status, reason, proposed_by_email, proposed_at, reviewed_by_email, error FROM support_actions
             WHERE (${orderId}::int IS NOT NULL AND order_id = ${orderId}) OR (${guestId}::int IS NOT NULL AND guest_id = ${guestId}) OR (${listingId}::int IS NOT NULL AND listing_id = ${listingId})
             ORDER BY proposed_at DESC LIMIT 30`)
  ]);
  return { reports, blocks, actions: actions.map(x => ({ ...x, kindLabel: KINDS[x.kind] })) };
}

// Listings this guest is kept away from (the site hides them; booking refuses).
async function blockedListingIds(sql, guestId) {
  if (!guestId) return [];
  return (await soft(sql`SELECT listing_id FROM listing_guest_blocks WHERE guest_id = ${guestId}`)).map(r => Number(r.listing_id));
}
async function isBlocked(sql, guestId, listingId) {
  if (!guestId || !listingId) return false;
  return (await soft(sql`SELECT 1 FROM listing_guest_blocks WHERE guest_id = ${guestId} AND listing_id = ${listingId}`)).length > 0;
}

module.exports = { ROLES, KINDS, roleOf, allowed, me, team, setRole, propose, withdraw, list, review, recordsFor, blockGuest, unblockGuest, blockedListingIds, isBlocked, addReport };
