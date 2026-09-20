// /api/host-listings.js
// Returns every listing belonging to the logged-in guest's linked host
// account — pending, approved, and rejected, so the dashboard can show
// real status, not just what's live to guests. Requires a valid
// guest-session token (the single login used across the whole site — see
// guest-auth.js / guest-phone-auth.js), sent as:
//   Authorization: Bearer <sessionToken>
//
// A guest who hasn't listed a property yet simply has no linked host
// account (guests.host_id is null) — that's not an error, it just means
// an empty list, same as a brand-new account.
//
//   GET  — as above, now also returns `verification`: the host's
//          PAN/Aadhaar/bank verification status, plus their name/phone
//          for the profile's Personal Details tab. Each booking now
//          includes its deposit fields (amount, status, release date,
//          any dispute already raised).
//   POST { panNumber?, panDocumentUrl? } — submits PAN, once ever. Like
//          Aadhaar below, this is permanently locked the moment a PAN
//          document exists on file, regardless of the review outcome —
//          contact support for any change after that, never a silent
//          self-service overwrite of identity documents.
//   POST { aadhaarDocumentUrl? } — submits Aadhaar, once ever — same
//          "permanently locked once submitted" rule as PAN above. This
//          used to allow a resubmit after a rejection; it no longer does,
//          to match PAN's stricter policy.
//   POST { bankAccountNumber?, bankIfsc?, bankAccountHolderName? } —
//          unlike PAN/Aadhaar, bank details CAN be changed anytime,
//          because a host's payout account can legitimately change. But
//          changing it is exactly the kind of action a compromised
//          account would take, so a change here re-triggers review of
//          everything: bank_status resets to pending_review as usual,
//          and if PAN/Aadhaar were already submitted, THEIR status also
//          resets to pending_review (same document, freshly re-checked)
//          rather than staying "verified" through an unrelated-looking
//          payout change.
//   POST { hostName?, hostPhone? } — updates the host's own profile
//          name/phone (Personal Details tab). Not identity-sensitive the
//          way PAN/Aadhaar/bank are, so no re-verification triggered.
//   POST { raiseDispute: { orderId, reason } } — flags a concern on one
//          of this host's bookings' held security deposits, before it
//          would otherwise auto-refund to the guest 7 days after
//          checkout. Only works while deposit_status is still 'held' and
//          the release date hasn't passed. See get-pending-listings.js's
//          resolveDispute mode for how an admin follows up.
//   POST { cancelBooking: { orderId, reason } } — cancels a paid booking
//          and refunds the guest in full, but ONLY if check-in is more
//          than 48 hours away. Within that window, the host cannot
//          cancel through this endpoint at all — the guest is protected
//          regardless of the host's reason.
//   POST { buyCouponOrder: { bookingId, amount } } — step 1 of issuing a
//          compensation coupon: creates a Razorpay order for the HOST to
//          pay Aerva (not a guest payment). bookingId must be one of this
//          host's own orders — the coupon is tied to that booking's guest.
//   POST { verifyCouponPayment: { couponId, razorpay_order_id,
//          razorpay_payment_id, razorpay_signature } } — step 2: confirms
//          the host's payment actually succeeded (never trusts the
//          browser's word alone), then activates the coupon, generates
//          its real code, and emails it to the guest. 3-month validity,
//          redeemable on any listing platform-wide.
//   POST { cancelWithCoupon: { orderId } } — cancels a booking to make
//          room for a bigger one, but ONLY if an active coupon already
//          exists for that exact booking (see buyCouponOrder above) —
//          the coupon has to be bought and confirmed FIRST. Same 48-hour
//          check-in cutoff as cancelBooking.

const { neon } = require('@neondatabase/serverless');
const Razorpay = require('razorpay');
const { verifyToken, createToken } = require('./_approval-token');
const { submissionOpen, REVIEW_WINDOW_DAYS } = require('./_review-policy');
const { GUEST_FACTORS, reviewScore } = require('./_tiers');
const { openFlagsForHost } = require('./_compliance');
const { buildProfile } = require('./_profiles');
const { DEFAULT_TIMEZONE } = require('./_timezones');
const { isAccountDeleted } = require('./_accounts');
const { logAudit } = require('./_audit-log');
const { convertInrToForeignSubunit } = require('./_currency');
const { verifyRazorpaySignature } = require('./_razorpay-verify');
const { COUPON_RELEASE_DELAY_MINUTES, sendCouponEmail } = require('./_coupons');
const { loadPayoutSummary } = require('./_payouts');
const { safeRefund } = require('./_refunds');
const { validatePhoneNumber, normalizeToE164 } = require('./_phone-validation');
const { countRecentAttempts, getClientIp } = require('./_rate-limit');
const crypto = require('crypto');
const { sanitizeBody } = require('./_plain-text');
const { AGREEMENT_VERSION } = require('./_agreements');
const { requestContext } = require('./_audit-log');
const { encryptField, maskPan, maskAccount, maskGstin, encryptionReady } = require('./_secure-fields');
const { COHOST_PERMISSIONS, FULL_ONLY, ALWAYS_LABEL, cleanPermissions, cleanEmail, resolveActingHost, cohostCan,
        cohostHasListing, describeAccess, inviteToken, readInviteToken, emailCohostInvite,
        cohostManageToken } = require('./_cohosts');

const sql = neon(process.env.DATABASE_URL);
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
const CANCELLATION_CUTOFF_HOURS = 48;

// Same Resend pattern used everywhere else in this codebase (see
// guest-auth.js, submit-listing.js, approve-listing.js) — never throws;
// a failed notification email shouldn't undo a cancellation that's
// already happened and already been refunded.
// Reasons a host may give for cancelling (the guest is told the reason).
const HOST_CANCEL_REASONS = {
  property_unavailable: 'Property unavailable (repairs or damage)',
  double_booking: 'Double booking',
  safety: 'Safety concern at the property',
  environmental: 'Environmental hazard (flood, fire, landslide or similar)',
  emergency: 'Personal or family emergency',
  government: 'Government order or travel restriction',
  other: 'Other'
};
// Reasons a guest may give when asking the host to accept a cancellation.
const GUEST_CANCEL_REASONS = {
  environmental: 'Environmental hazard (flood, fire, landslide or similar)',
  life_threatening: 'Life-threatening situation',
  emergency: 'Medical or family emergency',
  travel_restriction: 'Government order or travel restriction'
};

async function sendCancellationEmail(order, opts = {}){
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set — guest will not receive a cancellation notice.');
    return;
  }
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lead = opts.guestRequested
    ? `Your host has accepted your request to cancel your stay at <strong>${esc(order.suite_name)}</strong> (${order.arrival} — ${order.departure}).`
    : `Your host has cancelled your stay at <strong>${esc(order.suite_name)}</strong> (${order.arrival} — ${order.departure}).`;
  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">Your booking has been cancelled</h2>
      <p>${lead}</p>
      ${opts.reasonLabel ? `<p><strong>Reason:</strong> ${esc(opts.reasonLabel)}${opts.details ? ' — ' + esc(opts.details) : ''}</p>` : ''}
      <p>Your full payment has been refunded to your original payment method. It should appear within 5–7 business days, depending on your bank.</p>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">If you have questions about this cancellation, please contact hello@aerva.in.</p>
    </div>
  `;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Aerva <hello@aerva.in>',
      to: order.guest_email,
      subject: `Your Aerva booking at ${order.suite_name} has been cancelled`,
      html
    })
  });
  if (!res.ok) {
    let detail;
    try { detail = await res.json(); } catch { detail = { message: res.statusText }; }
    console.error('Resend send failed (cancellation notice):', res.status, detail);
  }
}

// sendCouponEmail now lives in _coupons.js (shared with the automatic release).
const SITE_BASE = 'https://aerva.in';
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

function requireGuestId(req) {
  const authHeader = req.headers['authorization'] || '';
  const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = sessionToken ? verifyToken(sessionToken) : null;
  if (!payload || payload.action !== 'guest-session') return null;
  return payload.listingId; // generically-named token field — see host-auth.js note
}


// ---- Unblocking part of a stored block range ----
// listing_blocked_dates stores one row per blocked RANGE, with end_date
// EXCLUSIVE (a single night on 15 Sep is stored 15 Sep -> 16 Sep; see how
// host-status.html sends nextDayStr(endInclusive) to bulkBlockRange).
// Freeing up part of that range therefore isn't a delete — it's a trim,
// or a split into two rows when the freed dates sit in the middle.
// Deleting the whole row instead, which is what used to happen, quietly
// reopened nights the host never asked to reopen.
//
// [from, to) is the half-open range being freed, matching the storage
// convention so the comparisons stay consistent.
// ---- Splitting a listing-level block into per-room blocks ----
// For a resort, every room is its own inventory. A block row with
// room_id NULL on a resort means "every room" — but the moment a host
// wants to free ONE room's night, that single row can't express it.
// So before acting on a NULL row for a specific room, the row is
// exploded into one identical row per room, the NULL row is deleted,
// and the action proceeds on just the requested room's copy. The other
// rooms end up exactly as blocked as they were, in their own rows.
//
// Returns the id of the row to act on: the original id if nothing
// needed splitting (a room-level row, a non-resort listing, or a
// request with no room), else the new row for the requested room.
async function resolveBlockRowForRoom(sql, rowId, roomId) {
  if (!roomId) return rowId;
  const rows = await sql`SELECT id, listing_id, room_id, start_date, end_date, reason FROM listing_blocked_dates WHERE id = ${rowId}`;
  const row = rows[0];
  if (!row || row.room_id !== null) return rowId;

  const rooms = await sql`SELECT id FROM listing_rooms WHERE listing_id = ${row.listing_id} ORDER BY id ASC`;
  if (!rooms.length) return rowId; // not a resort — a NULL row is the only kind there is

  let targetId = null;
  for (const room of rooms) {
    const inserted = await sql`
      INSERT INTO listing_blocked_dates (listing_id, room_id, start_date, end_date, reason)
      VALUES (${row.listing_id}, ${room.id}, ${row.start_date}, ${row.end_date}, ${row.reason})
      RETURNING id
    `;
    if (Number(room.id) === Number(roomId)) targetId = inserted[0].id;
  }
  await sql`DELETE FROM listing_blocked_dates WHERE id = ${row.id}`;
  // If the requested room somehow isn't on this listing, there's nothing
  // of it to act on; the split still stands, since it's a pure
  // re-expression of the same block.
  return targetId;
}

async function unblockRangeFromRow(sql, rowId, from, to) {
  const rows = await sql`SELECT id, listing_id, room_id, start_date, end_date, reason FROM listing_blocked_dates WHERE id = ${rowId}`;
  const row = rows[0];
  if (!row) return;

  const rowStart = new Date(row.start_date).toISOString().slice(0, 10);
  const rowEnd = new Date(row.end_date).toISOString().slice(0, 10);

  const keepLeft = from > rowStart;   // block survives before the freed part
  const keepRight = to < rowEnd;      // block survives after it

  if (!keepLeft && !keepRight) {
    // Freed range covers the whole row.
    await sql`DELETE FROM listing_blocked_dates WHERE id = ${row.id}`;
    return;
  }
  if (keepLeft && keepRight) {
    // Freed range is in the MIDDLE — shorten this row to the left piece
    // and insert a second row for the right piece.
    await sql`UPDATE listing_blocked_dates SET end_date = ${from}::date WHERE id = ${row.id}`;
    await sql`
      INSERT INTO listing_blocked_dates (listing_id, room_id, start_date, end_date, reason)
      VALUES (${row.listing_id}, ${row.room_id}, ${to}::date, ${rowEnd}::date, ${row.reason})
    `;
    return;
  }
  if (keepLeft) {
    await sql`UPDATE listing_blocked_dates SET end_date = ${from}::date WHERE id = ${row.id}`;
  } else {
    await sql`UPDATE listing_blocked_dates SET start_date = ${to}::date WHERE id = ${row.id}`;
  }
}


// ======================================================================
// Co-hosts
// ======================================================================

// Every action a co-host may ever take on a host's side, what it needs,
// and how to find the listing it touches. Anything not listed here is
// refused to a co-host outright — that is what keeps bank details,
// payouts, verification, coupons and co-host management out of reach.
const COHOST_ACTIONS = {
  // POST body keys
  bulkBlockRange:     { perm: 'rates', listingFrom: b => b.listingId },
  unblockRange:       { perm: 'rates', listingFrom: b => b.listingId },
  toggleBlockedDate:  { perm: 'rates', listingFrom: b => b.listingId },
  addPromotion:       { perm: 'rates', listingFrom: b => b.listingId },
  removePromotionRun: { perm: 'rates', listingFrom: b => b.listingId },
  removePromotion:    { perm: 'rates', promotionFrom: b => b.promotionId },
  removePromotionDay: { perm: 'rates', promotionFrom: b => b.promotionId },
  cancelBooking:      { perm: 'cancel', orderFrom: b => b.orderId },
  cancelWithCoupon:   { perm: 'cancel', orderFrom: b => b.orderId },
  buyCouponOrder:     { perm: 'cancel', orderFrom: b => b.bookingId },
  respondCancellationRequest: { perm: 'cancel', requestFrom: b => b.requestId },
  verifyCouponPayment:{ perm: 'cancel', couponFrom: b => b.couponId },
  raiseDispute:       { perm: FULL_ONLY, orderFrom: b => b.orderId },
  reviewGuest:        { perm: FULL_ONLY, orderFrom: b => b.orderId }
};

function cohostDenied(res, msg) {
  res.status(403).json({ error: msg || 'Your co-host access does not include this.' });
  return null;
}

// Decides a co-host request before any host code runs: who they are
// helping, whether this action is allowed at all, whether their access
// covers it, and whether the listing is one of theirs. Then trims
// everything the response would otherwise show to what they may see.
async function cohostGate(req, res, accountId) {
  const ctx = await resolveActingHost(sql, accountId, req.query.actingHost);
  if (!ctx) return cohostDenied(res, 'You are not a co-host for this host, or your access has ended.');

  let perm = null;
  let listingId = null;
  let mode = null;
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q.analytics === '1') { perm = 'analytics'; mode = 'analytics'; }
    else if (q.statusCalendar === '1') { perm = 'calendar'; mode = 'statusCalendar'; }
    // The co-host's own cancellation-coupon deductions (never the host's).
    else if (q.myPenalties === '1') { perm = 'cancel'; mode = 'myPenalties'; }
    else if (q.cancellationRequests === '1') { perm = 'cancel'; mode = 'cancellationRequests'; }
    else if (q.guestProfileForOrder !== undefined) {
      perm = 'bookings'; mode = 'guestProfile';
      const o = await sql`SELECT listing_id FROM orders WHERE id = ${Number(q.guestProfileForOrder) || 0}`;
      listingId = o[0] ? o[0].listing_id : -1;
    }
    else if (Object.keys(q).every(k => k === 'actingHost')) { mode = 'dashboard'; }
    else return cohostDenied(res);
  } else if (req.method === 'POST') {
    const body = req.body || {};
    const key = Object.keys(COHOST_ACTIONS).find(k => body[k]);
    if (!key || Object.keys(body).length !== 1) return cohostDenied(res);
    const rule = COHOST_ACTIONS[key];
    const payload = body[key] || {};
    perm = rule.perm; mode = key;
    if (rule.listingFrom) listingId = Number(rule.listingFrom(payload)) || -1;
    if (rule.orderFrom) {
      const o = await sql`SELECT listing_id FROM orders WHERE id = ${Number(rule.orderFrom(payload)) || 0}`;
      listingId = o[0] ? o[0].listing_id : -1;
    }
    if (rule.requestFrom) {
      const rr = await sql`SELECT o.listing_id FROM cancellation_requests r JOIN orders o ON o.id = r.order_id WHERE r.id = ${Number(rule.requestFrom(payload)) || 0}`;
      listingId = rr[0] ? rr[0].listing_id : -1;
    }
    if (rule.couponFrom) {
      const cr = await sql`SELECT o.listing_id FROM coupons c JOIN orders o ON o.id = c.source_order_id WHERE c.id = ${Number(rule.couponFrom(payload)) || 0}`;
      listingId = cr[0] ? cr[0].listing_id : -1;
    }
    if (rule.promotionFrom) {
      const pr = await sql`SELECT listing_id FROM listing_promotions WHERE id = ${Number(rule.promotionFrom(payload)) || 0}`;
      listingId = pr[0] ? pr[0].listing_id : -1;
    }
  } else {
    return cohostDenied(res);
  }

  if (perm && !cohostCan(ctx, perm)) return cohostDenied(res);
  if (listingId !== null && !cohostHasListing(ctx, listingId)) {
    return cohostDenied(res, 'That listing is not one you co-host.');
  }

  if (req.method === 'POST') {
    await logAudit(sql, {
      action: 'cohost_action', success: true, actorType: 'cohost', actorIdentifier: String(accountId),
      targetType: 'host', targetId: ctx.hostId, metadata: { mode, listingId, cohostId: ctx.cohostId }
    });
  }

  // Trim the answer to what this co-host may see.
  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(trimForCohost(ctx, mode, body));
  return { ctx };
}

function cohostManageLink(listingId, cohostRowId) {
  return `${SITE_BASE}/manage-listing.html?token=${cohostManageToken(listingId, cohostRowId)}`;
}

function trimForCohost(ctx, mode, body) {
  if (!body || typeof body !== 'object' || body.error) return body;
  const inScope = (id) => cohostHasListing(ctx, id);
  if (mode === 'dashboard') {
    const seesBookings = cohostCan(ctx, 'bookings');
    const out = {
      // Every co-host gets the Manage page, through their own link: it
      // stops working when they are removed and cannot rename the listing.
      listings: (body.listings || []).filter(l => inScope(l.id)).map(l => ({ ...l, manageLink: cohostManageLink(l.id, ctx.cohostId) })),
      hostBadge: body.hostBadge || null,
      bookings: seesBookings ? (body.bookings || []).filter(b => inScope(b.listing_id)) : [],
      verification: null, // never shown to a co-host
      complianceNotices: (body.complianceNotices || []).filter(n => inScope(n.listingId))
        .map(n => ({ ...n, manageLink: cohostManageLink(n.listingId, ctx.cohostId) })),
      today: { arrivals: [], departures: [], staying: [], experiences: [] },
      cohost: describeAccess(ctx)
    };
    if (seesBookings && body.today) {
      for (const k of Object.keys(out.today)) out.today[k] = (body.today[k] || []).filter(r => inScope(r.listingId));
    }
    return out;
  }
  if (mode === 'analytics') {
    return { ...body,
      rows: (body.rows || []).filter(r => inScope(r.listingId)),
      listings: Array.isArray(body.listings) ? body.listings.filter(l => inScope(l.id)) : body.listings };
  }
  if (mode === 'statusCalendar') {
    return { ...body, rows: (body.rows || []).filter(r => inScope(r.listingId)) };
  }
  return body;
}

// Inviting, changing and removing co-hosts (the host), and seeing,
// accepting, declining or leaving co-hosting (the co-host). Returns true
// when it has answered the request. Never runs for ?actingHost requests:
// a co-host can never manage co-hosts.
async function handleCohostModes(req, res, accountId) {
  const q = req.query || {};
  const b = (req.method === 'POST' && req.body) || {};
  const isMode = (req.method === 'GET' && (q.cohosts === '1' || q.myCohosting === '1'))
    || (req.method === 'POST' && (b.inviteCohost || b.updateCohost || b.removeCohost || b.acceptCohostInvite || b.declineCohostInvite || b.leaveCohost
        || b.proposeCommission || b.decideCommission || b.savePayoutProfile))
    || (req.method === 'GET' && q.myPayoutProfile === '1');
  if (!isMode) return false;
  if (q.actingHost !== undefined) { cohostDenied(res, 'Co-hosts cannot manage co-hosts.'); return true; }

  try {
    const meRows = await sql`SELECT id, host_id, email, name FROM guests WHERE id = ${accountId}`;
    const me = meRows[0];
    if (!me) { res.status(401).json({ error: 'Please log in again.' }); return true; }

    // ---- The co-host's side ----
    if (req.method === 'GET' && q.myCohosting === '1') {
      const active = await sql`
        SELECT c.id, c.host_id, c.access, c.permissions, c.listing_ids, h.name AS host_name,
               c.commission_percent, c.proposed_percent, c.proposal_status
        FROM cohosts c JOIN hosts h ON h.id = c.host_id
        WHERE c.cohost_guest_id = ${me.id} AND c.status = 'active'
        ORDER BY c.accepted_at DESC
      `;
      // What this person has earned as a co-host: every recorded share,
      // newest first (the last 50), and the total.
      let earnings = { total: 0, rows: [] };
      try {
        const er = await sql`
          SELECT s.amount, s.percent, o.arrival, o.departure, o.status, l.property_name, h.name AS host_name
          FROM order_cohost_shares s
          JOIN orders o ON o.id = s.order_id
          JOIN listings l ON l.id = o.listing_id
          JOIN hosts h ON h.id = l.host_id
          WHERE s.cohost_guest_id = ${me.id}
          ORDER BY o.arrival DESC NULLS LAST LIMIT 50
        `;
        const tot = await sql`SELECT COALESCE(SUM(s.amount), 0)::int AS t FROM order_cohost_shares s JOIN orders o ON o.id = s.order_id WHERE s.cohost_guest_id = ${me.id} AND o.status = 'paid'`;
        earnings = {
          total: Number(tot[0] && tot[0].t) || 0,
          rows: er.map(r => ({ amount: Number(r.amount), percent: Number(r.percent), arrival: r.arrival, departure: r.departure,
                               status: r.status, listingName: r.property_name, hostName: r.host_name }))
        };
      } catch (err) { console.error('co-host earnings failed:', err.message); }
      res.status(200).json({
        cohosting: active.map(r => ({
          hostId: r.host_id, hostName: r.host_name || 'Host', access: r.access,
          permissions: r.access === 'full' ? COHOST_PERMISSIONS.map(p => p.key) : cleanPermissions(r.permissions),
          listingCount: (r.listing_ids || []).length,
          commissionPercent: r.commission_percent == null ? null : Number(r.commission_percent),
          proposedPercent: r.proposed_percent == null ? null : Number(r.proposed_percent),
          proposalStatus: r.proposal_status || null
        })),
        earnings,
        permissionLabels: COHOST_PERMISSIONS,
        alwaysLabel: ALWAYS_LABEL
      });
      return true;
    }
    // ---- A co-host's payout details: PAN, optional GSTIN, bank account ----
    // Shown back to them masked; only the admin payout view sees them in
    // full. Any change needs an admin's approval again before payouts.
    if (req.method === 'GET' && q.myPayoutProfile === '1') {
      let p = null;
      try { p = (await sql`SELECT * FROM cohost_payout_profiles WHERE guest_id = ${me.id}`)[0] || null; }
      catch (err) { console.error('payout profile unavailable:', err.message); }
      res.status(200).json({ profile: p ? {
        // Stored encrypted; the co-host only ever sees it masked.
        panMasked: maskPan(p.pan_number),
        gstin: maskGstin(p.gstin),
        accountHolderName: p.account_holder_name,
        accountMasked: maskAccount(p.bank_account_number),
        ifsc: p.bank_ifsc,
        status: p.status,
        rejectionReason: p.status === 'rejected' ? (p.rejection_reason || null) : null
      } : null });
      return true;
    }
    if (b.savePayoutProfile) {
      const x = b.savePayoutProfile;
      const pan = String(x.pan || '').trim().toUpperCase();
      const gstin = String(x.gstin || '').trim().toUpperCase();
      const holder = String(x.accountHolderName || '').trim().slice(0, 120);
      const account = String(x.accountNumber || '').replace(/\s+/g, '');
      const ifsc = String(x.ifsc || '').trim().toUpperCase();
      if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) { res.status(400).json({ error: 'Please enter a valid PAN, like ABCDE1234F.' }); return true; }
      if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) { res.status(400).json({ error: 'That GSTIN does not look right — it is 15 characters, like 27ABCDE1234F1Z5. Leave it empty if you do not have one.' }); return true; }
      if (gstin && gstin.slice(2, 12) !== pan) { res.status(400).json({ error: 'Your GSTIN should contain your PAN (characters 3 to 12).' }); return true; }
      if (holder.length < 2) { res.status(400).json({ error: 'Please enter the account holder\'s name as the bank has it.' }); return true; }
      if (!/^[0-9]{9,18}$/.test(account)) { res.status(400).json({ error: 'Bank account numbers are 9 to 18 digits.' }); return true; }
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) { res.status(400).json({ error: 'Please enter a valid IFSC, like HDFC0001234.' }); return true; }
      const isCohost = await sql`SELECT 1 FROM cohosts WHERE cohost_guest_id = ${me.id} AND status = 'active' LIMIT 1`;
      if (!isCohost.length) { res.status(403).json({ error: 'Payout details are for active co-hosts.' }); return true; }
      // PAN, GSTIN (which contains the PAN) and account number are stored
      // encrypted (see _secure-fields.js) — or not at all.
      if (!encryptionReady()) {
        console.error('DATA_ENCRYPTION_KEY missing or invalid — refused to save co-host payout details.');
        res.status(503).json({ error: ENCRYPTION_UNAVAILABLE }); return true;
      }
      const encPan = encryptField(pan);
      const encAccount = encryptField(account);
      const encGstin = gstin ? encryptField(gstin) : null;
      await sql`
        INSERT INTO cohost_payout_profiles (guest_id, pan_number, gstin, account_holder_name, bank_account_number, bank_ifsc, status, rejection_reason, submitted_at, reviewed_at)
        VALUES (${me.id}, ${encPan}, ${encGstin}, ${holder}, ${encAccount}, ${ifsc}, 'pending_review', NULL, now(), NULL)
        ON CONFLICT (guest_id) DO UPDATE SET
          pan_number = EXCLUDED.pan_number, gstin = EXCLUDED.gstin, account_holder_name = EXCLUDED.account_holder_name,
          bank_account_number = EXCLUDED.bank_account_number, bank_ifsc = EXCLUDED.bank_ifsc,
          status = 'pending_review', rejection_reason = NULL, submitted_at = now(), reviewed_at = NULL
      `;
      await logAudit(sql, { action: 'cohost_payout_profile_submitted', success: true, actorType: 'guest', actorIdentifier: String(me.id), targetType: 'guest', targetId: me.id });
      res.status(200).json({ success: true, status: 'pending_review' });
      return true;
    }

    // A co-host proposes their share of the host's payout; the host decides.
    if (b.proposeCommission) {
      const pct = Math.round(Number(b.proposeCommission.percent) * 100) / 100;
      if (!(pct > 0 && pct <= 100)) { res.status(400).json({ error: 'Enter a percentage between 0.01 and 100.' }); return true; }
      const upd = await sql`
        UPDATE cohosts SET proposed_percent = ${pct}, proposal_status = 'proposed', proposed_at = now()
        WHERE cohost_guest_id = ${me.id} AND host_id = ${Number(b.proposeCommission.hostId) || 0} AND status = 'active'
        RETURNING id
      `;
      if (!upd.length) { res.status(404).json({ error: 'You are not an active co-host for this host.' }); return true; }
      await logAudit(sql, { action: 'cohost_commission_proposed', success: true, actorType: 'guest', actorIdentifier: String(me.id), targetType: 'cohost', targetId: upd[0].id, metadata: { percent: pct } });
      res.status(200).json({ success: true });
      return true;
    }
    if (b.acceptCohostInvite || b.declineCohostInvite) {
      const token = (b.acceptCohostInvite || b.declineCohostInvite).token;
      const rowId = readInviteToken(token);
      if (!rowId) { res.status(400).json({ error: 'This invitation link is not valid or has expired. Ask the host to send it again.' }); return true; }
      const rows = await sql`SELECT c.*, h.name AS host_name FROM cohosts c JOIN hosts h ON h.id = c.host_id WHERE c.id = ${rowId}`;
      const inv = rows[0];
      if (!inv || inv.status !== 'invited') { res.status(410).json({ error: 'This invitation is no longer open.' }); return true; }
      if (!me.email || String(me.email).trim().toLowerCase() !== String(inv.invited_email).toLowerCase()) {
        res.status(403).json({ error: `This invitation was sent to ${inv.invited_email}. Sign in with that email to accept it.` });
        return true;
      }
      if (me.host_id && Number(me.host_id) === Number(inv.host_id)) {
        res.status(400).json({ error: 'You cannot co-host your own listings.' });
        return true;
      }
      if (b.declineCohostInvite) {
        await sql`UPDATE cohosts SET status = 'declined' WHERE id = ${inv.id} AND status = 'invited'`;
        res.status(200).json({ success: true, declined: true });
        return true;
      }
      const upd = await sql`
        UPDATE cohosts SET status = 'active', cohost_guest_id = ${me.id}, accepted_at = now()
        WHERE id = ${inv.id} AND status = 'invited' RETURNING id
      `;
      if (!upd.length) { res.status(410).json({ error: 'This invitation is no longer open.' }); return true; }
      await logAudit(sql, { action: 'cohost_accepted', success: true, actorType: 'guest', actorIdentifier: String(me.id), targetType: 'host', targetId: inv.host_id, metadata: { cohostId: inv.id } });
      res.status(200).json({ success: true, hostId: inv.host_id, hostName: inv.host_name || 'Host' });
      return true;
    }
    if (b.leaveCohost) {
      await sql`UPDATE cohosts SET status = 'removed', removed_at = now()
                WHERE cohost_guest_id = ${me.id} AND host_id = ${Number(b.leaveCohost.hostId) || 0} AND status = 'active'`;
      res.status(200).json({ success: true });
      return true;
    }

    // ---- The host's side: only the listing owner ----
    if (!me.host_id) { res.status(403).json({ error: 'Only hosts can add co-hosts.' }); return true; }
    const ownListings = await sql`
      SELECT id, property_name, COALESCE(listing_type, 'stay') AS listing_type, status FROM listings
      WHERE host_id = ${me.host_id} AND status NOT IN ('removed', 'rejected')
      ORDER BY property_name ASC
    `;
    const ownIds = new Set(ownListings.map(l => Number(l.id)));
    const pickListings = (ids) => [...new Set((Array.isArray(ids) ? ids : []).map(Number))].filter(id => ownIds.has(id));

    if (req.method === 'GET' && q.cohosts === '1') {
      const rows = await sql`
        SELECT c.id, c.invited_email, c.access, c.permissions, c.listing_ids, c.status, c.invited_at, c.accepted_at,
               c.commission_percent, c.proposed_percent, c.proposal_status,
               g.name AS cohost_name
        FROM cohosts c LEFT JOIN guests g ON g.id = c.cohost_guest_id
        WHERE c.host_id = ${me.host_id} AND c.status IN ('invited', 'active')
        ORDER BY c.invited_at DESC
      `;
      res.status(200).json({
        cohosts: rows.map(r => ({
          id: r.id, email: r.invited_email, name: r.cohost_name || null, access: r.access,
          permissions: cleanPermissions(r.permissions), listingIds: (r.listing_ids || []).map(Number),
          status: r.status, invitedAt: r.invited_at, acceptedAt: r.accepted_at,
          commissionPercent: r.commission_percent == null ? null : Number(r.commission_percent),
          proposedPercent: r.proposed_percent == null ? null : Number(r.proposed_percent),
          proposalStatus: r.proposal_status || null
        })),
        listings: ownListings.map(l => ({ id: l.id, name: l.property_name, type: l.listing_type })),
        permissionLabels: COHOST_PERMISSIONS,
        alwaysLabel: ALWAYS_LABEL
      });
      return true;
    }

    // The host approves or declines a co-host's proposed share. Approved
    // shares on any one listing can never add up to more than 100% of the
    // host's payout.
    if (b.decideCommission) {
      const id = Number(b.decideCommission.id) || 0;
      const rows = await sql`SELECT id, proposed_percent, proposal_status, listing_ids FROM cohosts WHERE id = ${id} AND host_id = ${me.host_id} AND status = 'active'`;
      const c = rows[0];
      if (!c || c.proposal_status !== 'proposed' || c.proposed_percent == null) { res.status(404).json({ error: 'There is no proposal waiting for this co-host.' }); return true; }
      if (!b.decideCommission.approve) {
        await sql`UPDATE cohosts SET proposal_status = 'declined' WHERE id = ${id}`;
        await logAudit(sql, { action: 'cohost_commission_declined', success: true, actorType: 'host', actorIdentifier: String(me.host_id), targetType: 'cohost', targetId: id });
        res.status(200).json({ success: true, approved: false });
        return true;
      }
      const pct = Number(c.proposed_percent);
      const others = await sql`
        SELECT l AS listing_id, COALESCE(SUM(o.commission_percent), 0) AS used
        FROM unnest(${c.listing_ids}::int[]) AS l
        LEFT JOIN cohosts o ON o.host_id = ${me.host_id} AND o.status = 'active' AND o.id <> ${id}
             AND o.commission_percent IS NOT NULL AND l = ANY(o.listing_ids)
        GROUP BY l
      `;
      const over = others.find(r => Number(r.used) + pct > 100);
      if (over) { res.status(400).json({ error: `Approving this would give co-hosts more than 100% of your payout on one listing (${Number(over.used)}% is already shared there).` }); return true; }
      await sql`UPDATE cohosts SET commission_percent = ${pct}, proposal_status = 'approved' WHERE id = ${id}`;
      await logAudit(sql, { action: 'cohost_commission_approved', success: true, actorType: 'host', actorIdentifier: String(me.host_id), targetType: 'cohost', targetId: id, metadata: { percent: pct } });
      res.status(200).json({ success: true, approved: true, percent: pct });
      return true;
    }

    const readAccess = (x) => {
      const access = x.access === 'full' ? 'full' : 'limited';
      const permissions = access === 'full' ? [] : cleanPermissions(x.permissions);
      const listingIds = pickListings(x.listingIds);
      return { access, permissions, listingIds };
    };

    if (b.inviteCohost) {
      const email = cleanEmail(b.inviteCohost.email);
      if (!email) { res.status(400).json({ error: 'Please enter a valid email address.' }); return true; }
      if (me.email && email === String(me.email).trim().toLowerCase()) { res.status(400).json({ error: 'That is your own email.' }); return true; }
      const a = readAccess(b.inviteCohost);
      if (!a.listingIds.length) { res.status(400).json({ error: 'Choose at least one listing for this co-host.' }); return true; }
      if (a.access === 'limited' && !a.permissions.length) { res.status(400).json({ error: 'Choose at least one thing this co-host can do.' }); return true; }
      const existing = await sql`SELECT id, status FROM cohosts WHERE host_id = ${me.host_id} AND lower(invited_email) = ${email} AND status IN ('invited', 'active')`;
      if (existing.length) { res.status(409).json({ error: existing[0].status === 'active' ? 'This person is already your co-host.' : 'You have already invited this email.' }); return true; }
      const ins = await sql`
        INSERT INTO cohosts (host_id, invited_email, access, permissions, listing_ids)
        VALUES (${me.host_id}, ${email}, ${a.access}, ${JSON.stringify(a.permissions)}::jsonb, ${a.listingIds})
        RETURNING id
      `;
      const token = inviteToken(ins[0].id);
      const names = ownListings.filter(l => a.listingIds.includes(Number(l.id))).map(l => l.property_name);
      const emailed = await emailCohostInvite({ to: email, hostName: me.name || 'Your host', access: a.access, permissions: a.permissions, listingNames: names, token });
      await logAudit(sql, { action: 'cohost_invited', success: true, actorType: 'host', actorIdentifier: String(me.host_id), targetType: 'cohost', targetId: ins[0].id, metadata: { email, access: a.access } });
      // The link is returned too, so the host can pass it on themselves
      // if the email does not arrive. It only works for that email.
      res.status(200).json({ success: true, id: ins[0].id, emailed, inviteLink: `https://aerva.in/index.html?view=cohost&invite=${encodeURIComponent(token)}` });
      return true;
    }
    if (b.updateCohost) {
      const a = readAccess(b.updateCohost);
      if (!a.listingIds.length) { res.status(400).json({ error: 'Choose at least one listing for this co-host.' }); return true; }
      if (a.access === 'limited' && !a.permissions.length) { res.status(400).json({ error: 'Choose at least one thing this co-host can do.' }); return true; }
      const upd = await sql`
        UPDATE cohosts SET access = ${a.access}, permissions = ${JSON.stringify(a.permissions)}::jsonb, listing_ids = ${a.listingIds}
        WHERE id = ${Number(b.updateCohost.id) || 0} AND host_id = ${me.host_id} AND status IN ('invited', 'active')
        RETURNING id
      `;
      if (!upd.length) { res.status(404).json({ error: 'Co-host not found.' }); return true; }
      await logAudit(sql, { action: 'cohost_updated', success: true, actorType: 'host', actorIdentifier: String(me.host_id), targetType: 'cohost', targetId: upd[0].id, metadata: a });
      res.status(200).json({ success: true });
      return true;
    }
    if (b.removeCohost) {
      const upd = await sql`
        UPDATE cohosts SET status = 'removed', removed_at = now()
        WHERE id = ${Number(b.removeCohost.id) || 0} AND host_id = ${me.host_id} AND status IN ('invited', 'active')
        RETURNING id
      `;
      if (!upd.length) { res.status(404).json({ error: 'Co-host not found.' }); return true; }
      await logAudit(sql, { action: 'cohost_removed', success: true, actorType: 'host', actorIdentifier: String(me.host_id), targetType: 'cohost', targetId: upd[0].id });
      res.status(200).json({ success: true });
      return true;
    }
    res.status(400).json({ error: 'Unknown co-host request.' });
    return true;
  } catch (err) {
    console.error('co-host request failed:', err);
    res.status(500).json({ error: 'Could not complete that co-host request right now.' });
    return true;
  }
}

// An identity document must be a file uploaded to Aerva's own Blob store
// (blob-upload.js) — never any web address a request happens to carry. It
// is also what lets the admin delete it after review: a file anywhere else
// could not be deleted by us at all.
function isAervaBlobUrl(url) {
  return typeof url === 'string' && /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/[^\s]+$/i.test(url);
}
const ENCRYPTION_UNAVAILABLE = 'Bank and PAN details cannot be saved right now. Please try again later, or write to hello@aerva.in.';

module.exports = async (req, res) => {
  // Typed text can never become markup — see _plain-text.js.
  sanitizeBody(req);

  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // `let`, not `const`: a co-host request continues below AS the host it
  // is working for, once cohostGate() has checked what it may do.
  let guestId = requireGuestId(req);
  let cohostActor = null; // set when a co-host acts for the host (?actingHost=)
  if (!guestId) return res.status(401).json({ error: 'Please log in again.' });
  if (await isAccountDeleted(sql, guestId)) return res.status(401).json({ error: 'This account has been deleted.' });
  const accountId = guestId; // the person actually signed in, always

  // ---- Host agreement: one-time acceptance for hosts who listed before
  // it existed (new hosts accept it when submitting a listing) ----
  // GET ?hostAgreement=1 → { isHost, accepted, version }
  if (req.method === 'GET' && (req.query || {}).hostAgreement === '1' && (req.query || {}).actingHost === undefined) {
    try {
      const g = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
      if (!g[0] || !g[0].host_id) return res.status(200).json({ isHost: false, accepted: false, version: AGREEMENT_VERSION });
      let v = null;
      try { v = (await sql`SELECT host_agreement_version FROM hosts WHERE id = ${g[0].host_id}`)[0]?.host_agreement_version || null; }
      catch (err) { console.error('host agreement status unavailable:', err.message); }
      return res.status(200).json({ isHost: true, accepted: v === AGREEMENT_VERSION, version: AGREEMENT_VERSION });
    } catch (err) {
      return res.status(500).json({ error: 'Could not check the host agreement right now.' });
    }
  }
  // POST { acceptHostAgreement: { version } }
  if (req.method === 'POST' && req.body && req.body.acceptHostAgreement && (req.query || {}).actingHost === undefined) {
    try {
      const g = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
      if (!g[0] || !g[0].host_id) return res.status(403).json({ error: 'Only hosts accept the host agreement.' });
      if ((req.body.acceptHostAgreement || {}).version !== AGREEMENT_VERSION) {
        return res.status(400).json({ error: 'Please accept the current host agreement.', agreementVersion: AGREEMENT_VERSION });
      }
      const ctx = requestContext(req);
      await sql`UPDATE hosts SET host_agreement_version = ${AGREEMENT_VERSION}, host_agreement_accepted_at = now(), host_agreement_ip = ${ctx.ip} WHERE id = ${g[0].host_id}`;
      await logAudit(sql, { action: 'host_agreement_accepted', success: true, actorType: 'host', actorIdentifier: String(g[0].host_id),
        targetType: 'host', targetId: g[0].host_id, metadata: { version: AGREEMENT_VERSION, ip: ctx.ip, via: 'dashboard' } });
      return res.status(200).json({ success: true, version: AGREEMENT_VERSION });
    } catch (err) {
      console.error('acceptHostAgreement failed:', err);
      return res.status(500).json({ error: 'Could not save your acceptance right now. Please try again.' });
    }
  }

  // ---- Co-hosts: managing them, and being one ----
  const handledCohost = await handleCohostModes(req, res, accountId);
  if (handledCohost) return;

  // ---- Payouts sent to me (as host, or as a co-host) ----
  // GET ?myPayouts=1 → list; GET ?payoutDetail=<id> → one summary. Only
  // ever the signed-in person's own payouts.
  if (req.method === 'GET' && req.query && (req.query.myPayouts === '1' || req.query.payoutDetail !== undefined) && req.query.actingHost === undefined) {
    try {
      const me = (await sql`SELECT host_id FROM guests WHERE id = ${accountId}`)[0] || {};
      if (req.query.payoutDetail !== undefined) {
        const sum = await loadPayoutSummary(sql, req.query.payoutDetail);
        // The host sees every payout on their bookings (theirs and their
        // co-hosts'); a co-host sees their own and the host's, on listings
        // they co-host.
        let allowed = sum && ((me.host_id && sum.hostId === me.host_id) || (sum.payeeType === 'cohost' && sum.payeeGuestId === accountId));
        if (sum && !allowed) {
          const shared = await sql`SELECT 1 FROM cohosts c JOIN orders o ON o.id = ${sum.orderId}
                                   WHERE c.cohost_guest_id = ${accountId} AND c.status = 'active' AND c.host_id = ${sum.hostId}
                                     AND o.listing_id = ANY(c.listing_ids) LIMIT 1`.catch(() => []);
          allowed = shared.length > 0;
        }
        if (!allowed || sum.status !== 'sent') return res.status(404).json({ error: 'Payout not found.' });
        return res.status(200).json({ payout: { ...sum, viewerIsPayee: (sum.payeeType === 'host' ? sum.hostId === me.host_id : sum.payeeGuestId === accountId) } });
      }
      let rows = [];
      try {
        rows = await sql`
          SELECT p.id, p.net, p.sent_at, p.arriving_by, p.payee_type, p.payee_guest_id, p.host_id, o.suite_name, o.arrival, o.departure,
                 CASE WHEN p.payee_type = 'host' THEN h.name ELSE pg.name END AS payee_name
          FROM payouts p JOIN orders o ON o.id = p.order_id JOIN hosts h ON h.id = p.host_id LEFT JOIN guests pg ON pg.id = p.payee_guest_id
          WHERE p.status = 'sent' AND (p.host_id = ${me.host_id || 0}
             OR (p.payee_type = 'cohost' AND p.payee_guest_id = ${accountId})
             OR EXISTS (SELECT 1 FROM cohosts c WHERE c.cohost_guest_id = ${accountId} AND c.status = 'active' AND c.host_id = p.host_id AND o.listing_id = ANY(c.listing_ids)))
          ORDER BY p.sent_at DESC LIMIT 200
        `;
      } catch (err) { /* migration_payouts.sql not run yet */ }
      return res.status(200).json({ payouts: rows.map(r => ({ id: r.id, amount: Number(r.net), sentAt: r.sent_at, arrivingBy: r.arriving_by, as: r.payee_type,
        payeeName: r.payee_name || '', mine: r.payee_type === 'host' ? (me.host_id != null && r.host_id === me.host_id) : r.payee_guest_id === accountId,
        listing: r.suite_name, arrival: r.arrival, departure: r.departure })) });
    } catch (err) {
      console.error('payouts view failed:', err);
      return res.status(500).json({ error: 'Could not load payouts right now.' });
    }
  }

  // ---- A co-host working on a host's listings (?actingHost=<hostId>) ----
  if (req.query && req.query.actingHost !== undefined) {
    const gate = await cohostGate(req, res, accountId);
    if (!gate) return; // already answered with 403 / 400
    guestId = gate.ctx.ownerGuestId;
    cohostActor = { cohostId: gate.ctx.cohostId, guestId: accountId, ctx: gate.ctx };
  }

  // ---- Send an OTP to verify a host's phone number ----
  // Country-aware format validation (length + digits-only) happens
  // here, server-side, before anything is "sent" — never trusts
  // whatever the frontend already checked, since a direct API call
  // could skip that entirely. Actual SMS delivery is intentionally NOT
  // wired to a real provider yet — see the comment on otpForTesting
  // below for why, and what changes once a provider is chosen.
  if (req.method === 'POST' && req.body && req.body.sendHostPhoneOtp) {
    try {
      const { countryCode, localNumber } = req.body.sendHostPhoneOtp;
      const validation = validatePhoneNumber(countryCode, localNumber);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      const guestRows = await sql`SELECT host_id, email FROM guests WHERE id = ${guestId}`;
      const guest = guestRows[0];
      if (!guest || !guest.host_id) {
        return res.status(403).json({ error: 'You do not have permission to do this.' });
      }

      // Rate-limited per host (not just per IP) — a host retrying OTP
      // requests for their own number shouldn't be able to spam
      // themselves (or, if their session were somehow compromised,
      // spam an SMS provider's bill) unlimited times.
      const recentSends = await countRecentAttempts(sql, {
        action: 'host_phone_otp_sent', windowMinutes: 10, byEmail: String(guest.host_id)
      });
      if (recentSends >= 5) {
        return res.status(429).json({ error: 'Too many OTP requests — please wait a few minutes and try again.' });
      }

      const otp = String(crypto.randomInt(100000, 1000000)); // 6 digits, never starts with 0 so it always displays as 6 characters
      const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
      const OTP_LIFETIME_MINUTES = 10;

      await sql`
        UPDATE hosts SET
          phone_country_code = ${countryCode}, phone_otp_hash = ${otpHash},
          phone_otp_expires_at = now() + (${OTP_LIFETIME_MINUTES} || ' minutes')::interval,
          phone_otp_attempts = 0, phone_verified = FALSE
        WHERE id = ${guest.host_id}
      `;

      await logAudit(sql, {
        action: 'host_phone_otp_sent', success: true, actorType: 'host', actorIdentifier: String(guest.host_id),
        targetType: 'host', targetId: guest.host_id, metadata: { ip: getClientIp(req), countryCode }
      });

      // No real SMS provider is connected yet ("we'll take services
      // based on country the host belongs to, later on" — per the
      // request this was built for) — the OTP mechanism itself (
      // generation, hashing, expiry, attempt-limiting, verification) is
      // fully real and working; only the delivery step is a placeholder.
      // Returned directly in the response for now so the flow is
      // actually testable end to end without a provider connected —
      // this MUST be removed the moment a real SMS integration is
      // wired in, since shipping this to production as-is would defeat
      // the entire point of an OTP.
      return res.status(200).json({ success: true, otpForTesting: otp, note: 'No SMS provider connected yet — this code is returned directly for testing. Remove this field once a real provider is wired in.' });
    } catch (err) {
      console.error('host-listings (sendHostPhoneOtp) error:', err);
      return res.status(500).json({ error: 'Could not send a verification code right now. Please try again.' });
    }
  }

  // ---- Verify the OTP just sent ----
  if (req.method === 'POST' && req.body && req.body.verifyHostPhoneOtp) {
    try {
      const { otp } = req.body.verifyHostPhoneOtp;
      if (!otp || typeof otp !== 'string' || !/^[0-9]{6}$/.test(otp.trim())) {
        return res.status(400).json({ error: 'Please enter the 6-digit code.' });
      }

      const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
      const guest = guestRows[0];
      if (!guest || !guest.host_id) {
        return res.status(403).json({ error: 'You do not have permission to do this.' });
      }

      const hostRows = await sql`
        SELECT phone_otp_hash, phone_otp_expires_at, phone_otp_attempts
        FROM hosts WHERE id = ${guest.host_id}
      `;
      const host = hostRows[0];
      if (!host || !host.phone_otp_hash) {
        return res.status(400).json({ error: 'No verification code was requested — please request a new one.' });
      }
      if (new Date(host.phone_otp_expires_at) < new Date()) {
        return res.status(400).json({ error: 'This code has expired — please request a new one.' });
      }
      // Five wrong guesses invalidates the code entirely, rather than
      // leaving it guessable indefinitely within its 10-minute window —
      // a fresh OTP request is required after this, same recovery path
      // as an expired code.
      if (host.phone_otp_attempts >= 5) {
        return res.status(400).json({ error: 'Too many incorrect attempts — please request a new code.' });
      }

      const submittedHash = crypto.createHash('sha256').update(otp.trim()).digest('hex');
      if (submittedHash !== host.phone_otp_hash) {
        await sql`UPDATE hosts SET phone_otp_attempts = phone_otp_attempts + 1 WHERE id = ${guest.host_id}`;
        await logAudit(sql, {
          action: 'host_phone_otp_verified', success: false, actorType: 'host', actorIdentifier: String(guest.host_id),
          targetType: 'host', targetId: guest.host_id, metadata: { ip: getClientIp(req) }
        });
        return res.status(400).json({ error: 'Incorrect code — please try again.' });
      }

      await sql`
        UPDATE hosts SET phone_verified = TRUE, phone_otp_hash = NULL, phone_otp_expires_at = NULL, phone_otp_attempts = 0
        WHERE id = ${guest.host_id}
      `;
      await logAudit(sql, {
        action: 'host_phone_otp_verified', success: true, actorType: 'host', actorIdentifier: String(guest.host_id),
        targetType: 'host', targetId: guest.host_id, metadata: {}
      });
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('host-listings (verifyHostPhoneOtp) error:', err);
      return res.status(500).json({ error: 'Could not verify this code right now. Please try again.' });
    }
  }

  // ---- Unified 30-day status across this host's WHOLE portfolio, one
  // row per listing — the "Status" tab on host-dashboard.html. Separate
  // from the per-room Calendar tab on manage-listing.html, which is the
  // detailed view for ONE Resort at a time; this is the fast, at-a-
  // glance overview across everything a host manages.
  // ---- Host analytics ----
  // GET ?analytics=1 — one fetch returning the host's OWN paid bookings
  // aggregated by (month × listing × timing bucket), for a two-year
  // window. Folded in here as a mode rather than added as
  // /api/analytics.js because this project is at Vercel's 12-function
  // Hobby limit; a 13th file fails the whole deploy.
  //
  // Deliberately returns the GRAIN, not finished totals. Every filter the
  // dashboard offers — by listing, by stays vs experiences, by year,
  // month drill-down, year-on-year comparison — is a different grouping
  // of these same rows, so shipping the grain once lets all of that
  // happen instantly in the browser instead of a round trip per click.
  // The row count stays small: at most 24 months × listings × 3 buckets,
  // and only combinations that actually have a booking appear at all.
  //
  // Money is bucketed by the BOOKING month (orders.created_at), because
  // that is when the host is actually paid — the full payout lands at
  // booking time, not at check-in. Bucketing by arrival would report
  // money in a month it never arrived in.
  //
  // Each booking is then marked by whether its STAY has been delivered:
  //   current  — the guest has arrived (stay under way or finished)
  //   upcoming — the stay is still ahead
  // So 'upcoming' is revenue already banked against nights not yet
  // delivered: the host has the money but still owes the stay. Splitting
  // on booking month is what makes both meaningful at once — within one
  // arrival month every stay is either all past or all future, so that
  // grouping could never show both.
  //
  // Order status is returned as part of the grain rather than filtered
  // here, so the dashboard can answer "how many bookings did we take
  // that month" including ones later cancelled or refunded — history a
  // paid-only query erases. The dashboard defaults to paid, so money
  // figures are unaffected unless the host deliberately widens it.
  // ---- Host reviews a guest ----
  // POST { reviewGuest: { orderId, cleanliness, communication, respectful,
  // rules, comment } }
  //
  // Mirror of the guest's property review in guest-profile.js: all four
  // ratings and the comment mandatory, one per booking, inside the same
  // window, and published by the same daily sweep rather than here.
  if (req.method === 'POST' && req.body && req.body.reviewGuest) {
    try {
      const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
      const me = guestRows[0];
      if (!me || !me.host_id) return res.status(403).json({ error: 'You do not have permission to do this.' });

      const b = req.body.reviewGuest || {};
      const orderId = Number(b.orderId);
      if (!orderId) return res.status(400).json({ error: 'Which booking is this review for?' });

      // Scoped through listings.host_id, so a host can only ever review a
      // guest who actually stayed at one of their own properties.
      const rows = await sql`
        SELECT o.id, o.listing_id, o.guest_id, o.departure, o.status,
               (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), ${DEFAULT_TIMEZONE}))::date AS local_today
        FROM orders o JOIN listings l ON l.id = o.listing_id
        WHERE o.id = ${orderId} AND l.host_id = ${me.host_id}
      `;
      const order = rows[0];
      if (!order) return res.status(404).json({ error: 'Booking not found.' });
      if (order.status !== 'paid') return res.status(400).json({ error: 'Only completed stays can be reviewed.' });
      if (!order.guest_id) return res.status(400).json({ error: 'This booking has no guest account to review.' });
      // Judged on the property's calendar, not the server's.
      if (!submissionOpen(order.departure, order.local_today)) {
        return res.status(400).json({ error: `Reviews can be left for ${REVIEW_WINDOW_DAYS} days after checkout. This window has closed.` });
      }

      const FIELDS = ['cleanliness', 'communication', 'respectful', 'rules'];
      const vals = {};
      for (const f of FIELDS) {
        const v = Number(b[f]);
        if (!Number.isFinite(v) || v < 1 || v > 5) {
          return res.status(400).json({ error: `Please rate ${f === 'rules' ? 'rules followed' : f} between 1 and 5.` });
        }
        vals[f] = v;
      }
      const comment = typeof b.comment === 'string' ? b.comment.trim() : '';
      if (comment.length < 10) return res.status(400).json({ error: 'Please write a few words about this guest.' });

      // guest_reviews.rating predates the factor columns and is still read
      // by older code paths, so it is kept in step: the plain mean of the
      // four, not a weighted score, because that is what it always meant.
      // ROUNDED: the column is smallint in Neon, and any mean that is not a
      // whole number (5,4,4,4 -> 4.25) was rejected by Postgres, failing
      // the whole review with a 500. Nothing scores from this column any
      // more — standing uses the four factor columns — so rounding loses
      // nothing that matters.
      const blended = Math.round(FIELDS.reduce((a, f) => a + vals[f], 0) / FIELDS.length);

      const existing = await sql`SELECT id FROM guest_reviews WHERE order_id = ${order.id}`;
      if (existing.length) return res.status(409).json({ error: 'You have already reviewed this stay.' });

      const inserted = await sql`
        INSERT INTO guest_reviews
          (order_id, guest_id, host_id, listing_id, rating, comment,
           cleanliness, communication, respectful, rules)
        VALUES
          (${order.id}, ${order.guest_id}, ${me.host_id}, ${order.listing_id}, ${blended}, ${comment},
           ${vals.cleanliness}, ${vals.communication}, ${vals.respectful}, ${vals.rules})
        RETURNING id
      `;
      await logAudit(sql, {
        action: 'guest_review_submitted', success: true, actorType: 'host', actorIdentifier: String(guestId),
        targetType: 'guest_review', targetId: inserted[0].id,
        metadata: { orderId: order.id, guestId: order.guest_id }
      });
      return res.status(200).json({ success: true, held: true });
    } catch (err) {
      console.error('reviewGuest error:', err);
      return res.status(500).json({ error: 'Could not save your review right now.' });
    }
  }

  // ---- Host sends feedback about the website ----
  // POST { hostFeedback: { email, phone, category, message } }
  // One form for a host to tell Aerva something needs fixing or changing.
  // Email AND phone are both required: the point is being able to call
  // them back and understand the problem, and an email address alone has
  // repeatedly not been enough for that.
  //
  // Stored in audit_log rather than a new table, so this needs no
  // migration; the full message lives in the metadata. Also emailed to
  // hello@aerva.in so nobody has to remember to go and look.
  if (req.method === 'POST' && req.body && req.body.hostFeedback) {
    const fb = req.body.hostFeedback || {};
    const email = String(fb.email || '').trim().toLowerCase();
    const phoneRaw = String(fb.phone || '').trim();
    const message = String(fb.message || '').trim();
    const category = String(fb.category || 'Other').trim().slice(0, 60);

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter an email address we can reply to.' });
    }
    // Same normaliser the rest of the platform uses, so a number typed
    // any of the usual ways is accepted and stored one way.
    const phone = normalizeToE164(phoneRaw);
    if (!phone) {
      return res.status(400).json({ error: 'Please enter a phone number with country code, like +919876543210, so we can call you back.' });
    }
    if (message.length < 10) {
      return res.status(400).json({ error: 'Please tell us a little more about what needs looking at (at least 10 characters).' });
    }
    if (message.length > 4000) {
      return res.status(400).json({ error: 'That message is too long — please keep it under 4000 characters.' });
    }

    // A host could otherwise paste the same thing repeatedly, by accident
    // or otherwise, and every one of those is an email to the team.
    const recent = await countRecentAttempts(sql, {
      action: 'host_feedback', windowMinutes: 60, byActor: String(guestId), onlyFailures: false
    });
    if (recent >= 5) {
      return res.status(429).json({ error: 'Thanks — we have your messages. Please give us a little time to come back to you before sending more.' });
    }

    const who = await sql`
      SELECT g.id, g.name, g.email AS account_email, h.id AS host_id
      FROM guests g LEFT JOIN hosts h ON h.id = g.host_id
      WHERE g.id = ${guestId}
    `;
    const me = who[0] || {};

    await logAudit(sql, {
      action: 'host_feedback', success: true, actorType: 'host', actorIdentifier: String(guestId),
      targetType: 'host', targetId: me.host_id || null,
      metadata: {
        category, message, replyEmail: email, replyPhone: phone,
        accountEmail: me.account_email || null, name: me.name || null, ip: getClientIp(req)
      }
    });

    // Emailed for visibility. A send failure must not lose the feedback —
    // it is already recorded above — so the host still gets a thank you.
    try {
      if (process.env.RESEND_API_KEY) {
        const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const html = `
          <div style="font-family:sans-serif; max-width:560px;">
            <h2 style="font-family:Georgia,serif;">Host feedback: ${esc(category)}</h2>
            <p><strong>${esc(me.name || 'A host')}</strong> (account ${esc(me.account_email || '—')}, host id ${esc(me.host_id || '—')})</p>
            <p>Reply to: <strong>${esc(email)}</strong> &middot; <strong>${esc(phone)}</strong></p>
            <hr>
            <p style="white-space:pre-wrap;">${esc(message)}</p>
          </div>`;
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Aerva <hello@aerva.in>', to: 'hello@aerva.in', reply_to: email,
            subject: `Host feedback (${category}) from ${me.name || email}`, html
          })
        });
      }
    } catch (err) {
      console.error('host feedback email failed (feedback itself is saved):', err);
    }

    return res.status(200).json({ success: true, message: 'Thank you — we have your note and will be in touch on the number you gave us.' });
  }

  // ---- Host views a guest's profile ----
  // GET ?guestProfileForOrder=<orderId>
  // Only a guest's NAME and the published reviews other hosts have left
  // about them — never email, phone, photo, spend or booking history.
  //
  // Keyed on the BOOKING, not a guest id, so a host can only ever look up
  // someone who actually booked one of their own properties. Allowed from
  // the moment the booking is confirmed, and still after checkout or a
  // cancellation — the relationship happened, so the host keeps the view.
  if (req.method === 'GET' && req.query.guestProfileForOrder !== undefined) {
    try {
      const orderId = Number(req.query.guestProfileForOrder);
      if (!orderId) return res.status(400).json({ error: 'Which booking?' });
      const meRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
      const me = meRows[0];
      if (!me || !me.host_id) return res.status(403).json({ error: 'You do not have permission to do this.' });

      const rows = await sql`
        SELECT o.guest_id, g.id, g.name, g.created_at, g.profile_photo_url, g.host_id,
               g.profile_work, g.profile_hobbies, g.profile_about
        FROM orders o
        JOIN listings l ON l.id = o.listing_id
        JOIN guests g ON g.id = o.guest_id
        WHERE o.id = ${orderId} AND l.host_id = ${me.host_id}
          AND o.status IN ('paid', 'cancelled')
      `;
      // Same answer for "not yours" and "does not exist": a host must not
      // be able to probe which booking ids are real.
      if (!rows.length) return res.status(404).json({ error: 'Booking not found.' });
      const guest = rows[0];

      // Published and not reverted only — exactly what the review policy
      // allows anyone to read. A review still held (double-blind) stays
      // hidden, including the viewing host's own.
      const reviews = await sql`
        SELECT published_at, comment, rating, cleanliness, communication, respectful, rules
        FROM guest_reviews
        WHERE guest_id = ${guest.guest_id}
          AND published_at IS NOT NULL AND admin_reverted_at IS NULL
        ORDER BY published_at DESC, id DESC
        LIMIT 50
      `;
      const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };
      const pick = (f) => GUEST_FACTORS.map(x => ({ key: x.key, label: x.label, value: Number(f[x.key].toFixed(2)) })).filter(x => x.value > 0);
      const out = reviews.map(r => {
        const f = { cleanliness: n(r.cleanliness), communication: n(r.communication), respectful: n(r.respectful), rules: n(r.rules) };
        const rated = GUEST_FACTORS.some(x => f[x.key] > 0);
        const d = new Date(r.published_at);
        return {
          month: isNaN(d) ? null : d.toISOString().slice(0, 7),
          // Older reviews carry only the single overall rating.
          score: rated ? reviewScore(f, GUEST_FACTORS) : (n(r.rating) || null),
          factors: rated ? pick(f) : [],
          comment: String(r.comment || '')
        };
      });
      const rated = reviews.filter(r => r.cleanliness != null);
      const avg = (k) => rated.reduce((a, r) => a + n(r[k]), 0) / (rated.length || 1);
      const sumF = rated.length ? { cleanliness: avg('cleanliness'), communication: avg('communication'), respectful: avg('respectful'), rules: avg('rules') } : null;
      // The same three sections a guest sees on a host's profile: who
      // they are, where they have been with Aerva, and what others have
      // said. Still no email, phone or spend — see the note above.
      const profile = await buildProfile(sql, guest);

      return res.status(200).json({
        guest: { name: profile.name },
        profile,
        summary: sumF ? { count: reviews.length, score: reviewScore(sumF, GUEST_FACTORS), factors: pick(sumF) } : { count: reviews.length },
        reviews: out
      });
    } catch (err) {
      console.error('guestProfileForOrder error:', err);
      return res.status(500).json({ error: 'Could not load this guest right now.' });
    }
  }

  if (req.method === 'GET' && req.query.analytics === '1') {
    try {
      const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
      const guest = guestRows[0];
      if (!guest || !guest.host_id) return res.status(403).json({ error: 'You do not have permission to do this.' });

      // Exactly two calendar years — this year and last — which is the
      // only comparison the dashboard offers. Anchored on the server's
      // date so the two years can't disagree with the bucket CASE below.
      const thisYear = new Date().getUTCFullYear();
      const prevYear = thisYear - 1;
      const windowStart = `${prevYear}-01-01`;
      const windowEnd = `${thisYear + 1}-01-01`;

      // past / current / upcoming is about the STAY, not the payment:
      // every row here is already paid. A booking whose guest has checked
      // out is earned, one mid-stay is in progress, one still ahead is
      // expected income the host hasn't realised yet. departure is the
      // day the guest leaves, so departure <= today means fully over.
      const rows = await sql`
        SELECT to_char(date_trunc('month', o.created_at), 'YYYY-MM') AS month,
               to_char(date_trunc('month', o.arrival), 'YYYY-MM')    AS "stayMonth",
               o.listing_id                                        AS "listingId",
               l.property_name                                     AS "listingName",
               COALESCE(l.listing_type, 'stay')                     AS "listingType",
               CASE
                 WHEN o.arrival <= CURRENT_DATE THEN 'current'
                 ELSE 'upcoming'
               END                                                 AS bucket,
               o.status                                            AS status,
               COALESCE(SUM(o.total), 0)             AS gross,
               COALESCE(SUM(o.payout_amount), 0)     AS payout,
               COALESCE(SUM(o.commission_amount), 0) AS commission,
               COALESCE(SUM(o.nights), 0)            AS nights,
               COUNT(*)                              AS bookings
        FROM orders o
        JOIN listings l ON l.id = o.listing_id
        WHERE l.host_id = ${guest.host_id}
          AND o.created_at >= ${windowStart} AND o.created_at < ${windowEnd}
        GROUP BY 1, 2, 3, 4, 5, 6, 7
      `;

      // Every approved listing, including ones with no bookings at all —
      // the filter dropdown should offer them, and "this listing earned
      // nothing this year" is a real answer a host needs to see.
      const listingRows = await sql`
        SELECT id, property_name AS name, COALESCE(listing_type, 'stay') AS type
        FROM listings
        WHERE host_id = ${guest.host_id} AND status = 'approved'
        ORDER BY property_name ASC
      `;

      return res.status(200).json({
        rows: rows.map(r => ({
          month: r.month,
          stayMonth: r.stayMonth,
          listingId: r.listingId,
          listingName: r.listingName,
          listingType: r.listingType,
          bucket: r.bucket,
          status: r.status,
          gross: Number(r.gross) || 0,
          payout: Number(r.payout) || 0,
          commission: Number(r.commission) || 0,
          nights: Number(r.nights) || 0,
          bookings: Number(r.bookings) || 0
        })),
        listings: listingRows.map(l => ({ id: l.id, name: l.name, type: l.type })),
        years: [prevYear, thisYear],
        windowStart, windowEnd
      });
    } catch (err) {
      console.error('host analytics error:', err);
      return res.status(500).json({ error: 'Could not load your analytics right now.' });
    }
  }

  if (req.method === 'GET' && req.query.statusCalendar === '1') {
    try {
      const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
      const guest = guestRows[0];
      if (!guest || !guest.host_id) return res.status(403).json({ error: 'You do not have permission to do this.' });

      const listings = await sql`
        SELECT id, property_name, property_type, nightly_rate FROM listings
        WHERE host_id = ${guest.host_id} AND status = 'approved' AND listing_type = 'stay'
        ORDER BY created_at DESC
      `;

      const DAYS = 30;
      const startDate = new Date();
      startDate.setUTCHours(0, 0, 0, 0);
      const dayStrs = [];
      for (let i = 0; i < DAYS; i++) {
        const d = new Date(startDate);
        d.setUTCDate(d.getUTCDate() + i);
        dayStrs.push(d.toISOString().slice(0, 10));
      }
      const endStr = dayStrs[dayStrs.length - 1];
      const startStr = dayStrs[0];

      // Same real-price-per-date logic as the sidebar's Block Dates/
      // Promotions calendar (sbComputePriceForDate in host-dashboard.html)
      // — a promotion's discount is applied and shown as an actual rupee
      // amount, not a bare percentage, since the number a host gets paid
      // matters more here than how the discount happens to be expressed.
      // That existing function is scoped to whichever single listing is
      // currently open in the sidebar; this is the same math applied
      // across every row here at once instead.
      function priceForDate(baseRate, promotions, dateStr){
        const promo = promotions.find(p => dateStr >= p.start_date && dateStr < p.end_date);
        if (!promo) return { price: baseRate, promoName: null, promoId: null };
        const discounted = promo.discount_type === 'flat'
          ? Math.max(0, baseRate - Number(promo.discount_value))
          : Math.max(0, baseRate - Math.round(baseRate * (Number(promo.discount_value) / 100)));
        return {
          price: discounted, promoName: promo.name, promoId: promo.id,
          promoDiscountType: promo.discount_type, promoDiscountValue: promo.discount_value,
          promoMinNights: promo.min_nights, promoStartDate: promo.start_date, promoEndDate: promo.end_date,
          basePrice: baseRate,
        };
      }

      // Each ROW here is one bookable unit — a Resort's individual
      // rooms each get their own row, not aggregated into one line for
      // the whole resort, so a host can see and act on a specific
      // room's availability directly from this one view without
      // opening that listing separately.
      // Postgres DATE columns can come back from the driver as either
      // plain 'YYYY-MM-DD' strings or JS Date objects, depending on
      // subtle differences in how a column was originally defined —
      // orders/listing_blocked_dates have consistently come back as
      // strings (matching every dateStr comparison elsewhere in this
      // file), but there's no guarantee listing_promotions does too.
      // Comparing a string dateStr against a Date object with >=/< does
      // NOT throw — it just silently evaluates wrong every time, which
      // would produce exactly this symptom: a promotion saves
      // successfully but can never be found as "covering" any date.
      // Normalized here, once, right after fetching, so every
      // downstream comparison is guaranteed to be string-to-string
      // regardless of what the driver actually handed back.
      function toDateStr(d) {
        if (d instanceof Date) return d.toISOString().slice(0, 10);
        return typeof d === 'string' ? d.slice(0, 10) : d;
      }

      const rows = [];
      for (const listing of listings) {
        const rawPromotions = await sql`
          SELECT id, room_id, name, discount_type, discount_value, min_nights, start_date, end_date FROM listing_promotions
          WHERE listing_id = ${listing.id} AND is_active = TRUE
            AND start_date < ${endStr}::date AND end_date > ${startStr}::date
        `;
        const promotions = rawPromotions.map(p => ({ ...p, start_date: toDateStr(p.start_date), end_date: toDateStr(p.end_date) }));
        if (listing.property_type === 'Resort') {
          const rooms = await sql`SELECT id, room_name, nightly_rate FROM listing_rooms WHERE listing_id = ${listing.id} AND is_active = TRUE ORDER BY sort_order ASC, created_at ASC`;
          for (const room of rooms) {
            const bookedRangesRaw = await sql`
              SELECT id, arrival AS start_date, departure AS end_date, guest_email, guests, nights, total FROM orders
              WHERE room_id = ${room.id} AND status = 'paid'
                AND arrival < ${endStr}::date AND departure > ${startStr}::date
            `;
            const bookedRanges = bookedRangesRaw.map(r => ({ ...r, start_date: toDateStr(r.start_date), end_date: toDateStr(r.end_date) }));
            const blockedRangesRaw = await sql`
              SELECT start_date, end_date FROM listing_blocked_dates
              WHERE listing_id = ${listing.id} AND (room_id = ${room.id} OR room_id IS NULL)
                AND start_date < ${endStr}::date AND end_date > ${startStr}::date
            `;
            const blockedRanges = blockedRangesRaw.map(r => ({ ...r, start_date: toDateStr(r.start_date), end_date: toDateStr(r.end_date) }));
            const dayStatuses = dayStrs.map(dateStr => {
              if (bookedRanges.some(r => dateStr >= r.start_date && dateStr < r.end_date)) return 'booked';
              if (blockedRanges.some(r => dateStr >= r.start_date && dateStr < r.end_date)) return 'blocked';
              return 'available';
            });
            // A promotion scoped to THIS room, or one with no room_id at
            // all (a whole-resort promotion, still honored for every
            // room) — never a promotion scoped to a DIFFERENT room.
            const roomPromotions = promotions.filter(p => p.room_id === room.id || p.room_id === null);
            const dayPricing = dayStrs.map(dateStr => priceForDate(Number(room.nightly_rate) || 0, roomPromotions, dateStr));
            rows.push({
              listingId: listing.id, roomId: room.id, label: `${listing.property_name} — ${room.room_name || 'Room'}`,
              propertyType: listing.property_type, dayStatuses, dayPricing, bookings: bookedRanges
            });
          }
          if (!rooms.length) {
            // Previously hard-coded to price:0/no-promo regardless of
            // what was actually saved — a listing-wide promotion on a
            // Resort with no rooms yet would silently never show. Now
            // uses the real promotions list, same as the non-Resort
            // path below, with nightly_rate falling back to 0 since a
            // roomless Resort has no meaningful base rate to discount.
            const dayPricing = dayStrs.map(dateStr => priceForDate(0, promotions, dateStr));
            rows.push({ listingId: listing.id, roomId: null, label: `${listing.property_name} (no active rooms yet)`, propertyType: listing.property_type, dayStatuses: dayStrs.map(() => 'available'), dayPricing, bookings: [] });
          }
        } else {
          const bookedRangesRaw = await sql`
            SELECT id, arrival AS start_date, departure AS end_date, guest_email, guests, nights, total FROM orders
            WHERE listing_id = ${listing.id} AND status = 'paid'
              AND arrival < ${endStr}::date AND departure > ${startStr}::date
          `;
          const bookedRanges = bookedRangesRaw.map(r => ({ ...r, start_date: toDateStr(r.start_date), end_date: toDateStr(r.end_date) }));
          const blockedRangesRaw = await sql`
            SELECT start_date, end_date FROM listing_blocked_dates
            WHERE listing_id = ${listing.id}
              AND start_date < ${endStr}::date AND end_date > ${startStr}::date
          `;
          const blockedRanges = blockedRangesRaw.map(r => ({ ...r, start_date: toDateStr(r.start_date), end_date: toDateStr(r.end_date) }));
          const dayStatuses = dayStrs.map(dateStr => {
            if (bookedRanges.some(r => dateStr >= r.start_date && dateStr < r.end_date)) return 'booked';
            if (blockedRanges.some(r => dateStr >= r.start_date && dateStr < r.end_date)) return 'blocked';
            return 'available';
          });
          const dayPricing = dayStrs.map(dateStr => priceForDate(Number(listing.nightly_rate) || 0, promotions, dateStr));
          rows.push({ listingId: listing.id, roomId: null, label: listing.property_name, propertyType: listing.property_type, dayStatuses, dayPricing, bookings: bookedRanges });
        }
      }

      return res.status(200).json({ startDate: startStr, days: DAYS, rows });
    } catch (err) {
      console.error('host-listings (statusCalendar) error:', err);
      return res.status(500).json({ error: 'Could not load the status calendar right now.' });
    }
  }

  // ---- Toggle a single date blocked/unblocked directly from the
  // Status calendar's clickable cells — clicking an available day
  // blocks it, clicking a day this host already blocked removes it. A
  // real guest booking is never touched here: the frontend only ever
  // makes available/blocked cells clickable in the first place, and
  // this double-checks that server-side too, since a direct API call
  // could try to send a booked date anyway.
  // ---- Removes whichever block entry covers this date, whole entry at
  // once — regardless of whether it was a single day or a multi-day
  // range from a bulk selection. Renamed in behavior (kept the same
  // endpoint key for simplicity) from its original toggle/create-or-
  // delete design: creating a block now always goes through the
  // range-select + confirm flow below (bulkBlockRange), even for a
  // single day, matching exactly how the sidebar's per-listing
  // calendar already works — one consistent flow instead of two
  // different ones depending on whether 1 day or several were picked.
  if (req.method === 'POST' && req.body && req.body.toggleBlockedDate) {
    try {
      const { listingId, roomId, date } = req.body.toggleBlockedDate;
      if (!listingId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Missing or invalid listing/date.' });
      }
      const listingRows = await sql`
        SELECT l.id FROM listings l
        JOIN guests g ON g.host_id = l.host_id
        WHERE l.id = ${listingId} AND g.id = ${guestId}
      `;
      if (!listingRows[0]) return res.status(403).json({ error: 'You do not have permission to do this.' });

      const safeRoomId = roomId || null;
      const existing = await sql`
        SELECT id FROM listing_blocked_dates
        WHERE listing_id = ${listingId} AND (room_id = ${safeRoomId} OR room_id IS NULL)
          AND start_date <= ${date}::date AND end_date > ${date}::date
        LIMIT 1
      `;
      if (!existing[0]) {
        return res.status(400).json({ error: 'No block was found covering this date.' });
      }
      // Unblocks exactly ONE day, which usually means SPLITTING the row
      // rather than deleting it. Blocks are stored as ranges, so deleting
      // the row outright (as this used to) silently freed every other
      // night in the same block — a host clicking 15 Sep to reopen one
      // night would quietly reopen 13-20 Sep too.
      const nextDay = new Date(date + 'T00:00:00');
      nextDay.setDate(nextDay.getDate() + 1);
      const dayAfter = nextDay.toISOString().slice(0, 10);
      const targetRowId = await resolveBlockRowForRoom(sql, existing[0].id, roomId || null);
      if (targetRowId) await unblockRangeFromRow(sql, targetRowId, date, dayAfter);
      return res.status(200).json({ success: true, blocked: false });
    } catch (err) {
      console.error('host-listings (toggleBlockedDate) error:', err);
      return res.status(500).json({ error: 'Could not remove this block right now.' });
    }
  }


// NOTE on block scope (applies to toggleBlockedDate, unblockRange and the
// addPromotion overlap check below): a block row with room_id NULL is a
// LISTING-LEVEL block — for a resort, "the whole property is closed" —
// and it applies to every room. The Status calendar already draws it on
// every room row (see the (room_id = X OR room_id IS NULL) test in the
// status query). These three actions now use the same test, so what a
// host can SEE on a room row they can also ACT on. A request with no
// roomId matches NULL rows only, so a whole-listing action never reaches
// into an individual room's blocks. Consequence worth knowing: unblocking
// a listing-level block from a room row reopens that night for the whole
// resort, because that is what the row is.
  // ---- Unblock a dragged date range ----
  // scope 'selection' frees exactly the dates the host dragged over,
  // splitting or trimming each overlapping block row. scope 'wholeBlock'
  // deletes every block row the selection touches, even the parts outside
  // it — the "remove the whole block, not just these nights" choice the
  // Status calendar offers when a drag lands inside a longer block.
  if (req.method === 'POST' && req.body && req.body.unblockRange) {
    try {
      const { listingId, roomId, startDate, endDate, scope } = req.body.unblockRange;
      if (!listingId || !startDate || !endDate
          || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        return res.status(400).json({ error: 'Missing or invalid listing/date range.' });
      }
      if (endDate <= startDate) {
        return res.status(400).json({ error: 'That date range is empty.' });
      }
      const owns = await sql`
        SELECT l.id FROM listings l
        JOIN guests g ON g.host_id = l.host_id
        WHERE l.id = ${listingId} AND g.id = ${guestId}
      `;
      if (!owns[0]) return res.status(403).json({ error: 'You do not have permission to do this.' });

      const safeRoomId = roomId || null;
      // Overlap test for two half-open ranges: they overlap when each
      // starts before the other ends.
      const overlapping = await sql`
        SELECT id FROM listing_blocked_dates
        WHERE listing_id = ${listingId}
          AND (room_id = ${safeRoomId} OR room_id IS NULL)
          AND start_date < ${endDate}::date AND end_date > ${startDate}::date
      `;
      if (!overlapping.length) {
        return res.status(400).json({ error: 'No blocked dates were found in that range.' });
      }

      if (scope === 'wholeBlock') {
        for (const r of overlapping) {
          const targetRowId = await resolveBlockRowForRoom(sql, r.id, safeRoomId);
          if (targetRowId) await sql`DELETE FROM listing_blocked_dates WHERE id = ${targetRowId}`;
        }
      } else {
        for (const r of overlapping) {
          const targetRowId = await resolveBlockRowForRoom(sql, r.id, safeRoomId);
          if (targetRowId) await unblockRangeFromRow(sql, targetRowId, startDate, endDate);
        }
      }
      return res.status(200).json({ success: true, affected: overlapping.length });
    } catch (err) {
      console.error('host-listings (unblockRange) error:', err);
      return res.status(500).json({ error: 'Could not unblock those dates right now.' });
    }
  }

  // ---- Bulk block a whole date range in one action — the drag-select
  // outcome on the Status page's calendar, matching the same "select a
  // range, then Block or Add Promotion" flow the sidebar's per-listing
  // calendar already offers, just extended to work across every
  // listing/room from one shared view instead of one listing at a time.
  if (req.method === 'POST' && req.body && req.body.bulkBlockRange) {
    try {
      const { listingId, roomId, startDate, endDate, reason } = req.body.bulkBlockRange;
      if (!listingId || !startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        return res.status(400).json({ error: 'Missing or invalid listing/date range.' });
      }
      const listingRows = await sql`
        SELECT l.id FROM listings l
        JOIN guests g ON g.host_id = l.host_id
        WHERE l.id = ${listingId} AND g.id = ${guestId}
      `;
      if (!listingRows[0]) return res.status(403).json({ error: 'You do not have permission to do this.' });

      if (roomId) {
        const roomRows = await sql`SELECT id FROM listing_rooms WHERE id = ${roomId} AND listing_id = ${listingId}`;
        if (!roomRows[0]) return res.status(400).json({ error: 'That room could not be found on this listing.' });
      }

      const safeRoomId = roomId || null;
      const bookedRows = safeRoomId
        ? await sql`
            SELECT 1 FROM orders
            WHERE status = 'paid' AND room_id = ${safeRoomId}
              AND arrival < ${endDate}::date AND departure > ${startDate}::date
            LIMIT 1
          `
        : await sql`
            SELECT 1 FROM orders
            WHERE status = 'paid' AND listing_id = ${listingId}
              AND arrival < ${endDate}::date AND departure > ${startDate}::date
            LIMIT 1
          `;
      if (bookedRows[0]) {
        return res.status(400).json({ error: 'Part of this range already has a real booking — please adjust the dates and try again.' });
      }

      await sql`
        INSERT INTO listing_blocked_dates (listing_id, room_id, start_date, end_date, reason)
        VALUES (${listingId}, ${safeRoomId}, ${startDate}::date, ${endDate}::date, ${reason && reason.trim() ? reason.trim() : 'Blocked by host'})
      `;
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('host-listings (bulkBlockRange) error:', err);
      return res.status(500).json({ error: 'Could not block this range right now.' });
    }
  }

  // ---- Add a promotion over a selected range — same drag-select flow
  // as above, the other of the two outcomes offered for a selection.
  // roomId is optional: when provided (a Resort room's row was
  // selected), the promotion is scoped to that one room only — every
  // other room at the same resort keeps its own separate pricing,
  // untouched. Omitted for a non-Resort listing, which has no rooms to
  // scope to, matching the previous whole-listing-only behavior exactly.
  if (req.method === 'POST' && req.body && req.body.addPromotion) {
    try {
      const { listingId, roomId, name, discountType, discountValue, minNights, startDate, endDate } = req.body.addPromotion;
      if (!listingId || !startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        return res.status(400).json({ error: 'Missing or invalid listing/date range.' });
      }
      if (!name || !name.trim()) return res.status(400).json({ error: 'Please give this promotion a name.' });
      if (discountType !== 'flat' && discountType !== 'percentage') return res.status(400).json({ error: 'Invalid discount type.' });
      const value = Number(discountValue);
      if (!value || value <= 0) return res.status(400).json({ error: 'Please enter a discount amount greater than 0.' });
      if (discountType === 'percentage' && value > 100) return res.status(400).json({ error: "A percentage discount can't be more than 100." });

      const listingRows = await sql`
        SELECT l.id FROM listings l
        JOIN guests g ON g.host_id = l.host_id
        WHERE l.id = ${listingId} AND g.id = ${guestId}
      `;
      if (!listingRows[0]) return res.status(403).json({ error: 'You do not have permission to do this.' });

      const safeRoomId = roomId || null;

      // A promotion can't sit on top of a blocked night. Blocked means the
      // night isn't for sale at all, so discounting it would advertise a
      // price for something nobody can book. The host has to unblock
      // first. Checked HERE and not only in the UI because a promotion is
      // set as a RANGE — a host can widen the window across blocked
      // nights without ever clicking one of them, so the calendar's own
      // "clicking a blocked date only offers unblock" behaviour can't
      // catch this case on its own.
      //
      // Blocking OVER an existing promotion stays allowed and is the
      // reverse direction: the block simply wins, and once blocked the
      // same rule applies again if the host later wants to re-promote.
      const blockedOverlap = await sql`
        SELECT start_date, end_date FROM listing_blocked_dates
        WHERE listing_id = ${listingId}
          AND (room_id = ${safeRoomId} OR room_id IS NULL)
          AND start_date < ${endDate}::date AND end_date > ${startDate}::date
        ORDER BY start_date ASC
      `;
      // The promotion runs up to — but not into — the first blocked
      // night, and stops there. The nights after the block aren't
      // silently included: the host returns to the calendar, clicks the
      // next open date, and sets a second promotion for that stretch.
      // That keeps each promotion a continuous window over nights that
      // are actually for sale, instead of one entry that pretends to
      // cover dates nobody can book.
      let effectiveEndDate = endDate;
      let truncatedAt = null;
      let resumeFrom = null; // first open night after the block, for the client to continue from
      if (blockedOverlap.length) {
        const firstBlockedStart = new Date(blockedOverlap[0].start_date).toISOString().slice(0, 10);
        if (firstBlockedStart <= startDate) {
          // The very first night asked for is already blocked, so there's
          // nothing to apply at all.
          return res.status(409).json({
            error: 'Those nights are blocked. Unblock them first, then add the promotion.'
          });
        }
        effectiveEndDate = firstBlockedStart; // exclusive, so it stops the night before
        truncatedAt = firstBlockedStart;
        // end_date is exclusive in storage, so it IS the first night that
        // is open again. The client moves its start date here so the host
        // can add the next stretch with one more click, without being
        // told anything — the calendar makes it obvious what happened.
        resumeFrom = new Date(blockedOverlap[0].end_date).toISOString().slice(0, 10);
      }

      if (safeRoomId) {
        const roomRows = await sql`SELECT id FROM listing_rooms WHERE id = ${safeRoomId} AND listing_id = ${listingId}`;
        if (!roomRows[0]) return res.status(400).json({ error: 'That room could not be found on this listing.' });
      }

      await sql`
        INSERT INTO listing_promotions (listing_id, room_id, name, discount_type, discount_value, min_nights, start_date, end_date, is_active)
        VALUES (${listingId}, ${safeRoomId}, ${name.trim()}, ${discountType}, ${value}, ${minNights ? Number(minNights) : null}, ${startDate}::date, ${effectiveEndDate}::date, TRUE)
      `;
      if (truncatedAt) {
        return res.status(200).json({ success: true, resumeFrom });
      }
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('host-listings (addPromotion) error:', err);
      return res.status(500).json({ error: 'Could not add this promotion right now.' });
    }
  }

  // ---- Removes an entire promotion, whole entry at once — the Status
  // page's equivalent of clicking a promoted date on the sidebar
  // calendar. Deliberately simple: removes the whole promotion, not a
  // single day carved out of it — the sidebar calendar offers that finer
  // single-day-exception option (sbRemovePromoForSingleDay) because it's
  // scoped to one listing already open for editing; here, offering
  // full removal only keeps the interaction fast across a multi-listing
  // view.
  if (req.method === 'POST' && req.body && req.body.removePromotion) {
    try {
      const { promotionId } = req.body.removePromotion;
      if (!promotionId) return res.status(400).json({ error: 'Missing promotion.' });
      const rows = await sql`
        SELECT lp.id FROM listing_promotions lp
        JOIN listings l ON l.id = lp.listing_id
        JOIN guests g ON g.host_id = l.host_id
        WHERE lp.id = ${promotionId} AND g.id = ${guestId}
      `;
      if (!rows[0]) return res.status(403).json({ error: 'You do not have permission to do this.' });
      await sql`DELETE FROM listing_promotions WHERE id = ${promotionId}`;
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('host-listings (removePromotion) error:', err);
      return res.status(500).json({ error: 'Could not remove this promotion right now.' });
    }
  }

  // ---- Remove ONE night from a promotion ----
  // The Status page's "Remove for this day only", matching the host
  // dashboard's same button. A promotion is stored as one date range, so
  // taking a single night out means trimming an end or splitting it into
  // two rows around the night — exactly what unblockRangeFromRow does for
  // blocks. Deleting the row (removePromotion above) stays as "Remove
  // entire promotion".
  if (req.method === 'POST' && req.body && req.body.removePromotionDay) {
    try {
      const { promotionId, date } = req.body.removePromotionDay;
      if (!promotionId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Missing promotion or date.' });
      }
      const rows = await sql`
        SELECT lp.id, lp.listing_id, lp.room_id, lp.name, lp.discount_type, lp.discount_value, lp.min_nights, lp.is_active,
               lp.start_date, lp.end_date
        FROM listing_promotions lp
        JOIN listings l ON l.id = lp.listing_id
        JOIN guests g ON g.host_id = l.host_id
        WHERE lp.id = ${promotionId} AND g.id = ${guestId}
      `;
      const promo = rows[0];
      if (!promo) return res.status(403).json({ error: 'You do not have permission to do this.' });

      const start = new Date(promo.start_date).toISOString().slice(0, 10);
      const end = new Date(promo.end_date).toISOString().slice(0, 10); // exclusive
      if (date < start || date >= end) {
        return res.status(400).json({ error: "That date isn't inside this promotion." });
      }
      const next = new Date(date + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
      const dayAfter = next.toISOString().slice(0, 10);

      const keepLeft = date > start;
      const keepRight = dayAfter < end;
      if (!keepLeft && !keepRight) {
        await sql`DELETE FROM listing_promotions WHERE id = ${promo.id}`;
      } else if (keepLeft && keepRight) {
        await sql`UPDATE listing_promotions SET end_date = ${date}::date WHERE id = ${promo.id}`;
        await sql`
          INSERT INTO listing_promotions (listing_id, room_id, name, discount_type, discount_value, min_nights, start_date, end_date, is_active)
          VALUES (${promo.listing_id}, ${promo.room_id}, ${promo.name}, ${promo.discount_type}, ${promo.discount_value}, ${promo.min_nights}, ${dayAfter}::date, ${end}::date, ${promo.is_active})
        `;
      } else if (keepLeft) {
        await sql`UPDATE listing_promotions SET end_date = ${date}::date WHERE id = ${promo.id}`;
      } else {
        await sql`UPDATE listing_promotions SET start_date = ${dayAfter}::date WHERE id = ${promo.id}`;
      }
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('host-listings (removePromotionDay) error:', err);
      return res.status(500).json({ error: 'Could not update this promotion right now.' });
    }
  }

  // ---- Remove the contiguous promoted run around a date ----
  // The Status page's "Remove Entire Promotion". "Entire" is defined by
  // the CALENDAR, not by promotion names or row boundaries: starting at
  // the clicked night, walk outward while nights are promoted and not
  // blocked. A blocked night is a hard stop in either direction. Every
  // promotion row overlapping that run then has the run carved out of it
  // (deleted, trimmed, or split), so the nights on the far side of a
  // block — or beyond the run — keep whatever they had. This makes the
  // result identical whether the promotion is one long row, several rows
  // from the resume-from-block flow, or rows with different names.
  if (req.method === 'POST' && req.body && req.body.removePromotionRun) {
    try {
      const { listingId, roomId, date } = req.body.removePromotionRun;
      if (!listingId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Missing listing or date.' });
      }
      const owns = await sql`
        SELECT l.id FROM listings l JOIN guests g ON g.host_id = l.host_id
        WHERE l.id = ${listingId} AND g.id = ${guestId}
      `;
      if (!owns[0]) return res.status(403).json({ error: 'You do not have permission to do this.' });
      const safeRoomId = roomId || null;

      const ymd = (d) => new Date(d).toISOString().slice(0, 10);
      const shift = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

      const promos = (await sql`
        SELECT id, listing_id, room_id, name, discount_type, discount_value, min_nights, is_active, start_date, end_date
        FROM listing_promotions
        WHERE listing_id = ${listingId} AND is_active = TRUE
          AND (room_id = ${safeRoomId} OR room_id IS NULL)
      `).map(p => ({ ...p, start: ymd(p.start_date), end: ymd(p.end_date) }));
      const blocks = (await sql`
        SELECT start_date, end_date FROM listing_blocked_dates
        WHERE listing_id = ${listingId} AND (room_id = ${safeRoomId} OR room_id IS NULL)
      `).map(b => ({ start: ymd(b.start_date), end: ymd(b.end_date) }));

      const isPromoted = (d) => promos.some(p => d >= p.start && d < p.end);
      const isBlocked = (d) => blocks.some(b => d >= b.start && d < b.end);
      if (!isPromoted(date) || isBlocked(date)) {
        return res.status(400).json({ error: 'That night has no active promotion to remove.' });
      }

      let runStart = date, guard = 0;
      while (guard++ < 400) {
        const prev = shift(runStart, -1);
        if (!isPromoted(prev) || isBlocked(prev)) break;
        runStart = prev;
      }
      let runEnd = shift(date, 1); guard = 0; // exclusive
      while (guard++ < 400) {
        if (!isPromoted(runEnd) || isBlocked(runEnd)) break;
        runEnd = shift(runEnd, 1);
      }

      for (const p of promos) {
        if (runEnd <= p.start || runStart >= p.end) continue; // no overlap
        const keepLeft = runStart > p.start;
        const keepRight = runEnd < p.end;
        if (!keepLeft && !keepRight) {
          await sql`DELETE FROM listing_promotions WHERE id = ${p.id}`;
        } else if (keepLeft && keepRight) {
          await sql`UPDATE listing_promotions SET end_date = ${runStart}::date WHERE id = ${p.id}`;
          await sql`
            INSERT INTO listing_promotions (listing_id, room_id, name, discount_type, discount_value, min_nights, start_date, end_date, is_active)
            VALUES (${p.listing_id}, ${p.room_id}, ${p.name}, ${p.discount_type}, ${p.discount_value}, ${p.min_nights}, ${runEnd}::date, ${p.end}::date, ${p.is_active})
          `;
        } else if (keepLeft) {
          await sql`UPDATE listing_promotions SET end_date = ${runStart}::date WHERE id = ${p.id}`;
        } else {
          await sql`UPDATE listing_promotions SET start_date = ${runEnd}::date WHERE id = ${p.id}`;
        }
      }
      return res.status(200).json({ success: true, removedFrom: runStart, removedToExclusive: runEnd });
    } catch (err) {
      console.error('host-listings (removePromotionRun) error:', err);
      return res.status(500).json({ error: 'Could not remove this promotion right now.' });
    }
  }

  // ---- Raise a concern on a held security deposit ----
  // Separate from the verification-submission branch above — this only
  // ever touches one order's deposit_status, gated on it actually
  // belonging to this host and still being within the 7-day hold.
  if (req.method === 'POST' && req.body && req.body.raiseDispute) {
    try {
      const { orderId, reason } = req.body.raiseDispute;
      if (!orderId || !reason || !String(reason).trim()) {
        return res.status(400).json({ error: 'Please explain the concern before submitting.' });
      }

      const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
      const guest = guestRows[0];
      if (!guest || !guest.host_id) {
        return res.status(403).json({ error: 'You do not have permission to do this.' });
      }

      // Ownership check: the order's listing has to belong to this host —
      // never trust orderId alone, since it's just a number a guest's
      // browser could also send.
      const rows = await sql`
        SELECT o.id, o.deposit_status, o.deposit_release_at
        FROM orders o
        JOIN listings l ON o.listing_id = l.id
        WHERE o.id = ${orderId} AND l.host_id = ${guest.host_id}
      `;
      const order = rows[0];
      if (!order) {
        return res.status(403).json({ error: 'You do not have permission to do this.' });
      }
      if (order.deposit_status !== 'held') {
        return res.status(400).json({ error: 'This deposit is no longer open to a concern — it has already been refunded, disputed, or resolved.' });
      }
      const releaseDate = order.deposit_release_at ? new Date(order.deposit_release_at) : null;
      if (releaseDate && new Date() > releaseDate) {
        return res.status(400).json({ error: 'The 7-day window to raise a concern on this deposit has passed.' });
      }

      // Guarded on 'held' in the UPDATE itself, not just the check above:
      // an admin's deposit run may have claimed this order in between,
      // and flipping a deposit that is mid-refund to 'disputed' would let
      // it be refunded a second time when the dispute is resolved.
      const raised = await sql`
        UPDATE orders SET deposit_status = 'disputed', dispute_reason = ${String(reason).trim().slice(0, 1000)}, dispute_raised_at = now()
        WHERE id = ${orderId} AND deposit_status = 'held'
        RETURNING id
      `;
      if (!raised.length) {
        return res.status(400).json({ error: 'This deposit is no longer open to a concern — it has already been refunded, disputed, or resolved.' });
      }
      await logAudit(sql, {
        action: 'deposit_dispute_raised', success: true, actorType: 'host', actorIdentifier: String(guest.host_id),
        targetType: 'order', targetId: orderId
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('host-listings (raiseDispute) error:', err);
      return res.status(500).json({ error: 'Could not submit your concern right now. Please try again.' });
    }
  }

  // ---- Shared helpers for both cancellation paths below ----

  // Loads an order and confirms it genuinely belongs to this host,
  // is still a live paid booking, and (if requested) is past the
  // 48-hour check-in cutoff. Returns { error, status } on any failure,
  // or { order, guest } on success — callers check which shape they got.
  // ---- Host cancellation coupon ----
  // When a host cancels, they first buy the guest a coupon worth 10% of
  // what the guest paid for the booking and any linked rooms paid together
  // (excluding security deposits). The amount is set here, never by the
  // host. The coupon is held ('reserved') until the booking is cancelled,
  // then released to the guest ('active', 3 months) and emailed to them.
  async function cancellationCouponAmount(order, orderId){
    const rows = order.razorpay_order_id
      ? await sql`SELECT total, deposit_amount FROM orders WHERE razorpay_order_id = ${order.razorpay_order_id} AND status = 'paid'`
      : await sql`SELECT total, deposit_amount FROM orders WHERE id = ${orderId}`;
    const base = rows.reduce((sum, r) => sum + Math.max(0, (Number(r.total) || 0) - (Number(r.deposit_amount) || 0)), 0);
    return Math.max(1, Math.round(base * 0.10));
  }
  // Host chose not to pay now: the coupon is issued straight away (Aerva
  // fronts it) and the same amount is recorded against the host, to be
  // deducted from their next payout. Never throws: the refund is done.
  async function issueCouponChargedToNextPayout(order, orderId, hostId, amount){
    try {
      const guestAccount = order.guest_id;
      if (!amount || !guestAccount) {
        await logAudit(sql, { action: 'host_cancellation_coupon_skipped', success: false, actorType: 'system', targetType: 'order', targetId: orderId, metadata: { amount, reason: guestAccount ? 'zero amount' : 'no guest account' } });
        return { amount: 0 };
      }
      const code = 'AERVA-' + crypto.randomBytes(5).toString('hex').toUpperCase();
      // Released to the guest automatically after the delay (_coupons.js).
      const coupon = (await sql`
        INSERT INTO coupons (code, guest_id, amount, issuing_host_id, source_order_id, status, release_at)
        VALUES (${code}, ${guestAccount}, ${amount}, ${hostId}, ${orderId}, 'scheduled', now() + make_interval(mins => ${COUPON_RELEASE_DELAY_MINUTES}))
        RETURNING id
      `)[0];
      // Owed by whoever cancelled: the host, or the co-host themselves
      // (from their own co-host share). Aerva is not involved in any money
      // between host and co-host.
      let recorded = false;
      try {
        await sql`INSERT INTO host_penalties (host_id, order_id, coupon_id, amount, payer_guest_id, cohost_id)
                  VALUES (${hostId}, ${orderId}, ${coupon.id}, ${amount}, ${cohostActor ? cohostActor.guestId : null}, ${cohostActor ? cohostActor.cohostId : null})`;
        recorded = true;
      } catch (err) {
        console.error('next-payout deduction not recorded (run migration_host_penalties.sql and migration_coupon_release.sql):', err.message);
      }
      await logAudit(sql, { action: 'cancellation_coupon_charged_to_payout', success: recorded, actorType: cohostActor ? 'cohost' : 'system', targetType: 'order', targetId: orderId,
        metadata: { couponId: coupon.id, amount, hostId, payer: cohostActor ? 'cohost' : 'host', payerGuestId: cohostActor ? cohostActor.guestId : null, deductionRecorded: recorded } });
      return { amount };
    } catch (err) {
      console.error('coupon for next-payout cancellation failed (refund already done):', err);
      await logAudit(sql, { action: 'host_cancellation_coupon_failed', success: false, actorType: 'system', targetType: 'order', targetId: orderId, metadata: { error: String(err.message).slice(0, 200) } });
      return { amount: 0 };
    }
  }
  // After a paid-now cancellation: the held coupon is scheduled for the
  // guest, released automatically after the delay (_coupons.js).
  async function scheduleCancellationCoupon(couponId, orderId){
    try {
      await sql`UPDATE coupons SET status = 'scheduled', release_at = now() + make_interval(mins => ${COUPON_RELEASE_DELAY_MINUTES})
                WHERE id = ${couponId} AND status = 'reserved'`;
      await logAudit(sql, { action: 'cancellation_coupon_scheduled', success: true, actorType: 'system', targetType: 'coupon', targetId: couponId, metadata: { orderId, releaseMinutes: COUPON_RELEASE_DELAY_MINUTES } });
    } catch (err) {
      console.error('scheduleCancellationCoupon failed (booking already cancelled):', err);
      await logAudit(sql, { action: 'cancellation_coupon_schedule_failed', success: false, actorType: 'system', targetType: 'coupon', targetId: couponId, metadata: { orderId, error: String(err.message).slice(0, 200) } });
    }
  }

  async function loadCancellableOrder(orderId, enforceCutoff){
    const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
    const guest = guestRows[0];
    if (!guest || !guest.host_id) {
      return { error: 'You do not have permission to do this.', status: 403 };
    }
    const rows = await sql`
      SELECT o.id, o.suite_name, o.arrival, o.departure, o.guest_email, o.guest_id, o.status,
             o.total, o.deposit_status, o.charge_currency, o.razorpay_payment_id, o.razorpay_order_id
      FROM orders o
      JOIN listings l ON o.listing_id = l.id
      WHERE o.id = ${orderId} AND l.host_id = ${guest.host_id}
    `;
    const order = rows[0];
    if (!order) {
      return { error: 'You do not have permission to do this.', status: 403 };
    }
    if (order.status === 'cancelled') {
      return { error: 'This booking has already been cancelled.', status: 400 };
    }
    if (order.status !== 'paid') {
      return { error: 'Only a paid, confirmed booking can be cancelled this way.', status: 400 };
    }
    if (enforceCutoff) {
      const arrivalDate = new Date(order.arrival + 'T00:00:00Z');
      const hoursUntilArrival = (arrivalDate.getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursUntilArrival < CANCELLATION_CUTOFF_HOURS) {
        return {
          error: `This stay checks in within ${CANCELLATION_CUTOFF_HOURS} hours — bookings this close to check-in can no longer be cancelled by the host. Please contact hello@aerva.in if this is urgent.`,
          status: 400
        };
      }
    }
    return { order, guest };
  }

  // Actually performs the refund + DB update + email — shared by a plain
  // host cancellation and a coupon-gated "prioritize a bigger booking"
  // cancellation. Identical money-handling either way; only the gate
  // checks before calling this differ.
  async function executeCancellationRefund(order, orderId, reason, hostId, auditAction, emailOpts = {}){
    const currency = order.charge_currency || 'INR';
    let refundAmount;
    if (currency === 'INR') {
      refundAmount = Math.round(Number(order.total) * 100);
    } else {
      refundAmount = await convertInrToForeignSubunit(sql, Number(order.total), currency);
      if (!refundAmount) {
        throw Object.assign(new Error(`No cached exchange rate available to refund this ${currency} booking right now. Please try again shortly.`), { isUserFacing: true, status: 502 });
      }
    }

    // Guarded: once per booking, checked against Razorpay (_refunds.js).
    const refund = await safeRefund(sql, razorpay, { orderId, paymentId: order.razorpay_payment_id, amountSubunit: refundAmount, kind: 'cancellation' });

    await sql`
      UPDATE orders SET
        status = 'cancelled',
        cancellation_reason = ${String(reason).trim().slice(0, 1000)},
        cancelled_at = now(),
        deposit_status = ${order.deposit_status === 'held' ? 'refunded' : order.deposit_status},
        deposit_refund_id = ${refund.id}
      WHERE id = ${orderId}
    `;

    await logAudit(sql, {
      action: auditAction, success: true, actorType: 'host', actorIdentifier: String(hostId),
      targetType: 'order', targetId: orderId
    });

    // An "Includes a Stay" experience is one purchase written as two rows
    // sharing a payment: the experience and the nights at the property
    // hosting it. Cancelling either cancels both — the guest bought one
    // thing, and leaving them with half of it (nights but no experience,
    // or the reverse) is never what they want. Refunded separately
    // against the same payment, which Razorpay allows as long as the
    // refunds together do not exceed what was captured.
    //
    // Never throws: this booking is already cancelled and refunded by the
    // point we get here, and reporting that as a failure would be wrong.
    // A failure is logged for a human to finish by hand.
    if (order.razorpay_order_id) {
      try {
        const siblings = await sql`
          SELECT id, total, charge_currency, deposit_status, razorpay_payment_id
          FROM orders
          WHERE razorpay_order_id = ${order.razorpay_order_id} AND id <> ${orderId} AND status = 'paid'
        `;
        for (const sib of siblings) {
          const sibCurrency = sib.charge_currency || 'INR';
          const sibAmount = sibCurrency === 'INR'
            ? Math.round(Number(sib.total) * 100)
            : await convertInrToForeignSubunit(sql, Number(sib.total), sibCurrency);
          if (!sibAmount) throw new Error(`No cached ${sibCurrency} rate to refund linked booking ${sib.id}`);
          const sibRefund = await safeRefund(sql, razorpay, { orderId: sib.id, paymentId: sib.razorpay_payment_id, amountSubunit: sibAmount, kind: 'cancellation' });
          await sql`
            UPDATE orders SET
              status = 'cancelled',
              cancellation_reason = ${'Cancelled with the linked booking: ' + String(reason).trim().slice(0, 900)},
              cancelled_at = now(),
              deposit_status = ${sib.deposit_status === 'held' ? 'refunded' : sib.deposit_status},
              deposit_refund_id = ${sibRefund.id}
            WHERE id = ${sib.id}
          `;
          await logAudit(sql, {
            action: 'order_cancelled_with_linked', success: true, actorType: 'host', actorIdentifier: String(hostId),
            targetType: 'order', targetId: sib.id, metadata: { cancelledWith: orderId }
          });
        }
      } catch (err) {
        console.error('linked cancellation failed (needs manual follow-up):', orderId, err);
        await logAudit(sql, {
          action: 'order_cancelled_with_linked', success: false, actorType: 'host', actorIdentifier: String(hostId),
          targetType: 'order', targetId: orderId, metadata: { reason: String(err && err.message || err).slice(0, 300) }
        });
      }
    }

    await sendCancellationEmail(order, emailOpts);
  }

  // ---- Cancel a booking (host-initiated, no coupon required) ----
  // Only allowed more than 48 hours before check-in — a guest who's
  // already within that window is protected from a last-minute
  // cancellation, no matter the host's reason. Refunds the guest's
  // FULL payment (not just the deposit — this ends the whole stay, not
  // a deposit dispute), in whatever currency they were actually charged.
  // For a legitimate cancellation reason (maintenance, unavailability,
  // etc.) — NOT the "prioritize a bigger booking" scenario, which
  // requires a coupon first (see cancelWithCoupon below).
  if (req.method === 'POST' && req.body && req.body.cancelBooking) {
    try {
      const { orderId, reasonCode } = req.body.cancelBooking;
      const details = String(req.body.cancelBooking.details || req.body.cancelBooking.reason || '').trim().slice(0, 800);
      // A reason from the list is required; the guest is told it.
      // Older cached pages send free text as "reason" (no list): kept as "Other".
      const legacyText = !reasonCode && req.body.cancelBooking.reason && String(req.body.cancelBooking.reason).trim();
      const reasonLabel = HOST_CANCEL_REASONS[reasonCode] || (legacyText ? 'Other' : null);
      if (!orderId || !reasonLabel || (reasonCode === 'other' && !details)) {
        return res.status(400).json({ error: 'Choose a reason for cancelling this booking.' });
      }
      const reason = reasonLabel + (details ? ' — ' + details : '');
      const loaded = await loadCancellableOrder(orderId, true);
      if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

      // The guest's 10% coupon is paid for by the host, one of two ways:
      //  1. up front: buyCouponOrder → verifyCouponPayment (coupon held), or
      //  2. { payLater: true }: Aerva issues the coupon now and the amount is
      //     deducted from the host's next payout (host_penalties).
      // Either way the booking and deposit are refunded in full at once.
      const held = (await sql`SELECT id, amount FROM coupons WHERE source_order_id = ${orderId} AND status = 'reserved' ORDER BY id DESC LIMIT 1`)[0];
      const payLater = req.body.cancelBooking.payLater === true;
      // Co-host shares are paid in full, without deductions, so a co-host
      // pays for the coupon before cancelling.
      if (payLater && cohostActor) return res.status(400).json({ error: 'Co-hosts pay for the guest’s coupon before cancelling.', needsCoupon: true });
      if (!held && !payLater) {
        const amount = await cancellationCouponAmount(loaded.order, orderId);
        return res.status(402).json({ error: `Choose how to pay the guest’s cancellation coupon (₹${amount.toLocaleString('en-IN')}).`, needsCoupon: true, amount });
      }
      const amountLater = held ? 0 : await cancellationCouponAmount(loaded.order, orderId);

      await executeCancellationRefund(loaded.order, orderId, reason, loaded.guest.host_id, 'booking_cancelled_by_host', { reasonLabel, details });
      // Refund done: now the coupon goes to the guest. The host never sees
      // its code (it is only emailed to the guest).
      if (held) {
        await scheduleCancellationCoupon(held.id, orderId);
        return res.status(200).json({ success: true, couponAmount: Number(held.amount), paid: 'now', couponReleaseMinutes: COUPON_RELEASE_DELAY_MINUTES });
      }
      const issued = await issueCouponChargedToNextPayout(loaded.order, orderId, loaded.guest.host_id, amountLater);
      return res.status(200).json({ success: true, couponAmount: issued.amount, paid: 'next_payout', couponReleaseMinutes: COUPON_RELEASE_DELAY_MINUTES });
    } catch (err) {
      console.error('host-listings (cancelBooking) error:', err);
      const status = err.isUserFacing ? err.status : 500;
      return res.status(status).json({ error: err.isUserFacing ? err.message : 'Could not cancel this booking right now. Please try again, or contact hello@aerva.in.' });
    }
  }

  // ---- Cancel a booking to prioritize a bigger one, using an
  // already-issued coupon as the required compensation gate ----
  // The coupon must exist FIRST (see buyCouponOrder/verifyCouponPayment
  // below) — this is the whole point of the design: the host commits to
  // and pays for the guest's compensation before the cancellation is
  // even allowed to happen, not as a penalty applied afterward.
  // The old "prioritize a bigger booking" route (host pre-pays a coupon,
  // then cancels) is replaced: every host cancellation now refunds in full
  // AND gives the guest a 10% coupon, charged to the host's next payout.
  if (req.method === 'POST' && req.body && req.body.cancelWithCoupon) {
    return res.status(410).json({ error: 'Use Cancel Booking. The guest now always receives a full refund plus a 10% Aerva coupon.' });
  }

  // GET ?myPenalties=1 — cancellation coupons to be deducted from this
  // host's next payout.
  if (req.method === 'GET' && (req.query || {}).myPenalties === '1') {
    try {
      const g = (await sql`SELECT host_id FROM guests WHERE id = ${guestId}`)[0];
      if (!g || !g.host_id) return res.status(200).json({ owed: [], total: 0 });
      let rows = [];
      try {
        rows = cohostActor
          ? await sql`SELECT p.id, p.amount, p.created_at, o.suite_name FROM host_penalties p LEFT JOIN orders o ON o.id = p.order_id
                      WHERE p.payer_guest_id = ${cohostActor.guestId} AND p.status = 'owed' ORDER BY p.created_at`
          : await sql`SELECT p.id, p.amount, p.created_at, o.suite_name FROM host_penalties p LEFT JOIN orders o ON o.id = p.order_id
                      WHERE p.host_id = ${g.host_id} AND p.payer_guest_id IS NULL AND p.status = 'owed' ORDER BY p.created_at`;
      } catch (err) {
        try { // before migration_coupon_release.sql: everything is the host's
          if (!cohostActor) rows = await sql`SELECT p.id, p.amount, p.created_at, o.suite_name FROM host_penalties p LEFT JOIN orders o ON o.id = p.order_id
                                             WHERE p.host_id = ${g.host_id} AND p.status = 'owed' ORDER BY p.created_at`;
        } catch (e2) { /* table not created yet */ }
      }
      return res.status(200).json({ owed: rows.map(r => ({ id: r.id, amount: Number(r.amount), createdAt: r.created_at, booking: r.suite_name })),
                                    total: Math.round(rows.reduce((t, r) => t + Number(r.amount), 0)) });
    } catch (err) {
      return res.status(500).json({ error: 'Could not load this right now.' });
    }
  }

  // ---- Deactivate / reactivate a listing, or all hosting (host only) ----
  // A deactivated listing is hidden from search and takes no new bookings;
  // existing bookings go ahead. Reactivating puts it straight back live.
  // Deactivating hosting does this to every live listing at once and
  // restores exactly those. Co-hosts cannot (not in COHOST_ACTIONS).
  if (req.method === 'GET' && (req.query || {}).hostingStatus === '1') {
    try {
      const g = (await sql`SELECT host_id FROM guests WHERE id = ${guestId}`)[0];
      if (!g || !g.host_id) return res.status(200).json({ hostingStatus: null });
      let st = 'active';
      try { st = ((await sql`SELECT hosting_status FROM hosts WHERE id = ${g.host_id}`)[0] || {}).hosting_status || 'active'; } catch (e) { /* column not added yet */ }
      return res.status(200).json({ hostingStatus: st });
    } catch (err) { return res.status(500).json({ error: 'Could not load this right now.' }); }
  }
  if (req.method === 'POST' && req.body && (req.body.setListingActive || req.body.setHostingActive)) {
    try {
      const g = (await sql`SELECT host_id FROM guests WHERE id = ${guestId}`)[0];
      if (!g || !g.host_id) return res.status(403).json({ error: 'You do not have permission to do this.' });
      if (req.body.setListingActive) {
        const { listingId, active } = req.body.setListingActive;
        const l = (await sql`SELECT id, status, deactivated_by FROM listings WHERE id = ${Number(listingId) || 0} AND host_id = ${g.host_id}`)[0];
        if (!l) return res.status(404).json({ error: 'Listing not found.' });
        if (active === false) {
          if (l.status !== 'approved') return res.status(400).json({ error: 'Only a live listing can be deactivated.' });
          await sql`UPDATE listings SET status = 'deactivated', deactivated_by = 'host', deactivated_at = now() WHERE id = ${l.id}`;
        } else {
          if (l.status !== 'deactivated') return res.status(400).json({ error: 'This listing is not deactivated.' });
          const h = (await sql`SELECT hosting_status FROM hosts WHERE id = ${g.host_id}`)[0] || {};
          if (h.hosting_status === 'deactivated') return res.status(400).json({ error: 'Reactivate your hosting first.' });
          await sql`UPDATE listings SET status = 'approved', deactivated_by = NULL, deactivated_at = NULL WHERE id = ${l.id}`;
        }
        await logAudit(sql, { action: active === false ? 'listing_deactivated_by_host' : 'listing_reactivated_by_host', success: true, actorType: 'host', actorIdentifier: String(g.host_id), targetType: 'listing', targetId: l.id });
        return res.status(200).json({ success: true, status: active === false ? 'deactivated' : 'approved' });
      }
      const active = req.body.setHostingActive.active !== false;
      if (!active) {
        const changed = await sql`UPDATE listings SET status = 'deactivated', deactivated_by = 'hosting', deactivated_at = now()
                                  WHERE host_id = ${g.host_id} AND status = 'approved' RETURNING id`;
        await sql`UPDATE hosts SET hosting_status = 'deactivated' WHERE id = ${g.host_id}`;
        await logAudit(sql, { action: 'hosting_deactivated', success: true, actorType: 'host', actorIdentifier: String(g.host_id), targetType: 'host', targetId: g.host_id, metadata: { listings: changed.map(r => r.id) } });
        return res.status(200).json({ success: true, hostingStatus: 'deactivated', listingsDeactivated: changed.length });
      }
      const restored = await sql`UPDATE listings SET status = 'approved', deactivated_by = NULL, deactivated_at = NULL
                                 WHERE host_id = ${g.host_id} AND status = 'deactivated' AND deactivated_by = 'hosting' RETURNING id`;
      await sql`UPDATE hosts SET hosting_status = 'active' WHERE id = ${g.host_id}`;
      await logAudit(sql, { action: 'hosting_reactivated', success: true, actorType: 'host', actorIdentifier: String(g.host_id), targetType: 'host', targetId: g.host_id, metadata: { listings: restored.map(r => r.id) } });
      return res.status(200).json({ success: true, hostingStatus: 'active', listingsRestored: restored.length });
    } catch (err) {
      console.error('deactivation failed:', err);
      return res.status(500).json({ error: 'Could not do this right now. Please try again.' });
    }
  }

  // ---- Guest cancellation requests (hazard / life-threatening / emergency) ----
  // GET ?cancellationRequests=1 → open requests on my listings.
  // POST { respondCancellationRequest: { requestId, accept, note } }
  //   accept → full refund (booking and deposit), no coupon, no charge to
  //   the host; decline → the guest is told. Host, or co-host with cancel
  //   access on that listing.
  if (req.method === 'GET' && (req.query || {}).cancellationRequests === '1') {
    try {
      const g = (await sql`SELECT host_id FROM guests WHERE id = ${guestId}`)[0];
      if (!g || !g.host_id) return res.status(200).json({ requests: [] });
      let rows = [];
      try {
        rows = await sql`
          SELECT r.id, r.reason_code, r.details, r.created_at, o.id AS order_id, o.listing_id, o.suite_name, o.arrival, o.departure, o.total,
                 COALESCE(gu.name, o.guest_email) AS guest_name
          FROM cancellation_requests r JOIN orders o ON o.id = r.order_id JOIN listings l ON l.id = o.listing_id
          LEFT JOIN guests gu ON gu.id = o.guest_id
          WHERE r.status = 'pending' AND o.status = 'paid' AND l.host_id = ${g.host_id}
          ORDER BY r.created_at
        `;
      } catch (err) { /* migration_cancellation_requests.sql not run yet */ }
      if (cohostActor) rows = rows.filter(r => cohostHasListing(cohostActor.ctx, r.listing_id));
      return res.status(200).json({ requests: rows.map(r => ({ id: r.id, orderId: r.order_id, listing: r.suite_name, arrival: r.arrival, departure: r.departure,
        total: Number(r.total), guestName: r.guest_name, reason: GUEST_CANCEL_REASONS[r.reason_code] || r.reason_code, details: r.details || '', createdAt: r.created_at })) });
    } catch (err) {
      console.error('cancellationRequests failed:', err);
      return res.status(500).json({ error: 'Could not load cancellation requests right now.' });
    }
  }
  if (req.method === 'POST' && req.body && req.body.respondCancellationRequest) {
    try {
      const { requestId, accept } = req.body.respondCancellationRequest;
      const note = String(req.body.respondCancellationRequest.note || '').trim().slice(0, 500);
      const rq = (await sql`SELECT id, order_id, reason_code, details, status FROM cancellation_requests WHERE id = ${Number(requestId) || 0}`)[0];
      if (!rq) return res.status(404).json({ error: 'Request not found.' });
      if (rq.status !== 'pending') return res.status(409).json({ error: 'This request has already been answered.' });
      const loaded = await loadCancellableOrder(rq.order_id, false); // emergencies: no 48-hour cut-off
      if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });
      const label = GUEST_CANCEL_REASONS[rq.reason_code] || 'Guest request';
      if (accept === true) {
        await executeCancellationRefund(loaded.order, rq.order_id, `Guest request accepted: ${label}${rq.details ? ' — ' + rq.details : ''}`,
          loaded.guest.host_id, 'booking_cancelled_on_guest_request', { guestRequested: true, reasonLabel: label, details: rq.details });
        await sql`UPDATE cancellation_requests SET status = 'accepted', host_note = ${note || null}, decided_at = now(), decided_by = ${accountId} WHERE id = ${rq.id}`;
        return res.status(200).json({ success: true, accepted: true });
      }
      await sql`UPDATE cancellation_requests SET status = 'declined', host_note = ${note || null}, decided_at = now(), decided_by = ${accountId} WHERE id = ${rq.id}`;
      await logAudit(sql, { action: 'guest_cancellation_request_declined', success: true, actorType: cohostActor ? 'cohost' : 'host', actorIdentifier: String(accountId), targetType: 'order', targetId: rq.order_id, metadata: { requestId: rq.id } });
      try {
        if (process.env.RESEND_API_KEY && loaded.order.guest_email) {
          const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
          await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to: loaded.order.guest_email, subject: `Your cancellation request for ${loaded.order.suite_name}`,
              html: `<div style="font-family:sans-serif; max-width:480px;"><h2 style="font-family:Georgia,serif;">Your cancellation request was declined</h2><p>Your host has declined your request to cancel your stay at <strong>${esc(loaded.order.suite_name)}</strong> (${loaded.order.arrival} — ${loaded.order.departure}). Your booking stands.</p>${note ? `<p><strong>Host’s note:</strong> ${esc(note)}</p>` : ''}<p style="font-size:12px; opacity:0.6; margin-top:24px;">Questions? Contact hello@aerva.in.</p></div>` }) });
        }
      } catch (err) { console.error('decline email failed:', err.message); }
      return res.status(200).json({ success: true, accepted: false });
    } catch (err) {
      console.error('respondCancellationRequest failed:', err);
      const status = err.isUserFacing ? err.status : 500;
      return res.status(status).json({ error: err.isUserFacing ? err.message : 'Could not answer this request right now.' });
    }
  }

  // ---- Step 1 of a host cancellation: buy the guest's 10% coupon ----
  // POST { buyCouponOrder: { bookingId } } — the amount is worked out here
  // (cancellationCouponAmount); anything the page sends is ignored.
  if (req.method === 'POST' && req.body && req.body.buyCouponOrder) {
    try {
      const bookingId = Number((req.body.buyCouponOrder || {}).bookingId) || 0;
      const loaded = await loadCancellableOrder(bookingId, true);
      if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });
      if (!loaded.order.guest_id) return res.status(400).json({ error: 'This booking has no guest account to send a coupon to.' });
      const already = (await sql`SELECT id FROM coupons WHERE source_order_id = ${bookingId} AND status = 'reserved' LIMIT 1`)[0];
      if (already) return res.status(200).json({ alreadyPaid: true });
      const amount = await cancellationCouponAmount(loaded.order, bookingId);
      const razorpayOrder = await razorpay.orders.create({
        amount: amount * 100, currency: 'INR', receipt: `aerva_coupon_${Date.now()}`,
        notes: { type: 'host_cancellation_coupon', hostId: String(loaded.guest.host_id), bookingId: String(bookingId), paidBy: cohostActor ? 'cohost:' + accountId : 'host' }
      });
      const couponRows = await sql`
        INSERT INTO coupons (code, guest_id, amount, issuing_host_id, source_order_id, status, razorpay_order_id)
        VALUES (${'PENDING-' + razorpayOrder.id}, ${loaded.order.guest_id}, ${amount}, ${loaded.guest.host_id}, ${bookingId}, 'pending_payment', ${razorpayOrder.id})
        RETURNING id
      `;
      return res.status(200).json({ couponId: couponRows[0].id, amount, razorpayOrderId: razorpayOrder.id, keyId: process.env.RAZORPAY_KEY_ID, currency: 'INR' });
    } catch (err) {
      console.error('host-listings (buyCouponOrder) error:', err);
      return res.status(500).json({ error: 'Could not start the coupon payment. Please try again.' });
    }
  }

  // ---- Step 2: confirm the coupon payment ----
  // The coupon is created and HELD ('reserved') for the cancellation. Its
  // code is never returned to the host: the guest receives it by email
  // 15 minutes after the booking is cancelled (_coupons.js).
  if (req.method === 'POST' && req.body && req.body.verifyCouponPayment) {
    try {
      const { couponId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body.verifyCouponPayment;
      if (!verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
        return res.status(400).json({ verified: false, error: 'Payment could not be verified.' });
      }
      const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
      const guest = guestRows[0];
      if (!guest || !guest.host_id) return res.status(403).json({ error: 'You do not have permission to do this.' });
      const coupon = (await sql`SELECT id, status, razorpay_order_id FROM coupons WHERE id = ${Number(couponId) || 0} AND issuing_host_id = ${guest.host_id}`)[0];
      if (!coupon) return res.status(403).json({ error: 'You do not have permission to do this.' });
      if (coupon.razorpay_order_id !== razorpay_order_id) return res.status(400).json({ error: 'This payment does not match the coupon being confirmed.' });
      if (coupon.status === 'reserved' || coupon.status === 'active') return res.status(200).json({ verified: true });
      const code = 'AERVA-' + crypto.randomBytes(5).toString('hex').toUpperCase();
      await sql`
        UPDATE coupons SET status = 'reserved', code = ${code}, razorpay_payment_id = ${razorpay_payment_id}
        WHERE id = ${coupon.id} AND status = 'pending_payment'
      `;
      try { await sql`UPDATE coupons SET paid_by_guest_id = ${accountId} WHERE id = ${coupon.id}`; } catch (err) { /* column added by migration_coupon_release.sql */ }
      await logAudit(sql, { action: 'coupon_purchased', success: true, actorType: cohostActor ? 'cohost' : 'host', actorIdentifier: String(cohostActor ? accountId : guest.host_id), targetType: 'coupon', targetId: coupon.id,
        metadata: { paidBy: cohostActor ? 'cohost' : 'host' } });
      return res.status(200).json({ verified: true });
    } catch (err) {
      console.error('host-listings (verifyCouponPayment) error:', err);
      return res.status(500).json({ error: 'Could not confirm the coupon payment right now. Please try again.' });
    }
  }

  if (req.method === 'POST') {
    try {
      const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
      const guest = guestRows[0];
      if (!guest || !guest.host_id) {
        return res.status(400).json({ error: 'List a property first to create your host account.' });
      }

      const { aadhaarDocumentUrl, bankAccountNumber, bankIfsc, bankAccountHolderName, panNumber, panDocumentUrl, hostName, hostPhone } = req.body || {};
      // Uploaded documents: only Aerva's own storage (see isAervaBlobUrl).
      for (const u of [aadhaarDocumentUrl, panDocumentUrl]) {
        if (typeof u === 'string' && u && !isAervaBlobUrl(u)) {
          return res.status(400).json({ error: 'Please upload the document again from this page.' });
        }
      }
      // PAN and bank numbers are only ever stored encrypted: with no key
      // configured, refuse before writing anything rather than store them readable.
      const writesSecret = (typeof panDocumentUrl === 'string' && panDocumentUrl) || (bankAccountNumber && bankIfsc && bankAccountHolderName);
      if (writesSecret && !encryptionReady()) {
        console.error('DATA_ENCRYPTION_KEY missing or invalid — refused to save PAN / bank details.');
        return res.status(503).json({ error: ENCRYPTION_UNAVAILABLE });
      }
      const current = await sql`
        SELECT aadhaar_status, aadhaar_document_url, aadhaar_rejection_reason,
               bank_status, pan_status, pan_document_url, pan_rejection_reason
        FROM hosts WHERE id = ${guest.host_id}
      `;
      const host = current[0];
      let didSomething = false;

      // ---- PAN: submit once, then permanently locked ----
      if (typeof panDocumentUrl === 'string' && panDocumentUrl.startsWith('https://')) {
        // Decided by the status, not by a stored document: after review the
        // document and number are erased, and only the outcome is kept.
        if (host.pan_status && host.pan_status !== 'not_submitted') {
          return res.status(400).json({ error: 'Your PAN has already been submitted and can\'t be changed. Contact hello@aerva.in if you need to update it.' });
        }
        const cleanPan = typeof panNumber === 'string' ? panNumber.trim().toUpperCase() : '';
        if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(cleanPan)) {
          return res.status(400).json({ error: 'Please enter a valid 10-character PAN, e.g. ABCDE1234F.' });
        }
        await sql`
          UPDATE hosts SET pan_number = ${encryptField(cleanPan)}, pan_document_url = ${panDocumentUrl}, pan_status = 'pending_review', pan_rejection_reason = NULL
          WHERE id = ${guest.host_id}
        `;
        await logAudit(sql, {
          action: 'host_pan_submitted', success: true, actorType: 'host', actorIdentifier: String(guest.host_id),
          targetType: 'host', targetId: guest.host_id
        });
        didSomething = true;
      }

      // ---- Aadhaar: submit once, then permanently locked (same policy
      // as PAN above — no more resubmitting after a rejection either) ----
      if (typeof aadhaarDocumentUrl === 'string' && aadhaarDocumentUrl.startsWith('https://')) {
        if (host.aadhaar_status && host.aadhaar_status !== 'not_submitted') {
          return res.status(400).json({ error: 'Your Aadhaar has already been submitted and can\'t be changed. Contact hello@aerva.in if you need to update it.' });
        }
        // Uploading a file only confirms a file was uploaded — it says
        // nothing about whose document it actually is. Real verification
        // happens as a human admin review (see get-pending-listings.js's
        // ?verifications=1 mode) — pending_review is the correct state
        // until that review happens.
        await sql`
          UPDATE hosts SET aadhaar_document_url = ${aadhaarDocumentUrl}, aadhaar_status = 'pending_review', aadhaar_rejection_reason = NULL
          WHERE id = ${guest.host_id}
        `;
        await logAudit(sql, {
          action: 'host_aadhaar_submitted', success: true, actorType: 'host', actorIdentifier: String(guest.host_id),
          targetType: 'host', targetId: guest.host_id
        });
        didSomething = true;
      }

      // ---- Bank: can always be changed, but doing so re-triggers a
      // full identity re-check, not just the bank details themselves ----
      const hasBankInfo = bankAccountNumber && bankIfsc && bankAccountHolderName;
      if (hasBankInfo) {
        const cleanAccountNumber = String(bankAccountNumber).replace(/\s/g, '');
        const cleanIfsc = String(bankIfsc).trim().toUpperCase();
        if (!/^\d{6,20}$/.test(cleanAccountNumber)) {
          return res.status(400).json({ error: 'Please enter a valid bank account number.' });
        }
        if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(cleanIfsc)) {
          return res.status(400).json({ error: 'Please enter a valid IFSC code.' });
        }
        // Only reset PAN/Aadhaar back to pending_review if they'd
        // actually been submitted before — nothing to "re-check" for a
        // PAN/Aadhaar that was never on file in the first place.
        const aadhaarSubmitted = !!host.aadhaar_document_url;
        const panSubmitted = !!host.pan_document_url;
        const reAadhaarStatus = aadhaarSubmitted ? 'pending_review' : host.aadhaar_status;
        const rePanStatus = panSubmitted ? 'pending_review' : host.pan_status;
        const reAadhaarReason = aadhaarSubmitted ? null : host.aadhaar_rejection_reason;
        const rePanReason = panSubmitted ? null : host.pan_rejection_reason;
        await sql`
          UPDATE hosts SET
            bank_account_number = ${encryptField(cleanAccountNumber)}, bank_ifsc = ${cleanIfsc},
            bank_account_holder_name = ${String(bankAccountHolderName).trim().slice(0, 100)},
            bank_status = 'pending_review', bank_rejection_reason = NULL,
            aadhaar_status = ${reAadhaarStatus}, aadhaar_rejection_reason = ${reAadhaarReason},
            pan_status = ${rePanStatus}, pan_rejection_reason = ${rePanReason}
          WHERE id = ${guest.host_id}
        `;
        await logAudit(sql, {
          action: 'host_bank_details_submitted', success: true, actorType: 'host', actorIdentifier: String(guest.host_id),
          targetType: 'host', targetId: guest.host_id,
          metadata: { retriggeredAadhaar: aadhaarSubmitted, retriggeredPan: panSubmitted }
        });
        didSomething = true;
      }

      // ---- Personal details: name/phone, not identity-sensitive ----
      if (typeof hostName === 'string' || typeof hostPhone === 'string') {
        const safeName = typeof hostName === 'string' ? hostName.trim().slice(0, 100) : undefined;
        const safePhone = typeof hostPhone === 'string' ? hostPhone.trim().slice(0, 20) : undefined;
        if (safeName || safePhone) {
          await sql`
            UPDATE hosts SET
              name = COALESCE(${safeName ?? null}, name),
              phone = COALESCE(${safePhone ?? null}, phone)
            WHERE id = ${guest.host_id}
          `;
          await logAudit(sql, {
            action: 'host_profile_updated', success: true, actorType: 'host', actorIdentifier: String(guest.host_id),
            targetType: 'host', targetId: guest.host_id
          });
          didSomething = true;
        }
      }

      if (!didSomething) {
        return res.status(400).json({ error: 'Nothing to submit.' });
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('host-listings (POST verification) error:', err);
      return res.status(500).json({ error: 'Could not save your verification info right now. Please try again.' });
    }
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
    const guest = guestRows[0];
    if (!guest) return res.status(401).json({ error: 'Please log in again.' });

    // Never hosted anything yet — an empty dashboard, not an error.
    if (!guest.host_id) {
      return res.status(200).json({ listings: [], bookings: [], verification: null, complianceNotices: [] });
    }

    const listings = await sql`
      SELECT id, property_name, city, area, property_type, bedrooms, max_guests, nightly_rate, status,
             rejection_reason, admin_status_reason,
             description, amenities, services, host_name, host_phone,
             discount_type, discount_value, discount_min_nights, discount_description,
             latitude, longitude, formatted_address, pincode,
             exterior_photo_urls, interior_photo_urls, cover_photo_url, created_at,
             pending_room_photos,
             listing_type, hosting_listing_id, experience_category, experience_price_unit,
             experience_duration_hours, experience_duration_days, experience_type, experience_arranges_travel,
             experience_travel_details, experience_meeting_point_type,
             experience_meeting_point_details, experience_start_time, experience_refund_policy,
             experience_meeting_point_lat, experience_meeting_point_lng, experience_meeting_point_address,
             experience_instructions, experience_special_instructions,
             experience_available_from, experience_available_until
      FROM listings
      WHERE host_id = ${guest.host_id}
      ORDER BY created_at DESC
    `;
    // Generate a fresh "manage price" link for each listing on the spot —
    // the host doesn't have to dig up the one-time email from approval time.
    const listingsWithLinks = listings.map(l => ({
      ...l,
      manageLink: `${SITE_BASE}/manage-listing.html?token=${createToken(l.id, 'manage-pricing', TWO_YEARS_MS)}`
    }));

    // "Aerva Host" status — awarded the moment a host has at least one
    // approved listing. Computed here rather than stored anywhere, so it's
    // always accurate the instant a listing's status flips to 'approved'
    // (see approve-listing.js), with nothing to keep in sync.
    const hostBadge = listings.some(l => l.status === 'approved') ? 'Aerva Host' : null;

    // Bookings/earnings for this host's listings — deliberately selects
    // only host-relevant columns. `total` and `guest_service_fee` are
    // NEVER included here on purpose: total includes the guest's own
    // service fee, which is Aerva's guest-side revenue and none of the
    // host's business, exactly as guests never see the host's commission.
    // subtotal + gst here already reflects what the guest paid for the
    // stay itself, before that split — payout_amount is what actually
    // lands with the host after commission.
    const bookings = await sql`
      SELECT o.id, o.suite_name, o.listing_id, o.arrival, o.departure, o.nights, o.guests,
             o.subtotal, o.discount_amount, o.gst,
             o.commission_rate, o.commission_amount, o.payout_amount,
             o.deposit_amount, o.deposit_status, o.deposit_release_at,
             o.dispute_reason, o.dispute_raised_at, o.deposit_resolution_amount,
             o.cancellation_reason, o.cancelled_at,
             o.status, o.created_at, o.pet_types, o.service_animal_types, o.young_litter_count,
             o.guest_email, g.name AS guest_name
      FROM orders o
      JOIN listings l ON o.listing_id = l.id
      LEFT JOIN guests g ON g.id = o.guest_id
      WHERE l.host_id = ${guest.host_id}
      ORDER BY o.created_at DESC
      LIMIT 100
    `;
    // Each booking's co-host shares, so the host sees what is theirs after
    // co-hosts. Separate and fail-safe: before migration_cohost_commission.sql
    // has run there is no shares table, and bookings must still load.
    try {
      const ids = bookings.map(b => b.id);
      if (ids.length) {
        const sh = await sql`SELECT order_id, COALESCE(SUM(amount), 0)::int AS amt FROM order_cohost_shares WHERE order_id = ANY(${ids}) GROUP BY order_id`;
        const byOrder = {};
        sh.forEach(r => { byOrder[r.order_id] = Number(r.amt) || 0; });
        bookings.forEach(b => { b.cohost_share = byOrder[b.id] || 0; });
      }
    } catch (err) {
      console.error('co-host shares unavailable (non-fatal):', err.message);
    }


    // Verification status for the checklist. Bank account number is
    // masked to its last 4 digits — even the host's own dashboard never
    // re-displays the full number once submitted, so there's one fewer
    // place it exists in full anywhere in the UI.
    const hostRows = await sql`
      SELECT name, phone, aadhaar_status, aadhaar_rejection_reason, aadhaar_document_url,
             bank_status, bank_rejection_reason, bank_account_number, bank_account_holder_name, bank_ifsc,
             pan_status, pan_rejection_reason, pan_document_url, pan_number
      FROM hosts WHERE id = ${guest.host_id}
    `;
    const h = hostRows[0];
    // Separate and fail-safe: before migration_agreements.sql runs, this
    // column does not exist, and My Collection must still load.
    let hostAgreementVersion = null;
    try {
      const a = await sql`SELECT host_agreement_version FROM hosts WHERE id = ${guest.host_id}`;
      hostAgreementVersion = a[0] ? a[0].host_agreement_version : null;
    } catch (err) { console.error('host agreement status unavailable:', err.message); }
    const verification = h ? {
      hostName: h.name,
      hostPhone: h.phone,
      aadhaarStatus: h.aadhaar_status,
      aadhaarRejectionReason: h.aadhaar_rejection_reason,
      aadhaarSubmitted: !!h.aadhaar_status && h.aadhaar_status !== 'not_submitted',
      bankStatus: h.bank_status,
      bankRejectionReason: h.bank_rejection_reason,
      bankAccountNumberMasked: maskAccount(h.bank_account_number),
      bankAccountHolderName: h.bank_account_holder_name,
      bankIfsc: h.bank_ifsc,
      panStatus: h.pan_status,
      panRejectionReason: h.pan_rejection_reason,
      panSubmitted: !!h.pan_status && h.pan_status !== 'not_submitted',
      // PAN is shown, unlike the bank account number — it's not a
      // payment credential the way an account number is, and a host
      // benefits from being able to confirm exactly what's on file.
      // Kept (encrypted) for TDS; shown to the host masked.
      panNumberMasked: maskPan(h.pan_number),
      hostAgreementAccepted: hostAgreementVersion === AGREEMENT_VERSION,
      hostAgreementVersion: AGREEMENT_VERSION
    } : null;

    // ---- Today ----
    // What is actually happening at this host's properties today: who
    // arrives, who leaves, and who is staying on. Queried separately
    // rather than filtered out of `bookings` above, which is capped at
    // the 100 most recent and would quietly miss today's arrival for a
    // busy host.
    //
    // "Today" is the PROPERTY's today. Each listing carries its own
    // timezone (see _timezones.js), so a stay in Dubai turns over on
    // Dubai's calendar and one in Pune on India's — not on the database's
    // UTC clock, which before this showed yesterday to any Indian host
    // looking before 05:30.
    let today = { arrivals: [], departures: [], staying: [], experiences: [] };
    try {
      const rows = await sql`
        SELECT o.id, o.suite_name, o.listing_id, o.arrival, o.departure, o.guests, o.nights,
               o.payout_amount,
               o.guest_email, g.name AS guest_name, g.profile_photo_url,
               COALESCE(l.listing_type, 'stay') AS listing_type,
               l.experience_start_time, l.experience_duration_days,
               l.check_in_time, l.check_out_time,
               -- Cover photo where the host set one, otherwise the first
               -- photo the listing actually has. Nothing is picked at
               -- random: it is that listing's own first exterior shot,
               -- then interior, then whatever gallery it has. Both stored
               -- shapes are handled — a bare URL string, and the
               -- {url, caption} object older listings use.
               COALESCE(
                 NULLIF(btrim(l.cover_photo_url), ''),
                 CASE WHEN jsonb_typeof(l.exterior_photo_urls->0) = 'string'
                      THEN l.exterior_photo_urls->>0 ELSE l.exterior_photo_urls->0->>'url' END,
                 CASE WHEN jsonb_typeof(l.interior_photo_urls->0) = 'string'
                      THEN l.interior_photo_urls->>0 ELSE l.interior_photo_urls->0->>'url' END,
                 CASE WHEN jsonb_typeof(l.photo_urls->0) = 'string'
                      THEN l.photo_urls->>0 ELSE l.photo_urls->0->>'url' END,
                 CASE WHEN jsonb_typeof(l.photos->0) = 'string'
                      THEN l.photos->>0 ELSE l.photos->0->>'url' END
               ) AS cover_photo_url,
               o.pet_types, o.service_animal_types, o.young_litter_count,
               (o.arrival = local.today) AS arriving,
               (o.departure = local.today) AS departing,
               (o.departure - local.today) AS nights_left
        FROM orders o
        JOIN listings l ON l.id = o.listing_id
        LEFT JOIN guests g ON g.id = o.guest_id
        CROSS JOIN LATERAL (
          SELECT (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), ${DEFAULT_TIMEZONE}))::date AS today
        ) local
        WHERE l.host_id = ${guest.host_id} AND o.status = 'paid'
          AND o.arrival <= local.today AND o.departure >= local.today
        ORDER BY o.arrival ASC, o.id ASC
      `;
      const shape = (r) => ({
        orderId: r.id,
        guestName: String(r.guest_name || '').trim() || (r.guest_email || 'Guest').split('@')[0],
        guests: Number(r.guests) || 1,
        // Enough for the panel that opens when a host taps the row: the
        // dates, the stay, and what they paid out. No guest email or
        // phone — a host messages them through Aerva.
        arrival: r.arrival,
        departure: r.departure,
        nights: Number(r.nights) || null,
        payout: Number(r.payout_amount) || null,
        listingId: r.listing_id,
        listingName: r.suite_name,
        photoUrl: r.cover_photo_url || null,
        guestPhotoUrl: r.profile_photo_url || null,
        checkInTime: r.check_in_time || null,
        checkOutTime: r.check_out_time || null,
        nightsLeft: Number(r.nights_left) || 0,
        // An experience is not checked into: it starts, at its own time,
        // and is over the same day unless it runs longer. Kept separate so
        // the page can say so rather than calling it a check-in.
        kind: (r.listing_type === 'experience') ? 'experience' : 'stay',
        startTime: r.experience_start_time || null,
        // What animals are coming, so the host can prepare: billable pets,
        // any young litter travelling with them, and service / support
        // animals (never charged, never questioned — see the booking page).
        petTypes: Array.isArray(r.pet_types) ? r.pet_types : [],
        serviceAnimals: (Array.isArray(r.service_animal_types) ? r.service_animal_types : [])
          .map(a => (a && typeof a === 'object') ? a.type : a).filter(Boolean),
        youngLitter: Number(r.young_litter_count) || 0
      });
      const all = rows.map(shape);
      const stays = all.filter(r => r.kind === 'stay');
      today = {
        arrivals: stays.filter(r => rows.find(x => x.id === r.orderId).arriving),
        departures: stays.filter(r => { const o = rows.find(x => x.id === r.orderId); return o.departing && !o.arriving; }),
        staying: stays.filter(r => { const o = rows.find(x => x.id === r.orderId); return !o.arriving && !o.departing; }),
        // Everything experience-shaped happening today, whatever day of a
        // multi-day experience it is.
        experiences: all.filter(r => r.kind === 'experience')
      };
    } catch (err) {
      console.error('today view failed (non-fatal):', err);
    }

    // Outstanding requirements on this host's own listings. Shown as a
    // notice on the dashboard and as a warning on their earnings page —
    // an email alone is too easy to miss, and the consequence here is the
    // listing being taken down.
    const complianceNotices = await openFlagsForHost(sql, guest.host_id,
      (listingId) => `${SITE_BASE}/manage-listing.html?token=${createToken(listingId, 'manage-pricing', TWO_YEARS_MS)}`);

    return res.status(200).json({ listings: listingsWithLinks, hostBadge, bookings, verification, complianceNotices, today });
  } catch (err) {
    console.error('host-listings error:', err);
    return res.status(500).json({ error: 'Could not load your listings.' });
  }
};
