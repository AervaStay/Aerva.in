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
const { logAudit } = require('./_audit-log');
const { convertInrToForeignSubunit } = require('./_currency');
const { verifyRazorpaySignature } = require('./_razorpay-verify');
const { validatePhoneNumber } = require('./_phone-validation');
const { countRecentAttempts, getClientIp } = require('./_rate-limit');
const crypto = require('crypto');

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
async function sendCancellationEmail(order){
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set — guest will not receive a cancellation notice.');
    return;
  }
  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">Your booking has been cancelled</h2>
      <p>Your host has cancelled your stay at <strong>${order.suite_name}</strong> (${order.arrival} — ${order.departure}).</p>
      <p>Your full payment has been refunded to your original payment method — it should appear within 5–7 business days depending on your bank.</p>
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

async function sendCouponEmail(coupon, code, expiresAt){
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set — guest will not receive their coupon.');
    return;
  }
  const fmt = (n) => '₹' + Number(n).toLocaleString('en-IN');
  const expiresLabel = expiresAt.toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">You've received an Aerva coupon</h2>
      <p>Your host for <strong>${coupon.suite_name}</strong> has issued you a coupon worth <strong>${fmt(coupon.amount)}</strong>.</p>
      <p style="background:#f4eadc; padding:16px; text-align:center; font-size:20px; letter-spacing:0.05em; font-weight:600;">${code}</p>
      <p>Apply this code at checkout on any Aerva stay or experience. Valid until <strong>${expiresLabel}</strong> (3 months from today).</p>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">Questions about this coupon? Contact hello@aerva.in.</p>
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
      to: coupon.guest_email,
      subject: 'You\'ve received an Aerva coupon',
      html
    })
  });
  if (!res.ok) {
    let detail;
    try { detail = await res.json(); } catch { detail = { message: res.statusText }; }
    console.error('Resend send failed (coupon notice):', res.status, detail);
  }
}
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

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const guestId = requireGuestId(req);
  if (!guestId) return res.status(401).json({ error: 'Please log in again.' });

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
        SELECT o.id, o.listing_id, o.guest_id, o.departure, o.status
        FROM orders o JOIN listings l ON l.id = o.listing_id
        WHERE o.id = ${orderId} AND l.host_id = ${me.host_id}
      `;
      const order = rows[0];
      if (!order) return res.status(404).json({ error: 'Booking not found.' });
      if (order.status !== 'paid') return res.status(400).json({ error: 'Only completed stays can be reviewed.' });
      if (!order.guest_id) return res.status(400).json({ error: 'This booking has no guest account to review.' });
      if (!submissionOpen(order.departure)) {
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
      const blended = Number((FIELDS.reduce((a, f) => a + vals[f], 0) / FIELDS.length).toFixed(2));

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

      await sql`
        UPDATE orders SET deposit_status = 'disputed', dispute_reason = ${String(reason).trim().slice(0, 1000)}, dispute_raised_at = now()
        WHERE id = ${orderId}
      `;
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
  async function loadCancellableOrder(orderId, enforceCutoff){
    const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
    const guest = guestRows[0];
    if (!guest || !guest.host_id) {
      return { error: 'You do not have permission to do this.', status: 403 };
    }
    const rows = await sql`
      SELECT o.id, o.suite_name, o.arrival, o.departure, o.guest_email, o.guest_id, o.status,
             o.total, o.deposit_status, o.charge_currency, o.razorpay_payment_id
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
  async function executeCancellationRefund(order, orderId, reason, hostId, auditAction){
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

    const refund = await razorpay.payments.refund(order.razorpay_payment_id, {
      amount: refundAmount,
      speed: 'normal',
    });

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

    await sendCancellationEmail(order);
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
      const { orderId, reason } = req.body.cancelBooking;
      if (!orderId || !reason || !String(reason).trim()) {
        return res.status(400).json({ error: 'Please explain why you\'re cancelling this booking.' });
      }
      const loaded = await loadCancellableOrder(orderId, true);
      if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

      await executeCancellationRefund(loaded.order, orderId, reason, loaded.guest.host_id, 'booking_cancelled_by_host');
      return res.status(200).json({ success: true });
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
  if (req.method === 'POST' && req.body && req.body.cancelWithCoupon) {
    try {
      const { orderId } = req.body.cancelWithCoupon;
      if (!orderId) return res.status(400).json({ error: 'Missing booking.' });

      const loaded = await loadCancellableOrder(orderId, true);
      if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

      const couponRows = await sql`
        SELECT id FROM coupons
        WHERE source_order_id = ${orderId} AND status = 'active' AND expires_at > now()
      `;
      if (!couponRows[0]) {
        return res.status(400).json({ error: 'A compensation coupon must be issued to this guest before this booking can be cancelled to prioritize another one. Issue a coupon first.' });
      }

      await executeCancellationRefund(
        loaded.order, orderId,
        'Host prioritized a different booking on this space; guest was issued a compensation coupon before cancellation.',
        loaded.guest.host_id, 'booking_cancelled_by_host_with_coupon'
      );
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('host-listings (cancelWithCoupon) error:', err);
      const status = err.isUserFacing ? err.status : 500;
      return res.status(status).json({ error: err.isUserFacing ? err.message : 'Could not cancel this booking right now. Please try again, or contact hello@aerva.in.' });
    }
  }

  // ---- Buy a compensation coupon for a guest (step 1: create the
  // Razorpay order for the HOST to pay Aerva) ----
  // This is a genuinely different kind of transaction from everything
  // else in this codebase — the host is paying Aerva, not a guest paying
  // for a stay. Creates a 'pending_payment' coupon row now; it only
  // becomes real and usable once verifyCouponPayment below confirms the
  // payment actually succeeded.
  if (req.method === 'POST' && req.body && req.body.buyCouponOrder) {
    try {
      const { bookingId, amount } = req.body.buyCouponOrder;
      const numAmount = Number(amount);
      if (!bookingId || !numAmount || numAmount <= 0) {
        return res.status(400).json({ error: 'Please enter a booking and a valid amount.' });
      }

      const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
      const guest = guestRows[0];
      if (!guest || !guest.host_id) {
        return res.status(403).json({ error: 'You do not have permission to do this.' });
      }

      // Ownership check — the booking this coupon is "against" has to
      // genuinely belong to this host, same as every other order lookup
      // in this file.
      const orderRows = await sql`
        SELECT o.id, o.guest_id, o.guest_email, o.suite_name
        FROM orders o
        JOIN listings l ON o.listing_id = l.id
        WHERE o.id = ${bookingId} AND l.host_id = ${guest.host_id}
      `;
      const sourceOrder = orderRows[0];
      if (!sourceOrder) {
        return res.status(403).json({ error: 'That booking ID does not belong to one of your listings.' });
      }
      if (!sourceOrder.guest_id) {
        return res.status(400).json({ error: 'This booking has no linked guest account to issue a coupon to.' });
      }

      const razorpayOrder = await razorpay.orders.create({
        amount: Math.round(numAmount * 100), // paise — coupon purchases are always INR, host-side, regardless of what currency the guest was charged in
        currency: 'INR',
        receipt: `aerva_coupon_${Date.now()}`,
        notes: { type: 'host_coupon_purchase', hostId: String(guest.host_id), bookingId: String(bookingId) },
      });

      const couponRows = await sql`
        INSERT INTO coupons (code, guest_id, amount, issuing_host_id, source_order_id, status, razorpay_order_id)
        VALUES (${'PENDING-' + razorpayOrder.id}, ${sourceOrder.guest_id}, ${numAmount}, ${guest.host_id}, ${bookingId}, 'pending_payment', ${razorpayOrder.id})
        RETURNING id
      `;

      return res.status(200).json({
        couponId: couponRows[0].id,
        razorpayOrderId: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
      });
    } catch (err) {
      console.error('host-listings (buyCouponOrder) error:', err);
      return res.status(500).json({ error: 'Could not start the coupon payment right now. Please try again.' });
    }
  }

  // ---- Confirm the coupon payment actually succeeded (step 2) ----
  // Same "never trust the browser's word alone" principle as
  // verify-payment.js — re-verifies the Razorpay signature server-side
  // before treating the coupon as real. Only on success does the coupon
  // become 'active', get its real code, and get emailed to the guest.
  if (req.method === 'POST' && req.body && req.body.verifyCouponPayment) {
    try {
      const { couponId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body.verifyCouponPayment;
      if (!verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
        return res.status(400).json({ verified: false, error: 'Payment could not be verified.' });
      }

      const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
      const guest = guestRows[0];
      if (!guest || !guest.host_id) {
        return res.status(403).json({ error: 'You do not have permission to do this.' });
      }

      const rows = await sql`
        SELECT c.id, c.status, c.amount, c.guest_id, c.source_order_id, c.razorpay_order_id, o.guest_email, o.suite_name
        FROM coupons c
        JOIN orders o ON c.source_order_id = o.id
        WHERE c.id = ${couponId} AND c.issuing_host_id = ${guest.host_id}
      `;
      const coupon = rows[0];
      if (!coupon) return res.status(403).json({ error: 'You do not have permission to do this.' });
      if (coupon.razorpay_order_id !== razorpay_order_id) {
        return res.status(400).json({ error: 'This payment does not match the coupon being confirmed.' });
      }
      if (coupon.status === 'active') {
        return res.status(200).json({ verified: true, code: coupon.code }); // already processed — safe to no-op rather than error on a retry
      }

      // A real, guessable-resistant code — not the placeholder written at
      // buyCouponOrder time.
      const code = 'AERVA-' + crypto.randomBytes(5).toString('hex').toUpperCase();
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 3);

      await sql`
        UPDATE coupons SET
          status = 'active', code = ${code}, razorpay_payment_id = ${razorpay_payment_id}, expires_at = ${expiresAt.toISOString()}
        WHERE id = ${couponId}
      `;

      await logAudit(sql, {
        action: 'coupon_purchased', success: true, actorType: 'host', actorIdentifier: String(guest.host_id),
        targetType: 'coupon', targetId: couponId
      });

      await sendCouponEmail(coupon, code, expiresAt);

      return res.status(200).json({ verified: true, code });
    } catch (err) {
      console.error('host-listings (verifyCouponPayment) error:', err);
      return res.status(500).json({ error: 'Could not confirm the coupon payment right now. Please try again.' });
    }
  }

  // ---- Submit or resubmit verification info ----
  if (req.method === 'POST') {
    try {
      const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
      const guest = guestRows[0];
      if (!guest || !guest.host_id) {
        return res.status(400).json({ error: 'List a property first to create your host account.' });
      }

      const { aadhaarDocumentUrl, bankAccountNumber, bankIfsc, bankAccountHolderName, panNumber, panDocumentUrl, hostName, hostPhone } = req.body || {};
      const current = await sql`
        SELECT aadhaar_status, aadhaar_document_url, aadhaar_rejection_reason,
               bank_status, pan_status, pan_document_url, pan_rejection_reason
        FROM hosts WHERE id = ${guest.host_id}
      `;
      const host = current[0];
      let didSomething = false;

      // ---- PAN: submit once, then permanently locked ----
      if (typeof panDocumentUrl === 'string' && panDocumentUrl.startsWith('https://')) {
        if (host.pan_document_url) {
          return res.status(400).json({ error: 'Your PAN has already been submitted and can\'t be changed. Contact hello@aerva.in if you need to update it.' });
        }
        const cleanPan = typeof panNumber === 'string' ? panNumber.trim().toUpperCase() : '';
        if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(cleanPan)) {
          return res.status(400).json({ error: 'Please enter a valid 10-character PAN, e.g. ABCDE1234F.' });
        }
        await sql`
          UPDATE hosts SET pan_number = ${cleanPan}, pan_document_url = ${panDocumentUrl}, pan_status = 'pending_review', pan_rejection_reason = NULL
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
        if (host.aadhaar_document_url) {
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
            bank_account_number = ${cleanAccountNumber}, bank_ifsc = ${cleanIfsc},
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
      return res.status(200).json({ listings: [], bookings: [], verification: null });
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
             o.status, o.created_at, o.pet_types,
             o.guest_email, g.name AS guest_name
      FROM orders o
      JOIN listings l ON o.listing_id = l.id
      LEFT JOIN guests g ON g.id = o.guest_id
      WHERE l.host_id = ${guest.host_id}
      ORDER BY o.created_at DESC
      LIMIT 100
    `;

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
    const verification = h ? {
      hostName: h.name,
      hostPhone: h.phone,
      aadhaarStatus: h.aadhaar_status,
      aadhaarRejectionReason: h.aadhaar_rejection_reason,
      aadhaarSubmitted: !!h.aadhaar_document_url,
      bankStatus: h.bank_status,
      bankRejectionReason: h.bank_rejection_reason,
      bankAccountNumberMasked: h.bank_account_number ? '••••' + h.bank_account_number.slice(-4) : null,
      bankAccountHolderName: h.bank_account_holder_name,
      bankIfsc: h.bank_ifsc,
      panStatus: h.pan_status,
      panRejectionReason: h.pan_rejection_reason,
      panSubmitted: !!h.pan_document_url,
      // PAN is shown, unlike the bank account number — it's not a
      // payment credential the way an account number is, and a host
      // benefits from being able to confirm exactly what's on file.
      panNumberMasked: h.pan_number || null
    } : null;

    return res.status(200).json({ listings: listingsWithLinks, hostBadge, bookings, verification });
  } catch (err) {
    console.error('host-listings error:', err);
    return res.status(500).json({ error: 'Could not load your listings.' });
  }
};
