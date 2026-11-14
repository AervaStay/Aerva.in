// /api/_ownership.js — who a request belongs to, and who may act on it.
// Not an endpoint.
//
// Owner, 14 Nov 2026:
//   "CR can't take action on other CR requests."
//   "Reveiwers cant take action on other reviewer request."
//   "Super Admin can reassign then only they can."
//
// Before this, assignment was only a label: the horizon showed who had a
// request, and anybody could act on it anyway. Two representatives could
// answer the same guest, and two reviewers could decide the same proposal.
//
// THE MODEL, in one paragraph. A request is picked up by one
// representative and is then theirs: only they may reply on it, ask the
// host, write the case record or propose an action. A proposal is decided
// by one reviewer and is then theirs: only they may change that decision.
// A super admin stands outside both and may act on anything, because
// somebody has to be able to unstick a request when a person is away.
//
// PICKING UP IS NOT REASSIGNING. A request nobody holds may be picked up by
// any representative — that is the queue working. Taking a request off
// somebody, or handing it to a third person, is a reassignment, and that is
// a super admin's alone. Without that distinction "only a super admin may
// assign" would mean no representative could ever start work.

const userError = (message, status = 403) => Object.assign(new Error(message), { isUserFacing: true, status });

// Acting on a REQUEST: replying, asking the host, the case record, raising
// a proposal against it.
// Each of these carries the request's own id, as `ticketId` or as `id`.
// raiseForCustomer is deliberately NOT here: it CREATES a request, so there
// is nobody holding it yet, and its `id`-shaped fields are a guest and a
// booking rather than a ticket.
const REQUEST_ACTIONS = new Set([
  'supportReply', 'supportCase', 'hostStep', 'hostReply', 'messageHost',
  'supportSuggest', 'supportHostDraft', 'supportHostSuggest',
  'proposeAction'   // raising a proposal is acting on the request it is for
]);

// Acting on a PROPOSAL as a reviewer — the only thing rule B is about.
// Reproposing and withdrawing are the REPRESENTATIVE's side of a proposal:
// a reviewer sending one back is asking the representative to raise it
// again, so being refused as "not the reviewer who owns it" would stop the
// one person who is supposed to act. Those two are covered instead by rule
// A — the proposal's own request has a holder — and by rule 2 in
// _money-gate.js, which is what stops a representative undoing a decision.
const ACTION_ACTIONS = new Set(['reviewAction']);

// Keys that carry a proposal id and belong to the representative's side.
// Rule A is applied to the request the proposal hangs off.
const PROPOSAL_OWNER_ACTIONS = new Set(['reproposeAction', 'withdrawAction']);

// RULE A — a request belongs to the representative who picked it up.
//
//   t        the support_tickets row (needs assigned_to, assigned_to_email)
//   actor    { id, email, role, isSuper }
async function mayActOnRequest(sql, t, actor) {
  if (!t) return { ok: true };                       // nothing to own
  if (actor.isSuper) return { ok: true };            // stands outside it
  const holder = t.assigned_to == null ? null : Number(t.assigned_to);
  if (holder == null) return { ok: true };           // nobody holds it yet
  if (holder === Number(actor.id)) return { ok: true };
  // A reviewer is not the owner of the request, but reviewing is done on
  // the proposal, not on the request, so they are not blocked here.
  //
  // "Is a reviewer" is read from what the role may DO — decide proposals —
  // and not from the word 'reviewer', because the owner can create roles
  // and name them anything. A role with the deciding tab is a reviewer
  // whatever it is called; one without it is a representative.
  if (actor.decides) return { ok: true };
  return { ok: false,
    why: `${t.assigned_to_email || 'Somebody else'} is working on this request. Ask a super admin to move it to you.` };
}

// RULE B — a proposal belongs to the reviewer who first took it.
//
// A proposal nobody has reviewed is open to any reviewer. Once one has acted
// on it — approved, rejected or sent it back — it is theirs, and a second
// reviewer stepping in would be exactly the thing the owner called out.
//
// reviewer_owner, not reviewed_by. reviewed_by and returned_by both move as
// a proposal goes round: a repropose clears returned_by, so a reviewer could
// send one back, the representative could raise it again, and a different
// reviewer could decide it — reviewed_by was null the whole way through.
// reviewer_owner is claimed once and never moved (see claimReviewer in
// _support-actions.js). Before its migration it is undefined on every row,
// and the rule is simply not in force yet.
//
// A super admin may still act, which is what sign-off is.
function mayActOnAction(a, actor) {
  if (!a) return { ok: true };
  if (actor.isSuper) return { ok: true };
  const owner = a.reviewer_owner == null ? null : Number(a.reviewer_owner);
  if (owner == null) return { ok: true };            // nobody has taken it
  if (owner === Number(actor.id)) return { ok: true };
  return { ok: false,
    why: `${a.reviewer_owner_email || 'Another reviewer'} has already decided this one. Only they or a super admin can change it.` };
}

// RULE C — picking up is free, reassigning is a super admin's.
//
//   current   who holds it now (admins.id or null)
//   to        who it is being given to (admins.id or null for nobody)
function mayAssign({ current, to, actor }) {
  if (actor.isSuper) return { ok: true };
  const held = current == null ? null : Number(current);
  const giveTo = to == null ? null : Number(to);
  if (held == null && giveTo === Number(actor.id)) return { ok: true };   // picking it up
  if (held == null && giveTo == null) return { ok: true };                // no change
  if (held != null && giveTo == null) {
    return { ok: false, why: 'Only a super admin can take a request off somebody.' };
  }
  if (held != null && held !== giveTo) {
    return { ok: false, why: 'Only a super admin can move a request to somebody else.' };
  }
  if (held == null && giveTo !== Number(actor.id)) {
    return { ok: false, why: 'Only a super admin can hand a request to somebody else. You can pick it up yourself.' };
  }
  return { ok: true };
}

// Which ticket a request body is about, when it says so directly.
function ticketIdIn(body) {
  for (const k of Object.keys(body || {})) {
    if (!REQUEST_ACTIONS.has(k)) continue;
    const v = body[k];
    if (!v || typeof v !== 'object') continue;
    const id = v.ticketId != null ? v.ticketId : v.id;
    if (id != null) return Number(id) || null;
  }
  return null;
}
// Which proposal a request body is about, and from which side.
//   { id, reviewing: true }  a reviewer deciding it        → rules B
//   { id, reviewing: false } the representative's side      → rule A
function actionIdIn(body) {
  for (const k of Object.keys(body || {})) {
    const reviewing = ACTION_ACTIONS.has(k);
    if (!reviewing && !PROPOSAL_OWNER_ACTIONS.has(k)) continue;
    const v = body[k];
    if (v && typeof v === 'object' && v.id != null) {
      const id = Number(v.id) || null;
      if (id) return { id, reviewing };
    }
  }
  return null;
}

// One check for a whole request, called early. Returns null when nothing
// about this request is owned by anybody.
async function check(sql, req, actor) {
  if (!req || req.method !== 'POST' || !req.body) return null;
  const tid = ticketIdIn(req.body);
  if (tid) {
    let t = null;
    try { t = (await sql`SELECT id, assigned_to, assigned_to_email FROM support_tickets WHERE id = ${tid}`)[0] || null; }
    catch (err) { return null; }                     // before the horizon update
    const r = await mayActOnRequest(sql, t, actor);
    if (!r.ok) throw userError(r.why);
  }
  const act = actionIdIn(req.body);
  if (act) {
    let a = null;
    // SELECT * on purpose: reviewer_owner arrives with a migration, and a
    // named column that is not there yet would throw instead of simply
    // leaving the rule off.
    try { a = (await sql`SELECT * FROM support_actions WHERE id = ${act.id}`)[0] || null; }
    catch (err) { return null; }
    if (a && act.reviewing) {
      // RULE B — one reviewer owns the proposal.
      const r = mayActOnAction(a, actor);
      if (!r.ok) throw userError(r.why);
    } else if (a && a.ticket_id) {
      // RULE A — a representative reproposing or withdrawing is acting on
      // the request the proposal hangs off, which has a holder.
      let t = null;
      try { t = (await sql`SELECT id, assigned_to, assigned_to_email FROM support_tickets WHERE id = ${a.ticket_id}`)[0] || null; }
      catch (err) { return null; }
      const r = await mayActOnRequest(sql, t, actor);
      if (!r.ok) throw userError(r.why);
    }
  }
  return null;
}

module.exports = { REQUEST_ACTIONS, ACTION_ACTIONS, PROPOSAL_OWNER_ACTIONS, mayActOnRequest, mayActOnAction, mayAssign, ticketIdIn, actionIdIn, check };
