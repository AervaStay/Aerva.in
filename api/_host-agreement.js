// /api/_host-agreement.js — the Aerva Host Agreement on the server. Not an
// endpoint.
//
// The wording lives in aerva-policies.js (agreements.host), the same file
// the site shows, so the copy emailed to a host is word for word what they
// accepted. Each published version is kept in host_agreement_versions, and
// every acceptance, decline or termination in host_agreement_acceptances
// (one row per listing, or per host for a revision) — nothing is deleted.
//
//   • Every listing submitted for review accepts the current version
//     (submit-listing.js), saved on the listing and on the host.
//   • When the version changes (a revision: wording, commission, fees),
//     every host with listings is emailed a formal notice (job
//     'host_agreement_notices'), and accepts or declines it in the
//     dashboard (host-listings.js).
//   • Declining, or not accepting within NOTICE_DAYS of the notice, ends
//     the agreement: the host's live listings are deactivated
//     (deactivated_by = 'agreement'), confirmed bookings go ahead and
//     payouts are paid as usual. Accepting later restores them.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { HOST_AGREEMENT_VERSION } = require('./_agreements');

const NOTICE_DAYS = 30;
const SITE = 'https://aerva.in';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let cached = null;
function loadAgreement() {
  if (cached) return cached;
  const tries = [path.join(process.cwd(), 'aerva-policies.js'), path.join(__dirname, '..', 'aerva-policies.js')];
  const file = tries.find(f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
  let host = null, version = null;
  if (file) {
    try {
      const box = { window: {} };
      vm.runInNewContext(fs.readFileSync(file, 'utf8'), box, { timeout: 1000 });
      const A = (box.window.AERVA_POLICIES || {}).agreements || {};
      host = A.host || null; version = A.hostVersion || null;
    } catch (e) { console.error('host agreement text could not be read:', e.message); }
  }
  if (version && version !== HOST_AGREEMENT_VERSION) console.error(`aerva-policies.js hostVersion ${version} does not match HOST_AGREEMENT_VERSION ${HOST_AGREEMENT_VERSION}`);
  cached = host && host.clauses ? { version: HOST_AGREEMENT_VERSION, title: host.title, intro: host.intro || '', clauses: host.clauses, accept: host.accept || '' } : null;
  return cached;
}

function agreementHtml(a, { name = '', listings = [], acceptedAt = null } = {}) {
  if (!a) return '';
  const when = acceptedAt ? new Date(acceptedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' (India time)' : '';
  return `<div style="font-family:Georgia,serif; max-width:640px; color:#1c1a17; line-height:1.6;">
    <p style="font-size:12px; letter-spacing:0.14em; color:#8a6c39; margin:0;">AERVA</p>
    <h1 style="font-weight:500; font-size:24px; margin:6px 0 2px;">${esc(a.title)}</h1>
    <p style="font-family:sans-serif; font-size:13px; color:#6e675d; margin:0 0 16px;">Version ${esc(a.version)}${when ? ' · Accepted ' + esc(when) : ''}${name ? ' · ' + esc(name) : ''}${listings.length ? '<br>For: ' + listings.map(esc).join(', ') : ''}</p>
    <p style="font-family:sans-serif; font-size:14px;">${esc(a.intro)}</p>
    ${a.clauses.map(c => `<h3 style="font-family:sans-serif; font-size:14.5px; margin:18px 0 4px;">${esc(c.title)}</h3>
      <ul style="font-family:sans-serif; font-size:14px; margin:0; padding-left:20px;">${c.points.map(p => `<li style="margin:3px 0;">${esc(p)}</li>`).join('')}</ul>`).join('')}
    <p style="font-family:sans-serif; font-size:13px; color:#6e675d; margin-top:22px;">Keep this email for your records. Every agreement you have accepted is also in your dashboard under Account → Host Agreement. Questions: hello@aerva.in</p>
  </div>`;
}

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html })
    });
    return r.ok;
  } catch (e) { return false; }
}

// Keeps the published text of the current version (once).
async function saveVersion(sql, a) {
  try {
    await sql`INSERT INTO host_agreement_versions (version, title, content) VALUES (${a.version}, ${a.title}, ${JSON.stringify({ intro: a.intro, clauses: a.clauses, accept: a.accept })}::jsonb)
              ON CONFLICT (version) DO NOTHING`;
  } catch (e) { /* table not created yet */ }
}

// Records an acceptance of the current version for a host (and listings),
// emails the host a copy. listings: [{ id, name }] (may be empty).
async function recordAcceptance(sql, { hostId, guestId = null, email = null, name = '', listings = [], ip = null, via = 'listing_submission' }) {
  const a = loadAgreement();
  const version = HOST_AGREEMENT_VERSION;
  try { await sql`UPDATE hosts SET host_agreement_version = ${version}, host_agreement_accepted_at = now(), host_agreement_ip = ${ip} WHERE id = ${hostId}`; }
  catch (e) { console.error('host agreement could not be stored on the host:', e.message); }
  const ids = listings.map(l => Number(l.id)).filter(Boolean);
  if (ids.length) {
    try { await sql`UPDATE listings SET host_agreement_version = ${version}, host_agreement_accepted_at = now() WHERE id = ANY(${ids}) AND host_id = ${hostId}`; }
    catch (e) { /* database update not applied yet */ }
  }
  if (a) await saveVersion(sql, a);
  let emailed = false;
  if (a && email) emailed = await sendEmail(email, `Your copy of the ${a.title} (version ${version})`, agreementHtml(a, { name, listings: listings.map(l => l.name).filter(Boolean), acceptedAt: new Date() }));
  try {
    const rows = ids.length ? ids : [null];
    for (const lid of rows) {
      await sql`INSERT INTO host_agreement_acceptances (host_id, guest_id, listing_id, version, action, ip, via, emailed)
                VALUES (${hostId}, ${guestId}, ${lid}, ${version}, 'accepted', ${ip}, ${via}, ${emailed})`;
    }
  } catch (e) { /* database update not applied yet */ }
  return { version, emailed };
}

// Ends the agreement for a host: live listings deactivated (restorable by
// accepting the current version). Confirmed bookings and payouts carry on.
async function endAgreement(sql, hostId, { action = 'declined', guestId = null, ip = null, via = 'dashboard' } = {}) {
  const changed = await sql`UPDATE listings SET status = 'deactivated', deactivated_by = 'agreement', deactivated_at = now()
                            WHERE host_id = ${hostId} AND status = 'approved' RETURNING id`;
  try { await sql`UPDATE hosts SET host_agreement_declined_at = now() WHERE id = ${hostId}`; } catch (e) { /* not applied */ }
  try {
    await sql`INSERT INTO host_agreement_acceptances (host_id, guest_id, listing_id, version, action, ip, via, emailed)
              VALUES (${hostId}, ${guestId}, NULL, ${HOST_AGREEMENT_VERSION}, ${action}, ${ip}, ${via}, false)`;
  } catch (e) { /* not applied */ }
  return changed.map(r => r.id);
}

// Scheduler job: formal notice of a revised agreement to every host with
// listings who has not accepted the current version; and, NOTICE_DAYS
// after the notice, the agreement ends for those who still have not.
async function runAgreementNotices(sql, { deadlineMs = 5000 } = {}) {
  const started = Date.now();
  const out = { version: HOST_AGREEMENT_VERSION, noticed: 0, ended: 0 };
  // The text is included in the notice when this function can read it; the
  // notice goes out either way, with a link to read it on Aerva.
  const a = loadAgreement() || { version: HOST_AGREEMENT_VERSION, title: 'Aerva Host Agreement', intro: '', clauses: null };
  if (a.clauses) await saveVersion(sql, a);
  let due;
  try {
    due = await sql`
      SELECT h.id, h.name, g.email, g.id AS guest_id FROM hosts h
      JOIN LATERAL (SELECT id, email FROM guests WHERE host_id = h.id ORDER BY id LIMIT 1) g ON true
      WHERE COALESCE(h.host_agreement_version, '') <> ${HOST_AGREEMENT_VERSION}
        AND COALESCE(h.host_agreement_notice_version, '') <> ${HOST_AGREEMENT_VERSION}
        AND EXISTS (SELECT 1 FROM listings l WHERE l.host_id = h.id AND l.status IN ('approved', 'pending'))
      ORDER BY h.id LIMIT 50`;
  } catch (e) { return Object.assign(out, { skipped: e.code === '42703' || e.code === '42P01' ? 'database update not applied' : e.message }); }
  for (const h of due) {
    if (Date.now() - started > deadlineMs) break;
    const claimed = await sql`UPDATE hosts SET host_agreement_notice_version = ${HOST_AGREEMENT_VERSION}, host_agreement_notice_at = now()
                              WHERE id = ${h.id} AND COALESCE(host_agreement_notice_version, '') <> ${HOST_AGREEMENT_VERSION} RETURNING id`;
    if (!claimed.length) continue;
    const by = new Date(Date.now() + NOTICE_DAYS * 86400e3).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });
    const html = `<div style="font-family:sans-serif; max-width:640px; color:#1c1a17; line-height:1.6;">
      <p>Dear ${esc(h.name || 'Host')},</p>
      <p>Aerva has revised the <strong>${esc(a.title)}</strong> (version ${esc(a.version)}). The revised agreement, which may include changes to Aerva’s commission, fees or policies, is set out below and is in your dashboard.</p>
      <p><strong>Please review and accept it in your dashboard by ${esc(by)}.</strong> If it is declined, or not accepted by that date, your agreement with Aerva ends and your listings are deactivated. Confirmed bookings go ahead and amounts due to you are paid as usual.</p>
      <p><a href="${SITE}/host-dashboard.html" style="background:#1c1a17; color:#f4eadc; padding:11px 20px; text-decoration:none; display:inline-block;">Review and accept</a></p>
      <p>Read it in full: <a href="${SITE}/index.html?view=policies&doc=host-agreement">${SITE}/index.html?view=policies&amp;doc=host-agreement</a></p>
      ${a.clauses ? '<hr style="border:none; border-top:1px solid #ece4d8; margin:24px 0;">' + agreementHtml(a) : ''}
    </div>`;
    const ok = await sendEmail(h.email, `Important: revised ${a.title} — please review and accept`, html);
    try {
      await sql`INSERT INTO host_agreement_acceptances (host_id, guest_id, listing_id, version, action, ip, via, emailed)
                VALUES (${h.id}, ${h.guest_id}, NULL, ${HOST_AGREEMENT_VERSION}, 'notified', NULL, 'revision_notice', ${ok})`;
    } catch (e) { /* not applied */ }
    out.noticed++;
  }
  // Notice given, period over, still not accepted: the agreement ends.
  const lapsed = await sql`
    SELECT h.id FROM hosts h
    WHERE h.host_agreement_notice_version = ${HOST_AGREEMENT_VERSION} AND COALESCE(h.host_agreement_version, '') <> ${HOST_AGREEMENT_VERSION}
      AND h.host_agreement_notice_at < now() - make_interval(days => ${NOTICE_DAYS})
      AND EXISTS (SELECT 1 FROM listings l WHERE l.host_id = h.id AND l.status = 'approved')
    LIMIT 20`;
  for (const h of lapsed) {
    if (Date.now() - started > deadlineMs) break;
    await endAgreement(sql, h.id, { action: 'terminated', via: 'not_accepted_in_time' });
    out.ended++;
  }
  return out;
}

module.exports = { loadAgreement, agreementHtml, recordAcceptance, endAgreement, runAgreementNotices, NOTICE_DAYS, HOST_AGREEMENT_VERSION };
