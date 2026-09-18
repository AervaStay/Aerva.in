// /api/_profiles.js
// One profile per account. A host is a guest account with a hosts row
// (guests.host_id), so there is no separate "host profile" to keep in
// step with a "guest profile" — the same person, seen from either side.
// Not an API endpoint itself; the leading underscore tells Vercel that.
//
// Three parts, in the order they are shown:
//   1. Get to know them — work, hobbies, and the answers below.
//   2. Where they have been with Aerva — cities they have stayed in, or
//      hosted in.
//   3. What others have said about them — published reviews only.
//
// WHO CAN SEE IT
// Their own profile: always, and editable.
// Someone else's: only once the two are on a confirmed booking together,
// in either direction — a guest may read their host's profile, and a host
// their guest's. Before that there is no relationship, and a profile is
// not a public page.

const { GUEST_FACTORS, REVIEW_FACTORS, reviewScore } = require('./_tiers');

// Asked of everyone, host or guest. Kept short deliberately: a long form
// gets abandoned, and four answers is already more than most people write.
// Answers are stored by id in guests.profile_about, so re-wording a
// question here never orphans what somebody wrote.
const PROFILE_QUESTIONS = [
  { id: 'travel_style',   label: 'How I like to travel',        placeholder: 'Slow mornings, long drives, one bag…' },
  { id: 'favourite_place',label: 'A place that stayed with me',  placeholder: 'Somewhere you still think about.' },
  { id: 'ideal_weekend',  label: 'My ideal weekend',             placeholder: 'What a good Saturday looks like.' },
  { id: 'surprising',     label: 'Something people are surprised to learn about me', placeholder: 'One line is plenty.' }
];

const FIELD_MAX = 400;

// Trims, caps length, and keeps only answers to questions that still
// exist. Returns exactly what should be written — never the raw input.
function sanitizeProfileInput(body) {
  const text = (v) => {
    const t = String(v == null ? '' : v).trim();
    return t ? t.slice(0, FIELD_MAX) : null;
  };
  const about = {};
  const incoming = (body && body.about && typeof body.about === 'object') ? body.about : {};
  PROFILE_QUESTIONS.forEach(q => {
    const answer = text(incoming[q.id]);
    if (answer) about[q.id] = answer;
  });
  return {
    work: text(body && body.work),
    hobbies: text(body && body.hobbies),
    about
  };
}

// The answered questions, in the order they are asked, with their current
// wording. An unanswered question is simply absent.
function answeredQuestions(profileAbout) {
  const about = profileAbout && typeof profileAbout === 'object' ? profileAbout : {};
  return PROFILE_QUESTIONS
    .filter(q => about[q.id])
    .map(q => ({ id: q.id, label: q.label, answer: String(about[q.id]) }));
}

// Where this person has been with Aerva. For a guest, the places they
// have stayed; for a host, the places they host in. Cities only — never
// an address, and never which dates.
async function placesWithAerva(sql, { guestId, hostId }) {
  const out = { stayed: [], hosting: [] };
  try {
    const stayed = await sql`
      SELECT l.city, COUNT(*) AS n, MAX(o.departure) AS last_visit
      FROM orders o JOIN listings l ON l.id = o.listing_id
      WHERE o.guest_id = ${guestId} AND o.status = 'paid' AND o.departure <= CURRENT_DATE
        AND l.city IS NOT NULL AND btrim(l.city) <> ''
      GROUP BY l.city ORDER BY COUNT(*) DESC, MAX(o.departure) DESC
      LIMIT 12
    `;
    out.stayed = stayed.map(r => ({ city: r.city, visits: Number(r.n) }));
  } catch (err) {
    console.error('placesWithAerva (stayed) failed:', err);
  }
  if (hostId) {
    try {
      const hosting = await sql`
        SELECT city, COUNT(*) AS n FROM listings
        WHERE host_id = ${hostId} AND status = 'approved'
          AND city IS NOT NULL AND btrim(city) <> ''
        GROUP BY city ORDER BY COUNT(*) DESC LIMIT 12
      `;
      out.hosting = hosting.map(r => ({ city: r.city, listings: Number(r.n) }));
    } catch (err) {
      console.error('placesWithAerva (hosting) failed:', err);
    }
  }
  return out;
}

// What others have said about this person. Published and non-reverted
// only — the same rule the listing pages follow, so nothing held can be
// read early from here either.
//
// asGuest: what hosts wrote about them after a stay.
// asHost:  what guests wrote about their properties. About the property
//          rather than the person, which is why it is labelled that way.
async function reviewsAboutPerson(sql, { guestId, hostId, limit = 20 }) {
  const out = { asGuest: [], asHost: [], summaryAsGuest: null };
  const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };
  const month = (d) => { const x = new Date(d); return isNaN(x) ? null : x.toISOString().slice(0, 7); };
  try {
    const rows = await sql`
      SELECT published_at, comment, rating, cleanliness, communication, respectful, rules
      FROM guest_reviews
      WHERE guest_id = ${guestId} AND published_at IS NOT NULL AND admin_reverted_at IS NULL
      ORDER BY published_at DESC LIMIT ${limit}
    `;
    out.asGuest = rows.map(r => {
      const f = { cleanliness: n(r.cleanliness), communication: n(r.communication), respectful: n(r.respectful), rules: n(r.rules) };
      const rated = GUEST_FACTORS.some(x => f[x.key] > 0);
      return {
        month: month(r.published_at),
        score: rated ? reviewScore(f, GUEST_FACTORS) : (n(r.rating) || null),
        comment: String(r.comment || '')
      };
    });
    const rated = rows.filter(r => r.cleanliness != null);
    if (rated.length) {
      const avg = (k) => rated.reduce((a, r) => a + n(r[k]), 0) / rated.length;
      out.summaryAsGuest = {
        count: rows.length,
        score: reviewScore({ cleanliness: avg('cleanliness'), communication: avg('communication'), respectful: avg('respectful'), rules: avg('rules') }, GUEST_FACTORS)
      };
    }
  } catch (err) {
    console.error('reviewsAboutPerson (guest) failed:', err);
  }
  if (hostId) {
    try {
      const rows = await sql`
        SELECT r.published_at, r.comment, r.hygiene, r.communication, r.services, r.value_rating, r.location,
               l.property_name
        FROM listing_reviews r JOIN listings l ON l.id = r.listing_id
        WHERE l.host_id = ${hostId} AND r.published_at IS NOT NULL AND r.admin_reverted_at IS NULL
          AND r.hygiene IS NOT NULL
        ORDER BY r.published_at DESC LIMIT ${limit}
      `;
      out.asHost = rows.map(r => ({
        month: month(r.published_at),
        property: r.property_name,
        score: reviewScore({ hygiene: n(r.hygiene), communication: n(r.communication), services: n(r.services), value: n(r.value_rating), location: n(r.location) }, REVIEW_FACTORS),
        comment: String(r.comment || '')
      }));
    } catch (err) {
      console.error('reviewsAboutPerson (host) failed:', err);
    }
  }
  return out;
}

// Assembles one profile. `own` is true when the person is looking at
// their own — that version carries the raw fields for the edit form and
// the unanswered questions, so they can see what else they could add.
async function buildProfile(sql, account, { own = false } = {}) {
  const [places, reviews] = await Promise.all([
    placesWithAerva(sql, { guestId: account.id, hostId: account.host_id }),
    reviewsAboutPerson(sql, { guestId: account.id, hostId: account.host_id })
  ]);
  const profile = {
    name: String(account.name || '').trim() || 'Guest',
    photoUrl: account.profile_photo_url || null,
    isHost: !!account.host_id,
    memberSince: account.created_at ? String(new Date(account.created_at).getFullYear()) : null,
    work: account.profile_work || null,
    hobbies: account.profile_hobbies || null,
    answers: answeredQuestions(account.profile_about),
    places,
    reviews
  };
  if (own) {
    // The form needs every question, answered or not, and the answers in
    // raw form to fill the fields.
    profile.questions = PROFILE_QUESTIONS;
    profile.about = account.profile_about && typeof account.profile_about === 'object' ? account.profile_about : {};
    profile.updatedAt = account.profile_updated_at || null;
  }
  return profile;
}

// Are these two people on a confirmed booking together? This is what
// opens each other's profile, in either direction. A cancelled booking
// still counts: the stay was real enough to have been paid for, and the
// two may still be discussing it.
async function shareABooking(sql, { guestId, hostId }) {
  if (!guestId || !hostId) return false;
  const rows = await sql`
    SELECT 1 FROM orders o JOIN listings l ON l.id = o.listing_id
    WHERE o.guest_id = ${guestId} AND l.host_id = ${hostId}
      AND o.status IN ('paid', 'cancelled')
    LIMIT 1
  `;
  return rows.length > 0;
}

module.exports = {
  PROFILE_QUESTIONS, FIELD_MAX,
  sanitizeProfileInput, answeredQuestions, placesWithAerva, reviewsAboutPerson,
  buildProfile, shareABooking
};
