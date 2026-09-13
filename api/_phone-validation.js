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

// Server-side validation — never trusts whatever the client already
// checked, since a direct API call could skip the frontend entirely.
// Requires digits only (no spaces, dashes, letters, or symbols) and the
// exact length that country's local numbers use.
function validatePhoneNumber(countryCode, localNumber) {
  const rule = findCountryRule(countryCode);
  if (!rule) return { valid: false, error: 'Please select a valid country.' };
  const digitsOnly = typeof localNumber === 'string' ? localNumber.trim() : '';
  if (!/^[0-9]+$/.test(digitsOnly)) {
    return { valid: false, error: 'Phone number must contain digits only — no letters, spaces, or symbols.' };
  }
  if (digitsOnly.length !== rule.length) {
    return { valid: false, error: `A ${rule.name} number must be exactly ${rule.length} digits (got ${digitsOnly.length}).` };
  }
  return { valid: true, digits: digitsOnly };
}

module.exports = { COUNTRY_PHONE_RULES, findCountryRule, validatePhoneNumber };
