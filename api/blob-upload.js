// /api/blob-upload.js
// Photos (and a few documents) upload directly from
// the browser to Vercel Blob storage — they never pass through this
// server. This endpoint's only job is to hand out a short-lived, scoped
// upload token after checking the request looks legitimate (right file
// type, reasonable size). This is the standard "client upload" pattern
// for Vercel Blob.
//
// Only a signed-in caller gets a token. The browser sends clientPayload
// as a JSON string:
//   { purpose, token }
//   token   — a guest/host session (aerva_guest_session), the long-lived
//             manage-listing link token, or an admin session.
//   purpose — (nothing / anything else) listing and profile photos:
//               images only.
//             'aadhaar-verification' / 'dispute-evidence' — PDF allowed
//               too (e-Aadhaar downloads and stay-dispute evidence are
//               often PDFs). Kept to those flows only.
// The old plain-string clientPayload ('aadhaar-verification') carried no
// session and is refused.
//
// Each token handed out is written to audit_log (blob_upload_token), and
// one account may take at most UPLOADS_PER_DAY in 24 hours, so a signed-in
// account cannot turn Aerva's storage into free file hosting either.

const { handleUpload } = require('@vercel/blob/client');
const { neon } = require('@neondatabase/serverless');
const { verifyToken } = require('./_approval-token');
const { logAudit } = require('./_audit-log');
const { countRecentAttempts, getClientIp } = require('./_rate-limit');

const UPLOADS_PER_DAY = 200;
const PDF_PURPOSES = ['aadhaar-verification', 'dispute-evidence'];
const SESSION_ACTIONS = ['guest-session', 'manage-pricing', 'manage-cohost', 'admin-session'];

let sqlClient = null;
function db() {
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

// Guest sessions can be signed out everywhere (_accounts.js, once that
// helper exists); checked when it does. Never throws.
async function guestSessionRevoked(sql, payload) {
  try {
    const accounts = require('./_accounts');
    if (typeof accounts.isSessionRevoked === 'function') return await accounts.isSessionRevoked(sql, payload);
  } catch (err) { /* helper not available: the signature check stands alone */ }
  return false;
}

// Who is asking, from the clientPayload. Returns { account, purpose, kind }
// or throws with a message the uploader can show.
async function uploaderFrom(sql, clientPayload) {
  let parsed = null;
  try { parsed = JSON.parse(String(clientPayload || '')); } catch (e) { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.token !== 'string' || !parsed.token) {
    throw new Error('Please sign in again to upload files.');
  }
  const payload = verifyToken(parsed.token);
  if (!payload || !SESSION_ACTIONS.includes(payload.action) || !payload.listingId) {
    throw new Error('Please sign in again to upload files.');
  }
  if (payload.action === 'guest-session' && await guestSessionRevoked(sql, payload)) {
    throw new Error('Please sign in again to upload files.');
  }
  if (payload.action === 'manage-pricing') {
    // The manage-listing link names a listing; it must still exist.
    const rows = await sql`SELECT id FROM listings WHERE id = ${Number(payload.listingId) || 0}`;
    if (!rows.length) throw new Error('This link is no longer valid.');
  }
  // A co-host's Manage link: valid only while they are still an active
  // co-host of that listing (same check update-listing-pricing.js makes).
  let cohostListing = null;
  if (payload.action === 'manage-cohost') {
    const { readCohostManageToken } = require('./_cohosts');
    const ok = await readCohostManageToken(sql, payload);
    if (!ok) throw new Error('This link is no longer valid.');
    cohostListing = ok.listingId;
  }
  if (payload.action === 'admin-session') {
    const rows = await sql`SELECT id FROM admins WHERE id = ${Number(payload.listingId) || 0}`;
    if (!rows.length) throw new Error('Please sign in again to upload files.');
  }
  const kind = { 'guest-session': 'guest', 'manage-pricing': 'listing', 'manage-cohost': 'listing', 'admin-session': 'admin' }[payload.action];
  // audit_log.actor_type allows admin | host | guest | system only.
  const actorType = { guest: 'guest', listing: 'host', admin: 'system' }[kind];
  return { account: `${kind}:${cohostListing || payload.listingId}`, kind, actorType, purpose: typeof parsed.purpose === 'string' ? parsed.purpose : '' };
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const sql = db();
        const who = await uploaderFrom(sql, clientPayload);
        // countRecentAttempts fails open on a database error, like every
        // other limit on the site.
        const used = await countRecentAttempts(sql, { action: 'blob_upload_token', windowMinutes: 24 * 60, byActor: who.account });
        if (used >= UPLOADS_PER_DAY) {
          await logAudit(sql, { action: 'blob_upload_refused', success: false, actorType: who.actorType,
            actorIdentifier: who.account, metadata: { reason: 'daily limit', ip: getClientIp(req) } });
          throw new Error(`Upload limit reached (${UPLOADS_PER_DAY} files a day). Please try again tomorrow.`);
        }
        const allowsPdf = PDF_PURPOSES.includes(who.purpose);
        await logAudit(sql, { action: 'blob_upload_token', success: true, actorType: who.actorType,
          actorIdentifier: who.account, metadata: { purpose: who.purpose || 'photo', pathname: String(pathname || '').slice(0, 200), ip: getClientIp(req) } });
        return {
          allowedContentTypes: allowsPdf
            ? ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
            : ['image/jpeg', 'image/png', 'image/webp'],
          maximumSizeInBytes: 8 * 1024 * 1024, // 8MB per file
          addRandomSuffix: true, // avoids filename collisions between hosts
        };
      },
      onUploadCompleted: async ({ blob }) => {
        // Nothing to do here — the browser already has the blob's URL and
        // includes it directly in the listing submission (see submit-listing.js)
        // or the Aadhaar submission (see host-listings.js).
        console.log('File uploaded to Blob:', blob.url);
      },
    });

    return res.status(200).json(jsonResponse);
  } catch (err) {
    console.error('blob-upload error:', err.message);
    return res.status(400).json({ error: err.message || 'Upload authorization failed' });
  }
};

// For tests.
module.exports.uploaderFrom = uploaderFrom;
