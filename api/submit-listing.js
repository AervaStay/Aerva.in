// /api/submit-listing.js
// Saves a property submission into Neon, logs its starting price into
// price_history, and emails the admin a notification with one-click
// Approve / Reject links (see approve-listing.js and _approval-token.js).
//
// Photos still go to your inbox separately via Formspree (see aerva.html) —
// this only handles the structured/text fields.

const { neon } = require('@neondatabase/serverless');
const { createToken, verifyToken } = require('./_approval-token');

const sql = neon(process.env.DATABASE_URL);

// Aerva's cut on bookings — set by the platform, not the host, same as
// Airbnb's host service fee. Applied to every new listing at submission time.
const DEFAULT_COMMISSION_RATE = 15;

const SITE_BASE = 'https://aerva.in';
const ADMIN_EMAIL = 'hello@aerva.in';

async function sendAdminNotification(listing) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping admin notification email.');
    return;
  }

  const approveLink = `${SITE_BASE}/api/approve-listing?token=${createToken(listing.id, 'approve')}`;
  const rejectLink = `${SITE_BASE}/api/approve-listing?token=${createToken(listing.id, 'reject')}`;

  const exteriorPhotos = Array.isArray(listing.exterior_photo_urls) ? listing.exterior_photo_urls : [];
  const interiorPhotos = Array.isArray(listing.interior_photo_urls) ? listing.interior_photo_urls : [];

  function thumbnailRow(label, urls){
    if (!urls.length) return '';
    return `
      <p style="font-size:12px; opacity:0.6; margin:12px 0 4px;">${label}</p>
      <div style="display:flex; gap:6px;">${urls.slice(0, 5).map(url =>
        `<img src="${url}" width="90" height="90" style="object-fit:cover; border-radius:4px;">`
      ).join('')}</div>
    `;
  }

  const photoThumbnails = (exteriorPhotos.length || interiorPhotos.length)
    ? thumbnailRow('Exterior', exteriorPhotos) + thumbnailRow('Interior', interiorPhotos)
    : '<p style="font-size:12px; opacity:0.6;">No photos attached to this submission.</p>';

  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">New listing submitted</h2>
      <p><strong>${listing.property_name}</strong> — ${listing.city}</p>
      <p>Host: ${listing.host_name} (${listing.host_email}, ${listing.host_phone})</p>
      <p>Rate: ₹${listing.nightly_rate || 'not specified'}/night</p>
      ${photoThumbnails}
      <p style="white-space:pre-wrap;">${listing.description}</p>
      <div style="margin-top:24px;">
        <a href="${approveLink}" style="background:#1c1a17; color:#f4eadc; padding:12px 24px; text-decoration:none; margin-right:12px;">Approve</a>
        <a href="${rejectLink}" style="border:1px solid #a3402f; color:#a3402f; padding:12px 24px; text-decoration:none;">Reject</a>
      </div>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">Or review this and all pending listings at ${SITE_BASE}/admin.html</p>
    </div>
  `;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Aerva <hello@aerva.in>', // requires aerva.in verified in Resend — see below
      to: ADMIN_EMAIL,
      subject: `New listing: ${listing.property_name}`,
      html
    })
  });
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // A listing must now be tied to a real, logged-in host account — this is
  // what makes host-dashboard.html's "your listings" actually meaningful.
  const authHeader = req.headers['authorization'] || '';
  const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const sessionPayload = sessionToken ? verifyToken(sessionToken) : null;
  if (!sessionPayload || sessionPayload.action !== 'host-session') {
    return res.status(401).json({ error: 'Please log in to list a property.' });
  }
  const hostId = sessionPayload.listingId; // see the naming note in host-auth.js

  try {
    const {
      listingId, isDraft,
      propertyName, city, propertyType, bedrooms, maxGuests, nightlyRate,
      description, amenities, services, hostName, hostPhone,
      discountType, discountValue, discountMinNights, discountDescription,
      exteriorPhotoUrls, interiorPhotoUrls
    } = req.body;

    // hostEmail is looked up from the authenticated account, never trusted
    // from the request body — a logged-in host can't submit a listing
    // claiming to be a different host's email address.
    const hostRows = await sql`SELECT email FROM hosts WHERE id = ${hostId}`;
    const authenticatedHostEmail = hostRows[0] ? hostRows[0].email : null;
    if (!authenticatedHostEmail) {
      return res.status(401).json({ error: 'Your account could not be found. Please log in again.' });
    }

    // Resuming an existing draft to either update it or finally submit it —
    // verify it's really this host's own draft before touching it.
    let existingDraft = null;
    if (listingId) {
      const rows = await sql`SELECT id, host_id, status FROM listings WHERE id = ${listingId}`;
      existingDraft = rows[0];
      if (!existingDraft || existingDraft.host_id !== hostId) {
        return res.status(403).json({ error: 'You do not have permission to edit this listing.' });
      }
      if (existingDraft.status !== 'draft') {
        return res.status(400).json({ error: 'Only drafts can be edited this way — approved or pending listings go through the review team.' });
      }
    }

    // A draft only needs a name to be worth saving — everything else can
    // come later. A real submission still needs the full set.
    if (!propertyName) {
      return res.status(400).json({ error: 'Please give your property a name before saving.' });
    }
    if (!isDraft) {
      if (!city || !description || !hostName || !hostPhone) {
        console.warn('submit-listing rejected: missing required text fields');
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (!Array.isArray(exteriorPhotoUrls) || exteriorPhotoUrls.length === 0) {
        console.warn('submit-listing rejected: no exterior photos');
        return res.status(400).json({ error: 'At least 1 exterior photo is required' });
      }
      if (!Array.isArray(interiorPhotoUrls) || interiorPhotoUrls.length === 0) {
        console.warn('submit-listing rejected: no interior photos');
        return res.status(400).json({ error: 'At least 1 interior photo is required' });
      }
    }

    const rate = nightlyRate ? Number(nightlyRate) : null;
    // Only accept strings that look like real Blob URLs — defensive against
    // a tampered request trying to inject arbitrary content here.
    function sanitizePhotoUrls(urls){
      return Array.isArray(urls)
        ? urls.filter(url => typeof url === 'string' && url.startsWith('https://')).slice(0, 5)
        : [];
    }
    const safeExteriorUrls = sanitizePhotoUrls(exteriorPhotoUrls);
    const safeInteriorUrls = sanitizePhotoUrls(interiorPhotoUrls);
    const newStatus = isDraft ? 'draft' : 'pending';

    let listing;
    if (existingDraft) {
      const updated = await sql`
        UPDATE listings SET
          property_name = ${propertyName}, city = ${city || null}, property_type = ${propertyType || null},
          bedrooms = ${bedrooms || null}, max_guests = ${maxGuests || null}, nightly_rate = ${rate},
          description = ${description || null}, amenities = ${JSON.stringify(amenities || [])}, services = ${JSON.stringify(services || [])},
          host_name = ${hostName || null}, host_phone = ${hostPhone || null},
          discount_type = ${discountType || null}, discount_value = ${discountValue ? Number(discountValue) : null},
          discount_min_nights = ${discountMinNights ? Number(discountMinNights) : null}, discount_description = ${discountDescription || null},
          exterior_photo_urls = ${JSON.stringify(safeExteriorUrls)}, interior_photo_urls = ${JSON.stringify(safeInteriorUrls)},
          status = ${newStatus}
        WHERE id = ${listingId}
        RETURNING *
      `;
      listing = updated[0];
    } else {
      const inserted = await sql`
        INSERT INTO listings (
          property_name, city, property_type, bedrooms, max_guests, nightly_rate,
          description, amenities, services, host_name, host_email, host_phone, host_id,
          discount_type, discount_value, discount_min_nights, discount_description,
          commission_rate, exterior_photo_urls, interior_photo_urls, status
        ) VALUES (
          ${propertyName}, ${city || null}, ${propertyType || null}, ${bedrooms || null},
          ${maxGuests || null}, ${rate},
          ${description || null}, ${JSON.stringify(amenities || [])}, ${JSON.stringify(services || [])},
          ${hostName || null}, ${authenticatedHostEmail}, ${hostPhone || null}, ${hostId},
          ${discountType || null}, ${discountValue ? Number(discountValue) : null},
          ${discountMinNights ? Number(discountMinNights) : null}, ${discountDescription || null},
          ${DEFAULT_COMMISSION_RATE}, ${JSON.stringify(safeExteriorUrls)}, ${JSON.stringify(safeInteriorUrls)}, ${newStatus}
        )
        RETURNING *
      `;
      listing = inserted[0];
    }

    // Drafts don't need admin review yet, and don't count as a "real" price
    // the way a submitted listing's starting price does.
    if (!isDraft) {
      if (rate) {
        await sql`INSERT INTO price_history (listing_id, nightly_rate) VALUES (${listing.id}, ${rate})`;
      }
      // Best-effort — a failed notification email shouldn't fail the whole submission.
      try {
        await sendAdminNotification(listing);
      } catch (emailErr) {
        console.error('Admin notification email failed:', emailErr);
      }
    }

    return res.status(200).json({ success: true, id: listing.id, isDraft: !!isDraft });
  } catch (err) {
    console.error('submit-listing error:', err);
    return res.status(500).json({ error: 'Could not save listing' });
  }
};
