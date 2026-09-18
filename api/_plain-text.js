// /api/_plain-text.js
// Keeps text that people type from turning into markup. Not an API
// endpoint itself — the leading underscore tells Vercel that.
//
// Much of the site builds HTML by dropping values straight into template
// strings, and most of those places do not escape what they insert. A
// property name like  <img src=x onerror=...>  would run as code on the
// public listing pages and — worse — in the admin tool, where a pending
// listing is rendered for review with an admin signed in. Escaping every
// one of those places is the long-term fix; this closes the door at the
// one point all of it passes through, before anything is stored.
//
// Nothing is thrown away. The three characters that can start markup or
// break out of an HTML attribute are swapped for look-alikes that cannot:
//   <  ->  ‹      >  ->  ›      "  ->  ”
// So "Villa <3" is stored as "Villa ‹3" and still reads the same.
//
// Passwords, tokens, signatures and secrets are never touched: they must
// arrive exactly as typed or they will not match.

const SKIP_KEY = /password|token|signature|secret/i;

function plainText(value) {
  return String(value).replace(/</g, '\u2039').replace(/>/g, '\u203A').replace(/"/g, '\u201D');
}

function cleanValue(value, key) {
  if (typeof value === 'string') return key && SKIP_KEY.test(key) ? value : plainText(value);
  if (Array.isArray(value)) return value.map(v => cleanValue(v, key));
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = cleanValue(value[k], k);
    return value;
  }
  return value;
}

// Cleans a parsed request body in place. Safe to call on anything:
// undefined, a string body, or a nested object.
function sanitizeBody(req) {
  if (req && req.body && typeof req.body === 'object') cleanValue(req.body, null);
}

module.exports = { plainText, sanitizeBody };
