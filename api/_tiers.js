// /api/_tiers.js
// The guest and host reputation ladders, in one place. Not an API
// endpoint itself — the leading underscore is what tells Vercel that,
// same convention as _audit-log.js, _compliance.js, etc.
//
// Deliberately NOT called "Superhost" — that is Airbnb's term, and this
// is Aerva's own ladder. Same reasoning as the original computeBadge()
// note in guest-profile.js, which this file replaces and extends.
//
// Tiers are COMPUTED on every read, never stored on the row. A stored
// tier goes stale the moment a booking completes or a review lands, and
// then needs a backfill job nobody remembers to run. Recomputing costs
// one cheap aggregate and is always correct.
//
// Every threshold below is "at least" — a host or guest sits in the
// highest tier whose conditions they fully meet.

// ---------------------------------------------------------------------
// Guest ladder — earned on BOOKING VALUE and on how hosts have rated them.
//
// Value, not stay count: a guest who books a ₹2,00,000 week is worth more
// to the platform than one who books six ₹4,000 nights, and the badge is
// meant to mark exactly that. minSpend is lifetime gross paid on
// confirmed bookings.
//
// PROMOTION NEEDS BOTH: the cumulative spend for the rung AND a review
// score at or above its threshold. Spend alone never promotes — a guest
// who books heavily but leaves properties badly stays where they are.
//
// minAvgValue is now a single flat ₹10,000 floor on every rung, not a
// rising gate. It exists only to stop a long tail of token bookings
// manufacturing a badge; it is no longer the thing that decides which
// rung someone reaches. That job belongs to spend and rating. Booking
// value still counts toward speed through BOOKING_VALUE_BANDS.
//
// Each rung up needs 5 more than the last — but for guests the count is
// satisfied by BOOKINGS, not strictly by reviews: one completed booking
// counts as one, whether or not the host got round to reviewing it. A
// guest cannot make their host write a review, so requiring reviews alone
// would cap a loyal guest's badge on someone else's inaction. Every
// review belongs to a booking, so the effective count is simply whichever
// is larger, which is normally the booking count.
//
// The rating average is separate and unchanged: judged only once real
// reviews exist, because no reviews is absence of evidence, not evidence
// of a problem. So unreviewed bookings can carry a guest UP the ladder,
// but a genuinely poor average still holds them back.
// ---------------------------------------------------------------------
const GUEST_TIERS = [
  // minBookings is a RAW count of QUALIFYING bookings — those at or above
  // QUALIFYING_BOOKING_MIN. Counting every transaction let a guest pad to
  // five with four ₹1,000 stays alongside one large one and clear the gate
  // on a single real visit.
  //
  // unreviewedBookings is the higher bar an unreviewed guest must clear
  // for the same rung. Without it, zero reviews beat mediocre reviews
  // outright — five stays with no reviews reached Trusted while the same
  // guest reviewed at 4.4 sat two rungs lower, so the rational play was to
  // avoid ever being reviewed. Reviews remain the faster route; silence is
  // still a route, just a longer one.
  { key: 'aerva_favorite', label: 'Aerva Favorite', minSpend: 300000, minAvgValue: 10000, minBookings: 5, unreviewedBookings: null, minRatedReviews: 3, minScore: 4.8,
    blurb: 'A substantial booking history, consistently rated highly by hosts.' },
  { key: 'trusted_guest',  label: 'Trusted Guest',  minSpend: 100000, minAvgValue: 10000, minBookings: 5, unreviewedBookings: 8,    minRatedReviews: 0, minScore: 4.5,
    blurb: 'A strong booking history across at least five stays.' },
  { key: 'valued_guest',   label: 'Valued Guest',   minSpend: 40000,  minAvgValue: 10000, minBookings: 1, unreviewedBookings: 2,    minRatedReviews: 0, minScore: 4.0,
    blurb: 'A confirmed booking history with Aerva.' },
  { key: 'guest',          label: 'Guest',          minSpend: 0,      minAvgValue: 0,     minBookings: 1, unreviewedBookings: 1,    minRatedReviews: 0, minScore: 0,
    blurb: 'Welcome to Aerva.' }
];

// A booking below this does not count toward minBookings. It still counts
// toward spend — the money is real — it just cannot manufacture a "stay".
const QUALIFYING_BOOKING_MIN = 10000;

// An unreviewed booking counts HALF. A guest cannot make their host write
// a review, so bookings have to count for something — but counting them
// one-for-one meant ten bookings and no reviews reached the top badge on
// volume alone, which is what this ladder is supposed to prevent. Half
// credit keeps an unreviewed guest progressing while making a reviewed
// record worth twice as much, so reaching the top without reviews takes
// roughly twice the history.
// ---------------------------------------------------------------------
// Average booking value bands.
//
// minAvgValue on each tier is a floor — pass or fail. These bands are the
// other half: what a booking is WORTH toward the count. A guest averaging
// ₹1,20,000 a stay is not doing the same thing as one averaging ₹18,000,
// and counting both as "one booking" flattens the difference the whole
// ladder exists to notice.
//
// The multiplier applies to booking credit only, never to spend or to
// ratings: money already counts directly through minSpend, and a guest
// cannot buy a better review. So a premium guest reaches a rung on fewer
// stays, not on a lower standard of behaviour.
//
// Bands are read highest-first; the first whose minAvg is met wins.
const BOOKING_VALUE_BANDS = [
  { key: 'signature', label: 'Signature', minAvg: 100000, multiplier: 2 },
  { key: 'premium',   label: 'Premium',   minAvg: 40000,  multiplier: 1.5 },
  { key: 'standard',  label: 'Standard',  minAvg: 15000,  multiplier: 1 },
  { key: 'entry',     label: 'Entry',     minAvg: 0,      multiplier: 0.5 }
];

function bookingValueBand(avgValue) {
  const v = num(avgValue);
  return BOOKING_VALUE_BANDS.find(b => v >= b.minAvg) || BOOKING_VALUE_BANDS[BOOKING_VALUE_BANDS.length - 1];
}

const UNREVIEWED_BOOKING_CREDIT = 0.5;

// The entry rung carries no count requirement on purpose. With half
// credit, requiring 1 meant a guest's FIRST booking scored 0.5 and earned
// nothing at all — the spend and average-value floors already prove that
// booking was real, so the count has nothing left to add there. It only
// starts mattering from the second rung, which is where "is this a
// pattern or a one-off" becomes the actual question.

// ---------------------------------------------------------------------
// Host ladder — earned on payout received AND on guest ratings.
//
// Both must hold. Revenue alone would let a high-volume host with poor
// reviews reach the top, which is the opposite of what a badge is for: it
// tells a guest this property is a safe choice, not that the host is busy.
//
// Each rung up needs 10 more reviews than the last. Same two rules as the
// guest ladder: count is required unconditionally, average is judged only
// once there is something to judge — so one bad review demotes
// immediately, while a first GOOD review can never cost a rung.
// ---------------------------------------------------------------------
// minReviews is now only a CREDIBILITY FLOOR — enough reviews that the
// scores aren't noise — not the thing being measured. What separates the
// rungs is minScore (the weighted quality across all five factors) and
// minFactor (the worst single factor a host is allowed to have). Counts
// dropped accordingly: two perfect reviews still shouldn't crown anyone,
// but thirty mediocre ones shouldn't either, and the old ladder only
// guarded against the first of those.
// icon names the badge mark a page should draw. Only three exist, and the
// two elite marks are the same feather silhouette as the plain one —
// differing only in fill — so the set reads as one family rather than
// three unrelated icons:
//   feather-diamond — Aerva Elite: faceted, cut-gem outline, icy fill
//   feather-gold    — Golden Elite: warm metallic fill
//   feather         — every rung below: plain outline
// The SVG itself lives in the page that renders it, not here; this file
// stays free of markup so it can be required by any endpoint.
// minScore is on the DEDUCTION scale (see reviewScore), where each 0.1
// lost across every factor costs 0.54 — so these look far lower than the
// old weighted-mean thresholds while describing a stricter standard.
// Roughly, in uniform-rating terms:
//   Aerva Elite 4.70  ≈ every factor at 4.95
//   Golden Elite 4.35 ≈ every factor at 4.92
//   Elite 3.90        ≈ every factor at 4.80
//   Signature 3.10    ≈ every factor at 4.65
//   Established 2.00  ≈ every factor at 4.45
const HOST_TIERS = [
  // Three elite rungs, tightest first. The gap between them is mostly in
  // the score, because at this end of the ladder every host already has
  // the revenue and the volume — what separates them is whether the
  // reviews are excellent, near-perfect, or essentially flawless.
  { key: 'aerva_elite',      label: 'Aerva Elite',      icon: 'feather-diamond', minPayout: 5000000, minScore: 4.96, minFactor: 4.7, minReviews: 30,
    blurb: 'The highest standard on Aerva — essentially flawless, sustained.' },
  { key: 'golden_elite',     label: 'Golden Elite',     icon: 'feather-gold',    minPayout: 2500000, minScore: 4.92, minFactor: 4.6, minReviews: 20,
    blurb: 'Near-perfect reviews across a substantial body of stays.' },
  { key: 'elite',            label: 'Elite',            icon: 'feather',         minPayout: 1000000, minScore: 4.85, minFactor: 4.5, minReviews: 10,
    blurb: 'Exceptional across every part of the stay.' },
  { key: 'signature_host',   label: 'Signature Host',   icon: 'feather',         minPayout: 300000,  minScore: 4.60, minFactor: 4.2, minReviews: 6,
    blurb: 'Consistently well reviewed, with no weak spots.' },
  { key: 'established_host', label: 'Established Host', icon: 'feather',         minPayout: 75000,   minScore: 4.30, minFactor: 3.8, minReviews: 3,
    blurb: 'A proven track record of happy guests.' },
  { key: 'rising_host',      label: 'Rising Host',      icon: 'feather',         minPayout: 1,       minScore: 0,    minFactor: 0,   minReviews: 0,
    blurb: 'Off to a strong start.' }
];


function num(v) { return Number(v) || 0; }

// ---------------------------------------------------------------------
// Review quality — the five factors a guest scores a PROPERTY on after
// checkout. These belong to the host ladder only.
//
// A host reviewing a GUEST gives one overall rating plus a comment, not a
// factor breakdown, and location in particular has no meaning there: a
// guest does not have an address, and nothing about where a property sits
// says anything about the person who stayed in it. resolveTier reads
// stats.factors on the host path only, so a factors object passed
// alongside guest stats is ignored rather than silently scored — see the
// isGuest branches there.
//
// A single overall average is easy to game and easy to misread: a host
// with spotless hygiene and a beautiful location can carry a real
// communication problem for a long time behind one blended number. So
// quality is judged two ways at once — a WEIGHTED score across all five,
// and a floor that EVERY factor must clear on its own.
//
// Most factors count at face value — a 5 is a 5, a 1 is a 1 — with two
// exceptions at either end.
//
// HYGIENE counts one and a half, COMMUNICATION one point four. These are
// the two a guest cannot negotiate around and the two most squarely in
// the host's control: a dirty room ends the stay, and an unanswered
// message turns every other problem into a bigger one. Weighting them up
// puts the most pressure exactly where a host can act.
//
// Services and value for money stay at face value — they matter, but a
// thin breakfast or a slightly steep rate is a disappointment, not a
// ruined stay.
//
// LOCATION counts 0.1 — a tenth of a full-weight factor, and a fifteenth
// of hygiene. A host cannot move the property, so marking them down for
// an address they disclosed truthfully measures the address, not the
// hosting. At this weight it is close to symbolic: it registers that the
// guest felt the location let the stay down, without letting geography
// decide a badge that is meant to describe hosting. A point lost on
// location costs 0.10; a point lost on hygiene costs 1.50.
//
// Weights sum to 5.0. Nothing relies on that number — reviewScore divides
// by whatever the weights actually sum to, so retuning any of them is a
// one-line change with no other arithmetic to update.
// weight is the factor's nominal standing — location is a full factor and
// a guest scores it like any other. cost is what a point lost on it
// actually deducts. For four of the five the two are the same number;
// only location separates them, and that separation is the point: the
// factor is not diminished, only its power to cost a host a badge.
//
// Costs sum to 5.0, so a straight 5 scores exactly 5.0 and a straight 1
// scores exactly 0.0 — the scale has real ends.
const REVIEW_FACTORS = [
  { key: 'hygiene',       label: 'Hygiene',         weight: 1.5 },
  { key: 'communication', label: 'Communication',   weight: 1.4 },
  { key: 'services',      label: 'Services',        weight: 1 },
  { key: 'value',         label: 'Value for money', weight: 1 },
  // floorExempt: counted in the weighted score, but never held against a
  // host by the per-factor floor. A host cannot move the property. The
  // floor exists to stop a fixable weak spot — a dirty room, unanswered
  // messages — being masked by strong scores elsewhere, and an address is
  // not a fixable weak spot. Leaving location in the floor re-imposed at
  // full force exactly the penalty the low weight was meant to soften,
  // capping well-run properties in quiet locations.
  { key: 'location',      label: 'Location',        weight: 0.1, floorExempt: true }
];

// factors: { hygiene: 4.6, communication: 4.9, ... } — each a 1-5 average.
// Missing factors are skipped rather than counted as zero; a factor a
// guest declined to score is not a complaint.
// ---------------------------------------------------------------------
// The four factors a HOST scores a GUEST on after checkout. A separate
// set from the property factors above: a guest has no address, so there
// is no location here, and cleanliness means "left the place decent"
// rather than "arrived clean".
//
// Cleanliness and respectfulness carry 1.5 because they are what make a
// guest genuinely expensive to host — damage and bad behaviour cost real
// money and real standing. Communication and rules-followed carry 1:
// irritating when poor, but recoverable.
const GUEST_FACTORS = [
  { key: 'cleanliness',   label: 'Cleanliness',    weight: 1.5 },
  { key: 'communication', label: 'Communication',  weight: 1 },
  { key: 'respectful',    label: 'Respectful',     weight: 1.5 },
  { key: 'rules',         label: 'Rules followed', weight: 1 }
];

// A WEIGHTED MEAN, so the score reads as a rating: straight 4.9s score
// 4.90, straight 5s score 5.00. The weights set only how much each factor
// pulls on that average.
//
// This replaced a deduction model where each factor subtracted its weight
// per point lost. That amplified every shortfall by the sum of the
// weights — a 4.9 became 4.50 and a 4.68 average became 3.40 — so the
// score could not be shown to anyone as a rating without confusing them.
//
// A missing factor is skipped rather than counted as zero: someone who
// declined to score it has not complained about it. Its weight leaves the
// denominator too, so the remaining factors keep their relative pull.
function reviewScore(factors, set) {
  if (!factors) return 0;
  const FACTORS = set || REVIEW_FACTORS;
  let total = 0, weight = 0;
  FACTORS.forEach(f => {
    const v = num(factors[f.key]);
    if (v > 0) { total += v * f.weight; weight += f.weight; }
  });
  if (!weight) return 0;
  // Rounded to 3dp so a score sitting exactly on a threshold is not
  // dropped a rung by float drift.
  return Math.round((total / weight) * 1000) / 1000;
}

// The factor dragging hardest — what to tell a host to fix. Returns the
// lowest-scoring factor below `floor`, or null if nothing is below it.
function weakestFactor(factors, floor, set) {
  let worst = null;
  (set || REVIEW_FACTORS).forEach(f => {
    if (f.floorExempt) return;
    const v = num(factors && factors[f.key]);
    if (v > 0 && v < floor && (!worst || v < worst.value)) worst = { key: f.key, label: f.label, value: v };
  });
  return worst;
}


// Shared by both ladders — they differ only in which money field they
// read, so the eligibility rules live in one place and cannot drift.
function resolveTier(ladder, stats, moneyField) {
  const money = num(stats && stats[moneyField]);
  const reviews = num(stats && stats.reviewCount);
  const bookings = num(stats && stats.bookingCount);
  const avg = num(stats && stats.avgRating);
  const isGuest = moneyField === 'totalSpend';
  const minMoney = isGuest ? 'minSpend' : 'minPayout';
  const minCountField = isGuest ? 'minCount' : 'minReviews';
  // Guests: every review already sits on a booking, so the remaining
  // bookings are the unreviewed ones and they earn half credit. Hosts
  // count reviews only — a host CAN influence whether guests review them,
  // and their badge is a signal to strangers choosing a property, so it
  // has to rest on real feedback.

  // Average booking value, so a long tail of cheap bookings can't climb
  // the ladder the way a few substantial ones legitimately do.
  const avgValue = isGuest && bookings > 0 ? money / bookings : Infinity;
  // Hosts are judged on the five factors; guests have no factor breakdown
  // (a host rates them once, overall), so they keep the single average.
  // A valid review carries ALL FIVE ratings AND a comment — both are
  // mandatory at submission, and a review missing either is not accepted.
  // The comment is informational only: it is shown to guests, never scored
  // and never counted. Only the ratings move a tier.
  //
  // The fallback below therefore guards against data that should not
  // exist: rows written before that rule, imported from elsewhere, or
  // partially saved. It is kept because the failure is silent and
  // asymmetric — an unrated review counted as real would push a host past
  // the credibility floor on evidence that says nothing, then fail them on
  // a score of 0 they never earned. Treating it as no review at all is the
  // only reading that cannot punish a host for a row they did not create.
  //
  // reviewCount must therefore be the number of VALID reviews. Under the
  // mandatory-fields rule that is simply every row of listing_reviews, but
  // the query should still filter to rows carrying ratings rather than
  // assume it — the assumption is free to make and expensive to be wrong
  // about.
  const factorSet = isGuest ? GUEST_FACTORS : REVIEW_FACTORS;
  const rawFactors = stats && stats.factors;
  const factors = rawFactors && factorSet.some(f => num(rawFactors[f.key]) > 0) ? rawFactors : null;
  // Same rule on both sides of the ladder. A host reviewing a guest must
  // give a rating AND a comment, exactly as a guest reviewing a property
  // must; the comment is shown but never scored. A guest review carrying
  // no rating is therefore treated as no review — avg of 0 is the tell,
  // since a real rating is 1-5 and can never be 0.
  //
  // Without this the guest ladder had the mirror-image flaw of the host
  // one: unrated rows would inflate reviewCount past the credibility floor
  // and then fail the guest on an average of 0 they never received.
  const rated = factors ? reviews : (avg > 0 ? reviews : 0);
  const score = factors ? reviewScore(factors, factorSet) : avg;
  // Guests: a rated review is worth full credit, every other booking half
  // (see UNREVIEWED_BOOKING_CREDIT). An unrated review is not a review, so
  // its booking falls back to half credit rather than counting as one.
  // Guests: a rated review is worth full credit, every other booking half
  // (see UNREVIEWED_BOOKING_CREDIT), and the whole lot is then scaled by
  // the value band the guest actually books in.
  const band = isGuest ? bookingValueBand(avgValue === Infinity ? 0 : avgValue) : null;
  const count = isGuest
    ? (rated + Math.max(bookings - rated, 0) * UNREVIEWED_BOOKING_CREDIT) * band.multiplier
    : reviews;
  // Kept separate from `count` above on purpose. count is soft credit used
  // for pace; these two are hard gates and must not be inflatable by the
  // value band or by unreviewed-booking credit.
  // qualifyingBookings is supplied by the caller (a COUNT of bookings at or
  // above QUALIFYING_BOOKING_MIN). Falls back to the raw count when absent
  // so older callers keep working, but the query should provide it.
  const rawBookings = stats && stats.qualifyingBookings !== undefined
    ? num(stats.qualifyingBookings)
    : bookings;
  const ratedReviews = rated;
  for (const t of ladder) {
    if (money < t[minMoney]) continue;
    if (isGuest) {
      // An unreviewed guest is held to the higher bar, where one exists.
      const needBookings = ratedReviews > 0
        ? num(t.minBookings)
        : (t.unreviewedBookings === null ? Infinity : num(t.unreviewedBookings));
      if (rawBookings < needBookings) continue;
      if (ratedReviews < num(t.minRatedReviews)) continue;
    } else if (rated < t.minReviews) continue;
    if (t.minAvgValue && avgValue < t.minAvgValue) continue;
    if (rated > 0) {
      if (score < (t.minScore !== undefined ? t.minScore : t.minRating)) continue;
      // No single factor may sit below the tier's floor, however strong
      // the others are. This is the whole point of scoring five things:
      // a filthy room is not offset by a great location.
      if (t.minFactor && factors && weakestFactor(factors, t.minFactor, factorSet)) continue;
    }
    return { key: t.key, label: t.label, blurb: t.blurb, icon: t.icon || null };
  }
  return null; // no track record yet — callers show no badge at all
}

// stats: { totalSpend, bookingCount, reviewCount, avgRating }
// stats.factors is deliberately NOT read here — guests are rated once,
// overall. The five property factors (location included) never apply.
function guestTier(stats) { return resolveTier(GUEST_TIERS, stats, 'totalSpend'); }

// stats: { totalPayout, reviewCount, avgRating }
function hostTier(stats) { return resolveTier(HOST_TIERS, stats, 'totalPayout'); }

// What this host or guest still needs for the next rung up. Shown on
// their own dashboard only — never to anyone else, since "needs 3 more
// reviews" is nobody else's business. Returns null at the top.
function nextTierProgress(ladder, stats, currentKey) {
  const idx = currentKey ? ladder.findIndex(t => t.key === currentKey) : ladder.length;
  if (idx === 0) return null;
  const next = ladder[idx - 1];
  if (!next) return null;
  const isGuest = Object.prototype.hasOwnProperty.call(next, 'minSpend');
  const have = num(isGuest ? stats.totalSpend : stats.totalPayout);
  const need = isGuest ? next.minSpend : next.minPayout;
  const needs = [];
  if (have < need) {
    needs.push(`₹${(need - have).toLocaleString('en-IN')} more in ${isGuest ? 'booking value' : 'payouts'}`);
  }
  const haveCount = isGuest
    ? num(stats.reviewCount) + Math.max(num(stats.bookingCount) - num(stats.reviewCount), 0) * UNREVIEWED_BOOKING_CREDIT
    : num(stats.reviewCount);
  const needCount = isGuest ? next.minCount : next.minReviews;
  if (needCount && haveCount < needCount) {
    const gap = needCount - haveCount;
    needs.push(isGuest
      ? `${Math.ceil(gap / UNREVIEWED_BOOKING_CREDIT)} more booking${Math.ceil(gap / UNREVIEWED_BOOKING_CREDIT) === 1 ? '' : 's'} (or ${Math.ceil(gap)} reviewed)`
      : `${Math.ceil(gap)} more review${Math.ceil(gap) === 1 ? '' : 's'}`);
  }
  if (isGuest && next.minAvgValue) {
    const bk = num(stats.bookingCount);
    const avgV = bk > 0 ? num(stats.totalSpend) / bk : 0;
    if (bk > 0 && avgV < next.minAvgValue) {
      needs.push(`an average booking of ₹${next.minAvgValue.toLocaleString('en-IN')}`);
    }
  }
  if (num(stats.reviewCount) > 0) {
    const f = stats.factors;
    const score = f ? reviewScore(f) : num(stats.avgRating);
    const wantScore = next.minScore !== undefined ? next.minScore : next.minRating;
    if (wantScore && score < wantScore) needs.push(`an overall review score of ${wantScore}`);
    // Named explicitly — "improve your reviews" is not actionable, but
    // "hygiene is at 3.6, needs 4.2" tells a host exactly what to fix.
    if (next.minFactor && f) {
      const weak = weakestFactor(f, next.minFactor);
      if (weak) needs.push(`${weak.label.toLowerCase()} at ${next.minFactor} or above (currently ${weak.value.toFixed(1)})`);
    }
  }
  return { label: next.label, needs };
}

// ---------------------------------------------------------------------
// Periodic review
//
// Guests are reviewed ANNUALLY, on 1 January.
// Hosts are reviewed QUARTERLY, on 1 Jan / 1 Apr / 1 Jul / 1 Oct.
//
// Both are assessed against a rolling TWELVE MONTHS, not against the
// single period just ended. The thresholds above (₹10L payout, 30 reviews
// for Elite) describe a year's worth of trading; judging one quarter
// against them would mean needing 30 reviews in three months, which
// almost no host would ever clear. Reviewing quarterly makes the badge
// responsive — a host who slips is caught within three months instead of
// twelve — without quietly making it four times harder to earn.
//
// Two rules keep decay fair rather than brutal:
//
//   1. At most ONE rung is lost per review. Falling from Aerva Elite to
//      nothing over one quiet spell reads as punishment and is the surest
//      way to make someone stop trying.
//   2. There is no cap on gains. Earning three rungs at once awards all
//      three — the cap exists to soften loss, not to slow people down.
//
// Note this does mean a host can slide four rungs in a year where a guest
// slides one. That is the intended consequence of a tighter review cycle:
// a host badge is a promise to strangers choosing a property, so it
// should go stale faster than a guest's.
//
// Deliberately computed by walking the period history rather than stored
// on the row. A stored tier needs a cron that must fire on exactly the
// right day and goes silently wrong if it is missed, retried, or runs
// twice. Walking the history gives the same answer on any day, from any
// caller, with nothing to schedule and nothing to repair.

const CADENCES = {
  annual:    { perYear: 1, windowPeriods: 1 },  // 1 period = 12 months
  quarterly: { perYear: 4, windowPeriods: 4 }   // 4 periods = 12 months
};

// Period keys are sortable strings: "2026" annually, "2026-Q3" quarterly.
function periodKey(year, index, cadence) {
  return cadence === 'quarterly' ? `${year}-Q${index + 1}` : String(year);
}
function periodsBetween(fromYear, fromIdx, toYear, toIdx, cadence) {
  const per = CADENCES[cadence].perYear;
  const out = [];
  let y = fromYear, i = fromIdx;
  while (y < toYear || (y === toYear && i <= toIdx)) {
    out.push({ year: y, index: i, key: periodKey(y, i, cadence) });
    i += 1;
    if (i >= per) { i = 0; y += 1; }
  }
  return out;
}

// The period that most recently ENDED — the one the latest review judged.
function assessmentPeriod(now, cadence) {
  const d = now || new Date();
  const per = CADENCES[cadence].perYear;
  const idx = Math.floor(d.getUTCMonth() / (12 / per));  // 0-based
  return idx === 0
    ? { year: d.getUTCFullYear() - 1, index: per - 1 }   // still in the first period → previous year's last
    : { year: d.getUTCFullYear(), index: idx - 1 };
}
function assessmentYear(now) { return assessmentPeriod(now, 'annual').year; }

// Sum several periods into one stats object. avgRating is weighted by
// review count — a straight mean of period averages would let a quarter
// with two reviews count as much as one with two hundred.
function mergeStats(list) {
  const out = { totalSpend: 0, totalPayout: 0, bookingCount: 0, reviewCount: 0, avgRating: 0, factors: {} };
  let ratingWeight = 0;
  const fTotal = {}, fWeight = {};
  (list || []).forEach(st => {
    if (!st) return;
    out.totalSpend += num(st.totalSpend);
    out.totalPayout += num(st.totalPayout);
    out.bookingCount += num(st.bookingCount);
    const rc = num(st.reviewCount);
    out.reviewCount += rc;
    if (rc > 0 && num(st.avgRating) > 0) { out.avgRating += num(st.avgRating) * rc; ratingWeight += rc; }
    // Each factor averaged across periods, weighted by that period's
    // review count — same reasoning as the overall average: a quarter
    // with two reviews must not count as much as one with two hundred.
    if (rc > 0 && st.factors) {
      Object.keys(st.factors).forEach(k => {
        const v = num(st.factors[k]);
        if (v > 0) { fTotal[k] = (fTotal[k] || 0) + v * rc; fWeight[k] = (fWeight[k] || 0) + rc; }
      });
    }
  });
  out.avgRating = ratingWeight > 0 ? out.avgRating / ratingWeight : 0;
  Object.keys(fWeight).forEach(k => { out.factors[k] = fTotal[k] / fWeight[k]; });
  if (!Object.keys(out.factors).length) delete out.factors;
  return out;
}

function rungOf(ladder, key) {
  if (!key) return -1;
  const i = ladder.findIndex(t => t.key === key);
  return i < 0 ? -1 : (ladder.length - 1 - i); // 0 = lowest rung
}
function tierAtRung(ladder, rung) {
  if (rung < 0) return null;
  const t = ladder[ladder.length - 1 - rung];
  return t ? { key: t.key, label: t.label, blurb: t.blurb, icon: t.icon || null } : null;
}

// statsByPeriod: { "2026-Q1": {...} } quarterly, { "2026": {...} } annually.
// Missing periods are treated as empty — a period with no bookings must
// decay exactly like a recorded zero, or someone active once keeps a badge
// indefinitely, which is what the review exists to prevent.
function reviewTiers(ladder, statsByPeriod, moneyField, now, cadence) {
  const cad = CADENCES[cadence] ? cadence : 'annual';
  const win = CADENCES[cad].windowPeriods;
  const today = now || new Date();
  const assessed = assessmentPeriod(today, cad);
  const stats = statsByPeriod || {};

  const known = Object.keys(stats).filter(k => stats[k]).sort();
  let startYear = assessed.year, startIdx = assessed.index;
  if (known.length) {
    const first = known[0];
    startYear = Number(first.slice(0, 4));
    startIdx = cad === 'quarterly' ? Number(first.slice(6, 7)) - 1 : 0;
  }

  const timeline = periodsBetween(startYear, startIdx, assessed.year, assessed.index, cad);
  let heldRung = -1;
  let earnedAtAssessment = null;
  const history = [];

  timeline.forEach((p, i) => {
    // Rolling window: this period plus the preceding ones, so the
    // thresholds keep describing twelve months of activity.
    const windowKeys = timeline.slice(Math.max(0, i - win + 1), i + 1).map(x => x.key);
    const earned = resolveTier(ladder, mergeStats(windowKeys.map(k => stats[k])), moneyField);
    const earnedRung = rungOf(ladder, earned && earned.key);
    heldRung = earnedRung >= heldRung ? earnedRung : Math.max(earnedRung, heldRung - 1);
    history.push({ period: p.key, earned: earned ? earned.label : null, held: (tierAtRung(ladder, heldRung) || {}).label || null });
    if (p.key === periodKey(assessed.year, assessed.index, cad)) earnedAtAssessment = earned;
  });

  // Where the period currently RUNNING is heading — what the next review
  // would award if it closed today. Turns the review from a nasty
  // surprise into something the person can still act on.
  const per = CADENCES[cad].perYear;
  const curIdx = Math.floor(today.getUTCMonth() / (12 / per));
  const current = periodsBetween(today.getUTCFullYear(), curIdx, today.getUTCFullYear(), curIdx, cad)[0];
  const provWindow = [];
  let py = current.year, pi = current.index;
  for (let k = 0; k < win; k++) {
    provWindow.push(periodKey(py, pi, cad));
    pi -= 1; if (pi < 0) { pi = per - 1; py -= 1; }
  }
  const provisional = resolveTier(ladder, mergeStats(provWindow.map(k => stats[k])), moneyField);

  let ny = current.year, ni = current.index + 1;
  if (ni >= per) { ni = 0; ny += 1; }
  const nextMonth = String(ni * (12 / per) + 1).padStart(2, '0');

  return {
    current: tierAtRung(ladder, heldRung),
    earned: earnedAtAssessment,
    provisional,
    cadence: cad,
    assessmentPeriod: periodKey(assessed.year, assessed.index, cad),
    nextReview: `${ny}-${nextMonth}-01`,
    history
  };
}

// Convenience wrappers so callers can't accidentally pair the wrong
// ladder with the wrong cadence.
function reviewGuestTiers(statsByYear, now) {
  return reviewTiers(GUEST_TIERS, statsByYear, 'totalSpend', now, 'annual');
}
function reviewHostTiers(statsByQuarter, now) {
  return reviewTiers(HOST_TIERS, statsByQuarter, 'totalPayout', now, 'quarterly');
}

// ---------------------------------------------------------------------
// PROPERTY standing — earned purely on reviews, never on price.
//
// Deliberately separate from the host ladder, and measuring a different
// thing. The host ladder answers "is this person worth hosting with",
// and payout is part of that. This answers "is this place good", where
// what a night costs is beside the point: a ₹2,000 room rated 4.97 is a
// better stay than a ₹2,00,000 villa rated 4.2, and a badge that said
// otherwise would be measuring the price tag.
//
// Naming is quality-led on purpose. Earlier attempts (Premium, Signature,
// Rare, Lux) failed a simple test: ask ten people to order them and you
// get several answers, so a guest comparing two cards could not tell which
// was better. Great / Outstanding / Exceptional need no explaining.
//
// minReviews rises steeply because it is doing the work price used to do.
// Without it a single five-star review makes a listing Exceptional.
// Bands are RANKED POSITIONS, not scores and not percentages. Listings
// compete directly: the best one on the platform is Aerva Exceptional,
// the next four are Exceptional, and so on down. Exactly one listing can
// hold the top badge at a time.
//
// topN is a COUNT, deliberately. Percentages were tried first and cannot
// work at small scale: top 1% of eight listings is one listing, and top
// 1%, 5% and 10% of anything under sixty all resolve to the same row, so
// the bands collapse into one. A count is unambiguous from the first
// listing onwards and needs no minimum population to be meaningful.
//
// minScore is still a floor. Being the best of a poor field is not
// exceptional, so a band can sit empty — better an empty badge than one
// that means "least bad".
const PROPERTY_TIERS = [
  { key: 'aerva_exceptional', label: 'Aerva Exceptional', topN: 1,   minScore: 4.85, minReviews: 20,
    blurb: 'The single highest rated stay on Aerva.' },
  { key: 'exceptional',       label: 'Exceptional',       topN: 5,   minScore: 4.80, minReviews: 15,
    blurb: 'Among the five highest rated stays on Aerva.' },
  { key: 'outstanding',       label: 'Outstanding',       topN: 10,  minScore: 4.75, minReviews: 10,
    blurb: 'Among the ten highest rated stays on Aerva.' },
  { key: 'great_stay',        label: 'Great Stay',        topN: 100, minScore: 4.60, minReviews: 5,
    blurb: 'Among the hundred highest rated stays on Aerva.' }
];

// Flags are independent of the ladder and of each other. A property can
// hold one flag alongside its rung; where several apply, the first match
// in this order wins, so the rarer claim is the one shown.
const PROPERTY_FLAGS = [
  { key: 'hidden_treasure', label: 'Hidden Treasure', minScore: 4.85, maxReviews: 10, minReviews: 3,
    blurb: 'Excellent, and not yet widely discovered.' },
  { key: 'spotless',        label: 'Spotless',        minHygiene: 4.9, minReviews: 5,
    blurb: 'Rated near-perfect on hygiene by every guest who scored it.' }
];

// ---------------------------------------------------------------------
// The four factors a GUEST scores an EXPERIENCE on.
//
// A separate set from the property factors, because most of those do not
// transfer. Hygiene is the clearest case: it carried the heaviest weight
// on the property set and was, until this existed, the single largest
// input to a sunset trek's score — measuring something that barely
// applies. Location means something different too: for a stay it is where
// you sleep, for an experience it is part of what you came for, and is
// better captured by whether the thing was well run.
//
// Organisation and safety carry 1.5. Safety is weighted up rather than
// down because it is the one factor where a poor score is not a
// disappointment but a hazard — a badly run trek that was also unsafe
// should fall further than one that was merely disorganised, and a badge
// on an experience guests felt unsafe on is the worst thing this system
// could put on a card. Guide and value carry 1: a dull guide spoils an
// afternoon, an unsafe one ends worse.
//
// Costs sum to 5, the same as the other two sets, so a score means the
// same thing on any ladder.
const EXPERIENCE_FACTORS = [
  { key: 'organisation',  label: 'Organisation',    weight: 1.5 },
  { key: 'safety',        label: 'Safety',          weight: 1.5 },
  { key: 'guide',         label: 'Guide',           weight: 1 },
  { key: 'value',         label: 'Value for money', weight: 1 }
];

// ---------------------------------------------------------------------
// EXPERIENCE standing — ABSOLUTE thresholds, not ranked.
//
// Unlike the property ladder, experiences are not in competition. A rank
// needs a field to be meaningful, and there are few enough experiences
// that "top 1" would mean "best of three" — a hollow claim, and one that
// would flip between two experiences on a single review. An absolute bar
// is honest at any size: an experience either earns it or does not, and
// nothing another host does can take it away.
//
// Review counts are low for the same reason they are on the property
// ladder's lowest rungs: experiences collect fewer written reviews than
// stays, and holding them to a stay's volume would leave this empty.
const EXPERIENCE_TIERS = [
  { key: 'wow_experience',   label: 'Wow Experience',   minScore: 4.90, minReviews: 10,
    blurb: 'Rated outstanding by a substantial number of guests.' },
  { key: 'unforgettable',    label: 'Unforgettable',    minScore: 4.75, minReviews: 6,
    blurb: 'Consistently rated among the best experiences on Aerva.' },
  { key: 'great_experience', label: 'Great Experience', minScore: 4.55, minReviews: 3,
    blurb: 'Well reviewed by the guests who have been.' }
];

// stats: { reviewCount, factors }
// Takes no cutoffs: nothing here depends on the rest of the field.
function experienceTier(stats) {
  const reviews = num(stats && stats.reviewCount);
  const factors = stats && stats.factors;
  if (!factors) return null;
  // Scored on the experience set. Falls back to the property set only for
  // rows written before the experience columns existed — those carry the
  // old five and would otherwise read as no review at all.
  const set = EXPERIENCE_FACTORS.some(f => num(factors[f.key]) > 0)
    ? EXPERIENCE_FACTORS
    : (REVIEW_FACTORS.some(f => num(factors[f.key]) > 0) ? REVIEW_FACTORS : null);
  if (!set) return null;
  const score = reviewScore(factors, set);
  for (const t of EXPERIENCE_TIERS) {
    if (reviews < t.minReviews) continue;
    if (score < t.minScore) continue;
    return { key: t.key, label: t.label, blurb: t.blurb, score: Number(score.toFixed(3)) };
  }
  return null;
}

// Builds the score cutoff for each band from the current field.
//
// `population` is every ELIGIBLE listing's score — live listings with
// enough reviews to be judged. A listing that is not live does not
// compete, so it neither holds a rank nor displaces anyone from one.
//
// Ties are handled by score, not by arbitrary ordering: if three listings
// share the top score, all three clear the top-1 bar. That is the honest
// reading — there is no defensible way to rank identical records, and
// silently picking one by id would be a lie dressed as precision.
function propertyCutoffs(population, ladder) {
  const scores = (population || []).map(Number).filter(n => Number.isFinite(n)).sort((a, b) => b - a);
  const out = {};
  if (!scores.length) return out;
  (ladder || PROPERTY_TIERS).forEach(t => {
    // The score of the listing at position topN. If the field is smaller
    // than topN, everyone in it clears that band's rank — the floor is
    // then the only thing standing between them and the badge.
    const idx = Math.min(t.topN, scores.length) - 1;
    out[t.key] = scores[idx];
  });
  return out;
}

// stats: { reviewCount, factors }
// cutoffs: from propertyCutoffs(). Without them no ladder badge is given
// — a ranked band cannot be resolved against an unknown field.
function propertyTier(stats, cutoffs) {
  const reviews = num(stats && stats.reviewCount);
  const factors = stats && stats.factors;
  if (!factors || !REVIEW_FACTORS.some(f => num(factors[f.key]) > 0)) return null;
  if (!cutoffs || !Object.keys(cutoffs).length) return null;
  const score = reviewScore(factors, REVIEW_FACTORS);
  for (const t of PROPERTY_TIERS) {
    if (reviews < t.minReviews) continue;
    if (score < t.minScore) continue;          // absolute floor
    const cut = cutoffs[t.key];
    if (cut === undefined || score < cut) continue; // rank within the field
    return { key: t.key, label: t.label, blurb: t.blurb, score: Number(score.toFixed(3)) };
  }
  return null;
}

function propertyFlag(stats) {
  const reviews = num(stats && stats.reviewCount);
  const factors = stats && stats.factors;
  if (!factors || !reviews) return null;
  const score = reviewScore(factors, REVIEW_FACTORS);
  for (const f of PROPERTY_FLAGS) {
    if (f.minReviews && reviews < f.minReviews) continue;
    // maxReviews is what makes "hidden" mean something: the flag is meant
    // to disappear once a place is well known, so it is capped rather than
    // floored. A property losing it by becoming popular is the point.
    if (f.maxReviews !== undefined && reviews >= f.maxReviews) continue;
    if (f.minScore && score < f.minScore) continue;
    if (f.minHygiene && num(factors.hygiene) < f.minHygiene) continue;
    return { key: f.key, label: f.label, blurb: f.blurb };
  }
  return null;
}

// ---------------------------------------------------------------------
// Human-readable description of both ladders, GENERATED from the arrays
// above rather than written out separately. The admin tool renders this.
//
// Generated on purpose: a hand-written policy page and the code that
// enforces it drift the moment anyone retunes a threshold, and a stale
// policy is worse than none — an admin resolving a dispute would be
// reading rules the system stopped applying months ago.
function money(n) { return '\u20b9' + Number(n || 0).toLocaleString('en-IN'); }

function describeLadders() {
  const factorLine = (set) => set.map(f => `${f.label} \u00d7${f.weight}`).join(', ');

  return {
    guest: {
      title: 'Guest standing',
      basis: 'Earned on booking value, qualifying bookings, and the ratings hosts leave.',
      reviewedBy: 'Reviewed annually, on 1 January, against the calendar year just ended.',
      factors: `Hosts rate a guest on: ${factorLine(GUEST_FACTORS)}. Weights set how much each pulls on the score; the written comment is never scored.`,
      rules: [
        `A booking under ${money(QUALIFYING_BOOKING_MIN)} counts toward spend but not toward the booking count \u2014 it cannot manufacture a "stay".`,
        'A guest with no reviews is held to a HIGHER booking count for the same rung, so silence is a slower route rather than a free pass.',
        'A review with no ratings counts as no review at all, in either direction.',
        'At most one rung is lost per annual review; gains are uncapped.'
      ],
      bands: GUEST_TIERS.map(t => ({
        label: t.label,
        blurb: t.blurb,
        requirements: [
          t.minSpend > 0 ? `${money(t.minSpend)} spent this year` : 'Any confirmed booking',
          `${t.minBookings} qualifying booking${t.minBookings === 1 ? '' : 's'}` +
            (t.unreviewedBookings && t.unreviewedBookings !== t.minBookings
              ? ` (${t.unreviewedBookings} if never reviewed)`
              : t.unreviewedBookings === null ? ' \u2014 unreachable without reviews' : ''),
          t.minRatedReviews > 0 ? `${t.minRatedReviews} rated reviews` : 'No reviews required',
          t.minScore > 0 ? `Score of ${t.minScore} or above` : 'No rating requirement'
        ]
      }))
    },
    property: {
      title: 'Property standing',
      basis: 'Earned purely on guest reviews. Price is deliberately not a factor \u2014 what a night costs says nothing about whether the stay was good.',
      reviewedBy: 'Recomputed continuously from published reviews. No periodic review, no decay: a property is exactly as good as its current reviews say.',
      factors: `Scored on the same five property factors as the host ladder: ${factorLine(REVIEW_FACTORS)}.`,
      rules: [
        'Only published, non-reverted reviews count \u2014 a held review must not move a listing\u2019s badge any more than it shows on the card.',
        `Bands are ranked positions, not scores. Listings compete directly \u2014 exactly one can be Aerva Exceptional at a time, and a listing loses it when another overtakes it.`,
        `The minimum score is a floor on top of the rank: being best of a poor field is not exceptional, and the band is left empty instead.`,
        `Only live listings compete. A deactivated or removed listing holds no rank and displaces nobody; on reactivation it is ranked afresh against the field as it stands then.`,
        'A property may hold one flag alongside its rung. Where several flags apply, the rarer one wins.',
        'Below the lowest rung no badge is shown at all \u2014 never a lesser label.'
      ],
      bands: PROPERTY_TIERS.map(t => ({
        label: t.label, blurb: t.blurb, publicBadge: true,
        requirements: [
          t.topN === 1
            ? 'The single highest rated live listing'
            : `Ranked in the top ${t.topN} live listings by score`,
          `Score of at least ${t.minScore} regardless of rank`,
          `${t.minReviews} published reviews`
        ]
      })).concat(PROPERTY_FLAGS.map(f => ({
        label: f.label + ' (flag)', blurb: f.blurb, publicBadge: true,
        requirements: [
          f.minScore ? `Score of ${f.minScore} or above` : null,
          f.minHygiene ? `Hygiene of ${f.minHygiene} or above` : null,
          f.minReviews ? `At least ${f.minReviews} reviews` : null,
          f.maxReviews !== undefined ? `Fewer than ${f.maxReviews} reviews \u2014 lost once widely reviewed` : null
        ].filter(Boolean)
      })))
    },
    experience: {
      title: 'Experience standing',
      basis: 'Earned purely on guest reviews, against fixed thresholds. Experiences do not compete with each other and are never ranked.',
      reviewedBy: 'Recomputed continuously from published reviews. No periodic review and no decay.',
      factors: `Scored on its own four factors: ${factorLine(EXPERIENCE_FACTORS)}. Deliberately not the property set \u2014 hygiene and location say little about a guided walk, and hygiene carried the heaviest weight there.`,
      rules: [
        'Absolute, not ranked. A rank needs a field to mean anything, and there are few enough experiences that "top 1" would mean "best of three" \u2014 a hollow claim that would flip between two hosts on a single review.',
        'Because nothing is competitive, an experience cannot lose its badge to someone else improving. It keeps it as long as its own reviews hold up.',
        'Review counts are low on purpose. Experiences collect fewer written reviews than stays, and holding them to a stay\u2019s volume would leave this ladder permanently empty.',
        'Only published, non-reverted reviews count, and an inactive experience is not evaluated at all.'
      ],
      bands: EXPERIENCE_TIERS.map(t => ({
        label: t.label, blurb: t.blurb, publicBadge: true,
        requirements: [`Score of ${t.minScore} or above`, `${t.minReviews} published reviews`]
      }))
    },
    host: {
      title: 'Host standing',
      basis: 'Earned on payout received and the ratings guests leave. Revenue alone never promotes.',
      reviewedBy: 'Reviewed quarterly \u2014 1 Jan, 1 Apr, 1 Jul, 1 Oct \u2014 each against a rolling twelve months.',
      factors: `Guests rate a property on: ${factorLine(REVIEW_FACTORS)}. Location carries the least because a host cannot move the property, and is exempt from the per-factor floor for the same reason.`,
      rules: [
        'Both the score AND the per-factor floor must be met: one weak factor blocks a rung however strong the others are.',
        'The per-factor floor covers what a host can fix. Location is excluded from it.',
        'A host with no reviews climbs on payout alone up to the point a rung requires reviews \u2014 Elite and above never do.',
        'At most one rung is lost per quarterly review, so a full slide takes as long as the climb did.'
      ],
      bands: HOST_TIERS.map(t => ({
        label: t.label,
        blurb: t.blurb,
        icon: t.icon || null,
        publicBadge: ['elite', 'golden_elite', 'aerva_elite'].includes(t.key),
        requirements: [
          t.minPayout > 1 ? `${money(t.minPayout)} paid out over 12 months` : 'Any completed booking',
          t.minReviews > 0 ? `${t.minReviews} published reviews` : 'No reviews required',
          t.minScore > 0 ? `Score of ${t.minScore} or above` : 'No rating requirement',
          t.minFactor > 0 ? `No single factor below ${t.minFactor} (location exempt)` : 'No per-factor floor'
        ]
      }))
    }
  };
}

module.exports = {
  GUEST_TIERS, HOST_TIERS, UNREVIEWED_BOOKING_CREDIT, CADENCES, REVIEW_FACTORS, GUEST_FACTORS,
  BOOKING_VALUE_BANDS, bookingValueBand, QUALIFYING_BOOKING_MIN,
  reviewScore, weakestFactor,
  guestTier, hostTier, nextTierProgress, mergeStats,
  assessmentYear, assessmentPeriod, reviewTiers, describeLadders,
  PROPERTY_TIERS, PROPERTY_FLAGS, propertyTier, propertyFlag, propertyCutoffs,
  EXPERIENCE_TIERS, EXPERIENCE_FACTORS, experienceTier,
  reviewGuestTiers, reviewHostTiers
};
