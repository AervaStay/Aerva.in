// /api/_env.js — production or UAT, and the safety rails for UAT.
// Not an endpoint. Required first by every endpoint file.
//
// Which one: AERVA_ENV if set (Vercel → Settings → Environment Variables),
// otherwise Vercel's own VERCEL_ENV — 'production' is production, and any
// other deployment (the uat branch, any preview) is treated as UAT.
//
// In UAT (the database there is a copy of live data, real guests included):
//   • Live Razorpay keys are refused outright — UAT must use rzp_test_ keys,
//     so it can never take or refund real money or send a real payout.
//   • Every email goes to UAT_EMAIL_TO only (the Aerva team), with "[UAT]"
//     in the subject and the address it would have gone to — never to a
//     real guest or host. Without UAT_EMAIL_TO, emails are not sent at all.
//   • Links in those emails point at the UAT site (UAT_SITE_URL).
//   • The database, sign-in secret and Razorpay keys come from UAT_ twins
//     (UAT_DATABASE_URL, …), never from production's values.
//   • Stored files are never deleted, renamed or overwritten.

const ENV = (process.env.AERVA_ENV || '').toLowerCase()
  || (process.env.VERCEL_ENV === 'production' ? 'production' : process.env.VERCEL_ENV ? 'uat' : 'local');
const IS_PROD = ENV === 'production';
const IS_UAT = ENV === 'uat';

// ---- UAT's own settings ----
// Vercel hands previews the production values (the Neon integration's
// DATABASE_URL cannot be split per branch). So UAT never trusts them: in
// UAT every value below is replaced by its UAT_ twin, set in Vercel for
// Preview. DATABASE_URL and APPROVAL_TOKEN_SECRET are required — without a
// UAT_ twin, or with one equal to production's, UAT refuses to start
// rather than touch the live database or accept live sign-ins.
const UAT_OVERRIDES = ['DATABASE_URL', 'APPROVAL_TOKEN_SECRET', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'];
const UAT_REQUIRED = ['DATABASE_URL', 'APPROVAL_TOKEN_SECRET'];
let uatSetupError = null;
function dbHost(url) { try { return new URL(String(url)).hostname.replace(/-pooler(?=\.)/, '').toLowerCase(); } catch (e) { return ''; } }
if (IS_UAT && !globalThis.__aervaUatVars) {
  globalThis.__aervaUatVars = true;
  const live = {};
  for (const k of UAT_OVERRIDES) live[k] = process.env[k];
  for (const k of UAT_OVERRIDES) {
    const v = process.env['UAT_' + k];
    if (v) process.env[k] = v;
    else if (UAT_REQUIRED.includes(k)) { delete process.env[k]; uatSetupError = uatSetupError || `UAT_${k} is not set in Vercel (Preview).`; }
  }
  if (!uatSetupError && live.DATABASE_URL && dbHost(live.DATABASE_URL) === dbHost(process.env.DATABASE_URL)) {
    delete process.env.DATABASE_URL;
    uatSetupError = 'UAT_DATABASE_URL points at the LIVE database. Use the Neon uat branch connection string.';
  }
  if (!uatSetupError && live.APPROVAL_TOKEN_SECRET && live.APPROVAL_TOKEN_SECRET === process.env.APPROVAL_TOKEN_SECRET) {
    uatSetupError = 'UAT_APPROVAL_TOKEN_SECRET must differ from production\'s APPROVAL_TOKEN_SECRET.';
  }
}

function liveKeyInUse() {
  return ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'].some(k => /^rzp_live/i.test(String(process.env[k] || '')));
}

// ---- Outbound requests in UAT ----
// Every email in the codebase goes through fetch, so the
// rail is one wrapper around it, installed once per function instance.
if (IS_UAT && typeof globalThis.fetch === 'function' && !globalThis.__aervaUatFetch) {
  const realFetch = globalThis.fetch;
  const siteUrl = String(process.env.UAT_SITE_URL || '').replace(/\/$/, '');
  globalThis.__aervaUatFetch = true;
  globalThis.fetch = async function uatFetch(input, init) {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    if (/^https:\/\/api\.razorpay\.com\//.test(url) && liveKeyInUse()) {
      throw new Error('UAT refuses live Razorpay keys. Set rzp_test_ keys for this environment.');
    }
    // Resend (email)
    if (/^https:\/\/api\.resend\.com\/emails/.test(url) && init && typeof init.body === 'string') {
      const to = String(process.env.UAT_EMAIL_TO || '').trim();
      let body; try { body = JSON.parse(init.body); } catch (e) { body = null; }
      if (!body) return realFetch(input, init);
      const original = [].concat(body.to || []).join(', ');
      if (!to) {
        console.log(`[UAT] email not sent (no UAT_EMAIL_TO): "${body.subject}" → ${original}`);
        return new Response(JSON.stringify({ id: 'uat-suppressed' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      body.to = to.split(',').map(s => s.trim()).filter(Boolean);
      delete body.cc; delete body.bcc;
      body.subject = '[UAT] ' + String(body.subject || '');
      if (typeof body.html === 'string') {
        let html = body.html;
        if (siteUrl) html = html.split('https://aerva.in').join(siteUrl);
        body.html = `<div style="font:12px sans-serif; background:#fbefec; color:#7a2e25; padding:8px 12px; margin-bottom:12px;">UAT test email — on live this would go to <strong>${original.replace(/[<>&]/g, '')}</strong></div>` + html;
      }
      return realFetch(input, { ...init, body: JSON.stringify(body) });
    }
    return realFetch(input, init);
  };
}

// ---- Stored files (photos, ID documents) in UAT ----
// Production and UAT share ONE Vercel Blob store, and UAT's database is a
// copy of live — so every file address in it points at a LIVE file.
// Deleting or renaming one from UAT would remove it from aerva.in. So
// outside production, files are never deleted, renamed or overwritten:
// del() and rename() report success and do nothing (the UAT database moves
// on as if the file were gone; the live file stays), and put()/copy() may
// only create new files. Patched on the shared module, so every caller —
// account deletion, ID document review, anything added later — is covered.
if (!IS_PROD && !globalThis.__aervaUatBlob) {
  globalThis.__aervaUatBlob = true;
  try {
    const blob = require('@vercel/blob');
    const kept = (what) => async (target) => {
      const n = [].concat(target || []).length;
      console.log(`[${ENV}] ${what} skipped for ${n} stored file(s) — only production changes stored files.`);
      return undefined;
    };
    blob.del = kept('delete');
    if (typeof blob.rename === 'function') blob.rename = kept('rename');
    for (const fn of ['put', 'copy', 'putFromUrl']) {
      const real = blob[fn];
      if (typeof real !== 'function') continue;
      blob[fn] = function (a, b, options) {
        const opts = Object.assign({}, options || {}, { allowOverwrite: false });
        return real.call(this, a, b, opts);
      };
    }
  } catch (e) { /* @vercel/blob not installed here: nothing to guard */ }
}

// The Razorpay SDK does not use fetch, so live keys are also checked when a
// function starts: a UAT function with live keys fails at once, loudly,
// before it can do anything.
function assertSafeForEnv() {
  if (IS_UAT && uatSetupError) throw new Error('UAT is not set up safely: ' + uatSetupError);
  if (IS_UAT && liveKeyInUse()) {
    throw new Error('This is UAT, but live Razorpay keys are set. Use rzp_test_ keys for the uat branch in Vercel.');
  }
}
assertSafeForEnv();

module.exports = { ENV, IS_PROD, IS_UAT, assertSafeForEnv };
