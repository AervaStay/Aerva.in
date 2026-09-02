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

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
const sql = neon(process.env.DATABASE_URL);

const EXTRA_GUEST_RATE = 1500;
const BASE_OCCUPANCY = 2;
// GST is temporarily disabled for testing — set back to the correct rate
// once ready to introduce it properly per government rules. This is the
// number that actually determines what guests are charged; aerva.html's
// copy is display-only and must be kept in sync with this one.
const GST_RATE = 0;
// Fixed platform commission rates — replaces the old per-listing
// commission_rate column, which is no longer read for new bookings (kept
// in the schema/orders table only for historical orders placed before
// this change). Room + extra-guest charges are commissioned separately
// from paid amenities, at a lower rate, since amenities are a smaller
// add-on the host arranges directly.
const BASE_COMMISSION_RATE = 10; // on room + extra-guest charges, after any discount
const AMENITY_COMMISSION_RATE = 5; // on paid amenities
// Separate from the commission rates above — this is added ON TOP of what
// the guest pays, entirely distinct from what comes out of the host's
// side. A flat rate on the whole stay subtotal (room + extra guests +
// amenities, after discount), not split by category like the host
// commission is.
const GUEST_SERVICE_FEE_RATE = 8;
const MAX_STAYS = 5; // matches the frontend cap — reject anything absurd
const MAX_EXPERIENCES = 5; // same reasoning, for the experiences array
const MAX_AMENITIES_PER_STAY = 15;

function calculateNights(arrival, departure) {
  const arrivalDate = new Date(arrival);
  const departureDate = new Date(departure);
  return Math.round((departureDate - arrivalDate) / (1000 * 60 * 60 * 24));
}

// Every night of a stay as 'YYYY-MM-DD' strings: arrival up to (not
// including) departure — the same convention calculateNights already
// implies (departure is checkout day, not a night stayed).
function getNightsInRange(arrival, departure) {
  const nights = [];
  let d = new Date(arrival);
  const end = new Date(departure);
  while (d < end) {
    nights.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return nights;
}

// Normalizes a DATE column value to 'YYYY-MM-DD' whether the driver
// returns it as a JS Date object or an already-formatted string — safer
// than assuming one or the other for something this payment-critical.
function toDateStr(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0];
  return String(val).slice(0, 10);
}

// Re-fetches and re-validates every selected paid amenity fresh from the
// database — never trusts price, name, or availability from the browser.
// Returns { amenityTotal, amenityDetails, error }. On any invalid
// selection (wrong listing, inactive, a date outside the amenity's
// availability window, or a date outside the stay itself), returns an
// error rather than silently dropping it — a payment total should never
// change quietly out from under what the guest actually selected.
async function validateAndPriceAmenities(sql, listingId, arrival, departure, requested) {
  if (!Array.isArray(requested) || requested.length === 0) {
    return { amenityTotal: 0, amenityDetails: [] };
  }
  if (requested.length > MAX_AMENITIES_PER_STAY) {
    return { error: 'Too many amenities selected for one stay.' };
  }

  const stayNights = new Set(getNightsInRange(arrival, departure));
  const amenityDetails = [];
  let amenityTotal = 0;

  for (const req of requested) {
    const amenityId = Number(req.amenityId);
    const dates = Array.isArray(req.dates) ? [...new Set(req.dates)] : [];
    if (!amenityId || dates.length === 0) continue;

    const rows = await sql`
      SELECT id, name, price, available_from, available_until, excluded_weekdays
      FROM listing_amenities
      WHERE id = ${amenityId} AND listing_id = ${listingId} AND is_active = TRUE
    `;
    const amenity = rows[0];
    if (!amenity) {
      return { error: `One of the selected amenities is no longer available. Please refresh and try again.` };
    }
    const excludedWeekdays = Array.isArray(amenity.excluded_weekdays) ? amenity.excluded_weekdays : [];

    for (const date of dates) {
      if (!stayNights.has(date)) {
        return { error: `${amenity.name}: selected date ${date} isn't part of this stay.` };
      }
      // getDay() on a 'YYYY-MM-DD' string parses as UTC midnight, which
      // matches how getNightsInRange built these same strings above — no
      // timezone drift between the two.
      const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
      if (excludedWeekdays.includes(weekday)) {
        return { error: `${amenity.name} isn't available on ${date} (unavailable on that day of the week).` };
      }
      if (amenity.available_from && date < toDateStr(amenity.available_from)) {
        return { error: `${amenity.name} isn't available on ${date}.` };
      }
      if (amenity.available_until && date > toDateStr(amenity.available_until)) {
        return { error: `${amenity.name} isn't available on ${date}.` };
      }
    }

    const price = Number(amenity.price);
    const total = price * dates.length;
    amenityTotal += total;
    amenityDetails.push({ id: amenity.id, name: amenity.name, pricePerNight: price, dates, total });
  }

  return { amenityTotal, amenityDetails };
}

// Computes the discount for one candidate — either the listing's
// standing discount fields, or one row from listing_promotions — given
// they've already passed their own eligibility checks (min nights, date
// range). Shared so both sources price identically.
function discountAmountFor(discountType, discountValue, subtotalBeforeDiscount) {
  if (discountType === 'percentage') {
    return Math.round(subtotalBeforeDiscount * (Number(discountValue) / 100));
  }
  if (discountType === 'flat') {
    return Math.min(Number(discountValue), subtotalBeforeDiscount);
  }
  return 0;
}

// A stay can be eligible for more than one discount at once: the
// listing's single "standing" discount (discount_type/discount_value on
// listings itself) and/or any number of date-scoped promotions
// (listing_promotions — see update-listing-pricing.js). Rather than
// stacking them, the guest simply gets whichever single one saves them
// the most. A promotion applies when the stay's arrival date falls
// within [start_date, end_date) and nights meets its own min_nights, if
// any — same inclusive-start/exclusive-end convention used everywhere
// else in this codebase.
function calculateDiscount(listing, nights, arrival, subtotalBeforeDiscount, promotions) {
  const candidates = [];

  if (listing.discount_type && listing.discount_value) {
    if (!listing.discount_min_nights || nights >= listing.discount_min_nights) {
      candidates.push(discountAmountFor(listing.discount_type, listing.discount_value, subtotalBeforeDiscount));
    }
  }

  for (const promo of promotions || []) {
    if (!promo.is_active) continue;
    if (promo.min_nights && nights < promo.min_nights) continue;
    const arrivalStr = arrival; // already 'YYYY-MM-DD'
    const startStr = toDateStr(promo.start_date);
    const endStr = toDateStr(promo.end_date);
    if (arrivalStr < startStr || arrivalStr >= endStr) continue;
    candidates.push(discountAmountFor(promo.discount_type, promo.discount_value, subtotalBeforeDiscount));
  }

  return candidates.length ? Math.max(...candidates) : 0;
}

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
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { stays, experiences, email, preferredCurrency, couponCode } = req.body;
    const safeStays = Array.isArray(stays) ? stays : [];
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

    let grandSubtotal = 0;
    let grandDiscount = 0;
    let grandGuestServiceFee = 0;
    let grandDeposit = 0;
    const stayDetails = [];
    const experienceDetails = [];
    const seenListingIds = new Set();

    for (let i = 0; i < safeStays.length; i++) {
      const s = safeStays[i];
      if (!s.listingId || !s.arrival || !s.departure || !s.guests) {
        return res.status(400).json({ error: `Stay ${i + 1}: missing home selection, dates, or guest count` });
      }

      // Each property can only appear once per booking request.
      if (seenListingIds.has(s.listingId)) {
        return res.status(400).json({ error: `Stay ${i + 1} repeats a home already used in this request.` });
      }
      seenListingIds.add(s.listingId);

      // The listing is looked up fresh from the database — this is the
      // "validate against what the owner actually shared" step. A listing
      // that's been rejected, deleted, or never approved can't be booked,
      // no matter what the browser sends.
      const rows = await sql`
        SELECT id, property_name, nightly_rate, discount_type, discount_value,
               discount_min_nights, commission_rate, security_deposit,
               pet_friendly, max_pets_allowed, pet_fee, allowed_pet_types
        FROM listings
        WHERE id = ${s.listingId} AND status = 'approved'
      `;
      const listing = rows[0];
      if (!listing) {
        return res.status(400).json({ error: `Stay ${i + 1}: this home is no longer available to book.` });
      }
      if (!listing.nightly_rate) {
        return res.status(400).json({ error: `Stay ${i + 1}: ${listing.property_name} doesn't have a rate set yet.` });
      }

      const nights = calculateNights(s.arrival, s.departure);
      const guests = Number(s.guests);
      if (!nights || nights <= 0 || !guests || guests < 1) {
        return res.status(400).json({ error: `Stay ${i + 1}: invalid dates or guest count` });
      }

      // A stay must include at least one adult (18+) — children and
      // infants can't be the sole guest(s) on a booking. Enforced here,
      // not just via the guest-count stepper's floor on the frontend
      // (index.html's lgCounts), since that's a UI convenience a direct
      // API call could bypass — this is the actual guarantee. Note this
      // can't verify anyone's real age; like every booking platform, it
      // relies on the guest accurately representing their party.
      const adults = Number(s.adults);
      if (!adults || adults < 1) {
        return res.status(400).json({ error: `Stay ${i + 1}: at least one adult (18+) guest is required — children or infants can't book a stay on their own.` });
      }

      // ---- Availability, checked here for real (not just in the search
      // results the guest happened to click through from) ----
      // 1. Host-blocked dates (maintenance, personal use, etc. — see
      //    update-listing-pricing.js / listing_blocked_dates).
      // 2. Any other already-PAID booking on this same listing that
      //    overlaps. get-listings.js's search already excludes listings
      //    with an overlap for the dates a guest searched, but that's a
      //    point-in-time filter — nothing stopped two guests racing to
      //    pay for the same dates, or a guest paying from a stale page.
      //    This is the actual guarantee against a double-booked stay.
      const blockedRows = await sql`
        SELECT 1 FROM listing_blocked_dates
        WHERE listing_id = ${listing.id}
          AND start_date < ${s.departure}::date
          AND end_date > ${s.arrival}::date
        LIMIT 1
      `;
      if (blockedRows[0]) {
        return res.status(400).json({ error: `Stay ${i + 1}: ${listing.property_name} isn't available for those dates.` });
      }
      const overlapRows = await sql`
        SELECT 1 FROM orders
        WHERE listing_id = ${listing.id} AND status = 'paid'
          AND arrival < ${s.departure}::date AND departure > ${s.arrival}::date
        LIMIT 1
      `;
      if (overlapRows[0]) {
        return res.status(400).json({ error: `Stay ${i + 1}: ${listing.property_name} was just booked for those dates. Please choose different dates.` });
      }

      const rate = Number(listing.nightly_rate);
      const roomTotal = rate * nights;
      const extraGuests = Math.max(guests - BASE_OCCUPANCY, 0);
      const extraTotal = extraGuests * EXTRA_GUEST_RATE * nights;
      const beforeDiscount = roomTotal + extraTotal;
      const promoRows = await sql`
        SELECT discount_type, discount_value, min_nights, start_date, end_date, is_active
        FROM listing_promotions
        WHERE listing_id = ${listing.id} AND is_active = TRUE
      `;
      const discountAmount = calculateDiscount(listing, nights, s.arrival, beforeDiscount, promoRows);

      // Amenities are priced fresh from the database and are never
      // discounted — the discount applies to the room rate only, not to
      // optional add-ons chosen on top of it.
      const { amenityTotal, amenityDetails, error: amenityError } = await validateAndPriceAmenities(
        sql, listing.id, s.arrival, s.departure, s.selectedAmenities
      );
      if (amenityError) {
        return res.status(400).json({ error: `Stay ${i + 1}: ${amenityError}` });
      }

      // Pets — charged PER PET, per stay (not a single flat fee no
      // matter how many), validated against the listing's own policy the
      // same way amenities are: never trusted from the browser alone.
      const requestedPets = Number(s.pets) || 0;
      if (requestedPets > 0 && !listing.pet_friendly) {
        return res.status(400).json({ error: `Stay ${i + 1}: ${listing.property_name} doesn't allow pets.` });
      }
      if (listing.max_pets_allowed != null && requestedPets > Number(listing.max_pets_allowed)) {
        return res.status(400).json({ error: `Stay ${i + 1}: ${listing.property_name} allows at most ${listing.max_pets_allowed} pet(s).` });
      }
      // What kind of pet, not just how many — a host who only allows
      // Dogs shouldn't discover a turtle showed up because "pets" was
      // just a headcount with no species attached. Every listed type
      // has to be one the listing actually allows.
      const requestedPetTypes = Array.isArray(s.petTypes) ? s.petTypes.filter(t => typeof t === 'string') : [];
      if (requestedPets > 0) {
        const allowedTypes = Array.isArray(listing.allowed_pet_types) ? listing.allowed_pet_types : [];
        if (!requestedPetTypes.length) {
          return res.status(400).json({ error: `Stay ${i + 1}: please specify what kind of pet(s) you're bringing.` });
        }
        const disallowed = requestedPetTypes.filter(t => !allowedTypes.includes(t));
        if (disallowed.length) {
          return res.status(400).json({ error: `Stay ${i + 1}: ${listing.property_name} doesn't allow ${disallowed.join(', ')}.` });
        }
      }
      const petFeeAmount = requestedPets > 0 ? Math.round(Number(listing.pet_fee || 0) * requestedPets) : 0;

      const roomPortion = beforeDiscount - discountAmount; // room + extra guests, after discount, never includes amenities
      const staySubtotal = roomPortion + amenityTotal + petFeeAmount;
      const baseCommission = Math.round(roomPortion * (BASE_COMMISSION_RATE / 100));
      // Pet fee is commissioned at the same rate as paid amenities — both
      // are optional, host-set extras layered on top of the room rate,
      // not the base booking itself. Folded into amenityCommission
      // (rather than a new field) so verify-payment.js's existing
      // commissionAmount = baseCommission + amenityCommission logic picks
      // it up automatically, with no changes needed there.
      const amenityCommission = Math.round((amenityTotal + petFeeAmount) * (AMENITY_COMMISSION_RATE / 100));
      // Flat rate on the whole stay subtotal — added on top of what the
      // guest pays, never subtracted from what the host receives.
      const guestServiceFee = Math.round(staySubtotal * (GUEST_SERVICE_FEE_RATE / 100));

      // Refundable security deposit — the host's own per-listing amount,
      // charged in full on top of everything else. Never discounted,
      // never commissioned, never counted as Aerva revenue: it's held,
      // not earned, and normally goes straight back to the guest (see
      // verify-payment.js for how the 7-day hold and release works).
      const depositAmount = listing.security_deposit ? Number(listing.security_deposit) : 0;

      grandSubtotal += staySubtotal;
      grandDiscount += discountAmount;
      grandGuestServiceFee += guestServiceFee;
      grandDeposit += depositAmount;

      stayDetails.push({
        listingId: listing.id,
        suite: listing.property_name,
        arrival: s.arrival,
        departure: s.departure,
        guests,
        nights,
        subtotal: staySubtotal,
        discountAmount,
        extraGuestCharge: extraTotal, // broken out for the guest-facing summary
        petFeeAmount, // broken out for the guest-facing summary
        petTypes: requestedPetTypes, // trusted server-side validated list, not re-trusted from the browser at verify time
        roomPortion,
        baseCommission,
        amenityCommission,
        guestServiceFee,
        depositAmount,
        amenities: amenityDetails,
      });
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

      const rows = await sql`
        SELECT id, property_name, nightly_rate, experience_price_unit, commission_rate
        FROM listings
        WHERE id = ${ex.listingId} AND status = 'approved' AND listing_type = 'experience'
      `;
      const experience = rows[0];
      if (!experience) {
        return res.status(400).json({ error: `Experience ${i + 1}: this experience is no longer available to book.` });
      }
      if (!experience.nightly_rate) {
        return res.status(400).json({ error: `Experience ${i + 1}: ${experience.property_name} doesn't have a price set yet.` });
      }

      const guests = Number(ex.guests) || 1;
      if (guests < 1) {
        return res.status(400).json({ error: `Experience ${i + 1}: invalid guest count` });
      }

      const price = Number(experience.nightly_rate);
      const subtotal = experience.experience_price_unit === 'per_person' ? price * guests : price;
      const commissionRate = BASE_COMMISSION_RATE;
      const commissionAmount = Math.round(subtotal * (commissionRate / 100));
      const guestServiceFee = Math.round(subtotal * (GUEST_SERVICE_FEE_RATE / 100));

      grandSubtotal += subtotal;
      grandGuestServiceFee += guestServiceFee;

      experienceDetails.push({
        listingId: experience.id,
        suite: experience.property_name,
        date: ex.date,
        guests,
        subtotal,
        commissionRate,
        commissionAmount,
        guestServiceFee,
      });
    }

    const gst = Math.round(grandSubtotal * GST_RATE);
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
    if (couponCode && String(couponCode).trim()) {
      if (!guestId) {
        return res.status(400).json({ error: 'Please log in to your account to use a coupon.' });
      }
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
        return res.status(400).json({ error: coupon.status === 'redeemed' ? 'This coupon has already been used.' : 'This coupon is no longer valid.' });
      }
      if (new Date(coupon.expires_at) < new Date()) {
        return res.status(400).json({ error: 'This coupon has expired.' });
      }
      // Never let a coupon discount a booking below zero, and never
      // discount more than the coupon is actually worth.
      appliedCouponDiscount = Math.min(Number(coupon.amount), totalRupees);
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
        // Razorpay notes have a size limit we haven't hit in practice yet,
        // but amenities make this payload meaningfully bigger than before
        // — if bookings with several amenities/dates start failing here,
        // this is the first place to check (may need a shorter encoding,
        // or storing full details in our own DB keyed by a short token
        // instead of putting everything in Razorpay's notes directly).
        stays: JSON.stringify(stayDetails).slice(0, 4000),
        experiences: JSON.stringify(experienceDetails).slice(0, 2000),
      },
    });

    return res.status(200).json({
      orderId: order.id,
      chargeCurrency,
      chargeAmount,
      amount: order.amount,
      currency: order.currency,
      totalDeposit: grandDeposit,
      couponDiscount: appliedCouponDiscount || 0,
    });
  } catch (err) {
    console.error('create-order error:', err);
    return res.status(500).json({ error: 'Could not create order' });
  }
};
