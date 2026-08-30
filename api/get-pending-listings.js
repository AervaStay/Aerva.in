// /api/get-pending-listings.js
// Powers admin.html. Requires the x-admin-secret header to match
// ADMIN_SECRET — this is intentionally simple (a single shared password,
// not per-user accounts), appropriate for a small internal review tool,
// not a substitute for real authentication if this ever needs multiple
// reviewers with different permissions.
//
//   GET  — pending listings for review, as before.
//   GET ?verifications=1 — hosts with an Aadhaar or bank submission
//          awaiting review (pending_review), instead of pending listings.
//   GET ?disputes=1 — disputed security deposits awaiting an admin
//          decision (see resolveDispute below), instead of pending listings.
//   POST { verifyDocument: { hostId, field: 'aadhaar'|'bank', action:
//          'approve'|'reject', reason? } }
//        — the actual human check pending_review exists for: an admin
//          looking at the uploaded document (or bank details) and
//          approving or rejecting it. reason is required when rejecting.
//   POST { backgroundImages: [url, url, ...] }
//        — saves the admin's chosen homepage background photos. Kept in
//          this same file (rather than its own /api endpoint) to stay
//          under Vercel's Hobby-plan 12-serverless-function limit, and
//          because it's the same admin-secret gate either way. Uploading
//          the actual image files still goes through the existing
//          blob-upload.js first — this call only saves the resulting
//          URLs. An empty array clears the selection, and the homepage
//          falls back to using every listing's own cover photo instead
//          (see get-listings.js's ?siteBackground=1 mode, which is what
//          the homepage actually reads from).
//   POST { processDeposits: true }
//        — finds every security deposit past its 7-day hold with no
//          dispute raised, and refunds each one in full to the guest's
//          original payment method via Razorpay. Admin-triggered by
//          design (a button in admin.html), not an unattended cron job —
//          this moves real money. Returns per-order results so a partial
//          failure is visible rather than silent.
//   POST { resolveDispute: { orderId, compensationAmount } }
//        — an admin's decision on a disputed deposit: compensationAmount
//          (capped at the deposit itself) is recorded against the order
//          for the host's payout, and whatever's left of the deposit is
//          refunded to the guest the same way processDeposits does.
//
// Requires a site_settings table:
//   CREATE TABLE IF NOT EXISTS site_settings (
//     key TEXT PRIMARY KEY,
//     value JSONB NOT NULL,
//     updated_at TIMESTAMPTZ DEFAULT now()
//   );
//
// processDeposits and resolveDispute both call the Razorpay Refunds API
// (razorpay.payments.refund) — make sure this has been tested against a
// real Razorpay test-mode payment before relying on it in production.

const { neon } = require('@neondatabase/serverless');
const Razorpay = require('razorpay');
const { logAudit } = require('./_audit-log');
const { convertInrToForeignSubunit, ZERO_DECIMAL_CURRENCIES } = require('./_currency');

const sql = neon(process.env.DATABASE_URL);
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
const BACKGROUND_IMAGES_KEY = 'homepage_background_images';

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminSecret = req.headers['x-admin-secret'];
  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'POST') {
    // ---- Auto-refund every held deposit past its 7-day release date ----
    // Admin-triggered rather than a blind cron job — this endpoint does
    // real money movement via Razorpay, so a human clicking "Process" in
    // admin.html is the safety check before it runs, at least until this
    // has been tested enough in production to trust running unattended.
    if (req.body && req.body.processDeposits) {
      try {
        const eligible = await sql`
          SELECT id, razorpay_payment_id, deposit_amount, charge_currency
          FROM orders
          WHERE deposit_status = 'held' AND deposit_release_at <= CURRENT_DATE AND deposit_amount > 0
        `;

        const results = [];
        for (const order of eligible) {
          try {
            // A refund has to be issued in the SAME currency the payment
            // was originally charged in — deposit_amount is always stored
            // in INR, but if this particular order was charged directly
            // in a foreign currency (International Payments — see
            // create-order.js), refunding it as INR paise against a
            // foreign-currency payment would be wrong. Convert first.
            const currency = order.charge_currency || 'INR';
            let refundAmount;
            if (currency === 'INR') {
              refundAmount = Math.round(Number(order.deposit_amount) * 100);
            } else {
              refundAmount = await convertInrToForeignSubunit(sql, Number(order.deposit_amount), currency);
              if (!refundAmount) {
                throw new Error(`No cached rate available to refund this ${currency} deposit — left 'held' for manual review.`);
              }
            }

            // A partial refund on the ORIGINAL payment — Razorpay sends
            // this back to whatever the guest originally paid with
            // (card, UPI, etc.) automatically. This is what satisfies
            // "refunded ... into the same account" — Aerva never asks
            // for or stores separate refund destination details.
            const refund = await razorpay.payments.refund(order.razorpay_payment_id, {
              amount: refundAmount,
              speed: 'normal',
            });
            await sql`
              UPDATE orders SET deposit_status = 'refunded', deposit_refund_id = ${refund.id}
              WHERE id = ${order.id}
            `;
            results.push({ orderId: order.id, success: true });
          } catch (refundErr) {
            // One failed refund (e.g. a payment too old for Razorpay to
            // refund) shouldn't block the rest — log it and keep going,
            // leaving that order's status as 'held' for manual follow-up.
            console.error(`processDeposits: refund failed for order ${order.id}:`, refundErr);
            results.push({ orderId: order.id, success: false, error: refundErr.message || 'Refund failed' });
          }
        }

        return res.status(200).json({ processed: results.length, results });
      } catch (err) {
        console.error('get-pending-listings (processDeposits) error:', err);
        return res.status(500).json({ error: 'Could not process deposits right now.' });
      }
    }

    // ---- Resolve a disputed deposit ----
    // An admin decides how much of the deposit compensates the host for
    // damage/etc.; whatever's left over (if anything) goes back to the
    // guest the same way processDeposits refunds do — a partial refund on
    // the original payment. The host's compensation isn't paid out
    // automatically here (Aerva's payouts are handled outside this
    // codebase, same as regular booking payouts) — deposit_resolution_amount
    // just records the decision so it's visible on the host's dashboard
    // and can be included in their next payout.
    if (req.body && req.body.resolveDispute) {
      try {
        const { orderId, compensationAmount } = req.body.resolveDispute;
        const rows = await sql`SELECT id, razorpay_payment_id, deposit_amount, deposit_status, charge_currency FROM orders WHERE id = ${orderId}`;
        const order = rows[0];
        if (!order) return res.status(404).json({ error: 'Order not found.' });
        if (order.deposit_status !== 'disputed') {
          return res.status(400).json({ error: 'This deposit is not currently disputed.' });
        }

        const compensation = Math.max(0, Math.min(Number(compensationAmount) || 0, Number(order.deposit_amount)));
        const guestRefundAmount = Number(order.deposit_amount) - compensation;

        let refundId = null;
        if (guestRefundAmount > 0) {
          // Same currency-matching requirement as processDeposits above —
          // a refund has to be issued in whatever currency the payment
          // was actually charged in.
          const currency = order.charge_currency || 'INR';
          let refundSubunitAmount;
          if (currency === 'INR') {
            refundSubunitAmount = Math.round(guestRefundAmount * 100);
          } else {
            refundSubunitAmount = await convertInrToForeignSubunit(sql, guestRefundAmount, currency);
            if (!refundSubunitAmount) {
              return res.status(502).json({ error: `No cached rate available to refund this ${currency} deposit right now. Please try again shortly.` });
            }
          }
          const refund = await razorpay.payments.refund(order.razorpay_payment_id, {
            amount: refundSubunitAmount,
            speed: 'normal',
          });
          refundId = refund.id;
        }

        await sql`
          UPDATE orders SET
            deposit_status = 'resolved', deposit_resolution_amount = ${compensation}, deposit_refund_id = ${refundId}
          WHERE id = ${orderId}
        `;

        return res.status(200).json({ success: true, compensation, guestRefundAmount });
      } catch (err) {
        console.error('get-pending-listings (resolveDispute) error:', err);
        return res.status(500).json({ error: 'Could not resolve this dispute right now.' });
      }
    }

    // ---- Approve or reject a pending Aadhaar/bank submission ----
    // This is the actual human check that pending_review exists for —
    // an admin looking at the uploaded document (or the bank details)
    // and deciding whether it's genuine, rather than the old behavior
    // of trusting any upload automatically.
    if (req.body && req.body.verifyDocument) {
      try {
        const { hostId, field, action, reason } = req.body.verifyDocument;
        if (field !== 'aadhaar' && field !== 'bank') {
          return res.status(400).json({ error: 'Invalid field.' });
        }
        if (action !== 'approve' && action !== 'reject') {
          return res.status(400).json({ error: 'Invalid action.' });
        }
        if (action === 'reject' && (!reason || !String(reason).trim())) {
          return res.status(400).json({ error: 'Please provide a reason for rejecting this.' });
        }

        const newStatus = action === 'approve' ? 'verified' : 'rejected';
        const cleanReason = action === 'reject' ? String(reason).trim().slice(0, 500) : null;

        if (field === 'aadhaar') {
          await sql`
            UPDATE hosts SET aadhaar_status = ${newStatus}, aadhaar_rejection_reason = ${cleanReason}
            WHERE id = ${hostId} AND aadhaar_status = 'pending_review'
          `;
        } else {
          await sql`
            UPDATE hosts SET bank_status = ${newStatus}, bank_rejection_reason = ${cleanReason}
            WHERE id = ${hostId} AND bank_status = 'pending_review'
          `;
        }

        await logAudit(sql, {
          action: `host_${field}_${action}d`, success: true, actorType: 'admin', actorIdentifier: 'admin',
          targetType: 'host', targetId: hostId
        });

        return res.status(200).json({ success: true });
      } catch (err) {
        console.error('get-pending-listings (verifyDocument) error:', err);
        return res.status(500).json({ error: 'Could not update this verification right now.' });
      }
    }

    try {
      const { backgroundImages } = req.body || {};
      // Only real Blob URLs are kept — same defensive pattern used
      // everywhere else photo URLs are accepted from a request body (see
      // submit-listing.js) — never trust an arbitrary string into this.
      const safeImages = Array.isArray(backgroundImages)
        ? backgroundImages.filter(url => typeof url === 'string' && url.startsWith('https://')).slice(0, 20)
        : [];

      await sql`
        INSERT INTO site_settings (key, value, updated_at)
        VALUES (${BACKGROUND_IMAGES_KEY}, ${JSON.stringify(safeImages)}, now())
        ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(safeImages)}, updated_at = now()
      `;

      return res.status(200).json({ success: true, images: safeImages });
    } catch (err) {
      console.error('get-pending-listings (POST background) error:', err);
      return res.status(500).json({ error: 'Could not save background images right now.' });
    }
  }

  // ---- Host ID/bank verifications awaiting review ----
  // Same pattern as disputes above — pending_review Aadhaar/bank
  // submissions, which now actually require a human look before
  // becoming 'verified' (see host-listings.js for why this changed).
  if (req.query.verifications === '1') {
    try {
      const verifications = await sql`
        SELECT id, guest_id, email, name, phone,
               aadhaar_document_url, aadhaar_status,
               bank_account_number, bank_ifsc, bank_account_holder_name, bank_status
        FROM hosts
        WHERE aadhaar_status = 'pending_review' OR bank_status = 'pending_review'
        ORDER BY id ASC
      `;
      return res.status(200).json({ verifications });
    } catch (err) {
      console.error('get-pending-listings (verifications) error:', err);
      return res.status(500).json({ error: 'Could not fetch verifications' });
    }
  }

  // ---- Disputed deposits awaiting review ----
  // A separate GET mode (?disputes=1) rather than always bundling this in
  // — admin.html only needs it on the deposits tab, not on every load of
  // the pending-listings view.
  if (req.query.disputes === '1') {
    try {
      const disputes = await sql`
        SELECT o.id, o.suite_name, o.arrival, o.departure, o.deposit_amount,
               o.dispute_reason, o.dispute_raised_at, o.guest_email,
               l.host_name, l.host_email
        FROM orders o
        JOIN listings l ON o.listing_id = l.id
        WHERE o.deposit_status = 'disputed'
        ORDER BY o.dispute_raised_at ASC
      `;
      return res.status(200).json({ disputes });
    } catch (err) {
      console.error('get-pending-listings (disputes) error:', err);
      return res.status(500).json({ error: 'Could not fetch disputes' });
    }
  }

  try {
    const listings = await sql`
      SELECT l.id, l.property_name, l.city, l.property_type, l.bedrooms, l.max_guests,
             l.nightly_rate, l.description, l.amenities, l.services,
             l.host_name, l.host_email, l.host_phone,
             l.discount_type, l.discount_value, l.discount_min_nights, l.discount_description,
             l.exterior_photo_urls, l.interior_photo_urls,
             l.commission_rate, l.created_at,
             l.listing_type, l.hosting_listing_id, l.experience_category,
             l.experience_price_unit, l.experience_duration_hours,
             h.property_name AS hosting_property_name
      FROM listings l
      LEFT JOIN listings h ON h.id = l.hosting_listing_id
      WHERE l.status = 'pending'
      ORDER BY l.created_at ASC
    `;
    return res.status(200).json({ listings });
  } catch (err) {
    console.error('get-pending-listings error:', err);
    return res.status(500).json({ error: 'Could not fetch listings' });
  }
};
