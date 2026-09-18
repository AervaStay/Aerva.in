// /api/verify-payment.js
// Confirms a payment is genuine before you treat a booking as paid.
// Razorpay signs every successful payment with your Key Secret — this function
// re-computes that signature server-side and checks it matches what the browser sent.
// Never trust a "payment succeeded" message from the browser alone.
//
// Once verified, this also writes one row per stay AND one row per
// Aerva Experience booking into the `orders` table (order_type = 'stay'
// or 'experience') — pulling the trusted stay/experience/email/guest
// details back from Razorpay's own order record (via order.notes), not
// from anything the browser sends here, so a tampered request can't fake
// what got booked or at what price. An experience row reuses the same
// columns a stay does (arrival = departure = the experience's date,
// nights = 1) rather than needing its own table.
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

const { verifyRazorpaySignature } = require('./_razorpay-verify');
const Razorpay = require('razorpay');
const { neon } = require('@neondatabase/serverless');
const PDFDocument = require('pdfkit');
const { logAudit } = require('./_audit-log');
const { sendBookingConfirmedTemplates } = require('./_template-scheduling');

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

// Builds a simple, single-page-per-item PDF summarizing everything in
// this booking — generated fresh from the SAME trusted stays/experiences
// data pulled from Razorpay's order notes above, never from anything the
// browser sends, same reasoning as the DB inserts below. Returns a
// Buffer (pdfkit streams to memory here, never touches disk — this is a
// serverless function with no persistent filesystem to write to).
function generateBookingConfirmationPdf(stays, experiences, razorpayOrderId, chargeCurrency, couponDiscount = 0){
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fmt = (n) => `Rs. ${Number(n).toLocaleString('en-IN')}`;
    const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    doc.fontSize(22).font('Helvetica-Bold').text('Aerva', { align: 'center' });
    doc.fontSize(11).font('Helvetica').fillColor('#8a6c39').text('Booking Confirmation', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor('#888').text(`Reference: ${razorpayOrderId}`, { align: 'center' });
    doc.moveDown(2);
    doc.fillColor('#000');

    // Totals by kind, so the summary at the bottom adds up to what the
    // guest was actually charged. (It used to total the booking amounts
    // only, leaving out the service fee, deposit and any coupon.)
    let sumSubtotal = 0, sumGst = 0, sumFee = 0, sumDeposit = 0;
    const gstLine = (item) => {
      const g = Math.max(0, Math.round(Number(item.gst) || 0));
      if (g > 0) doc.font('Helvetica').text(`GST${item.gstRate ? ` (${item.gstRate}%)` : ''}: ${fmt(g)}`);
      return g;
    };

    stays.forEach((s) => {
      doc.fontSize(15).font('Helvetica-Bold').text(s.suite);
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').fillColor('#333');
      doc.text(`Check-in: ${fmtDate(s.arrival)}`);
      doc.text(`Check-out: ${fmtDate(s.departure)}`);
      doc.text(`${s.nights} night${s.nights === 1 ? '' : 's'} · ${s.guests} guest${s.guests === 1 ? '' : 's'}`);
      doc.font('Helvetica-Bold').text(`Amount: ${fmt(s.subtotal)}`);
      sumGst += gstLine(s);
      doc.fillColor('#000');
      doc.moveDown(1.2);
      sumSubtotal += Number(s.subtotal) || 0;
      sumFee += Number(s.guestServiceFee) || 0;
      sumDeposit += Number(s.depositAmount) || 0;
    });

    experiences.forEach((ex) => {
      doc.fontSize(15).font('Helvetica-Bold').text(ex.suite);
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').fillColor('#333');
      const isMultiDay = ex.durationDays && ex.durationDays > 1 && ex.endDate;
      if(isMultiDay){
        doc.text(`${fmtDate(ex.date)} to ${fmtDate(new Date(new Date(ex.endDate).getTime() - 86400000))}`);
        doc.text(`${ex.durationDays} days · ${ex.guests} guest${ex.guests === 1 ? '' : 's'}`);
      } else {
        doc.text(`Date: ${fmtDate(ex.date)}`);
        doc.text(`${ex.guests} guest${ex.guests === 1 ? '' : 's'}`);
      }
      doc.font('Helvetica-Bold').text(`Amount: ${fmt(ex.subtotal)}`);
      sumGst += gstLine(ex);
      doc.fillColor('#000');
      doc.moveDown(1.2);
      sumSubtotal += Number(ex.subtotal) || 0;
      sumFee += Number(ex.guestServiceFee) || 0;
    });

    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd0bc').stroke();
    doc.moveDown(0.8);
    const row = (label, amount) => doc.fontSize(10.5).font('Helvetica').text(`${label}: ${amount}`, { align: 'right' });
    const coupon = Math.max(0, Math.round(Number(couponDiscount) || 0));
    const beforeCoupon = sumSubtotal + sumGst + sumFee + sumDeposit;
    const paid = Math.max(0, beforeCoupon - coupon);
    row('Bookings', fmt(sumSubtotal));
    if (sumGst > 0) row('GST', fmt(sumGst));
    if (sumFee > 0) row('Guest service fee', fmt(sumFee));
    if (sumDeposit > 0) row('Refundable deposit', fmt(sumDeposit));
    if (coupon > 0) row('Coupon', '- ' + fmt(coupon));
    doc.moveDown(0.3);
    doc.fontSize(13).font('Helvetica-Bold').text(`Total paid: ${fmt(paid)}${chargeCurrency && chargeCurrency !== 'INR' ? ' (charged in ' + chargeCurrency + ')' : ''}`, { align: 'right' });
    // Aerva's GST registration, once set in Vercel. Until then it is left
    // off rather than printed as a placeholder.
    if (process.env.AERVA_GSTIN) {
      doc.moveDown(0.5);
      doc.fontSize(9).font('Helvetica').fillColor('#555').text(`GSTIN: ${process.env.AERVA_GSTIN}`, { align: 'right' });
      doc.fillColor('#000');
    }

    doc.moveDown(3);
    doc.fontSize(9).font('Helvetica').fillColor('#888').text('Thank you for booking with Aerva. For any questions, contact hello@aerva.in.', { align: 'center' });

    doc.end();
  });
}

// Same Resend pattern used everywhere else on the site (see guest-auth.js)
// — attachments are just base64-encoded content plus a filename, no
// special handling needed beyond what fetch/JSON already do.
async function sendBookingConfirmationEmail(email, stays, experiences, pdfBuffer){
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set — booking confirmation email not sent.');
    return;
  }
  const itemNames = [...stays.map(s => s.suite), ...experiences.map(e => e.suite)];
  const itemsListHtml = itemNames.map(name => `<li>${name}</li>`).join('');

  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">Your booking is confirmed</h2>
      <p>Thank you for booking with Aerva:</p>
      <ul>${itemsListHtml}</ul>
      <p>Your full booking details — dates, amounts, and everything else — are attached as a PDF to this email.</p>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">Questions? Reply to this email or write to hello@aerva.in.</p>
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
      to: email,
      subject: 'Your Aerva Booking Confirmation',
      html,
      attachments: [
        { filename: 'aerva-booking-confirmation.pdf', content: pdfBuffer.toString('base64') }
      ]
    })
  });

  if (!res.ok) {
    let detail;
    try { detail = await res.json(); } catch { detail = { message: res.statusText }; }
    console.error('Booking confirmation email failed:', res.status, detail);
  }
}

// Idempotency for verify-payment: see the comment where it is called.
// payment_confirmations (migration_payment_confirmations.sql) holds one
// row per Razorpay order that has been recorded; its primary key is what
// makes the claim atomic. Until that migration has run, falls back to
// looking for an existing booking — enough for retries arriving a moment
// apart, though not for two requests in the same instant.
async function claimPaymentConfirmation(razorpayOrderId) {
  try {
    const rows = await sql`
      INSERT INTO payment_confirmations (razorpay_order_id)
      VALUES (${razorpayOrderId})
      ON CONFLICT (razorpay_order_id) DO NOTHING
      RETURNING razorpay_order_id
    `;
    return rows.length ? 'claimed' : 'duplicate';
  } catch (err) {
    console.error('payment_confirmations unavailable, falling back to an orders lookup:', err.message);
    try {
      const existing = await sql`SELECT 1 FROM orders WHERE razorpay_order_id = ${razorpayOrderId} LIMIT 1`;
      return existing.length ? 'duplicate' : 'unclaimed';
    } catch (lookupErr) {
      console.error('verify-payment duplicate check failed:', lookupErr);
      return 'unclaimed';
    }
  }
}

async function releasePaymentConfirmation(razorpayOrderId) {
  try {
    await sql`DELETE FROM payment_confirmations WHERE razorpay_order_id = ${razorpayOrderId}`;
  } catch (err) {
    console.error('releasePaymentConfirmation failed:', err);
  }
}

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

    const isValid = verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);

    if (!isValid) {
      // Someone sent a forged/tampered response — do not confirm the booking.
      return res.status(400).json({ verified: false });
    }

    // One payment, one booking. Retries happen for ordinary reasons — a
    // double tap, a flaky connection re-sending, Razorpay's handler firing
    // twice — and each used to insert the whole booking again: a second
    // order row, a second confirmation email, a second host payout, and a
    // second deposit that could later be refunded twice. The claim below
    // is atomic, so only the first request records the booking; the rest
    // get the same success answer without touching anything.
    const claim = await claimPaymentConfirmation(razorpay_order_id);
    if (claim === 'duplicate') {
      return res.status(200).json({ verified: true, alreadyConfirmed: true });
    }
    let insertedCount = 0;

    // Declared OUT HERE because the PDF/email step below runs after the
    // database block has closed. They used to be `const` inside it, so
    // that step threw "email is not defined" on every successful payment:
    // the booking was saved, but the guest was told verification failed
    // and never got their confirmation.
    let email = null;
    let stays = [];
    let experiences = [];
    let chargeCurrency = 'INR';
    let couponDiscount = 0;

    // Payment is genuine. Pull the trusted stay details back from Razorpay's
    // own order record — this is what create-order.js stored in `notes`
    // when the order was created, server-side, before any payment happened.
    try {
      const order = await razorpay.orders.fetch(razorpay_order_id);
      email = order.notes?.email || null;
      // Only set if the guest was logged in at the time of booking (see
      // create-order.js) — empty string means guest checkout, no account
      // to link. Coerced to a real integer or null, never trusting the
      // string itself as-is going into a numeric column.
      const guestIdRaw = order.notes?.guestId;
      const guestId = guestIdRaw ? parseInt(guestIdRaw, 10) : null;
      stays = order.notes?.stays ? JSON.parse(order.notes.stays) : [];
      experiences = order.notes?.experiences ? JSON.parse(order.notes.experiences) : [];
      // What the guest was ACTUALLY charged in — trusted because it comes
      // from Razorpay's own order record, not anything the browser sent
      // here. 'INR' with no amount is the default/only case until
      // International Payments is enabled (see create-order.js).
      chargeCurrency = order.notes?.chargeCurrency || 'INR';
      const chargeAmount = order.notes?.chargeAmount ? Number(order.notes.chargeAmount) : null;
      // Applied at checkout — see create-order.js's coupon validation.
      // Attributed to whichever order row is created FIRST below (a
      // checkout-level discount, not a per-stay one), so it isn't
      // double-counted across multiple stays/experiences in one payment.
      const couponId = order.notes?.couponId ? Number(order.notes.couponId) : null;
      couponDiscount = order.notes?.couponDiscount ? Number(order.notes.couponDiscount) : 0;
      let couponAttributed = false;

      // GST is stored per item by create-order.js (each stay has its own
      // rate). It used to be reconstructed here as "whatever is left of
      // the payment", which went NEGATIVE whenever a coupon was used: the
      // order row stored negative GST and the host's payout fell by the
      // coupon amount, although the host had already paid for that coupon.
      // Orders created before this change carry no gst field and were
      // charged 0% GST, so 0 is also the correct fallback.
      const itemGst = (item) => Math.max(0, Math.round(Number(item && item.gst) || 0));

      for (const stay of stays) {
        const guestServiceFee = Number(stay.guestServiceFee) || 0;
        const depositAmount = Number(stay.depositAmount) || 0;
        const gstShare = itemGst(stay);

        // The amount commission and payout are based on. It EXCLUDES:
        //   - GST: Aerva collects it and pays it to the government;
        //   - guestServiceFee: Aerva's guest-side revenue;
        //   - depositAmount: held, not earned, by anyone.
        const hostRelevantTotal = stay.subtotal;
        // What the guest was charged for this stay: GST, guest fee and
        // deposit included (a coupon, if any, is recorded separately).
        const stayTotal = stay.subtotal + gstShare + guestServiceFee + depositAmount;

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

        const thisRowCouponId = (couponId && !couponAttributed) ? couponId : null;
        const thisRowCouponDiscount = (couponId && !couponAttributed) ? couponDiscount : 0;
        if (couponId && !couponAttributed) couponAttributed = true;

        const inserted = await sql`
          INSERT INTO orders (
            suite_name, listing_id, room_id, guest_id, guest_email, arrival, departure, guests, nights,
            subtotal, discount_amount, gst, guest_service_fee, total,
            commission_rate, commission_amount, payout_amount,
            deposit_amount, deposit_status, deposit_release_at,
            charge_currency, charge_amount, coupon_id, coupon_discount,
            razorpay_order_id, razorpay_payment_id, status, order_type, pet_types
          ) VALUES (
            ${stay.suite}, ${stay.listingId || null}, ${stay.roomId || null}, ${guestId}, ${email}, ${stay.arrival}, ${stay.departure}, ${stay.guests}, ${stay.nights},
            ${stay.subtotal}, ${stay.discountAmount || 0}, ${gstShare}, ${guestServiceFee}, ${stayTotal},
            ${effectiveRate}, ${commissionAmount}, ${payoutAmount},
            ${depositAmount}, ${depositStatus}, ${depositReleaseAt},
            ${chargeCurrency}, ${chargeAmount}, ${thisRowCouponId}, ${thisRowCouponDiscount},
            ${razorpay_order_id}, ${razorpay_payment_id}, 'paid', 'stay', ${JSON.stringify(Array.isArray(stay.petTypes) ? stay.petTypes : [])}
          )
          RETURNING id
        `;
        insertedCount++;

        if (thisRowCouponId) {
          await sql`UPDATE coupons SET status = 'redeemed', redeemed_order_id = ${inserted[0].id}, redeemed_at = now() WHERE id = ${thisRowCouponId}`;
        }
        const newOrderId = inserted[0].id;

        // "What they actually booked" — logged here, not at order
        // creation in create-order.js, since that's just the Razorpay
        // order being created (the guest could still abandon payment).
        // This is the real, paid, confirmed booking.
        await logAudit(sql, {
          action: 'booking_confirmed', success: true, actorType: 'guest', actorIdentifier: email || null,
          targetType: 'order', targetId: newOrderId,
          metadata: {
            listingId: stay.listingId || null, roomId: stay.roomId || null, suiteName: stay.suite, arrival: stay.arrival, departure: stay.departure,
            guests: stay.guests, nights: stay.nights, total: stayTotal, razorpayOrderId: razorpay_order_id
          }
        });

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

        // The "guest confirmed a booking" trigger for host message
        // templates and the auto-sent check-in instructions. Placed here,
        // at the very end of the iteration, so the order row and its
        // amenities are fully written before any message referencing them
        // is generated.
        //
        // This call is what _template-scheduling.js was written for and
        // has always documented itself as having — it was never actually
        // wired up, so until now a host could tick "send on booking
        // confirmed" on a template, or enable auto-send check-in
        // instructions on a listing, and nothing would ever be sent.
        //
        // Stays only: the module resolves listing check-in/WiFi/access
        // fields that experiences don't have. It never throws (same
        // principle as logAudit above) so a template problem can't break
        // a payment that has genuinely succeeded.
        await sendBookingConfirmedTemplates(sql, {
          id: newOrderId,
          listing_id: stay.listingId || null,
          guest_id: guestId,
          guest_email: email
        });
      }

      // Experience bookings — arrival/departure and nights now reflect
      // the real span of a multi-day experience (a 3-day trek, etc.),
      // computed by create-order.js from the host's set duration, not
      // hardcoded to a single day anymore — every existing query reading
      // arrival/departure/nights still works unchanged either way.
      for (const ex of experiences) {
        const guestServiceFee = Number(ex.guestServiceFee) || 0;
        const gstShare = itemGst(ex);
        // Same rule as stays: GST is Aerva's to pay over, never the host's.
        const hostRelevantTotal = ex.subtotal;
        const total = ex.subtotal + gstShare + guestServiceFee;
        const commissionAmount = Number(ex.commissionAmount) || 0;
        const effectiveRate = ex.commissionRate != null ? Number(ex.commissionRate) : FALLBACK_COMMISSION_RATE;
        const payoutAmount = hostRelevantTotal - commissionAmount;

        const thisRowCouponId = (couponId && !couponAttributed) ? couponId : null;
        const thisRowCouponDiscount = (couponId && !couponAttributed) ? couponDiscount : 0;
        if (couponId && !couponAttributed) couponAttributed = true;

        const insertedEx = await sql`
          INSERT INTO orders (
            suite_name, listing_id, guest_id, guest_email, arrival, departure, guests, nights,
            subtotal, discount_amount, gst, guest_service_fee, total,
            commission_rate, commission_amount, payout_amount,
            deposit_amount, deposit_status, deposit_release_at,
            charge_currency, charge_amount, coupon_id, coupon_discount,
            razorpay_order_id, razorpay_payment_id, status, order_type
          ) VALUES (
            ${ex.suite}, ${ex.listingId || null}, ${guestId}, ${email}, ${ex.date}, ${ex.endDate || ex.date}, ${ex.guests}, ${ex.durationDays || 1},
            ${ex.subtotal}, 0, ${gstShare}, ${guestServiceFee}, ${total},
            ${effectiveRate}, ${commissionAmount}, ${payoutAmount},
            0, 'none', null,
            ${chargeCurrency}, ${chargeAmount}, ${thisRowCouponId}, ${thisRowCouponDiscount},
            ${razorpay_order_id}, ${razorpay_payment_id}, 'paid', 'experience'
          )
          RETURNING id
        `;
        insertedCount++;

        if (thisRowCouponId) {
          await sql`UPDATE coupons SET status = 'redeemed', redeemed_order_id = ${insertedEx[0].id}, redeemed_at = now() WHERE id = ${thisRowCouponId}`;
        }
        await logAudit(sql, {
          action: 'booking_confirmed', success: true, actorType: 'guest', actorIdentifier: email || null,
          targetType: 'order', targetId: insertedEx[0].id,
          metadata: {
            listingId: ex.listingId || null, suiteName: ex.suite, date: ex.date, endDate: ex.endDate || ex.date,
            guests: ex.guests, durationDays: ex.durationDays || 1, total, razorpayOrderId: razorpay_order_id, isExperience: true
          }
        });
      }
    } catch (dbErr) {
      // A booking that's paid-for but not logged to `orders` is recoverable
      // (the payment itself is safely recorded in Razorpay's own dashboard).
      // Don't fail the guest's confirmation over a logging problem.
      console.error('Could not write order(s) to database:', dbErr);
      // Nothing was recorded, so let a retry try again rather than
      // being turned away as a duplicate. If some rows DID go in, the
      // claim stays: a retry would duplicate those, and the rest are
      // recoverable from Razorpay's record of the order.
      if (claim === 'claimed' && insertedCount === 0) {
        await releasePaymentConfirmation(razorpay_order_id);
      } else if (insertedCount > 0) {
        console.error(`verify-payment: order ${razorpay_order_id} partly recorded (${insertedCount} row(s)) — finish by hand.`);
      }
    }

    // PDF + email confirmation — deliberately its own try/catch, separate
    // from the DB insert above. A guest's booking is already confirmed
    // and paid for by this point; a failed email should never turn that
    // into an error response. Skipped entirely if there's no email on
    // file at all (shouldn't happen in practice — create-order.js
    // requires one — but this is defensive either way).
    if (email) {
      try {
        const pdfBuffer = await generateBookingConfirmationPdf(stays, experiences, razorpay_order_id, chargeCurrency, couponDiscount);
        await sendBookingConfirmationEmail(email, stays, experiences, pdfBuffer);
      } catch (emailErr) {
        console.error('Could not send booking confirmation email:', emailErr);
      }
    }

    return res.status(200).json({ verified: true });
  } catch (err) {
    console.error('verify-payment error:', err);
    return res.status(500).json({ error: 'Verification failed' });
  }
};
