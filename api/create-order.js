// /api/create-order.js
// Deploy target: Vercel (or Netlify Functions with minor adjustments — see README below)
//
// This runs server-side only. Your Razorpay Key Secret NEVER reaches the browser.
// The browser only ever sees the public Key ID and the order_id this function returns.
//
// Pricing is now driven entirely by each listing's own row in the database —
// nightly_rate, discount_type/value/min_nights, commission_rate, security_deposit
// — never by anything the browser sends. This mirrors the frontend's own
// calculation, but is the actual source of truth: a tampered browser
// request can change what it *displays*, never what it's actually charged.
//
// Refundable security deposits (see security_deposit on listings) are
// collected here as part of the same Razorpay payment, then tracked
// separately by verify-payment.js once payment succeeds — see that file
// for the 7-day hold, auto-refund, and dispute lifecycle.
//
// ---------------------------------------------------------------------
// International Payments (Razorpay) — SCAFFOLDING, disabled by default
// ---------------------------------------------------------------------
// Razorpay's Orders API already supports charging in a currency other
// than INR — same razorpay.orders.create() call used below, just with a
// `currency` param and the amount in THAT currency's own subunit instead
// of paise. The catch: your Razorpay account has to be approved for
// International Payments first (a request made from the Razorpay
// Dashboard, not something this code can do), and it's high-fraud-risk
// enough that Razorpay reviews it manually.
//
// Until that approval exists, INTERNATIONAL_ENABLED_CURRENCIES (read from
// site_settings, see getEnabledInternationalCurrencies() below) stays
// empty, and every order charges in INR exactly as it always has —
// nothing about existing behavior changes by this code merely existing.
// Once approved, an admin can enable specific currencies by writing to
// that same site_settings row (no code change needed) and this same
// function starts actually charging guests directly in their currency.
//
// Settlement to Aerva stays INR regardless (confirmed against Razorpay's
// own docs — payments in any currency settle to the merchant in INR/USD
// per your account type, never in the guest's currency), so every OTHER
// pricing column in `orders` (subtotal, gst, commission_amount,
// payout_amount, deposit_amount) stays INR-denominated no matter what a
// guest was actually charged — host payout accounting is completely
// unaffected by this feature. charge_currency/charge_amount exist purely
// to record what the guest's own statement will show.

const Razorpay = require('razorpay');
const { neon } = require('@neondatabase/serverless');
const { verifyToken } = require('./_approval-token');
const { getEnabledInternationalCurrencies, convertInrToForeignSubunit, ZERO_DECIMAL_CURRENCIES } = require('./_currency');
const { isAccountDeleted } = require('./_accounts');
const { logAudit } = require('./_audit-log');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
const sql = neon(process.env.DATABASE_URL);
// Pricing rules and helpers: _pricing.js (shared with booking changes).
const {
  EXTRA_GUEST_RATE, BASE_OCCUPANCY, BASE_COMMISSION_RATE, AMENITY_COMMISSION_RATE, GUEST_SERVICE_FEE_RATE,
  MAX_STAYS, MAX_EXPERIENCES, MAX_AMENITIES_PER_STAY,
  calculateNights, addDaysToDateStr, getNightsInRange, toDateStr, validateAndPriceAmenities,
  discountAmountFor, calculateDiscount, priceStay, priceExperience
} = require('./_pricing');

// GST: rates and rules live in _gst.js (added on top, kept by Aerva, not
// charged on the guest service fee or the deposit). index.html's copy is
// display-only.
const { stayGst, experienceGst } = require('./_gst');
const { sanitizeBody } = require('./_plain-text');
const { AGREEMENT_VERSION } = require('./_agreements');
const { syncStaleFeeds } = require('./_calendar-sync');
const { decryptField } = require('./_secure-fields');
const { releaseDueCoupons } = require('./_coupons');
const { requestContext } = require('./_audit-log');
const { takeHolds, attachHolds, releaseHolds, holdStatus, HOLD_SECONDS } = require('./_booking-rules');
const { startChangePayment } = require('./_booking-changes');
const { assertCanBook } = require('./_guest-id');
// Fixed platform commission rates — replaces the old per-listing
// commission_rate column, which is no longer read for new bookings (kept
// in the schema/orders table only for historical orders placed before
// this change). Room + extra-guest charges are commissioned separately
// from paid amenities, at a lower rate, since amenities are a smaller
// add-on the host arranges directly.
// Separate from the commission rates above — this is added ON TOP of what
// the guest pays, entirely distinct from what comes out of the host's
// side. A flat rate on the whole stay subtotal (room + extra guests +
// amenities, after discount), not split by category like the host
// commission is.

// A logged-in guest booking is optional, not required — Aerva still
// supports guest checkout without an account. If a valid guest session
// token is present, its id rides along in the Razorpay order's notes so
// verify-payment.js can link the eventual order row back to the account;
// if it's missing, expired, or invalid, booking proceeds exactly as
// before, just without that link.
function getOptionalGuestId(req) {
  const authHeader = req.headers['authorization'] || '';
  const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!sessionToken) return null;
  const payload = verifyToken(sessionToken);
  if (!payload || payload.action !== 'guest-session') return null;
  return payload.listingId; // generically-named token field — see host-auth.js note; here it's the guest's id
}

module.exports = async (req, res) => {
  // Typed text can never become markup — see _plain-text.js.
  sanitizeBody(req);

  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // The guest closed the payment window, or the payment failed: free the
  // dates at once instead of waiting out the 10 minutes.
  // POST { releaseHold: '<razorpay order id>' }
  if (req.body && req.body.releaseHold) {
    await releaseHolds(sql, { razorpayOrderId: String(req.body.releaseHold).slice(0, 64) });
    return res.status(200).json({ released: true });
  }
  // Paying the difference for a change the host accepted: the same strict
  // 90-second window as a booking (_booking-changes.js).
  // POST { payChange: <change id> } — signed-in guest only.
  if (req.body && req.body.payChange) {
    const gid = getOptionalGuestId(req);
    if (!gid) return res.status(401).json({ error: 'Please log in again.' });
    try {
      const out = await startChangePayment(sql, razorpay, { changeId: Number(req.body.payChange) || 0, guestId: gid, ip: requestContext(req).ip || null });
      return res.status(200).json(out);
    } catch (err) {
      if (!err.isUserFacing) console.error('payChange failed:', err);
      return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not start the payment. Please try again.' });
    }
  }
  // The page asks every few seconds while the payment window is open:
  // still running? timed out? did the host change a price? The window is
  // closed (and the dates released) the moment the answer is no.
  // POST { holdStatus: '<razorpay order id>' }
  if (req.body && req.body.holdStatus) {
    return res.status(200).json(await holdStatus(sql, String(req.body.holdStatus).slice(0, 64)));
  }

  let holdIds = [];
  try {
    const { stays, experiences, email, preferredCurrency, couponCode, pricesSeen } = req.body;

    // The booking agreement must be accepted, in its current wording, before
    // any payment is created (aerva-policies.js → agreements.guest). What was
    // accepted, when and from where travels with the payment and is saved on
    // every booking row (verify-payment.js).
    // A deleted account is refused before anything else.
    { const early = getOptionalGuestId(req); if (early && await isAccountDeleted(sql, early)) return res.status(401).json({ error: 'This account has been deleted.' }); }
    if (req.body.agreementVersion !== AGREEMENT_VERSION) {
      return res.status(400).json({ error: 'Please read and accept the booking agreement to continue.', agreementVersion: AGREEMENT_VERSION });
    }
    const agreementNote = [AGREEMENT_VERSION, new Date().toISOString(), requestContext(req).ip || ''].join('|').slice(0, 200);

    // Dates sold on Airbnb / Agoda / Booking.com… must be closed here before
    // this booking is checked: refresh these listings' imported calendars if
    // older than 15 minutes (6-second budget; a calendar that is down keeps
    // its previous dates blocked). See _calendar-sync.js.
    const stayListingIds = [...new Set((Array.isArray(stays) ? stays : []).map(x => Number(x && x.listingId)).filter(n => n > 0))];
    if (stayListingIds.length) await syncStaleFeeds(sql, decryptField, { listingIds: stayListingIds, maxAgeMinutes: 15, deadlineMs: 6000 });
    let safeStays = Array.isArray(stays) ? stays : [];
    const safeExperiences = Array.isArray(experiences) ? experiences : [];

    if (!email || (safeStays.length === 0 && safeExperiences.length === 0)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (safeStays.length > MAX_STAYS) {
      return res.status(400).json({ error: 'Too many stays in one request' });
    }
    if (safeExperiences.length > MAX_EXPERIENCES) {
      return res.status(400).json({ error: 'Too many experiences in one request' });
    }

    const guestId = getOptionalGuestId(req);
    // Every booking needs an account with a phone number and ID proof
    // (_guest-id.js). The phone typed at checkout is saved to the account if
    // it has none. `needs` tells the page what to ask for.
    try { await assertCanBook(sql, guestId, { phone: req.body.phone }); }
    catch (err) {
      if (err.isUserFacing) return res.status(err.status).json({ error: err.message, needs: err.needs || [] });
      throw err;
    }

    // Hosts and co-hosts cannot book listings they run: a self-booking pays
    // the booker's own payout, inflates ratings and blocks real guests'
    // dates. Checked on the server for every stay and experience in the cart.
    if (guestId) {
      const ids = [...new Set([]
        .concat((Array.isArray(stays) ? stays : []).map(x => Number(x && x.listingId)))
        .concat((Array.isArray(experiences) ? experiences : []).map(x => Number(x && x.listingId))))]
        .filter(n => Number.isInteger(n) && n > 0);
      if (ids.length) {
        let own = [];
        try {
          own = await sql`
            SELECT l.id, l.property_name FROM listings l
            WHERE l.id = ANY(${ids}) AND (
              l.host_id = (SELECT host_id FROM guests WHERE id = ${guestId})
              OR EXISTS (SELECT 1 FROM cohosts c WHERE c.host_id = l.host_id AND c.cohost_guest_id = ${guestId}
                         AND c.status = 'active' AND l.id = ANY(c.listing_ids))
            )
          `;
        } catch (err) {
          // Before migration_cohosts.sql the co-host part cannot run; the
          // host check alone still applies.
          own = await sql`SELECT l.id, l.property_name FROM listings l WHERE l.id = ANY(${ids}) AND l.host_id = (SELECT host_id FROM guests WHERE id = ${guestId})`;
        }
        if (own.length) {
          return res.status(400).json({ error: `You can't book ${own[0].property_name} — hosts and co-hosts can't book listings they run.` });
        }
      }
    }

    // ---- "Includes a Stay" experiences ----
    // An experience whose type is with_stay is sold together with nights
    // at the property that hosts it, paid for in ONE payment. The nights
    // are added here as an ordinary stay so they go through the same
    // path as any other: availability, blocked dates, max guests,
    // deposit, commission and GST all behave identically, with no second
    // copy of those rules to drift.
    //
    // The browser never sends this stay and cannot influence it: the
    // property, its rate and the number of nights all come from the
    // host's own experience record. The two rows end up sharing one
    // razorpay_order_id, which is what ties them together afterwards —
    // for the single review form, and for cancelling them as a pair.
    for (const ex of safeExperiences) {
      if (!ex.listingId || !ex.date) continue; // reported by the experience loop below
      const exRows = await sql`
        SELECT id, property_name, experience_type, hosting_listing_id, experience_duration_days
        FROM listings
        WHERE id = ${ex.listingId} AND status = 'approved' AND listing_type = 'experience'
      `;
      const e = exRows[0];
      if (!e || e.experience_type !== 'with_stay') continue;
      if (!e.hosting_listing_id) {
        return res.status(400).json({ error: `${e.property_name} includes a stay, but no home is linked to it yet. Please contact us.` });
      }
      const hostRows = await sql`SELECT id, status FROM listings WHERE id = ${e.hosting_listing_id}`;
      if (!hostRows[0] || hostRows[0].status !== 'approved') {
        return res.status(400).json({ error: `The home that hosts ${e.property_name} is not available to book right now.` });
      }
      // Booking that same home separately in the same request would look
      // like a duplicate further down; say so plainly instead.
      if (safeStays.some(s => Number(s.listingId) === Number(e.hosting_listing_id))) {
        return res.status(400).json({ error: `${e.property_name} already includes nights at that home — please remove the separate stay.` });
      }
      // One night per day of the experience: a two-day experience is two
      // nights. Taken from the host's own duration, never the request.
      const nights = e.experience_duration_days && e.experience_duration_days >= 1 ? e.experience_duration_days : 1;
      const guestCount = Number(ex.guests) || 1;
      safeStays = safeStays.concat([{
        listingId: e.hosting_listing_id,
        arrival: ex.date,
        departure: addDaysToDateStr(ex.date, nights),
        guests: guestCount,
        adults: guestCount,
        includedWithExperienceId: e.id
      }]);
    }
    if (safeStays.length > MAX_STAYS) {
      return res.status(400).json({ error: 'Too many homes in one booking once the stays included with your experiences are counted. Please book them separately.' });
    }

    let grandSubtotal = 0;
    let grandDiscount = 0;
    let grandGuestServiceFee = 0;
    let grandDeposit = 0;
    let grandGst = 0;
    const stayDetails = [];
    const experienceDetails = [];
    const seenListingIds = new Set();

    for (let i = 0; i < safeStays.length; i++) {
      const s = safeStays[i];
      if (!s.listingId || !s.arrival || !s.departure || !s.guests) {
        return res.status(400).json({ error: `Stay ${i + 1}: missing home selection, dates, or guest count` });
      }

      // Each property can only appear once per booking request — EXCEPT
      // a Resort, where booking several different rooms of the same
      // resort in one order is completely normal and valid. Keyed on
      // listingId+roomId together so two different rooms never collide,
      // while two requests for the SAME room (or the same non-Resort
      // listing, which has no roomId to distinguish by) still correctly
      // get caught as a genuine duplicate.
      const dedupeKey = s.listingId + ':' + (s.roomId || '');
      if (seenListingIds.has(dedupeKey)) {
        return res.status(400).json({ error: `Stay ${i + 1} repeats a room or home already used in this request.` });
      }
      seenListingIds.add(dedupeKey);

      // Priced by the shared rules in _pricing.js: listing, room, capacity,
      // availability, discount, amenities, pets, commission, GST, deposit.
      const priced = await priceStay(sql, s, i);
      if (priced.error) return res.status(400).json({ error: priced.error });
      const d = priced.detail;
      grandSubtotal += d.subtotal;
      grandGst += d.gst;
      grandDiscount += d.discountAmount;
      grandGuestServiceFee += d.guestServiceFee;
      grandDeposit += d.depositAmount;
      stayDetails.push(d);
    }

    // Experiences price much more simply than stays: no discount, no
    // extra-guest charge, no security deposit, no nights — just the
    // host's set price (per person or flat) plus the same guest service
    // fee rate everything else on Aerva charges.
    const seenExperienceIds = new Set();
    for (let i = 0; i < safeExperiences.length; i++) {
      const ex = safeExperiences[i];
      if (!ex.listingId || !ex.date) {
        return res.status(400).json({ error: `Experience ${i + 1}: missing selection or date` });
      }
      if (seenExperienceIds.has(ex.listingId)) {
        return res.status(400).json({ error: `Experience ${i + 1} repeats one already used in this request.` });
      }
      seenExperienceIds.add(ex.listingId);

      // Priced by the shared rules in _pricing.js (also used for changes).
      const pricedEx = await priceExperience(sql, ex, i);
      if (pricedEx.error) return res.status(400).json({ error: pricedEx.error });
      const xd = pricedEx.detail;
      grandSubtotal += xd.subtotal;
      grandGst += xd.gst;
      grandGuestServiceFee += xd.guestServiceFee;
      experienceDetails.push(xd);
    }

    // GST is summed per item above (each stay has its own rate), never
    // re-derived from a grand total. A coupon, applied next, is a voucher:
    // it reduces what the guest pays, not the GST on the booking.
    const gst = grandGst;
    let totalRupees = grandSubtotal + gst + grandGuestServiceFee + grandDeposit;

    // ---- Coupon redemption ----
    // Requires the guest to actually be logged in — a coupon is tied to
    // one specific guest_id (set when the issuing host bought it, see
    // host-listings.js's buyCouponOrder), not just an email address, so
    // there's no way to redeem one anonymously. Applied here, before the
    // Razorpay order amount is computed, so the discount is real —
    // baked into what's actually charged, not just displayed.
    let appliedCouponId = null;
    let appliedCouponDiscount = 0;
    let couponForfeited = 0;
    if (couponCode && String(couponCode).trim()) {
      if (!guestId) {
        return res.status(400).json({ error: 'Please log in to your account to use a coupon.' });
      }
      // A cancellation coupon whose 15 minutes are up is released first, so a
      // guest applying it right away is never told it is invalid.
      await releaseDueCoupons(sql, { force: true });
      const cleanCode = String(couponCode).trim().toUpperCase();
      const couponRows = await sql`
        SELECT id, guest_id, amount, status, expires_at FROM coupons WHERE code = ${cleanCode}
      `;
      const coupon = couponRows[0];
      if (!coupon) {
        return res.status(400).json({ error: 'This coupon code was not found.' });
      }
      if (coupon.guest_id !== guestId) {
        return res.status(400).json({ error: 'This coupon is not valid for your account.' });
      }
      if (coupon.status !== 'active') {
        return res.status(400).json({ error: coupon.status === 'redeemed' ? 'This coupon has already been used.' : coupon.status === 'scheduled' ? 'This coupon is not active yet. It is released 15 minutes after the cancellation.' : 'This coupon is no longer valid.' });
      }
      if (new Date(coupon.expires_at) < new Date()) {
        return res.status(400).json({ error: 'This coupon has expired.' });
      }
      // A coupon covers the BOOKING PRICE only (stays and experiences,
      // including amenities and pet fees). The guest service fee, GST and
      // any security deposit are always paid in full, on the full price.
      // If the coupon is worth more than the booking price, the unused
      // part is forfeited: not refunded, not carried over (Aerva income,
      // recorded on the coupon when payment is confirmed).
      appliedCouponDiscount = Math.min(Math.round(Number(coupon.amount)), Math.round(grandSubtotal));
      couponForfeited = Math.max(0, Math.round(Number(coupon.amount)) - appliedCouponDiscount);
      appliedCouponId = coupon.id;
      totalRupees = Math.max(0, totalRupees - appliedCouponDiscount);
    }

    // Default path, and the ONLY path until International Payments is
    // actually approved and an admin explicitly enables specific
    // currencies — charge in INR, exactly as this has always worked.
    let razorpayAmount = totalRupees * 100; // paise
    let razorpayCurrency = 'INR';
    let chargeCurrency = 'INR';
    let chargeAmount = null;

    if (preferredCurrency && preferredCurrency !== 'INR') {
      const enabledCurrencies = await getEnabledInternationalCurrencies(sql);
      if (enabledCurrencies.includes(preferredCurrency)) {
        const foreignSubunitAmount = await convertInrToForeignSubunit(sql, totalRupees, preferredCurrency);
        if (foreignSubunitAmount && foreignSubunitAmount > 0) {
          razorpayAmount = foreignSubunitAmount;
          razorpayCurrency = preferredCurrency;
          chargeCurrency = preferredCurrency;
          const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.includes(preferredCurrency);
          chargeAmount = isZeroDecimal ? foreignSubunitAmount : foreignSubunitAmount / 100;
        }
        // If conversion failed (no cached rate for this currency), this
        // silently falls through to the INR defaults set above — a
        // missing rate should never block a booking, just mean it
        // charges in INR instead of the guest's preferred currency.
      }
    }

    // The stay/experience details travel to verify-payment.js inside the
    // Razorpay order's notes. They used to be cut with .slice(), which on
    // an oversized booking produced broken JSON: the guest would pay, and
    // verify-payment could not read what they had paid for. Refuse before
    // payment instead. (Two new fields per item, gst and gstRate, add a
    // little to this size.)
    const staysNote = JSON.stringify(stayDetails);
    const experiencesNote = JSON.stringify(experienceDetails);
    if (staysNote.length > 4000 || experiencesNote.length > 2000) {
      return res.status(400).json({ error: 'This booking has too many items to process in one payment. Please split it into two bookings.' });
    }

    // ---- Has the host changed a price since this page loaded? ----
    // pricesSeen: { listingId: price_changed_at as the page received it }.
    // If any listing's price changed since, nothing is charged: the guest
    // is shown the new breakdown and confirms it first ("Prices have been
    // changed recently"). Re-sending with the returned pricesSeen continues.
    const involved = [...new Set([...stayDetails.map(x => Number(x.listingId)), ...experienceDetails.map(x => Number(x.listingId))])];
    let current = {};
    try {
      (await sql`SELECT id, price_changed_at FROM listings WHERE id = ANY(${involved})`).forEach(r => { current[r.id] = r.price_changed_at ? new Date(r.price_changed_at).toISOString() : null; });
    } catch (err) { current = null; } // before migration_checkout_rules.sql
    if (current && pricesSeen && typeof pricesSeen === 'object') {
      const changed = involved.filter(id => {
        if (!(String(id) in pricesSeen)) return false;          // not shown on this page (e.g. an included stay)
        const seen = pricesSeen[String(id)] ? Date.parse(pricesSeen[String(id)]) : null;
        const now = current[id] ? Date.parse(current[id]) : null;
        return now != null && (seen == null || now > seen);
      });
      if (changed.length) {
        const lines = [];
        stayDetails.forEach(x => {
          lines.push({ label: `${x.suite} — ${x.nights} night${x.nights === 1 ? '' : 's'}`, amount: x.subtotal + x.discountAmount });
          if (x.discountAmount) lines.push({ label: 'Discount', amount: -x.discountAmount });
        });
        experienceDetails.forEach(x => lines.push({ label: x.suite, amount: x.subtotal }));
        if (gst) lines.push({ label: 'GST', amount: gst });
        lines.push({ label: 'Guest service fee', amount: grandGuestServiceFee });
        if (grandDeposit) lines.push({ label: 'Refundable deposit', amount: grandDeposit });
        if (appliedCouponDiscount) lines.push({ label: 'Coupon', amount: -appliedCouponDiscount });
        return res.status(409).json({
          priceChanged: true,
          error: 'Prices have been changed recently. The new price is below.',
          lines, total: totalRupees, pricesSeen: current
        });
      }
    }

    // Open the 90-second payment window for these dates. If anyone —
    // this guest included — already has one open for them, stop here,
    // before any payment can start. Taken last, after every other check.
    const guestKey = guestId ? 'g:' + guestId : 'e:' + String(email).trim().toLowerCase();
    const held = await takeHolds(sql, stayDetails.map(s => ({ listingId: s.listingId, roomId: s.roomId, arrival: s.arrival, departure: s.departure })),
      { guestKey, ip: requestContext(req).ip || null });
    holdIds = held.ids;

    const order = await razorpay.orders.create({
      amount: razorpayAmount,
      currency: razorpayCurrency,
      receipt: `aerva_${Date.now()}`,
      notes: {
        email,
        guestId: guestId || '',
        stayCount: safeStays.length,
        experienceCount: safeExperiences.length,
        chargeCurrency,
        chargeAmount: chargeAmount || '',
        couponId: appliedCouponId || '',
        couponDiscount: appliedCouponDiscount || '',
        couponForfeited: couponForfeited || '',
        agreement: agreementNote,
        // '1' when a payment window was opened: the payment then only
        // counts if it completes inside it (_confirm-booking.js).
        held: holdIds.length ? '1' : '',
        // The exact price stamps this order was priced with. At payment,
        // any listing whose stamp differs had its price changed in between
        // — compared stamp to stamp, never by clocks.
        prices: current ? JSON.stringify(current) : '',
        // Razorpay notes have a size limit we haven't hit in practice yet,
        // but amenities make this payload meaningfully bigger than before
        // — if bookings with several amenities/dates start failing here,
        // this is the first place to check (may need a shorter encoding,
        // or storing full details in our own DB keyed by a short token
        // instead of putting everything in Razorpay's notes directly).
        stays: staysNote,
        experiences: experiencesNote,
      },
    });

    await attachHolds(sql, holdIds, order.id);

    // "What they booked" — the actual stay/experience details, dates,
    // and amount, logged the moment the order (and its Razorpay
    // counterpart) actually gets created. This is the booking ATTEMPT,
    // not yet a confirmed booking — verify-payment.js logs that
    // separately once payment actually clears, since a guest can create
    // an order here and then abandon payment entirely.
    await logAudit(sql, {
      action: 'booking_order_created', success: true, actorType: 'guest', actorIdentifier: email || null,
      targetType: 'order', targetId: null,
      metadata: {
        razorpayOrderId: order.id, guestId: guestId || null,
        stays: safeStays.map(s => ({ listingId: s.listingId, arrival: s.arrival, departure: s.departure, guests: s.guests })),
        experiences: safeExperiences.map(e => ({ listingId: e.listingId, date: e.date, guests: e.guests })),
        totalRupees, chargeCurrency, chargeAmount, couponId: appliedCouponId || null
      }
    });

    return res.status(200).json({
      orderId: order.id,
      chargeCurrency,
      chargeAmount,
      amount: order.amount,
      currency: order.currency,
      totalDeposit: grandDeposit,
      gst,
      couponDiscount: appliedCouponDiscount || 0,
      couponForfeited: couponForfeited || 0,
      // The page shows a countdown and closes the payment window when it ends.
      holdSeconds: holdIds.length ? HOLD_SECONDS : null,
      pricesSeen: current || undefined,
    });
  } catch (err) {
    if (holdIds.length) await releaseHolds(sql, { ids: holdIds });
    if (err && err.isUserFacing) return res.status(err.status || 400).json({ error: err.message });
    console.error('create-order error:', err);
    return res.status(500).json({ error: 'Could not create order' });
  }
};
