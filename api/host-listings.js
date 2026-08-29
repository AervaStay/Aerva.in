// /api/host-listings.js
// Returns every listing belonging to the logged-in guest's linked host
// account — pending, approved, and rejected, so the dashboard can show
// real status, not just what's live to guests. Requires a valid
// guest-session token (the single login used across the whole site — see
// guest-auth.js / guest-phone-auth.js), sent as:
//   Authorization: Bearer <sessionToken>
//
// A guest who hasn't listed a property yet simply has no linked host
// account (guests.host_id is null) — that's not an error, it just means
// an empty list, same as a brand-new account.
//
//   GET  — as above, now also returns `verification`: the host's
//          Aadhaar/bank verification status, and each booking now
//          includes its deposit fields (amount, status, release date,
//          any dispute already raised).
//   POST { aadhaarDocumentUrl? , bankAccountNumber?, bankIfsc?,
//          bankAccountHolderName? } — submits (or resubmits) whichever
//          section is included. Locked once a section is 'verified'
//          (contact support to change verified info, rather than letting
//          it be silently overwritten).
//   POST { raiseDispute: { orderId, reason } } — flags a concern on one
//          of this host's bookings' held security deposits, before it
//          would otherwise auto-refund to the guest 7 days after
//          checkout. Only works while deposit_status is still 'held' and
//          the release date hasn't passed. See get-pending-listings.js's
//          resolveDispute mode for how an admin follows up.

const { neon } = require('@neondatabase/serverless');
const { verifyToken, createToken } = require('./_approval-token');
const { logAudit } = require('./_audit-log');

const sql = neon(process.env.DATABASE_URL);
const SITE_BASE = 'https://aerva.in';
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

function requireGuestId(req) {
  const authHeader = req.headers['authorization'] || '';
  const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = sessionToken ? verifyToken(sessionToken) : null;
  if (!payload || payload.action !== 'guest-session') return null;
  return payload.listingId; // generically-named token field — see host-auth.js note
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const guestId = requireGuestId(req);
  if (!guestId) return res.status(401).json({ error: 'Please log in again.' });

  // ---- Raise a concern on a held security deposit ----
  // Separate from the verification-submission branch above — this only
  // ever touches one order's deposit_status, gated on it actually
  // belonging to this host and still being within the 7-day hold.
  if (req.method === 'POST' && req.body && req.body.raiseDispute) {
    try {
      const { orderId, reason } = req.body.raiseDispute;
      if (!orderId || !reason || !String(reason).trim()) {
        return res.status(400).json({ error: 'Please explain the concern before submitting.' });
      }

      const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
      const guest = guestRows[0];
      if (!guest || !guest.host_id) {
        return res.status(403).json({ error: 'You do not have permission to do this.' });
      }

      // Ownership check: the order's listing has to belong to this host —
      // never trust orderId alone, since it's just a number a guest's
      // browser could also send.
      const rows = await sql`
        SELECT o.id, o.deposit_status, o.deposit_release_at
        FROM orders o
        JOIN listings l ON o.listing_id = l.id
        WHERE o.id = ${orderId} AND l.host_id = ${guest.host_id}
      `;
      const order = rows[0];
      if (!order) {
        return res.status(403).json({ error: 'You do not have permission to do this.' });
      }
      if (order.deposit_status !== 'held') {
        return res.status(400).json({ error: 'This deposit is no longer open to a concern — it has already been refunded, disputed, or resolved.' });
      }
      const releaseDate = order.deposit_release_at ? new Date(order.deposit_release_at) : null;
      if (releaseDate && new Date() > releaseDate) {
        return res.status(400).json({ error: 'The 7-day window to raise a concern on this deposit has passed.' });
      }

      await sql`
        UPDATE orders SET deposit_status = 'disputed', dispute_reason = ${String(reason).trim().slice(0, 1000)}, dispute_raised_at = now()
        WHERE id = ${orderId}
      `;
      await logAudit(sql, {
        action: 'deposit_dispute_raised', success: true, actorType: 'host', actorIdentifier: String(guest.host_id),
        targetType: 'order', targetId: orderId
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('host-listings (raiseDispute) error:', err);
      return res.status(500).json({ error: 'Could not submit your concern right now. Please try again.' });
    }
  }

  // ---- Submit or resubmit verification info ----
  if (req.method === 'POST') {
    try {
      const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
      const guest = guestRows[0];
      if (!guest || !guest.host_id) {
        return res.status(400).json({ error: 'List a property first to create your host account.' });
      }

      const { aadhaarDocumentUrl, bankAccountNumber, bankIfsc, bankAccountHolderName } = req.body || {};
      const current = await sql`SELECT aadhaar_status, bank_status FROM hosts WHERE id = ${guest.host_id}`;
      const host = current[0];

      if (typeof aadhaarDocumentUrl === 'string' && aadhaarDocumentUrl.startsWith('https://')) {
        if (host.aadhaar_status === 'verified') {
          return res.status(400).json({ error: 'Your Aadhaar is already approved. Contact hello@aerva.in to change it.' });
        }
        await sql`
          UPDATE hosts SET aadhaar_document_url = ${aadhaarDocumentUrl}, aadhaar_status = 'verified', aadhaar_rejection_reason = NULL
          WHERE id = ${guest.host_id}
        `;
        await logAudit(sql, {
          action: 'host_aadhaar_submitted', success: true, actorType: 'host', actorIdentifier: String(guest.host_id),
          targetType: 'host', targetId: guest.host_id
        });
      }

      const hasBankInfo = bankAccountNumber && bankIfsc && bankAccountHolderName;
      if (hasBankInfo) {
        if (host.bank_status === 'verified') {
          return res.status(400).json({ error: 'Your bank details are already approved. Contact hello@aerva.in to change them.' });
        }
        // Basic sanity checks only — real validation happens when an admin
        // (or eventually a bank verification API) actually reviews this.
        const cleanAccountNumber = String(bankAccountNumber).replace(/\s/g, '');
        const cleanIfsc = String(bankIfsc).trim().toUpperCase();
        if (!/^\d{6,20}$/.test(cleanAccountNumber)) {
          return res.status(400).json({ error: 'Please enter a valid bank account number.' });
        }
        if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(cleanIfsc)) {
          return res.status(400).json({ error: 'Please enter a valid IFSC code.' });
        }
        await sql`
          UPDATE hosts SET
            bank_account_number = ${cleanAccountNumber}, bank_ifsc = ${cleanIfsc},
            bank_account_holder_name = ${String(bankAccountHolderName).trim().slice(0, 100)},
            bank_status = 'verified', bank_rejection_reason = NULL
          WHERE id = ${guest.host_id}
        `;
        await logAudit(sql, {
          action: 'host_bank_details_submitted', success: true, actorType: 'host', actorIdentifier: String(guest.host_id),
          targetType: 'host', targetId: guest.host_id
        });
      }

      if (!aadhaarDocumentUrl && !hasBankInfo) {
        return res.status(400).json({ error: 'Nothing to submit.' });
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('host-listings (POST verification) error:', err);
      return res.status(500).json({ error: 'Could not save your verification info right now. Please try again.' });
    }
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const guestRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
    const guest = guestRows[0];
    if (!guest) return res.status(401).json({ error: 'Please log in again.' });

    // Never hosted anything yet — an empty dashboard, not an error.
    if (!guest.host_id) {
      return res.status(200).json({ listings: [], bookings: [], verification: null });
    }

    const listings = await sql`
      SELECT id, property_name, city, property_type, bedrooms, max_guests, nightly_rate, status,
             description, amenities, services, host_name, host_phone,
             discount_type, discount_value, discount_min_nights, discount_description,
             latitude, longitude, formatted_address,
             exterior_photo_urls, interior_photo_urls, cover_photo_url, created_at
      FROM listings
      WHERE host_id = ${guest.host_id}
      ORDER BY created_at DESC
    `;
    // Generate a fresh "manage price" link for each listing on the spot —
    // the host doesn't have to dig up the one-time email from approval time.
    const listingsWithLinks = listings.map(l => ({
      ...l,
      manageLink: `${SITE_BASE}/manage-listing.html?token=${createToken(l.id, 'manage-pricing', TWO_YEARS_MS)}`
    }));

    // "Aerva Host" status — awarded the moment a host has at least one
    // approved listing. Computed here rather than stored anywhere, so it's
    // always accurate the instant a listing's status flips to 'approved'
    // (see approve-listing.js), with nothing to keep in sync.
    const hostBadge = listings.some(l => l.status === 'approved') ? 'Aerva Host' : null;

    // Bookings/earnings for this host's listings — deliberately selects
    // only host-relevant columns. `total` and `guest_service_fee` are
    // NEVER included here on purpose: total includes the guest's own
    // service fee, which is Aerva's guest-side revenue and none of the
    // host's business, exactly as guests never see the host's commission.
    // subtotal + gst here already reflects what the guest paid for the
    // stay itself, before that split — payout_amount is what actually
    // lands with the host after commission.
    const bookings = await sql`
      SELECT o.id, o.suite_name, o.listing_id, o.arrival, o.departure, o.nights,
             o.subtotal, o.discount_amount, o.gst,
             o.commission_rate, o.commission_amount, o.payout_amount,
             o.deposit_amount, o.deposit_status, o.deposit_release_at,
             o.dispute_reason, o.dispute_raised_at, o.deposit_resolution_amount,
             o.status, o.created_at
      FROM orders o
      JOIN listings l ON o.listing_id = l.id
      WHERE l.host_id = ${guest.host_id}
      ORDER BY o.created_at DESC
      LIMIT 100
    `;

    // Verification status for the checklist. Bank account number is
    // masked to its last 4 digits — even the host's own dashboard never
    // re-displays the full number once submitted, so there's one fewer
    // place it exists in full anywhere in the UI.
    const hostRows = await sql`
      SELECT aadhaar_status, aadhaar_rejection_reason,
             bank_status, bank_rejection_reason, bank_account_number, bank_account_holder_name
      FROM hosts WHERE id = ${guest.host_id}
    `;
    const h = hostRows[0];
    const verification = h ? {
      aadhaarStatus: h.aadhaar_status,
      aadhaarRejectionReason: h.aadhaar_rejection_reason,
      bankStatus: h.bank_status,
      bankRejectionReason: h.bank_rejection_reason,
      bankAccountNumberMasked: h.bank_account_number ? '••••' + h.bank_account_number.slice(-4) : null,
      bankAccountHolderName: h.bank_account_holder_name
    } : null;

    return res.status(200).json({ listings: listingsWithLinks, hostBadge, bookings, verification });
  } catch (err) {
    console.error('host-listings error:', err);
    return res.status(500).json({ error: 'Could not load your listings.' });
  }
};
