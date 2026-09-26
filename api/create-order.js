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
const { sessionStatus } = require('./_accounts');
const { getClientIp, countRecentAttempts } = require('./_rate-limit');
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
const { RELEASE_REASONS } = require('./_booking-rules');

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
const { normalizeToE164 } = require('./_phone-validation');
const crypto = require('crypto');
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

// Booking needs an Aerva account (_guest-id.js): the session token's guest
// id is read here and stored with the cart, so the eventual order rows are
// linked to the account. Returns { guestId, payload }; guestId is null when
// there is no valid session — fine for a price quote, refused for a
// booking by assertCanBook below. The payload is what sessionRefusal
// checks against the account (logged out everywhere, deleted).
function getOptionalGuestId(req) {
  const authHeader = req.headers['authorization'] || '';
  const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!sessionToken) return { guestId: null, payload: null };
  const payload = verifyToken(sessionToken);
  if (!payload || payload.action !== 'guest-session') return { guestId: null, payload: null };
  return { guestId: payload.listingId, payload }; // generically-named token field — see host-auth.js note; here it's the guest's id
}

// A signed session token stays valid until it expires, so it is checked
// against the account too: logged out everywhere, or deleted, and it is
// refused. Returns the error to send, or null. Fails closed (_accounts.js).
async function sessionRefusal(payload) {
  if (!payload) return null;
  const st = await sessionStatus(sql, payload);
  if (st === 'ok') return null;
  return st === 'deleted' ? 'This account has been deleted.' : 'Please log in again.';
}

// Price quotes need no account, so they are limited per address instead:
// 60 a minute. Counted in this instance's memory (free, best effort); an
// address that goes over is written to audit_log once, and from then on
// any instance it reaches checks that record once it is busy there too —
// so the database is only read for heavy callers, and written once a
// minute at most per address.
const QUOTE_LIMIT_PER_MINUTE = 60;
const QUOTE_DB_CHECK_AFTER = 20;
const quoteCounts = new Map();
async function quoteRateLimited(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  let e = quoteCounts.get(ip);
  if (!e || now - e.start > 60 * 1000) {
    if (quoteCounts.size > 5000) quoteCounts.clear(); // never grows without bound
    e = { start: now, n: 0, logged: false, flaggedElsewhere: null };
    quoteCounts.set(ip, e);
  }
  e.n += 1;
  if (e.n > QUOTE_LIMIT_PER_MINUTE) {
    if (!e.logged) {
      e.logged = true;
      await logAudit(sql, { action: 'quote_rate_limited', success: false, actorType: 'system', actorIdentifier: 'create-order', metadata: { ip } });
    }
    return true;
  }
  if (e.n > QUOTE_DB_CHECK_AFTER && e.flaggedElsewhere === null) {
    e.flaggedElsewhere = (await countRecentAttempts(sql, { action: 'quote_rate_limited', windowMinutes: 5, byIp: ip })) > 0;
  }
  return !!e.flaggedElsewhere;
}

// Pricing messages start "Stay 1:" / "Experience 1:" so a cart of several
// items says which one is wrong. On a page booking one thing that is just
// noise, so it is dropped there.
function plainError(message, itemCount) {
  const m = String(message || '');
  if (itemCount !== 1) return m;
  const t = m.replace(/^(Stay|Experience) \d+: /, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// The breakdown a guest sees: the price quote, and the "prices have been
// changed recently" answer. Amounts in rupees; the page formats them.
function priceLines(stayDetails, experienceDetails, { gst, fee, deposit, coupon = 0 }) {
  const lines = [];
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  stayDetails.forEach(x => {
    const roomTotal = x.roomPortion + x.discountAmount - x.extraGuestCharge;
    lines.push({ kind: 'room', item: x.suite, label: `${x.suite} — ${plural(x.nights, 'night')}`, amount: roomTotal,
                 rate: x.nights ? Math.round(roomTotal / x.nights) : roomTotal, nights: x.nights, guests: x.guests, withExperience: !!x.withExperienceId });
    const extra = Math.max(0, x.guests - BASE_OCCUPANCY);
    if (x.extraGuestCharge) lines.push({ kind: 'extra', item: x.suite, label: `${plural(extra, 'extra guest')} (above ${BASE_OCCUPANCY})`, amount: x.extraGuestCharge });
    if (x.discountAmount) lines.push({ kind: 'discount', item: x.suite, label: 'Offer applied', amount: -x.discountAmount });
    if (x.petFeeAmount) lines.push({ kind: 'pets', item: x.suite, label: `Pet fee (${plural((x.petTypes || []).length, 'pet')})`, amount: x.petFeeAmount });
    if (x.serviceAnimalFee) lines.push({ kind: 'service', item: x.suite, label: 'Additional service or support animals', amount: x.serviceAnimalFee });
    const amenityTotal = (x.amenities || []).reduce((t, a) => t + Number(a.total || 0), 0);
    const amenityNights = (x.amenities || []).reduce((t, a) => t + (a.dates || []).length, 0);
    if (amenityTotal) lines.push({ kind: 'amenities', item: x.suite, label: `Amenities (${plural(amenityNights, 'night')})`, amount: amenityTotal });
  });
  experienceDetails.forEach(x => {
    const before = x.subtotalBeforeDiscount != null ? x.subtotalBeforeDiscount : x.subtotal;
    lines.push({ kind: 'experience', item: x.suite, label: x.priceUnit === 'per_person' ? `${x.suite} — ${plural(x.guests, 'guest')}` : x.suite,
                 amount: before, unitPrice: x.unitPrice, guests: x.guests, perPerson: x.priceUnit === 'per_person' });
    if (x.discountAmount) lines.push({ kind: 'discount', item: x.suite, label: 'Offer applied', amount: -x.discountAmount });
  });
  const rates = [...new Set([...stayDetails, ...experienceDetails].filter(x => Number(x.gst) > 0).map(x => x.gstRate))];
  if (gst) lines.push({ kind: 'gst', label: rates.length === 1 ? `GST (${rates[0]}%)` : 'GST', amount: gst });
  lines.push({ kind: 'fee', label: 'Guest service fee', amount: fee });
  if (deposit) lines.push({ kind: 'deposit', label: 'Refundable deposit (held 7 days)', amount: deposit });
  if (coupon) lines.push({ kind: 'coupon', label: 'Coupon', amount: -coupon });
  return lines;
}

// The phone typed at checkout goes on the account when the account has
// none — only a valid number, and only one no other account uses (the
// database allows each number once). Never throws.
async function savePhoneIfMissing(sql, guestId, raw) {
  const e164 = normalizeToE164(String(raw || '').slice(0, 40));
  if (!guestId || !e164) return false;
  try {
    const r = await sql`
      UPDATE guests SET phone = ${e164}
      WHERE id = ${guestId} AND (phone IS NULL OR btrim(phone) = '')
        AND NOT EXISTS (SELECT 1 FROM guests o WHERE o.id <> ${guestId} AND btrim(o.phone) = ${e164})
      RETURNING id`;
    return r.length > 0;
  } catch (err) { return false; }
}

// The name of the guest staying, kept on the account so it is filled in
// next time. first_name/last_name arrive with migration_guest_details.sql;
// the full-name fallback is written on its own so it is never lost when
// those columns are not there yet. Never throws.
async function saveGuestName(sql, guestId, first, last) {
  if (!guestId) return;
  try { await sql`UPDATE guests SET first_name = ${first}, last_name = ${last} WHERE id = ${guestId}`; }
  catch (err) { /* before migration_guest_details.sql */ }
  try { await sql`UPDATE guests SET name = COALESCE(NULLIF(btrim(name), ''), ${first + ' ' + last}) WHERE id = ${guestId}`; }
  catch (err) { console.error('guest name not saved:', err.message); }
}

// Is checkout_carts there? New bookings cannot be paid for without it.
async function cartsReady(sql) {
  try { await sql`SELECT 1 FROM checkout_carts LIMIT 0`; return true; } catch (err) { return false; }
}

// Razorpay allows at most 15 notes of 256 characters each. Checked before
// every order, so a note can never be cut off or refused after the fact.
const MAX_NOTES = 15;
const MAX_NOTE_CHARS = 256;
function assertNotesFit(notes) {
  const keys = Object.keys(notes);
  if (keys.length > MAX_NOTES) throw new Error(`Razorpay notes: ${keys.length} keys (max ${MAX_NOTES})`);
  keys.forEach(k => { if (String(notes[k]).length > MAX_NOTE_CHARS) throw new Error(`Razorpay notes: ${k} is ${String(notes[k]).length} characters (max ${MAX_NOTE_CHARS})`); });
  return notes;
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
  req.body = req.body || {};

  // The guest closed the payment window, the payment failed, or the page's
  // timer ran out: free the dates at once instead of waiting.
  // POST { releaseHold: '<razorpay order id>', reason: 'closed' | 'failed' | 'expired' | 'price_changed' }
  // A window the guest closed can never become a booking; one that ran out
  // of time still can within the 15-second grace (_booking-rules.js).
  if (req.body.releaseHold) {
    const asked = String(req.body.reason || 'closed');
    const reason = asked === 'failed' ? 'closed' : (RELEASE_REASONS.includes(asked) && asked !== 'paid' ? asked : 'closed');
    await releaseHolds(sql, { razorpayOrderId: String(req.body.releaseHold).slice(0, 64), reason });
    return res.status(200).json({ released: true });
  }
  // Paying the difference for a change the host accepted: the same strict
  // 90-second window as a booking (_booking-changes.js).
  // POST { payChange: <change id> } — signed-in guest only.
  if (req.body.payChange) {
    const { guestId: gid, payload } = getOptionalGuestId(req);
    if (!gid) return res.status(401).json({ error: 'Please log in again.' });
    const refused = await sessionRefusal(payload);
    if (refused) return res.status(401).json({ error: refused });
    try {
      const out = await startChangePayment(sql, razorpay, { changeId: Number(req.body.payChange) || 0, guestId: gid, ip: requestContext(req).ip || null });
      return res.status(200).json(Object.assign({}, out, { keyId: process.env.RAZORPAY_KEY_ID }));
    } catch (err) {
      if (!err.isUserFacing) console.error('payChange failed:', err);
      return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not start the payment. Please try again.' });
    }
  }
  // The page asks every few seconds while the payment window is open:
  // still running? timed out? did the host change a price? The window is
  // closed (and the dates released) the moment the answer is no.
  // POST { holdStatus: '<razorpay order id>' }
  if (req.body.holdStatus) {
    return res.status(200).json(await holdStatus(sql, String(req.body.holdStatus).slice(0, 64)));
  }
  // What the booking form can fill in for a signed-in guest.
  // POST { prefill: true } → { firstName, lastName, email, phone }
  if (req.body.prefill) {
    const { guestId: gid, payload } = getOptionalGuestId(req);
    if (!gid) return res.status(200).json({});
    const refused = await sessionRefusal(payload);
    if (refused) return res.status(401).json({ error: refused });
    try {
      const g = (await sql`SELECT email, name, phone, to_jsonb(guests)->>'first_name' AS first_name, to_jsonb(guests)->>'last_name' AS last_name
                           FROM guests WHERE id = ${gid} AND deleted_at IS NULL`)[0];
      if (!g) return res.status(200).json({});
      const parts = String(g.name || '').trim().split(/\s+/).filter(Boolean);
      return res.status(200).json({
        firstName: g.first_name || parts[0] || '', lastName: g.last_name || parts.slice(1).join(' ') || '',
        email: g.email || '', phone: g.phone || ''
      });
    } catch (err) { return res.status(200).json({}); }
  }

  // quoteOnly: price exactly as a booking would be charged, and change
  // nothing — no payment, no held dates, no agreement or account needed.
  // The booking pages show this, so the total a guest sees before paying
  // is the one computed by the same code that charges it.
  const quoteOnly = req.body.quoteOnly === true;
  if (quoteOnly && await quoteRateLimited(req)) {
    return res.status(429).json({ error: 'Too many price checks. Please wait a minute and try again.' });
  }
  let holdIds = [];
  try {
    const { stays, experiences, email, preferredCurrency, couponCode, pricesSeen } = req.body;

    const session = getOptionalGuestId(req);
    let guestId = session.guestId;
    let agreementNote = '';
    if (!quoteOnly) {
      // A session that was logged out everywhere, or a deleted account,
      // is refused before anything else.
      const refused = await sessionRefusal(session.payload);
      if (refused) return res.status(401).json({ error: refused });
      // The booking agreement must be accepted, in its current wording, before
      // any payment is created (aerva-policies.js → agreements.guest). What was
      // accepted, when and from where travels with the payment and is saved on
      // every booking row (_confirm-booking.js).
      if (req.body.agreementVersion !== AGREEMENT_VERSION) {
        return res.status(400).json({ error: 'Please read and accept the booking agreement to continue.', agreementVersion: AGREEMENT_VERSION });
      }
      agreementNote = [AGREEMENT_VERSION, new Date().toISOString(), requestContext(req).ip || ''].join('|').slice(0, 200);
    }

    // Anything the server alone decides is never taken from the browser:
    // the stay an experience includes, and keeping a past arrival (only a
    // change to a booking already under way may, _booking-changes.js).
    let safeStays = (Array.isArray(stays) ? stays : []).map(x => Object.assign({}, x, { includedWithExperienceId: undefined, keepArrival: undefined }));
    const safeExperiences = (Array.isArray(experiences) ? experiences : []).map(x => Object.assign({}, x, { keepDate: undefined }));
    const requestedItems = safeStays.length + safeExperiences.length;

    if (requestedItems === 0) {
      return res.status(400).json({ error: 'Please choose your dates first.' });
    }
    if (!quoteOnly && !String(email || '').trim()) {
      return res.status(400).json({ error: 'Please enter your email address.' });
    }
    if (safeStays.length > MAX_STAYS) {
      return res.status(400).json({ error: 'Too many stays in one booking. Please book them separately.' });
    }
    if (safeExperiences.length > MAX_EXPERIENCES) {
      return res.status(400).json({ error: 'Too many experiences in one booking. Please book them separately.' });
    }

    // The name of the guest staying, as given at checkout: it goes to the
    // host with the number of guests. Kept on the account for next time.
    const guestFirst = String(req.body.firstName || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const guestLast = String(req.body.lastName || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!quoteOnly) {
      if (!guestFirst || !guestLast) {
        return res.status(400).json({ error: 'Please give the first and last name of the guest staying.', needs: ['name'] });
      }
      await saveGuestName(sql, guestId, guestFirst, guestLast);

      // Every booking needs an account with a confirmed email and a phone
      // number (_guest-id.js). The phone typed at checkout is saved to the
      // account first if it has none. `needs` tells the page what to ask for.
      await savePhoneIfMissing(sql, guestId, req.body.phone);
      try { await assertCanBook(sql, guestId); }
      catch (err) {
        if (err.isUserFacing) return res.status(err.status).json({ error: err.message, needs: err.needs || [] });
        throw err;
      }
    }

    // Hosts and co-hosts cannot book listings they run: a self-booking pays
    // the booker's own payout, inflates ratings and blocks real guests'
    // dates. Checked on the server for every stay and experience in the cart.
    if (guestId && !quoteOnly) {
      const ids = [...new Set([]
        .concat(safeStays.map(x => Number(x && x.listingId)))
        .concat(safeExperiences.map(x => Number(x && x.listingId))))]
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

    // What was paid for is kept in checkout_carts (migration_checkout_carts.sql);
    // without that table a payment could not be matched to its booking, so
    // nothing is charged. Checked before any dates are held.
    if (!quoteOnly && !(await cartsReady(sql))) {
      console.error('create-order: checkout_carts table is missing — run sql/migration_checkout_carts.sql. Booking refused.');
      return res.status(503).json({ error: 'Booking is paused for a few minutes while we update the site. Nothing has been charged. Please try again shortly.' });
    }

    // ---- "Includes a Stay" experiences ----
    // An experience whose type is with_stay is sold together with nights
    // at the property that hosts it, paid for in ONE payment. The nights
    // are added here as an ordinary stay so they go through the same
    // path as any other: availability, blocked dates, max guests,
    // deposit, commission and GST all behave identically, with no second
    // copy of those rules to drift.
    //
    // The property, its rate and the number of nights all come from the
    // host's own experience record, never from the browser. The rows end
    // up sharing one razorpay_order_id, which is what ties them together
    // afterwards — for the single review form, and for cancelling them as
    // a pair.
    //
    // Added from that home's own page, the guest is already booking the
    // home for their dates: the experience's nights are then those nights
    // (they must fall inside the stay), so nothing is charged twice.
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
      // One night per day of the experience: a two-day experience is two
      // nights. Taken from the host's own duration, never the request.
      const nights = e.experience_duration_days && e.experience_duration_days >= 1 ? e.experience_duration_days : 1;
      const end = addDaysToDateStr(String(ex.date).slice(0, 10), nights);
      const ownStay = safeStays.find(s => Number(s.listingId) === Number(e.hosting_listing_id));
      if (ownStay) {
        if (String(ex.date) < String(ownStay.arrival) || end > String(ownStay.departure)) {
          return res.status(400).json({ error: `${e.property_name} includes ${nights} night${nights === 1 ? '' : 's'} at this home from the day it starts. Please choose an experience date inside your stay.` });
        }
        if (ownStay.includedWithExperienceId) {
          return res.status(400).json({ error: 'Only one experience that includes a stay can be added to each stay.' });
        }
        ownStay.includedWithExperienceId = e.id;
        continue;
      }
      const guestCount = Number(ex.guests) || 1;
      safeStays = safeStays.concat([{
        listingId: e.hosting_listing_id,
        arrival: ex.date,
        departure: end,
        guests: guestCount,
        adults: guestCount,
        includedWithExperienceId: e.id
      }]);
    }
    if (safeStays.length > MAX_STAYS) {
      return res.status(400).json({ error: 'Too many homes in one booking once the stays included with your experiences are counted. Please book them separately.' });
    }

    // Dates sold on Airbnb / Agoda / Booking.com… must be closed here before
    // this booking is checked: refresh these listings' imported calendars if
    // older than 15 minutes (6-second budget; a calendar that is down keeps
    // its previous dates blocked). See _calendar-sync.js. Run after the
    // included stays are added, so their homes are refreshed too; not for a
    // quote, which must answer quickly.
    const stayListingIds = [...new Set(safeStays.map(x => Number(x && x.listingId)).filter(n => n > 0))];
    if (!quoteOnly && stayListingIds.length) await syncStaleFeeds(sql, decryptField, { listingIds: stayListingIds, maxAgeMinutes: 15, deadlineMs: 6000 });

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
        return res.status(400).json({ error: plainError(`Stay ${i + 1}: please choose the home, your dates and the number of guests.`, requestedItems) });
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
        return res.status(400).json({ error: `Stay ${i + 1} repeats a room or home already in this booking.` });
      }
      seenListingIds.add(dedupeKey);

      // Priced by the shared rules in _pricing.js: listing, room, capacity,
      // availability, discount, amenities, pets, commission, GST, deposit.
      const priced = await priceStay(sql, s, i);
      if (priced.error) return res.status(400).json({ error: plainError(priced.error, requestedItems) });
      const d = priced.detail;
      grandSubtotal += d.subtotal;
      grandGst += d.gst;
      grandDiscount += d.discountAmount;
      grandGuestServiceFee += d.guestServiceFee;
      grandDeposit += d.depositAmount;
      stayDetails.push(d);
    }

    // Experiences price much more simply than stays: no extra-guest
    // charge, no security deposit, no nights — just the host's set price
    // (per person or flat), any offer, plus the same guest service fee
    // rate everything else on Aerva charges.
    const seenExperienceIds = new Set();
    for (let i = 0; i < safeExperiences.length; i++) {
      const ex = safeExperiences[i];
      if (!ex.listingId || !ex.date) {
        return res.status(400).json({ error: plainError(`Experience ${i + 1}: please choose a date.`, requestedItems) });
      }
      if (seenExperienceIds.has(ex.listingId)) {
        return res.status(400).json({ error: `Experience ${i + 1} repeats one already in this booking.` });
      }
      seenExperienceIds.add(ex.listingId);

      // Priced by the shared rules in _pricing.js (also used for changes).
      const pricedEx = await priceExperience(sql, ex, i);
      if (pricedEx.error) return res.status(400).json({ error: plainError(pricedEx.error, requestedItems) });
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

    if (quoteOnly) {
      return res.status(200).json({
        quote: true,
        lines: priceLines(stayDetails, experienceDetails, { gst, fee: grandGuestServiceFee, deposit: grandDeposit }),
        total: totalRupees, subtotal: grandSubtotal, gst, guestServiceFee: grandGuestServiceFee, deposit: grandDeposit,
        stays: stayDetails.map(x => ({ listingId: x.listingId, roomId: x.roomId, suite: x.suite, arrival: x.arrival, departure: x.departure, nights: x.nights,
                                       guests: x.guests, subtotal: x.subtotal, gst: x.gst, gstRate: x.gstRate, guestServiceFee: x.guestServiceFee, depositAmount: x.depositAmount,
                                       withExperienceId: x.withExperienceId })),
        experiences: experienceDetails.map(x => ({ listingId: x.listingId, suite: x.suite, date: x.date, endDate: x.endDate, durationDays: x.durationDays, guests: x.guests,
                                                   subtotal: x.subtotal, gst: x.gst, gstRate: x.gstRate, guestServiceFee: x.guestServiceFee }))
      });
    }

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
      if (Number(coupon.guest_id) !== Number(guestId)) {
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
        return res.status(409).json({
          priceChanged: true,
          error: 'Prices have been changed recently. The new price is below.',
          lines: priceLines(stayDetails, experienceDetails, { gst, fee: grandGuestServiceFee, deposit: grandDeposit, coupon: appliedCouponDiscount }),
          total: totalRupees, pricesSeen: current
        });
      }
    }

    // ---- The same experience paid for twice ----
    // A second tap, a second tab, or pressing pay again after it went
    // through: refused while this guest's payment for it is open (the hold
    // below) and for 10 minutes after one was paid.
    for (const x of experienceDetails) {
      const recent = await sql`
        SELECT 1 FROM orders
        WHERE guest_id = ${guestId} AND listing_id = ${x.listingId} AND arrival = ${x.date}::date
          AND status = 'paid' AND created_at > now() - interval '10 minutes'
        LIMIT 1`;
      if (recent.length) {
        return res.status(409).json({ error: `You booked ${x.suite} for this date a few minutes ago — see My Bookings. To book it again, please wait a few minutes.` });
      }
    }

    // Open the 90-second payment window. Stays: those dates are held from
    // everyone, this guest included. Experiences are not date-exclusive, so
    // each is held for THIS guest only (its room is minus the guest's id):
    // a second checkout for the same experience and date by the same guest
    // is refused while the first is open. Taken last, after every other check.
    const guestKey = 'g:' + guestId;
    const held = await takeHolds(sql,
      stayDetails.map(s => ({ listingId: s.listingId, roomId: s.roomId, arrival: s.arrival, departure: s.departure }))
        .concat(experienceDetails.map(x => ({ listingId: x.listingId, roomId: -Math.abs(Number(guestId)), arrival: x.date, departure: x.endDate }))),
      { guestKey, ip: requestContext(req).ip || null });
    holdIds = held.ids;

    // What is being paid for, kept in full in our own database. Razorpay's
    // notes carry only this cart's id (they allow 15 short values; a cart
    // with a few amenities is several kilobytes). _confirm-booking.js reads
    // the cart back when the payment arrives.
    const cartId = crypto.randomBytes(12).toString('hex');
    const cart = {
      v: 2,
      email: String(email).trim(), guestId: guestId || null,
      // The guest's own name, given at checkout — this is what the host is
      // told, with the number of guests.
      firstName: guestFirst, lastName: guestLast,
      stays: stayDetails, experiences: experienceDetails,
      chargeCurrency, chargeAmount,
      couponId: appliedCouponId, couponDiscount: appliedCouponDiscount, couponForfeited,
      agreement: agreementNote,
      // true when a payment window was opened: the payment then only counts
      // if it completes inside it (_confirm-booking.js).
      held: holdIds.length > 0,
      // The exact price stamps this order was priced with. At payment, any
      // listing whose stamp differs had its price changed in between —
      // compared stamp to stamp, never by clocks.
      prices: current || null
    };
    await sql`INSERT INTO checkout_carts (id, guest_id, payload) VALUES (${cartId}, ${guestId || null}, ${JSON.stringify(cart)}::jsonb)`;

    const order = await razorpay.orders.create({
      amount: razorpayAmount,
      currency: razorpayCurrency,
      receipt: `aerva_${Date.now()}`,
      notes: assertNotesFit({
        type: 'booking',
        cartId,
        email: String(email).trim().slice(0, 200),
        guestId: String(guestId || ''),
        held: holdIds.length ? '1' : ''
      }),
    });

    try { await sql`UPDATE checkout_carts SET razorpay_order_id = ${order.id} WHERE id = ${cartId}`; }
    catch (err) { console.error('checkout cart not linked to its order (read by cart id instead):', cartId, err.message); }
    await attachHolds(sql, holdIds, order.id);

    // "What they booked" — the actual stay/experience details, dates,
    // and amount, logged the moment the order (and its Razorpay
    // counterpart) actually gets created. This is the booking ATTEMPT,
    // not yet a confirmed booking — _confirm-booking.js logs that
    // separately once payment actually clears, since a guest can create
    // an order here and then abandon payment entirely.
    await logAudit(sql, {
      action: 'booking_order_created', success: true, actorType: 'guest', actorIdentifier: email || null,
      targetType: 'order', targetId: null,
      metadata: {
        razorpayOrderId: order.id, cartId, guestId: guestId || null,
        stays: safeStays.map(s => ({ listingId: s.listingId, arrival: s.arrival, departure: s.departure, guests: s.guests })),
        experiences: safeExperiences.map(e => ({ listingId: e.listingId, date: e.date, guests: e.guests })),
        totalRupees, chargeCurrency, chargeAmount, couponId: appliedCouponId || null
      }
    });

    return res.status(200).json({
      orderId: order.id,
      // The public Key ID for Razorpay's checkout, from the server's own
      // settings, so the page always opens the account this order is in.
      keyId: process.env.RAZORPAY_KEY_ID,
      chargeCurrency,
      chargeAmount,
      amount: order.amount,
      currency: order.currency,
      total: totalRupees,
      totalDeposit: grandDeposit,
      gst,
      couponDiscount: appliedCouponDiscount || 0,
      couponForfeited: couponForfeited || 0,
      // The page shows a countdown and closes the payment window when it ends.
      holdSeconds: holdIds.length ? HOLD_SECONDS : null,
      pricesSeen: current || undefined,
    });
  } catch (err) {
    if (holdIds.length) await releaseHolds(sql, { ids: holdIds, reason: 'error' });
    if (err && err.isUserFacing) return res.status(err.status || 400).json({ error: err.message });
    console.error('create-order error:', err);
    return res.status(500).json({ error: quoteOnly ? 'We could not work out the price just now. Please try again.' : 'We could not start your payment. Nothing has been charged. Please try again in a moment.' });
  }
};

// For tests.
module.exports.priceLines = priceLines;
module.exports.assertNotesFit = assertNotesFit;
