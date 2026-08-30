// /api/get-pending-listings.js
// Powers admin.html. Requires the x-admin-secret header to match
// ADMIN_SECRET — this is intentionally simple (a single shared password,
// not per-user accounts), appropriate for a small internal review tool,
// not a substitute for real authentication if this ever needs multiple
// reviewers with different permissions.
//
//   POST { adminLogin: { email, password } }
//        — real admin login, no secret needed once an account exists.
//   POST { adminSignup: { email, password, name } }
//        — creates a real admin login. Requires x-admin-secret, not a
//          session — this is the one place the master secret still
//          matters day to day.
//   POST { adminForgotPassword: { email } }
//        — sends a password reset link if that email belongs to an
//          admin account, but responds identically either way (same
//          anti-enumeration approach as guest-auth.js).
//   POST { adminResetPassword: { resetToken, newPassword } }
//        — sets a new password from the emailed link, then logs the
//          admin straight in.
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
const bcrypt = require('bcryptjs');
const { logAudit } = require('./_audit-log');
const { convertInrToForeignSubunit, ZERO_DECIMAL_CURRENCIES } = require('./_currency');
const { createToken, verifyToken } = require('./_approval-token');

const sql = neon(process.env.DATABASE_URL);
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
const BACKGROUND_IMAGES_KEY = 'homepage_background_images';
const ADMIN_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — same as guest sessions
const ADMIN_RESET_LINK_LIFETIME_MS = 60 * 60 * 1000; // 1 hour — same reasoning as guest-auth.js's password reset link
const BCRYPT_ROUNDS = 12; // matches guest-auth.js exactly
const SITE_BASE = 'https://aerva.in';
// Keep this in sync with whatever your actual admin page filename is —
// see the note near the top of admin.html about why it's an obscure,
// randomly-generated name rather than the guessable "admin.html".
const ADMIN_PAGE_PATH = 'admin-e75a6e8cd0cf8f34bc57cf65.html';

async function sendAdminPasswordResetEmail(admin, resetTok) {
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set — admin cannot receive their password reset link.');
    return; // same "fail quietly, log loudly" approach as guest-auth.js's version — never reveals send failures to the caller
  }
  const link = `${SITE_BASE}/${ADMIN_PAGE_PATH}?resetToken=${resetTok}`;
  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">Reset your admin password</h2>
      <p>Click below to choose a new password for your Aerva admin account. This link expires in 1 hour.</p>
      <p><a href="${link}" style="background:#1c1a17; color:#f4eadc; padding:12px 24px; text-decoration:none; display:inline-block;">Reset Password</a></p>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">If you didn't request this, you can safely ignore this email — your password won't change unless you click the link above and set a new one.</p>
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
      to: admin.email,
      subject: 'Reset your Aerva admin password',
      html
    })
  });
  if (!res.ok) {
    let detail;
    try { detail = await res.json(); } catch { detail = { message: res.statusText }; }
    console.error('Resend send failed (admin password reset):', res.status, detail);
  }
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ---- Admin login (real email + password, no secret needed) ----
  // Deliberately runs BEFORE the auth gate below — this is how an admin
  // gets in without already having a session or the master secret.
  if (req.method === 'POST' && req.body && req.body.adminLogin) {
    try {
      const { email, password } = req.body.adminLogin;
      const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (!cleanEmail || !password) {
        return res.status(400).json({ error: 'Please enter your email and password.' });
      }
      const rows = await sql`SELECT id, email, password_hash, name FROM admins WHERE email = ${cleanEmail}`;
      const admin = rows[0];
      // Same timing-safe pattern as guest-auth.js: always run bcrypt.compare,
      // even against a dummy hash for a non-existent account, so a wrong
      // email can't be distinguished from a wrong password by response time.
      const DUMMY_HASH = '$2a$12$CwTycUXWue0Thq9StjUM0uJ8yqxbwmkQ.6qhg0OSyMH0RfaOOKKae';
      const passwordMatches = await bcrypt.compare(password, admin ? admin.password_hash : DUMMY_HASH);
      if (!admin || !passwordMatches) {
        await logAudit(sql, {
          action: 'admin_login', success: false, actorType: 'admin', actorIdentifier: cleanEmail,
          metadata: { reason: !admin ? 'no_such_account' : 'wrong_password' }
        });
        return res.status(401).json({ error: 'Incorrect email or password.' });
      }
      const sessionToken = createToken(admin.id, 'admin-session', ADMIN_SESSION_LIFETIME_MS);
      await logAudit(sql, {
        action: 'admin_login', success: true, actorType: 'admin', actorIdentifier: cleanEmail,
        targetType: 'admin', targetId: admin.id
      });
      return res.status(200).json({ sessionToken, admin: { id: admin.id, email: admin.email, name: admin.name } });
    } catch (err) {
      console.error('get-pending-listings (adminLogin) error:', err);
      return res.status(500).json({ error: 'Could not log you in right now. Please try again.' });
    }
  }

  // ---- Create a new admin account ----
  // Gated by ADMIN_SECRET itself, not a session — this is the one place
  // the shared secret still matters day to day: proving you're allowed
  // to create a real login, whether for yourself the first time or for
  // a second admin later. Not reachable with just an admin-session token.
  if (req.method === 'POST' && req.body && req.body.adminSignup) {
    const adminSecretHeader = req.headers['x-admin-secret'];
    if (!adminSecretHeader || adminSecretHeader !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const { email, password, name } = req.body.adminSignup;
      const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (!cleanEmail || !cleanEmail.includes('@')) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
      }
      if (!password || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      }
      const existing = await sql`SELECT id FROM admins WHERE email = ${cleanEmail}`;
      if (existing[0]) {
        return res.status(409).json({ error: 'An admin account with this email already exists — log in instead.' });
      }
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const inserted = await sql`
        INSERT INTO admins (email, password_hash, name)
        VALUES (${cleanEmail}, ${passwordHash}, ${name || null})
        RETURNING id, email, name
      `;
      await logAudit(sql, {
        action: 'admin_account_created', success: true, actorType: 'admin', actorIdentifier: cleanEmail,
        targetType: 'admin', targetId: inserted[0].id
      });
      return res.status(200).json({ success: true, admin: inserted[0] });
    } catch (err) {
      console.error('get-pending-listings (adminSignup) error:', err);
      return res.status(500).json({ error: 'Could not create the admin account right now. Please try again.' });
    }
  }

  // ---- Admin forgot password ----
  // Same anti-enumeration approach as guest-auth.js's version: identical
  // response whether or not the email belongs to a real admin account.
  if (req.method === 'POST' && req.body && req.body.adminForgotPassword) {
    try {
      const { email } = req.body.adminForgotPassword;
      const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (!cleanEmail || !cleanEmail.includes('@')) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
      }
      const rows = await sql`SELECT id, email FROM admins WHERE email = ${cleanEmail}`;
      const admin = rows[0];
      if (admin) {
        const resetTok = createToken(admin.id, 'admin-password-reset', ADMIN_RESET_LINK_LIFETIME_MS);
        await sendAdminPasswordResetEmail(admin, resetTok);
        await logAudit(sql, {
          action: 'admin_password_reset_requested', success: true, actorType: 'admin', actorIdentifier: cleanEmail,
          targetType: 'admin', targetId: admin.id
        });
      }
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('get-pending-listings (adminForgotPassword) error:', err);
      return res.status(200).json({ success: true }); // still the same generic response — see note above
    }
  }

  // ---- Admin reset password (from the emailed link) ----
  if (req.method === 'POST' && req.body && req.body.adminResetPassword) {
    try {
      const { resetToken, newPassword } = req.body.adminResetPassword;
      if (!resetToken) {
        return res.status(400).json({ error: 'This reset link is missing its token — please request a new one.' });
      }
      if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      }
      const payload = verifyToken(resetToken);
      if (!payload || payload.action !== 'admin-password-reset') {
        return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
      }
      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      const rows = await sql`
        UPDATE admins SET password_hash = ${passwordHash} WHERE id = ${payload.listingId}
        RETURNING id, email, name
      `;
      const admin = rows[0];
      if (!admin) return res.status(404).json({ error: 'Account not found.' });

      // Same convenience as the guest-facing version: one click both
      // resets the password and logs the admin straight in.
      const sessionToken = createToken(admin.id, 'admin-session', ADMIN_SESSION_LIFETIME_MS);
      await logAudit(sql, {
        action: 'admin_password_reset_completed', success: true, actorType: 'admin', actorIdentifier: admin.email,
        targetType: 'admin', targetId: admin.id
      });
      return res.status(200).json({ sessionToken, admin: { id: admin.id, email: admin.email, name: admin.name } });
    } catch (err) {
      console.error('get-pending-listings (adminResetPassword) error:', err);
      return res.status(500).json({ error: 'Could not reset your password right now. Please try again.' });
    }
  }

  // ---- Everything else requires either a valid admin session OR the
  // master secret (kept working so nothing already relying on it breaks) ----
  const adminSecret = req.headers['x-admin-secret'];
  const authHeader = req.headers['authorization'] || '';
  const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const sessionPayload = sessionToken ? verifyToken(sessionToken) : null;
  const hasValidSession = sessionPayload && sessionPayload.action === 'admin-session';
  const hasValidSecret = adminSecret && adminSecret === process.env.ADMIN_SECRET;
  if (!hasValidSession && !hasValidSecret) {
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
