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
        return { price: discounted, promoName: promo.name, promoId: promo.id };
      }

      // Each ROW here is one bookable unit — a Resort's individual
      // rooms each get their own row, not aggregated into one line for
      // the whole resort, so a host can see and act on a specific
      // room's availability directly from this one view without
      // opening that listing separately.
      const rows = [];
      for (const listing of listings) {
        const promotions = await sql`
          SELECT id, room_id, name, discount_type, discount_value, start_date, end_date FROM listing_promotions
          WHERE listing_id = ${listing.id} AND is_active = TRUE
            AND start_date < ${endStr}::date AND end_date > ${startStr}::date
        `;
        if (listing.property_type === 'Resort') {
          const rooms = await sql`SELECT id, room_name, nightly_rate FROM listing_rooms WHERE listing_id = ${listing.id} AND is_active = TRUE ORDER BY sort_order ASC, created_at ASC`;
          for (const room of rooms) {
            const bookedRanges = await sql`
              SELECT id, arrival AS start_date, departure AS end_date, guest_email, guests, nights, total FROM orders
              WHERE room_id = ${room.id} AND status = 'paid'
                AND arrival < ${endStr}::date AND departure > ${startStr}::date
            `;
            const blockedRanges = await sql`
              SELECT start_date, end_date FROM listing_blocked_dates
              WHERE listing_id = ${listing.id} AND (room_id = ${room.id} OR room_id IS NULL)
                AND start_date < ${endStr}::date AND end_date > ${startStr}::date
            `;
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
            rows.push({ listingId: listing.id, roomId: null, label: `${listing.property_name} (no active rooms yet)`, propertyType: listing.property_type, dayStatuses: dayStrs.map(() => 'available'), dayPricing: dayStrs.map(() => ({ price: 0, promoName: null, promoId: null })), bookings: [] });
          }
        } else {
          const bookedRanges = await sql`
            SELECT id, arrival AS start_date, departure AS end_date, guest_email, guests, nights, total FROM orders
            WHERE listing_id = ${listing.id} AND status = 'paid'
              AND arrival < ${endStr}::date AND departure > ${startStr}::date
          `;
          const blockedRanges = await sql`
            SELECT start_date, end_date FROM listing_blocked_dates
            WHERE listing_id = ${listing.id}
              AND start_date < ${endStr}::date AND end_date > ${startStr}::date
          `;
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
        WHERE listing_id = ${listingId} AND (room_id = ${safeRoomId} OR (room_id IS NULL AND ${safeRoomId}::int IS NULL))
          AND start_date <= ${date}::date AND end_date > ${date}::date
        LIMIT 1
      `;
      if (!existing[0]) {
        return res.status(400).json({ error: 'No block was found covering this date.' });
      }
      await sql`DELETE FROM listing_blocked_dates WHERE id = ${existing[0].id}`;
      return res.status(200).json({ success: true, blocked: false });
    } catch (err) {
      console.error('host-listings (toggleBlockedDate) error:', err);
      return res.status(500).json({ error: 'Could not remove this block right now.' });
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
      if (safeRoomId) {
        const roomRows = await sql`SELECT id FROM listing_rooms WHERE id = ${safeRoomId} AND listing_id = ${listingId}`;
        if (!roomRows[0]) return res.status(400).json({ error: 'That room could not be found on this listing.' });
      }

      await sql`
        INSERT INTO listing_promotions (listing_id, room_id, name, discount_type, discount_value, min_nights, start_date, end_date, is_active)
        VALUES (${listingId}, ${safeRoomId}, ${name.trim()}, ${discountType}, ${value}, ${minNights ? Number(minNights) : null}, ${startDate}::date, ${endDate}::date, TRUE)
      `;
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
