// /api/_roles.js — the roles the owner can create, and the tabs each one
// may use. Not an endpoint.
//
// Owner, 14 Nov 2026: "Admin can create roles and also can define tabs that
// will be allowed against that role."
//
// THE TABS ARE THE PERMISSION. A role is a list of tabs; the requests it may
// make are worked out from that list by TAB_KEYS below. So granting a tab
// grants exactly the calls that tab needs, and nothing else — there is no
// second list to keep in step, and no way to hold a tab without being able
// to use it or to reach an endpoint whose tab you do not have.
//
// Hiding a tab in the page is not a permission. Every request is checked
// here, server side, on the role the database says that person has.

const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });

// Every tab in Admin, in the order the sidebar shows them. The label is
// what the owner ticks in the Roles screen.
// Approvals is TWO permissions, not one. A representative sees the queue
// and proposes; a reviewer decides. Folding them into a single tab would
// have let representatives approve proposals — including refunds — which
// is the one thing the review step exists to prevent. Caught by
// lifecycle_test when this file first took over from the hard-coded rules.
const TABS = [
  ['approvals', 'Approvals — see and propose'],
  ['approvals_decide', 'Approvals — approve or reject'],
  ['support', 'Support'],
  ['lookup', 'Lookup'],
  ['team', 'Team'],
  ['roles', 'Roles'],
  ['safety', 'Data safety'],
  ['db', 'Database updates'],
  ['listings', 'Pending Listings'],
  ['live', 'Live Listings'],
  ['compliance', 'Compliance'],
  ['verifications', 'ID Verifications'],
  ['contact', 'Contact Checks'],
  ['rates', 'Commission Settings'],
  ['insights', 'Business Insights'],
  ['accounts', 'Accounts'],
  ['money', 'Transactions'],
  ['payouts', 'Payouts'],
  ['deposits', 'Security Deposits'],
  ['trust', 'Guest Safety'],
  ['policy', 'Review Policy'],
  ['simulator', 'Simulator'],
  ['batch', 'Batch Jobs'],
  ['traffic', 'Traffic'],
  ['audit', 'Audit Log'],
  ['policies', 'Policies']
];
const TAB_KEYS_SET = new Set(TABS.map(t => t[0]));
const TAB_LABEL = Object.fromEntries(TABS);

// Tabs nobody but a super admin may be given, whatever role they hold.
// These either change who can do what, or can destroy data (owner,
// 14 Nov 2026: "Only Super Admin will have access to Run Batch job and can
// see tab"). Ticking one for an ordinary role is refused.
const SUPER_ONLY = new Set(['safety', 'roles', 'team', 'batch']);

// What each tab needs to call on get-pending-listings.js: the query keys of
// a GET and the body keys of a POST. A request is allowed when EVERY key it
// carries belongs to a tab the role holds.
//
// Keys that are not listed anywhere are admin-only by construction, because
// no tab grants them.
const TAB_KEYS = {
  // Seeing the queue and putting something forward. NOT deciding it.
  approvals: { get: ['supportActions', 'priceReviews', 'checkinPromise', 'groupBookings', 'cancellationRequests'],
               post: ['proposeAction', 'withdrawAction', 'reproposeAction'] },
  // Deciding. signoffAction is here too, but the function behind it allows
  // only a super admin whatever tab you hold, because that is the money
  // gate and it is not a tab's to open.
  approvals_decide: { get: [], post: ['reviewAction', 'signoffAction', 'decidePriceReview', 'decideCancellationRequest'] },
  support:   { get: ['supportCategories', 'supportTickets', 'supportTicket', 'supportTicketLive', 'adminNotes', 'adminSummary', 'aiBudget'],
               post: ['supportReply', 'supportCase', 'supportSuggest', 'supportHostDraft', 'supportHostSuggest', 'raiseForCustomer', 'hostStep', 'hostReply', 'assignRequest', 'messageHost', 'aiToggle'] },
  lookup:    { get: ['lookup', 'lookupBooking', 'lookupGuest', 'lookupListing'], post: [] },
  team:      { get: ['adminTeam'], post: ['setAdminRole', 'removeTeamMember', 'restoreTeamMember', 'setSuperAdmin'] },
  roles:     { get: ['adminRoles'], post: ['createRole', 'updateRole', 'deleteRole'] },
  db:        { get: ['dbMigrations'], post: ['applyMigrations'] },
  audit:     { get: ['auditLog'], post: [] },
  policies:  { get: ['policyDocs'], post: [] }
};
// Everyone signed in may ask who they are and sign themselves out.
const ALWAYS = { get: ['adminMe'], post: ['adminSignOutEverywhere'] };
// Query keys that only shape a request (paging, filters) and never decide
// what it reaches.
const MODIFIERS = new Set(['status', 'days', 'limit', 'offset', 'page', 'q', 'from', 'to', 'before', 'state', 'kind', 'id', 'ref']);

const BUILTIN = {
  admin: { key: 'admin', label: 'Admin', tabs: TABS.map(t => t[0]), builtin: true },
  reviewer: { key: 'reviewer', label: 'Reviewer', tabs: ['lookup', 'support', 'approvals', 'approvals_decide', 'policies'], builtin: true },
  agent: { key: 'agent', label: 'Customer representative', tabs: ['lookup', 'support', 'approvals', 'policies'], builtin: true }
};

let tableReady = null;
async function ready(sql) {
  if (tableReady === true) return true;          // a table does not vanish
  try {
    const r = await sql`SELECT to_regclass('public.admin_roles') IS NOT NULL AS ok`;
    tableReady = !!(r[0] && r[0].ok);
  } catch (err) { tableReady = false; }
  return tableReady;
}

// Every role, by key. Before the migration this is the three that are
// written into the code, so nothing changes until it is run.
async function all(sql) {
  if (!(await ready(sql))) return { ...BUILTIN };
  try {
    const rows = await sql`SELECT key, label, tabs, builtin, created_at, created_by, updated_at, updated_by FROM admin_roles ORDER BY builtin DESC, label`;
    if (!rows.length) return { ...BUILTIN };
    const out = {};
    for (const r of rows) {
      out[r.key] = { key: r.key, label: r.label, builtin: !!r.builtin,
        tabs: (Array.isArray(r.tabs) ? r.tabs : []).filter(t => TAB_KEYS_SET.has(t)),
        createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by };
    }
    return out;
  } catch (err) { return { ...BUILTIN }; }
}

async function get(sql, key) {
  const roles = await all(sql);
  return roles[String(key || '')] || null;
}

// The tabs a role may open. An unknown role gets NOTHING — it used to get
// everything, because the old roleOf() turned any unrecognised role into
// 'admin'.
async function tabsFor(sql, key) {
  if (key === 'admin') return TABS.map(t => t[0]);
  const r = await get(sql, key);
  return r ? r.tabs.slice() : [];
}

// Is this request one that the given tabs allow? Same shape as the old
// allowed(): every key the request carries must be granted.
function allows(tabs, req) {
  const held = new Set(tabs || []);
  const pick = (side) => {
    const out = new Set(ALWAYS[side]);
    for (const t of held) for (const k of ((TAB_KEYS[t] || {})[side] || [])) out.add(k);
    return out;
  };
  if (req.method === 'GET' || req.method === 'OPTIONS') {
    const keys = Object.keys(req.query || {}).filter(k => !MODIFIERS.has(k));
    const ok = pick('get');
    return keys.length > 0 && keys.every(k => ok.has(k));
  }
  const keys = Object.keys(req.body || {});
  const ok = pick('post');
  return keys.length > 0 && keys.every(k => ok.has(k));
}

const cleanKey = (k) => String(k || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '').slice(0, 31);
const cleanTabs = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter(t => TAB_KEYS_SET.has(t)))];

// The reserved tabs cannot be put on ANY role except the built-in Admin —
// not even by a super admin, and not even on a role only super admins would
// hold. Three of them (Roles, Team, Data safety) decide who can do what, so
// granting one is granting the power to grant anything; Batch Jobs can set
// the whole platform running by hand. The owner's rule for the last of
// those (14 Nov 2026): "Only Super Admin will have access to Run Batch job
// and can see tab".
//
// The endpoints behind them check for a super admin as well. This stops the
// tab being handed out in the first place, so nobody is shown a tab that
// would then refuse them.
function checkTabs(tabs, { roleKey } = {}) {
  if (roleKey === 'admin') return;
  const barred = tabs.filter(t => SUPER_ONLY.has(t));
  if (barred.length) {
    throw userError(`${barred.map(t => TAB_LABEL[t]).join(', ')} ${barred.length === 1 ? 'is' : 'are'} for super admins only and cannot be put on a role.`, 403);
  }
}

async function create(sql, { key, label, tabs, by, isSuper }) {
  if (!(await ready(sql))) throw userError('Aerva cannot add roles yet — the database update for it has not been run.', 503);
  const k = cleanKey(key || label);
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(k)) throw userError('Give the role a name of at least two letters.');
  const name = String(label || '').trim().slice(0, 60);
  if (!name) throw userError('Give the role a name.');
  const t = cleanTabs(tabs);
  if (!t.length) throw userError('Tick at least one tab, or the role can do nothing.');
  checkTabs(t, { roleKey: k });
  const exists = await sql`SELECT key FROM admin_roles WHERE key = ${k}`;
  if (exists.length) throw userError('There is already a role with that name.', 409);
  const r = await sql`INSERT INTO admin_roles (key, label, tabs, builtin, created_by)
                      VALUES (${k}, ${name}, ${JSON.stringify(t)}::jsonb, false, ${by || null}) RETURNING key`;
  return { key: r[0].key, label: name, tabs: t, builtin: false };
}

async function update(sql, { key, label, tabs, by, isSuper }) {
  if (!(await ready(sql))) throw userError('Aerva cannot change roles yet — the database update for it has not been run.', 503);
  const k = cleanKey(key);
  const cur = await get(sql, k);
  if (!cur) throw userError('No such role.', 404);
  const t = tabs === undefined ? cur.tabs : cleanTabs(tabs);
  if (!t.length) throw userError('Tick at least one tab, or the role can do nothing.');
  checkTabs(t, { roleKey: k });
  // The admin role is what manages everything else. Leaving it without the
  // Roles or Team tab would lock the owner out of their own permissions
  // with no way back except SQL.
  if (k === 'admin' && !(t.includes('roles') && t.includes('team'))) {
    throw userError('The Admin role has to keep Roles and Team, or nobody could change roles again.');
  }
  const name = label === undefined ? cur.label : String(label).trim().slice(0, 60);
  if (!name) throw userError('Give the role a name.');
  await sql`UPDATE admin_roles SET label = ${name}, tabs = ${JSON.stringify(t)}::jsonb,
                   updated_at = now(), updated_by = ${by || null} WHERE key = ${k}`;
  return { key: k, label: name, tabs: t, builtin: cur.builtin };
}

async function remove(sql, { key, by }) {
  if (!(await ready(sql))) throw userError('Aerva cannot change roles yet — the database update for it has not been run.', 503);
  const k = cleanKey(key);
  const cur = await get(sql, k);
  if (!cur) throw userError('No such role.', 404);
  if (cur.builtin) throw userError('The three roles Aerva ships with cannot be deleted. Change what they can reach instead.', 409);
  const inUse = await sql`SELECT count(*)::int AS n FROM admins WHERE role = ${k} AND removed_at IS NULL`;
  if (Number(inUse[0].n) > 0) {
    throw userError(`${inUse[0].n} ${Number(inUse[0].n) === 1 ? 'person is' : 'people are'} on this role. Move them to another role first.`, 409);
  }
  await sql`DELETE FROM admin_roles WHERE key = ${k} AND builtin = false`;
  return { key: k, deleted: true };
}

// For the Roles screen: every role, every tab, and how many people hold each.
async function screen(sql) {
  const roles = await all(sql);
  let counts = {};
  try {
    const rows = await sql`SELECT role, count(*)::int AS n FROM admins WHERE removed_at IS NULL GROUP BY role`;
    counts = Object.fromEntries(rows.map(r => [r.role, Number(r.n)]));
  } catch (err) { counts = {}; }
  return {
    ready: await ready(sql),
    tabs: TABS.map(([key, label]) => ({ key, label, superOnly: SUPER_ONLY.has(key) })),
    roles: Object.values(roles).map(r => ({ ...r, people: counts[r.key] || 0 }))
  };
}

module.exports = { TABS, TAB_LABEL, TAB_KEYS, SUPER_ONLY, MODIFIERS, BUILTIN,
                   ready, all, get, tabsFor, allows, create, update, remove, screen,
                   _internals: { cleanKey, cleanTabs, checkTabs } };
