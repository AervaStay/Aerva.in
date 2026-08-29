// /api/blob-upload.js
// Photos (and, for one specific case, ID documents) upload directly from
// the browser to Vercel Blob storage — they never pass through this
// server. This endpoint's only job is to hand out a short-lived, scoped
// upload token after checking the request looks legitimate (right file
// type, reasonable size). This is the standard "client upload" pattern
// for Vercel Blob.
//
// Callers pass a clientPayload to say what they're uploading:
//   (nothing / anything else) — listing photos: images only, as before.
//   'aadhaar-verification'    — host-dashboard.html's Aadhaar upload
//                                (see host-listings.js) additionally
//                                allows PDF, since e-Aadhaar downloads
//                                from UIDAI are commonly PDFs, not photos.
// This keeps the PDF allowance scoped to that one flow rather than
// loosening what regular listing-photo uploads will accept.

const { handleUpload } = require('@vercel/blob/client');

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
        // No user accounts on this site, so there's no "is this the right
        // person" check to do — instead we restrict *what* can be uploaded:
        // images only (plus PDF for the Aadhaar case above), capped size,
        // so this endpoint can't be abused to host arbitrary files.
        const isAadhaarUpload = clientPayload === 'aadhaar-verification';
        const allowedContentTypes = isAadhaarUpload
          ? ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
          : ['image/jpeg', 'image/png', 'image/webp'];
        return {
          allowedContentTypes,
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
    console.error('blob-upload error:', err);
    return res.status(400).json({ error: err.message || 'Upload authorization failed' });
  }
};
