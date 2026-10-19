// /api/_offers-email.js — "Come back to Aerva": one offers email a quarter
// to guests who are not booking. Not an endpoint.
//
// Who gets it (checked when it is sent):
//   • a guest account (not a host), with an email, not deleted, deactivated
//     or suspended;
//   • no booking made in the last 90 days, and no stay coming up;
//   • "Offers from Aerva by email" not switched off (Account Settings →
//     Privacy; the unsubscribe link in every email switches it off);
//   • not already sent one this calendar quarter (offer_email_sends,
//     one row per guest per quarter — the database refuses a second).
// When: the scheduler (get-listings.js JOBS 'offers_email') runs it daily
// at 11 am India time; each run sends a batch, so a quarter's emails go out
// over the first days of that quarter. In UAT, at most 3 a run (they all go
// to UAT_EMAIL_TO anyway, see _env.js). OFFERS_EMAIL=off in Vercel stops it.
//
// The email shows a few of Aerva's best live homes and a link to the site.

const crypto = require('crypto');
const { IS_UAT } = require('./_env');

const SITE = 'https://aerva.in';
const BATCH = () => (IS_UAT ? 3 : 150);
const LAPSED_DAYS = 90;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');

function quarterKey(d = new Date()) {
  const ist = new Date(d.getTime() + 5.5 * 3600e3);
  return ist.getUTCFullYear() + '-Q' + (Math.floor(ist.getUTCMonth() / 3) + 1);
}

// Unsubscribe link: signed with the app's secret, so it works without
// signing in and cannot be forged for someone else.
function unsubscribeToken(guestId) {
  const sig = crypto.createHmac('sha256', String(process.env.APPROVAL_TOKEN_SECRET || 'aerva')).update('offers-unsub:' + guestId).digest('base64url').slice(0, 24);
  return guestId + '.' + sig;
}
function readUnsubscribeToken(token) {
  const m = String(token || '').match(/^(\d+)\.([A-Za-z0-9_-]{24})$/);
  if (!m) return null;
  const want = unsubscribeToken(Number(m[1])).split('.')[1];
  const a = Buffer.from(m[2]), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? Number(m[1]) : null;
}
const unsubscribeLink = (guestId) => `https://aerva-in.vercel.app/api/get-listings?unsubscribeOffers=${encodeURIComponent(unsubscribeToken(guestId))}`;

async function optOut(sql, guestId) {
  const cur = (await sql`SELECT privacy_settings FROM guests WHERE id = ${guestId}`)[0];
  if (!cur) return false;
  const s = Object.assign({}, cur.privacy_settings && typeof cur.privacy_settings === 'object' ? cur.privacy_settings : {}, { offers_email: false });
  await sql`UPDATE guests SET privacy_settings = ${JSON.stringify(s)}::jsonb WHERE id = ${guestId}`;
  return true;
}

// A few homes worth coming back for: live stays with the most reviews, then newest.
async function featuredHomes(sql) {
  try {
    return await sql`
      SELECT l.id, l.property_name, l.city, l.area, l.nightly_rate, COALESCE(l.cover_photo_url, l.photo_urls->>0) AS photo
      FROM listings l
      WHERE l.status = 'approved' AND COALESCE(l.listing_type, 'stay') = 'stay'
      ORDER BY (SELECT count(*) FROM orders o WHERE o.listing_id = l.id AND o.status = 'paid') DESC, l.created_at DESC
      LIMIT 3`;
  } catch (e) { return []; }
}

function emailHtml(name, homes, guestId) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const { staySlug } = (() => { try { return require('./_seo'); } catch (e) { return {}; } })();
  const link = (h) => staySlug ? `${SITE}/stays/${staySlug(h)}` : `${SITE}/index.html`;
  return `<div style="font-family:sans-serif; max-width:560px; color:#1c1a17;">
    <h2 style="font-family:Georgia,serif; font-weight:500; margin:0 0 8px;">Your next stay is waiting, ${esc(first)}</h2>
    <p style="line-height:1.6;">It has been a while. Here are a few homes guests are loving on Aerva right now — book directly on Aerva for verified hosts, secure payment and support through your stay.</p>
    ${homes.map(h => `<a href="${esc(link(h))}" style="display:block; text-decoration:none; color:#1c1a17; border:1px solid #ece4d8; border-radius:12px; overflow:hidden; margin:0 0 14px;">
      ${h.photo ? `<img src="${esc(h.photo)}" alt="" width="560" style="display:block; width:100%; height:auto; max-height:260px; object-fit:cover;">` : ''}
      <div style="padding:12px 16px;"><strong style="font-family:Georgia,serif; font-size:17px;">${esc(h.property_name)}</strong><br>
      <span style="font-size:13.5px; color:#6e675d;">${esc([h.area, h.city].filter(Boolean).join(', '))}${Number(h.nightly_rate) ? ' · from ' + inr(h.nightly_rate) + ' a night' : ''}</span></div></a>`).join('')}
    <p style="margin:22px 0;"><a href="${SITE}/index.html" style="background:#1c1a17; color:#f4eadc; padding:12px 22px; text-decoration:none; display:inline-block;">See all stays</a></p>
    <p style="font-size:12px; color:#8a8378; line-height:1.6; margin-top:26px;">You are receiving this because you have an Aerva account. We send offers about once a quarter.
      <a href="${esc(unsubscribeLink(guestId))}" style="color:#8a6c39;">Unsubscribe</a> · or switch off “Offers from Aerva by email” in Account Settings → Privacy. Booking emails are not affected.</p>
  </div>`;
}

async function send(to, subject, html, guestId) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html,
      headers: { 'List-Unsubscribe': `<${unsubscribeLink(guestId)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } })
  });
  return r.ok;
}

async function sendQuarterlyOffers(sql, { deadlineMs = 4000, limit = null } = {}) {
  const started = Date.now();
  const out = { quarter: quarterKey(), sent: 0, failed: 0 };
  if (String(process.env.OFFERS_EMAIL || '').toLowerCase() === 'off') return Object.assign(out, { off: true });
  let rows;
  try {
    rows = await sql`
      SELECT g.id, g.email, g.name
      FROM guests g
      WHERE g.host_id IS NULL AND g.email IS NOT NULL AND g.email <> ''
        AND g.deleted_at IS NULL AND COALESCE(to_jsonb(g)->>'account_status', 'active') NOT IN ('suspended')
        AND to_jsonb(g)->>'deactivated_at' IS NULL
        AND COALESCE((g.privacy_settings->>'offers_email')::boolean, true)
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.guest_id = g.id AND o.status IN ('paid', 'cancelled')
                        AND (o.created_at > now() - make_interval(days => ${LAPSED_DAYS}) OR (o.status = 'paid' AND o.departure >= CURRENT_DATE)))
        AND NOT EXISTS (SELECT 1 FROM offer_email_sends s WHERE s.guest_id = g.id AND s.quarter = ${out.quarter} AND s.status <> 'failed')
      ORDER BY g.id LIMIT ${limit || BATCH()}`;
  } catch (err) { return Object.assign(out, { skipped: true, error: err.code === '42P01' || err.code === '42703' ? 'database update not applied' : err.message }); }
  if (!rows.length) return out;
  const homes = await featuredHomes(sql);
  for (const g of rows) {
    if (Date.now() - started > deadlineMs) break;
    // Claimed first: a second run at the same moment cannot send twice. A
    // failed send is tried again on the next run (nothing is ever deleted).
    const claimed = await sql`INSERT INTO offer_email_sends (guest_id, quarter, status) VALUES (${g.id}, ${out.quarter}, 'sending')
                              ON CONFLICT (guest_id, quarter) DO UPDATE SET status = 'sending', attempted_at = now()
                              WHERE offer_email_sends.status = 'failed' RETURNING guest_id`;
    if (!claimed.length) continue;
    let ok = false;
    try { ok = await send(g.email, 'A few stays picked for you — Aerva', emailHtml(g.name, homes, g.id), g.id); } catch (e) { ok = false; }
    await sql`UPDATE offer_email_sends SET status = ${ok ? 'sent' : 'failed'}, attempted_at = now() WHERE guest_id = ${g.id} AND quarter = ${out.quarter}`;
    if (ok) out.sent++; else out.failed++;
  }
  return out;
}

module.exports = { sendQuarterlyOffers, quarterKey, unsubscribeToken, readUnsubscribeToken, optOut, emailHtml };
