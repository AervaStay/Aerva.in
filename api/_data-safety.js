// The Aerva mark on every email (api/_email-shell.js, owner 14 Nov 2026):
// requiring it brands everything this process sends.
require('./_email-shell');
// /api/_data-safety.js — Admin → Data safety. Not an endpoint
// (get-pending-listings.js). Owner's rules (9 Nov 2026):
//   • Only the SUPER ADMIN sees or uses any of this — other admins,
//     reviewers and representatives get nothing (not even the tab).
//     Super admin = a signed-in admin whose email is in SUPER_ADMIN_EMAILS
//     (Vercel; default hello@aerva.in). The shared admin secret never is.
//   • Every destructive step needs a one-time PIN emailed to the OWNER
//     (OWNER_EMAIL, default aervastudios@gmail.com) with a clear warning of
//     exactly what will happen; the PIN works only for that exact request,
//     for 10 minutes, 5 tries.
//   • A copy of the data is always kept, so it can be recovered without
//     loss: a Neon backup branch every day, before every clear and before
//     every restore (the state being replaced is kept too).
//   • Two clears: "Dummy data only" and "From the beginning". Going live
//     switches "From the beginning" off for good.
//
// Backups are Neon branches (copy-on-write, instant, the whole database):
//   NEON_API_KEY, NEON_PROJECT_ID, NEON_BRANCH_ID (PROD's branch);
//   on UAT, UAT_NEON_BRANCH_ID only — never PROD's branch.
// Kept: the newest BACKUP_KEEP (default 5) — mind Neon's branch limit.

const crypto = require('crypto');
const { IS_UAT, ENV } = require('./_env');

const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });
const PIN_KEY = 'data_safety_pin';
const LIVE_KEY = 'aerva_live';
const PIN_MINUTES = 10, PIN_TRIES = 5;
const NEON = 'https://console.neon.tech/api/v2';
const ACTIONS = {
  clear_dummy: 'Clear dummy data only',
  clear_all: 'Clear everything — from the beginning',
  restore: 'Restore the database from a backup',
  go_live: 'Go live — delete everything from before today (data, logs and old backups) and switch clearing off for good'
};
const CONFIRM_WORDS = { clear_dummy: 'DELETE TEST DATA', clear_all: 'DELETE EVERYTHING', restore: 'RESTORE', go_live: 'GO LIVE' };

const ownerEmail = () => String(process.env.OWNER_EMAIL || 'aervastudios@gmail.com').trim();
const superEmails = () => String(process.env.SUPER_ADMIN_EMAILS || 'hello@aerva.in').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const mask = (e) => String(e || '').replace(/^(.)(.*)(.@.*)$/, (m, a, b, c) => a + '•'.repeat(Math.min(6, b.length)) + c);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const secret = () => process.env.APPROVAL_TOKEN_SECRET || process.env.ADMIN_SECRET || 'aerva';
const digest = (s) => crypto.createHmac('sha256', secret()).update(String(s)).digest('hex');

// A signed-in admin (never the shared secret) on the super admin list.
function isSuperAdmin(adminAudit) {
  return !!(adminAudit && adminAudit.adminId && superEmails().includes(String(adminAudit.actorIdentifier || '').toLowerCase()));
}

// ---------------------------------------------------------------- go live
async function liveSince(sql) {
  try { const r = await sql`SELECT value FROM site_settings WHERE key = ${LIVE_KEY}`; return r[0] ? r[0].value : null; }
  catch (e) { return null; }
}
async function goLive(sql, by) {
  const v = { at: new Date().toISOString(), by };
  await sql`INSERT INTO site_settings (key, value, updated_at) VALUES (${LIVE_KEY}, ${JSON.stringify(v)}::jsonb, now())
            ON CONFLICT (key) DO NOTHING`;
  return liveSince(sql);
}

// ---------------------------------------------------------------- email
async function sendOwner(subject, html) {
  if (!process.env.RESEND_API_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to: ownerEmail(), subject,
        html: `<div style="font-family:sans-serif; max-width:560px; color:#1c1a17; line-height:1.5;">${html}</div>` }) });
    return r.ok;
  } catch (e) { return false; }
}

// ---------------------------------------------------------------- PIN
// The request is fingerprinted (action + exactly what it covers), so a PIN
// sent for "clear dummy data keeping these 4 listings" cannot be used for
// anything else.
const fingerprint = (action, details) => digest(action + '|' + JSON.stringify(details || {}));

async function requestPin(sql, { action, details, summaryHtml, adminLabel, ip }) {
  if (!ACTIONS[action]) throw userError('Unknown action.');
  const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const rec = { pinHash: digest('pin|' + pin), action, fp: fingerprint(action, details), expiresAt: Date.now() + PIN_MINUTES * 60000, tries: 0, by: adminLabel };
  await sql`INSERT INTO site_settings (key, value, updated_at) VALUES (${PIN_KEY}, ${JSON.stringify(rec)}::jsonb, now())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const sent = await sendOwner(`⚠ Aerva ${ENV.toUpperCase()}: PIN to ${ACTIONS[action].toLowerCase()}`, `
    <p style="background:#fbecea; border-left:4px solid #a3402f; padding:10px 12px; margin:0 0 14px;"><b>Warning — this cannot be undone in Aerva.</b><br>
    Someone signed in to Aerva Admin (${ENV.toUpperCase()}) asked to: <b>${esc(ACTIONS[action])}</b>.</p>
    <p><b>Asked by:</b> ${esc(adminLabel)}<br><b>When:</b> ${esc(when)} (India time)${ip ? `<br><b>From:</b> ${esc(ip)}` : ''}</p>
    ${summaryHtml || ''}
    <p>Only if this was you, enter this PIN in Admin → Data safety:</p>
    <p style="font-size:30px; letter-spacing:6px; font-weight:bold; margin:6px 0 14px;">${pin}</p>
    <p style="color:#5b554c; font-size:13px;">It works once, for this exact request only, for ${PIN_MINUTES} minutes. A copy of the database is taken automatically before anything is deleted or replaced.<br>
    <b>If this was not you, do not share this PIN</b> — sign out every admin (Admin → Team → Sign out everywhere) and change the admin passwords.</p>`);
  if (!sent) throw userError(`The PIN email could not be sent to the owner (${mask(ownerEmail())}). Nothing was done.`, 503);
  return { sentTo: mask(ownerEmail()), minutes: PIN_MINUTES };
}

async function checkPin(sql, { action, details, pin }) {
  const r = await sql`SELECT value FROM site_settings WHERE key = ${PIN_KEY}`;
  const rec = r[0] && r[0].value;
  if (!rec || rec.action !== action) throw userError('Ask for a PIN first.', 400);
  if (Date.now() > Number(rec.expiresAt)) { await sql`DELETE FROM site_settings WHERE key = ${PIN_KEY}`; throw userError('That PIN has expired. Ask for a new one.', 400); }
  if (rec.fp !== fingerprint(action, details)) throw userError('The selection changed after the PIN was sent. Ask for a new PIN for what is selected now.', 400);
  if (Number(rec.tries) >= PIN_TRIES) { await sql`DELETE FROM site_settings WHERE key = ${PIN_KEY}`; throw userError('Too many wrong PINs. Ask for a new one.', 429); }
  const ok = /^\d{6}$/.test(String(pin || '').trim()) &&
    crypto.timingSafeEqual(Buffer.from(digest('pin|' + String(pin).trim())), Buffer.from(String(rec.pinHash)));
  if (!ok) {
    rec.tries = Number(rec.tries) + 1;
    await sql`UPDATE site_settings SET value = ${JSON.stringify(rec)}::jsonb, updated_at = now() WHERE key = ${PIN_KEY}`;
    throw userError(`Wrong PIN (${PIN_TRIES - rec.tries} ${PIN_TRIES - rec.tries === 1 ? 'try' : 'tries'} left).`, 400);
  }
  await sql`DELETE FROM site_settings WHERE key = ${PIN_KEY}`;      // used once
  return true;
}

// ---------------------------------------------------------------- backups (Neon branches)
function neonCfg() {
  const key = process.env.NEON_API_KEY, project = process.env.NEON_PROJECT_ID;
  const branch = IS_UAT ? process.env.UAT_NEON_BRANCH_ID : process.env.NEON_BRANCH_ID;
  return { ok: !!(key && project && branch), key, project, branch, keep: Math.max(2, Math.min(20, Number(process.env.BACKUP_KEEP) || 5)),
    prefix: `aerva-backup-${IS_UAT ? 'uat' : 'prod'}-` };
}
async function neon(method, path, body) {
  const c = neonCfg();
  const r = await fetch(NEON + path, { method, headers: { Authorization: `Bearer ${c.key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Neon ${r.status}: ${String((j && j.message) || '').slice(0, 200)}`), { neonStatus: r.status });
  return j;
}
async function listBackups() {
  const c = neonCfg();
  if (!c.ok) return { configured: false, backups: [] };
  const j = await neon('GET', `/projects/${c.project}/branches`);
  const backups = (j.branches || []).filter(b => String(b.name || '').startsWith(c.prefix))
    .map(b => ({ id: b.id, name: b.name, createdAt: b.created_at, sizeBytes: b.logical_size || null, parentId: b.parent_id }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { configured: true, keep: c.keep, backups };
}
const stamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace(/[-:]/g, '').replace(' ', '-').slice(0, 13);
async function createBackup(reason) {
  const c = neonCfg();
  if (!c.ok) throw userError('Backups are not set up: add NEON_API_KEY, NEON_PROJECT_ID and NEON_BRANCH_ID in Vercel (UAT: UAT_NEON_BRANCH_ID).', 503);
  const name = c.prefix + stamp() + '-' + String(reason || 'manual').replace(/[^a-z0-9-]/gi, '').slice(0, 24).toLowerCase();
  const j = await neon('POST', `/projects/${c.project}/branches`, { branch: { parent_id: c.branch, name } });
  const made = { id: j.branch && j.branch.id, name };
  const pruned = await prune(made.id).catch(e => { console.error('backup prune failed:', e.message); return []; });
  return { backup: made, pruned };
}
// Only our own backup branches, oldest first, beyond the newest `keep`.
async function prune(justMade) {
  const c = neonCfg();
  const { backups } = await listBackups();
  const extra = backups.filter(b => b.id !== justMade).slice(c.keep - 1);
  const gone = [];
  for (const b of extra) {
    if (!String(b.name).startsWith(c.prefix)) continue;
    await neon('DELETE', `/projects/${c.project}/branches/${b.id}`);
    gone.push(b.name);
  }
  return gone;
}
// Replaces the live data with a backup; the data being replaced is kept
// as its own backup branch (nothing lost).
async function restore(backupId) {
  const c = neonCfg();
  if (!c.ok) throw userError('Backups are not set up.', 503);
  const { backups } = await listBackups();
  const b = backups.find(x => x.id === backupId);
  if (!b) throw userError('That backup is not in the list any more.', 404);
  const keptAs = c.prefix + stamp() + '-before-restore';
  try {
    await neon('POST', `/projects/${c.project}/branches/${c.branch}/restore`, { source_branch_id: b.id, preserve_under_name: keptAs });
  } catch (e) {
    throw userError(`Neon did not restore it (${e.message}). Nothing changed. You can also restore in the Neon console: Branches → ${c.branch} → Restore → from branch ${b.name}.`, 502);
  }
  return { restoredFrom: b.name, previousDataKeptAs: keptAs };
}

// Going live (owner, 9 Nov 2026): every backup from before launch is
// deleted too — only our own prefixed branches, never main or uat.
async function deleteAllBackups() {
  const c = neonCfg();
  if (!c.ok) return [];
  const { backups } = await listBackups();
  const gone = [];
  for (const b of backups) {
    if (!String(b.name).startsWith(c.prefix)) continue;
    await neon('DELETE', `/projects/${c.project}/branches/${b.id}`);
    gone.push(b.name);
  }
  return gone;
}

// Daily job (get-listings JOBS): a backup every day; quiet when not set up.
async function dailyBackup() {
  if (!neonCfg().ok) return { skipped: 'Neon backups not set up (NEON_API_KEY, NEON_PROJECT_ID, NEON_BRANCH_ID)' };
  const out = await createBackup('daily');
  return { backup: out.backup.name, pruned: out.pruned.length };
}

module.exports = { isSuperAdmin, ACTIONS, CONFIRM_WORDS, requestPin, checkPin, fingerprint, liveSince, goLive, sendOwner,
  listBackups, createBackup, deleteAllBackups, restore, dailyBackup, neonCfg, ownerEmail, mask, esc };
