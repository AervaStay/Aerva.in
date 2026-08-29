// /api/verify-payment.js
// Confirms a payment is genuine before you treat a booking as paid.
// Razorpay signs every successful payment with your Key Secret — this function
// re-computes that signature server-side and checks it matches what the browser sent.
// Never trust a "payment succeeded" message from the browser alone.
//
// Once verified, this also writes one row per stay into the `orders` table —
// pulling the trusted stay/email/guest details back from Razorpay's own order
// record (via order.notes), not from anything the browser sends here, so a
// tampered request can't fake what got booked or at what price.
//
// Security deposit lifecycle (see orders.deposit_status):
//   'held'     — set here, the moment payment is confirmed, if the stay's
//                listing has a security_deposit. deposit_release_at is set
//                to 7 days after the stay's departure date.
//   'disputed' — set by host-listings.js's raiseDispute mode if the host
//                flags a concern before deposit_release_at.
//   'refunded' — set by get-pending-listings.js's processDeposits mode
//                (admin-triggered), which finds every 'held' deposit past
//                its release date with no dispute and refunds it in full
//                to the guest's original payment method via Razorpay.
//   'resolved' — set by get-pending-listings.js's resolveDispute mode
//                once an admin decides how much of a disputed deposit to
//                pay the host vs. refund the guest.

const crypto = require('crypto');
const Razorpay = require('razorpay');
const { neon } = require('@neondatabase/serverless');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
const sql = neon(process.env.DATABASE_URL);

// Fixed platform commission rates, matching create-order.js exactly — see
// that file for the reasoning. Kept here only as a fallback for orders
// placed before this split existed (where stay.baseCommission /
// amenityCommission won't be present in the stored notes).
const FALLBACK_COMMISSION_RATE = 15;

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    const isValid = expectedSignature === razorpay_signature;

    if (!isValid) {
      // Someone sent a forged/tampered response — do not confirm the booking.
      return res.status(400).json({ verified: false });
    }

    // Payment is genuine. Pull the trusted stay details back from Razorpay's
    // own order record — this is what create-order.js stored in `notes`
    // when the order was created, server-side, before any payment happened.
    try {
      const order = await razorpay.orders.fetch(razorpay_order_id);
      const email = order.notes?.email;
      // Only set if the guest was logged in at the time of booking (see
      // create-order.js) — empty string means guest checkout, no account
      // to link. Coerced to a real integer or null, never trusting the
      // string itself as-is going into a numeric column.
      const guestIdRaw = order.notes?.guestId;
      const guestId = guestIdRaw ? parseInt(guestIdRaw, 10) : null;
      const stays = order.notes?.stays ? JSON.parse(order.notes.stays) : [];

      const totalSubtotalAllStays = stays.reduce((sum, s) => sum + s.subtotal, 0);
      const totalGuestFeeAllStays = stays.reduce((sum, s) => sum + (Number(s.guestServiceFee) || 0), 0);
      // The deposit total also has to be subtracted out here — order.amount
      // now includes it too (see create-order.js), and without this the
      // whole deposit would get miscounted as GST below.
      const totalDepositAllStays = stays.reduce((sum, s) => sum + (Number(s.depositAmount) || 0), 0);

      for (const stay of stays) {
        const guestServiceFee = Number(stay.guestServiceFee) || 0;
        const depositAmount = Number(stay.depositAmount) || 0;
        // GST share, with the guest fee and deposit subtracted out first —
        // otherwise either would get miscounted as part of GST, since all
        // three are now folded into order.amount alongside the room/amenity
        // subtotals.
        const gstShare = Math.round((stay.subtotal / totalSubtotalAllStays) *
          (order.amount / 100 - totalSubtotalAllStays - totalGuestFeeAllStays - totalDepositAllStays));

        // This is the amount commission/payout are based on — deliberately
        // EXCLUDING guestServiceFee and depositAmount, since neither is
        // Aerva or host revenue: the guest fee is Aerva's guest-side
        // revenue only, and the deposit is held, not earned, by anyone.
        const hostRelevantTotal = stay.subtotal + gstShare;
        // What the guest actually paid for this stay, guest fee and
        // deposit included.
        const stayTotal = hostRelevantTotal + guestServiceFee + depositAmount;

        // Prefer the new split commission (base booking vs. amenities,
        // computed server-side in create-order.js). Falls back to the old
        // single blended rate only for orders placed before this existed.
        let commissionAmount, effectiveRate;
        if (stay.baseCommission != null && stay.amenityCommission != null) {
          commissionAmount = Number(stay.baseCommission) + Number(stay.amenityCommission);
          effectiveRate = hostRelevantTotal > 0 ? Number(((commissionAmount / hostRelevantTotal) * 100).toFixed(2)) : 0;
        } else {
          effectiveRate = stay.commissionRate != null ? Number(stay.commissionRate) : FALLBACK_COMMISSION_RATE;
          commissionAmount = Math.round(hostRelevantTotal * (effectiveRate / 100));
        }
        const payoutAmount = hostRelevantTotal - commissionAmount;

        // Deposit lifecycle starts here: held with Aerva until 7 days
        // after checkout, unless the host raises a concern first (see
        // host-listings.js's raiseDispute mode) or there's simply no
        // deposit on this listing at all.
        const DEPOSIT_HOLD_DAYS = 7;
        let depositStatus = 'none';
        let depositReleaseAt = null;
        if (depositAmount > 0) {
          depositStatus = 'held';
          const releaseDate = new Date(stay.departure + 'T00:00:00Z');
          releaseDate.setUTCDate(releaseDate.getUTCDate() + DEPOSIT_HOLD_DAYS);
          depositReleaseAt = releaseDate.toISOString().split('T')[0];
        }

        const inserted = await sql`
          INSERT INTO orders (
            suite_name, listing_id, guest_id, guest_email, arrival, departure, guests, nights,
            subtotal, discount_amount, gst, guest_service_fee, total,
            commission_rate, commission_amount, payout_amount,
            deposit_amount, deposit_status, deposit_release_at,
            razorpay_order_id, razorpay_payment_id, status
          ) VALUES (
            ${stay.suite}, ${stay.listingId || null}, ${guestId}, ${email}, ${stay.arrival}, ${stay.departure}, ${stay.guests}, ${stay.nights},
            ${stay.subtotal}, ${stay.discountAmount || 0}, ${gstShare}, ${guestServiceFee}, ${stayTotal},
            ${effectiveRate}, ${commissionAmount}, ${payoutAmount},
            ${depositAmount}, ${depositStatus}, ${depositReleaseAt},
            ${razorpay_order_id}, ${razorpay_payment_id}, 'paid'
          )
          RETURNING id
        `;
        const newOrderId = inserted[0].id;

        // Persist which paid amenities (and specific nights) were part of
        // this stay — already validated and priced server-side back in
        // create-order.js, so this is just recording what was genuinely
        // paid for, not re-trusting anything from the browser.
        const amenities = Array.isArray(stay.amenities) ? stay.amenities : [];
        for (const a of amenities) {
          await sql`
            INSERT INTO order_amenities (order_id, listing_amenity_id, name, price_per_night, selected_dates, total_price)
            VALUES (${newOrderId}, ${a.id || null}, ${a.name}, ${a.pricePerNight}, ${JSON.stringify(a.dates)}, ${a.total})
          `;
        }
      }
    } catch (dbErr) {
      // A booking that's paid-for but not logged to `orders` is recoverable
      // (the payment itself is safely recorded in Razorpay's own dashboard).
      // Don't fail the guest's confirmation over a logging problem.
      console.error('Could not write order(s) to database:', dbErr);
    }

    return res.status(200).json({ verified: true });
  } catch (err) {
    console.error('verify-payment error:', err);
    return res.status(500).json({ error: 'Verification failed' });
  }
};
