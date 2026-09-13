// /api/_phone-validation.js
// Shared phone format rules — not an API endpoint itself (leading
// underscore tells Vercel that, same convention as every other _helper
// here). This is the SAME list a duplicate copy of lives in index.html's
// own <script> (a browser can't require() a server-side file), kept in
// sync by hand between the two — see the comment there.
//
// Deliberately just length + digits-only for now, not full E.164/libphonenumber-
// grade validation — "we'll take services based on country later on"
// (per the request this was built for) means real per-country SMS
// routing and stricter validation both come later; this is enough to
// catch an obviously wrong number (too short, too long, letters mixed
// in) without needing a heavy phone-number library today.
const COUNTRY_PHONE_RULES = [
  { code: 'IN', dialCode: '+91', name: 'India', length: 10 },
  { code: 'US', dialCode: '+1', name: 'United States', length: 10 },
  { code: 'CA', dialCode: '+1', name: 'Canada', length: 10 },
  { code: 'GB', dialCode: '+44', name: 'United Kingdom', length: 10 },
  { code: 'AE', dialCode: '+971', name: 'United Arab Emirates', length: 9 },
  { code: 'AU', dialCode: '+61', name: 'Australia', length: 9 },
  { code: 'SG', dialCode: '+65', name: 'Singapore', length: 8 },
  { code: 'NP', dialCode: '+977', name: 'Nepal', length: 10 },
  { code: 'LK', dialCode: '+94', name: 'Sri Lanka', length: 9 },
  { code: 'BD', dialCode: '+880', name: 'Bangladesh', length: 10 },
  { code: 'DE', dialCode: '+49', name: 'Germany', length: 11 },
  { code: 'FR', dialCode: '+33', name: 'France', length: 9 },
];

function findCountryRule(countryCode) {
  return COUNTRY_PHONE_RULES.find(c => c.code === countryCode) || null;
}

// E.164: a leading +, then 8-15 digits, first digit 1-9. This is the
// storage format for guests.phone (see schema.sql's comment on that
// column) and the format Twilio Verify expects.
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

// The default assumed when someone types a bare local number with no
// country code at all. India, because that's where essentially every
// Aerva guest and property is, and because charges are INR-only anyway.
const DEFAULT_DIAL_CODE = '+91';

// Turns a country code + local digits into the single stored E.164
// string. Used by anything that collects the two separately (a country
// dropdown plus a number field).
function toE164(countryCode, localNumber) {
  const check = validatePhoneNumber(countryCode, localNumber);
  if (!check.valid) return { valid: false, error: check.error };
  const rule = findCountryRule(countryCode);
  return { valid: true, e164: `${rule.dialCode}${check.digits}` };
}

// Best-effort normalization of a free-typed phone number into E.164.
// This exists because guests.phone was written three different ways
// historically — full E.164 from phone/OTP login, a bare local number
// from the old free-text signup field, and country-code-plus-local for
// hosts — which meant the SAME person could end up with two separate
// accounts that never matched each other.
//
// Handles: already-E.164, international 00 prefix, spaces/dashes/
// parentheses, a leading 0 trunk prefix on a local number, and a bare
// local number (assumed DEFAULT_DIAL_CODE). Returns null rather than
// guessing when the result wouldn't be a plausible E.164 number — the
// caller decides whether that's an error or just a field left blank.
function normalizeToE164(raw, defaultDialCode = DEFAULT_DIAL_CODE) {
  if (!raw || typeof raw !== 'string') return null;

  let s = raw.trim().replace(/[\s\-().]/g, '');
  if (!s) return null;

  if (s.startsWith('00')) s = '+' + s.slice(2); // 00 is the international prefix in much of the world
  if (s.startsWith('+')) {
    return E164_PATTERN.test(s) ? s : null;
  }
  if (!/^[0-9]+$/.test(s)) return null; // letters or stray symbols — not salvageable

  // A leading 0 on a local number is a domestic trunk prefix (0 98765
  // 43210), never part of the E.164 number itself.
  s = s.replace(/^0+/, '');
  if (!s) return null;

  // A bare local number with no country code is the one case where this
  // has to GUESS, and a wrong guess is worse than a rejection: it would
  // silently file a US number like 4155550123 as +914155550123, a real
  // but completely different Indian number, under someone's account.
  //
  // So the default dial code is only applied when the number actually
  // fits that country's shape. For India that's 10 digits starting 6-9
  // (every Indian mobile does; US area codes start 2-5 as often as not,
  // so they fall through to null instead of being mangled). Anything
  // else comes back null and the caller asks for a country code.
  //
  // These are the same two shapes migration_phone_e164_and_commission.sql
  // converts, kept deliberately identical so a number normalized at
  // runtime and one normalized by the migration can never disagree.
  if (defaultDialCode === DEFAULT_DIAL_CODE) {
    if (/^91[6-9]\d{9}$/.test(s)) return `+${s}`; // country code present, just missing the +
    if (!/^[6-9]\d{9}$/.test(s)) return null;
  }

  const candidate = `${defaultDialCode}${s}`;
  return E164_PATTERN.test(candidate) ? candidate : null;
}

// The last 10 digits of a number, used ONLY to match a newly verified
// E.164 number against rows written before normalization existed (e.g. a
// guest who signed up by email typing "9876543210", then later logs in
// with "+919876543210" — same person, two different strings). Not a
// general-purpose identity check: 10 digits is short enough that two
// numbers in different countries could theoretically collide, so this is
// only ever used as a tiebreaker alongside other signals, never on its
// own to authenticate anyone.
function phoneMatchSuffix(phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

module.exports = {
  COUNTRY_PHONE_RULES, findCountryRule, validatePhoneNumber,
  E164_PATTERN, DEFAULT_DIAL_CODE, toE164, normalizeToE164, phoneMatchSuffix
};

// Server-side validation — never trusts whatever the client already
// checked, since a direct API call could skip the frontend entirely.
//
// Formatting is CLEANED before checking rather than rejected: spaces,
// dashes, brackets and dots are how people actually write phone numbers,
// and a leading 0 is a domestic trunk prefix, not part of the number.
// This matches guest-login.html's client-side buildE164 exactly — while
// the two disagreed, a number the form happily accepted could still come
// back refused by the server for no reason the person could see.
// Letters and stray symbols are still rejected outright, as is any
// number that isn't the right length for its country.
function validatePhoneNumber(countryCode, localNumber) {
  const rule = findCountryRule(countryCode);
  if (!rule) return { valid: false, error: 'Please select a valid country.' };
  const cleaned = typeof localNumber === 'string'
    ? localNumber.trim().replace(/[\s\-().]/g, '').replace(/^0+/, '')
    : '';
  if (!cleaned) {
    return { valid: false, error: 'Please enter your phone number.' };
  }
  if (!/^[0-9]+$/.test(cleaned)) {
    return { valid: false, error: 'Phone number must contain digits only — no letters or symbols.' };
  }
  if (cleaned.length !== rule.length) {
    return { valid: false, error: `${rule.name} numbers are exactly ${rule.length} digits — that one has ${cleaned.length}.` };
  }
  return { valid: true, digits: cleaned };
}
