// /api/guest-profile.js
// Everything a logged-in guest's profile page needs, in one call, plus the
// ability to update their own name and profile photo.
//
//   GET  (Authorization: Bearer <guestSessionToken>)
//     Returns { guest, bookings, reviews }. "guest" includes a computed
//     "badge" field derived from guest_reviews — see computeBadge() below.
//
//   PATCH { name?, profilePhotoUrl? } (Authorization: Bearer <token>)
//     Updates only the fields provided. The photo itself is uploaded
//     directly to Vercel Blob from the browser first (see blob-upload.js,
//     same endpoint listing photos already use) — this call just saves
//     the resulting URL against the guest's account.

const { neon } = require('@neondatabase/serverless');
const { verifyToken } = require('./_approval-token');
const { logAudit } = require('./_audit-log');

const sql = neon(process.env.DATABASE_URL);

// Badge tiers, computed fresh from guest_reviews on every profile load —
// not stored, so it's always accurate as new reviews come in. Deliberately
// not called "Superhost" (that's Airbnb's term) — this is Aerva's own
// guest-reputation ladder.
function computeBadge(reviewCount, avgRating) {
  if (reviewCount >= 5 && avgRating >= 4.8) return 'Aerva Favorite';
  if (reviewCount >= 3 && avgRating >= 4.5) return 'Trusted Guest';
  if (reviewCount >= 1 && avgRating >= 4.0) return 'Valued Guest';
  return null; // not enough of a track record yet — profile just shows no badge
}

function requireGuest(req) {
  const authHeader = req.headers['authorization'] || '';
  const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = sessionToken ? verifyToken(sessionToken) : null;
  if (!payload || payload.action !== 'guest-session') return null;
  return payload.listingId; // generically-named token field — see host-auth.js note; here it's the guest's id
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const guestId = requireGuest(req);
  if (!guestId) return res.status(401).json({ error: 'Please log in again.' });

  // ---- Fetch the full profile bundle ----
  if (req.method === 'GET') {
    try {
      const guestRows = await sql`
        SELECT id, email, phone, name, profile_photo_url, created_at
        FROM guests WHERE id = ${guestId}
      `;
      const guest = guestRows[0];
      if (!guest) return res.status(404).json({ error: 'Account not found.' });

      // Payment/booking history — every completed booking tied to this
      // account. subtotal/discount/gst/total double as the "payment info"
      // the profile shows; there's no separate payment-methods table since
      // Razorpay handles card/UPI details on their end, never ours.
      const bookings = await sql`
        SELECT id, suite_name, listing_id, arrival, departure, guests, nights,
               subtotal, discount_amount, gst, total, status, created_at
        FROM orders
        WHERE guest_id = ${guestId}
        ORDER BY created_at DESC
      `;

      const reviews = await sql`
        SELECT rating, comment, created_at FROM guest_reviews
        WHERE guest_id = ${guestId}
        ORDER BY created_at DESC
      `;

      const reviewCount = reviews.length;
      const avgRating = reviewCount
        ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviewCount
        : 0;

      return res.status(200).json({
        guest: {
          id: guest.id,
          email: guest.email,
          phone: guest.phone,
          name: guest.name,
          profilePhotoUrl: guest.profile_photo_url,
          memberSince: guest.created_at,
          badge: computeBadge(reviewCount, avgRating),
          reviewCount,
          avgRating: reviewCount ? Number(avgRating.toFixed(2)) : null
        },
        bookings,
        reviews
      });
    } catch (err) {
      console.error('guest-profile (GET) error:', err);
      return res.status(500).json({ error: 'Could not load your profile.' });
    }
  }

  // ---- Update name and/or profile photo ----
  if (req.method === 'PATCH') {
    try {
      const { name, profilePhotoUrl } = req.body || {};

      // Only accept real Blob URLs for the photo, same defensive check
      // used for listing photos in submit-listing.js — never trust an
      // arbitrary URL string into this column.
      const safePhotoUrl = typeof profilePhotoUrl === 'string' && profilePhotoUrl.startsWith('https://')
        ? profilePhotoUrl
        : undefined;
      const safeName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : undefined;

      if (safeName === undefined && safePhotoUrl === undefined) {
        return res.status(400).json({ error: 'Nothing to update.' });
      }

      const updated = await sql`
        UPDATE guests SET
          name = COALESCE(${safeName ?? null}, name),
          profile_photo_url = COALESCE(${safePhotoUrl ?? null}, profile_photo_url)
        WHERE id = ${guestId}
        RETURNING id, name, profile_photo_url
      `;

      await logAudit(sql, {
        action: 'guest_profile_updated', success: true, actorType: 'guest', actorIdentifier: String(guestId),
        targetType: 'guest', targetId: guestId,
        metadata: { updatedName: safeName !== undefined, updatedPhoto: safePhotoUrl !== undefined }
      });

      return res.status(200).json({ success: true, guest: updated[0] });
    } catch (err) {
      console.error('guest-profile (PATCH) error:', err);
      await logAudit(sql, {
        action: 'guest_profile_updated', success: false, actorType: 'guest', actorIdentifier: String(guestId),
        metadata: { reason: 'server_error' }
      });
      return res.status(500).json({ error: 'Could not save your changes right now.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
