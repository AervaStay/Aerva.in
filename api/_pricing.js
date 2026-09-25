// /api/_pricing.js — how a stay is priced. Not an endpoint.
//
// The single source of truth for a stay's price: used by create-order.js
// for a new booking and by _booking-changes.js to price a change to an
// existing one, so both always charge by exactly the same rules. Everything
// is read fresh from the database — never trusted from the browser.
// Moved here unchanged from create-order.js (Sept 2026).

const { stayGst, experienceGst } = require('./_gst');
const { earliestArrival } = require('./_booking-rules');

const EXTRA_GUEST_RATE = 1500;
const BASE_OCCUPANCY = 2;
const BASE_COMMISSION_RATE = 10; // on room + extra-guest charges, after any discount
const AMENITY_COMMISSION_RATE = 5; // on paid amenities
const GUEST_SERVICE_FEE_RATE = 8;
const MAX_STAYS = 5; // matches the frontend cap — reject anything absurd
const MAX_EXPERIENCES = 5; // same reasoning, for the experiences array
const MAX_AMENITIES_PER_STAY = 15;

// listings.max_guests and listings.bedrooms are TEXT columns. Newer
// listings hold a bare number, but older ones hold what the old
// submission form allowed — "3–4", "9+", "Up to 8". The largest number
// in the value is the reading, matching what search has always done.
// Returns null when there is no number at all, which callers must treat
// as "unknown", never as zero.
//
// Lives here, and is exported, so there is ONE of it: get-listings.js had
// the only copy and everything that priced or booked a stay used a plain
// Number() instead, which is how capacity came to be enforced in search
// but not at checkout.
function parseMaxGuests(raw) {
  if (!raw) return null;
  const numbers = String(raw).match(/\d+/g);
  if (!numbers) return null;
  return Math.max(...numbers.map(Number));
}

function calculateNights(arrival, departure) {
  const arrivalDate = new Date(arrival);
  const departureDate = new Date(departure);
  return Math.round((departureDate - arrivalDate) / (1000 * 60 * 60 * 24));
}

// 'YYYY-MM-DD' + N days -> 'YYYY-MM-DD', for computing a multi-day
// experience's end date from its start date and the host's set duration.
function addDaysToDateStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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


// Prices one stay. s: { listingId, roomId, arrival, departure, guests, adults,
// pets, petTypes, serviceAnimals, youngLitterCount, selectedAmenities,
// includedWithExperienceId }. i: its position (for messages).
// excludeOrderId: when pricing a CHANGE to a booking, that booking's own
// nights do not count as taken. Returns { detail } or { error }.
async function priceStay(sql, s, i, { excludeOrderId = null } = {}) {
  if (!s.listingId || !s.arrival || !s.departure || !s.guests) {
    return { error: `Stay ${i + 1}: missing home selection, dates, or guest count` };
  }

      // The listing is looked up fresh from the database — this is the
      // "validate against what the owner actually shared" step. A listing
      // that's been rejected, deleted, or never approved can't be booked,
      // no matter what the browser sends.
      const rows = await sql`
        SELECT id, property_name, nightly_rate, discount_type, discount_value,
               discount_min_nights, commission_rate, security_deposit,
               pet_friendly, max_pets_allowed, pet_fee, allowed_pet_types,
               max_guests, property_type, timezone
        FROM listings
        WHERE id = ${s.listingId} AND status = 'approved'
      `;
      const listing = rows[0];
      if (!listing) {
        return { error: `Stay ${i + 1}: this home is no longer available to book.` };
      }

      // A Resort's real price and capacity live on the SPECIFIC ROOM
      // being booked, never on the listing itself — the listing's own
      // nightly_rate for a Resort is just the cheapest active room's
      // price (used for card display/sorting), not what any particular
      // room actually costs. Using it directly here would have meant a
      // guest booking an expensive room could be charged the cheapest
      // room's rate instead. room stays null for a non-Resort stay,
      // where the listing's own fields are correctly authoritative.
      let room = null;
      if (listing.property_type === 'Resort') {
        if (!s.roomId) {
          return { error: `Stay ${i + 1}: please select a specific room for this resort.` };
        }
        const roomRows = await sql`
          SELECT id, room_name, max_occupancy, nightly_rate, is_active
          FROM listing_rooms WHERE id = ${s.roomId} AND listing_id = ${listing.id}
        `;
        room = roomRows[0];
        if (!room || !room.is_active) {
          return { error: `Stay ${i + 1}: this room is no longer available to book.` };
        }
        if (!room.nightly_rate) {
          return { error: `Stay ${i + 1}: this room doesn't have a rate set yet.` };
        }
      } else if (!listing.nightly_rate) {
        return { error: `Stay ${i + 1}: ${listing.property_name} doesn't have a rate set yet.` };
      }

      const nights = calculateNights(s.arrival, s.departure);
      const guests = Number(s.guests);
      if (!nights || nights <= 0 || !guests || guests < 1) {
        return { error: `Stay ${i + 1}: invalid dates or guest count` };
      }
      // Dates must be real calendar dates, and not in the past on the
      // property's clock — except a late-night booking: between 12:00 AM and
      // 6:00 AM the night is still counted as the previous day's, so
      // yesterday's date may be booked as arrival (_booking-rules.js).
      // A change to a booking already under way keeps its original arrival.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.arrival)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(s.departure))) {
        return { error: `Stay ${i + 1}: invalid dates` };
      }
      if (!s.keepArrival && String(s.arrival) < earliestArrival(listing.timezone)) {
        return { error: `Stay ${i + 1}: check-in cannot be in the past. Please choose today or a later date.` };
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
        return { error: `Stay ${i + 1}: at least one adult (18+) guest is required — children or infants can't book a stay on their own.` };
      }

      // A stay is a single physical unit (a villa, a studio, a room) —
      // priced flat per night regardless of how many people are in it,
      // but still genuinely limited by how many people can actually fit.
      // For a Resort this checks the SPECIFIC room's own capacity, not
      // any listing-level number (which isn't meaningful for a Resort).
      // parseMaxGuests, not Number(). listings.max_guests is a TEXT
      // column and older listings hold values like "3–4", "9+" or
      // "Up to 8" rather than a bare number. Number("3–4") is NaN,
      // NaN > 0 is false, and the whole check below was therefore
      // SKIPPED for those listings — a four-person villa would accept a
      // booking for fifty. Search never had the bug (get-listings.js has
      // always parsed the same values properly), so such a listing turned
      // up correctly in results and then went unchecked at checkout.
      // listing_rooms.max_occupancy is a real integer, so it needs none
      // of this.
      const capacityLimit = room ? Number(room.max_occupancy) : parseMaxGuests(listing.max_guests);
      if (capacityLimit > 0 && guests > capacityLimit) {
        return {
          error: room
            ? `Stay ${i + 1}: ${room.room_name || 'This room'} sleeps up to ${capacityLimit} guests, but ${guests} were requested. Please choose a larger room or book an additional room for the rest of your group.`
            : `Stay ${i + 1}: ${listing.property_name} sleeps up to ${capacityLimit} guests, but ${guests} were requested. Please reduce the guest count or book an additional stay for the rest of your group.`
        };
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
      // A NULL room_id on listing_blocked_dates blocks the WHOLE listing
      // (e.g. the resort's grounds are shut for a day) — always checked.
      // A room_id-specific block only applies to that one room, so for a
      // non-Resort stay (room is null) this condition is simply skipped,
      // matching the old listing-wide-only behavior exactly.
      const blockedRows = await sql`
        SELECT 1 FROM listing_blocked_dates
        WHERE listing_id = ${listing.id}
          AND (room_id IS NULL OR room_id = ${room ? room.id : null})
          AND start_date < ${s.departure}::date
          AND end_date > ${s.arrival}::date
        LIMIT 1
      `;
      if (blockedRows[0]) {
        return { error: `Stay ${i + 1}: ${room ? (room.room_name || 'This room') : listing.property_name} isn't available for those dates.` };
      }
      // For a Resort, only an existing PAID booking of the SAME room
      // counts as an overlap — a different room at the same resort being
      // booked for the same dates is completely fine and expected. This
      // was previously checked at the whole-listing level, which meant
      // one room's booking could incorrectly block every other room at
      // the same resort from ever being booked for those dates.
      const overlapRows = room
        ? await sql`
            SELECT 1 FROM orders
            WHERE room_id = ${room.id} AND status = 'paid'
              AND arrival < ${s.departure}::date AND departure > ${s.arrival}::date
              AND (${excludeOrderId}::int IS NULL OR id <> ${excludeOrderId}::int)
            LIMIT 1
          `
        : await sql`
            SELECT 1 FROM orders
            WHERE listing_id = ${listing.id} AND status = 'paid'
              AND arrival < ${s.departure}::date AND departure > ${s.arrival}::date
              AND (${excludeOrderId}::int IS NULL OR id <> ${excludeOrderId}::int)
            LIMIT 1
          `;
      if (overlapRows[0]) {
        return { error: `Stay ${i + 1}: ${room ? (room.room_name || 'This room') : listing.property_name} was just booked for those dates. Please choose different dates.` };
      }

      // Rounded, because Aerva deals in whole rupees: every money column
      // on orders (subtotal, gst, total, commission_amount, payout_amount)
      // is an integer. listing_rooms.nightly_rate is numeric and could
      // hold 4999.50, which gave a subtotal of 14998.5 on a three-night
      // stay — quoted to the guest with the paise, then SILENTLY ROUNDED
      // to 14999 by Postgres on the way into orders.subtotal, so the
      // record and the charge disagreed. listings.nightly_rate is already
      // an integer column and never had the problem.
      const rate = room ? Math.round(Number(room.nightly_rate)) : Number(listing.nightly_rate);
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
        return { error: `Stay ${i + 1}: ${amenityError}` };
      }

      // Pets — charged PER PET, per stay (not a single flat fee no
      // matter how many), validated against the listing's own policy the
      // same way amenities are: never trusted from the browser alone.
      const requestedPets = Number(s.pets) || 0;
      if (requestedPets > 0 && !listing.pet_friendly) {
        return { error: `Stay ${i + 1}: ${listing.property_name} doesn't allow pets.` };
      }
      if (listing.max_pets_allowed != null && requestedPets > Number(listing.max_pets_allowed)) {
        return { error: `Stay ${i + 1}: ${listing.property_name} allows at most ${listing.max_pets_allowed} pet(s).` };
      }
      // What kind of pet, not just how many — a host who only allows
      // Dogs shouldn't discover a turtle showed up because "pets" was
      // just a headcount with no species attached. Every listed type
      // has to be one the listing actually allows.
      const requestedPetTypes = Array.isArray(s.petTypes) ? s.petTypes.filter(t => typeof t === 'string') : [];
      if (requestedPets > 0) {
        const allowedTypes = Array.isArray(listing.allowed_pet_types) ? listing.allowed_pet_types : [];
        if (!requestedPetTypes.length) {
          return { error: `Stay ${i + 1}: please specify what kind of pet(s) you're bringing.` };
        }
        const disallowed = requestedPetTypes.filter(t => !allowedTypes.includes(t));
        if (disallowed.length) {
          return { error: `Stay ${i + 1}: ${listing.property_name} doesn't allow ${disallowed.join(', ')}.` };
        }
      }
      const petFeeAmount = requestedPets > 0 ? Math.round(Number(listing.pet_fee || 0) * requestedPets) : 0;

      // Service / support animals and young litter: never counted or
      // charged, but the host needs to know before the guest arrives, so
      // they travel with the booking (see verify-payment.js). Each service
      // animal is its type as chosen on the booking page; young litter is
      // a count, and only means something alongside a pet.
      const requestedServiceAnimals = (Array.isArray(s.serviceAnimals) ? s.serviceAnimals : [])
        .map(a => (a && typeof a === 'object') ? a.type : a)
        .filter(t => typeof t === 'string' && t.trim())
        .map(t => t.trim().slice(0, 30))
        .slice(0, 5);
      const requestedYoungLitter = requestedPets > 0
        ? Math.max(0, Math.min(10, Math.floor(Number(s.youngLitterCount)) || 0))
        : 0;
      // One service / support animal per booking is free. Each one after
      // the first is charged at the listing's pet fee, the same way a pet
      // is — it is not counted toward the pet limit, only charged.
      const chargeableServiceAnimals = Math.max(0, requestedServiceAnimals.length - 1);
      const serviceAnimalFee = Math.round(Number(listing.pet_fee || 0) * chargeableServiceAnimals);
      const animalFees = petFeeAmount + serviceAnimalFee;

      const roomPortion = beforeDiscount - discountAmount; // room + extra guests, after discount, never includes amenities
      const staySubtotal = roomPortion + amenityTotal + animalFees;
      const baseCommission = Math.round(roomPortion * (BASE_COMMISSION_RATE / 100));
      // Pet fee is commissioned at the same rate as paid amenities — both
      // are optional, host-set extras layered on top of the room rate,
      // not the base booking itself. Folded into amenityCommission
      // (rather than a new field) so verify-payment.js's existing
      // commissionAmount = baseCommission + amenityCommission logic picks
      // it up automatically, with no changes needed there.
      const amenityCommission = Math.round((amenityTotal + animalFees) * (AMENITY_COMMISSION_RATE / 100));
      // Flat rate on the whole stay subtotal — added on top of what the
      // guest pays, never subtracted from what the host receives.
      const guestServiceFee = Math.round(staySubtotal * (GUEST_SERVICE_FEE_RATE / 100));

      // Refundable security deposit — the host's own per-listing amount,
      // charged in full on top of everything else. Never discounted,
      // never commissioned, never counted as Aerva revenue: it's held,
      // not earned, and normally goes straight back to the guest (see
      // verify-payment.js for how the 7-day hold and release works).
      const depositAmount = listing.security_deposit ? Number(listing.security_deposit) : 0;

      // GST for this stay: rate from the per-night value of the room
      // itself, applied to the room plus its amenities and pet fees.
      const stayTax = stayGst({ roomPortion, nights, extras: amenityTotal + animalFees });

      return { detail: {
        listingId: listing.id,
        roomId: room ? room.id : null,
        suite: room ? `${listing.property_name} — ${room.room_name || 'Room'}` : listing.property_name,
        arrival: s.arrival,
        departure: s.departure,
        guests,
        nights,
        subtotal: staySubtotal,
        discountAmount,
        extraGuestCharge: extraTotal, // broken out for the guest-facing summary
        petFeeAmount, // broken out for the guest-facing summary
        serviceAnimalFee,
        petTypes: requestedPetTypes, // trusted server-side validated list, not re-trusted from the browser at verify time
        serviceAnimals: requestedServiceAnimals,
        youngLitterCount: requestedYoungLitter,
        roomPortion,
        baseCommission,
        amenityCommission,
        guestServiceFee,
        depositAmount,
        gst: stayTax.gst,
        gstRate: stayTax.rate,
        // Set when these nights came with a with_stay experience.
        withExperienceId: s.includedWithExperienceId || null,
        amenities: amenityDetails,
      } };
}

// Prices one experience. ex: { listingId, date, guests }. i: its position.
// Moved from create-order.js; the season check now compares real dates
// (the database returns DATE columns as Date objects, which a text
// comparison never matched — so the season was never enforced).
// Returns { detail } or { error }.
async function priceExperience(sql, ex, i) {
  if (!ex.listingId || !ex.date) return { error: `Experience ${i + 1}: missing selection or date` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ex.date))) return { error: `Experience ${i + 1}: invalid date` };
  const rows = await sql`
    SELECT id, property_name, nightly_rate, experience_price_unit, commission_rate, timezone,
           experience_available_from, experience_available_until, experience_duration_days,
           discount_type, discount_value, discount_min_nights
    FROM listings
    WHERE id = ${ex.listingId} AND status = 'approved' AND listing_type = 'experience'
  `;
  const experience = rows[0];
  if (!experience) return { error: `Experience ${i + 1}: this experience is no longer available to book.` };
  if (!experience.nightly_rate) return { error: `Experience ${i + 1}: ${experience.property_name} doesn't have a price set yet.` };
  if (!ex.keepDate && String(ex.date) < earliestArrival(experience.timezone)) {
    return { error: `Experience ${i + 1}: the date cannot be in the past.` };
  }
  const durationDays = experience.experience_duration_days && experience.experience_duration_days >= 1 ? experience.experience_duration_days : 1;
  const endDateExclusive = addDaysToDateStr(ex.date, durationDays);
  const from = toDateStr(experience.experience_available_from);
  const until = toDateStr(experience.experience_available_until);
  if (from && ex.date < from) return { error: `Experience ${i + 1}: ${experience.property_name} isn't available until ${from}.` };
  if (until && addDaysToDateStr(ex.date, durationDays - 1) > until) return { error: `Experience ${i + 1}: ${experience.property_name} isn't available after ${until}.` };
  const blocked = await sql`
    SELECT 1 FROM listing_blocked_dates
    WHERE listing_id = ${ex.listingId} AND start_date < ${endDateExclusive}::date AND end_date > ${ex.date}::date
    LIMIT 1
  `;
  if (blocked[0]) return { error: `Experience ${i + 1}: ${experience.property_name} isn't available for those dates.` };
  const guests = Number(ex.guests) || 1;
  if (guests < 1) return { error: `Experience ${i + 1}: invalid guest count` };
  const price = Number(experience.nightly_rate);
  const subtotalBeforeDiscount = experience.experience_price_unit === 'per_person' ? price * guests : price;
  const promos = await sql`
    SELECT is_active, discount_type, discount_value, min_nights, start_date, end_date
    FROM listing_promotions
    WHERE listing_id = ${ex.listingId} AND is_active = TRUE AND end_date > CURRENT_DATE
  `;
  const subtotal = subtotalBeforeDiscount - calculateDiscount(experience, durationDays, ex.date, subtotalBeforeDiscount, promos);
  const commissionRate = BASE_COMMISSION_RATE;
  const commissionAmount = Math.round(subtotal * (commissionRate / 100));
  const guestServiceFee = Math.round(subtotal * (GUEST_SERVICE_FEE_RATE / 100));
  const expTax = experienceGst(subtotal);
  return { detail: {
    listingId: experience.id, suite: experience.property_name, date: ex.date, endDate: endDateExclusive, durationDays, guests,
    subtotal, commissionRate, commissionAmount, guestServiceFee, gst: expTax.gst, gstRate: expTax.rate
  } };
}

module.exports = {
  EXTRA_GUEST_RATE, BASE_OCCUPANCY, BASE_COMMISSION_RATE, AMENITY_COMMISSION_RATE, GUEST_SERVICE_FEE_RATE,
  MAX_STAYS, MAX_EXPERIENCES, MAX_AMENITIES_PER_STAY,
  calculateNights, addDaysToDateStr, getNightsInRange, toDateStr, validateAndPriceAmenities,
  discountAmountFor, calculateDiscount, priceStay, priceExperience, parseMaxGuests
};
