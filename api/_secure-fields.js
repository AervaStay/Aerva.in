// /api/_secure-fields.js
// Encrypts the few numbers Aerva must keep but should never hold readable:
// PAN (needed for TDS under section 194-O) and bank account numbers
// (needed for payouts). Not an API endpoint — the leading underscore tells
// Vercel that.
//
// AES-256-GCM with a key that lives only in Vercel's environment
// (DATA_ENCRYPTION_KEY, 32 random bytes, base64). A copy of the database on
// its own — a leaked backup, a stolen Neon login — shows only ciphertext.
//
// Stored form:  enc:v1:<iv>:<tag>:<ciphertext>   (all base64url)
// Anything without that prefix is an older plaintext value; it is still
// read correctly, and the admin's "encrypt stored numbers" action (see
// get-pending-listings.js) rewrites it encrypted.
//
// KEEP THE KEY SAFE AND BACKED UP. Without it the stored numbers cannot be
// read by anyone, Aerva included.

const crypto = require('crypto');
const PREFIX = 'enc:v1:';

function key() {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw) return null;
  const buf = Buffer.from(raw, 'base64');
  return buf.length === 32 ? buf : null;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

// Throws when no valid key is configured: saving a PAN or bank number in
// the clear because a setting was missing is exactly what this prevents.
function encryptField(plain) {
  if (plain == null || plain === '') return null;
  const k = key();
  if (!k) throw new Error('DATA_ENCRYPTION_KEY is not set (or is not 32 bytes, base64) in Vercel.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, enc].map(b => b.toString('base64url')).join(':');
}

// Never throws: a value that cannot be read comes back null (and is logged),
// so one bad row cannot take down a page.
function decryptField(stored) {
  if (stored == null || stored === '') return null;
  if (!isEncrypted(stored)) return String(stored); // older plaintext value
  const k = key();
  if (!k) { console.error('DATA_ENCRYPTION_KEY missing — cannot read an encrypted field.'); return null; }
  try {
    const [ivB, tagB, encB] = stored.slice(PREFIX.length).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(ivB, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encB, 'base64url')), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('Could not decrypt a stored field:', err.message);
    return null;
  }
}

// Is a usable key configured? Checked BEFORE any write, so a request
// either saves encrypted or does not save at all.
function encryptionReady() {
  return !!key();
}

// For admin screens: the readable value, or a loud marker if a stored value
// exists but cannot be read — which only happens when the key in Vercel is
// not the one the data was encrypted with. Never a silent blank.
const UNREADABLE = '\u26a0 unreadable \u2014 check DATA_ENCRYPTION_KEY';
function readableForAdmin(stored) {
  if (stored == null || stored === '') return null;
  const v = decryptField(stored);
  return v == null ? UNREADABLE : v;
}

// Does the configured key open data that is ALREADY encrypted? Used before
// bulk encryption, so a wrong or replaced key can never leave the database
// holding values encrypted under two different keys.
function keyOpens(sampleStored) {
  if (!isEncrypted(sampleStored)) return true; // nothing encrypted yet
  return decryptField(sampleStored) != null;
}

// What the account holder is shown: never the whole number.
function maskPan(stored) {
  const p = decryptField(stored);
  return p && p.length === 10 ? 'XXXXX' + p.slice(5, 9) + 'X' : null;
}
function maskAccount(stored) {
  const a = decryptField(stored);
  return a ? '\u2022\u2022\u2022\u2022 ' + a.slice(-4) : null;
}

// A GSTIN contains the PAN (characters 3–12), so it is stored encrypted
// and shown masked too: state code and last three characters only.
function maskGstin(stored) {
  const g = decryptField(stored);
  return g && g.length === 15 ? g.slice(0, 2) + '\u2022'.repeat(10) + g.slice(12) : null;
}

module.exports = {
  encryptField, decryptField, isEncrypted, maskPan, maskAccount, maskGstin,
  encryptionReady, readableForAdmin, keyOpens, UNREADABLE
};
