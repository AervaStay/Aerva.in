// /api/_bank-check.js — the PAN and the bank account must belong to the same
// person. Not an endpoint.
//
//   PAN       Checked when it is entered: the format (_tds.js), the 5th
//             letter against the name as printed on the PAN (it is the
//             first letter of the holder's surname, or of a business's
//             name), and that no other Aerva account already uses it.
//             The admin confirms the number and name against the card.
//
//   Bank      Penny drop through RazorpayX (fund account validation): ₹1 is
//             sent to the account and the bank returns the name it is held
//             in. That name is compared with the name on the PAN:
//               match     → bank details approved automatically
//               partial   → left for an admin to decide (both names shown)
//               mismatch  → refused: payouts go only to the PAN holder
//               invalid   → refused: the bank could not confirm the account
//             Without RazorpayX set up, or if the check fails, the details
//             wait for an admin to review by hand, as before.
//
//   Change    A new bank account is checked again from scratch: the saved
//             RazorpayX payee is cleared, so no payout can go to the old
//             account, and payouts wait 48 hours after any change (time for
//             the account holder to notice the change email).
//
// Works for both payees: hosts (table hosts) and co-hosts
// (table cohost_payout_profiles). Columns: migration_bank_check.sql.

const { decryptField } = require('./_secure-fields');
const { logAudit } = require('./_audit-log');

const HOLD_HOURS_AFTER_CHANGE = 48;
const ready = () => !!(process.env.RAZORPAYX_ACCOUNT_NUMBER && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const notReady = (err) => !!err && (err.code === '42703' || err.code === '42P01');

// ------------------------------------------------------------------ names
const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'DR', 'SHRI', 'SRI', 'SHREE', 'SMT', 'KUMARI', 'KUM', 'PROF', 'LATE', 'MASTER', 'THE']);
const SAME = { PVT: 'PRIVATE', PRIV: 'PRIVATE', LTD: 'LIMITED', LTDA: 'LIMITED', CO: 'COMPANY', CORP: 'CORPORATION', INC: 'INCORPORATED', '&': 'AND', HUF: 'HUF' };
function nameTokens(name) {
  return String(name || '').toUpperCase()
    .replace(/\bM\s*\/\s*S\b\.?/g, ' ')            // M/S (messrs)
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/).filter(Boolean)
    .map(t => SAME[t] || t)
    .filter(t => !TITLES.has(t));
}

// How closely two names agree. Banks often shorten, reorder, or use
// initials ("R K SHARMA" for "RAVI KUMAR SHARMA"), so this is tolerant of
// those, and nothing else.
//   'match'    every part of the shorter name is in the longer one (initials
//              count), with at least one whole part the same, and — unless
//              one name is a single word — at least two parts in common
//   'partial'  some whole part in common, but not enough to be sure
//   'mismatch' nothing whole in common
function nameMatch(a, b) {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return { result: 'mismatch', score: 0 };
  if (ta.join('') === tb.join('') || [...ta].sort().join(' ') === [...tb].sort().join(' ')) return { result: 'match', score: 100 };
  const [S, L] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const used = new Set();
  let matched = 0, whole = 0;
  for (const t of S) {
    let hit = -1, isWhole = false;
    L.forEach((u, i) => {
      if (hit >= 0 || used.has(i)) return;
      if (t === u) { hit = i; isWhole = t.length >= 2; }
    });
    if (hit < 0) L.forEach((u, i) => {
      if (hit >= 0 || used.has(i)) return;
      if (t.length === 1 && u.startsWith(t)) hit = i;                                   // an initial
      else if (u.length === 1 && t.startsWith(u)) hit = i;
      else if (t.length >= 4 && u.length >= 4 && (u.startsWith(t) || t.startsWith(u))) { hit = i; isWhole = true; } // shortened by the bank
    });
    if (hit >= 0) { used.add(hit); matched++; if (isWhole) whole++; }
  }
  const score = Math.round(100 * matched / L.length);
  if (matched === S.length && whole >= 1 && (S.length >= 2 || L.length === 1)) return { result: 'match', score: Math.max(score, 80) };
  const common = ta.filter(t => t.length >= 3 && tb.includes(t)).length;
  if (common || whole) return { result: 'partial', score };
  return { result: 'mismatch', score };
}

// The PAN's 5th letter is the first letter of the holder's surname (a
// person) or of the business's name. A name with no part starting with that
// letter means the PAN or the name was typed wrong. Returns an error or null.
function panNameProblem(pan, panName) {
  const p = String(pan || '').trim().toUpperCase();
  const tokens = nameTokens(panName);
  if (tokens.length === 0 || String(panName || '').trim().length < 3) return 'Enter your name exactly as it is printed on your PAN card.';
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p)) return null;               // the format check reports this
  const fifth = p[4];
  if (!tokens.some(t => t[0] === fifth)) {
    return `This PAN and name do not go together: the 5th letter of a PAN (${fifth}) is the first letter of the holder’s surname, or of the business’s name. Check both against your PAN card.`;
  }
  return null;
}

// Is this PAN already on another Aerva account? A host and their own
// co-host profile (the same person) may share it. PANs are stored
// encrypted, so they are compared after decrypting.
async function panInUseElsewhere(sql, pan, { hostId = null, guestId = null } = {}) {
  const p = String(pan || '').trim().toUpperCase();
  if (!p) return false;
  const hosts = await sql`SELECT id, guest_id, pan_number FROM hosts WHERE pan_number IS NOT NULL AND id <> ${hostId || 0}`;
  for (const h of hosts) {
    if (guestId && Number(h.guest_id) === Number(guestId)) continue;
    if (String(decryptField(h.pan_number) || '').toUpperCase() === p) return true;
  }
  let profiles = [];
  try { profiles = await sql`SELECT guest_id, pan_number FROM cohost_payout_profiles WHERE pan_number IS NOT NULL AND guest_id <> ${guestId || 0}`; } catch (e) { profiles = []; }
  const hostGuest = hostId ? ((await sql`SELECT guest_id FROM hosts WHERE id = ${hostId}`)[0] || {}).guest_id : null;
  for (const c of profiles) {
    if (hostGuest && Number(c.guest_id) === Number(hostGuest)) continue;
    if (String(decryptField(c.pan_number) || '').toUpperCase() === p) return true;
  }
  return false;
}

// ------------------------------------------------------------- RazorpayX
async function razorpayx(method, path, body) {
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method, headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.description) || `RazorpayX ${res.status}`);
  return data;
}

// One payee, read the same way from either table.
async function loadPayee(sql, kind, key) {
  if (kind === 'host') {
    const h = (await sql`SELECT h.id, h.name, h.email, h.pan_number, h.bank_account_number, h.bank_ifsc, h.bank_account_holder_name, h.bank_status,
                                to_jsonb(h) AS j FROM hosts h WHERE h.id = ${key}`)[0];
    if (!h) return null;
    return { kind, key: h.id, name: h.name, email: h.email, panName: h.j.pan_name || null, holder: h.bank_account_holder_name,
             account: decryptField(h.bank_account_number), ifsc: h.bank_ifsc, status: h.bank_status, checkId: h.j.bank_check_id || null, checkStatus: h.j.bank_check_status || null };
  }
  const c = (await sql`SELECT p.guest_id, p.account_holder_name, p.bank_account_number, p.bank_ifsc, p.status, g.name, g.email, to_jsonb(p) AS j
                       FROM cohost_payout_profiles p JOIN guests g ON g.id = p.guest_id WHERE p.guest_id = ${key}`)[0];
  if (!c) return null;
  return { kind, key: c.guest_id, name: c.name, email: c.email, panName: c.j.pan_name || null, holder: c.account_holder_name,
           account: decryptField(c.bank_account_number), ifsc: c.bank_ifsc, status: c.status, checkId: c.j.bank_check_id || null, checkStatus: c.j.bank_check_status || null };
}

async function saveCheck(sql, kind, key, f) {
  if (kind === 'host') {
    await sql`UPDATE hosts SET
                bank_check_id = COALESCE(${f.id ?? null}, bank_check_id), bank_check_status = ${f.status},
                bank_registered_name = ${f.registeredName ?? null}, bank_name_match = ${f.match ?? null},
                bank_checked_at = now(), razorpayx_fund_account_id = COALESCE(${f.fundAccountId ?? null}, razorpayx_fund_account_id)
              WHERE id = ${key}`;
  } else {
    await sql`UPDATE cohost_payout_profiles SET
                bank_check_id = COALESCE(${f.id ?? null}, bank_check_id), bank_check_status = ${f.status},
                bank_registered_name = ${f.registeredName ?? null}, bank_name_match = ${f.match ?? null},
                bank_checked_at = now(), razorpayx_fund_account_id = COALESCE(${f.fundAccountId ?? null}, razorpayx_fund_account_id)
              WHERE guest_id = ${key}`;
  }
}

// The outcome, on the payee's own status. Only a payee still waiting
// (pending_review) is moved, so an admin's decision is never overwritten.
async function settleStatus(sql, kind, key, decision, reason) {
  if (kind === 'host') {
    if (decision === 'approve') await sql`UPDATE hosts SET bank_status = 'verified', bank_rejection_reason = NULL WHERE id = ${key} AND bank_status = 'pending_review'`;
    else if (decision === 'reject') await sql`UPDATE hosts SET bank_status = 'rejected', bank_rejection_reason = ${reason} WHERE id = ${key} AND bank_status = 'pending_review'`;
  } else {
    if (decision === 'approve') await sql`UPDATE cohost_payout_profiles SET status = 'approved', rejection_reason = NULL, reviewed_at = now() WHERE guest_id = ${key} AND status = 'pending_review'`;
    else if (decision === 'reject') await sql`UPDATE cohost_payout_profiles SET status = 'rejected', rejection_reason = ${reason}, reviewed_at = now() WHERE guest_id = ${key} AND status = 'pending_review'`;
  }
}

async function sendMail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html: `<div style="font-family:sans-serif; max-width:520px; color:#1c1a17;">${html}</div>` }) });
    return r.ok;
  } catch (e) { return false; }
}
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Bank details were just saved: tell the account owner (a hijacked account
// changing where payouts go is the fraud this guards against), and start
// the penny drop. Never throws: the details are saved either way.
async function bankDetailsChanged(sql, kind, key) {
  try {
    const p = await loadPayee(sql, kind, key);
    if (!p) return { status: 'missing' };
    const last4 = String(p.account || '').slice(-4);
    await sendMail(p.email, 'Your payout bank account was changed',
      `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">Your payout bank account was changed</h2>
       <p>The bank account for your Aerva payouts was just set to the account ending <strong>${esc(last4)}</strong> (${esc(p.ifsc)}), in the name ${esc(p.holder)}.</p>
       <p>Aerva checks it with your bank, and payouts wait ${HOLD_HOURS_AFTER_CHANGE} hours after any change.</p>
       <p><strong>Did not make this change?</strong> Reply to this email or write to hello@aerva.in straight away.</p>`);
    return await startCheck(sql, kind, key);
  } catch (err) {
    console.error('bank check not started:', err.message);
    return { status: 'error' };
  }
}

// The penny drop. A fresh RazorpayX payee (contact + fund account) in the
// name on the PAN, then ₹1 to it.
async function startCheck(sql, kind, key) {
  if (!ready()) {
    try { await saveCheck(sql, kind, key, { status: 'not_set_up' }); } catch (e) { if (!notReady(e)) throw e; }
    return { status: 'not_set_up' };
  }
  const p = await loadPayee(sql, kind, key);
  if (!p || !p.account || !p.ifsc) return { status: 'missing' };
  try {
    const contact = await razorpayx('POST', '/contacts', { name: (p.panName || p.holder || p.name || 'Aerva payee').slice(0, 50), email: p.email || undefined, type: 'vendor',
      reference_id: `${kind === 'host' ? 'hosts' : 'cohost_payout_profiles'}-${key}` });
    const fa = await razorpayx('POST', '/fund_accounts', { contact_id: contact.id, account_type: 'bank_account',
      bank_account: { name: (p.panName || p.holder || '').slice(0, 120), ifsc: p.ifsc, account_number: p.account } });
    const v = await razorpayx('POST', '/fund_accounts/validations', { account_number: process.env.RAZORPAYX_ACCOUNT_NUMBER,
      fund_account: { id: fa.id }, amount: 100, currency: 'INR', notes: { payee: `${kind}-${key}` } });
    await saveCheck(sql, kind, key, { id: v.id, status: 'checking', fundAccountId: fa.id });
    await logAudit(sql, { action: 'bank_check_started', success: true, actorType: 'system', actorIdentifier: 'bank-check',
      targetType: kind === 'host' ? 'host' : 'guest', targetId: key, metadata: { validationId: v.id } });
    if (v.status && v.status !== 'created') return await settleCheck(sql, kind, key, v);
    return { status: 'checking' };
  } catch (err) {
    await saveCheck(sql, kind, key, { status: 'error' });
    await logAudit(sql, { action: 'bank_check_started', success: false, actorType: 'system', actorIdentifier: 'bank-check',
      targetType: kind === 'host' ? 'host' : 'guest', targetId: key, metadata: { error: String(err.message || err).slice(0, 300) } });
    return { status: 'error', error: err.message };
  }
}

// A finished (or failed) validation → the decision.
async function settleCheck(sql, kind, key, v) {
  const p = await loadPayee(sql, kind, key);
  if (!p) return { status: 'missing' };
  if (v.status === 'failed') {
    await saveCheck(sql, kind, key, { status: 'failed' });
    return { status: 'failed' };                      // left for an admin
  }
  if (v.status !== 'completed') return { status: 'checking' };
  const r = v.results || {};
  const registered = r.registered_name ? String(r.registered_name).trim().slice(0, 140) : null;
  if (r.account_status !== 'active') {
    await saveCheck(sql, kind, key, { status: 'invalid', registeredName: registered });
    const why = 'Your bank could not confirm this account. Check the account number and IFSC, then save them again.';
    await settleStatus(sql, kind, key, 'reject', why);
    await tellResult(p, 'reject', why);
    return { status: 'invalid' };
  }
  // Compared with the name on the PAN; without one on file (PANs entered
  // before this check), an admin decides.
  const against = p.panName;
  const m = against && registered ? nameMatch(against, registered) : { result: 'partial', score: null };
  await saveCheck(sql, kind, key, { status: 'active', registeredName: registered, match: m.result });
  let decision = 'review', why = null;
  if (against && m.result === 'match') decision = 'approve';
  else if (against && m.result === 'mismatch') {
    decision = 'reject';
    why = `This account is held in the name “${registered}”. Payouts can only go to an account in the name on your PAN (${against}). Add an account in that name.`;
  }
  await settleStatus(sql, kind, key, decision, why);
  await logAudit(sql, { action: 'bank_check_completed', success: true, actorType: 'system', actorIdentifier: 'bank-check',
    targetType: kind === 'host' ? 'host' : 'guest', targetId: key, metadata: { match: m.result, score: m.score, decision } });
  if (decision !== 'review') await tellResult(p, decision, why);
  return { status: 'active', match: m.result, decision };
}

async function tellResult(p, decision, why) {
  if (decision === 'approve') {
    await sendMail(p.email, 'Your bank account is verified', `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">Your bank account is verified</h2>
      <p>Your bank confirmed the account ending ${esc(String(p.account || '').slice(-4))} is in the name on your PAN. Payouts will go to it.</p>`);
  } else if (decision === 'reject') {
    await sendMail(p.email, 'Your bank account could not be verified', `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">Your bank account could not be verified</h2>
      <p>${esc(why)}</p><p>Update it in your Aerva account. Payouts wait until a bank account is verified.</p>`);
  }
}

// Validations still in progress: ask RazorpayX again. The scheduler runs
// this every 5 minutes, and the host's own page calls it for their row.
async function pollChecks(sql, { deadlineMs = 4000, only = null } = {}) {
  if (!ready()) return { checked: 0 };
  const started = Date.now();
  let rows = [];
  try {
    const hosts = await sql`SELECT 'host' AS kind, id AS key, bank_check_id FROM hosts WHERE bank_check_status = 'checking' AND bank_check_id IS NOT NULL`;
    let cos = [];
    try { cos = await sql`SELECT 'cohost' AS kind, guest_id AS key, bank_check_id FROM cohost_payout_profiles WHERE bank_check_status = 'checking' AND bank_check_id IS NOT NULL`; } catch (e) { cos = []; }
    rows = hosts.concat(cos);
  } catch (err) { if (notReady(err)) return { checked: 0, ready: false }; throw err; }
  if (only) rows = rows.filter(r => r.kind === only.kind && Number(r.key) === Number(only.key));
  const results = [];
  for (const r of rows) {
    if (Date.now() - started > deadlineMs) break;
    try {
      const v = await razorpayx('GET', `/fund_accounts/validations/${encodeURIComponent(r.bank_check_id)}`);
      results.push({ payee: `${r.kind}-${r.key}`, ...(await settleCheck(sql, r.kind, Number(r.key), v)) });
    } catch (err) { results.push({ payee: `${r.kind}-${r.key}`, status: 'error', error: err.message }); }
  }
  return { checked: results.length, results };
}

// Bank details changed less than 48 hours ago: no payout yet.
function inChangeHold(changedAt) {
  return !!changedAt && (Date.now() - new Date(changedAt).getTime()) < HOLD_HOURS_AFTER_CHANGE * 3600e3;
}

// What the payee and the admin see about the check.
function describeCheck(row) {
  const s = row && row.bank_check_status;
  const m = row && row.bank_name_match;
  const map = {
    checking: 'Checking with your bank…',
    not_set_up: 'Waiting for Aerva to review.',
    error: 'Waiting for Aerva to review.',
    failed: 'Your bank did not respond. Waiting for Aerva to review.',
    invalid: 'Your bank could not confirm this account.',
    active: m === 'match' ? 'Confirmed by your bank, in the name on your PAN.' : m === 'mismatch' ? 'The account is not in the name on your PAN.' : 'Confirmed by your bank. Aerva is checking the name.'
  };
  return s ? (map[s] || null) : null;
}

module.exports = {
  nameTokens, nameMatch, panNameProblem, panInUseElsewhere,
  bankDetailsChanged, startCheck, settleCheck, pollChecks, inChangeHold, describeCheck, HOLD_HOURS_AFTER_CHANGE
};
