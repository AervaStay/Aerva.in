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

// A joint account: the bank may give every holder ("RAVI SHARMA & PRIYA
// SHARMA", "RAVI SHARMA / PRIYA SHARMA", "RAVI SHARMA JT PRIYA SHARMA").
// The PAN holder must be one of them; any one matching is enough.
const JOINT = /\s*(?:&|\/|,|;|\+|\band\b|\bjt\.?\b|\bjoint\b|\bw\/o\b|\bor\b)\s*/i;
function holderNames(name) {
  return String(name || '').split(JOINT).map(x => x.trim()).filter(x => nameTokens(x).length);
}
const looksJoint = (name) => holderNames(name).length > 1;
// The best match of the PAN name against any holder of the account.
function holderMatch(panName, accountName) {
  const order = { match: 2, partial: 1, mismatch: 0 };
  let best = { result: 'mismatch', score: 0, holder: null };
  // The whole name first (a business: "ABC & SONS PVT LTD"), then each holder.
  for (const h of [accountName].concat(holderNames(accountName))) {
    const m = nameMatch(panName, h);
    if (order[m.result] > order[best.result] || (m.result === best.result && m.score > best.score)) best = { ...m, holder: h };
  }
  return best;
}

// ---- Whose account: a company or firm, a proprietor's business, or a person ----
// A company, LLP or partnership firm is paid only against its own PAN (4th
// letter C for a company, F for a firm or LLP, or another non-personal
// letter). A sole proprietorship has no PAN of its own — by law it uses the
// owner's personal PAN — so a trading name on a personal PAN goes to an admin.
const COMPANY_WORDS = /\b(PRIVATE|LIMITED|LLP|INCORPORATED|CORPORATION|COMPANY|PARTNERS|PARTNERSHIP|PLC|LLC|OPC)\b/;
const TRADE_WORDS = /\b(ENTERPRISES?|TRADERS?|TRADING|AGENC(Y|IES)|STORES?|HOSPITALITY|HOTELS?|RESORTS?|STAYS?|HOMESTAYS?|VILLAS?|PROPERTIES|REALTY|VENTURES?|SOLUTIONS|SERVICES|ASSOCIATES|INDUSTRIES|GROUP|HOLIDAYS?|TOURS?|TRAVELS?|INTERNATIONAL|GLOBAL|EXPORTS?|IMPEX)\b/;
function accountKind(name) {
  const t = nameTokens(name).join(' ');
  if (COMPANY_WORDS.test(t)) return 'company';
  if (TRADE_WORDS.test(t)) return 'trade';
  return 'person';
}
const PERSONAL_PAN = new Set(['P', 'H']);          // a person, a HUF
const panLetter = (pan) => { const p = String(pan || '').trim().toUpperCase(); return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p) ? p[3] : null; };
// A company or firm account against a personal PAN: refused, with this message. Else null.
function companyPanProblem(pan, accountName) {
  if (accountKind(accountName) === 'company' && PERSONAL_PAN.has(panLetter(pan))) {
    return 'This is a company, LLP or firm account. Payouts to it need the business’s own PAN (4th letter C for a company, F for a firm or LLP). Add the business PAN, or use an account the PAN holder holds personally.';
  }
  return null;
}

// ---- GSTIN: a proprietor's trade-name account ----
// A GSTIN is 15 characters: state code (2), the holder's PAN (10), entity
// number, 'Z', and a check character worked out from the first 14. Its
// characters 3–12 being the payee's own PAN shows the business is registered
// under that PAN, i.e. the payee's own proprietorship.
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]);
    if (v < 0) return null;
    const prod = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}
function cleanGstin(g) { return String(g || '').replace(/\s+/g, '').toUpperCase(); }
function validGstin(g) {
  const x = cleanGstin(g);
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(x) && gstinCheckChar(x.slice(0, 14)) === x[14];
}
const gstinPan = (g) => cleanGstin(g).slice(2, 12);
// For a trade-name account on a personal PAN: null if the GSTIN shows the
// business is the payee's own, else the message to show.
const TRADE_NEEDS = 'This account is in a business name. Payouts to it need the business’s GSTIN, registered under your own PAN. Otherwise, use your personal bank account, in the name on your personal PAN.';
function tradeGstinProblem(pan, gstin) {
  if (!gstin) return TRADE_NEEDS;
  if (!validGstin(gstin)) return 'That GSTIN is not valid — check it against your GST registration certificate (15 characters, like 27ABCPS1234K1Z5).';
  if (gstinPan(gstin) !== String(pan || '').trim().toUpperCase()) return 'That GSTIN is registered under a different PAN. The business must be registered under your own PAN, or use your personal bank account.';
  return null;
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
    return { kind, key: h.id, name: h.name, email: h.email, pan: decryptField(h.pan_number), gstin: h.j.bank_gstin ? decryptField(h.j.bank_gstin) : null, panName: h.j.pan_name || null, holder: h.bank_account_holder_name,
             account: decryptField(h.bank_account_number), ifsc: h.bank_ifsc, status: h.bank_status, checkId: h.j.bank_check_id || null, checkStatus: h.j.bank_check_status || null, changedAt: h.j.bank_changed_at || null };
  }
  const c = (await sql`SELECT p.guest_id, p.pan_number, p.gstin, p.account_holder_name, p.bank_account_number, p.bank_ifsc, p.status, g.name, g.email, to_jsonb(p) AS j
                       FROM cohost_payout_profiles p JOIN guests g ON g.id = p.guest_id WHERE p.guest_id = ${key}`)[0];
  if (!c) return null;
  return { kind, key: c.guest_id, name: c.name, email: c.email, pan: decryptField(c.pan_number), gstin: c.gstin ? decryptField(c.gstin) : null, panName: c.j.pan_name || null, holder: c.account_holder_name,
           account: decryptField(c.bank_account_number), ifsc: c.bank_ifsc, status: c.status, checkId: c.j.bank_check_id || null, checkStatus: c.j.bank_check_status || null, changedAt: c.j.bank_changed_at || null };
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

// Payout details were just changed — a new bank account (what: 'bank') or
// a new PAN (what: 'pan'). The owner is told clearly what changed, that
// payouts are on hold and why, and the bank account is checked again from
// scratch against the name on the PAN. Never throws: the change is saved
// either way.
const fmtWhen = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
async function payoutDetailsChanged(sql, kind, key, what = 'bank') {
  try {
    const p = await loadPayee(sql, kind, key);
    if (!p) return { status: 'missing' };
    const last4 = String(p.account || '').slice(-4);
    const until = fmtWhen(Date.now() + HOLD_HOURS_AFTER_CHANGE * 3600e3);
    const where = kind === 'host' ? 'https://aerva.in/host-dashboard.html?openProfile=1&profileTab=verification' : 'https://aerva.in/index.html?view=cohost';
    const changed = what === 'pan'
      ? `The PAN on your Aerva account was changed${p.panName ? ` to one in the name <strong>${esc(p.panName)}</strong>` : ''}.`
      : `The bank account for your Aerva payouts was changed to the account ending <strong>${esc(last4)}</strong> (${esc(p.ifsc)}), in the name ${esc(p.holder)}.`;
    await sendMail(p.email, what === 'pan' ? 'Your PAN was changed — payouts on hold' : 'Your payout bank account was changed — payouts on hold',
      `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">${what === 'pan' ? 'Your PAN was changed' : 'Your payout bank account was changed'}</h2>
       <p>${changed}</p>
       <p><strong>Your payouts are on hold</strong> while Aerva checks your details again:</p>
       <ul>
         ${p.account ? '<li>your bank confirms the account is held by the person (or business) on your PAN — Aerva sends ₹1 to it to ask;</li>' : '<li>add a bank account in the name on your PAN — payouts cannot be sent without one;</li>'}
         ${what === 'pan' ? '<li>Aerva reviews your new PAN;</li>' : ''}
         <li>and, for your security, at least until ${esc(until)}.</li>
       </ul>
       <p>Nothing is lost: payouts that fall due meanwhile are sent once the checks are done. You will get an email when they are, or if anything is needed from you.</p>
       <p style="margin:20px 0;"><a href="${where}" style="background:#1c1a17; color:#f4eadc; padding:12px 22px; text-decoration:none; display:inline-block;">See your payout details</a></p>
       <p><strong>Did not make this change?</strong> Reply to this email or write to hello@aerva.in straight away.</p>`);
    if (!p.account || !p.ifsc) return { status: 'missing' };
    return await startCheck(sql, kind, key);
  } catch (err) {
    console.error('payout details check not started:', err.message);
    return { status: 'error' };
  }
}
const bankDetailsChanged = (sql, kind, key) => payoutDetailsChanged(sql, kind, key, 'bank');

// ---- What the payee must do, or is waiting for (bell, dashboard banner) ----
// kind 'action': the payee has to do something; 'info': Aerva is checking.
// The id carries the state, so a new state shows as a new notification.
function payoutItems(row, { who = 'host' } = {}) {
  const items = [];
  if (!row) return items;
  const href = who === 'host' ? 'host-dashboard.html?openProfile=1&profileTab=verification' : 'index.html?view=cohost';
  const holdUntil = row.bank_changed_at && inChangeHold(row.bank_changed_at)
    ? new Date(new Date(row.bank_changed_at).getTime() + HOLD_HOURS_AFTER_CHANGE * 3600e3) : null;
  const add = (state, kind, title, body) => items.push({ id: `payout-details:${who}:${state}:${row.bank_checked_at || row.bank_changed_at || ''}`, kind, title, body, href });
  if (who === 'host') {
    if (row.pan_status === 'rejected') add('pan-rejected', 'action', 'Action needed: your PAN was not approved', row.pan_rejection_reason || 'Write to hello@aerva.in to submit it again.');
    else if (!row.pan_status || row.pan_status === 'not_submitted') add('pan-missing', 'action', 'Action needed: add your PAN', 'Payouts carry 5% TDS without a PAN, 0.1% with one. Add it in your payout details.');
    else if (row.pan_number && !row.pan_name) add('pan-name', 'action', 'Action needed: add the name on your PAN', 'Your bank account is checked against it before payouts.');
    if (row.bank_status === 'rejected') add('bank-rejected', 'action', 'Action needed: update your bank account', (row.bank_rejection_reason || 'Your bank account could not be verified.') + ' Payouts are on hold until a bank account is verified.');
    else if (!row.bank_status || row.bank_status === 'not_submitted' || !row.bank_account_number) add('bank-missing', 'action', 'Action needed: add your bank account', 'Payouts are on hold until you add a bank account in the name on your PAN.');
    else if (row.bank_status === 'pending_review' || row.pan_status === 'pending_review') add('checking', 'info', 'Your payout details are being checked',
      `Payouts are on hold until the check is done${holdUntil ? `, and at least until ${fmtWhen(holdUntil)}` : ''}. Nothing needed from you unless we ask.`);
    else if (holdUntil) add('hold', 'info', `Payouts resume on ${fmtWhen(holdUntil)}`, 'Your payout details changed recently, so payouts wait 48 hours for your security.');
  } else {
    if (row.status === 'rejected') add('rejected', 'action', 'Action needed: update your payout details', (row.rejection_reason || 'Your payout details could not be verified.') + ' Your shares are on hold until they are approved.');
    else if (row.status === 'pending_review') add('checking', 'info', 'Your payout details are being checked',
      `Your shares are on hold until the check is done${holdUntil ? `, and at least until ${fmtWhen(holdUntil)}` : ''}.`);
    else if (holdUntil) add('hold', 'info', `Payouts resume on ${fmtWhen(holdUntil)}`, 'Your payout details changed recently, so payouts wait 48 hours for your security.');
  }
  return items;
}
// The bell's items for one account: as a host, and as a co-host.
async function payoutNotifications(sql, { hostId = null, guestId = null } = {}) {
  const out = [];
  try {
    if (hostId) {
      const hasListing = (await sql`SELECT 1 FROM listings WHERE host_id = ${hostId} AND status IN ('approved', 'blocked') LIMIT 1`).length;
      if (hasListing) {
        const h = (await sql`SELECT pan_status, pan_rejection_reason, pan_number, bank_status, bank_rejection_reason, bank_account_number,
                                    to_jsonb(hosts)->>'pan_name' AS pan_name, to_jsonb(hosts)->>'bank_changed_at' AS bank_changed_at,
                                    to_jsonb(hosts)->>'bank_checked_at' AS bank_checked_at
                             FROM hosts WHERE id = ${hostId}`)[0];
        payoutItems(h, { who: 'host' }).forEach(i => out.push(i));
      }
    }
    if (guestId) {
      const c = (await sql`SELECT status, rejection_reason, to_jsonb(p)->>'bank_changed_at' AS bank_changed_at, to_jsonb(p)->>'bank_checked_at' AS bank_checked_at
                           FROM cohost_payout_profiles p WHERE guest_id = ${guestId}`)[0];
      payoutItems(c, { who: 'cohost' }).forEach(i => out.push(i));
    }
  } catch (err) { /* tables or columns not there yet */ }
  return out;
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
  // Any holder of a joint account may be the PAN holder.
  const m = against && registered ? holderMatch(against, registered) : { result: 'partial', score: null };
  await saveCheck(sql, kind, key, { status: 'active', registeredName: registered, match: m.result });
  let decision = 'review', why = null;
  const companyProblem = companyPanProblem(p.pan, registered);
  if (companyProblem) { decision = 'reject'; why = companyProblem; }
  else if (against && m.result === 'match') decision = 'approve';
  // A trading name on a personal PAN (a sole proprietor): accepted only with
  // the business's GSTIN, registered under the payee's own PAN.
  else if (accountKind(registered) === 'trade' && PERSONAL_PAN.has(panLetter(p.pan))) {
    const gp = tradeGstinProblem(p.pan, p.gstin);
    if (gp) { decision = 'reject'; why = `${registered ? `The bank holds this account as “${registered}”. ` : ''}${gp}`; }
    else decision = 'approve';
  }
  else if (against && m.result === 'mismatch') {
    // A joint account where the bank named only the first holder: the PAN
    // holder may be the second. An admin confirms with a passbook or statement.
    if (looksJoint(p.holder) && !looksJoint(registered)) decision = 'review';
    else {
      decision = 'reject';
      why = `This account is held in the name “${registered}”. Payouts can only go to an account the PAN holder (${against}) holds, alone or jointly. Add an account in that name.`;
    }
  }
  await settleStatus(sql, kind, key, decision, why);
  await logAudit(sql, { action: 'bank_check_completed', success: true, actorType: 'system', actorIdentifier: 'bank-check',
    targetType: kind === 'host' ? 'host' : 'guest', targetId: key, metadata: { match: m.result, score: m.score, decision } });
  if (decision !== 'review') await tellResult(p, decision, why);
  return { status: 'active', match: m.result, decision };
}

async function tellResult(p, decision, why) {
  if (decision === 'approve') {
    const holdUntil = p.changedAt && inChangeHold(p.changedAt) ? fmtWhen(new Date(p.changedAt).getTime() + HOLD_HOURS_AFTER_CHANGE * 3600e3) : null;
    await sendMail(p.email, 'Your bank account is verified', `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">Your bank account is verified</h2>
      <p>Your bank confirmed the account ending ${esc(String(p.account || '').slice(-4))} is held by the person (or business) on your PAN. Payouts will go to it${holdUntil ? `, from ${esc(holdUntil)} (48 hours after the change, for your security)` : ''}.</p>`);
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
  nameTokens, nameMatch, holderMatch, accountKind, companyPanProblem, validGstin, gstinPan, tradeGstinProblem, PERSONAL_PAN, panLetter, holderNames, looksJoint, panNameProblem, panInUseElsewhere,
  bankDetailsChanged, payoutDetailsChanged, payoutItems, payoutNotifications, startCheck, settleCheck, pollChecks, inChangeHold, describeCheck, HOLD_HOURS_AFTER_CHANGE
};
