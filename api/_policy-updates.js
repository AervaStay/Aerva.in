// The Aerva mark on every email (api/_email-shell.js, owner 14 Nov 2026):
// requiring it brands everything this process sends.
require('./_email-shell');
// /api/_policy-updates.js — telling people about material changes to
// Aerva's agreements and policies (owner, 9 Nov 2026). Not an endpoint.
//
// What other platforms do, and Aerva follows:
//   • rewording / corrections that do not change the meaning: the text and
//     its "last updated" date change; nobody is emailed;
//   • a material change: everyone affected is told at least 30 days before
//     it takes effect, by email and a banner, with a short summary;
//     continuing to use Aerva after that date is acceptance;
//   • a click-to-accept only where the law or the change requires it
//     (the Host Agreement's 'accept' revisions, _host-agreement.js).
//
// The changes are listed in aerva-policies.js (AERVA_POLICIES.updates) —
// the same file the site shows, so the banner, the email and the policy
// pages never disagree. This file emails each account once per update
// (policy_update_sends, migrations/2026-11-09-01-policy-update-sends.sql).
// The banners are drawn by the pages themselves from the same list.

const { helpLine } = require('./_help-link');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SITE = 'https://aerva.in';
const MIN_NOTICE_DAYS = 30;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });   // YYYY-MM-DD, India
const day = (d) => new Date(d + 'T00:00:00+05:30').toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });
const ymd = /^\d{4}-\d{2}-\d{2}$/;

let cached = null;
function loadUpdates() {
  if (cached) return cached;
  const tries = [path.join(process.cwd(), 'aerva-policies.js'), path.join(__dirname, '..', 'aerva-policies.js')];
  const file = tries.find(f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
  let list = [];
  if (file) {
    try {
      const box = { window: {} };
      vm.runInNewContext(fs.readFileSync(file, 'utf8'), box, { timeout: 1000 });
      list = ((box.window.AERVA_POLICIES || {}).updates || []);
    } catch (e) { console.error('policy updates could not be read:', e.message); }
  }
  cached = list.filter(u => u && u.id && ymd.test(u.published) && ymd.test(u.effective) && ['guests', 'hosts', 'all'].includes(u.audience)
    && Array.isArray(u.summary) && u.summary.length).map(u => {
      const gap = (new Date(u.effective) - new Date(u.published)) / 86400e3;
      if (gap < MIN_NOTICE_DAYS) console.error(`policy update ${u.id}: only ${gap} days' notice (at least ${MIN_NOTICE_DAYS})`);
      return u;
    });
  return cached;
}

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html }) });
    return r.ok;
  } catch (e) { return false; }
}

function emailHtml(u, name) {
  return `<div style="font-family:sans-serif; max-width:620px; color:#1c1a17; line-height:1.6;">
    <p style="font-size:12px; letter-spacing:0.14em; color:#8a6c39;">AERVA</p>
    <p>Dear ${esc(name || (u.audience === 'hosts' ? 'Host' : 'Guest'))},</p>
    <p>We are updating ${u.audience === 'hosts' ? 'the terms you host under' : 'Aerva’s terms and policies'}: <strong>${esc(u.title)}</strong>. The changes take effect on <strong>${esc(day(u.effective))}</strong>.</p>
    <p><strong>What is changing</strong></p>
    <ul>${u.summary.map(p => `<li style="margin:3px 0;">${esc(p)}</li>`).join('')}</ul>
    <p>There is nothing you need to do. Continuing to use Aerva after ${esc(day(u.effective))} means you accept the updated terms.${u.audience === 'hosts' ? ' If you do not accept them, you may deactivate your listings before then.' : ''}</p>
    <p><a href="${SITE}/index.html?view=policies" style="background:#1c1a17; color:#f4eadc; padding:11px 20px; text-decoration:none; display:inline-block;">Read the policies</a></p>
    <p style="font-size:13px; color:#6e675d;">${helpLine({}, 'Questions?')}</p></div>`;
}

// Job 'policy_update_notices': each update, from its publish date until it
// takes effect, is emailed once to every account in its audience (50 per
// run). Deleted accounts are skipped.
async function runPolicyUpdateNotices(sql, { deadlineMs = 5000 } = {}) {
  const started = Date.now();
  const out = { sent: 0, updates: 0 };
  const now = today();
  const due = loadUpdates().filter(u => u.published <= now && now <= u.effective);
  out.updates = due.length;
  for (const u of due) {
    let rows;
    try {
      rows = await sql`SELECT g.id, g.email, COALESCE(g.first_name, g.name) AS name FROM guests g
                       WHERE g.email IS NOT NULL AND g.deleted_at IS NULL
                         AND (${u.audience} <> 'hosts' OR g.host_id IS NOT NULL)
                         AND NOT EXISTS (SELECT 1 FROM policy_update_sends s WHERE s.update_id = ${u.id} AND s.guest_id = g.id)
                       ORDER BY g.id LIMIT 50`;
    } catch (e) { return Object.assign(out, { skipped: e.code === '42P01' || e.code === '42703' ? 'database update not applied' : e.message }); }
    for (const g of rows) {
      if (Date.now() - started > deadlineMs) return out;
      const claimed = await sql`INSERT INTO policy_update_sends (update_id, guest_id) VALUES (${u.id}, ${g.id}) ON CONFLICT DO NOTHING RETURNING guest_id`;
      if (!claimed.length) continue;
      const ok = await sendEmail(g.email, `Update to Aerva’s terms: ${u.title}`, emailHtml(u, g.name));
      await sql`UPDATE policy_update_sends SET emailed = ${ok} WHERE update_id = ${u.id} AND guest_id = ${g.id}`;
      out.sent++;
    }
  }
  return out;
}

module.exports = { loadUpdates, runPolicyUpdateNotices, emailHtml, MIN_NOTICE_DAYS };
