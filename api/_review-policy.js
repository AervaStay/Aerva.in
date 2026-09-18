// /api/_review-policy.js
// The rules governing when a review becomes visible, and the canonical
// written policy the admin tool displays. Not an API endpoint itself —
// the leading underscore is what tells Vercel that, same convention as
// _tiers.js, _audit-log.js, etc.
//
// The policy text lives here rather than in the admin HTML so there is
// exactly one copy. An admin reading the policy and an endpoint enforcing
// it must never be able to disagree; a second copy in a template is how
// that starts.
//
// NOTHING here is shown to guests or hosts. It is internal reference for
// resolving disputes.

const { DEFAULT_TIMEZONE, safeZone } = require('./_timezones');

const REVIEW_WINDOW_DAYS = 15;

// ---------------------------------------------------------------------
// Double-blind publication
//
// Neither side sees the other's review until both are in, or the window
// closes. The reason is simple: if a guest could read the host's review
// before writing their own, every review would become a reply. Retaliation
// and reciprocal inflation both get their opening at exactly that moment.
//
//   both submitted        — published immediately, together
//   one submitted, window still open — held, invisible to the other side
//   one submitted, window closed     — published alone
//   neither, window closed           — nothing to publish; the chance is gone
//
// The window runs from CHECKOUT, not from when the first review arrived.
// Anchoring it to the first review would let whoever reviews first choose
// the deadline for the other.
function publicationState(review, counterpartReview, checkoutDate, today) {
  if (!review) return { status: 'none', visible: false, reason: 'No review submitted.' };
  if (review.admin_reverted_at) {
    return { status: 'reverted', visible: false, reason: 'Withdrawn by an administrator.' };
  }
  if (counterpartReview && !counterpartReview.admin_reverted_at) {
    return { status: 'published', visible: true, reason: 'Both sides reviewed — published immediately.' };
  }
  const age = daysSinceCheckout(checkoutDate, today);
  if (age === null) {
    // No usable checkout date means no clock can be trusted. Holding is
    // the safe failure: a review published early cannot be unpublished
    // from someone's memory, but a held one can always be released.
    return { status: 'held', visible: false, reason: 'Awaiting a valid checkout date.' };
  }
  if (age >= REVIEW_WINDOW_DAYS) {
    return { status: 'published', visible: true, reason: `Window closed after ${REVIEW_WINDOW_DAYS} days — published unmatched.` };
  }
  const daysLeft = REVIEW_WINDOW_DAYS - Math.max(0, age);
  return { status: 'held', visible: false, reason: `Held — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left for the other side to review.`, daysLeft };
}

// ---------------------------------------------------------------------
// Whose calendar
//
// The window is counted in the PROPERTY's days. A stay that checked out
// 15 days ago where the property stands is closed, whatever the server's
// clock says: the database runs in UTC, 5h30m behind India, so for the
// first five and a half hours of every Indian day the server still thinks
// it is yesterday. Every function here therefore takes `today` as the
// property's own calendar date, not an instant in time.
//
// Callers get that date from Postgres alongside the booking, with the
// same expression everywhere (see localTodaySql below), so the endpoint
// that accepts a review, the page that offers the button, and the sweep
// that publishes can never disagree about which day it is.
//
// `today` may be a 'YYYY-MM-DD' string or a Date as the database driver
// returns it. Left out, it falls back to today in DEFAULT_TIMEZONE, never
// to the server's own date.

// A calendar date as 'YYYY-MM-DD', from a 'YYYY-MM-DD…' string or from a
// Date. A Date from the driver is midnight of that date in the server's
// local time, so its LOCAL fields are the date that was stored.
function toDateStr(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    const y = value.getFullYear(), m = String(value.getMonth() + 1).padStart(2, '0'), d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Today's date where the property stands.
function localToday(zone, now) {
  const at = now instanceof Date ? now : new Date();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: safeZone(zone), year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(at);
}

// Whole calendar days from checkout to today (0 on the day of checkout,
// negative before it). null when either date is unusable.
function daysSinceCheckout(checkoutDate, today) {
  const c = toDateStr(checkoutDate);
  const t = toDateStr(today) || localToday(DEFAULT_TIMEZONE);
  if (!c || !t) return null;
  const [cy, cm, cd] = c.split('-').map(Number);
  const [ty, tm, td] = t.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(cy, cm - 1, cd)) / 86400000);
}

// Where a booking stands in its review window, on the property's
// calendar: 'upcoming' (not checked out yet), 'open', or 'closed'.
function reviewWindowState(checkoutDate, today) {
  const age = daysSinceCheckout(checkoutDate, today);
  if (age === null) return 'closed';
  if (age < 0) return 'upcoming';
  return age < REVIEW_WINDOW_DAYS ? 'open' : 'closed';
}

// Can this review still be submitted at all? Open from the day of
// checkout until the day before the window's 15th day; refused from then
// on, for guests and hosts alike.
function submissionOpen(checkoutDate, today) {
  return reviewWindowState(checkoutDate, today) === 'open';
}

// ---------------------------------------------------------------------
// Conflicts an admin should look at.
//
// None of these are automatically actioned. They are a queue: a human
// decides. Automating a revert would make the override exactly as gameable
// as the reviews it is meant to police.
const CONFLICT_CHECKS = [
  { key: 'mutual_low',
    label: 'Both sides rated each other poorly',
    detail: 'Each party scored the other below 3. Usually one real dispute, not two independent bad experiences.' },
  { key: 'retaliatory_timing',
    label: 'Second review filed within an hour of the first',
    detail: 'Reviews are double-blind, but a host who guesses a bad review is coming may file quickly. Worth reading both.' },
  { key: 'outlier_against_history',
    label: 'A single review far below the subject\u2019s own average',
    detail: 'One 1-star against a long 4.8 history. Sometimes accurate, sometimes a grudge — read it before it moves a tier.' },
  { key: 'tier_boundary',
    label: 'Review moved a tier by less than 0.05',
    detail: 'The review decided a promotion or demotion on a hair. Worth confirming it is a real signal.' },
  { key: 'reported',
    label: 'Reported by the other party',
    detail: 'Explicitly flagged as unfair or untrue. Always read.' }
];

// ---------------------------------------------------------------------
// The written policy. Admin-only reference text, rendered by the admin
// tool's Policy section. Kept as data, not markup, so it can be displayed
// anywhere without a second copy drifting out of date.
const REVIEW_POLICY = {
  version: '1.0',
  audience: 'Internal — Aerva administrators only. Not shown to guests or hosts.',
  sections: [
    {
      title: 'What is collected',
      points: [
        'A guest reviews the PROPERTY on five factors: hygiene, communication, services, value for money, and location. All five are mandatory, each 1-5.',
        'A host reviews the GUEST on four factors: cleanliness, communication, respectfulness, and rules followed. All four are mandatory, each 1-5.',
        'A written comment is mandatory on both sides. The comment is displayed but never scored — it carries no weight in any tier calculation.',
        'A review missing any rating is not accepted. Reviews that somehow exist without ratings are treated as no review at all, in either direction.'
      ]
    },
    {
      title: 'When a review is published',
      points: [
        `Both sides reviewed: published immediately, together.`,
        `Only one side reviewed: held until ${REVIEW_WINDOW_DAYS} days after checkout, then published unmatched.`,
        `Neither side reviewed within ${REVIEW_WINDOW_DAYS} days of checkout: the opportunity lapses and nothing is published.`,
        'Neither party can read the other\u2019s review before their own is submitted. This is what stops reviews becoming replies.',
        'The window runs from checkout, never from when the first review arrived — otherwise whoever reviews first sets the other\u2019s deadline.',
        'Days are counted on the property\u2019s own calendar, not the server\u2019s. A stay that checked out 15 days ago where the property stands is closed: reviews are refused from that day, for guests and hosts alike, and anything unmatched is published.'
      ]
    },
    {
      title: 'How reviews affect standing',
      points: [
        'Host tiers use the weighted property score. Location carries the lowest weight because a host cannot move the property; hygiene carries the most.',
        'Host tiers also set a minimum for each factor except location. One weak area blocks a rung however good the rest is: ratings of 5, 5, 4.4, 5, 5 average 4.88, above Elite\u2019s 4.85, but services at 4.4 is below Elite\u2019s 4.5 minimum, so the host is held at Signature Host.',
        'A host cannot reach Signature Host or above without a body of real reviews, regardless of revenue.',
        'Guest tiers use the weighted guest score alongside spend and qualifying bookings. Aerva Favorite additionally requires at least three rated reviews.',
        'Host and guest standing are both reviewed quarterly (1 Jan, 1 Apr, 1 Jul, 1 Oct), each against a rolling twelve months. At most one rung is lost per review; gains are uncapped.',
        'Badges shown anywhere on the site are the ones set at the last quarterly review. They do not move between reviews, with one exception: a badge affected by an administrator\u2019s revert is corrected within 48 hours.',
        'Only reviews of stays count toward host and property standing. Experience reviews count only toward the experience\u2019s own badge.'
      ]
    },
    {
      title: 'Administrator override',
      points: [
        'Only an administrator may revert a review. There is no self-service path for either party.',
        'A reverted review is withdrawn from publication immediately. Its effect on badges is removed within 48 hours: the last quarterly review is re-run for the affected property, host or guest with that review left out. No one else\u2019s badge moves.',
        'A revert is never automatic. The conflict checks surface cases for a human to read; they do not act on their own.',
        'Every revert is written to audit_log with the administrator, the reason, and the affected review.',
        'A review should be reverted when it is factually false, retaliatory, or concerns something outside the other party\u2019s control. Not merely because it is unflattering.'
      ]
    }
  ]
};

module.exports = {
  REVIEW_WINDOW_DAYS, CONFLICT_CHECKS, REVIEW_POLICY,
  publicationState, submissionOpen, reviewWindowState, daysSinceCheckout,
  localToday, toDateStr
};
