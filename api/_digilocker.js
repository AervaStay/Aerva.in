// /api/_digilocker.js — verifying a guest's ID through DigiLocker. Not an endpoint.
//
// The guest taps "Verify with DigiLocker", logs in to their own DigiLocker
// with their Aadhaar-linked mobile and OTP, and approves sharing their
// Aadhaar. Aerva reads three things from the answer, checks them, and
// throws the rest away:
//
//   • the name          → must match the profile's first and last name
//                         (the same rule as the photo-ID check)
//   • the date of birth → 18 or over
//   • the masked Aadhaar number → only its last 4 digits are kept
//
// Never stored, never logged, never written to disk: the photo, the
// address, the gender, the care-of name, the mobile number on the Aadhaar,
// the XML file link. What is kept is exactly what the photo-ID check keeps:
// guests.guest_id_type / _last4 / _name_match / _verified_at / _method,
// with the method 'digilocker'.
//
// Switching it on (Vercel):
//   DIGILOCKER_PROVIDER           'cashfree'   (the only one built so far)
//   CASHFREE_VERIFY_CLIENT_ID     from the provider
//   CASHFREE_VERIFY_CLIENT_SECRET from the provider
//   CASHFREE_VERIFY_ENV           'sandbox' while testing, else leave unset
//   DIGILOCKER_RETURN_URL         where the guest comes back to, https
//                                 (default https://aerva.in/?view=profile)
//   DIGILOCKER_STARTS_PER_DAY     how many tries an account gets (default 10)
//
// Each start costs money with the provider, so starts are capped per
// account per day and the provider is only called for a guest who still
// needs an ID.
//
// Another provider is one object in PROVIDERS below: start() returns
// { url, verificationId, referenceId }, read() returns
// { state, name, dob, uid } with state 'ok' | 'waiting' | 'expired' |
// 'denied' | 'not_linked'.

const userError = (message, status = 400, extra = {}) => Object.assign(new Error(message), { isUserFacing: true, status }, extra);

const PROVIDER = () => String(process.env.DIGILOCKER_PROVIDER || '').trim().toLowerCase();
const STARTS_PER_DAY = () => Math.max(1, Number(process.env.DIGILOCKER_STARTS_PER_DAY) || 10);
const RETURN_URL = () => {
  const raw = String(process.env.DIGILOCKER_RETURN_URL || 'https://aerva.in/?view=profile').trim();
  return /^https:\/\//i.test(raw) ? raw : 'https://aerva.in/?view=profile';
};

// ------------------------------------------------------------------ providers

async function fetchJson(url, opts, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, Object.assign({ signal: ctrl.signal }, opts));
    const text = await res.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
    return { status: res.status, ok: res.ok, body, text };
  } finally { clearTimeout(t); }
}

const CASHFREE = {
  ready() { return !!(process.env.CASHFREE_VERIFY_CLIENT_ID && process.env.CASHFREE_VERIFY_CLIENT_SECRET); },
  base() {
    return String(process.env.CASHFREE_VERIFY_ENV || '').trim().toLowerCase() === 'sandbox'
      ? 'https://sandbox.cashfree.com/verification'
      : 'https://api.cashfree.com/verification';
  },
  headers() {
    return {
      'x-client-id': String(process.env.CASHFREE_VERIFY_CLIENT_ID || ''),
      'x-client-secret': String(process.env.CASHFREE_VERIFY_CLIENT_SECRET || ''),
      'Content-Type': 'application/json'
    };
  },
  async start(verificationId, returnUrl) {
    const r = await fetchJson(this.base() + '/digilocker', {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({
        verification_id: verificationId,
        document_requested: ['AADHAAR'],      // only the Aadhaar; nothing else is asked for
        redirect_url: returnUrl,
        purpose: 'Aerva guest ID check',
        company_name: 'Aerva'
      })
    });
    if (r.status === 422) throw userError('ID verification with DigiLocker is not available right now. Use a photo of your ID instead.', 503, { reason: 'provider balance' });
    if (!r.ok || !r.body || !r.body.url) {
      const detail = (r.body && r.body.message) || (r.text || '').slice(0, 160);
      throw userError('DigiLocker could not be opened right now. Use a photo of your ID instead.', 503, { reason: 'HTTP ' + r.status + ': ' + detail });
    }
    return { url: String(r.body.url), verificationId, referenceId: r.body.reference_id == null ? null : String(r.body.reference_id) };
  },
  async read(verificationId) {
    const q = '?verification_id=' + encodeURIComponent(verificationId);
    const s = await fetchJson(this.base() + '/digilocker' + q, { method: 'GET', headers: this.headers() });
    if (!s.ok || !s.body) {
      const detail = (s.body && s.body.message) || (s.text || '').slice(0, 160);
      throw userError('We could not reach DigiLocker just now. Please try again in a minute.', 503, { reason: 'status HTTP ' + s.status + ': ' + detail });
    }
    const state = String(s.body.status || '').toUpperCase();
    if (state === 'PENDING') return { state: 'waiting' };
    if (state === 'EXPIRED') return { state: 'expired' };
    if (state === 'CONSENT_DENIED') return { state: 'denied' };
    if (state !== 'AUTHENTICATED') return { state: 'waiting' };
    const shared = Array.isArray(s.body.document_consent) ? s.body.document_consent.map(x => String(x).toUpperCase()) : [];
    if (shared.length && !shared.includes('AADHAAR')) return { state: 'denied' };

    const d = await fetchJson(this.base() + '/digilocker/document/AADHAAR' + q, { method: 'GET', headers: this.headers() });
    if (!d.ok || !d.body) {
      const detail = (d.body && d.body.message) || (d.text || '').slice(0, 160);
      throw userError('We could not read your Aadhaar from DigiLocker just now. Please try again in a minute.', 503, { reason: 'document HTTP ' + d.status + ': ' + detail });
    }
    if (String(d.body.status || '').toUpperCase() === 'AADHAAR_NOT_LINKED') return { state: 'not_linked' };
    // Only these three are read out of the answer. Everything else the
    // provider sent (photo, address, gender, care-of, mobile, XML link)
    // is left in the response object, which goes out of scope here.
    return {
      state: 'ok',
      name: String(d.body.name || '').trim(),
      dob: String(d.body.dob || d.body.year_of_birth || '').trim(),
      uid: String(d.body.uid || '')
    };
  }
};

const PROVIDERS = { cashfree: CASHFREE };
const provider = () => PROVIDERS[PROVIDER()] || null;
const ready = () => { const p = provider(); return !!(p && p.ready()); };

// ------------------------------------------------------------------ the data

// DigiLocker gives the date of birth as DD-MM-YYYY, sometimes YYYY-MM-DD,
// sometimes the year alone. Returns 'YYYY-MM-DD', 'YYYY', or ''.
function normalizeDob(raw) {
  const s = String(raw || '').trim().replace(/\//g, '-');
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/))) return `${m[3]}-${m[2]}-${m[1]}`;
  if ((m = s.match(/^(\d{4})$/))) return m[1];
  return '';
}

// The last 4 of the masked Aadhaar ("xxxxxxxx5647" → "5647").
const last4Of = (uid) => String(uid || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^X+/, '').slice(-4);

// ------------------------------------------------------------------ the table

async function table(sql) {
  try { await sql`SELECT verification_id FROM digilocker_checks LIMIT 0`; return true; }
  catch (err) { return false; }
}

const newVerificationId = (guestId) => 'aerva-' + String(guestId) + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

async function startsToday(sql, guestId) {
  try {
    const r = await sql`SELECT count(*)::int AS n FROM digilocker_checks
                        WHERE guest_id = ${guestId} AND created_at > now() - interval '24 hours'`;
    return Number(r[0] && r[0].n) || 0;
  } catch (err) { return 0; }
}

module.exports = { ready, provider, normalizeDob, last4Of, newVerificationId, startsToday, table, userError, RETURN_URL, STARTS_PER_DAY, PROVIDER };
