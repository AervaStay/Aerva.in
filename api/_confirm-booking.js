// /api/_confirm-booking.js — turns a paid Razorpay order into bookings.
// Not an endpoint (leading underscore).
//
// Used in two places, so a paid booking is always recorded exactly once:
//   • verify-payment.js — the browser posts here right after paying;
//   • the payment_reconcile scheduled job (get-listings.js, every 5 min) —
//     for payments whose browser never came back (a UPI app switch that
//     killed the tab, a closed window, a lost connection). The money was
//     taken; without this the booking would never be written.
//
// Before anything is written, it re-checks, from the database as it is NOW:
//   • the dates are still free (another guest may have paid for them while
//     this guest was paying — create-order.js only checked before payment);
//   • the coupon, if one was used, has not been used by another payment
//     (claimed atomically; the first payment to be confirmed keeps it).
// If either fails, the booking is written as CANCELLED with the reason, every
// rupee is refunded through _refunds.js, and the guest is told by email.
//
// One payment, one run: payment_confirmations is claimed atomically first.
// An optional database constraint (migration_no_double_booking.sql) makes a
// double booking impossible even for two payments confirmed in the same
// instant; this file treats that constraint's refusal as a conflict too.

const PDFDocument = require('pdfkit');
const { logAudit } = require('./_audit-log');
const { sendBookingConfirmedTemplates } = require('./_template-scheduling');
const { recordCohostShares } = require('./_cohosts');
const { safeRefund } = require('./_refunds');
const { convertInrToForeignSubunit } = require('./_currency');
const { allocatePaid, releaseHolds, holdValidForConfirmation } = require('./_booking-rules');
const { confirmChangePayment } = require('./_booking-changes');
const { markIdDeadlineIfMissing } = require('./_guest-id');

// Fallback only for orders placed before the split commission existed.
const crypto = require('crypto');
const FALLBACK_COMMISSION_RATE = 15;
const DEPOSIT_HOLD_DAYS = 7;   // a deposit is held for 7 days after departure

// ---- The booking's confirmation code ----
// RANDOM only: eight digits, carrying nothing about the booking, the
// guest, the date or anything else —  48291374.
//
// Never issued twice: every code is claimed in the confirmation_codes
// register before it goes on a booking, so a code cannot come back even
// after a booking is cancelled. A draw that collides is simply redrawn.
//
// Eight digits is one hundred million codes — room for a very long time.
// Draws only begin to collide once a large share is taken, and a collision
// is simply redrawn. Nothing on Aerva looks a booking up by its code, so a
// guessed code opens nothing; if that ever changes, widen the code
// (CODE_LENGTH / CODE_ALPHABET below) before building it.
const CODE_ALPHABET = '0123456789';
const CODE_LENGTH = 8;
function randomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH * 2);
  let out = '';
  // Only values that divide evenly across the alphabet are used, so every
  // digit is equally likely (a plain % would favour the low digits).
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  for (let i = 0; out.length < CODE_LENGTH; i++) {
    const b = i < bytes.length ? bytes[i] : crypto.randomBytes(1)[0];
    if (b < limit) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  }
  return out;
}
// Claims a code that has never been issued. Returns null if the register
// is not there yet (before migration_confirmation_code.sql).
async function issueConfirmationCode(sql, orderId) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const code = randomCode();
    try {
      const got = await sql`INSERT INTO confirmation_codes (code, order_id) VALUES (${code}, ${orderId})
                            ON CONFLICT (code) DO NOTHING RETURNING code`;
      if (got.length) return code;
    } catch (err) {
      console.error('confirmation code register unavailable:', err.message);
      return null;
    }
  }
  // 25 collisions in a row means the code space is filling up.
  console.error('could not claim a confirmation code after 25 tries — consider a longer code (CODE_LENGTH in _confirm-booking.js)');
  return null;
}

// Builds a simple, single-page-per-item PDF summarizing everything in
// this booking — generated fresh from the SAME trusted stays/experiences
// data pulled from Razorpay's order notes above, never from anything the
// browser sends, same reasoning as the DB inserts below. Returns a
// Buffer (pdfkit streams to memory here, never touches disk — this is a
// serverless function with no persistent filesystem to write to).
function generateBookingConfirmationPdf(stays, experiences, razorpayOrderId, chargeCurrency, couponDiscount = 0, confirmationCodes = null){
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
    if (confirmationCodes && confirmationCodes.length) {
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#1c1b19')
        .text(confirmationCodes.length === 1 ? `Confirmation code: ${confirmationCodes[0].code}` : 'Confirmation codes', { align: 'center' });
      if (confirmationCodes.length > 1) {
        doc.fontSize(10).font('Helvetica').fillColor('#444');
        confirmationCodes.forEach(c => doc.text(`${c.item}: ${c.code}`, { align: 'center' }));
      }
      doc.moveDown(0.3);
    }
    doc.fontSize(9).font('Helvetica').fillColor('#888').text(`Reference: ${razorpayOrderId}`, { align: 'center' });
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
// The host's side of a confirmed booking: what was booked, and what the
// host must do. One email per host per payment. Never throws.
async function sendHostBookingEmails(sql, stays, experiences, agreementVersion, confirmationCodes = null) {
  if (!process.env.RESEND_API_KEY) return;
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const items = [
    ...stays.map(s => ({ listingId: s.listingId, name: s.suite, when: `${s.arrival} → ${s.departure}`, guests: s.guests,
                         pets: (s.petTypes || []).length, service: (s.serviceAnimals || []).length })),
    ...experiences.map(e => ({ listingId: e.listingId, name: e.suite, when: e.date, guests: e.guests, pets: 0, service: 0 }))
  ].filter(i => i.listingId);
  if (!items.length) return;
  let rows = [];
  try {
    rows = await sql`SELECT id, host_email FROM listings WHERE id = ANY(${items.map(i => Number(i.listingId))})`;
  } catch (err) { console.error('host booking email lookup failed:', err.message); return; }
  const byHost = {};
  items.forEach(i => {
    const r = rows.find(x => Number(x.id) === Number(i.listingId));
    if (r && r.host_email) (byHost[r.host_email] = byHost[r.host_email] || []).push(i);
  });
  for (const [to, list] of Object.entries(byHost)) {
    try {
      const html = `
        <div style="font-family:sans-serif; max-width:520px;">
          <h2 style="font-family:Georgia,serif;">New confirmed booking</h2>
          <ul>${list.map(i => {
            const code = (confirmationCodes || []).find(c => c.item === i.name);
            return `<li><strong>${esc(i.name)}</strong> — ${esc(i.when)} — ${Number(i.guests) || 0} guest(s)${i.pets ? `, ${i.pets} pet(s)` : ''}${i.service ? `, ${i.service} service/support animal(s)` : ''}${code ? `<br><span style="font-size:13px; color:#6b5222;">Confirmation code: <strong>${esc(code.code)}</strong> — the guest shows this at check-in</span>` : ''}</li>`;
          }).join('')}</ul>
          <p><strong>Your responsibilities for this booking:</strong></p>
          <ul>
            <li>Provide the home or experience as listed, safe and clean.</li>
            <li>Check a government photo ID for every adult guest.</li>
            <li>Foreign guests: file Form III at indianfrro.gov.in within 24 hours of arrival and of departure.</li>
            <li>Share check-in details in Aerva Messages before arrival.</li>
            <li>Keep all communication and payments on Aerva.</li>
          </ul>
          <p style="font-size:13px; opacity:0.8;">This booking is covered by the host agreement you accepted and the guest’s booking agreement${agreementVersion ? ` (version ${esc(agreementVersion)})` : ''}. Read Aerva’s Policies at <a href="https://aerva.in/index.html?view=policies&tab=host">aerva.in/policies</a>.</p>
        </div>`;
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject: 'New confirmed booking on Aerva', html })
      });
    } catch (err) { console.error('host booking email failed:', err.message); }
  }
}

async function sendBookingConfirmationEmail(email, stays, experiences, pdfBuffer, agreementVersion = null, confirmationCodes = null){
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
      ${(confirmationCodes || []).length ? `<div style="background:#f6efe3; border:1px solid #e0cda8; border-radius:10px; padding:14px 16px; margin:14px 0;">
        <p style="margin:0 0 6px; font-size:13px; color:#6b5222;">Your confirmation code${confirmationCodes.length > 1 ? 's' : ''} — show this at check-in:</p>
        ${confirmationCodes.map(c => `<p style="margin:2px 0; font-size:19px; font-weight:600; letter-spacing:0.04em; color:#1c1b19;">${c.code}${confirmationCodes.length > 1 ? ` <span style="font-size:13px; font-weight:400; color:#6b5222;">— ${c.item}</span>` : ''}</p>`).join('')}
      </div>` : ''}
      <p>Your full booking details — dates, amounts, and everything else — are attached as a PDF to this email.</p>
      ${agreementVersion ? `<p style="font-size:13px; opacity:0.8;">You accepted Aerva’s booking agreement (version ${agreementVersion}) before paying. Read it and Aerva’s Policies at <a href="https://aerva.in/index.html?view=policies">aerva.in/policies</a>.</p>` : ''}
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


// ---------------------------------------------------------------------
// Idempotency: one row per Razorpay order in payment_confirmations.
async function claimPaymentConfirmation(sql, razorpayOrderId) {
  try {
    const rows = await sql`
      INSERT INTO payment_confirmations (razorpay_order_id) VALUES (${razorpayOrderId})
      ON CONFLICT (razorpay_order_id) DO NOTHING RETURNING razorpay_order_id
    `;
    return rows.length ? 'claimed' : 'duplicate';
  } catch (err) {
    console.error('payment_confirmations unavailable, falling back to an orders lookup:', err.message);
    try {
      const existing = await sql`SELECT 1 FROM orders WHERE razorpay_order_id = ${razorpayOrderId} LIMIT 1`;
      return existing.length ? 'duplicate' : 'unclaimed';
    } catch (lookupErr) {
      return 'unclaimed';
    }
  }
}
async function releasePaymentConfirmation(sql, razorpayOrderId) {
  try { await sql`DELETE FROM payment_confirmations WHERE razorpay_order_id = ${razorpayOrderId}`; }
  catch (err) { console.error('releasePaymentConfirmation failed:', err.message); }
}

// Asks Razorpay about the payment itself (not just the browser's
// signature): it must belong to this order and be captured. A payment
// left 'authorized' is captured here — Razorpay refunds uncaptured
// payments automatically after a few days, which would silently undo a
// confirmed booking. Returns { ok, retry, reason }.
async function checkPayment(razorpay, razorpayOrderId, paymentId) {
  let payment;
  try {
    payment = await razorpay.payments.fetch(paymentId);
  } catch (err) {
    return { ok: false, retry: true, reason: 'Could not reach Razorpay to check the payment: ' + (err.message || err) };
  }
  if (!payment || payment.order_id !== razorpayOrderId) return { ok: false, retry: false, reason: 'This payment does not belong to this order.' };
  if (payment.status === 'authorized') {
    try { payment = await razorpay.payments.capture(paymentId, payment.amount, payment.currency); }
    catch (err) { return { ok: false, retry: true, reason: 'Capture failed: ' + ((err.error && err.error.description) || err.message || err) }; }
  }
  if (payment.status !== 'captured') {
    return { ok: false, retry: payment.status === 'authorized' || payment.status === 'created', reason: `Payment status is ${payment.status}.` };
  }
  return { ok: true, payment };
}

// Is any stay's date range no longer free? Same rules as create-order.js:
// host-blocked or imported (Airbnb/Booking.com…) dates, or another PAID
// booking of the same room (Resort) or home. Returns a list of problems.
async function findDateConflicts(sql, stays) {
  const problems = [];
  for (const s of stays) {
    if (!s.listingId || !s.arrival || !s.departure) continue;
    const roomId = s.roomId || null;
    const blocked = await sql`
      SELECT 1 FROM listing_blocked_dates
      WHERE listing_id = ${s.listingId} AND (room_id IS NULL OR room_id = ${roomId})
        AND start_date < ${s.departure}::date AND end_date > ${s.arrival}::date
      LIMIT 1
    `;
    const booked = roomId
      ? await sql`SELECT 1 FROM orders WHERE room_id = ${roomId} AND status = 'paid' AND COALESCE(order_type, 'stay') = 'stay'
                    AND arrival < ${s.departure}::date AND departure > ${s.arrival}::date LIMIT 1`
      : await sql`SELECT 1 FROM orders WHERE listing_id = ${s.listingId} AND status = 'paid' AND COALESCE(order_type, 'stay') = 'stay'
                    AND arrival < ${s.departure}::date AND departure > ${s.arrival}::date LIMIT 1`;
    if (blocked.length || booked.length) problems.push({ listingId: s.listingId, roomId, suite: s.suite, arrival: s.arrival, departure: s.departure });
  }
  return problems;
}

// Every order row this payment will write, fully worked out, before any
// is written — so the whole payment is written as paid, or as cancelled,
// never half of each.
function planRows(ctx) {
  const { stays, experiences, couponId, couponDiscount } = ctx;
  const itemGst = (item) => Math.max(0, Math.round(Number(item && item.gst) || 0));
  const rows = [];
  let couponAttributed = false;
  const takeCoupon = () => {
    if (!couponId || couponAttributed) return { couponId: null, couponDiscount: 0 };
    couponAttributed = true;
    return { couponId, couponDiscount };
  };

  for (const stay of stays) {
    const guestServiceFee = Number(stay.guestServiceFee) || 0;
    const depositAmount = Number(stay.depositAmount) || 0;
    const gst = itemGst(stay);
    const subtotal = stay.subtotal;
    let commissionAmount, effectiveRate;
    if (stay.baseCommission != null && stay.amenityCommission != null) {
      commissionAmount = Number(stay.baseCommission) + Number(stay.amenityCommission);
      effectiveRate = subtotal > 0 ? Number(((commissionAmount / subtotal) * 100).toFixed(2)) : 0;
    } else {
      effectiveRate = stay.commissionRate != null ? Number(stay.commissionRate) : FALLBACK_COMMISSION_RATE;
      commissionAmount = Math.round(subtotal * (effectiveRate / 100));
    }
    let depositReleaseAt = null;
    if (depositAmount > 0) {
      const d = new Date(stay.departure + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + DEPOSIT_HOLD_DAYS);
      depositReleaseAt = d.toISOString().split('T')[0];
    }
    rows.push({
      type: 'stay', item: stay, suite: stay.suite, listingId: stay.listingId || null, roomId: stay.roomId || null,
      arrival: stay.arrival, departure: stay.departure, guests: stay.guests, nights: stay.nights,
      subtotal, discountAmount: stay.discountAmount || 0, gst, guestServiceFee,
      total: subtotal + gst + guestServiceFee + depositAmount,
      effectiveRate, commissionAmount, payoutAmount: subtotal - commissionAmount,
      depositAmount, depositReleaseAt, ...takeCoupon()
    });
  }
  for (const ex of experiences) {
    const guestServiceFee = Number(ex.guestServiceFee) || 0;
    const gst = itemGst(ex);
    const commissionAmount = Number(ex.commissionAmount) || 0;
    rows.push({
      type: 'experience', item: ex, suite: ex.suite, listingId: ex.listingId || null, roomId: null,
      arrival: ex.date, departure: ex.endDate || ex.date, guests: ex.guests, nights: ex.durationDays || 1,
      subtotal: ex.subtotal, discountAmount: 0, gst, guestServiceFee,
      total: ex.subtotal + gst + guestServiceFee,
      effectiveRate: ex.commissionRate != null ? Number(ex.commissionRate) : FALLBACK_COMMISSION_RATE,
      commissionAmount, payoutAmount: ex.subtotal - commissionAmount,
      depositAmount: 0, depositReleaseAt: null, ...takeCoupon()
    });
  }
  return rows;
}

async function insertRow(sql, ctx, row, cancelledReason) {
  const paid = !cancelledReason;
  const status = paid ? 'paid' : 'cancelled';
  const depositStatus = paid && row.depositAmount > 0 ? 'held' : 'none';
  const it = row.item;
  const inserted = await sql`
    INSERT INTO orders (
      suite_name, listing_id, room_id, guest_id, guest_email, arrival, departure, guests, nights,
      subtotal, discount_amount, gst, guest_service_fee, total,
      commission_rate, commission_amount, payout_amount,
      deposit_amount, deposit_status, deposit_release_at,
      charge_currency, charge_amount, coupon_id, coupon_discount,
      razorpay_order_id, razorpay_payment_id, status, order_type, pet_types,
      service_animal_types, young_litter_count,
      agreement_version, agreement_accepted_at, agreement_ip,
      cancellation_reason, cancelled_at
    ) VALUES (
      ${row.suite}, ${row.listingId}, ${row.roomId}, ${ctx.guestId}, ${ctx.email}, ${row.arrival}, ${row.departure}, ${row.guests}, ${row.nights},
      ${row.subtotal}, ${row.discountAmount}, ${row.gst}, ${row.guestServiceFee}, ${row.total},
      ${row.effectiveRate}, ${row.commissionAmount}, ${row.payoutAmount},
      ${row.depositAmount}, ${depositStatus}, ${paid ? row.depositReleaseAt : null},
      ${ctx.chargeCurrency}, ${ctx.chargeAmount}, ${row.couponId}, ${row.couponDiscount},
      ${ctx.razorpayOrderId}, ${ctx.razorpayPaymentId}, ${status}, ${row.type},
      ${row.type === 'stay' ? JSON.stringify(Array.isArray(it.petTypes) ? it.petTypes : []) : null},
      ${row.type === 'stay' ? JSON.stringify(Array.isArray(it.serviceAnimals) ? it.serviceAnimals : []) : null},
      ${row.type === 'stay' ? (Number(it.youngLitterCount) || 0) : null},
      ${ctx.agreement.version}, ${ctx.agreement.acceptedAt}, ${ctx.agreement.ip},
      ${cancelledReason || null}, ${paid ? null : new Date().toISOString()}
    )
    RETURNING id
  `;
  return inserted[0].id;
}

// Everything that follows a PAID row: co-host shares, amenities, audit,
// host message templates. Each step is its own failure domain.
async function afterPaidRow(sql, ctx, row, orderId) {
  await recordCohostShares(sql, orderId, row.listingId, row.payoutAmount);
  await logAudit(sql, {
    action: 'booking_confirmed', success: true, actorType: 'guest', actorIdentifier: ctx.email || null,
    targetType: 'order', targetId: orderId,
    metadata: { listingId: row.listingId, roomId: row.roomId, suiteName: row.suite, arrival: row.arrival, departure: row.departure,
      guests: row.guests, nights: row.nights, total: row.total, razorpayOrderId: ctx.razorpayOrderId,
      isExperience: row.type === 'experience', source: ctx.source }
  });
  if (row.type !== 'stay') return;
  for (const a of (Array.isArray(row.item.amenities) ? row.item.amenities : [])) {
    try {
      await sql`INSERT INTO order_amenities (order_id, listing_amenity_id, name, price_per_night, selected_dates, total_price)
                VALUES (${orderId}, ${a.id || null}, ${a.name}, ${a.pricePerNight}, ${JSON.stringify(a.dates)}, ${a.total})`;
    } catch (err) { console.error('order_amenities insert failed:', orderId, err.message); }
  }
  await sendBookingConfirmedTemplates(sql, { id: orderId, listing_id: row.listingId, guest_id: ctx.guestId, guest_email: ctx.email });
}

async function sendConflictEmail(ctx, reasonText, refundedInr, refundFailed) {
  if (!process.env.RESEND_API_KEY || !ctx.email) return;
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const items = [...ctx.stays.map(s => `${s.suite} (${s.arrival} → ${s.departure})`), ...ctx.experiences.map(e => `${e.suite} (${e.date})`)];
  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">We could not complete your booking</h2>
      <p>${esc(reasonText)}</p>
      <ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
      <p>${refundFailed
        ? `We are refunding your payment of <strong>₹${Number(refundedInr).toLocaleString('en-IN')}</strong> in full. Our team is completing it and will confirm by email.`
        : `Your payment of <strong>₹${Number(refundedInr).toLocaleString('en-IN')}</strong> is being refunded in full to your original payment method. Refunds usually arrive in 5–7 working days.`}</p>
      <p>Reference: ${esc(ctx.razorpayOrderId)}</p>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">We are sorry for the trouble. Questions? Write to hello@aerva.in.</p>
    </div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to: ctx.email, subject: 'Your Aerva booking could not be completed — full refund', html })
    });
  } catch (err) { console.error('conflict email failed:', err.message); }
}

// Refund every row of this payment, in full, through _refunds.js.
async function refundWholePayment(sql, razorpay, ctx, orderIds) {
  const paid = allocatePaid(await sql`SELECT id, subtotal, total, coupon_discount FROM orders WHERE id = ANY(${orderIds})`);
  let totalInr = 0;
  let failed = false;
  for (const id of orderIds) {
    const inr = (paid[id] || {}).paid || 0;
    totalInr += inr;
    try {
      const amount = ctx.chargeCurrency === 'INR' ? Math.round(inr * 100) : await convertInrToForeignSubunit(sql, inr, ctx.chargeCurrency);
      if (!amount && inr > 0) throw new Error(`No cached ${ctx.chargeCurrency} rate to refund order ${id}.`);
      const refund = await safeRefund(sql, razorpay, { orderId: id, paymentId: ctx.razorpayPaymentId, amountSubunit: amount, kind: 'cancellation' });
      await sql`UPDATE orders SET deposit_refund_id = ${refund.id} WHERE id = ${id}`;
    } catch (err) {
      failed = true;
      console.error('conflict refund failed (Admin → Refunds can retry):', id, err.message);
    }
  }
  return { totalInr, failed };
}

// Amount mismatch: every row is written as cancelled (so it is on record),
// the dates are released, the guest is told, and the WHOLE amount paid is
// refunded the next day by the scheduled_refunds job. One per payment.
async function cancelAndScheduleRefund(sql, razorpay, ctx, rows, reason) {
  const ids = [];
  for (const row of rows) ids.push(await insertRow(sql, ctx, row, 'Payment amount mismatch: ' + reason));
  const paid = allocatePaid(await sql`SELECT id, subtotal, total, coupon_discount FROM orders WHERE id = ANY(${ids})`);
  const amountInr = ids.reduce((t, id) => t + ((paid[id] || {}).paid || 0), 0);
  let scheduled = false;
  try {
    const r = await sql`INSERT INTO scheduled_refunds (razorpay_order_id, razorpay_payment_id, order_ids, charge_currency, amount_inr, reason, due_at)
                        VALUES (${ctx.razorpayOrderId}, ${ctx.razorpayPaymentId}, ${ids}, ${ctx.chargeCurrency}, ${amountInr}, ${reason}, now() + interval '1 day')
                        ON CONFLICT (razorpay_order_id) DO NOTHING RETURNING id`;
    scheduled = r.length > 0;
  } catch (err) {
    // Before migration_checkout_rules.sql: refund at once rather than never.
    await refundWholePayment(sql, razorpay, ctx, ids).catch(() => {});
  }
  await releaseHolds(sql, { razorpayOrderId: ctx.razorpayOrderId });
  await logAudit(sql, { action: 'booking_amount_mismatch', success: true, actorType: 'system', targetType: 'order', targetId: ids[0],
    metadata: { razorpayOrderId: ctx.razorpayOrderId, orderIds: ids, reason, amountInr, refundScheduled: scheduled, source: ctx.source } });
  if (process.env.RESEND_API_KEY && ctx.email) {
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    try {
      await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to: ctx.email, subject: 'Your Aerva booking was cancelled — full refund tomorrow',
          html: `<div style="font-family:sans-serif; max-width:480px;"><h2 style="font-family:Georgia,serif;">Your booking was cancelled</h2>
            <p>${esc(reason)}</p><p>Your payment of <strong>₹${amountInr.toLocaleString('en-IN')}</strong> will be refunded in full tomorrow, to your original payment method.</p>
            <p>Reference: ${esc(ctx.razorpayOrderId)}</p><p style="font-size:12px; opacity:0.6; margin-top:24px;">Questions? Write to hello@aerva.in.</p></div>` }) });
    } catch (err) { console.error('mismatch email failed:', err.message); }
  }
  return { status: 'conflict', message: `${reason} Your booking has been cancelled and ₹${amountInr.toLocaleString('en-IN')} will be refunded in full tomorrow.` };
}

// scheduled_refunds job: refunds whose day has come. Each is claimed
// (scheduled → processing) so two runs never refund it twice, and the
// refund itself goes through _refunds.js (one per booking, checked with
// Razorpay first).
async function processScheduledRefunds(sql, razorpay, { deadlineMs = 4000 } = {}) {
  const started = Date.now();
  const out = { refunded: 0, failed: 0 };
  if (!razorpay) return { ...out, skipped: 'Razorpay keys not set' };
  let due = [];
  try { due = await sql`SELECT * FROM scheduled_refunds WHERE status = 'scheduled' AND due_at <= now() ORDER BY due_at LIMIT 20`; }
  catch (err) { return { ...out, skipped: 'table not ready' }; }
  for (const r of due) {
    if (Date.now() - started > deadlineMs) break;
    const mine = await sql`UPDATE scheduled_refunds SET status = 'processing' WHERE id = ${r.id} AND status = 'scheduled' RETURNING id`;
    if (!mine.length) continue;
    // A change payment is refunded on its own; a booking payment row by row.
    const res = r.refund_kind
      ? await safeRefund(sql, razorpay, { orderId: r.order_ids[0], paymentId: r.razorpay_payment_id, amountSubunit: r.amount_inr * 100, kind: r.refund_kind })
          .then(() => ({ failed: false })).catch(err => { console.error('scheduled change refund failed:', err.message); return { failed: true }; })
      : await refundWholePayment(sql, razorpay, { razorpayPaymentId: r.razorpay_payment_id, chargeCurrency: r.charge_currency }, r.order_ids);
    await sql`UPDATE scheduled_refunds SET status = ${res.failed ? 'failed' : 'done'}, processed_at = now(), error = ${res.failed ? 'One or more refunds failed — retry in Admin → Refunds' : null} WHERE id = ${r.id}`;
    res.failed ? out.failed++ : out.refunded++;
  }
  return out;
}

// ---------------------------------------------------------------------
// The one entry point. Returns:
//   { status: 'confirmed' }                  booking written as paid
//   { status: 'duplicate' }                  already handled earlier
//   { status: 'conflict', message }          written cancelled, refunded
//   { status: 'pending', message }           payment not settled yet; retried later
//   { status: 'error', message }             nothing written; retried later
async function confirmBooking(sql, razorpay, { razorpayOrderId, razorpayPaymentId, source = 'browser' }) {
  const claim = await claimPaymentConfirmation(sql, razorpayOrderId);
  if (claim === 'duplicate') return { status: 'duplicate' };
  const release = async () => { if (claim === 'claimed') await releasePaymentConfirmation(sql, razorpayOrderId); };

  // 1. The payment itself, from Razorpay.
  const check = await checkPayment(razorpay, razorpayOrderId, razorpayPaymentId);
  if (!check.ok) {
    await release();
    await logAudit(sql, { action: 'booking_payment_not_settled', success: false, actorType: 'system', targetType: 'order', targetId: null,
      metadata: { razorpayOrderId, razorpayPaymentId, reason: check.reason, source } });
    return { status: check.retry ? 'pending' : 'error', message: check.reason };
  }

  // 2. What was bought, from Razorpay's own copy of the order.
  let ctx;
  try {
    const order = await razorpay.orders.fetch(razorpayOrderId);
    const n = order.notes || {};
    // A payment for a change to an existing booking (_booking-changes.js).
    if (n.type === 'booking_change') {
      return await confirmChangePayment(sql, razorpay, { order, payment: check.payment, razorpayOrderId, razorpayPaymentId });
    }
    const agreement = { version: null, acceptedAt: null, ip: null };
    if (n.agreement) {
      const [v, at, ip] = String(n.agreement).split('|');
      agreement.version = v || null;
      agreement.acceptedAt = at && !isNaN(Date.parse(at)) ? new Date(at).toISOString() : null;
      agreement.ip = ip || null;
    }
    ctx = {
      source, razorpayOrderId, razorpayPaymentId,
      email: n.email || null,
      guestId: n.guestId ? parseInt(n.guestId, 10) || null : null,
      stays: n.stays ? JSON.parse(n.stays) : [],
      experiences: n.experiences ? JSON.parse(n.experiences) : [],
      chargeCurrency: n.chargeCurrency || 'INR',
      chargeAmount: n.chargeAmount ? Number(n.chargeAmount) : null,
      couponId: n.couponId ? Number(n.couponId) : null,
      couponDiscount: n.couponDiscount ? Number(n.couponDiscount) : 0,
      couponForfeited: n.couponForfeited ? Number(n.couponForfeited) : 0,
      agreement,
      orderAmount: Number(order.amount),
      orderCreatedAt: order.created_at ? Number(order.created_at) : null,
      heldAtCheckout: n.held === '1',
      pricesAtCheckout: (() => { try { return n.prices ? JSON.parse(n.prices) : null; } catch (e) { return null; } })()
    };
  } catch (err) {
    await release();
    console.error('confirmBooking: could not read the order:', razorpayOrderId, err);
    return { status: 'error', message: 'Could not read this order from Razorpay.' };
  }
  if (!ctx.stays.length && !ctx.experiences.length) {
    // Not a booking order (e.g. a host's coupon purchase). Leave it alone.
    await release();
    return { status: 'error', message: 'This payment is not for a booking.' };
  }

  const rows = planRows(ctx);
  let conflictReason = null;

  // 2a. The amount paid must equal the booking amount — the amount on the
  // Razorpay order, the booking's own figures, and today's prices (a host
  // price change after the order was made means the amount no longer
  // matches). Otherwise: cancelled, and refunded in full the next day.
  try {
    const expected = ctx.stays.reduce((t, x) => t + Number(x.subtotal) + Number(x.gst || 0) + Number(x.guestServiceFee || 0) + Number(x.depositAmount || 0), 0)
                   + ctx.experiences.reduce((t, x) => t + Number(x.subtotal) + Number(x.gst || 0) + Number(x.guestServiceFee || 0), 0)
                   - Number(ctx.couponDiscount || 0);
    let mismatch = null;
    if (Number(check.payment.amount) !== ctx.orderAmount) mismatch = 'The amount paid did not match the amount of the order.';
    else if (ctx.chargeCurrency === 'INR' && ctx.orderAmount !== Math.round(expected * 100)) mismatch = 'The amount paid did not match the booking amount.';
    else if (ctx.pricesAtCheckout) {
      // Stamp to stamp: the price stamps checkout priced with, against the
      // listings' stamps now. Any difference = the price changed in between.
      const ids = Object.keys(ctx.pricesAtCheckout).map(Number).filter(Boolean);
      let now = [];
      try { now = await sql`SELECT id, price_changed_at FROM listings WHERE id = ANY(${ids})`; }
      catch (err) { /* before migration_checkout_rules.sql */ }
      const changed = now.filter(r => (r.price_changed_at ? new Date(r.price_changed_at).toISOString() : null) !== (ctx.pricesAtCheckout[String(r.id)] || null));
      if (changed.length) mismatch = 'The host changed the price while the payment was being made, so the amount paid no longer matches the booking amount.';
    }
    if (mismatch) return await cancelAndScheduleRefund(sql, razorpay, ctx, rows, mismatch);
  } catch (err) {
    await release();
    console.error('confirmBooking: amount check failed:', err);
    return { status: 'error', message: 'Could not check the payment amount right now.' };
  }

  // 2b. It must have completed inside its 90-second payment window. A
  // payment for a window that was cancelled, closed or timed out is not a
  // booking: cancelled and refunded in full at once.
  if (ctx.stays.length) {
    const win = await holdValidForConfirmation(sql, razorpayOrderId, { heldAtCheckout: ctx.heldAtCheckout });
    if (!win.ok) conflictReason = win.reason;
  }

  // 3. Dates still free?
  if (!conflictReason) try {
    const clashes = await findDateConflicts(sql, ctx.stays);
    if (clashes.length) {
      conflictReason = `The dates for ${clashes.map(c => c.suite).join(', ')} were booked by someone else while your payment was being completed.`;
    }
  } catch (err) {
    await release();
    console.error('confirmBooking: availability check failed:', err);
    return { status: 'error', message: 'Could not check availability right now.' };
  }

  // 4. Coupon still unused? Claimed atomically: of two payments using the
  // same coupon, only the first to be confirmed keeps it.
  let couponClaimed = false;
  if (!conflictReason && ctx.couponId) {
    const got = await sql`UPDATE coupons SET status = 'redeemed', redeemed_at = now()
                          WHERE id = ${ctx.couponId} AND status = 'active' RETURNING id`;
    if (got.length) couponClaimed = true;
    else conflictReason = 'The coupon on this booking had already been used on another booking.';
  }
  const unclaimCoupon = async () => {
    if (!couponClaimed) return;
    try { await sql`UPDATE coupons SET status = 'active', redeemed_at = NULL WHERE id = ${ctx.couponId} AND status = 'redeemed' AND redeemed_order_id IS NULL`; }
    catch (err) { console.error('could not return coupon after conflict:', ctx.couponId, err.message); }
    couponClaimed = false;
  };

  // 5. Write the rows — all paid, or (on a conflict) all cancelled.
  const written = []; // { row, id }
  try {
    if (!conflictReason) {
      for (const row of rows) written.push({ row, id: await insertRow(sql, ctx, row, null) });
    }
  } catch (err) {
    if (err && err.code === '23P01') {
      // The database's own double-booking guard refused a row: another
      // payment for these dates was confirmed in the same instant.
      conflictReason = 'These dates were booked by someone else while your payment was being completed.';
      if (written.length) {
        await sql`UPDATE orders SET status = 'cancelled', cancellation_reason = ${'Payment conflict: ' + conflictReason}, cancelled_at = now(),
                    deposit_status = 'none', deposit_release_at = NULL
                  WHERE id = ANY(${written.map(w => w.id)})`;
      }
    } else {
      console.error('confirmBooking: could not write the booking:', razorpayOrderId, err);
      if (!written.length) {
        await unclaimCoupon();
        await release();
        return { status: 'error', message: 'Could not save the booking right now.' };
      }
      // Some rows are in: keep the claim (a retry would duplicate them) and
      // surface it loudly for a person to finish.
      await logAudit(sql, { action: 'booking_partly_recorded', success: false, actorType: 'system', targetType: 'order', targetId: written[0].id,
        metadata: { razorpayOrderId, written: written.length, of: rows.length, error: String(err.message || err).slice(0, 300) } });
      return { status: 'error', message: 'Booking partly saved.', userMessage: 'Your payment was received but the booking was only partly saved. Our team has been alerted and will confirm by email. Please do not pay again.' };
    }
  }

  // 6a. Conflict: record, refund in full, tell the guest.
  if (conflictReason) {
    await unclaimCoupon();
    const already = new Set(written.map(w => w.row));
    for (const row of rows) {
      if (already.has(row)) continue;
      written.push({ row, id: await insertRow(sql, ctx, row, 'Payment conflict: ' + conflictReason) });
    }
    const ids = written.map(w => w.id);
    const refund = await refundWholePayment(sql, razorpay, ctx, ids);
    await logAudit(sql, { action: 'booking_conflict_refunded', success: !refund.failed, actorType: 'system', targetType: 'order', targetId: ids[0],
      metadata: { razorpayOrderId, orderIds: ids, reason: conflictReason, refundedInr: refund.totalInr, refundFailed: refund.failed, source } });
    await sendConflictEmail(ctx, conflictReason, refund.totalInr, refund.failed);
    await releaseHolds(sql, { razorpayOrderId });
    return { status: 'conflict', message: `${conflictReason} The booking was not made, and your payment is being refunded in full — we have emailed you the details.` };
  }

  // 6b. Confirmed. Every booking gets its confirmation code.
  try {
    for (const w of written) {
      const code = await issueConfirmationCode(sql, w.id);
      if (!code) continue;
      const set = await sql`UPDATE orders SET confirmation_code = ${code} WHERE id = ${w.id} AND confirmation_code IS NULL RETURNING confirmation_code`;
      // Already had one (a repeat confirmation): keep it, and the code just
      // claimed stays in the register, never to be issued again.
      w.confirmationCode = set.length ? code : (await sql`SELECT confirmation_code FROM orders WHERE id = ${w.id}`)[0].confirmation_code;
    }
    ctx.confirmationCodes = written.filter(w => w.confirmationCode).map(w => ({ item: w.row.suite, code: w.confirmationCode }));
  } catch (err) { console.error('confirmation code not set:', err.message); }

  // Each booking keeps the refund policy it was paid under,
  // so a host switching to Firm later never changes it (_cancellations.js).
  try {
    await sql`UPDATE orders o SET cancellation_policy = l.cancellation_policy FROM listings l
              WHERE o.id = ANY(${written.map(w => w.id)}) AND l.id = o.listing_id`;
  } catch (err) { /* before migration_cancellation_policy.sql: treated as Flexible */ }
  for (const { row, id } of written) {
    try { await afterPaidRow(sql, ctx, row, id); }
    catch (err) { console.error('post-booking step failed (booking kept):', id, err.message); }
    if (row.couponId && couponClaimed) {
      try { await sql`UPDATE coupons SET redeemed_order_id = ${id} WHERE id = ${row.couponId}`; }
      catch (err) { console.error('coupon link failed:', err.message); }
      try { if (ctx.couponForfeited > 0) await sql`UPDATE coupons SET forfeited_amount = ${ctx.couponForfeited} WHERE id = ${row.couponId}`; }
      catch (e) { console.error('coupon forfeit not recorded:', e.message); }
    }
  }

  if (ctx.email) {
    try {
      const pdf = await generateBookingConfirmationPdf(ctx.stays, ctx.experiences, razorpayOrderId, ctx.chargeCurrency, ctx.couponDiscount, ctx.confirmationCodes);
      await sendBookingConfirmationEmail(ctx.email, ctx.stays, ctx.experiences, pdf, ctx.agreement.version, ctx.confirmationCodes);
    } catch (err) { console.error('Could not send booking confirmation email:', err); }
  }
  try { await sendHostBookingEmails(sql, ctx.stays, ctx.experiences, ctx.agreement.version, ctx.confirmationCodes); }
  catch (err) { console.error('host booking emails failed:', err.message); }

  // The booking now holds the dates itself; the temporary hold goes.
  await releaseHolds(sql, { razorpayOrderId });
  // Paid without a valid ID on the account (removed or rejected while
  // paying): the guest gets a short deadline to add one (_guest-id.js).
  await markIdDeadlineIfMissing(sql, written.map(w => w.id), ctx.guestId);
  return { status: 'confirmed' };
}

// ---------------------------------------------------------------------
// payment_reconcile job: booking orders created 10 minutes to 6 hours ago
// with no confirmation yet. Razorpay is asked for each one's payments; a
// captured (or authorized) payment is confirmed exactly as the browser
// would have done it. Abandoned checkouts simply have no such payment.
async function reconcilePayments(sql, razorpay, { deadlineMs = 4000, limit = 25 } = {}) {
  const started = Date.now();
  const out = { checked: 0, confirmed: 0, conflicts: 0, pending: 0 };
  if (!razorpay) return { ...out, skipped: 'Razorpay keys not set' };
  const rows = await sql`
    SELECT DISTINCT a.metadata->>'razorpayOrderId' AS oid, max(a.created_at) AS at
    FROM audit_log a
    WHERE a.action IN ('booking_order_created', 'booking_change_order_created')
      AND a.created_at > now() - interval '6 hours' AND a.created_at < now() - interval '10 minutes'
      AND a.metadata->>'razorpayOrderId' IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM payment_confirmations p WHERE p.razorpay_order_id = a.metadata->>'razorpayOrderId')
    GROUP BY 1 ORDER BY 2 DESC LIMIT ${limit}
  `;
  for (const r of rows) {
    if (Date.now() - started > deadlineMs) break;
    out.checked++;
    try {
      const list = await razorpay.orders.fetchPayments(r.oid);
      const items = (list && list.items) || [];
      const pay = items.find(p => p.status === 'captured') || items.find(p => p.status === 'authorized');
      if (!pay) continue;
      const result = await confirmBooking(sql, razorpay, { razorpayOrderId: r.oid, razorpayPaymentId: pay.id, source: 'reconcile' });
      if (result.status === 'confirmed') out.confirmed++;
      else if (result.status === 'conflict') out.conflicts++;
      else if (result.status === 'pending') out.pending++;
    } catch (err) {
      console.error('reconcile failed for', r.oid, err.message);
    }
  }
  return out;
}

module.exports = { confirmBooking, reconcilePayments, processScheduledRefunds, findDateConflicts, planRows, checkPayment };
