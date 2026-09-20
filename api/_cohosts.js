// /api/_cohosts.js
// Co-hosts: people a host lets into their listings. Not an API endpoint —
// the leading underscore tells Vercel that.
//
// How a request becomes a co-host request: the page adds ?actingHost=<id>
// (the host being helped). resolveActingHost() then confirms, from the
// cohosts table, that the signed-in account is an ACTIVE co-host of that
// host, and returns what they may do and on which listings. Every check
// that matters happens here and in host-listings.js / guest-profile.js on
// the server — hiding a button on the page is never the protection.
//
// What no co-host can ever do, whatever their access: see or change bank
// details, payouts, identity verification, buy coupons, or add, change or
// remove co-hosts. Those actions are simply never on the co-host allowlist.

const { createToken, verifyToken } = require('./_approval-token');

// What EVERY co-host can do, limited or full: the Manage page (everything
// except renaming the listing), analytics, calendars, prices, blocking
// dates, and cancelling bookings.
const ALWAYS_PERMISSIONS = ['manage', 'analytics', 'calendar', 'rates', 'cancel'];
const ALWAYS_LABEL = 'Manage the listing (except renaming it), see analytics and calendars, change prices, block dates and cancel bookings';

// The extra choices a host can tick for a limited co-host.
const COHOST_PERMISSIONS = [
  { key: 'bookings',  label: 'See arrivals and bookings' },
  { key: 'messages',  label: 'Reply to guest messages' },
  { key: 'templates', label: 'Edit message templates' }
];
const PERMISSION_KEYS = COHOST_PERMISSIONS.map(p => p.key);
// Full access can do everything on the list plus the host-only actions
// (cancelling bookings, deposit disputes, reviewing guests, the full
// Manage page) — still never money or account settings.
const FULL_ONLY = 'full';

const INVITE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

function cleanPermissions(list) {
  const set = new Set((Array.isArray(list) ? list : []).filter(k => PERMISSION_KEYS.includes(k)));
  return PERMISSION_KEYS.filter(k => set.has(k));
}

function cleanEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

// The signed-in account's co-host standing for one host, or null.
async function resolveActingHost(sql, accountId, hostId) {
  const hid = Number(hostId);
  if (!Number.isInteger(hid) || hid <= 0 || !accountId) return null;
  const rows = await sql`
    SELECT c.id, c.access, c.permissions, c.listing_ids, c.commission_percent,
           (SELECT g.id FROM guests g WHERE g.host_id = c.host_id ORDER BY g.id LIMIT 1) AS owner_guest_id,
           h.name AS host_name
    FROM cohosts c JOIN hosts h ON h.id = c.host_id
    WHERE c.host_id = ${hid} AND c.cohost_guest_id = ${accountId} AND c.status = 'active'
    LIMIT 1
  `;
  const r = rows[0];
  if (!r || !r.owner_guest_id) return null;
  return {
    cohostId: r.id,
    hostId: hid,
    hostName: r.host_name || 'your host',
    ownerGuestId: r.owner_guest_id,
    access: r.access === 'full' ? 'full' : 'limited',
    permissions: new Set(cleanPermissions(r.permissions)),
    listingIds: new Set((r.listing_ids || []).map(Number)),
    commissionPercent: r.commission_percent == null ? null : Number(r.commission_percent)
  };
}

// May this co-host do something needing `perm`? 'full' covers every
// permission on the list and the full-only actions.
function cohostCan(ctx, perm) {
  if (!ctx) return false;
  if (ctx.access === 'full') return true;
  if (perm === FULL_ONLY) return false;
  if (ALWAYS_PERMISSIONS.includes(perm)) return true;
  return ctx.permissions.has(perm);
}

function cohostHasListing(ctx, listingId) {
  return !!ctx && ctx.listingIds.has(Number(listingId));
}

// What a co-host's page is told about their own access.
function describeAccess(ctx) {
  return {
    hostId: ctx.hostId,
    hostName: ctx.hostName,
    access: ctx.access,
    permissions: ALWAYS_PERMISSIONS.concat(ctx.access === 'full' ? PERMISSION_KEYS : [...ctx.permissions]),
    listingIds: [...ctx.listingIds],
    commissionPercent: ctx.commissionPercent
  };
}

// The Manage page link a co-host gets. Unlike the host's own link it names
// the co-host (so it stops working the moment they are removed — checked
// on every use in update-listing-pricing.js) and cannot rename the listing.
// Short-lived: My Collection hands out a fresh one on every load.
const COHOST_MANAGE_LIFETIME_MS = 12 * 60 * 60 * 1000;
function cohostManageToken(listingId, cohostRowId) {
  return createToken(`${Number(listingId)}.${Number(cohostRowId)}`, 'manage-cohost', COHOST_MANAGE_LIFETIME_MS);
}
async function readCohostManageToken(sql, payload) {
  if (!payload || payload.action !== 'manage-cohost') return null;
  const [lid, cid] = String(payload.listingId).split('.').map(Number);
  if (!lid || !cid) return null;
  const rows = await sql`
    SELECT c.id FROM cohosts c JOIN listings l ON l.host_id = c.host_id
    WHERE c.id = ${cid} AND c.status = 'active' AND l.id = ${lid} AND ${lid} = ANY(c.listing_ids)
  `;
  return rows.length ? { listingId: lid, cohostId: cid } : null;
}

// Share of the host's payout (after Aerva's commission) for each co-host
// on this listing with an approved commission. Written when a payment is
// confirmed (verify-payment.js). Never throws: a booking is never undone
// because a share could not be recorded — it is logged instead.
async function recordCohostShares(sql, orderId, listingId, hostPayout) {
  try {
    const payout = Math.max(0, Number(hostPayout) || 0);
    if (!orderId || !listingId || !payout) return;
    const rows = await sql`
      SELECT c.id, c.cohost_guest_id, c.commission_percent
      FROM cohosts c JOIN listings l ON l.host_id = c.host_id
      WHERE l.id = ${listingId} AND c.status = 'active' AND ${listingId} = ANY(c.listing_ids)
        AND c.commission_percent IS NOT NULL AND c.commission_percent > 0
    `;
    for (const r of rows) {
      const pct = Number(r.commission_percent);
      const amount = Math.round(payout * pct / 100);
      await sql`
        INSERT INTO order_cohost_shares (order_id, cohost_id, cohost_guest_id, percent, amount)
        VALUES (${orderId}, ${r.id}, ${r.cohost_guest_id}, ${pct}, ${amount})
        ON CONFLICT (order_id, cohost_id) DO NOTHING
      `;
    }
  } catch (err) {
    console.error('recordCohostShares failed (booking kept):', orderId, err.message);
  }
}

function inviteToken(cohostRowId) {
  return createToken(cohostRowId, 'cohost-invite', INVITE_LIFETIME_MS);
}
function readInviteToken(token) {
  const p = token ? verifyToken(token) : null;
  return p && p.action === 'cohost-invite' ? Number(p.listingId) : null;
}

// The invitation email. The link proves the person owns this inbox —
// accepting needs it, so nobody can sign up with someone else's address
// and take their invitation. Never throws.
async function emailCohostInvite({ to, hostName, access, permissions, listingNames, token }) {
  try {
    if (!process.env.RESEND_API_KEY) {
      console.error('RESEND_API_KEY not set — co-host invitation email not sent.');
      return false;
    }
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const link = `https://aerva.in/index.html?view=cohost&invite=${encodeURIComponent(token)}`;
    const extras = COHOST_PERMISSIONS.filter(p => permissions.includes(p.key)).map(p => p.label.toLowerCase());
    const what = access === 'full'
      ? 'full access to these listings (everything except renaming them, payouts, bank details and account settings)'
      : 'access to: ' + [ALWAYS_LABEL.toLowerCase()].concat(extras).join('; ');
    const html = `
      <div style="font-family:sans-serif; max-width:520px;">
        <h2 style="font-family:Georgia,serif;">${esc(hostName)} invited you to co-host on Aerva</h2>
        <p>You would have ${esc(what)}.</p>
        <p>Listings: ${esc(listingNames.join(', ') || '—')}</p>
        <p><a href="${link}" style="display:inline-block; background:#1c1a17; color:#fff; padding:12px 22px; border-radius:999px; text-decoration:none;">Accept invitation</a></p>
        <p style="font-size:13px; opacity:0.7;">Sign in, or create an account, with this email address (${esc(to)}) — the invitation only works for it. It expires in 14 days.</p>
      </div>`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject: `${hostName} invited you to co-host on Aerva`, html })
    });
    if (!res.ok) { console.error('co-host invite email failed:', res.status); return false; }
    return true;
  } catch (err) {
    console.error('co-host invite email failed (non-fatal):', err);
    return false;
  }
}

// ---- What a co-host still has to give, per host they help ----
// phone (on their account), about (work + "About me"), and a proposed
// commission (0–100% of the host's payout; an approved one also counts).
// Until nothing is missing they cannot act for that host: the gates in
// host-listings.js and guest-profile.js refuse, and the site sends them
// to the Co-hosting tab to finish.
function aboutDone(g) {
  let a = g && g.profile_about;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = {}; } }
  a = a && typeof a === 'object' ? a : {};
  return !!(String((g && g.profile_work) || '').trim() && String(a.about_me || '').trim());
}
function commissionDone(c) {
  return !!c && (c.commission_percent != null || (c.proposal_status === 'proposed' && c.proposed_percent != null));
}
async function cohostDetailsMissing(sql, accountId, hostId) {
  let g, c;
  try {
    g = (await sql`SELECT phone, profile_work, profile_about FROM guests WHERE id = ${accountId}`)[0] || {};
    c = (await sql`SELECT commission_percent, proposed_percent, proposal_status FROM cohosts
                   WHERE cohost_guest_id = ${accountId} AND host_id = ${Number(hostId) || 0} AND status = 'active' ORDER BY id DESC LIMIT 1`)[0];
  } catch (err) {
    // Onboarding check only: if the details cannot be read, never block work.
    console.error('cohostDetailsMissing skipped:', err.message);
    return [];
  }
  const missing = [];
  if (!g.phone) missing.push('phone');
  if (!aboutDone(g)) missing.push('about');
  if (!commissionDone(c)) missing.push('commission');
  return missing;
}
const DETAILS_REQUIRED_MESSAGE = 'Finish your co-host details first (phone, about you and your proposed commission) on the Co-hosting page.';

module.exports = {
  aboutDone, commissionDone, cohostDetailsMissing, DETAILS_REQUIRED_MESSAGE,
  COHOST_PERMISSIONS, PERMISSION_KEYS, FULL_ONLY, ALWAYS_PERMISSIONS, ALWAYS_LABEL,
  cohostManageToken, readCohostManageToken, recordCohostShares,
  cleanPermissions, cleanEmail, resolveActingHost, cohostCan, cohostHasListing,
  describeAccess, inviteToken, readInviteToken, emailCohostInvite
};
