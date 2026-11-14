// /api/_email-shell.js — the Aerva mark on every email. Not an endpoint.
//
// Owner, 14 Nov 2026: "aerva logo should be part of every email."
//
// Forty-one files send email, each building its own HTML and posting it
// straight to Resend. Adding a header to forty-one bodies by hand would
// mean forty-one chances to get one wrong, and the forty-second sender
// written next week would go out bare.
//
// So the mark is added where every one of them already meets: the POST to
// Resend. Requiring this file once in a process brands everything that
// process sends, including senders added later, and the senders themselves
// need no change.
//
// IT IS INSTALLED AS A PROPERTY, NOT A REPLACEMENT. The test rig assigns
// global.fetch after the API modules load; a wrapper that captured the
// function it found would be thrown away by that assignment and the
// branding would quietly stop. A getter/setter pair keeps the wrapper in
// place and swaps what it calls underneath, so it survives whatever
// replaces fetch, in whatever order.
//
// It never throws and never delays: anything unexpected falls through to
// the original request with the original body.

const LOGO = 'https://aerva.in/aerva-logo.png';
const MARK = 'data-aerva-brand';          // already branded; do not do it twice

// The header, as email clients actually render it: inline styles only, a
// fixed width on the image, and alt text that still reads as Aerva when
// images are blocked — which is the default in most inboxes.
function header() {
  return `<div ${MARK}="1" style="text-align:center; padding:26px 0 18px; font-family:Georgia,'Times New Roman',serif;">
    <img src="${LOGO}" width="34" height="42" alt="Aerva" style="display:inline-block; border:0; outline:none; text-decoration:none; height:42px; width:34px;">
    <div style="font-size:13px; letter-spacing:0.3em; color:#1c1a17; margin-top:8px;">AERVA</div>
    <div style="font-family:Helvetica,Arial,sans-serif; font-size:9px; letter-spacing:0.2em; color:#8a6c39; margin-top:3px;">STAY ELEGANT</div>
  </div>
  <div style="height:1px; background:#e8e0d2; max-width:520px; margin:0 auto 22px;"></div>`;
}

function brand(html) {
  const body = String(html == null ? '' : html);
  if (!body.trim()) return body;                    // nothing to brand
  if (body.includes(MARK)) return body;             // already has it
  return `<div style="background:#ffffff; padding:8px 0;">${header()}${body}</div>`;
}

// Is this the call that sends an email?
function isResend(input, init) {
  const url = typeof input === 'string' ? input : (input && (input.url || String(input))) || '';
  if (!url.startsWith('https://api.resend.com/emails')) return false;
  const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
  return method === 'POST';
}

function brandedBody(body) {
  if (typeof body !== 'string' || !body) return null;
  let parsed;
  try { parsed = JSON.parse(body); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.html !== 'string') return null;
  const next = brand(parsed.html);
  if (next === parsed.html) return null;
  parsed.html = next;
  try { return JSON.stringify(parsed); } catch (e) { return null; }
}

function install() {
  if (globalThis.__aervaEmailBrand) return;         // once per process
  let inner = globalThis.fetch;
  const wrapper = function (input, init) {
    try {
      if (init && isResend(input, init)) {
        const next = brandedBody(init.body);
        if (next != null) init = Object.assign({}, init, { body: next });
      }
    } catch (e) { /* an email that cannot be branded still goes out */ }
    return inner.apply(this, [input, init]);
  };
  try {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      get() { return wrapper; },
      // Whatever replaces fetch — the test rig, a polyfill — becomes what
      // the wrapper calls, rather than replacing the wrapper.
      set(v) { if (typeof v === 'function' && v !== wrapper) inner = v; }
    });
    globalThis.__aervaEmailBrand = true;
  } catch (e) {
    console.error('email branding could not be installed:', e.message);
  }
}

install();

module.exports = { brand, header, install, LOGO, MARK };
