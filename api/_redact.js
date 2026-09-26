// /api/_redact.js — taking contact details out of messages. Not an endpoint.
//
// Used for every message a guest or host types (guest-profile.js, mode
// 'send') and for every template Aerva sends on the host's behalf
// (_template-scheduling.js). Never trust a client-side-only filter for this
// — this is what actually gets enforced before anything is stored/shown.
//
// Worth being upfront: this is pattern-based (regex + a spelled-out-digits
// check). It catches the overwhelming majority of real attempts — plain
// digit sequences in any spacing, spelled-out numbers, emails, and
// Instagram/Facebook/WhatsApp/Telegram mentions and links — but no text
// filter can catch every possible obfuscation a determined person invents
// (letter-substituted digits, unicode lookalikes, a number split across two
// messages, etc.). That's a genuine, known limit of any pattern-based
// approach, not a bug fixable with more regex.

const NUMBER_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9', oh: '0'
};

const SOCIAL_URL_PATTERN = /(instagram\.com|facebook\.com|fb\.com|fb\.me|wa\.me|whatsapp\.com|t\.me|telegram\.me|snapchat\.com)/i;

// Aerva's own Blob store, when it can be told from the upload token
// (vercel_blob_rw_<storeId>_<secret>; the store serves from
// <storeid>.public.blob.vercel-storage.com). Without the token any Blob
// store is accepted — still only a photo link, never free text.
function blobHostPattern() {
  const m = String(process.env.BLOB_READ_WRITE_TOKEN || '').match(/^vercel_blob_rw_([A-Za-z0-9]+)_/);
  const store = m ? m[1].toLowerCase().replace(/[^a-z0-9]/g, '') : '[a-z0-9]+';
  return new RegExp(`^https://${store}\\.public\\.blob\\.vercel-storage\\.com/[A-Za-z0-9._~%/-]+(\\?[A-Za-z0-9=&._-]*)?$`, 'i');
}
// A map link to a latitude/longitude (what @maplink produces from a
// listing's position) — digits, but not a phone number.
const MAP_LATLNG_URL = /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=-?\d{1,3}\.\d+,-?\d{1,3}\.\d+$/;

// Only these links are set aside untouched. Every other link is checked
// like any other text: https://x.co/+919876543210 or http://me@gmail.com
// used to pass because every URL was set aside.
//
// Why anything is set aside at all: the phone-number pattern below (7+
// digits mixed with dashes) happily matches the middle of a Vercel Blob
// filename — a UUID plus random suffix is full of digit runs — and would
// rewrite a check-in photo link into a dead one nobody can tell is broken.
function isProtectedUrl(url) {
  return blobHostPattern().test(url) || MAP_LATLNG_URL.test(url);
}

function redactContactInfo(text) {
  let result = String(text == null ? '' : text);
  let redacted = false;

  const urls = [];
  result = result.replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
    if (SOCIAL_URL_PATTERN.test(match)) {
      redacted = true;
      return '[contact info removed]';
    }
    if (!isProtectedUrl(match)) return match;   // left in place: the patterns below see it
    urls.push(match);
    return `\u0000URL${urls.length - 1}\u0000`;
  });

  result = result.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, () => { redacted = true; return '[email removed]'; });

  result = result.replace(/(\+?\d[\d\s\-.()]{6,}\d)/g, (match) => {
    const digitCount = (match.match(/\d/g) || []).length;
    if (digitCount < 7) return match;
    redacted = true;
    return '[number removed]';
  });

  // Spelled-out digits — "nine eight seven six five four three two one
  // zero" or similar, 7+ consecutive number-words. Deliberately
  // conservative (whole-word matches only) to avoid flagging ordinary
  // sentences that just happen to contain a couple of number-words.
  const words = result.split(/(\s+)/);
  let run = [];
  function flushRun(){
    if (run.length >= 7) {
      redacted = true;
      for (const idx of run) words[idx] = '[number removed]';
    }
    run = [];
  }
  words.forEach((w, idx) => {
    const clean = w.toLowerCase().replace(/[.,\-]/g, '');
    if (NUMBER_WORDS[clean] !== undefined) {
      run.push(idx);
    } else if (w.trim() !== '') {
      flushRun();
    }
  });
  flushRun();
  result = words.join('');
  result = result.replace(/(\[number removed\]\s*){2,}/g, '[number removed] ');

  result = result.replace(/\b(instagram|insta|ig|facebook|fb|whatsapp|telegram|snapchat)\b\s*[:@]?\s*[a-zA-Z0-9._]{2,}/gi, () => { redacted = true; return '[contact info removed]'; });
  result = result.replace(/\b(instagram\.com|facebook\.com|fb\.com|wa\.me|t\.me)\/[a-zA-Z0-9._]+/gi, () => { redacted = true; return '[contact info removed]'; });

  // Put the protected links back now that every pattern has run.
  result = result.replace(/\u0000URL(\d+)\u0000/g, (_m, i) => urls[Number(i)]);

  return { displayText: result, wasRedacted: redacted };
}

module.exports = { redactContactInfo, isProtectedUrl };
