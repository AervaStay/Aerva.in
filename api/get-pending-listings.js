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
//   GET ?liveListings=1
//        — every listing that has ever gone live (status IN ('approved',
//          'blocked', 'removed')), for the admin's moderation view.
//          Pending/rejected submissions aren't included here — those are
//          the default GET's job.
//   POST { setListingStatus: { listingId, action, reason? } }
//        — admin moderation of an already-approved listing. action is
//          one of:
//            'block'   approved -> blocked (reversible; e.g. a quality
//                      or policy concern worth pausing over)
//            'unblock' blocked  -> approved
//            'remove'  approved or blocked -> removed (a more final
//                      takedown, but still reversible if needed)
//            'restore' removed  -> approved
//          reason is optional free text, shown to the host by email and
//          saved so the admin panel can show why a listing is down.
//          Both 'blocked' and 'removed' are equally hidden from guests
//          (get-listings.js only shows status = 'approved') — this never
//          deletes the row, so existing orders/reviews on it are
//          untouched. The host is emailed either way, best-effort.
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
const { logAudit, adminContext, requestContext } = require('./_audit-log');
const { createPayoutRows, markPayoutSent, razorpayxReady, attemptPayout } = require('./_payouts');
const { disputesForAdmin, decideDispute, REASONS: DISPUTE_REASONS } = require('./_stay-disputes');
const { reviewIdDocument, idDocumentUrlForAdmin, ID_TYPES } = require('./_guest-id');
const { safeRefund } = require('./_refunds');
const { releaseDueDeposits } = require('./_deposits');
const { encryptField, isEncrypted, encryptionReady, readableForAdmin, keyOpens, maskAccount } = require('./_secure-fields');
const { getClientIp, countRecentAttempts } = require('./_rate-limit');
const { convertInrToForeignSubunit, ZERO_DECIMAL_CURRENCIES } = require('./_currency');
const { createToken, verifyToken, secretMatches } = require('./_approval-token');
const { REVIEW_POLICY, CONFLICT_CHECKS, REVIEW_WINDOW_DAYS, publicationState } = require('./_review-policy');
const { describeLadders, guestTier, hostTier, reviewScore, weakestFactor,
        REVIEW_FACTORS, GUEST_FACTORS, HOST_TIERS, GUEST_TIERS,
        bookingValueBand, QUALIFYING_BOOKING_MIN,
        propertyTier, propertyFlag, PROPERTY_TIERS, propertyCutoffs } = require('./_tiers');
const { tierHistoryFor, requestTierRecompute } = require('./_tier-history');
const { COMPLIANCE_CHECKS, enforceComplianceDeadlines, runComplianceScan } = require('./_compliance');
const { sanitizeBody } = require('./_plain-text');

const sql = neon(process.env.DATABASE_URL);
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
const BACKGROUND_IMAGES_KEY = 'homepage_background_images';

// Razorpay's SDK rejects with { statusCode, error: { code, description } }
// rather than an Error, so err.message is usually undefined — which is
// why a failed refund only ever reached the admin as a generic "could not
// resolve". This pulls out the reason Razorpay actually gave. Admin-only
// endpoint, so showing it is safe and is what makes a failure fixable.
function razorpayErrorMessage(err) {
  const d = err && err.error && (err.error.description || err.error.reason);
  if (d) return `Razorpay: ${d}`;
  if (err && err.message) return err.message;
  return 'Razorpay did not accept the refund.';
}
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

// Tells a host their listing's visibility changed — used by both
// block/remove and unblock/restore. Never thrown on failure: a host not
// getting the email shouldn't undo a moderation action that's already
// taken effect. Same "log loudly, fail quietly" pattern as every other
// Resend call in this codebase.
async function sendListingStatusEmail(listing, action, reason) {
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set — host will not be notified of listing status change.');
    return;
  }
  const copy = {
    block: {
      subject: `Your Aerva listing has been paused: ${listing.property_name}`,
      heading: 'Your listing has been paused',
      body: `Your listing <strong>${listing.property_name}</strong> has been temporarily taken off Aerva and is no longer visible to guests.`,
    },
    remove: {
      subject: `Your Aerva listing has been removed: ${listing.property_name}`,
      heading: 'Your listing has been removed',
      body: `Your listing <strong>${listing.property_name}</strong> has been removed from Aerva and is no longer visible to guests.`,
    },
    unblock: {
      subject: `Your Aerva listing is live again: ${listing.property_name}`,
      heading: 'Your listing is live again',
      body: `Good news — your listing <strong>${listing.property_name}</strong> is visible to guests on Aerva again.`,
    },
    restore: {
      subject: `Your Aerva listing is live again: ${listing.property_name}`,
      heading: 'Your listing is live again',
      body: `Good news — your listing <strong>${listing.property_name}</strong> has been restored and is visible to guests on Aerva again.`,
    },
  }[action];
  if (!copy) return;

  const reasonBlock = reason
    ? `<p style="background:#f4eadc; padding:14px 16px; margin-top:16px;"><strong>Note from Aerva:</strong> ${reason}</p>`
    : '';
  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">${copy.heading}</h2>
      <p>${copy.body}</p>
      ${reasonBlock}
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">Questions about this? Contact hello@aerva.in.</p>
    </div>
  `;
  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to: listing.host_email, subject: copy.subject, html })
  }).catch(err => {
    console.error('Resend request failed (listing status change):', err);
    return null;
  });
  if (!emailRes) return; // network/DNS-level failure — never let this bubble up and mask a successful status change
  if (!emailRes.ok) {
    let detail;
    try { detail = await emailRes.json(); } catch { detail = { message: emailRes.statusText }; }
    console.error('Resend send failed (listing status change):', emailRes.status, detail);
  }
}

// ======================================================================
// Identity documents: review, then erase
// ======================================================================
// Aadhaar: only the OUTCOME is kept. An admin sees the document once,
// while reviewing; approving or rejecting deletes the file from Blob
// storage and clears the link. What stays: the status, any rejection
// reason, and the audit log entry.
//
// PAN: the NUMBER is kept, encrypted (_secure-fields.js), because TDS
// under section 194-O needs it; the uploaded PAN card IMAGE is deleted on
// review exactly like an Aadhaar document.
//
// Returns true only when the file is really gone (or there was none). If
// Blob deletion fails the URL is kept, so purgeReviewedIdDocuments can try
// again later — clearing it would leave the file online with nothing
// pointing at it to delete it by.
async function deleteUploadedDocument(url) {
  if (!url) return { ok: true };
  try {
    const { del } = require('@vercel/blob');
    await del(url);
    return { ok: true };
  } catch (err) {
    console.error('Could not delete identity document from Blob (kept for retry):', err.message);
    return { ok: false, reason: String(err.message || 'Blob deletion failed').slice(0, 200) };
  }
}

async function eraseHostIdDocument(hostId, field) {
  const rows = await sql`SELECT aadhaar_document_url, pan_document_url FROM hosts WHERE id = ${hostId}`;
  const h = rows[0];
  if (!h) return { erased: false, reason: 'Host not found' };
  if (field === 'aadhaar') {
    const d = await deleteUploadedDocument(h.aadhaar_document_url);
    if (d.ok) await sql`UPDATE hosts SET aadhaar_document_url = NULL WHERE id = ${hostId}`;
    return { erased: d.ok, reason: d.reason };
  }
  if (field === 'pan') {
    // The card image goes; the (encrypted) number stays for TDS.
    const d = await deleteUploadedDocument(h.pan_document_url);
    if (d.ok) await sql`UPDATE hosts SET pan_document_url = NULL WHERE id = ${hostId}`;
    return { erased: d.ok, reason: d.reason };
  }
  return { erased: true };
}

module.exports = async (req, res) => {
  // Typed text can never become markup — see _plain-text.js.
  sanitizeBody(req);

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
      // Rate limited like guest login. Without it, this form — the one
      // that opens the whole admin tool — could be guessed at without
      // limit. Checked before bcrypt, so a flood costs nothing to refuse.
      const clientIp = getClientIp(req);
      const failedForEmail = await countRecentAttempts(sql, {
        action: 'admin_login', windowMinutes: 15, byActor: cleanEmail, onlyFailures: true
      });
      const attemptsFromIp = await countRecentAttempts(sql, {
        action: 'admin_login', windowMinutes: 15, byIp: clientIp, onlyFailures: false
      });
      if (failedForEmail >= 5 || attemptsFromIp >= 20) {
        await logAudit(sql, {
          action: 'admin_login_blocked', success: false, actorType: 'admin', actorIdentifier: cleanEmail, ...requestContext(req),
          metadata: { reason: failedForEmail >= 5 ? 'too_many_failures' : 'ip_rate_limited', ip: clientIp }
        });
        return res.status(429).json({ error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' });
      }

      const rows = await sql`SELECT id, email, password_hash, name FROM admins WHERE email = ${cleanEmail}`;
      const admin = rows[0];
      // Same timing-safe pattern as guest-auth.js: always run bcrypt.compare,
      // even against a dummy hash for a non-existent account, so a wrong
      // email can't be distinguished from a wrong password by response time.
      const DUMMY_HASH = '$2a$12$CwTycUXWue0Thq9StjUM0uJ8yqxbwmkQ.6qhg0OSyMH0RfaOOKKae';
      const passwordMatches = await bcrypt.compare(password, admin && admin.password_hash ? admin.password_hash : DUMMY_HASH);
      if (!admin || !passwordMatches) {
        await logAudit(sql, {
          action: 'admin_login', success: false, actorType: 'admin', actorIdentifier: cleanEmail, ...requestContext(req),
          metadata: { reason: !admin ? 'no_such_account' : 'wrong_password', ip: clientIp }
        });
        return res.status(401).json({ error: 'Incorrect email or password.' });
      }
      const sessionToken = createToken(admin.id, 'admin-session', ADMIN_SESSION_LIFETIME_MS);
      await logAudit(sql, {
        action: 'admin_login', success: true, actorType: 'admin', actorIdentifier: cleanEmail, ...requestContext(req),
        targetType: 'admin', targetId: admin.id, metadata: { ip: clientIp }
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
    if (!secretMatches(adminSecretHeader, process.env.ADMIN_SECRET)) {
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
        action: 'admin_account_created', success: true, actorType: 'admin', actorIdentifier: cleanEmail, ...requestContext(req),
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
      // Each request is logged (whether or not the account exists) so it
      // can be rate limited; otherwise this sends Aerva-branded email to
      // any admin address as often as a script likes. Over the limit it
      // still answers the same generic success, so it reveals nothing.
      const clientIp = getClientIp(req);
      const recentFromIp = await countRecentAttempts(sql, {
        action: 'admin_password_reset_attempt', windowMinutes: 60, byIp: clientIp, onlyFailures: false
      });
      await logAudit(sql, {
        action: 'admin_password_reset_attempt', success: true, actorType: 'admin', actorIdentifier: cleanEmail, ...requestContext(req),
        metadata: { ip: clientIp }
      });
      if (recentFromIp >= 5) return res.status(200).json({ success: true });

      const rows = await sql`SELECT id, email FROM admins WHERE email = ${cleanEmail}`;
      const admin = rows[0];
      if (admin) {
        const resetTok = createToken(admin.id, 'admin-password-reset', ADMIN_RESET_LINK_LIFETIME_MS);
        await sendAdminPasswordResetEmail(admin, resetTok);
        await logAudit(sql, {
          action: 'admin_password_reset_requested', success: true, actorType: 'admin', actorIdentifier: cleanEmail, ...requestContext(req),
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
        action: 'admin_password_reset_completed', success: true, actorType: 'admin', actorIdentifier: admin.email, ...requestContext(req),
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
  const hasValidSecret = secretMatches(adminSecret, process.env.ADMIN_SECRET);
  if (!hasValidSession && !hasValidSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Named on every admin action below: the signed-in admin's email and id,
  // plus the IP and device the request came from (see _audit-log.js).
  const ADMIN_AUDIT = await adminContext(sql, req, sessionPayload, hasValidSecret);
  const ADMIN_ACTOR = ADMIN_AUDIT.actorIdentifier;

  // ---- Stay disputes (guest reported a problem during the stay) ----
  // GET ?stayDisputes=1[&status=all] · POST { decideStayDispute: { disputeId, refund, note } }
  // The host's account is given more weight: refund only when the guest's
  // evidence stands and the host cannot justify (_stay-disputes.js).
  if (req.method === 'GET' && req.query.stayDisputes === '1') {
    const rows = await disputesForAdmin(sql, { status: req.query.status === 'all' ? 'all' : 'open' });
    return res.status(200).json({ reasons: DISPUTE_REASONS, disputes: rows });
  }
  if (req.method === 'POST' && req.body && req.body.decideStayDispute) {
    try {
      const b = req.body.decideStayDispute;
      const out = await decideDispute(sql, razorpay, { disputeId: Number(b.disputeId) || 0, refund: b.refund === true, note: String(b.note || ''), adminLabel: ADMIN_ACTOR });
      return res.status(200).json({ success: true, ...out });
    } catch (err) {
      if (!err.isUserFacing) console.error('decideStayDispute failed:', err);
      return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not decide this dispute.' });
    }
  }

  // ---- Guest ID proofs waiting for review ----
  // GET ?guestIds=1 · POST { reviewGuestId: { guestId, approve, reason } }
  // The document address is decrypted for the admin only, here.
  if (req.method === 'GET' && req.query.guestIds === '1') {
    let rows = [];
    try {
      rows = await sql`SELECT id, name, email, phone, id_document_url, id_document_type, id_status, id_uploaded_at FROM guests
                       WHERE id_status = 'uploaded' AND deleted_at IS NULL ORDER BY id_uploaded_at LIMIT 100`;
    } catch (err) { /* before migration_trust_rules.sql */ }
    return res.status(200).json({ types: ID_TYPES, ids: rows.map(r => ({ guestId: r.id, name: r.name, email: r.email, phone: r.phone,
      type: r.id_document_type, uploadedAt: r.id_uploaded_at, url: idDocumentUrlForAdmin(r.id_document_url) })) });
  }
  if (req.method === 'POST' && req.body && req.body.reviewGuestId) {
    try {
      const b = req.body.reviewGuestId;
      const out = await reviewIdDocument(sql, { guestId: Number(b.guestId) || 0, approve: b.approve === true, reason: String(b.reason || ''), adminLabel: ADMIN_ACTOR });
      await logAudit(sql, { action: b.approve === true ? 'guest_id_verified' : 'guest_id_rejected', success: true, actorType: 'admin', ...ADMIN_AUDIT,
        targetType: 'guest', targetId: Number(b.guestId) || null, metadata: { reason: b.reason || null } });
      return res.status(200).json({ success: true, ...out });
    } catch (err) {
      return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not save this review.' });
    }
  }

  // ---- Audit history (admin only) ----
  // GET ?auditLog=1 [&who=admin|host|guest|cohost|system] [&q=text]
  //     [&from=YYYY-MM-DD] [&to=YYYY-MM-DD] [&before=<id>]
  // Newest first, 100 at a time; pass the last id as `before` for the
  // next page. Read-only: nothing here can change or delete an entry, and
  // no endpoint anywhere deletes audit rows (DPDP Rules: keep processing
  // logs at least one year — Aerva keeps them indefinitely).
  if (req.method === 'GET' && req.query.auditLog === '1') {
    // ?source=admin — the dedicated, append-only admin_audit_log, with the
    // admin's id, IP and device (see migration_admin_audit_log.sql).
    if (req.query.source === 'admin') {
      try {
        const q = typeof req.query.q === 'string' && req.query.q.trim() ? '%' + req.query.q.trim().slice(0, 80).replace(/[%_\\]/g, m => '\\' + m) + '%' : null;
        const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
        const from = day(req.query.from);
        const to = day(req.query.to);
        const before = Number(req.query.before) > 0 ? Number(req.query.before) : null;
        const rows = await sql`
          SELECT id, at, admin_id, admin_email, action, success, target_type, target_id, details, ip, user_agent
          FROM admin_audit_log
          WHERE (${q}::text IS NULL OR action ILIKE ${q} OR admin_email ILIKE ${q} OR ip ILIKE ${q} OR details::text ILIKE ${q})
            AND (${from}::date IS NULL OR at >= ${from}::date)
            AND (${to}::date IS NULL OR at < (${to}::date + 1))
            AND (${before}::bigint IS NULL OR id < ${before})
          ORDER BY id DESC
          LIMIT 101
        `;
        return res.status(200).json({
          entries: rows.slice(0, 100).map(r => ({
            id: Number(r.id), at: r.at, action: r.action, success: r.success !== false,
            who: 'admin', by: r.admin_email || (r.admin_id ? `admin #${r.admin_id}` : null),
            target: r.target_type ? `${r.target_type}${r.target_id != null ? ' #' + r.target_id : ''}` : null,
            details: r.details || null, ip: r.ip || null, device: r.user_agent || null
          })),
          hasMore: rows.length > 100
        });
      } catch (err) {
        console.error('admin audit view failed:', err);
        return res.status(500).json({ error: 'Could not load admin actions. Has migration_admin_audit_log.sql been run?' });
      }
    }
    try {
      const WHO = ['admin', 'host', 'guest', 'cohost', 'system'];
      const who = WHO.includes(req.query.who) ? req.query.who : null;
      const q = typeof req.query.q === 'string' && req.query.q.trim() ? '%' + req.query.q.trim().slice(0, 80).replace(/[%_\\]/g, m => '\\' + m) + '%' : null;
      const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
      const from = day(req.query.from);
      const to = day(req.query.to);
      const before = Number(req.query.before) > 0 ? Number(req.query.before) : null;
      const rows = await sql`
        SELECT id, created_at, action, success, actor_type, actor_identifier, target_type, target_id, metadata
        FROM audit_log
        WHERE (${who}::text IS NULL OR actor_type = ${who})
          AND (${q}::text IS NULL OR action ILIKE ${q} OR actor_identifier ILIKE ${q} OR target_type ILIKE ${q} OR metadata::text ILIKE ${q})
          AND (${from}::date IS NULL OR created_at >= ${from}::date)
          AND (${to}::date IS NULL OR created_at < (${to}::date + 1))
          AND (${before}::int IS NULL OR id < ${before})
        ORDER BY id DESC
        LIMIT 101
      `;
      return res.status(200).json({
        entries: rows.slice(0, 100).map(r => ({
          id: r.id, at: r.created_at, action: r.action, success: r.success !== false,
          who: r.actor_type || 'system', by: r.actor_identifier || null,
          target: r.target_type ? `${r.target_type}${r.target_id != null ? ' #' + r.target_id : ''}` : null,
          details: r.metadata || null
        })),
        hasMore: rows.length > 100
      });
    } catch (err) {
      console.error('auditLog view failed:', err);
      return res.status(500).json({ error: 'Could not load the audit history right now.' });
    }
  }

  // ---- Review policy + conflicts (admin only) ----
  // GET ?reviewPolicy=1 — the written policy plus the conflict queue.
  // Admin-only by construction: it sits below the auth gate above, and
  // nothing in it is ever served to a guest or host.
  if (req.method === 'GET' && req.query.reviewPolicy === '1') {
    try {
      // Reviews an admin should read, newest first. Deliberately a small
      // set of pointed queries rather than one clever join — each maps to
      // a named check in CONFLICT_CHECKS so the UI can explain WHY a row
      // is here, which a generic "suspicious" list never can.
      const mutualLow = await sql`
        SELECT lr.id AS listing_review_id, gr.id AS guest_review_id, lr.order_id,
               lr.comment AS guest_comment, gr.comment AS host_comment, lr.created_at
        FROM listing_reviews lr
        JOIN guest_reviews gr ON gr.order_id = lr.order_id
        WHERE lr.admin_reverted_at IS NULL AND gr.admin_reverted_at IS NULL
          AND (lr.hygiene + lr.communication + lr.services + lr.value_rating + lr.location) / 5 < 3
          AND gr.rating < 3
        ORDER BY lr.created_at DESC LIMIT 50
      `;
      const reported = await sql`
        SELECT id, order_id, comment, reported_at, reported_reason, 'listing_review' AS kind
        FROM listing_reviews WHERE reported_at IS NOT NULL AND admin_reverted_at IS NULL
        UNION ALL
        SELECT id, order_id, comment, reported_at, reported_reason, 'guest_review' AS kind
        FROM guest_reviews WHERE reported_at IS NOT NULL AND admin_reverted_at IS NULL
        ORDER BY reported_at DESC LIMIT 50
      `;
      // A single review far below the listing's own history — the classic
      // grudge shape. Needs at least 3 prior reviews to mean anything.
      const outliers = await sql`
        SELECT lr.id, lr.order_id, lr.listing_id, lr.comment, lr.created_at,
               (lr.hygiene + lr.communication + lr.services + lr.value_rating + lr.location) / 5 AS this_score,
               agg.avg_score, agg.n
        FROM listing_reviews lr
        JOIN (
          SELECT listing_id, AVG((hygiene + communication + services + value_rating + location) / 5) AS avg_score, COUNT(*) AS n
          FROM listing_reviews WHERE admin_reverted_at IS NULL GROUP BY listing_id
        ) agg ON agg.listing_id = lr.listing_id
        WHERE lr.admin_reverted_at IS NULL AND agg.n >= 3
          AND (lr.hygiene + lr.communication + lr.services + lr.value_rating + lr.location) / 5 < agg.avg_score - 1.5
        ORDER BY lr.created_at DESC LIMIT 50
      `;
      const heldCount = await sql`
        SELECT
          (SELECT COUNT(*) FROM listing_reviews WHERE published_at IS NULL AND admin_reverted_at IS NULL) AS listing_held,
          (SELECT COUNT(*) FROM guest_reviews   WHERE published_at IS NULL AND admin_reverted_at IS NULL) AS guest_held
      `;
      return res.status(200).json({
        policy: REVIEW_POLICY,
        ladders: describeLadders(),
        windowDays: REVIEW_WINDOW_DAYS,
        checks: CONFLICT_CHECKS,
        conflicts: { mutualLow, reported, outliers },
        held: heldCount[0] || { listing_held: 0, guest_held: 0 }
      });
    } catch (err) {
      console.error('reviewPolicy error:', err);
      return res.status(500).json({ error: 'Could not load the review policy right now.' });
    }
  }

  // ---- Listing location suggestions (admin only) ----
  // GET ?listingCities=1 — distinct cities and areas across approved
  // listings, each with a count.
  //
  // Deliberately NOT a geocoder lookup. Suggesting places from Google
  // would offer cities Aerva has no property in, so an admin could type a
  // perfectly valid suggestion and get zero results. Sourcing from the
  // listings themselves means every suggestion is guaranteed to match
  // something, and the counts tell you how much before you click.
  if (req.method === 'GET' && req.query.listingCities === '1') {
    try {
      const rows = await sql`
        SELECT city AS name, 'city' AS kind, COUNT(*) AS n
        FROM listings
        WHERE status = 'approved' AND city IS NOT NULL AND btrim(city) <> ''
        GROUP BY city
        UNION ALL
        SELECT area AS name, 'area' AS kind, COUNT(*) AS n
        FROM listings
        WHERE status = 'approved' AND area IS NOT NULL AND btrim(area) <> ''
        GROUP BY area
        ORDER BY n DESC, name ASC
        LIMIT 200
      `;
      // Deduplicated because a place is often recorded as both — Bandra is
      // an area of Mumbai on one listing and the city on another. The
      // higher count wins, since that is the more common usage.
      const seen = {};
      rows.forEach(r => {
        const key = String(r.name).trim().toLowerCase();
        const n = Number(r.n) || 0;
        if (!seen[key] || n > seen[key].count) seen[key] = { name: String(r.name).trim(), kind: r.kind, count: n };
      });
      const places = Object.values(seen).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      return res.status(200).json({ places });
    } catch (err) {
      console.error('listingCities error:', err);
      return res.status(500).json({ error: 'Could not load locations.' });
    }
  }

  // ---- Property lookup (admin only) ----
  // GET ?propertyLookup=<query> — find a listing by name, city or id, and
  // return its live numbers plus the history of when it reached each rung.
  //
  // Exists because typing scores by hand does not scale: with a thousand
  // listings an admin needs to pull up ONE and see what it actually holds,
  // not approximate it.
  if (req.method === 'GET' && req.query.propertyLookup !== undefined) {
    try {
      const q = String(req.query.propertyLookup || '').trim();
      if (q.length < 2) return res.status(400).json({ error: 'Type at least two characters.' });
      const asId = /^[0-9]+$/.test(q) ? Number(q) : -1;
      const like = '%' + q.toLowerCase() + '%';

      const rows = await sql`
        SELECT l.id, l.property_name, l.city, l.area, l.property_type, l.nightly_rate,
               COUNT(r.id)        AS reviews,
               AVG(r.hygiene)       AS hygiene,
               AVG(r.communication) AS communication,
               AVG(r.services)      AS services,
               AVG(r.value_rating)  AS value,
               AVG(r.location)      AS location
        FROM listings l
        LEFT JOIN listing_reviews r
          ON r.listing_id = l.id AND r.published_at IS NOT NULL AND r.admin_reverted_at IS NULL
          AND r.hygiene IS NOT NULL -- stay reviews only, same as the sweep
        WHERE l.status = 'approved'
          AND (l.id = ${asId} OR lower(l.property_name) LIKE ${like} OR lower(COALESCE(l.city,'')) LIKE ${like})
        GROUP BY l.id
        ORDER BY COUNT(r.id) DESC, l.property_name ASC
        LIMIT 25
      `;

      const minPool = Math.min(...PROPERTY_TIERS.map(x => x.minReviews));
      let cutoffs = {};
      try {
        const pool = await sql`
          SELECT AVG(hygiene) AS hygiene, AVG(communication) AS communication,
                 AVG(services) AS services, AVG(value_rating) AS value, AVG(location) AS location
          FROM listing_reviews r
          JOIN listings l ON l.id = r.listing_id AND l.status = 'approved'
          WHERE r.published_at IS NOT NULL AND r.admin_reverted_at IS NULL
            AND r.hygiene IS NOT NULL -- stay reviews only, same as the sweep
          GROUP BY r.listing_id HAVING COUNT(*) >= ${minPool}
        `;
        cutoffs = propertyCutoffs(pool.map(r => reviewScore({
          hygiene: Number(r.hygiene), communication: Number(r.communication),
          services: Number(r.services), value: Number(r.value), location: Number(r.location)
        }, REVIEW_FACTORS)));
      } catch (err) { console.error('lookup cutoffs failed:', err); }

      const results = rows.map(r => {
        const n = Number(r.reviews) || 0;
        const factors = n > 0 ? {
          hygiene: Number(r.hygiene), communication: Number(r.communication),
          services: Number(r.services), value: Number(r.value), location: Number(r.location)
        } : null;
        const t = factors ? propertyTier({ reviewCount: n, factors }, cutoffs) : null;
        const f = factors ? propertyFlag({ reviewCount: n, factors }) : null;
        return {
          id: r.id, name: r.property_name, city: r.city, area: r.area,
          propertyType: r.property_type, nightlyRate: Number(r.nightly_rate) || 0,
          reviewCount: n,
          factors: factors || { hygiene: 0, communication: 0, services: 0, value: 0, location: 0 },
          score: factors ? Number(reviewScore(factors, REVIEW_FACTORS).toFixed(3)) : null,
          tier: t ? { key: t.key, label: t.label } : null,
          flag: f ? { key: f.key, label: f.label } : null
        };
      });
      return res.status(200).json({ results, cutoffs });
    } catch (err) {
      console.error('propertyLookup error:', err);
      return res.status(500).json({ error: 'Could not search listings right now.' });
    }
  }

  // ---- Recorded standing history (admin only) ----
  // GET ?tierHistory=<id>&subject=listing|host|guest
  //
  // Reads the LOGGED history written by the daily sweep, not a replay.
  // The earlier version replayed old scores against today's cutoffs,
  // which answered a subtly different question: the bands are relative,
  // so "score 4.93" only means something alongside the bar that applied
  // that day. Each logged row carries its own cutoff snapshot, so a row
  // from last March can still be read correctly.
  if (req.method === 'GET' && req.query.tierHistory !== undefined) {
    try {
      const subjectId = Number(req.query.tierHistory);
      const subject = ['listing', 'host', 'guest'].includes(req.query.subject) ? req.query.subject : 'listing';
      if (!subjectId) return res.status(400).json({ error: 'Which subject?' });

      const rows = await tierHistoryFor(sql, subject, subjectId, 100);
      const current = await sql`
        SELECT tier_key, score, review_count, metric, updated_at
        FROM tier_current WHERE subject_type = ${subject} AND subject_id = ${subjectId}
      `;
      return res.status(200).json({
        subject, subjectId,
        current: current[0] || null,
        history: rows,
        note: rows.length ? null
          : 'No recorded changes yet. History is written by the daily sweep (/api/get-listings?reviewSweep=1); nothing is backfilled for the period before it first ran.'
      });
    } catch (err) {
      console.error('tierHistory error:', err);
      return res.status(500).json({ error: 'Could not load that history.' });
    }
  }

  // ---- Tier simulator (admin only) ----
  // POST { simulateTier: { kind: 'guest'|'host', ...inputs } }
  //
  // Runs the REAL ladder from _tiers.js on hypothetical numbers. That is
  // the entire point: a simulator that reimplements the maths would agree
  // with itself and disagree with production, which is worse than having
  // no simulator at all. Any retune of a threshold changes this answer on
  // the next deploy with no edit here.
  //
  // Returns the verdict AND why, gate by gate, so an admin can see which
  // requirement failed rather than just that one did.
  if (req.method === 'POST' && req.body && req.body.simulateTier) {
    try {
      const inp = req.body.simulateTier || {};
      const kind = ['host', 'property'].includes(inp.kind) ? inp.kind : 'guest';
      const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

      if (kind === 'property') {
        const factors = {
          hygiene: num(inp.hygiene), communication: num(inp.communication),
          services: num(inp.services), value: num(inp.value), location: num(inp.location)
        };
        const reviewCount = num(inp.reviewCount);
        const stats = { reviewCount, factors };
        // Property bands are RELATIVE, so a simulation needs a field to
        // rank against. The live cutoffs are used by default, so the
        // simulator answers the question an admin is actually asking:
        // would this listing be badged today, against today's platform.
        const minPool = Math.min(...PROPERTY_TIERS.map(x => x.minReviews));
        let cutoffs = {};
        try {
          const pool = await sql`
            SELECT AVG(hygiene) AS hygiene, AVG(communication) AS communication,
                   AVG(services) AS services, AVG(value_rating) AS value,
                   AVG(location) AS location
            FROM listing_reviews r
            JOIN listings l ON l.id = r.listing_id AND l.status = 'approved'
            WHERE r.published_at IS NOT NULL AND r.admin_reverted_at IS NULL
              AND r.hygiene IS NOT NULL -- stay reviews only, same as the sweep
            GROUP BY r.listing_id
            HAVING COUNT(*) >= ${minPool}
          `;
          cutoffs = propertyCutoffs(pool.map(r => reviewScore({
            hygiene: Number(r.hygiene), communication: Number(r.communication),
            services: Number(r.services), value: Number(r.value), location: Number(r.location)
          }, REVIEW_FACTORS)));
        } catch (err) { console.error('simulator cutoffs failed:', err); }

        const t = propertyTier(stats, cutoffs), f = propertyFlag(stats);
        const score = reviewScore(factors, REVIEW_FACTORS);
        const haveCutoffs = Object.keys(cutoffs).length > 0;
        const trace = PROPERTY_TIERS.map(tt => {
          const fails = [];
          if (reviewCount < tt.minReviews) fails.push(`fewer than ${tt.minReviews} reviews`);
          if (score < tt.minScore) fails.push(`score ${score.toFixed(3)} below floor ${tt.minScore}`);
          if (!haveCutoffs) fails.push('too few reviewed listings on the platform to rank against');
          else if (score < cutoffs[tt.key]) fails.push(`score ${score.toFixed(3)} below the top ${tt.topPercent}% cutoff of ${Number(cutoffs[tt.key]).toFixed(3)}`);
          return { label: tt.label, pass: fails.length === 0, blockedBy: fails };
        });
        return res.status(200).json({
          kind, score: Number(score.toFixed(3)),
          tier: t ? { key: t.key, label: t.label } : null,
          flag: f ? { key: f.key, label: f.label } : null,
          cutoffs, publicBadge: !!t, trace
        });
      }

      if (kind === 'host') {
        const factors = {
          hygiene: num(inp.hygiene), communication: num(inp.communication),
          services: num(inp.services), value: num(inp.value), location: num(inp.location)
        };
        const hasFactors = REVIEW_FACTORS.some(f => num(factors[f.key]) > 0);
        const reviewCount = num(inp.reviewCount);
        const totalPayout = num(inp.totalPayout);
        const tier = hostTier({ totalPayout, reviewCount, factors: hasFactors ? factors : undefined });
        const score = hasFactors ? reviewScore(factors, REVIEW_FACTORS) : 0;

        // Walk every rung and record which gate stopped them. Reported
        // highest-first, so the first 'pass' is the answer.
        const trace = HOST_TIERS.map(t => {
          const fails = [];
          if (totalPayout < t.minPayout) fails.push(`payout below ${t.minPayout}`);
          if (reviewCount < t.minReviews) fails.push(`fewer than ${t.minReviews} reviews`);
          if (hasFactors && reviewCount > 0) {
            if (score < t.minScore) fails.push(`score ${score.toFixed(3)} below ${t.minScore}`);
            const weak = t.minFactor ? weakestFactor(factors, t.minFactor, REVIEW_FACTORS) : null;
            if (weak) fails.push(`${weak.label.toLowerCase()} ${weak.value.toFixed(2)} below floor ${t.minFactor}`);
          }
          return { label: t.label, pass: fails.length === 0, blockedBy: fails };
        });
        return res.status(200).json({
          kind, score: Number(score.toFixed(3)),
          tier: tier ? { key: tier.key, label: tier.label, icon: tier.icon } : null,
          publicBadge: !!(tier && ['elite', 'golden_elite', 'aerva_elite'].includes(tier.key)),
          trace
        });
      }

      const factors = {
        cleanliness: num(inp.cleanliness), communication: num(inp.communication),
        respectful: num(inp.respectful), rules: num(inp.rules)
      };
      const hasFactors = GUEST_FACTORS.some(f => num(factors[f.key]) > 0);
      const reviewCount = num(inp.reviewCount);
      const bookingCount = num(inp.bookingCount);
      const qualifyingBookings = inp.qualifyingBookings !== undefined ? num(inp.qualifyingBookings) : bookingCount;
      const totalSpend = num(inp.totalSpend);
      const stats = { totalSpend, bookingCount, qualifyingBookings, reviewCount,
                      factors: hasFactors ? factors : undefined };
      const tier = guestTier(stats);
      const score = hasFactors ? reviewScore(factors, GUEST_FACTORS) : 0;
      const avgValue = bookingCount > 0 ? totalSpend / bookingCount : 0;
      const band = bookingValueBand(avgValue);

      const trace = GUEST_TIERS.map(t => {
        const fails = [];
        if (totalSpend < t.minSpend) fails.push(`spend below ${t.minSpend}`);
        const needBookings = reviewCount > 0
          ? t.minBookings
          : (t.unreviewedBookings === null ? Infinity : t.unreviewedBookings);
        if (qualifyingBookings < needBookings) {
          fails.push(needBookings === Infinity
            ? 'unreachable without at least one rated review'
            : `fewer than ${needBookings} qualifying bookings${reviewCount > 0 ? '' : ' (unreviewed bar)'}`);
        }
        if (reviewCount < t.minRatedReviews) fails.push(`fewer than ${t.minRatedReviews} rated reviews`);
        if (t.minAvgValue && bookingCount > 0 && avgValue < t.minAvgValue) {
          fails.push(`average booking ${Math.round(avgValue)} below ${t.minAvgValue}`);
        }
        if (hasFactors && reviewCount > 0 && score < t.minScore) {
          fails.push(`score ${score.toFixed(3)} below ${t.minScore}`);
        }
        return { label: t.label, pass: fails.length === 0, blockedBy: fails };
      });
      return res.status(200).json({
        kind, score: Number(score.toFixed(3)),
        avgBooking: Math.round(avgValue),
        band: { label: band.label, multiplier: band.multiplier },
        qualifyingMin: QUALIFYING_BOOKING_MIN,
        tier: tier ? { key: tier.key, label: tier.label } : null,
        trace
      });
    } catch (err) {
      console.error('simulateTier error:', err);
      return res.status(500).json({ error: 'Could not run that simulation.' });
    }
  }

  // ---- Admin reverts a review ----
  // POST { revertReview: { kind: 'listing'|'guest', id, reason } }
  // Withdraws it from display AND from every tier calculation. The row is
  // kept, not deleted: a dispute can be re-examined, and deleting would
  // erase the evidence the decision rested on.
  if (req.method === 'POST' && req.body && req.body.revertReview) {
    try {
      const { kind, id, reason } = req.body.revertReview;
      const reviewId = Number(id);
      const why = typeof reason === 'string' ? reason.trim() : '';
      if (!reviewId || (kind !== 'listing' && kind !== 'guest')) {
        return res.status(400).json({ error: 'Which review, and of which kind?' });
      }
      // A reason is required. An unexplained revert is indistinguishable
      // from a mistake when someone reads the audit log a year later.
      if (why.length < 10) return res.status(400).json({ error: 'Please record why this review is being reverted.' });

      const adminId = hasValidSession ? sessionPayload.listingId : null;
      const rows = kind === 'listing'
        ? await sql`
            UPDATE listing_reviews
            SET admin_reverted_at = now(), admin_reverted_by = ${adminId}, admin_revert_reason = ${why}
            WHERE id = ${reviewId} AND admin_reverted_at IS NULL
            RETURNING id, order_id, host_id, listing_id`
        : await sql`
            UPDATE guest_reviews
            SET admin_reverted_at = now(), admin_reverted_by = ${adminId}, admin_revert_reason = ${why}
            WHERE id = ${reviewId} AND admin_reverted_at IS NULL
            RETURNING id, order_id, guest_id`;
      if (!rows.length) return res.status(404).json({ error: 'Review not found, or already reverted.' });

      await logAudit(sql, {
        action: 'review_reverted', success: true, actorType: 'admin', ...ADMIN_AUDIT,
        targetType: kind === 'listing' ? 'listing_review' : 'guest_review', targetId: reviewId,
        metadata: { orderId: rows[0].order_id, reason: why }
      });

      // Badges normally move only on a quarterly review day. A revert is
      // the exception: queue the affected subjects so the next daily sweep
      // (02:00 UTC) re-runs the last review without this review — within
      // 48 hours, and in practice within 24. A property review affects
      // the listing's rank AND its host; a guest review affects the guest.
      const r0 = rows[0];
      const queued = await requestTierRecompute(sql, kind === 'listing'
        ? [{ type: 'listing', id: r0.listing_id, reason: `revert:listing_review:${reviewId}` },
           { type: 'host', id: r0.host_id, reason: `revert:listing_review:${reviewId}` }]
        : [{ type: 'guest', id: r0.guest_id, reason: `revert:guest_review:${reviewId}` }]);
      return res.status(200).json({
        success: true,
        badgeUpdate: queued
          ? 'Review withdrawn now. Affected badges update within 48 hours.'
          : 'Review withdrawn now, but the badge update could not be scheduled. Badges will correct at the next quarterly review.'
      });
    } catch (err) {
      console.error('revertReview error:', err);
      return res.status(500).json({ error: 'Could not revert that review right now.' });
    }
  }

  if (req.method === 'POST') {
    // ---- Compliance requirements: a general mechanism for "every
    // listing needs X, but some already-approved ones don't have it" —
    // not specific to any one field. Adding a future requirement means
    // registering a new key in _compliance.js (a message + a query for
    // which listings are missing it), not building a new one-off
    // feature each time.

    // ---- Admin-triggered: scan every listing for one requirement,
    // flagging whichever don't currently meet it. Safe to re-run — the
    // partial unique index on compliance_flags means a listing that's
    // already flagged and still unresolved doesn't get a second,
    // duplicate flag.
    if (req.body && req.body.runComplianceCheck) {
      try {
        const { key } = req.body.runComplianceCheck;
        if (!COMPLIANCE_CHECKS[key]) return res.status(400).json({ error: `Unknown compliance requirement: ${key}` });
        // Same scan the daily job runs — one implementation, so a manual
        // run and the automatic one can never behave differently.
        const r = await runComplianceScan(sql, key);
        await logAudit(sql, {
          action: 'compliance_check_run', success: true, actorType: 'admin', ...ADMIN_AUDIT,
          targetType: 'compliance', targetId: null,
          metadata: { key, affectedCount: r.affected, newlyFlagged: r.flagged, emailed: r.emailed }
        });
        return res.status(200).json({ success: true, affectedCount: r.affected, newlyFlagged: r.flagged, emailed: r.emailed });
      } catch (err) {
        console.error('get-pending-listings (runComplianceCheck) error:', err);
        return res.status(500).json({ error: 'Could not run this compliance check: ' + (err.message || 'unknown error') });
      }
    }

    // ---- Cron-callable (or admin-triggered): blocks every listing whose
    // deadline has passed without being resolved. Uses the SAME
    // x-admin-secret auth already checked above — a scheduled job sends
    // that header the same way a manual admin action would, no separate
    // secret mechanism needed.
    if (req.body && req.body.enforceCompliance === true) {
      try {
        // Shared with the daily job in get-listings.js — one implementation,
        // so a deadline is enforced identically however it is triggered.
        const r = await enforceComplianceDeadlines(sql, logAudit);
        return res.status(200).json({ success: true, checked: r.checked, blocked: r.blocked });
      } catch (err) {
        console.error('get-pending-listings (enforceCompliance) error:', err);
        return res.status(500).json({ error: 'Could not enforce compliance deadlines: ' + (err.message || 'unknown error') });
      }
    }

    // ---- Block / unblock / remove / restore an already-approved listing ----
    if (req.body && req.body.setListingStatus) {
      try {
        const { listingId, action, reason } = req.body.setListingStatus;
        const id = Number(listingId);
        const VALID_ACTIONS = { block: 'blocked', unblock: 'approved', remove: 'removed', restore: 'approved' };
        if (!id || !VALID_ACTIONS[action]) {
          return res.status(400).json({ error: 'Invalid listing or action.' });
        }
        const rows = await sql`SELECT id, property_name, host_email, status FROM listings WHERE id = ${id}`;
        const listing = rows[0];
        if (!listing) return res.status(404).json({ error: 'Listing not found.' });

        // Only sensible transitions — this is what stops, say, "unblock"
        // being called on a listing that was never blocked in the first
        // place, or a moderation action landing on a submission that's
        // still just pending review (that's approve-listing.js's job).
        const ALLOWED_FROM = {
          block: ['approved'],
          remove: ['approved', 'blocked'],
          unblock: ['blocked'],
          restore: ['removed'],
        };
        if (!ALLOWED_FROM[action].includes(listing.status)) {
          return res.status(400).json({ error: `Can't ${action} a listing that's currently "${listing.status}".` });
        }

        const newStatus = VALID_ACTIONS[action];
        const isTakedown = action === 'block' || action === 'remove';
        const safeReason = isTakedown && typeof reason === 'string' ? reason.trim().slice(0, 500) || null : null;

        await sql`
          UPDATE listings SET status = ${newStatus}, admin_status_reason = ${safeReason}
          WHERE id = ${id}
        `;

        await logAudit(sql, {
          action: 'listing_status_changed', success: true, actorType: 'admin', ...ADMIN_AUDIT,
          targetType: 'listing', targetId: id,
          metadata: { action, fromStatus: listing.status, toStatus: newStatus, reason: safeReason }
        });

        await sendListingStatusEmail(listing, action, safeReason);

        return res.status(200).json({ success: true, status: newStatus });
      } catch (err) {
        console.error('get-pending-listings (setListingStatus) error:', err);
        return res.status(500).json({ error: 'Could not update this listing right now.' });
      }
    }

    // ---- Auto-refund every held deposit past its 7-day release date ----
    // Admin-triggered rather than a blind cron job — this endpoint does
    // real money movement via Razorpay, so a human clicking "Process" in
    // admin.html is the safety check before it runs, at least until this
    // has been tested enough in production to trust running unattended.
    if (req.body && req.body.processDeposits) {
      // Same job the scheduler runs every 15 minutes (_deposits.js).
      try {
        const out = await releaseDueDeposits(sql, razorpay, { deadlineMs: 8000 });
        return res.status(200).json({ processed: out.processed, results: out.results });
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
      const { orderId, compensationAmount } = req.body.resolveDispute;
      let claimed = false;
      try {
        const rows = await sql`SELECT id, razorpay_payment_id, deposit_amount, deposit_status, charge_currency FROM orders WHERE id = ${orderId}`;
        const order = rows[0];
        if (!order) return res.status(404).json({ error: 'Order not found.' });
        if (order.deposit_status === 'resolving') {
          return res.status(409).json({ error: 'This dispute is already being resolved. Refresh the page.' });
        }
        if (order.deposit_status !== 'disputed') {
          return res.status(400).json({ error: 'This deposit is not currently disputed.' });
        }

        const compensation = Math.max(0, Math.min(Number(compensationAmount) || 0, Number(order.deposit_amount)));
        const guestRefundAmount = Number(order.deposit_amount) - compensation;

        if (guestRefundAmount > 0 && !order.razorpay_payment_id) {
          return res.status(400).json({ error: 'No Razorpay payment is recorded for this booking, so the guest\'s share cannot be refunded automatically.' });
        }

        // Worked out before claiming, so a missing rate never leaves the
        // dispute locked. Same currency-matching rule as processDeposits:
        // a refund goes back in whatever currency was actually charged.
        let refundSubunitAmount = null;
        if (guestRefundAmount > 0) {
          const currency = order.charge_currency || 'INR';
          if (currency === 'INR') {
            refundSubunitAmount = Math.round(guestRefundAmount * 100);
          } else {
            refundSubunitAmount = await convertInrToForeignSubunit(sql, guestRefundAmount, currency);
            if (!refundSubunitAmount) {
              return res.status(502).json({ error: `No cached rate available to refund this ${currency} deposit right now. Please try again shortly.` });
            }
          }
        }

        // Claim it before any money moves: a double click, or two admins
        // on the same dispute, would otherwise both pass the check above
        // and both refund the guest. Only the request that flips
        // disputed -> resolving carries on.
        const claim = await sql`
          UPDATE orders SET deposit_status = 'resolving'
          WHERE id = ${orderId} AND deposit_status = 'disputed'
          RETURNING id
        `;
        if (!claim.length) {
          return res.status(409).json({ error: 'This dispute is already being resolved. Refresh the page.' });
        }
        claimed = true;

        let refundId = null;
        if (refundSubunitAmount) {
          try {
            const refund = await safeRefund(sql, razorpay, { orderId, paymentId: order.razorpay_payment_id, amountSubunit: refundSubunitAmount, kind: 'deposit_dispute' });
            refundId = refund.id;
          } catch (refundErr) {
            // Nothing was refunded, so reopen the dispute for another try.
            console.error('get-pending-listings (resolveDispute) refund failed:', refundErr);
            await sql`UPDATE orders SET deposit_status = 'disputed' WHERE id = ${orderId} AND deposit_status = 'resolving'`;
            claimed = false;
            await logAudit(sql, {
              action: 'deposit_dispute_resolved', success: false, actorType: 'admin', ...ADMIN_AUDIT,
              targetType: 'order', targetId: orderId,
              metadata: { compensation, guestRefundAmount, reason: razorpayErrorMessage(refundErr) }
            });
            return res.status(502).json({ error: razorpayErrorMessage(refundErr) });
          }
        }

        try {
          await sql`
            UPDATE orders SET
              deposit_status = 'resolved', deposit_resolution_amount = ${compensation}, deposit_refund_id = ${refundId}
            WHERE id = ${orderId}
          `;
        } catch (saveErr) {
          // The refund has gone through. Leaving the order 'resolving'
          // means it can never be refunded a second time; it only needs
          // its record finished by hand.
          console.error(`resolveDispute: refund ${refundId} issued for order ${orderId} but saving failed:`, saveErr);
          return res.status(500).json({ error: `Refund ${refundId} was issued, but saving the result failed. The dispute is locked so it cannot be refunded twice; update order ${orderId} by hand.` });
        }

        await logAudit(sql, {
          action: 'deposit_dispute_resolved', success: true, actorType: 'admin', ...ADMIN_AUDIT,
          targetType: 'order', targetId: orderId,
          metadata: { compensation, guestRefundAmount, refundId }
        });
        return res.status(200).json({ success: true, compensation, guestRefundAmount });
      } catch (err) {
        console.error('get-pending-listings (resolveDispute) error:', err);
        // Only reached before any refund was attempted (refund and save
        // failures return above), so reopening is always safe here.
        if (claimed) {
          try { await sql`UPDATE orders SET deposit_status = 'disputed' WHERE id = ${orderId} AND deposit_status = 'resolving'`; } catch (_) {}
        }
        return res.status(500).json({ error: 'Could not resolve this dispute right now.' });
      }
    }

    // ---- Approve or reject a pending Aadhaar/bank submission ----
    // This is the actual human check that pending_review exists for —
    // an admin looking at the uploaded document (or the bank details)
    // and deciding whether it's genuine, rather than the old behavior
    // of trusting any upload automatically.
    // ---- Cancellation coupon owed by a host: recovered from a payout, or written off ----
    // POST { settleHostPenalty: { id, action: 'recovered' | 'written_off', note } }
    if (req.body && req.body.settleHostPenalty) {
      try {
        const { id, action, note } = req.body.settleHostPenalty;
        if (action !== 'recovered' && action !== 'written_off') return res.status(400).json({ error: 'Invalid action.' });
        const why = typeof note === 'string' ? note.trim().slice(0, 300) : '';
        if (action === 'written_off' && !why) return res.status(400).json({ error: 'Please give a reason for writing this off.' });
        const upd = await sql`
          UPDATE host_penalties SET status = ${action}, note = ${why || null}, settled_at = now(), settled_by = ${ADMIN_ACTOR}
          WHERE id = ${Number(id) || 0} AND status = 'owed' RETURNING id, host_id, amount
        `;
        if (!upd.length) return res.status(404).json({ error: 'That amount is not owed any more.' });
        await logAudit(sql, { action: action === 'recovered' ? 'host_penalty_recovered' : 'host_penalty_written_off', success: true, actorType: 'admin', ...ADMIN_AUDIT,
          targetType: 'host', targetId: upd[0].host_id, metadata: { penaltyId: upd[0].id, amount: Number(upd[0].amount), note: why || null } });
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error('settleHostPenalty failed:', err);
        return res.status(500).json({ error: 'Could not save that right now.' });
      }
    }

    // ---- Mark a payout as sent (sent by hand), and tell the host / co-host ----
    // POST { markPayoutPaid: { orderId, payee: 'host' | 'cohost', cohostGuestId?,
    //        reference, arrivingBy (YYYY-MM-DD), tds?, deductCoupons? } }
    // Finishes the booking's payout row (created automatically at 5 PM on
    // check-out day, or here if not yet): amounts come from the booking.
    // Co-host shares are paid in full. Refused if already sent, or being
    // sent by RazorpayX, or if deductions would take it below zero.
    if (req.body && req.body.markPayoutPaid) {
      try {
        const b = req.body.markPayoutPaid;
        const orderId = Number(b.orderId) || 0;
        const isCohost = b.payee === 'cohost';
        const reference = String(b.reference || '').trim().slice(0, 100);
        if (!reference) return res.status(400).json({ error: 'Enter the bank reference (UTR) for this payout.' });
        const arrivingBy = /^\d{4}-\d{2}-\d{2}$/.test(String(b.arrivingBy || '')) ? b.arrivingBy : null;
        const o = (await sql`SELECT id, status FROM orders WHERE id = ${orderId}`)[0];
        if (!o || o.status !== 'paid') return res.status(404).json({ error: 'That booking is not a paid booking.' });
        await createPayoutRows(sql, orderId);
        const payeeGuestId = isCohost ? (Number(b.cohostGuestId) || 0) : null;
        const row = (await sql`SELECT * FROM payouts WHERE order_id = ${orderId} AND payee_type = ${isCohost ? 'cohost' : 'host'} AND COALESCE(payee_guest_id, 0) = ${payeeGuestId || 0}`)[0];
        if (!row) return res.status(404).json({ error: isCohost ? 'That co-host has no share in this booking.' : 'No payout found for this booking.' });
        if (row.status === 'sent') return res.status(409).json({ error: 'This payout is already marked paid.' });
        if (row.status === 'processing') return res.status(409).json({ error: 'RazorpayX is sending this payout. Wait for it to finish.' });
        // With automatic payouts on, never pay by hand what the system pays:
        // use Retry. (Payouts created while they were off can still be
        // recorded here.)
        if (razorpayxReady() && row.auto_eligible) return res.status(409).json({ error: 'Automatic payouts are on. Use Retry instead of paying by hand.' });
        let tds = Number(row.tds), deductions = Number(row.deductions), ids = row.deducted_penalty_ids || [];
        if (!isCohost) {
          if (b.tds !== undefined && b.tds !== null && b.tds !== '') tds = Math.max(0, Math.round((Number(b.tds) || 0) * 100) / 100);
          if (!b.deductCoupons) { deductions = 0; ids = []; }
        }
        const net = Math.round((Number(row.gross) - Number(row.commission) - Number(row.cohost_shares) - deductions - tds) * 100) / 100;
        if (net < 0) return res.status(400).json({ error: `Deductions (₹${(deductions + tds).toLocaleString('en-IN')}) are more than this payout. Leave the coupon deduction for a larger payout.` });
        // If an admin typed the TDS, the rate shown is the one that amount represents.
        const tdsBase = Number(row.gross) - Number(row.cohost_shares);
        const tdsRate = tds === Number(row.tds) ? Number(row.tds_rate || 0) : (tdsBase > 0 ? Math.round(tds / tdsBase * 10000) / 100 : 0);
        await sql`UPDATE payouts SET tds = ${tds}, tds_rate = ${tdsRate}, deductions = ${deductions}, deducted_penalty_ids = ${ids}, net = ${net} WHERE id = ${row.id}`;
        const done = await markPayoutSent(sql, row.id, { reference, arrivingBy, by: ADMIN_ACTOR });
        if (!done) return res.status(409).json({ error: 'This payout could not be marked paid. Refresh and try again.' });
        await logAudit(sql, { action: 'payout_marked_paid', success: true, actorType: 'admin', ...ADMIN_AUDIT, targetType: 'order', targetId: orderId,
          metadata: { payoutId: row.id, payee: isCohost ? 'cohost' : 'host', payeeGuestId, net, tds, deductions, reference, emailed: done.emailed } });
        return res.status(200).json({ success: true, payoutId: row.id, net, emailed: done.emailed });
      } catch (err) {
        console.error('markPayoutPaid failed:', err);
        return res.status(500).json({ error: 'Could not record this payout right now.' });
      }
    }

    // ---- Retry a payout (failed at the bank, or left behind) ----
    // POST { retryPayout: { payoutId } } — the same safe attempt the
    // scheduler uses: RazorpayX is checked first, so nothing is paid twice.
    if (req.body && req.body.retryPayout) {
      try {
        const id = Number(req.body.retryPayout.payoutId) || 0;
        const row = (await sql`SELECT id, order_id, status FROM payouts WHERE id = ${id}`)[0];
        if (!row) return res.status(404).json({ error: 'Payout not found.' });
        if (!['failed', 'due'].includes(row.status)) return res.status(409).json({ error: row.status === 'sent' ? 'This payout has already been sent.' : 'This payout is being sent. Wait for it to finish.' });
        if (!razorpayxReady()) return res.status(400).json({ error: 'Automatic payouts are off (RazorpayX not set up).' });
        const result = await attemptPayout(sql, id, { by: ADMIN_ACTOR });
        await logAudit(sql, { action: 'payout_retried', success: result !== 'busy', actorType: 'admin', ...ADMIN_AUDIT, targetType: 'order', targetId: row.order_id, metadata: { payoutId: id, result } });
        return res.status(200).json({ success: true, result });
      } catch (err) {
        console.error('retryPayout failed:', err);
        return res.status(500).json({ error: 'Could not retry this payout right now.' });
      }
    }
    // ---- Retry a refund that failed ----
    // POST { retryRefund: { refundId } } — Razorpay is re-checked first
    // (_refunds.js), so a refund that did go through is never repeated.
    if (req.body && req.body.retryRefund) {
      try {
        const id = Number(req.body.retryRefund.refundId) || 0;
        const rf = (await sql`SELECT * FROM refunds WHERE id = ${id}`)[0];
        if (!rf) return res.status(404).json({ error: 'Refund not found.' });
        if (rf.status !== 'failed') return res.status(409).json({ error: rf.status === 'processed' ? 'This refund has already been processed.' : 'This refund is in progress.' });
        const r = await safeRefund(sql, razorpay, { orderId: rf.order_id, paymentId: rf.razorpay_payment_id, amountSubunit: rf.amount, kind: rf.kind });
        // A retried deposit refund also settles the deposit on the booking.
        if (rf.kind === 'deposit' && r.id) {
          await sql`UPDATE orders SET deposit_status = 'refunded', deposit_refund_id = ${r.id} WHERE id = ${rf.order_id} AND deposit_status IN ('held', 'refunding')`;
        }
        await logAudit(sql, { action: 'refund_retried', success: true, actorType: 'admin', ...ADMIN_AUDIT, targetType: 'order', targetId: rf.order_id, metadata: { refundId: id, kind: rf.kind, result: r.adopted ? 'adopted' : 'created' } });
        return res.status(200).json({ success: true, adopted: !!r.adopted, status: r.status });
      } catch (err) {
        console.error('retryRefund failed:', err);
        return res.status(err.isUserFacing ? err.status : 502).json({ error: err.isUserFacing ? err.message : 'Razorpay could not refund this right now.' });
      }
    }

    // ---- Approve or reject a co-host's payout details ----
    // POST { reviewCohostPayout: { guestId, approve, reason } }
    if (req.body && req.body.reviewCohostPayout) {
      try {
        const { guestId, approve, reason } = req.body.reviewCohostPayout;
        const gid = Number(guestId) || 0;
        const why = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
        if (!approve && !why) return res.status(400).json({ error: 'Please give a reason, so the co-host knows what to fix.' });
        const upd = await sql`
          UPDATE cohost_payout_profiles
          SET status = ${approve ? 'approved' : 'rejected'}, rejection_reason = ${approve ? null : why}, reviewed_at = now()
          WHERE guest_id = ${gid} AND status = 'pending_review'
          RETURNING guest_id
        `;
        if (!upd.length) return res.status(404).json({ error: 'Nothing is waiting for review for this co-host.' });
        await logAudit(sql, {
          action: approve ? 'cohost_payout_profile_approved' : 'cohost_payout_profile_rejected', success: true,
          actorType: 'admin', ...ADMIN_AUDIT, targetType: 'guest', targetId: gid, metadata: { reason: why || null }
        });
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error('reviewCohostPayout failed:', err);
        return res.status(500).json({ error: 'Could not save that review right now.' });
      }
    }

    // ---- Let a host upload a rejected Aadhaar / PAN again ----
    // POST { resetIdVerification: { hostId, field: 'aadhaar' | 'pan' } }
    // Only from 'rejected'. Clears the status back to not_submitted, deletes
    // any file still stored, and — for PAN — the rejected number, since it
    // was not a valid PAN for this host.
    if (req.body && req.body.resetIdVerification) {
      try {
        const { hostId, field } = req.body.resetIdVerification;
        const hid = Number(hostId) || 0;
        if (field !== 'aadhaar' && field !== 'pan') return res.status(400).json({ error: 'Invalid field.' });
        const rows = await sql`SELECT aadhaar_status, pan_status FROM hosts WHERE id = ${hid}`;
        if (!rows[0]) return res.status(404).json({ error: 'Host not found.' });
        if ((field === 'aadhaar' ? rows[0].aadhaar_status : rows[0].pan_status) !== 'rejected') {
          return res.status(400).json({ error: 'Only a rejected document can be reopened for upload.' });
        }
        const e = await eraseHostIdDocument(hid, field);
        if (!e.erased) return res.status(502).json({ error: `The old file could not be deleted yet (${e.reason || 'storage error'}). Nothing was changed — try again shortly.` });
        if (field === 'aadhaar') {
          await sql`UPDATE hosts SET aadhaar_status = 'not_submitted', aadhaar_rejection_reason = NULL WHERE id = ${hid} AND aadhaar_status = 'rejected'`;
        } else {
          await sql`UPDATE hosts SET pan_status = 'not_submitted', pan_rejection_reason = NULL, pan_number = NULL WHERE id = ${hid} AND pan_status = 'rejected'`;
        }
        await logAudit(sql, { action: `host_${field}_reopened`, success: true, actorType: 'admin', ...ADMIN_AUDIT, targetType: 'host', targetId: hid });
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error('resetIdVerification failed:', err);
        return res.status(500).json({ error: 'Could not reopen this right now.' });
      }
    }

    // ---- Erase identity documents that have already been reviewed ----
    // POST { purgeReviewedIdDocuments: true } — for anything reviewed
    // before erasing existed, and to retry any Blob deletion that failed.
    if (req.body && req.body.purgeReviewedIdDocuments) {
      try {
        // Checks before touching anything: a key must be configured, and it
        // must open whatever is already encrypted — otherwise stop, so the
        // database never ends up holding values under two different keys.
        if (!encryptionReady()) {
          return res.status(503).json({ error: 'DATA_ENCRYPTION_KEY is not set (or is not 32 bytes, base64) in Vercel. Nothing was changed.' });
        }
        const samples = await sql`
          SELECT pan_number AS v FROM hosts WHERE pan_number LIKE 'enc:v1:%'
          UNION ALL SELECT bank_account_number FROM hosts WHERE bank_account_number LIKE 'enc:v1:%'
          LIMIT 5
        `;
        let coSamples = [];
        try { coSamples = await sql`SELECT pan_number AS v FROM cohost_payout_profiles WHERE pan_number LIKE 'enc:v1:%' LIMIT 5`; } catch (e) { /* table not created yet */ }
        if (![...samples, ...coSamples].every(r => keyOpens(r.v))) {
          return res.status(409).json({ error: 'The DATA_ENCRYPTION_KEY in Vercel does not open the data already encrypted. It must be the original key — restore it before doing anything else. Nothing was changed.' });
        }
        const out = { aadhaar: 0, pan: 0, encrypted: 0, failed: 0, failures: [] };
        const hosts = await sql`
          SELECT id, aadhaar_status, aadhaar_document_url, pan_status, pan_document_url FROM hosts
          WHERE (aadhaar_status IN ('verified', 'rejected') AND aadhaar_document_url IS NOT NULL)
             OR (pan_status IN ('verified', 'rejected') AND pan_document_url IS NOT NULL)
        `;
        for (const h of hosts) {
          for (const field of ['aadhaar', 'pan']) {
            const status = field === 'aadhaar' ? h.aadhaar_status : h.pan_status;
            const url = field === 'aadhaar' ? h.aadhaar_document_url : h.pan_document_url;
            if (!['verified', 'rejected'].includes(status) || !url) continue;
            const e = await eraseHostIdDocument(h.id, field);
            if (e.erased) out[field]++;
            else { out.failed++; out.failures.push({ hostId: h.id, field, reason: e.reason || 'unknown' }); }
          }
        }
        // Encrypt any PAN or bank number still stored in the clear (saved
        // before encryption existed). Values already encrypted are skipped.
        const plainHosts = await sql`
          SELECT id, pan_number, bank_account_number FROM hosts
          WHERE (pan_number IS NOT NULL AND pan_number NOT LIKE 'enc:v1:%')
             OR (bank_account_number IS NOT NULL AND bank_account_number NOT LIKE 'enc:v1:%')
        `;
        for (const h of plainHosts) {
          await sql`UPDATE hosts SET
            pan_number = ${h.pan_number && !isEncrypted(h.pan_number) ? encryptField(h.pan_number) : h.pan_number},
            bank_account_number = ${h.bank_account_number && !isEncrypted(h.bank_account_number) ? encryptField(h.bank_account_number) : h.bank_account_number}
            WHERE id = ${h.id}`;
          out.encrypted++;
        }
        try {
          const plainCo = await sql`
            SELECT guest_id, pan_number, bank_account_number, gstin FROM cohost_payout_profiles
            WHERE (pan_number IS NOT NULL AND pan_number NOT LIKE 'enc:v1:%')
               OR (bank_account_number IS NOT NULL AND bank_account_number NOT LIKE 'enc:v1:%')
               OR (gstin IS NOT NULL AND gstin NOT LIKE 'enc:v1:%')
          `;
          const enc = (v) => (v && !isEncrypted(v) ? encryptField(v) : v);
          for (const c of plainCo) {
            await sql`UPDATE cohost_payout_profiles SET
              pan_number = ${enc(c.pan_number)}, bank_account_number = ${enc(c.bank_account_number)}, gstin = ${enc(c.gstin)}
              WHERE guest_id = ${c.guest_id}`;
            out.encrypted++;
          }
        } catch (err) { /* co-host table not created yet */ }
        await logAudit(sql, { action: 'id_documents_purged', success: true, actorType: 'admin', ...ADMIN_AUDIT, metadata: out });
        return res.status(200).json({ success: true, ...out });
      } catch (err) {
        console.error('purgeReviewedIdDocuments failed:', err);
        return res.status(500).json({ error: 'Could not erase reviewed documents right now.' });
      }
    }

    if (req.body && req.body.verifyDocument) {
      try {
        const { hostId, field, action, reason } = req.body.verifyDocument;
        if (field !== 'aadhaar' && field !== 'bank' && field !== 'pan') {
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

        let erased = null;
        let eraseReason = null;
        if (field === 'aadhaar') {
          const upd = await sql`
            UPDATE hosts SET aadhaar_status = ${newStatus}, aadhaar_rejection_reason = ${cleanReason}
            WHERE id = ${hostId} AND aadhaar_status = 'pending_review' RETURNING id
          `;
          if (upd.length) { const e = await eraseHostIdDocument(hostId, 'aadhaar'); erased = e.erased; eraseReason = e.reason || null; }
        } else if (field === 'pan') {
          const upd = await sql`
            UPDATE hosts SET pan_status = ${newStatus}, pan_rejection_reason = ${cleanReason}
            WHERE id = ${hostId} AND pan_status = 'pending_review' RETURNING id
          `;
          if (upd.length) { const e = await eraseHostIdDocument(hostId, 'pan'); erased = e.erased; eraseReason = e.reason || null; }
        } else {
          await sql`
            UPDATE hosts SET bank_status = ${newStatus}, bank_rejection_reason = ${cleanReason}
            WHERE id = ${hostId} AND bank_status = 'pending_review'
          `;
        }

        await logAudit(sql, {
          action: `host_${field}_${action}d`, success: true, actorType: 'admin', ...ADMIN_AUDIT,
          targetType: 'host', targetId: hostId, metadata: erased === null ? {} : { documentErased: erased }
        });

        return res.status(200).json({ success: true, documentErased: erased, eraseFailedReason: eraseReason });
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
  // ---- Payouts: co-host payout details, and who is owed what ----
  // GET ?payouts=1 — the 200 most recent paid bookings with the host's
  // payout split between host and co-hosts, and each payee's bank details
  // and approval, so payouts can be made by hand until Razorpay Route
  // automates them. Also every co-host payout profile waiting for review.
  if (req.query.payouts === '1') {
    try {
      let pendingProfiles = [];
      try {
        pendingProfiles = await sql`
          SELECT p.guest_id, g.name, g.email, p.pan_number, p.gstin, p.account_holder_name, p.bank_account_number,
                 p.bank_ifsc, p.status, p.submitted_at,
                 (SELECT string_agg(DISTINCT h.name, ', ') FROM cohosts c JOIN hosts h ON h.id = c.host_id
                   WHERE c.cohost_guest_id = p.guest_id AND c.status = 'active') AS cohosts_for
          FROM cohost_payout_profiles p JOIN guests g ON g.id = p.guest_id
          WHERE p.status = 'pending_review'
          ORDER BY p.submitted_at ASC
        `;
      } catch (err) { console.error('payout profiles unavailable:', err.message); }
      const orders = await sql`
        SELECT o.id, o.suite_name, o.arrival, o.departure, o.status, o.total, o.commission_amount, o.payout_amount,
               h.id AS host_id, h.name AS host_name, h.bank_account_holder_name AS host_holder,
               h.bank_account_number AS host_account, h.bank_ifsc AS host_ifsc, h.bank_status AS host_bank_status
        FROM orders o JOIN listings l ON l.id = o.listing_id JOIN hosts h ON h.id = l.host_id
        WHERE o.status = 'paid'
        ORDER BY o.arrival DESC NULLS LAST, o.id DESC
        LIMIT 200
      `;
      let shares = [];
      try {
        const ids = orders.map(o => o.id);
        if (ids.length) shares = await sql`
          SELECT s.order_id, s.percent, s.amount, s.cohost_guest_id, g.name, g.email,
                 p.account_holder_name, p.bank_account_number, p.bank_ifsc, p.status AS profile_status
          FROM order_cohost_shares s
          LEFT JOIN guests g ON g.id = s.cohost_guest_id
          LEFT JOIN cohost_payout_profiles p ON p.guest_id = s.cohost_guest_id
          WHERE s.order_id = ANY(${ids})
        `;
      } catch (err) { console.error('co-host shares unavailable:', err.message); }
      const byOrder = {};
      shares.forEach(x => { (byOrder[x.order_id] = byOrder[x.order_id] || []).push(x); });
      // Cancellation coupons the host chose to pay from their next payout.
      // Rows older than 6 months are flagged for an admin decision.
      let penalties = [];
      try {
        try {
          penalties = await sql`
            SELECT p.id, p.host_id, p.amount, p.created_at, h.name AS host_name, o.suite_name, o.id AS order_id,
                   p.payer_guest_id, pg.name AS payer_name, pg.email AS payer_email,
                   (p.created_at < now() - interval '6 months') AS over_six_months
            FROM host_penalties p JOIN hosts h ON h.id = p.host_id LEFT JOIN orders o ON o.id = p.order_id
            LEFT JOIN guests pg ON pg.id = p.payer_guest_id
            WHERE p.status = 'owed' ORDER BY p.created_at
          `;
        } catch (err) { // before migration_coupon_release.sql: all owed by hosts
          penalties = await sql`
            SELECT p.id, p.host_id, p.amount, p.created_at, h.name AS host_name, o.suite_name, o.id AS order_id,
                   (p.created_at < now() - interval '6 months') AS over_six_months
            FROM host_penalties p JOIN hosts h ON h.id = p.host_id LEFT JOIN orders o ON o.id = p.order_id
            WHERE p.status = 'owed' ORDER BY p.created_at
          `;
        }
      } catch (err) { /* table not created yet */ }
      // Owed by the host (from the host's payout) or by a co-host who
      // cancelled (from that co-host's own share).
      // Payouts already sent (Mark paid), per booking and payee.
      let paidRows = [];
      try {
        const ids = orders.map(o => o.id);
        if (ids.length) paidRows = await sql`SELECT id, order_id, payee_type, payee_guest_id, status, net, reference, sent_at, failure_reason, attempts, last_attempt_at, auto_eligible, tds, tds_rate, pan_furnished FROM payouts WHERE order_id = ANY(${ids})`;
      } catch (err) { /* migration_payouts.sql not run yet */ }
      const paidKey = (orderId, type, guest) => `${orderId}:${type}:${guest || 0}`;
      const paidMap = {};
      paidRows.forEach(p => { paidMap[paidKey(p.order_id, p.payee_type, p.payee_guest_id)] = { id: p.id, status: p.status, net: Number(p.net), reference: p.reference, sentAt: p.sent_at, failure: p.failure_reason,
        attempts: p.attempts, lastAttemptAt: p.last_attempt_at, autoEligible: p.auto_eligible, tds: Number(p.tds), tdsRate: Number(p.tds_rate), panFurnished: p.pan_furnished }; });
      // Refunds not yet confirmed (in progress, or failed: admin retries).
      let openRefunds = [];
      try {
        openRefunds = await sql`SELECT r.id, r.order_id, r.kind, r.amount, r.status, r.failure_reason, r.attempts, r.created_at, o.suite_name, o.guest_email, o.charge_currency
                                FROM refunds r JOIN orders o ON o.id = r.order_id WHERE r.status IN ('new', 'creating', 'pending', 'failed') ORDER BY r.created_at DESC LIMIT 100`;
      } catch (err) { /* migration_refunds.sql not run yet */ }
      const owedByHost = {};
      const owedByCohost = {};
      penalties.forEach(p => {
        if (p.payer_guest_id) owedByCohost[p.payer_guest_id] = (owedByCohost[p.payer_guest_id] || 0) + Number(p.amount);
        else owedByHost[p.host_id] = (owedByHost[p.host_id] || 0) + Number(p.amount);
      });
      // Unused coupon balances (coupon worth more than the booking price):
      // forfeited by the guest, kept by Aerva.
      let couponForfeitTotal = 0;
      try {
        couponForfeitTotal = Math.round(Number((await sql`SELECT COALESCE(SUM(forfeited_amount), 0) AS t FROM coupons WHERE status = 'redeemed'`)[0].t) || 0);
      } catch (err) { /* column not added yet */ }
      await logAudit(sql, { action: 'admin_viewed_payouts', success: true, actorType: 'admin', ...ADMIN_AUDIT,
        metadata: { bookings: orders.length, pendingProfiles: pendingProfiles.length } });
      return res.status(200).json({
        couponForfeitTotal,
        automaticPayouts: razorpayxReady(),
        refunds: openRefunds.map(r => ({ id: r.id, orderId: r.order_id, kind: r.kind, amount: Number(r.amount) / 100, currency: r.charge_currency || 'INR', status: r.status,
          failure: r.failure_reason, attempts: r.attempts, listing: r.suite_name, guestEmail: r.guest_email, createdAt: r.created_at })),
        penalties: penalties.map(p => ({ id: p.id, hostId: p.host_id, hostName: p.host_name, amount: Number(p.amount),
          payer: p.payer_guest_id ? 'cohost' : 'host', payerName: p.payer_guest_id ? (p.payer_name || p.payer_email || 'Co-host') : p.host_name,
          booking: p.suite_name, orderId: p.order_id, createdAt: p.created_at, overSixMonths: !!p.over_six_months })),
        pendingProfiles: pendingProfiles.map(p => ({
          guestId: p.guest_id, name: p.name, email: p.email, pan: readableForAdmin(p.pan_number), gstin: readableForAdmin(p.gstin),
          holder: p.account_holder_name, account: readableForAdmin(p.bank_account_number), ifsc: p.bank_ifsc,
          submittedAt: p.submitted_at, cohostsFor: p.cohosts_for || ''
        })),
        payouts: orders.map(o => {
          const cs = (byOrder[o.id] || []).map(x => ({
            name: x.name || x.email || 'Co-host', percent: Number(x.percent), amount: Number(x.amount),
            penaltyToDeduct: Math.round(owedByCohost[x.cohost_guest_id] || 0),
            guestId: x.cohost_guest_id, paid: paidMap[paidKey(x.order_id, 'cohost', x.cohost_guest_id)] || null,
            holder: x.account_holder_name || null, account: readableForAdmin(x.bank_account_number), ifsc: x.bank_ifsc || null,
            // Paid only once their payout details are approved.
            ready: x.profile_status === 'approved', profileStatus: x.profile_status || 'missing'
          }));
          const coTotal = cs.reduce((a, x) => a + x.amount, 0);
          return {
            penaltyToDeduct: Math.round(owedByHost[o.host_id] || 0),
            hostPaid: paidMap[paidKey(o.id, 'host', null)] || null,
            orderId: o.id, listing: o.suite_name, arrival: o.arrival, departure: o.departure,
            total: Number(o.total) || 0, commission: Number(o.commission_amount) || 0,
            hostPayout: Number(o.payout_amount) || 0, hostNet: (Number(o.payout_amount) || 0) - coTotal,
            host: { name: o.host_name, holder: o.host_holder, account: readableForAdmin(o.host_account), ifsc: o.host_ifsc,
                    ready: o.host_bank_status === 'verified' || o.host_bank_status === 'approved', bankStatus: o.host_bank_status || 'missing' },
            cohosts: cs
          };
        })
      });
    } catch (err) {
      console.error('payouts view failed:', err);
      return res.status(500).json({ error: 'Could not load payouts right now.' });
    }
  }

  if (req.query.verifications === '1') {
    try {
      // No dedicated "submitted at" column exists on hosts itself —
      // reused from audit_log instead (see host-listings.js, which
      // already logs host_aadhaar_submitted / host_bank_details_submitted
      // there), rather than adding a new column just to duplicate a
      // timestamp that's effectively already being recorded.
      const verifications = await sql`
        SELECT h.id, h.guest_id, h.email, h.name, h.phone,
               h.aadhaar_document_url, h.aadhaar_status, h.pan_number, h.pan_document_url, h.pan_status,
               (SELECT MAX(created_at) FROM audit_log WHERE action = 'host_pan_submitted' AND actor_identifier = h.id::text) AS pan_submitted_at,
               h.bank_account_number, h.bank_ifsc, h.bank_account_holder_name, h.bank_status,
               (SELECT MAX(created_at) FROM audit_log WHERE action = 'host_aadhaar_submitted' AND actor_identifier = h.id::text) AS aadhaar_submitted_at,
               (SELECT MAX(created_at) FROM audit_log WHERE action = 'host_bank_details_submitted' AND actor_identifier = h.id::text) AS bank_submitted_at
        FROM hosts h
        WHERE h.aadhaar_status = 'pending_review' OR h.bank_status = 'pending_review' OR h.pan_status = 'pending_review'
        ORDER BY h.id ASC
      `;
      // Numbers are stored encrypted; the admin reviewing sees them readable.
      verifications.forEach(v => {
        v.pan_number = readableForAdmin(v.pan_number);
        v.bank_account_number = readableForAdmin(v.bank_account_number);
      });
      // Rejected Aadhaar / PAN: the document is already erased, and the
      // host cannot upload again by themselves, so the admin can reopen it.
      const rejected = await sql`
        SELECT id, name, email, aadhaar_status, aadhaar_rejection_reason, pan_status, pan_rejection_reason
        FROM hosts WHERE aadhaar_status = 'rejected' OR pan_status = 'rejected'
        ORDER BY id DESC LIMIT 100
      `;
      // Viewing PAN and bank numbers is itself recorded.
      await logAudit(sql, { action: 'admin_viewed_id_verifications', success: true, actorType: 'admin', ...ADMIN_AUDIT,
        metadata: { pending: verifications.length, rejected: rejected.length } });
      return res.status(200).json({ verifications, rejected });
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

  // ---- Every currently-open compliance flag, for admin visibility —
  // which listings have an outstanding requirement, how much time is
  // left, and whether it's already been auto-enforced.
  // ---- Traffic ----
  // GET ?traffic=1 — two questions an admin actually asks: how many
  // people came, and who started a booking and did not finish it.
  //
  // Visits come from the per-day tally get-listings.js keeps. Abandoned
  // checkouts are derived from what is already logged: an order created
  // at Razorpay with no confirmed booking behind it. Nothing new is
  // recorded to answer this.
  if (req.query.traffic === '1') {
    try {
      const vs = await sql`SELECT value FROM site_settings WHERE key = 'visit_counts'`;
      const counts = (vs[0] && vs[0].value) || {};
      const visits = Object.keys(counts)
        .sort().reverse().slice(0, 30)
        .map(day => ({ day, visits: Number(counts[day]) || 0 }));

      const abandoned = await sql`
        SELECT a.created_at, a.actor_identifier AS email, a.metadata
        FROM audit_log a
        WHERE a.action = 'booking_order_created'
          AND a.created_at > now() - interval '30 days'
          AND NOT EXISTS (
            SELECT 1 FROM orders o
            WHERE o.razorpay_order_id = a.metadata->>'razorpayOrderId'
          )
        ORDER BY a.created_at DESC
        LIMIT 100
      `;
      const totalVisits = visits.reduce((n, v) => n + v.visits, 0);
      const started = await sql`
        SELECT COUNT(*) AS n FROM audit_log
        WHERE action = 'booking_order_created' AND created_at > now() - interval '30 days'
      `;
      const startedCount = Number(started[0] && started[0].n) || 0;
      return res.status(200).json({
        visits,
        totalVisits,
        checkoutsStarted: startedCount,
        checkoutsAbandoned: abandoned.length,
        abandoned: abandoned.map(a => ({
          at: a.created_at,
          email: a.email || null,
          amount: Number((a.metadata || {}).totalRupees) || null,
          currency: (a.metadata || {}).chargeCurrency || 'INR',
          items: [
            ...(((a.metadata || {}).stays) || []).map(x => ({ kind: 'stay', listingId: x.listingId, arrival: x.arrival, departure: x.departure, guests: x.guests })),
            ...(((a.metadata || {}).experiences) || []).map(x => ({ kind: 'experience', listingId: x.listingId, date: x.date, guests: x.guests }))
          ]
        }))
      });
    } catch (err) {
      console.error('get-pending-listings (traffic) error:', err);
      return res.status(500).json({ error: 'Could not load traffic: ' + (err.message || 'unknown error') });
    }
  }

  if (req.query.complianceFlags === '1') {
    try {
      const flags = await sql`
        SELECT cf.id, cf.listing_id, cf.requirement_key, cf.message, cf.deadline, cf.created_at, cf.auto_blocked,
               l.property_name, l.host_email, l.status AS listing_status
        FROM compliance_flags cf
        JOIN listings l ON l.id = cf.listing_id
        WHERE cf.resolved_at IS NULL
        ORDER BY cf.deadline ASC
      `;
      return res.status(200).json({ flags });
    } catch (err) {
      console.error('get-pending-listings (complianceFlags) error:', err);
      return res.status(500).json({ error: 'Could not fetch compliance flags: ' + (err.message || 'unknown error') });
    }
  }

  // ---- Listings that have ever gone live, for admin moderation ----
  // Deliberately separate from the 'pending' GET below — this is the
  // "manage what's already live" view (block/remove/unblock/restore),
  // not the "review a new submission" queue.
  if (req.query.liveListings === '1') {
    try {
      const liveListings = await sql`
        SELECT id, property_name, city, area, host_name, host_email, status,
               admin_status_reason, created_at
        FROM listings
        WHERE status IN ('approved', 'blocked', 'removed') AND listing_type = 'stay'
        ORDER BY created_at DESC
      `;
      return res.status(200).json({ liveListings });
    } catch (err) {
      console.error('get-pending-listings (liveListings) error:', err);
      return res.status(500).json({ error: 'Could not fetch listings' });
    }
  }

  try {
    const listings = await sql`
      SELECT l.id, l.property_name, l.city, l.area, l.property_type, l.bedrooms, l.max_guests,
             l.nightly_rate, l.description, l.amenities, l.services,
             l.host_name, l.host_email, l.host_phone,
             l.discount_type, l.discount_value, l.discount_min_nights, l.discount_description,
             l.exterior_photo_urls, l.interior_photo_urls,
             l.latitude, l.longitude, l.formatted_address, l.pincode,
             l.commission_rate, l.created_at,
             l.listing_type, l.hosting_listing_id, l.experience_category,
             l.experience_price_unit, l.experience_duration_hours,
             l.pending_room_photos,
             h.property_name AS hosting_property_name,
             c.property_name AS cloned_from_property_name, c.status AS cloned_from_status,
             c.rejection_reason AS cloned_from_rejection_reason
      FROM listings l
      LEFT JOIN listings h ON h.id = l.hosting_listing_id
      LEFT JOIN listings c ON c.id = l.cloned_from_listing_id
      WHERE l.status = 'pending'
      ORDER BY l.created_at ASC
    `;

    // Separate from the "brand new submission" queue above — these are
    // individual rooms on ALREADY-approved, live Resorts where the host
    // has since added, edited, or is proposing something new for a
    // specific room. Per-room now, not per-listing: two different rooms
    // on the same resort can be independently pending, and this returns
    // each as its own entry rather than bundling a whole listing's
    // rooms into one review. For an edit to a previously-live room, the
    // room's own fields ARE the still-live version and pending_changes
    // holds the proposal; for a brand-new room, the room's own fields
    // already hold the intended data (it's just inactive) and
    // pending_changes only carries the newRoomIntendedActive marker —
    // admin.html tells these apart the same way update-listing-pricing.js
    // does.
    const roomChangeRequests = await sql`
      SELECT lr.id AS room_id, lr.listing_id, lr.room_name, lr.max_occupancy, lr.nightly_rate,
             lr.description, lr.cover_photo_url, lr.photo_urls, lr.is_active,
             lr.pending_changes, lr.pending_since,
             l.property_name, l.city, l.area, l.host_name, l.host_email, l.host_phone
      FROM listing_rooms lr
      JOIN listings l ON l.id = lr.listing_id
      WHERE lr.pending_review = TRUE
      ORDER BY lr.pending_since ASC NULLS LAST
    `;

    return res.status(200).json({ listings, roomChangeRequests });
  } catch (err) {
    console.error('get-pending-listings error:', err);
    // This is an authenticated, admin-only endpoint — safe to return the
    // actual database error message here, unlike a public-facing one.
    // A generic "Could not fetch listings" with no detail was the reason
    // a missing-migration column error looked identical to every other
    // possible failure on the admin page, with no way to tell them apart
    // without checking server logs directly.
    return res.status(500).json({ error: 'Could not fetch listings: ' + (err.message || 'unknown error') });
  }
};
