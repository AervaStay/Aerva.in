// /api/_money-gate.js — the three rules the owner set on 14 Nov 2026 about
// who may move money and who may overturn whom. Not an endpoint.
//
//   1. "CR cant refund, neither Reviewer - Only super admin can"
//   2. "CR can't overturn reviewer action but reviewer can overturn"
//   3. "Reviewer cant directly pitch in without going through CR review"
//
// These sit ABOVE roles and tabs. A role the owner creates cannot be given
// any of this, however its tabs are ticked, and the plain Admin role cannot
// do it either — only a super admin. Keeping them in one small file means
// there is a single place to read what the rules are, and a single place a
// new money endpoint has to be added to.

const userError = (message, status = 403) => Object.assign(new Error(message), { isUserFacing: true, status });

// RULE 1. Every request that moves money, by any route. A refund proposed
// through Support already stops at the money gate for a super admin to
// sign; these are the DIRECT routes — the buttons in Lookup and Payouts —
// and before this they were open to anybody holding the Admin role.
//
// Nothing here is about the proposal chain: a representative may still
// propose a refund and a reviewer may still approve one. What neither of
// them can do, and what a plain admin can no longer do either, is make the
// money move.
const MONEY_KEYS = new Set([
  'adminPartialRefund',      // refund an amount without cancelling (Lookup)
  'adminCancelBooking',      // cancel with a refund (Lookup)
  'retryRefund',             // send a failed refund again (Payouts)
  'retryPayout',             // send a failed payout again (Payouts)
  'markPayoutPaid',          // record a payout sent by hand (Payouts)
  'decideCancellationRequest' // approve a natural-disaster cancellation: credit and deposit move
]);

function isMoneyRequest(req) {
  if (!req || req.method !== 'POST' || !req.body) return null;
  for (const k of Object.keys(req.body)) if (MONEY_KEYS.has(k)) return k;
  return null;
}

// Is there any way to BE a super admin on this database yet? The column
// arrives with 2026-11-12-05-super-admin.sql, and the env list is the other
// route. If neither exists, nobody is one — and enforcing the rule would
// then refuse every refund, payout and cancellation decision on the
// platform, from everybody, until that migration was run.
//
// So the rule turns itself on only once it can be satisfied. Deploying the
// code before the migration leaves money working exactly as it did
// yesterday; running the migration switches the rule on. This was found by
// flows 12, 14 and 15, which deliberately run against a database with no
// migrations applied — on a production database that had not had the
// super-admin update yet, the first deploy would have frozen all money.
let superPossible = null;
async function canEnforce(sql) {
  if ((process.env.SUPER_ADMIN_EMAILS || '').trim()) return true;
  if (superPossible !== null) return superPossible;
  try {
    const r = await sql`SELECT count(*)::int AS n FROM information_schema.columns
                        WHERE table_name = 'admins' AND column_name = 'super_admin'`;
    superPossible = Number(r[0].n) > 0;
  } catch (err) { superPossible = false; }
  return superPossible;
}

// Called once, early, on every admin request. Throws when somebody who is
// not a super admin tries to move money directly.
async function check(req, { isSuper, sql }) {
  const key = isMoneyRequest(req);
  if (!key) return null;
  if (isSuper) return key;
  if (sql && !(await canEnforce(sql))) return key;   // see canEnforce above
  throw userError('Only a super admin can move money. Propose it on the request instead, and a super admin will sign it off.');
}

// RULE 2 and RULE 3 live on a proposal's own trail, so they are checked
// where a proposal is acted on rather than here. These two say what the
// rules are; _support-actions.js calls them.

// RULE 2. Once a reviewer has decided a proposal, the representative who
// raised it cannot undo that decision. A reviewer may overturn another
// reviewer, and a super admin may overturn anybody — that is what sign-off
// is for.
//
//   a        the proposal row, as it stands
//   role     the role of whoever is acting
//   isSuper  whether they are a super admin
function canOverturn(a, { role, isSuper }) {
  const decided = !!(a.reviewed_by || a.reviewed_at) || ['approving', 'done', 'failed', 'rejected', 'awaiting_admin'].includes(a.status);
  if (!decided) return { ok: true };
  if (isSuper) return { ok: true };
  if (role === 'reviewer' || role === 'admin') return { ok: true };
  return { ok: false, why: 'A reviewer has already decided this. A representative cannot undo that — ask a reviewer or a super admin.' };
}

// RULE 3, as it now stands (owner, 14 Nov 2026 afternoon: "CR and
// reviewers can propose a refund" — do it).
//
// This replaces the morning's version of the rule, which refused a
// proposal raised by a reviewer on the grounds that there would be nothing
// left for anyone to review. The owner has since settled it the other way:
// a reviewer may raise one too. So anybody on the team may put something
// forward, and nobody may wave their own through.
//
// WHAT STILL STOPS A REVIEWER DECIDING THEIR OWN. The second pair of eyes
// is not lost by this, it just moves: review() refuses a proposal whose
// proposed_by is the person deciding it ("Someone else has to approve your
// own proposal"), so a reviewer who raises one needs another reviewer or
// an admin to decide it. And money, whoever raised it and whoever approved
// it, still stops at the super admin's gate under rule 1.
//
// Kept as a function rather than deleted: it is the one place the rule is
// written down, and the next change to it belongs here.
function canPropose() {
  return { ok: true };
}

module.exports = { MONEY_KEYS, isMoneyRequest, check, canOverturn, canPropose };
