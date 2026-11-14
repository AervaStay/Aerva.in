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
  block_guest_listing: 'Block the guest from this listing',
  decline: 'Turn the request down (nothing is paid or changed)'
};

// Why a request is turned down. The agent picks one and the wording is
// filled in for them, then edited to the case (owner, 12 Nov 2026: "it can
// be no changes can be done per the policy etc"). 'other' is free wording.
// What the person reads is always p.message — never the label below.
// Money actions: a second person must approve them, always. Everything
// else (reports, blocking a guest from a listing, turning a request down)
// pays nothing and changes no booking, so an ADMIN may simply do it —
// owner, 12 Nov 2026: "reviewer is required only when there is a refund or
// reducing the Aerva fees question comes. For general request, it should be
// enough." A customer representative or a reviewer still proposes it and a
// second person decides.
const MONEY_KINDS = ['cancel_refund', 'partial_refund', 'deposit_refund'];
// Still to be decided by somebody: the reviewer's queue and the super
// admin's gate both count as waiting (owner, 14 Nov 2026).
const OPEN_STATES = ['pending', 'awaiting_admin'];
// Does this need a second pair of eyes?
//
// Money always does — rule 1, and nothing below weakens it. Anything else
// does only when the person raising it is not an admin, and, since
// 14 Nov 2026, not a super admin either (owner: "Super admin self-approves
// non-money actions too"). Before that, super admin was a flag sitting on
// top of a role, and the shortcut only ever read the role: a plain admin
// could turn a request down on their own word while a super admin whose
// role was reviewer had to queue it for somebody junior to them.
const needsReview = (kind, role, isSuper) => MONEY_KINDS.includes(kind) || (!isSuper && (role || 'admin') !== 'admin');

const GROUNDS = {
  policy: 'The booking’s policy does not allow it',
  too_late: 'Asked for after the time allowed',
  host_decided: 'The host’s decision stands',
  nothing_wrong: 'Nothing was found to be wrong',
  not_aerva: 'Not something Aerva decides',
  already_settled: 'Already settled on an earlier request',
  no_evidence: 'Not enough to go on',
  other: 'Something else (written out in full)'
};

// The same grounds as a CLAUSE, to follow "turned down because …".
//
// GROUNDS above are picker labels, written to stand alone in a dropdown.
// Dropped into a sentence they came out as "turned down on the ground that
// Already settled on an earlier request" — which is what a reviewer was
// reading on the card (owner, 14 Nov 2026, screenshot of SR-36302230).
// Lower-casing the label was not enough: most of them are not clauses at
// all. So each ground is written twice, once to choose and once to read.
const GROUND_CLAUSE = {
  policy: 'the booking’s policy does not allow it',
  too_late: 'it was asked for after the time allowed',
  host_decided: 'the host’s decision stands',
  nothing_wrong: 'nothing was found to be wrong',
  not_aerva: 'it is not something Aerva decides',
  already_settled: 'it was already settled on an earlier request',
  no_evidence: 'there is not enough to go on',
  other: 'of the reason set out below'
};

// ---------------------------------------------------------------- roles

async function roleOf(sql, sessionPayload, hasValidSecret) {
  if (!sessionPayload) return hasValidSecret ? 'admin' : null;
  const r = (await soft(sql`SELECT to_jsonb(a)->>'role' AS role FROM admins a WHERE a.id = ${Number(sessionPayload.listingId) || 0}`))[0];
  const role = r && r.role;
  if (!role) return 'admin';                // before the migration: everyone is an admin
  // A role the code does not recognise used to be treated as 'admin', which
  // meant that creating a role called anything at all handed its holders
  // every power in Admin. Now the roles table decides, and a role that is
  // not in it gets nothing (owner, 14 Nov 2026).
  try {
    const roles = require('./_roles');
    if (await roles.ready(sql)) return (await roles.get(sql, role)) ? role : null;
  } catch (err) { /* fall through to the built-in three */ }
  return ROLES[role] ? role : 'admin';
}

// What each role may call on get-pending-listings.js. Admin: everything.
// Others: only these request keys (a GET's query keys, a POST's body keys).
const MODIFIERS = new Set(['q', 'status', 'subject', 'limit', 'offset', 'before', 'ref', 'mine']);
const AGENT_GET = new Set(['cancellationRequests', 'adminNotes', 'adminSummary', 'adminMe', 'supportCategories', 'supportTickets', 'supportTicket', 'supportTicketLive', 'lookup', 'lookupBooking', 'lookupGuest', 'lookupListing', 'supportActions', 'priceReviews',
  // Approvals also shows these two lists to every role (read only; the page offers the check-in actions to admins alone and the POSTs stay admin-only).
  'checkinPromise', 'groupBookings',
  // Their own AI credit, and their switch for it (owner, 14 Nov 2026). Every
  // role sees this, because every role spends it.
  'aiBudget']);
// reproposeAction: a proposal the reviewer sent back, put right and sent
// again. It is the representative's own work, so it belongs to them
// (owner, 14 Nov 2026). signoffAction is NOT here for anyone: the function
// itself allows only a super admin.
// supportHostDraft / supportHostSuggest: the AI's summary for a host and
// the reply cards for that channel. A representative is who these are FOR
// (owner, 14 Nov 2026), so they belong here — without them the feature
// answered 403 to the only people meant to use it.
// aiToggle: their own AI switch. The function behind it allows a person to
// set their own and a super admin to set anybody's, so it is safe for every
// role to reach.
const AGENT_POST = new Set(['supportReply', 'supportCase', 'supportSuggest', 'supportHostDraft', 'supportHostSuggest', 'raiseForCustomer', 'proposeAction', 'withdrawAction', 'reproposeAction', 'hostStep', 'hostReply', 'assignRequest', 'messageHost', 'adminSignOutEverywhere', 'aiToggle']);
const REVIEWER_POST = new Set([...AGENT_POST, 'reviewAction', 'decidePriceReview', 'decideCancellationRequest']);
// The roles table decides this once the migration has been run: a role is a
// list of tabs, and the requests it may make are worked out from those tabs
// (see _roles.js). The hard-coded sets above are what happens before then,
// so nothing changes on an older database.
async function allowedFor(sql, role, req) {
  if (role === 'admin') return true;
  if (!role) return false;
  try {
    const roles = require('./_roles');
    if (await roles.ready(sql)) return roles.allows(await roles.tabsFor(sql, role), req);
  } catch (err) { /* fall through to the built-in sets */ }
  return allowed(role, req);
}

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
  // The tabs come from the role, which the owner can change, so the page is
  // told them rather than keeping a copy of its own that would go stale the
  // moment a role was edited.
  let tabs = null, roleLabel = ROLES[role] || role;
  try {
    const roles = require('./_roles');
    if (await roles.ready(sql)) {
      tabs = await roles.tabsFor(sql, role);
      const rec = await roles.get(sql, role);
      if (rec) roleLabel = rec.label;
    }
  } catch (err) { /* older database: the page falls back to its own list */ }
  return { id: a ? a.id : null, email: a ? a.email : 'master secret', name: a ? a.name : null, role, roleLabel, kinds: KINDS,
           tabs, canManageTeam: await isSuper(sql, a ? a.id : null) };
}

// Who is on the team, and who has been taken off it. A removed member's row
// is kept for ever so every approval and case record still names who did it
// (owner, 12 Nov 2026).
async function team(sql) {
  const all = await sql`SELECT id, email, name, created_at, COALESCE(to_jsonb(a)->>'role', 'admin') AS role,
                               COALESCE((to_jsonb(a)->>'super_admin')::boolean, false) AS super_admin,
                               to_jsonb(a)->>'removed_at' AS removed_at
                          FROM admins a ORDER BY id`;
  return { roles: ROLES, team: all.filter(a => !a.removed_at), removed: all.filter(a => a.removed_at) };
}

// A super admin adds and removes team members and names other super admins.
// Two ways to be one, and they are the same thing to this file:
//   • admins.super_admin, set here by another super admin (2026-11-12-05);
//   • an email in SUPER_ADMIN_EMAILS, which also opens Admin → Data safety
//     and is deliberately set outside the app (_data-safety.js).
// The master secret (no admin row) counts as one: it is the owner's own way in.
const superEmails = () => String(process.env.SUPER_ADMIN_EMAILS || 'hello@aerva.in').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
async function isSuper(sql, adminId) {
  if (adminId == null) return true;
  const a = (await soft(sql`SELECT email, COALESCE((to_jsonb(a)->>'super_admin')::boolean, false) AS s, to_jsonb(a)->>'removed_at' AS removed_at
                            FROM admins a WHERE a.id = ${Number(adminId) || 0}`))[0];
  if (!a || a.removed_at) return false;
  return !!a.s || superEmails().includes(String(a.email || '').toLowerCase());
}
const superOnly = () => userError('Only a super admin can do this.', 403);

// Taking someone off the team: they are signed out at once and cannot sign
// in again. Nothing they did is removed, and they can be let back in.
async function removeMember(sql, { adminId, byId, audit }) {
  if (!(await isSuper(sql, byId))) throw superOnly();
  const t = (await sql`SELECT id, email, name, COALESCE(to_jsonb(a)->>'role', 'admin') AS role,
                              COALESCE((to_jsonb(a)->>'super_admin')::boolean, false) AS super_admin,
                              to_jsonb(a)->>'removed_at' AS removed_at
                         FROM admins a WHERE a.id = ${Number(adminId) || 0}`)[0];
  if (!t) throw userError('Team member not found.', 404);
  if (t.removed_at) throw userError('They are already off the team.', 409);
  if (byId != null && Number(t.id) === Number(byId)) throw userError('You cannot take yourself off the team. Ask another super admin.', 409);
  if (t.super_admin) {
    const supers = (await sql`SELECT count(*)::int AS n FROM admins a
                               WHERE COALESCE((to_jsonb(a)->>'super_admin')::boolean, false) = true AND to_jsonb(a)->>'removed_at' IS NULL`)[0].n;
    if (supers <= 1) throw userError('There must always be one super admin. Make someone else a super admin first.', 409);
  }
  if (t.role === 'admin') {
    const admins = (await sql`SELECT count(*)::int AS n FROM admins a
                               WHERE COALESCE(to_jsonb(a)->>'role', 'admin') = 'admin' AND to_jsonb(a)->>'removed_at' IS NULL AND a.id <> ${t.id}`)[0].n;
    if (admins < 1) throw userError('There must always be at least one admin.', 409);
  }
  try { await sql`UPDATE admins SET removed_at = now(), session_version = COALESCE(session_version, 0) + 1 WHERE id = ${t.id}`; }
  catch (err) { throw userError('Run the database update for the team first (Admin → Database updates).', 503); }
  await logAudit(sql, { action: 'admin_removed', success: true, actorType: 'admin', ...audit, targetType: 'admin', targetId: t.id,
    metadata: { email: t.email, name: t.name, role: t.role, superAdmin: t.super_admin } });
  return team(sql);
}

// Letting someone back in, with the role they had.
async function restoreMember(sql, { adminId, byId, audit }) {
  if (!(await isSuper(sql, byId))) throw superOnly();
  const t = (await sql`SELECT id, email, to_jsonb(a)->>'removed_at' AS removed_at FROM admins a WHERE a.id = ${Number(adminId) || 0}`)[0];
  if (!t) throw userError('Team member not found.', 404);
  if (!t.removed_at) throw userError('They are already on the team.', 409);
  // Back on the team, but NOT back with their old password (owner,
  // 14 Nov 2026). Someone who has been off the team may have been off it
  // for months; letting the password they last used work again means an
  // account comes back to life on a secret nobody has checked since. So
  // the password is made unusable and they are sent a fresh link to set a
  // new one, good for two hours.
  //
  // '!' is not a bcrypt hash and never compares true, so sign-in simply
  // fails. Raising session_version at the same time kills any older invite
  // or reset link they were still holding — including one sent before they
  // were taken off.
  await sql`UPDATE admins SET removed_at = NULL, password_hash = '!', session_version = COALESCE(session_version, 0) + 1 WHERE id = ${t.id}`;
  await logAudit(sql, { action: 'admin_restored', success: true, actorType: 'admin', ...audit, targetType: 'admin', targetId: t.id, metadata: { email: t.email } });
  const out = await team(sql);
  // The endpoint sends the email: it owns the token maker and the mailer.
  const row = (await soft(sql`SELECT id, email, name, COALESCE(to_jsonb(a)->>'role', 'admin') AS role,
                                     COALESCE(session_version, 0) AS session_version
                                FROM admins a WHERE a.id = ${t.id}`))[0];
  return Object.assign(out, { restored: row ? { id: row.id, email: row.email, name: row.name, role: ROLES[row.role] || row.role, sv: Number(row.session_version) || 0 } : null });
}

// Naming (or unnaming) another super admin. Only a super admin may, and the
// last one cannot be unnamed.
async function setSuper(sql, { adminId, isSuper: want, byId, audit }) {
  if (!(await isSuper(sql, byId))) throw superOnly();
  const t = (await sql`SELECT id, email, COALESCE(to_jsonb(a)->>'role', 'admin') AS role,
                              COALESCE((to_jsonb(a)->>'super_admin')::boolean, false) AS super_admin,
                              to_jsonb(a)->>'removed_at' AS removed_at
                         FROM admins a WHERE a.id = ${Number(adminId) || 0}`)[0];
  if (!t) throw userError('Team member not found.', 404);
  if (t.removed_at) throw userError('They are off the team.', 409);
  const on = want === true;
  if (on && t.role !== 'admin') throw userError('Only an admin can be a super admin. Change their role first.', 409);
  if (!on && t.super_admin) {
    const supers = (await sql`SELECT count(*)::int AS n FROM admins a
                               WHERE COALESCE((to_jsonb(a)->>'super_admin')::boolean, false) = true AND to_jsonb(a)->>'removed_at' IS NULL`)[0].n;
    if (supers <= 1) throw userError('There must always be one super admin.', 409);
  }
  try { await sql`UPDATE admins SET super_admin = ${on} WHERE id = ${t.id}`; }
  catch (err) { throw userError('Run the database update for the team first (Admin → Database updates).', 503); }
  await logAudit(sql, { action: on ? 'admin_made_super' : 'admin_unmade_super', success: true, actorType: 'admin', ...audit, targetType: 'admin', targetId: t.id, metadata: { email: t.email } });
  return team(sql);
}
async function setRole(sql, { adminId, role, byId, audit }) {
  // Putting somebody ON a role is a super admin's alone (owner, 14 Nov
  // 2026: "super admin can assign roles only. Not other kind can"). Before
  // this, anybody holding the Admin role could move people between roles,
  // which is the same power as granting permissions.
  if (!(await isSuper(sql, byId))) throw userError('Only a super admin can put somebody on a role.', 403);
  // The role has to exist. This used to check the three names written into
  // the code, which meant a role the owner created could never be given to
  // anybody — the Roles screen would make it and Team could not use it.
  let known = !!ROLES[role];
  try {
    const roles = require('./_roles');
    if (await roles.ready(sql)) known = !!(await roles.get(sql, role));
  } catch (err) { /* older database: the three built-in names */ }
  if (!known) throw userError('Choose a role.');
  const target = (await sql`SELECT id, email, COALESCE(to_jsonb(a)->>'role', 'admin') AS role FROM admins a WHERE id = ${Number(adminId) || 0}`)[0];
  if (!target) throw userError('Team member not found.', 404);
  if (target.role === 'admin' && role !== 'admin') {
    const admins = (await sql`SELECT count(*)::int AS n FROM admins a
                               WHERE COALESCE(to_jsonb(a)->>'role', 'admin') = 'admin' AND to_jsonb(a)->>'removed_at' IS NULL`)[0].n;
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
        // Plain sentences, no markdown, no questions back. It used to
        // return "**Summary**" with the asterisks showing, write in Aerva's
        // own jargon, and end by asking the reviewer which booking was
        // meant — because it had been handed an internal row number as if
        // it were a booking reference (owner, 14 Nov 2026).
        // Short (owner, 14 Nov 2026: "Shorten the AI conversation
        // summary"). A reviewer is deciding, not reading a report, and the
        // whole conversation is one click away underneath — so this says
        // only what they need to hold in their head while they decide.
        system: 'You summarise an Aerva customer-support conversation for a reviewer who must approve or reject an action. The reviewer can open the whole conversation themselves, so be SHORT: at most 3 sentences and at most 45 words in total. Say only what the customer reported, what was established, and what they are asking for. Leave out dates, amounts, names and detail they can read for themselves unless the decision turns on them. PLAIN TEXT ONLY: no markdown, no asterisks, no headings, no bullet points, no labels like "Summary:". Never ask the reviewer a question and never ask for clarification — if something is unclear, say what is known and stop. Do not recommend a decision. Refer to a booking only by its confirmation code or the property name, never by a number you were not given.',
        messages: [{ role: 'user', content: `Proposed action: ${KINDS[kind]}.\nAgent's reason: ${reason}\n\nConversation:\n${timeline.slice(0, 24000)}` }] }) });
    clearTimeout(timer);
    const d = await r.json().catch(() => ({}));
    let text = (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    // Belt and braces: strip any markdown that comes back anyway, and drop
    // a closing sentence that asks the reviewer something.
    text = text.replace(/\*\*/g, '').replace(/^#+\s*/gm, '').replace(/^[-•]\s*/gm, '')
               .replace(/\s*(Clarification needed|Please clarify|Which booking|It is unclear which)[^.]*\.\s*$/i, '').trim();
    return r.ok && text ? text : fallback;
  } catch (e) { return fallback; }
}

// ---------------------------------------------------------------- proposing

async function checkAndPreview(sql, kind, p) {
  const order = p.orderId ? (await sql`SELECT o.*, l.host_id, l.property_name FROM orders o LEFT JOIN listings l ON l.id = o.listing_id WHERE o.id = ${Number(p.orderId)}`)[0] : null;
  if (['cancel_refund', 'partial_refund', 'deposit_refund'].includes(kind) && !order) throw userError('Choose the booking.');
  // No second refund on a booking that has already had one (owner,
  // 14 Nov 2026) — refused here, at the point of proposing, so a
  // representative is told before they have promised a guest anything.
  // A deposit is a separate pot of money, so it is not caught by this.
  if (['cancel_refund', 'partial_refund'].includes(kind) && order) {
    const stop = await require('./_refunds').refuseSecondRefund(sql, order.id, { ticketId: p.ticketId || null, by: p.byEmail || null });
    if (stop) throw stop;
  }
  if (kind === 'cancel_refund') {
    const pct = Number(p.refundPercent);
    if (!(pct >= 0 && pct <= 100)) throw userError('Refund must be 0 to 100%.');
    if (order.status !== 'paid') throw userError('Only a confirmed booking can be cancelled.');
    // Refunding Aerva's service fee is an exception: a reason is required,
    // and only an admin can approve it (review below).
    const feeReason = String(p.feeReason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (p.refundFee && feeReason.length < 10) throw userError('Explain why Aerva’s service fee should be refunded (at least a sentence). Only an admin can approve it.');
    const pv = await executePolicyCancellation(sql, null, { orderId: order.id, pct, by: 'admin', note: '', refundFee: !!p.refundFee, preview: true });
    return { order, params: { orderId: order.id, refundPercent: pct, refundFee: !!p.refundFee, feeReason: p.refundFee ? feeReason : undefined, countAgainstHost: !!p.countAgainstHost },
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
  // Turning a request down. Nothing is paid and nothing on the booking
  // changes; the person is told why, and the request is marked resolved.
  // It still goes to a reviewer, so a refusal is on the record like any
  // other decision (owner, 12 Nov 2026).
  if (kind === 'decline') {
    const tell = String(p.message || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    if (tell.length < 20) throw userError('Write what the person will be told, in a sentence or two — they see this word for word.');
    // A refusal is recorded as fully as a refund: the case record needs how
    // the person behaved, so it is chosen here rather than guessed later.
    const CONDUCT = ['cooperative', 'neutral', 'difficult', 'abusive', 'not_involved'];
    const conduct = String(p.conduct || '').trim();
    if (!CONDUCT.includes(conduct)) throw userError('Choose how the person behaved — it goes on the case record.');
    // The OTHER party's conduct too, whenever there is one. Resolving a
    // request demands both (see adminReply in _support.js), so collecting
    // only the first meant a decline was approved and then failed to carry
    // out with "record how the other party behaved" — found while building
    // the host step, 14 Nov 2026.
    const otherConduct = String(p.otherConduct || '').trim();
    if (order && !CONDUCT.includes(otherConduct)) throw userError('Choose how the other party behaved too — the case record needs both before a request can be closed.');
    const ground = String(p.ground || '').trim();
    if (!GROUNDS[ground]) throw userError('Choose the ground for turning it down — it goes on the case record.');
    return { order, params: { orderId: order ? order.id : null, message: tell, conduct, otherConduct: otherConduct || undefined, ground },
             preview: { message: tell, conduct, otherConduct: otherConduct || undefined, ground, groundLabel: GROUNDS[ground] } };
  }
  throw userError('Unknown action.');
}

async function propose(sql, { kind, params = {}, reason, ticketId = null, admin, audit }) {
  // RULE 3 (owner, 14 Nov 2026): "Reviewer cant directly pitch in without
  // going through CR review." A reviewer decides what a representative puts
  // forward; raising it themselves would leave nothing for anyone to
  // review, and the second pair of eyes is the whole point of the step.
  {
    const r = require('./_money-gate').canPropose({ role: admin && admin.role, isSuper: !!(admin && admin.isSuper) });
    if (!r.ok) throw userError(r.why, 403);
  }
  if (!KINDS[kind]) throw userError('Choose what should be done.');
  const why = String(reason || '').trim().slice(0, 1500);
  if (why.length < 10) throw userError('Explain why, in a sentence or two — the reviewer decides on it.');
  const tid = Number(ticketId) || null;
  if (tid && !(await sql`SELECT 1 FROM support_tickets WHERE id = ${tid}`).length) throw userError('Support request not found.', 404);
  // THE HOST STEP COMES FIRST (owner, 14 Nov 2026). On a request about a
  // booking, nothing can be proposed until the representative has said
  // whether the host is needed — and, if they are, asked them. A reviewer
  // should never have to guess whether the other side was heard.
  if (tid) {
    try {
      const S = require('./_support');
      const step = await S.hostStep(sql, tid);
      if (step && step.hasBooking && !step.answered) {
        throw userError('Answer “do we need the host on this?” first — it is the first step on the case, and the reviewer sees the answer.', 409);
      }
      if (step && step.needed === true && !step.reply && !step.noAnswer) {
        throw userError('The host has been asked but has not answered yet. Record what they said, or mark that they did not answer, before proposing anything.', 409);
      }
    } catch (err) { if (err.isUserFacing) throw err; /* before the database update: carry on */ }
  }
  const c = await checkAndPreview(sql, kind, Object.assign({}, params, { ticketId: tid, byEmail: admin.email }));
  // One live proposal of a kind per booking. 'awaiting_admin' and 'returned'
  // are live too: the first is approved and waiting to be paid, the second
  // is being reworked by the representative on that same row. Leaving them
  // out let a second proposal be raised on a booking that already had one
  // in flight, and both could reach a super admin — who would then be asked
  // to pay the same thing twice.
  const dup = c.params.orderId ? (await sql`SELECT id, status FROM support_actions
                                            WHERE kind = ${kind} AND order_id = ${c.params.orderId}
                                              AND status IN ('pending', 'approving', 'awaiting_admin', 'returned')`)[0] : null;
  if (dup) {
    throw userError(dup.status === 'awaiting_admin'
      ? `This is already approved and waiting for a super admin (#${dup.id}). Nothing more can be raised on this booking until they decide.`
      : dup.status === 'returned'
      ? `This was sent back to be done again (#${dup.id}). Change that one and send it again rather than raising another.`
      : `This is already waiting for approval (#${dup.id}).`, 409);
  }
  const summary = await summarise(sql, { ticketId: tid, orderId: c.params.orderId, reason: why, kind });
  const row = (await sql`INSERT INTO support_actions (kind, ticket_id, order_id, guest_id, listing_id, params, reason, summary, preview, proposed_by, proposed_by_email)
    VALUES (${kind}, ${tid}, ${c.params.orderId || null}, ${c.params.guestId || (c.order ? c.order.guest_id : null) || null}, ${c.params.listingId || (c.order ? c.order.listing_id : null) || null},
            ${JSON.stringify(c.params)}::jsonb, ${why}, ${summary}, ${JSON.stringify(c.preview)}::jsonb, ${admin.id}, ${admin.email}) RETURNING *`)[0];
  if (tid) await sql`INSERT INTO support_messages (ticket_id, sender, internal, admin_email, body) VALUES (${tid}, 'support', true, ${admin.email},
                      ${`Proposed for approval (#${row.id}): ${KINDS[kind]}. ${describe(kind, c.params, c.preview)} Reason: ${why}`})`;
  await logAudit(sql, { action: 'support_action_proposed', success: true, actorType: 'admin', ...audit, targetType: 'support_action', targetId: row.id,
    metadata: { kind, orderId: row.order_id, ticketId: tid, params: c.params } });
  // An admin doing something that pays nothing: done as they send it, with
  // the same record as an approved one (who, why, what, on the request).
  if (!needsReview(kind, admin.role, admin.isSuper)) {
    const done = await review(sql, admin.razorpay || null, { id: row.id, approve: true, note: 'Done by the admin who proposed it (no money involved, so no second approval is needed).',
      admin: Object.assign({}, admin, { selfApproveAllowed: true }), audit });
    const after = (await sql`SELECT * FROM support_actions WHERE id = ${row.id}`)[0];
    return Object.assign({}, after || row, { applied: true, outcome: done });
  }
  await notifyReviewers(sql, row);
  return row;
}
function describe(kind, p, pv = {}) {
  if (kind === 'cancel_refund') return `${p.refundPercent}% of the booking price${p.refundFee ? ' plus Aerva’s service fee (exception — admin approval only; why: ' + (p.feeReason || '') + ')' : ''} — guest gets ${inr(pv.refundCash)}${pv.couponBack ? ' + ' + inr(pv.couponBack) + ' coupon' : ''}, host ${inr(pv.hostPayout)}.`;
  if (kind === 'partial_refund') return `${inr(p.amount)} back to the guest, paid by ${p.hostPays ? 'the host' : 'Aerva'}; the booking stays.`;
  if (kind === 'deposit_refund') return `${inr(pv.toGuest)} of the ${inr(pv.deposit)} deposit back to the guest${pv.toHost ? `, ${inr(pv.toHost)} to the host` : ''}.`;
  if (kind === 'block_guest_listing') return `${pv.person || 'The guest'} would no longer see or book ${pv.listing || 'the listing'}.`;
  // Written as what WOULD happen. It used to read "Turned down — …" on a
  // proposal nobody had approved yet, so a card marked WAITING described
  // itself in the past tense (owner, 14 Nov 2026).
  if (kind === 'decline') return `The request is turned down because ${GROUND_CLAUSE[pv.ground || p.ground] || 'of a ground on the record'}. No money is paid and nothing on the booking changes. The person is sent these words: “${(pv.message || p.message || '').slice(0, 300)}”`;
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

// The host step, for the approvals card: a reviewer and a super admin both
// need to see whether the other side was heard before money was promised
// (owner, 14 Nov 2026).
async function hostStepFor(sql, ticketIds) {
  const ids = [...new Set((ticketIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return new Map();
  try {
    const rows = await sql`SELECT id, to_jsonb(s)->>'host_needed' AS needed, to_jsonb(s)->>'host_no_reason' AS no_reason,
                                  to_jsonb(s)->>'host_ask' AS ask, to_jsonb(s)->>'host_reply' AS reply,
                                  to_jsonb(s)->>'host_no_answer' AS no_answer
                             FROM support_tickets s WHERE s.id = ANY(${ids})`;
    return new Map(rows.map(r => [Number(r.id), {
      needed: r.needed == null ? null : r.needed === 'true',
      whyNot: r.no_reason || null, ask: r.ask || null, reply: r.reply || null, noAnswer: r.no_answer === 'true',
      line: r.needed == null ? 'Not decided'
        : r.needed !== 'true' ? `Host not needed — ${r.no_reason || 'no reason given'}`
        : r.reply ? `Host asked: “${String(r.ask || '').slice(0, 120)}” — they said: “${String(r.reply).slice(0, 200)}”`
        : r.no_answer === 'true' ? `Host asked: “${String(r.ask || '').slice(0, 120)}” — they did not answer`
        : `Host asked: “${String(r.ask || '').slice(0, 120)}” — waiting for their answer`
    }]));
  } catch (err) { return new Map(); }
}

async function list(sql, { status = 'pending' } = {}) {
  // "Waiting" means waiting on somebody: a reviewer, or a super admin at
  // the money gate (owner, 14 Nov 2026). Sent-back ones are the
  // representative's to move, so they are listed with the open set too.
  const want = status === 'all' ? null : status === 'done' ? ['done', 'failed', 'rejected', 'withdrawn'] : ['pending', 'approving', 'awaiting_admin', 'returned'];
  const rows = await sql`
    SELECT a.*, t.ref AS ticket_ref, o.suite_name, o.arrival, o.departure, o.status AS booking_status, o.total, to_jsonb(o)->>'confirmation_code' AS code,
           g.name AS guest_name, g.email AS guest_email, l.property_name
    FROM support_actions a
    LEFT JOIN support_tickets t ON t.id = a.ticket_id LEFT JOIN orders o ON o.id = a.order_id
    LEFT JOIN guests g ON g.id = a.guest_id LEFT JOIN listings l ON l.id = a.listing_id
    WHERE (${want}::text[] IS NULL OR a.status = ANY(${want}::text[]))
    ORDER BY (a.status IN ('pending', 'approving', 'awaiting_admin')) DESC, a.proposed_at DESC LIMIT 200`;
  const counts = await sql`SELECT status, count(*)::int AS n FROM support_actions GROUP BY status`;
  const hosts = await hostStepFor(sql, rows.map(r => r.ticket_id));
  return { kinds: KINDS, actions: rows.map(r => ({ ...r, kindLabel: KINDS[r.kind], description: describe(r.kind, r.params || {}, r.preview || {}),
             hostStep: hosts.get(Number(r.ticket_id)) || null })), counts: Object.fromEntries(counts.map(c => [c.status, c.n])) };
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

// Who a proposal BELONGS to, as opposed to who last decided it.
//
// Owner, 14 Nov 2026: "Reveiwers cant take action on other reviewer
// request." reviewed_by and returned_by both move as a proposal goes round —
// a repropose clears returned_by, and a super admin's gate run leaves
// reviewed_by in place on purpose — so neither survives a round trip. A
// reviewer could send one back, the representative could raise it again, and
// a DIFFERENT reviewer could then decide it. reviewer_owner is claimed by
// the first reviewer to touch it and is never moved; _ownership.js reads it.
//
// Best-effort on purpose: the column arrives with
// 2026-11-14-08-action-reviewer-owner.sql, and until that is run a failed
// claim must not fail the review it belongs to. Reviews then work exactly as
// they did yesterday, and the rule switches itself on with the migration.
async function claimReviewer(sql, id, admin) {
  if (!admin || !admin.id || admin.gatePassed) return;
  await sql`UPDATE support_actions SET reviewer_owner = COALESCE(reviewer_owner, ${admin.id}),
              reviewer_owner_email = COALESCE(reviewer_owner_email, ${admin.email})
            WHERE id = ${id}`.catch(() => {});
}

// The reviewer's three ways out (owner, 14 Nov 2026):
//   approve  — as proposed, or CHANGED first. A reviewer may change the
//              action and approve it in one go: the owner chose that over
//              sending a changed action back for a second approval, knowing
//              it lets a reviewer decide a refund alone. What they changed
//              is recorded beside what was proposed and stays on the case
//              for ever — that record is the check that is left.
//   return   — sent back to the representative to do again. Not a
//              rejection: nothing is decided, and they may change it and
//              propose it afresh.
//   reject   — the answer is no, with a note the representative reads.
async function review(sql, razorpay, { id, approve, action, note, changes, admin, audit }) {
  let a = (await sql`SELECT * FROM support_actions WHERE id = ${Number(id) || 0}`)[0];
  if (!a) throw userError('Proposal not found.', 404);
  const what = ['approve', 'reject', 'return'].includes(String(action || '')) ? String(action) : (approve ? 'approve' : 'reject');
  if (what === 'return') {
    const why = String(note || '').trim().slice(0, 1000);
    if (why.length < 5) throw userError('Say what should be done differently — the representative sees it.');
    const r = await sql`UPDATE support_actions SET status = 'returned', returned_by = ${admin.id}, returned_by_email = ${admin.email},
                          returned_at = now(), review_note = ${why}
                        WHERE id = ${a.id} AND status = 'pending' RETURNING id`;
    if (!r.length) throw userError('This proposal has already been decided.', 409);
    await claimReviewer(sql, a.id, admin);
    await logAudit(sql, { action: 'support_action_returned', success: true, actorType: 'admin', ...audit, targetType: 'support_action', targetId: a.id,
      metadata: { kind: a.kind, note: why, proposedBy: a.proposed_by_email } });
    return { status: 'returned' };
  }
  approve = what === 'approve';
  // An admin's own non-money action is carried out as they send it (below,
  // in propose): that is the one case where the proposer is the approver.
  if (Number(a.proposed_by) === Number(admin.id) && !admin.selfApproveAllowed) {
    throw userError('Someone else has to approve your own proposal.', 403);
  }
  const why = String(note || '').trim().slice(0, 1000);
  if (!approve) {
    if (why.length < 5) throw userError('Say why it is rejected — the representative sees it.');
    const r = await sql`UPDATE support_actions SET status = 'rejected', reviewed_by = ${admin.id}, reviewed_by_email = ${admin.email}, reviewed_at = now(), review_note = ${why}
                        WHERE id = ${a.id} AND status = 'pending' RETURNING id`;
    if (!r.length) throw userError('This proposal has already been decided.', 409);
    await claimReviewer(sql, a.id, admin);
    if (a.ticket_id) await sql`INSERT INTO support_messages (ticket_id, sender, internal, admin_email, body) VALUES (${a.ticket_id}, 'support', true, ${admin.email}, ${`Proposal #${a.id} rejected: ${why}`})`;
    await logAudit(sql, { action: 'support_action_rejected', success: true, actorType: 'admin', ...audit, targetType: 'support_action', targetId: a.id, metadata: { kind: a.kind, note: why } });
    return { status: 'rejected' };
  }
  // The reviewer changed it before approving. The representative's version
  // is kept in original_kind/original_params and shown beside it on the
  // case for ever, so what each person decided is never in doubt. The new
  // version goes through checkAndPreview like any proposal, so every rule
  // that applies to proposing applies to changing.
  if (changes && (changes.kind || changes.params)) {
    const newKind = changes.kind ? String(changes.kind) : a.kind;
    if (!KINDS[newKind]) throw userError('Choose what should be done instead.');
    const changeNote = String(changes.note || note || '').trim().slice(0, 1000);
    if (changeNote.length < 5) throw userError('Say what you changed and why — the representative and the record both see it.');
    const c = await checkAndPreview(sql, newKind, Object.assign({}, a.params || {}, changes.params || {}, { ticketId: a.ticket_id || null, byEmail: admin.email }));
    const upd = await sql`UPDATE support_actions
        SET original_kind = COALESCE(original_kind, ${a.kind}),
            original_params = COALESCE(original_params, ${JSON.stringify(a.params || {})}::jsonb),
            kind = ${newKind}, params = ${JSON.stringify(c.params)}::jsonb, preview = ${JSON.stringify(c.preview)}::jsonb,
            changed_by = ${admin.id}, changed_by_email = ${admin.email}, changed_at = now(), change_note = ${changeNote}
        WHERE id = ${a.id} AND status = 'pending' RETURNING *`;
    if (!upd.length) throw userError('This proposal has already been decided.', 409);
    a = upd[0];
    await logAudit(sql, { action: 'support_action_changed', success: true, actorType: 'admin', ...audit, targetType: 'support_action', targetId: a.id,
      metadata: { from: { kind: a.original_kind, params: a.original_params }, to: { kind: newKind, params: c.params }, note: changeNote, proposedBy: a.proposed_by_email } });
  }
  // Refunding Aerva's service fee: an admin only, case by case. Checked
  // after any change, so a reviewer cannot add it on the way through.
  if (a.kind === 'cancel_refund' && a.params && a.params.refundFee && (admin.role || 'admin') !== 'admin') {
    throw userError('This refunds Aerva’s service fee — only an admin can approve it.', 403);
  }
  // THE GATE (owner, 14 Nov 2026). A reviewer's approval no longer pays.
  // Anything that moves money stops here and waits for a super admin, who
  // sees what the customer asked for, what the representative proposed,
  // what the host said, and what the reviewer made of it — and only then
  // is money sent. Two people have to agree before a rupee leaves Aerva.
  // Everything that is NOT money still finishes on the reviewer's word: a
  // support team that queues for a signature to say "no" stops saying
  // anything.
  // gatePassed: the super admin has already decided to pay it, and is
  // running it through this very path so there is one execution route and
  // not two.
  if (MONEY_KINDS.includes(a.kind) && !admin.gatePassed) {
    const held = await sql`UPDATE support_actions SET status = 'awaiting_admin', reviewed_by = ${admin.id}, reviewed_by_email = ${admin.email},
                             reviewed_at = now(), review_note = ${why || null}
                           WHERE id = ${a.id} AND status = 'pending' RETURNING id`;
    if (!held.length) throw userError('This proposal has already been decided.', 409);
    await claimReviewer(sql, a.id, admin);
    if (a.ticket_id) await sql`INSERT INTO support_messages (ticket_id, sender, internal, admin_email, body)
                               VALUES (${a.ticket_id}, 'support', true, ${admin.email},
                                       ${`Proposal #${a.id} approved by the reviewer and sent to a super admin. Nothing is paid until they decide.`})`;
    await logAudit(sql, { action: 'support_action_awaiting_admin', success: true, actorType: 'admin', ...audit, targetType: 'support_action', targetId: a.id,
      metadata: { kind: a.kind, proposedBy: a.proposed_by_email, changed: !!a.changed_at } });
    return { status: 'awaiting_admin' };
  }
  // Only one approval runs: pending → approving in one statement.
  //
  // When a super admin is paying something through the gate, the reviewer
  // already decided it and their name and words are on the row. Writing the
  // super admin's name over them would leave nobody able to tell who
  // reviewed it — the opposite of what the gate is for (owner, 14 Nov 2026:
  // a super admin should see "what reviewer has done and what CR has
  // done"). So the gate's run claims the row without touching the review
  // trail; who paid it is recorded as the sign-off, which is a separate
  // thing from who reviewed it.
  const claim = admin.gatePassed
    ? await sql`UPDATE support_actions SET status = 'approving'
                WHERE id = ${a.id} AND status = 'pending' RETURNING id`
    : await sql`UPDATE support_actions SET status = 'approving', reviewed_by = ${admin.id}, reviewed_by_email = ${admin.email}, reviewed_at = now(), review_note = ${why || null}
                WHERE id = ${a.id} AND status = 'pending' RETURNING id`;
  if (!claim.length) throw userError('This proposal has already been decided.', 409);
  await claimReviewer(sql, a.id, admin);
  const p = a.params || {};
  const label = `${admin.email} (approved #${a.id}, proposed by ${a.proposed_by_email})`;
  let result;
  try {
    if (a.kind === 'cancel_refund') {
      result = await executePolicyCancellation(sql, razorpay, { orderId: p.orderId, pct: p.refundPercent, by: 'admin', note: a.reason.slice(0, 300), refundFee: !!p.refundFee, feeReason: p.feeReason || a.reason, countAgainstHost: !!p.countAgainstHost, adminLabel: label });
    } else if (a.kind === 'partial_refund') {
      result = await lookup.partialRefund(sql, razorpay, { orderId: p.orderId, amount: p.amount, reason: a.reason.slice(0, 400), hostPays: !!p.hostPays, adminLabel: label });
    } else if (a.kind === 'deposit_refund') {
      result = await refundDeposit(sql, razorpay, { orderId: p.orderId, amount: p.amount, adminLabel: label });
    } else if (a.kind === 'report_guest' || a.kind === 'report_host') {
      result = await addReport(sql, { kind: a.kind === 'report_guest' ? 'guest' : 'host', guestId: p.guestId, listingId: p.listingId, orderId: p.orderId, ticketId: a.ticket_id, actionId: a.id, reason: a.reason, by: label });
    } else if (a.kind === 'block_guest_listing') {
      result = await blockGuest(sql, { listingId: p.listingId, guestId: p.guestId, reason: a.reason, by: label });
    } else if (a.kind === 'decline') {
      if (!a.ticket_id) throw userError('A request can only be turned down from the request itself.');
      const S = require('./_support');
      // The refusal is the case record: what was asked, what was decided,
      // and the words the person was given. Without it the request cannot
      // be resolved, and a refusal must be as well documented as a refund.
      await S.adminSaveCase(sql, { id: a.ticket_id, summary: a.reason,
        outcome: `Turned down (${GROUNDS[p.ground] || 'ground not recorded'}) — nothing paid, nothing changed. Approved by ${admin.email} (proposal #${a.id}, proposed by ${a.proposed_by_email}). The person was told: ${p.message}`,
        requesterConduct: p.conduct || 'neutral', otherConduct: p.otherConduct || undefined,
        adminEmail: label, audit: { actorIdentifier: admin.email } });
      await S.adminReply(sql, { id: a.ticket_id, text: p.message, status: 'resolved', adminEmail: label,
        audit: { actorIdentifier: admin.email } });
      result = { declined: true, ticketId: a.ticket_id };
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

// Every proposal on a request, with its whole trail, for the case
// timeline (owner, 14 Nov 2026: "what actually was the next action done —
// not clear"). The timeline used to reconstruct this from three separate
// internal notes written at three different times, so a proposal that was
// later approved still read as waiting, and a proposal to decline read in
// the past tense before anyone had decided. Now the row itself says.
const STATE = {
  pending: 'Waiting for a reviewer', approving: 'Being carried out', done: 'Approved and done',
  failed: 'Approved, but it did not go through', rejected: 'Rejected', withdrawn: 'Withdrawn',
  returned: 'Sent back to the representative',
  awaiting_admin: 'Approved by the reviewer — waiting for a super admin, nothing paid yet'
};
async function forTicket(sql, ticketId) {
  const tid = Number(ticketId) || 0;
  if (!tid) return [];
  const rows = await soft(sql`SELECT * FROM support_actions WHERE ticket_id = ${tid} ORDER BY proposed_at, id`);
  return rows.map(a => {
    const p = a.params || {}, pv = a.preview || {};
    const changed = !!a.changed_at;
    return {
      id: a.id, kind: a.kind, kindLabel: KINDS[a.kind] || a.kind,
      status: a.status, stateLabel: STATE[a.status] || a.status,
      // Present tense while it is still only a proposal, past tense once it
      // has been carried out. "Turned down — …" on something nobody has
      // approved yet was the worst of the old wording.
      what: (a.status === 'done' ? '' : 'Would be: ') + describe(a.kind, p, pv),
      reason: a.reason, proposedBy: a.proposed_by_email, proposedAt: a.proposed_at,
      changed, changedBy: a.changed_by_email || null, changedAt: a.changed_at || null, changeNote: a.change_note || null,
      // What the representative actually asked for, when a reviewer changed it.
      originally: changed && a.original_kind ? { kindLabel: KINDS[a.original_kind] || a.original_kind, what: describe(a.original_kind, a.original_params || {}, {}) } : null,
      decidedBy: a.reviewed_by_email || a.returned_by_email || null,
      decidedAt: a.reviewed_at || a.returned_at || null,
      note: a.review_note || null, error: a.error || null,
      signoff: a.signoff || null, signoffLabel: a.signoff ? SIGNOFFS[a.signoff] : null,
      signoffBy: a.signoff_by_email || null, signoffAt: a.signoff_at || null, signoffNote: a.signoff_note || null
    };
  });
}

// A super admin signs off on what the representative and the reviewer did
// (owner, 14 Nov 2026). They keep every other power they have — this is
// oversight on top, not instead.
//   good     — satisfied. The case is closed to review.
//   rejected — the decision was wrong, on the record, for whoever made it.
//   reverted — put it right: the action goes back to be done again.
//
// MONEY IS NEVER PULLED BACK BY THIS. A refund that has reached a card is
// gone; Aerva will not charge a guest again because a decision is being
// revisited. So a sign-off records the judgement and, where money has
// already moved, says plainly what has to be put right by hand. Nothing
// here touches Razorpay.
const SIGNOFFS = { pay: 'Paid', good: 'Good to proceed', rejected: 'Rejected', reverted: 'Reverted', revert_cr: 'Sent back to the representative' };
async function signoff(sql, razorpay, { id, decision, note, admin, audit }) {
  if (!admin || !admin.superAdmin) throw userError('Only a super admin can sign a decision off.', 403);
  if (!SIGNOFFS[decision]) throw userError('Choose Pay it, Good to proceed, Reject or Revert.');
  const why = String(note || '').trim().slice(0, 1000);
  // Agreeing needs no explanation; disagreeing does. Checked after the row
  // is read, so "this was already decided" is what you are told when that
  // is the real problem, rather than being asked for a note first.
  const mustSayWhy = !['good', 'pay'].includes(decision);
  const a = (await sql`SELECT * FROM support_actions WHERE id = ${Number(id) || 0}`)[0];
  if (!a) throw userError('Proposal not found.', 404);
  if (a.signoff && a.status !== 'awaiting_admin') throw userError(`This was already decided — ${SIGNOFFS[a.signoff]}.`, 409);
  if (mustSayWhy && why.length < 5) throw userError('Say why — the representative and the reviewer both see it.');
  // ---- the gate: money the reviewer approved, waiting to be paid ----
  if (a.status === 'awaiting_admin') {
    if (decision === 'pay') {
      // Back to pending, then through the one execution path there is, so
      // every money rule that applies to an approval still applies here.
      const ready = await sql`UPDATE support_actions SET status = 'pending' WHERE id = ${a.id} AND status = 'awaiting_admin' RETURNING id`;
      if (!ready.length) throw userError('This has already been decided.', 409);
      try {
        const out = await review(sql, razorpay, { id: a.id, approve: true, note: why || a.review_note || 'Paid by a super admin.',
          admin: Object.assign({}, admin, { gatePassed: true, selfApproveAllowed: true }), audit });
        await sql`UPDATE support_actions SET signoff = 'pay', signoff_by = ${admin.id}, signoff_by_email = ${admin.email},
                    signoff_at = now(), signoff_note = ${why || null} WHERE id = ${a.id}`;
        return Object.assign({ signoff: 'pay' }, out);
      } catch (err) {
        // Put it back in the queue rather than losing it.
        await sql`UPDATE support_actions SET status = 'awaiting_admin' WHERE id = ${a.id} AND status = 'pending'`.catch(() => {});
        throw err;
      }
    }
    const back = decision === 'reverted' ? 'pending' : decision === 'revert_cr' ? 'returned' : decision === 'rejected' ? 'rejected' : null;
    if (!back) throw userError('Choose Pay it, Reject, or send it back.');
    await sql`UPDATE support_actions SET status = ${back}, signoff = ${decision}, signoff_by = ${admin.id}, signoff_by_email = ${admin.email},
                signoff_at = now(), signoff_note = ${why || null},
                returned_by = ${back === 'returned' ? admin.id : null}, returned_by_email = ${back === 'returned' ? admin.email : null},
                returned_at = ${back === 'returned' ? new Date().toISOString() : null}
              WHERE id = ${a.id} AND status = 'awaiting_admin'`;
    if (a.ticket_id) await sql`INSERT INTO support_messages (ticket_id, sender, internal, admin_email, body)
                               VALUES (${a.ticket_id}, 'support', true, ${admin.email},
                                       ${`Proposal #${a.id} — a super admin decided: ${SIGNOFFS[decision]}. Nothing was paid.${why ? ' ' + why : ''}`})`;
    await logAudit(sql, { action: 'support_action_gate_' + decision, success: true, actorType: 'admin', ...audit, targetType: 'support_action', targetId: a.id,
      metadata: { kind: a.kind, note: why, proposedBy: a.proposed_by_email, reviewedBy: a.reviewed_by_email } });
    return { status: back, signoff: decision, paid: false };
  }
  if (!['done', 'failed', 'rejected', 'returned', 'withdrawn'].includes(a.status))
    throw userError('Wait until the reviewer has decided — there is nothing to sign off yet.', 409);
  await sql`UPDATE support_actions SET signoff = ${decision}, signoff_by = ${admin.id}, signoff_by_email = ${admin.email},
              signoff_at = now(), signoff_note = ${why || null} WHERE id = ${a.id}`;
  // What a revert can and cannot undo, said plainly rather than implied.
  const moved = a.status === 'done' && MONEY_KINDS.includes(a.kind);
  const toPutRight = decision === 'reverted' && moved
    ? 'Money has already left Aerva on this one, and Aerva does not take a refund back off a guest. Put it right by hand: the booking and the payout are in Lookup.'
    : null;
  if (a.ticket_id) {
    await sql`INSERT INTO support_messages (ticket_id, sender, internal, admin_email, body)
              VALUES (${a.ticket_id}, 'support', true, ${admin.email},
                      ${`Signed off by a super admin — ${SIGNOFFS[decision]} (proposal #${a.id}).${why ? ' ' + why : ''}${toPutRight ? ' ' + toPutRight : ''}`})`;
  }
  await logAudit(sql, { action: 'support_action_signed_off', success: true, actorType: 'admin', ...audit, targetType: 'support_action', targetId: a.id,
    metadata: { decision, note: why, kind: a.kind, status: a.status, proposedBy: a.proposed_by_email, reviewedBy: a.reviewed_by_email, changedBy: a.changed_by_email || null } });
  return { status: a.status, signoff: decision, toPutRight };
}

// A proposal the reviewer sent back. The representative changes it and
// sends it again: same row, so the case keeps one thread per decision
// rather than sprouting a new number every time it goes round.
async function repropose(sql, { id, kind, params = {}, reason, admin, audit }) {
  const a = (await sql`SELECT * FROM support_actions WHERE id = ${Number(id) || 0}`)[0];
  if (!a) throw userError('Proposal not found.', 404);
  // RULE 2 (owner, 14 Nov 2026): "CR can't overturn reviewer action but
  // reviewer can overturn." A proposal the reviewer SENT BACK is meant to
  // be done again — that is the reviewer asking for it. Anything else they
  // decided is theirs, and a representative does not get to reopen it.
  if (a.status !== 'returned') {
    const over = require('./_money-gate').canOverturn(a, { role: admin && admin.role, isSuper: !!(admin && admin.isSuper) });
    throw userError(over.ok ? 'Only a proposal that was sent back can be sent again.' : over.why, 409);
  }
  const newKind = kind ? String(kind) : a.kind;
  if (!KINDS[newKind]) throw userError('Choose what should be done.');
  const why = String(reason || a.reason || '').trim().slice(0, 1500);
  if (why.length < 10) throw userError('Explain why, in a sentence or two — the reviewer decides on it.');
  // ticketId and byEmail matter: a second-refund attempt refuses itself
  // inside here, and the refusal has to land on the case for a super admin
  // to see and name who tried it. Without them the attempt was refused
  // silently and the audit line said "unknown".
  const c = await checkAndPreview(sql, newKind, Object.assign({}, a.params || {}, params || {}, { ticketId: a.ticket_id || null, byEmail: admin.email }));
  const upd = await sql`UPDATE support_actions
      SET kind = ${newKind}, params = ${JSON.stringify(c.params)}::jsonb, preview = ${JSON.stringify(c.preview)}::jsonb,
          reason = ${why}, status = 'pending', proposed_by = ${admin.id}, proposed_by_email = ${admin.email}, proposed_at = now(),
          returned_by = NULL, returned_by_email = NULL, returned_at = NULL, review_note = NULL
      WHERE id = ${a.id} AND status = 'returned' RETURNING *`;
  if (!upd.length) throw userError('This proposal has already moved on.', 409);
  await notifyReviewers(sql, upd[0]);
  await logAudit(sql, { action: 'support_action_reproposed', success: true, actorType: 'admin', ...audit, targetType: 'support_action', targetId: a.id,
    metadata: { kind: newKind, params: c.params, sentBackBy: a.returned_by_email } });
  return upd[0];
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

module.exports = { GROUNDS, ROLES, KINDS, roleOf, allowed, allowedFor, me, team, setRole, isSuper, removeMember, restoreMember, setSuper, propose, withdraw, list, review, signoff, repropose, SIGNOFFS, describe, forTicket, recordsFor, blockGuest, unblockGuest, blockedListingIds, isBlocked, addReport };
