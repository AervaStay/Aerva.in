// /api/_ai-budget.js — what Aerva spends on the Anthropic API, and the
// ceiling it will not go past in a day. Not an endpoint.
//
// Why this exists (owner, 14 Nov 2026): before this there was no record of
// what the support assistant and the suggestion cards cost, and no limit on
// them. The guest chat had a per-account message limit (20 an hour, 80 a
// day), which stops one person looping — but nothing stopped the platform
// as a whole, and nothing at all limited the team's own suggestion clicks,
// which are the expensive calls.
//
// Two things here:
//
//   1. A record. Every model call writes its real token counts, as the API
//      reports them, into ai_usage — one row per IST day per kind. Cost is
//      worked out from the model's published rates, so Admin can show what
//      a day actually cost rather than an estimate of calls.
//
//   2. A ceiling. Before a call is made, the day's spend and call count are
//      checked against the caps below. Over either one, the call does not
//      happen: support still works, the person is simply served by a human
//      instead of the assistant. A cap is a cost stop, never a reason to
//      leave somebody unanswered.
//
// If the ai_usage table is missing (the database update has not been run),
// calls are allowed and the usage is not recorded — a pending migration
// must not take support down. Admin → Database updates says so, and the
// budget panel says the cap is not being enforced yet.
//
// Environment, all optional:
//   AI_DAILY_RUPEES        platform-wide spend ceiling per IST day (400)
//   AI_DAILY_CALLS         platform-wide call ceiling per IST day (500)
//   AI_ADMIN_DAILY_CALLS   one admin's suggestion/summary calls a day (60)
//   AI_USD_INR             rupees to the dollar for the cost figures (89)

const CAPS = () => ({
  rupees: Math.max(0, Number(process.env.AI_DAILY_RUPEES) || 400),
  calls: Math.max(0, Number(process.env.AI_DAILY_CALLS) || 500),
  perAdmin: Math.max(0, Number(process.env.AI_ADMIN_DAILY_CALLS) || 60)
});
const USD_INR = () => Number(process.env.AI_USD_INR) || 89;

// Published rates, US dollars per million tokens. A model we do not know
// falls back to the Haiku rates, which are the ones Aerva runs on; an
// unknown model is never treated as free.
const RATES = {
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.10, cacheWrite: 1.25 },
  'claude-sonnet-4-5': { in: 3, out: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-opus-4-5': { in: 5, out: 25, cacheRead: 0.50, cacheWrite: 6.25 }
};
const rateFor = (model) => {
  const m = String(model || '');
  const key = Object.keys(RATES).find(k => m.startsWith(k));
  return RATES[key] || RATES['claude-haiku-4-5'];
};

const istDay = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

// What one call cost, in rupees, from the token counts the API reported.
function costOf(model, u = {}) {
  const r = rateFor(model);
  const n = (x) => Math.max(0, Number(x) || 0);
  const usd = (n(u.input_tokens) * r.in
    + n(u.output_tokens) * r.out
    + n(u.cache_read_input_tokens) * r.cacheRead
    + n(u.cache_creation_input_tokens) * r.cacheWrite) / 1e6;
  return usd * USD_INR();
}

let ready = null;
async function tableReady(sql) {
  if (ready !== null) return ready;
  try {
    const r = await sql`SELECT to_regclass('public.ai_usage') IS NOT NULL AS ok`;
    ready = !!(r[0] && r[0].ok);
  } catch (err) { ready = false; }
  return ready;
}

async function today(sql) {
  if (!(await tableReady(sql))) return null;
  const r = await sql`SELECT COALESCE(sum(calls), 0)::int AS calls,
                             COALESCE(sum(cost_inr), 0)::numeric AS cost_inr
                      FROM ai_usage WHERE day = ${istDay()}`;
  return { calls: Number(r[0].calls) || 0, rupees: Number(r[0].cost_inr) || 0 };
}

// Called before a model call. Throws a user-facing 429 when the day is
// spent. `by` is the admin's email for the per-person cap; guest calls pass
// nothing and are covered by the platform cap plus their own message limit.
// Has this person turned the AI off for themselves? Returns false when the
// column is not there yet (the database update is pending), because a
// missing column must not switch everybody's AI off.
async function aiOffFor(sql, email) {
  if (!email) return false;
  try {
    const r = await sql`SELECT ai_enabled FROM admins WHERE lower(email) = ${String(email).toLowerCase()}`;
    return r.length > 0 && r[0].ai_enabled === false;
  } catch (err) { return false; }
}

async function check(sql, { kind = 'other', by = null } = {}) {
  // Their own choice comes first: it is the most specific reason, and it
  // applies whether or not the usage table exists yet.
  if (by && (await aiOffFor(sql, by))) {
    throw Object.assign(new Error('You have Aerva’s AI turned off for your account. Turn it back on under your name in Admin, or write the reply yourself.'),
      { isUserFacing: true, status: 403, aiOff: true });
  }
  if (!(await tableReady(sql))) return { enforced: false };
  const caps = CAPS();
  const day = await today(sql);
  if (caps.calls && day.calls >= caps.calls) {
    throw Object.assign(new Error('Aerva’s AI budget for today is used up. Our team will answer this themselves.'),
      { isUserFacing: true, status: 429, budgetSpent: true });
  }
  if (caps.rupees && day.rupees >= caps.rupees) {
    throw Object.assign(new Error('Aerva’s AI budget for today is used up. Our team will answer this themselves.'),
      { isUserFacing: true, status: 429, budgetSpent: true });
  }
  if (by && caps.perAdmin) {
    const mine = (await sql`SELECT COALESCE(sum(calls), 0)::int AS n FROM ai_usage
                            WHERE day = ${istDay()} AND by_email = ${String(by).toLowerCase()}`)[0];
    if ((Number(mine.n) || 0) >= caps.perAdmin) {
      throw Object.assign(new Error(`You have used today’s ${caps.perAdmin} AI suggestions. Write the reply yourself, or ask a super admin to raise the limit.`),
        { isUserFacing: true, status: 429, budgetSpent: true });
    }
  }
  return { enforced: true, ...day, caps };
}

// Called after a model call with the API's own usage block. Never throws:
// a call that has already been paid for must not fail on bookkeeping.
async function record(sql, { kind = 'other', model = '', by = null, usage = {} } = {}) {
  try {
    if (!(await tableReady(sql))) return null;
    const cost = costOf(model, usage);
    const n = (x) => Math.max(0, Number(x) || 0);
    await sql`
      INSERT INTO ai_usage (day, kind, by_email, calls, input_tokens, output_tokens,
                            cache_read_tokens, cache_write_tokens, cost_inr)
      VALUES (${istDay()}, ${String(kind).slice(0, 40)}, ${by ? String(by).toLowerCase().slice(0, 200) : null},
              1, ${n(usage.input_tokens)}, ${n(usage.output_tokens)},
              ${n(usage.cache_read_input_tokens)}, ${n(usage.cache_creation_input_tokens)}, ${cost})
      ON CONFLICT (day, kind, by_key) DO UPDATE SET
        calls              = ai_usage.calls + 1,
        input_tokens       = ai_usage.input_tokens + EXCLUDED.input_tokens,
        output_tokens      = ai_usage.output_tokens + EXCLUDED.output_tokens,
        cache_read_tokens  = ai_usage.cache_read_tokens + EXCLUDED.cache_read_tokens,
        cache_write_tokens = ai_usage.cache_write_tokens + EXCLUDED.cache_write_tokens,
        cost_inr           = ai_usage.cost_inr + EXCLUDED.cost_inr`;
    return cost;
  } catch (err) {
    console.error('ai budget: could not record usage', err && err.message);
    return null;
  }
}

// For Admin: the last `days` days, newest first, with today's caps beside
// them so the panel can show how close the day came.
async function report(sql, days = 14) {
  const enforced = await tableReady(sql);
  if (!enforced) return { enforced: false, caps: CAPS(), days: [], today: null };
  const rows = await sql`SELECT day, kind, sum(calls)::int AS calls,
                                sum(input_tokens)::bigint   AS input_tokens,
                                sum(output_tokens)::bigint  AS output_tokens,
                                sum(cache_read_tokens)::bigint  AS cache_read_tokens,
                                sum(cache_write_tokens)::bigint AS cache_write_tokens,
                                sum(cost_inr)::numeric AS cost_inr
                         FROM ai_usage
                         WHERE day > (now() AT TIME ZONE 'Asia/Kolkata')::date - ${Math.max(1, Math.min(90, Number(days) || 14))}::int
                         GROUP BY day, kind ORDER BY day DESC, cost_inr DESC`;
  const byDay = new Map();
  for (const r of rows) {
    const d = String(r.day).slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, { day: d, calls: 0, rupees: 0, kinds: [] });
    const e = byDay.get(d);
    e.calls += Number(r.calls) || 0;
    e.rupees += Number(r.cost_inr) || 0;
    e.kinds.push({
      kind: r.kind, calls: Number(r.calls) || 0, rupees: Number(r.cost_inr) || 0,
      input: Number(r.input_tokens) || 0, output: Number(r.output_tokens) || 0,
      cacheRead: Number(r.cache_read_tokens) || 0, cacheWrite: Number(r.cache_write_tokens) || 0
    });
  }
  return { enforced: true, caps: CAPS(), usdInr: USD_INR(), today: await today(sql), days: [...byDay.values()], people: await people(sql) };
}

// Everyone on the team, with their own AI spend against their name and how
// much of today's allowance is left (owner, 14 Nov 2026: "show the token
// credit against each CR... Same for reviewer... Same for Super Admin").
//
// Read for every role, not just representatives: a reviewer who changes a
// proposal and a super admin signing one off both use the same suggestion
// cards, so both spend and both are shown.
//
// `left` is the credit: how many more AI calls that person can make today
// before their own cap stops them. It is a count, because the per-person
// cap is a count; the rupees beside it are what they have actually cost.
async function people(sql) {
  let rows = [];
  try {
    rows = await sql`SELECT lower(a.email) AS email, a.name, a.role,
                            COALESCE(a.super_admin, false) AS super_admin,
                            COALESCE(a.ai_enabled, true)   AS ai_enabled
                     FROM admins a WHERE a.removed_at IS NULL ORDER BY a.email`;
  } catch (err) {
    // Either column may be missing while a database update is pending.
    try { rows = await sql`SELECT lower(email) AS email, name, role FROM admins ORDER BY email`; }
    catch (e) { return []; }
  }
  let used = [];
  if (await tableReady(sql)) {
    used = await sql`SELECT by_email, sum(calls)::int AS calls, sum(cost_inr)::numeric AS cost_inr,
                            sum(input_tokens + cache_read_tokens + cache_write_tokens)::bigint AS in_tokens,
                            sum(output_tokens)::bigint AS out_tokens
                     FROM ai_usage WHERE day = ${istDay()} AND by_email IS NOT NULL GROUP BY by_email`;
  }
  const byEmail = new Map(used.map(u => [String(u.by_email).toLowerCase(), u]));
  const caps = CAPS();
  return rows.map(r => {
    const u = byEmail.get(r.email) || {};
    const calls = Number(u.calls) || 0;
    return {
      email: r.email, name: r.name || null, role: r.role || null,
      superAdmin: !!r.super_admin,
      aiEnabled: r.ai_enabled === undefined ? true : r.ai_enabled !== false,
      calls,
      rupees: Number(u.cost_inr) || 0,
      inTokens: Number(u.in_tokens) || 0,
      outTokens: Number(u.out_tokens) || 0,
      cap: caps.perAdmin,
      left: caps.perAdmin ? Math.max(0, caps.perAdmin - calls) : null
    };
  });
}

// Turn one person's AI on or off. A person may always set their own; a
// super admin may set anybody's. Nobody else can touch somebody else's.
async function setAi(sql, { email, enabled, by, bySuper = false }) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) throw Object.assign(new Error('Which account?'), { isUserFacing: true, status: 400 });
  const self = String(by || '').trim().toLowerCase() === target;
  if (!self && !bySuper) {
    throw Object.assign(new Error('Only a super admin can change this for somebody else.'), { isUserFacing: true, status: 403 });
  }
  let r;
  try {
    r = await sql`UPDATE admins SET ai_enabled = ${!!enabled} WHERE lower(email) = ${target} RETURNING lower(email) AS email, ai_enabled`;
  } catch (err) {
    throw Object.assign(new Error('Aerva cannot change this yet — the database update for it has not been run.'), { isUserFacing: true, status: 503 });
  }
  if (!r.length) throw Object.assign(new Error('No such account.'), { isUserFacing: true, status: 404 });
  return { email: r[0].email, aiEnabled: r[0].ai_enabled !== false, changedBy: self ? 'self' : 'super_admin' };
}

module.exports = { check, record, report, today, costOf, CAPS, people, setAi, aiOffFor, _internals: { rateFor, istDay } };
