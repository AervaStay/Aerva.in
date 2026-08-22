// /api/submit-listing.js
// Saves a property submission into Neon, logs its starting price into
// price_history, and emails the admin a notification with one-click
// Approve / Reject links (see approve-listing.js and _approval-token.js).
//
// Photos still go to your inbox separately via Formspree (see aerva.html) —
// this only handles the structured/text fields.

const { neon } = require('@neondatabase/serverless');
const { createToken } = require('./_approval-token');

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

  const photos = Array.isArray(listing.photo_urls) ? listing.photo_urls : [];
  const photoThumbnails = photos.length
    ? `<div style="margin:12px 0; display:flex; gap:6px;">${photos.slice(0, 5).map(url =>
        `<img src="${url}" width="90" height="90" style="object-fit:cover; border-radius:4px;">`
      ).join('')}</div>`
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      propertyName, city, propertyType, bedrooms, maxGuests, nightlyRate,
      description, amenities, services, hostName, hostEmail, hostPhone,
      discountType, discountValue, discountMinNights, discountDescription,
      photoUrls
    } = req.body;

    if (!propertyName || !city || !description || !hostName || !hostEmail || !hostPhone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const rate = nightlyRate ? Number(nightlyRate) : null;
    // Only accept strings that look like real Blob URLs — defensive against
    // a tampered request trying to inject arbitrary content here.
    const safePhotoUrls = Array.isArray(photoUrls)
      ? photoUrls.filter(url => typeof url === 'string' && url.startsWith('https://')).slice(0, 5)
      : [];

    const inserted = await sql`
      INSERT INTO listings (
        property_name, city, property_type, bedrooms, max_guests, nightly_rate,
        description, amenities, services, host_name, host_email, host_phone,
        discount_type, discount_value, discount_min_nights, discount_description,
        commission_rate, photo_urls
      ) VALUES (
        ${propertyName}, ${city}, ${propertyType || null}, ${bedrooms || null},
        ${maxGuests || null}, ${rate},
        ${description}, ${JSON.stringify(amenities || [])}, ${JSON.stringify(services || [])},
        ${hostName}, ${hostEmail}, ${hostPhone},
        ${discountType || null}, ${discountValue ? Number(discountValue) : null},
        ${discountMinNights ? Number(discountMinNights) : null}, ${discountDescription || null},
        ${DEFAULT_COMMISSION_RATE}, ${JSON.stringify(safePhotoUrls)}
      )
      RETURNING *
    `;

    const listing = inserted[0];

    if (rate) {
      await sql`INSERT INTO price_history (listing_id, nightly_rate) VALUES (${listing.id}, ${rate})`;
    }

    // Best-effort — a failed notification email shouldn't fail the whole submission.
    try {
      await sendAdminNotification(listing);
    } catch (emailErr) {
      console.error('Admin notification email failed:', emailErr);
    }

    return res.status(200).json({ success: true, id: listing.id });
  } catch (err) {
    console.error('submit-listing error:', err);
    return res.status(500).json({ error: 'Could not save listing' });
  }
};
