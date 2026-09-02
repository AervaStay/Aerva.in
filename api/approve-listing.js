// /api/approve-listing.js
// Three ways in:
//   GET  ?token=...(action=approve)  — clicked "Approve" in the admin
//                                       email. Instant, same as before.
//   GET  ?token=...(action=reject)   — clicked "Reject" in the admin
//                                       email. Shows a short form asking
//                                       for a reason FIRST — rejection
//                                       isn't finalized until that's
//                                       submitted (see the POST-with-token
//                                       path below).
//   POST { token, reason }           — submitted from that reason form.
//                                       Finalizes the rejection and emails
//                                       the host with the specific reason.
//   POST { listingId, action, reason? } with header x-admin-secret
//                                     — clicked a button on admin.html
//                                       instead. reason is optional here.
//
// On approval, this also emails the host a long-lived link to manage their
// own listing's price and discount going forward (manage-listing.html) —
// best-effort, same pattern as the admin notification email in
// submit-listing.js: if RESEND_API_KEY isn't set, it's skipped quietly
// rather than failing the approval/rejection itself.

const { neon } = require('@neondatabase/serverless');
const { verifyToken, createToken } = require('./_approval-token');

const sql = neon(process.env.DATABASE_URL);

const SITE_BASE = 'https://aerva.in';
// Distinct from SITE_BASE — see the note in submit-listing.js. This file
// IS the API, so its own self-referencing links (the reason form's submit
// target) need to point here, not at the static frontend.
const API_BASE = 'https://aerva-in.vercel.app';
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

function htmlPage(title, message, isError) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
  <style>
    body{font-family:'Jost',sans-serif;background:#f4eadc;color:#1c1a17;
      display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}
    .box{max-width:420px;padding:40px;}
    h1{font-family:'Bodoni Moda',serif;font-size:24px;margin-bottom:12px;color:${isError ? '#a3402f' : '#1c1a17'};}
    p{opacity:0.75;line-height:1.6;}
  </style></head>
  <body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

// The reason-entry page shown when an admin clicks "Reject" — rejection
// only actually happens once this form is submitted, not on the initial
// click. Self-contained: submits via fetch to this same endpoint (POST
// with the token), then swaps in a confirmation message inline.
function rejectionReasonPage(listing, token) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Reject Listing</title>
  <style>
    body{font-family:'Jost',sans-serif;background:#f4eadc;color:#1c1a17;
      display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box;}
    .box{max-width:440px;width:100%;}
    h1{font-family:'Bodoni Moda',serif;font-size:24px;margin-bottom:8px;}
    .subtitle{opacity:0.7;line-height:1.6;margin-bottom:24px;font-size:14px;}
    label{font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#8a7f6c;display:block;margin-bottom:6px;}
    textarea{width:100%;box-sizing:border-box;background:white;border:1px solid #ddd0bc;padding:12px;
      font-family:'Jost',sans-serif;font-size:15px;color:#1c1a17;min-height:110px;resize:vertical;}
    .btn{background:#a3402f;color:#f4eadc;border:none;padding:14px 28px;font-size:12px;
      letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;width:100%;margin-top:16px;}
    .btn:disabled{opacity:0.5;cursor:default;}
    .error{font-size:13px;color:#a3402f;margin-top:12px;display:none;}
    .confirm{font-size:15px;line-height:1.7;display:none;}
  </style></head>
  <body><div class="box">
    <div id="formState">
      <h1>Reject "${listing.property_name}"</h1>
      <p class="subtitle">This note goes directly to the host by email, so please make it specific and actionable — e.g. "Exterior photos are too dark, please retake in daylight" rather than just "photos need work."</p>
      <label for="reason">Reason for the host</label>
      <textarea id="reason" placeholder="What needs to change before this can be approved?"></textarea>
      <p class="error" id="reasonError">Please enter a reason before rejecting — the host needs to know what to fix.</p>
      <button class="btn" id="submitBtn">Reject &amp; Notify Host</button>
    </div>
    <div id="confirmState" class="confirm">
      <h1>Listing rejected</h1>
      <p>"${listing.property_name}" has been marked as rejected, and the host has been emailed the reason.</p>
    </div>
  </div>
  <script>
    document.getElementById('submitBtn').addEventListener('click', async function(){
      var reasonEl = document.getElementById('reason');
      var errorEl = document.getElementById('reasonError');
      var reason = reasonEl.value.trim();
      if(!reason){
        errorEl.style.display = 'block';
        return;
      }
      errorEl.style.display = 'none';
      this.disabled = true;
      this.textContent = 'Submitting…';
      try{
        var res = await fetch('${API_BASE}/api/approve-listing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: '${token}', reason: reason })
        });
        if(res.ok){
          document.getElementById('formState').style.display = 'none';
          document.getElementById('confirmState').style.display = 'block';
        } else {
          var data = await res.json();
          errorEl.textContent = data.error || 'Something went wrong. Please try again.';
          errorEl.style.display = 'block';
          this.disabled = false;
          this.textContent = 'Reject & Notify Host';
        }
      } catch(err){
        errorEl.textContent = 'Something went wrong. Please try again.';
        errorEl.style.display = 'block';
        this.disabled = false;
        this.textContent = 'Reject & Notify Host';
      }
    });
  </script>
  </body></html>`;
}

async function sendHostApprovalEmail(listing) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping host approval email.');
    return;
  }
  const manageToken = createToken(listing.id, 'manage-pricing', TWO_YEARS_MS);
  const manageLink = `${SITE_BASE}/manage-listing.html?token=${manageToken}`;

  // "Aerva Host" status is awarded the moment a host has at least one
  // approved listing (see host-listings.js, which computes this the same
  // way for the dashboard). Only call it out here the first time it
  // actually happens — a host's second, third, etc. approval is still
  // good news, just not a new milestone worth re-announcing.
  let isFirstApproval = false;
  if (listing.host_id) {
    const approvedCount = await sql`
      SELECT COUNT(*)::int AS count FROM listings WHERE host_id = ${listing.host_id} AND status = 'approved'
    `;
    isFirstApproval = approvedCount[0].count === 1;
  }

  const badgeAnnouncement = isFirstApproval ? `
      <div style="background:#faf3e6; border:1px solid #ddc9a3; padding:16px 20px; margin:20px 0; border-radius:4px;">
        <p style="margin:0; font-size:13px; letter-spacing:0.06em; text-transform:uppercase; color:#8a6c39;">New status unlocked</p>
        <p style="margin:6px 0 0; font-size:16px; font-family:Georgia,serif;">You're now an <strong>Aerva Host</strong> 🎉</p>
      </div>
  ` : '';

  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">Your listing is live on Aerva</h2>
      <p><strong>${listing.property_name}</strong> is now approved and visible to guests.</p>
      ${badgeAnnouncement}
      <p>Whenever you'd like to change your nightly rate or set up an offer, use this link — it's yours to keep and reuse anytime:</p>
      <p><a href="${manageLink}" style="background:#1c1a17; color:#f4eadc; padding:12px 24px; text-decoration:none; display:inline-block;">Manage Price & Offers</a></p>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">Keep this email — this link doesn't expire for two years. If you ever lose it, contact hello@aerva.in for a new one.</p>
    </div>
  `;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Aerva <hello@aerva.in>',
      to: listing.host_email,
      subject: isFirstApproval ? `You're an Aerva Host — ${listing.property_name} is live!` : `${listing.property_name} is live on Aerva`,
      html
    })
  });
}

async function sendHostRejectionEmail(listing) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping host rejection email.');
    return;
  }

  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">About your listing submission</h2>
      <p><strong>${listing.property_name}</strong> wasn't approved this time. Here's why:</p>
      <div style="background:#faf3e6; border-left:3px solid #a3402f; padding:14px 18px; margin:16px 0;">
        <p style="margin:0; white-space:pre-wrap;">${listing.rejection_reason}</p>
      </div>
      <p>Once you've made those changes and submitted them, we'll review your listing again and send you an update.</p>
      <p><a href="${SITE_BASE}/host-dashboard.html" style="color:#8a6c39;">Go to your dashboard</a> to edit and resubmit this listing.</p>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">Questions about this decision? Just reply — a real person reads every message.</p>
    </div>
  `;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Aerva <hello@aerva.in>',
      to: listing.host_email,
      subject: `Update on your Aerva listing: ${listing.property_name}`,
      html
    })
  });
}

async function applyDecision(listingId, action, reason = null) {
  if (action !== 'approve' && action !== 'reject') {
    throw new Error('Invalid action');
  }
  const newStatus = action === 'approve' ? 'approved' : 'rejected';

  const result = await sql`
    UPDATE listings SET status = ${newStatus}, rejection_reason = ${action === 'reject' ? reason : null}
    WHERE id = ${listingId}
    RETURNING id, property_name, status, host_email, host_id, rejection_reason
  `;
  const listing = result[0] || null;

  if (listing && action === 'approve') {
    try {
      await sendHostApprovalEmail(listing);
    } catch (emailErr) {
      console.error('Host approval email failed:', emailErr);
    }
  }
  if (listing && action === 'reject' && listing.rejection_reason) {
    try {
      await sendHostRejectionEmail(listing);
    } catch (emailErr) {
      console.error('Host rejection email failed:', emailErr);
    }
  }

  return listing;
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ---- Path 1: email magic link ----
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html');
    const token = req.query.token;
    const payload = token ? verifyToken(token) : null;

    if (!payload) {
      return res.status(400).send(htmlPage(
        'Link expired or invalid',
        'This approval link is no longer valid — it may have already been used, or it\'s more than 7 days old. Use the admin page instead to review this listing.',
        true
      ));
    }

    try {
      // Approve is still instant — only reject needs a reason first.
      if (payload.action === 'approve') {
        const listing = await applyDecision(payload.listingId, 'approve');
        if (!listing) {
          return res.status(404).send(htmlPage('Listing not found', 'This listing may have already been removed.', true));
        }
        return res.status(200).send(htmlPage('Listing approved', `"${listing.property_name}" is now approved and live.`, false));
      }

      // Reject: show the reason form instead of rejecting immediately.
      // Look the listing up without changing anything yet.
      const rows = await sql`SELECT id, property_name, status FROM listings WHERE id = ${payload.listingId}`;
      const listing = rows[0];
      if (!listing) {
        return res.status(404).send(htmlPage('Listing not found', 'This listing may have already been removed.', true));
      }
      if (listing.status !== 'pending') {
        return res.status(400).send(htmlPage(
          'Already reviewed',
          `"${listing.property_name}" is already marked as ${listing.status} — no action needed.`,
          true
        ));
      }
      return res.status(200).send(rejectionReasonPage(listing, token));
    } catch (err) {
      console.error('approve-listing (GET) error:', err);
      return res.status(500).send(htmlPage('Something went wrong', 'Please try again from the admin page.', true));
    }
  }

  // ---- Path 2: reason form submission (token-based, from the page above) ----
  if (req.method === 'POST' && req.body && req.body.token) {
    try {
      const { token, reason } = req.body;
      const payload = verifyToken(token);
      if (!payload || payload.action !== 'reject') {
        return res.status(400).json({ error: 'This link is no longer valid. Please use the admin page instead.' });
      }
      const cleanReason = typeof reason === 'string' ? reason.trim() : '';
      if (!cleanReason) {
        return res.status(400).json({ error: 'Please enter a reason before rejecting — the host needs to know what to fix.' });
      }
      const listing = await applyDecision(payload.listingId, 'reject', cleanReason);
      if (!listing) return res.status(404).json({ error: 'Listing not found' });
      return res.status(200).json({ success: true, listing });
    } catch (err) {
      console.error('approve-listing (POST token) error:', err);
      return res.status(500).json({ error: 'Could not reject the listing right now. Please try again.' });
    }
  }

  // ---- Path 3: admin page button ----
  if (req.method === 'POST') {
    // Same dual-auth as get-pending-listings.js: a real admin login
    // session (the normal way now) or the master ADMIN_SECRET (kept
    // working as a fallback / for creating new admin accounts).
    const adminSecret = req.headers['x-admin-secret'];
    const authHeader = req.headers['authorization'] || '';
    const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const sessionPayload = sessionToken ? verifyToken(sessionToken) : null;
    const hasValidSession = sessionPayload && sessionPayload.action === 'admin-session';
    const hasValidSecret = adminSecret && adminSecret === process.env.ADMIN_SECRET;
    if (!hasValidSession && !hasValidSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const { listingId, action, reason } = req.body;
      const listing = await applyDecision(listingId, action, reason || null);
      if (!listing) return res.status(404).json({ error: 'Listing not found' });
      return res.status(200).json({ success: true, listing });
    } catch (err) {
      console.error('approve-listing (POST) error:', err);
      return res.status(500).json({ error: 'Could not update listing' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
