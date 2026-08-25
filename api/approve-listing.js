// /api/approve-listing.js
// Two ways in, one action taken:
//   GET  ?token=...           — clicked from the "Approve"/"Reject" link
//                                in the admin notification email.
//   POST { listingId, action } with header x-admin-secret — clicked from
//                                a button on admin.html instead.
//
// On approval, this also emails the host a long-lived link to manage their
// own listing's price and discount going forward (manage-listing.html) —
// best-effort, same pattern as the admin notification email in
// submit-listing.js: if RESEND_API_KEY isn't set, it's skipped quietly
// rather than failing the approval itself.

const { neon } = require('@neondatabase/serverless');
const { verifyToken, createToken } = require('./_approval-token');

const sql = neon(process.env.DATABASE_URL);

const SITE_BASE = 'https://aerva.in';
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

async function sendHostApprovalEmail(listing) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping host approval email.');
    return;
  }
  const manageToken = createToken(listing.id, 'manage-pricing', TWO_YEARS_MS);
  const manageLink = `${SITE_BASE}/manage-listing.html?token=${manageToken}`;

  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">Your listing is live on Aerva</h2>
      <p><strong>${listing.property_name}</strong> is now approved and visible to guests.</p>
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
      subject: `${listing.property_name} is live on Aerva`,
      html
    })
  });
}

async function applyDecision(listingId, action) {
  if (action !== 'approve' && action !== 'reject') {
    throw new Error('Invalid action');
  }
  const newStatus = action === 'approve' ? 'approved' : 'rejected';

  const result = await sql`
    UPDATE listings SET status = ${newStatus}
    WHERE id = ${listingId}
    RETURNING id, property_name, status, host_email
  `;
  const listing = result[0] || null;

  if (listing && action === 'approve') {
    try {
      await sendHostApprovalEmail(listing);
    } catch (emailErr) {
      console.error('Host approval email failed:', emailErr);
    }
  }

  return listing;
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');

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
      const listing = await applyDecision(payload.listingId, payload.action);
      if (!listing) {
        return res.status(404).send(htmlPage('Listing not found', 'This listing may have already been removed.', true));
      }
      return res.status(200).send(htmlPage(
        payload.action === 'approve' ? 'Listing approved' : 'Listing rejected',
        `"${listing.property_name}" has been marked as ${listing.status}.`,
        false
      ));
    } catch (err) {
      console.error('approve-listing (GET) error:', err);
      return res.status(500).send(htmlPage('Something went wrong', 'Please try again from the admin page.', true));
    }
  }

  // ---- Path 2: admin page button ----
  if (req.method === 'POST') {
    const adminSecret = req.headers['x-admin-secret'];
    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const { listingId, action } = req.body;
      const listing = await applyDecision(listingId, action);
      if (!listing) return res.status(404).json({ error: 'Listing not found' });
      return res.status(200).json({ success: true, listing });
    } catch (err) {
      console.error('approve-listing (POST) error:', err);
      return res.status(500).json({ error: 'Could not update listing' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
