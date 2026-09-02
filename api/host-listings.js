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
//          Aadhaar/bank verification status, and each booking now
//          includes its deposit fields (amount, status, release date,
//          any dispute already raised).
//   POST { aadhaarDocumentUrl? , bankAccountNumber?, bankIfsc?,
//          bankAccountHolderName? } — submits (or resubmits) whichever
//          section is included. Locked once a section is 'verified'
//          (contact support to change verified info, rather than letting
//          it be silently overwritten).
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

      const { aadhaarDocumentUrl, bankAccountNumber, bankIfsc, bankAccountHolderName } = req.body || {};
      const current = await sql`SELECT aadhaar_status, bank_status FROM hosts WHERE id = ${guest.host_id}`;
      const host = current[0];

      if (typeof aadhaarDocumentUrl === 'string' && aadhaarDocumentUrl.startsWith('https://')) {
        if (host.aadhaar_status === 'verified') {
          return res.status(400).json({ error: 'Your Aadhaar is already approved. Contact hello@aerva.in to change it.' });
        }
        if (host.aadhaar_status === 'pending_review') {
          return res.status(400).json({ error: 'Your Aadhaar is already submitted and awaiting review.' });
        }
        // Uploading a file only confirms a file was uploaded — it says
        // nothing about whose document it actually is. This used to jump
        // straight to 'verified', which meant literally any HTTPS URL
        // (including someone else's ID) was accepted as "verified" with
        // zero actual checking. Real verification now happens as a human
        // admin review (see get-pending-listings.js's ?verifications=1
        // mode and its verifyDocument POST action) — pending_review is
        // the correct state until that review happens, matching what
        // host-dashboard.html's badge/label logic already expected.
        await sql`
          UPDATE hosts SET aadhaar_document_url = ${aadhaarDocumentUrl}, aadhaar_status = 'pending_review', aadhaar_rejection_reason = NULL
          WHERE id = ${guest.host_id}
        `;
        await logAudit(sql, {
          action: 'host_aadhaar_submitted', success: true, actorType: 'host', actorIdentifier: String(guest.host_id),
          targetType: 'host', targetId: guest.host_id
        });
      }

      const hasBankInfo = bankAccountNumber && bankIfsc && bankAccountHolderName;
      if (hasBankInfo) {
        if (host.bank_status === 'verified') {
          return res.status(400).json({ error: 'Your bank details are already approved. Contact hello@aerva.in to change them.' });
        }
        if (host.bank_status === 'pending_review') {
          return res.status(400).json({ error: 'Your bank details are already submitted and awaiting review.' });
        }
        // Format checks only (real account number pattern, real IFSC
        // pattern) — this was already the comment's stated intent, but
        // the code below it still auto-approved on format alone. Same
        // fix as Aadhaar: pending_review until an admin actually looks
        // at it, not an automatic "verified" the moment the numbers look
        // shaped right.
        const cleanAccountNumber = String(bankAccountNumber).replace(/\s/g, '');
        const cleanIfsc = String(bankIfsc).trim().toUpperCase();
        if (!/^\d{6,20}$/.test(cleanAccountNumber)) {
          return res.status(400).json({ error: 'Please enter a valid bank account number.' });
        }
        if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(cleanIfsc)) {
          return res.status(400).json({ error: 'Please enter a valid IFSC code.' });
        }
        await sql`
          UPDATE hosts SET
            bank_account_number = ${cleanAccountNumber}, bank_ifsc = ${cleanIfsc},
            bank_account_holder_name = ${String(bankAccountHolderName).trim().slice(0, 100)},
            bank_status = 'pending_review', bank_rejection_reason = NULL
          WHERE id = ${guest.host_id}
        `;
        await logAudit(sql, {
          action: 'host_bank_details_submitted', success: true, actorType: 'host', actorIdentifier: String(guest.host_id),
          targetType: 'host', targetId: guest.host_id
        });
      }

      if (!aadhaarDocumentUrl && !hasBankInfo) {
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
             description, amenities, services, host_name, host_phone,
             discount_type, discount_value, discount_min_nights, discount_description,
             latitude, longitude, formatted_address,
             exterior_photo_urls, interior_photo_urls, cover_photo_url, created_at
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
      SELECT o.id, o.suite_name, o.listing_id, o.arrival, o.departure, o.nights,
             o.subtotal, o.discount_amount, o.gst,
             o.commission_rate, o.commission_amount, o.payout_amount,
             o.deposit_amount, o.deposit_status, o.deposit_release_at,
             o.dispute_reason, o.dispute_raised_at, o.deposit_resolution_amount,
             o.cancellation_reason, o.cancelled_at,
             o.status, o.created_at
      FROM orders o
      JOIN listings l ON o.listing_id = l.id
      WHERE l.host_id = ${guest.host_id}
      ORDER BY o.created_at DESC
      LIMIT 100
    `;

    // Verification status for the checklist. Bank account number is
    // masked to its last 4 digits — even the host's own dashboard never
    // re-displays the full number once submitted, so there's one fewer
    // place it exists in full anywhere in the UI.
    const hostRows = await sql`
      SELECT aadhaar_status, aadhaar_rejection_reason,
             bank_status, bank_rejection_reason, bank_account_number, bank_account_holder_name
      FROM hosts WHERE id = ${guest.host_id}
    `;
    const h = hostRows[0];
    const verification = h ? {
      aadhaarStatus: h.aadhaar_status,
      aadhaarRejectionReason: h.aadhaar_rejection_reason,
      bankStatus: h.bank_status,
      bankRejectionReason: h.bank_rejection_reason,
      bankAccountNumberMasked: h.bank_account_number ? '••••' + h.bank_account_number.slice(-4) : null,
      bankAccountHolderName: h.bank_account_holder_name
    } : null;

    return res.status(200).json({ listings: listingsWithLinks, hostBadge, bookings, verification });
  } catch (err) {
    console.error('host-listings error:', err);
    return res.status(500).json({ error: 'Could not load your listings.' });
  }
};
