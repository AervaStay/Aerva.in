// /api/guest-profile.js
// Everything a logged-in guest's profile page needs, in one call, plus the
// ability to update their own name and profile photo — and, folded in
// here rather than as a separate file (Vercel Hobby plan's 12-function
// cap), the host-guest chat feature: conversations, sending messages
// with contact-info redaction, and host quick-reply templates.
//
//   GET  (Authorization: Bearer <guestSessionToken>)
//     Returns { guest, bookings, reviews }. "guest" includes a computed
//     "badge" field — the label of the guest's quarterly standing.
//
//   GET  ?mode=conversation&orderId=X      — fetch/create the chat for one confirmed booking
//   GET  ?mode=hostConversations           — a host's inbox across all their listings
//   GET  ?mode=templates                   — a host's own quick-reply templates
//
//   PATCH { name?, profilePhotoUrl?, preferredCurrency? } (Authorization: Bearer <token>)
//     Updates only the fields provided. The photo itself is uploaded
//     directly to Vercel Blob from the browser first (see blob-upload.js,
//     same endpoint listing photos already use) — this call just saves
//     the resulting URL against the guest's account.
//
//   POST { mode: 'logoutAllDevices' } — ends every session of this account
//   POST { mode: 'send', conversationId, text }
//   POST { mode: 'unsend', conversationId, messageId, role } — own message, within 1 hour
//   POST { mode: 'react', conversationId, messageId, emoji, role } — smiley on the other side's message
//   GET mode=myFavorites · POST { mode: 'setFavorite', listingId(s), on } — hearted homes on the account
//   POST { mode: 'saveTemplate', templateId?, listingId?, body }
//   POST { mode: 'deleteTemplate', templateId }
//   POST { mode: 'translate', text, targetLang }
//     Machine-translates one message via Google Cloud Translation API.
//     Requires GOOGLE_TRANSLATE_API_KEY. Available to either side of a
//     conversation — just needs a valid session, not conversation
//     ownership, since it's a stateless text-in/text-out utility.
//
// A conversation only ever exists tied to a confirmed (status='paid')
// order — there is no path anywhere on the site for a guest to message a
// host without an actual booking. See redactContactInfo() below for the
// message-filtering approach and its real, worth-knowing limitations.

require('./_env'); // production vs UAT safety rails — must load first
const { neon } = require('@neondatabase/serverless');
const { daysSinceCheckout, submissionOpen, reviewWindowState, REVIEW_WINDOW_DAYS, cleanReviewPhotos } = require('./_review-policy');
const { DEFAULT_TIMEZONE } = require('./_timezones');
const { buildProfile, sanitizeProfileInput, PRIVACY_OPTIONS, sanitizePrivacy, readPrivacy } = require('./_profiles');
const { GUEST_FACTORS, EXPERIENCE_FACTORS, GUEST_TIERS, tierByKey } = require('./_tiers');
const { verifyToken } = require('./_approval-token');
const { isAccountDeleted, deletionBlockers, deleteAccount, sessionStatus, bumpSessionVersion, newSessionToken, SUSPENDED_MESSAGE } = require('./_accounts');
const { logAudit } = require('./_audit-log');
const { sanitizeBody } = require('./_plain-text');
const { cancellationQuote, createCancellationRequest, cancellationCard } = require('./_cancellations');
const { changeOptions, quoteChange, requestChange, withdrawChange, openChangeFor, loadBooking } = require('./_booking-changes');
const { idSummary } = require('./_guest-id');
const idVerify = require('./_id-verify');
const emailOtp = require('./_email-otp');
const photoGuard = require('./_photo-guard');
const { raiseDispute, openDisputeFor, REASONS: DISPUTE_REASONS } = require('./_stay-disputes');
const support = require('./_support');
const supportChat = require('./_support-chat');
// The problem-report card at the top of a booking's thread.
async function disputeCard(sql, conversationId, role) {
  try {
    const c = (await sql`SELECT order_id FROM conversations WHERE id = ${conversationId}`)[0];
    const d = c && c.order_id ? await openDisputeFor(sql, c.order_id) : null;
    if (!d) return null;
    return { disputeId: d.id, reason: DISPUTE_REASONS[d.reason] || 'Problem', details: d.details, status: d.status, role,
             evidence: role === 'host' ? d.evidence : undefined, hostResponded: !!d.host_responded_at };
  } catch (err) { return null; }
}
const { normalizeToE164 } = require('./_phone-validation');
const { getClientIp, countRecentAttempts } = require('./_rate-limit');
const bcrypt = require('bcryptjs');
// Same lifetime as a sign-in (guest-auth.js), for the fresh token after an email change.
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

// What the guest sees about a change: never the internal pricing record.
function changeView(qc) {
  if (qc.kind === 'transfer') return require('./_booking-transfers').transferView(qc);
  const q = qc.quote;
  if (q.kind === 'experience' || q.kind === 'pair') {
    const x = q.experience, st = q.stay;
    const lines = [{ label: `${x.suite} — ${x.guests} guest${x.guests === 1 ? '' : 's'}`, amount: x.subtotal }];
    if (st) lines.push({ label: `Included stay — ${st.nights} night${st.nights === 1 ? '' : 's'}`, amount: st.subtotal });
    lines.push({ label: 'GST', amount: x.gst + (st ? st.gst : 0) });
    lines.push({ label: 'Guest service fee', amount: x.guestServiceFee + (st ? st.guestServiceFee : 0) });
    if (st && st.depositAmount) lines.push({ label: 'Refundable deposit', amount: st.depositAmount });
    return { summary: qc.summary, lines, oldTotal: qc.oldTotal, newTotal: qc.newTotal, difference: qc.difference, couponNotReturned: qc.couponNotReturned || 0 };
  }
  const lines = [{ label: `${q.nights} night${q.nights === 1 ? '' : 's'}${q.discountAmount ? ' (after discount)' : ''}`, amount: q.roomPortion }];
  (q.amenities || []).forEach(a => lines.push({ label: a.name, amount: a.total }));
  if (q.petFeeAmount) lines.push({ label: 'Pet fee', amount: q.petFeeAmount });
  // The free cancellation add-on stays with the booking (_booking-changes.js).
  if (q.freeCancelFee) lines.push({ label: q.freeCancelExtra ? `Free cancellation (₹${Number(q.freeCancelExtra).toLocaleString('en-IN')} more for the added nights)` : 'Free cancellation (kept)', amount: q.freeCancelFee });
  if (q.gst || q.freeCancelGst) lines.push({ label: 'GST', amount: (q.gst || 0) + (q.freeCancelGst || 0) });
  lines.push({ label: 'Guest service fee', amount: q.guestServiceFee });
  if (q.depositAmount) lines.push({ label: 'Refundable deposit', amount: q.depositAmount });
  // Leaving early (owner, 10 Nov 2026 01:28): the nights not stayed stay paid.
  if (qc.leavingEarly) lines.push({ label: 'Nights you don’t stay (not refunded)', amount: qc.leavingEarly.notRefunded });
  return { summary: qc.summary, lines, oldTotal: qc.oldTotal, newTotal: qc.newTotal, difference: qc.difference, couponNotReturned: qc.couponNotReturned || 0,
           leavingEarly: qc.leavingEarly || null };
}
// The change card at the top of a booking's thread.
async function changeCard(sql, conversationId, role) {
  try {
    const c = (await sql`SELECT c.order_id FROM conversations c WHERE c.id = ${conversationId}`)[0];
    if (!c || !c.order_id) return null;
    // A change to an "Includes a Stay" pair shows in the thread of either half.
    const main = await loadBooking(sql, c.order_id);
    const ch = await openChangeFor(sql, main ? main.id : c.order_id);
    if (!ch) return null;
    if (role === 'host') return ch.status === 'pending' ? { changeId: ch.id, summary: ch.summary, difference: ch.difference } : { changeId: ch.id, summary: ch.summary, awaitingPayment: ch.difference };
    return { changeId: ch.id, orderId: c.order_id, summary: ch.summary, status: ch.status, difference: ch.difference };
  } catch (err) { return null; }
}
let razorpayInstance = null;
function razorpayClient() {
  if (!razorpayInstance) {
    const Razorpay = require('razorpay');
    razorpayInstance = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  }
  return razorpayInstance;
}
const { resolveActingHost, cohostCan, cohostHasListing, cohostDetailsMissing, DETAILS_REQUIRED_MESSAGE } = require('./_cohosts');

const sql = neon(process.env.DATABASE_URL);

// Normalizes a DATE column value to 'YYYY-MM-DD' whether the driver
// returns it as a JS Date object or an already-formatted string — same
// helper used in get-listings.js/create-order.js/host-listings.js for
// the same reason (see host-listings.js's own comment on this: skipping
// it is what caused the 48-hour cancellation cutoff to silently miscalc
// via a mangled date-string concatenation). Needed here now that
// hostConversations returns booking dates for the inbox's status tags.
// A first or last name as on a government ID. Spaces are tidied (and
// curly apostrophes made straight) before checking; nothing else is
// changed. \p{M} keeps the vowel signs of Indian scripts (हि, ಶ್ರೀ).
function cleanPersonName(v) {
  return typeof v === 'string' ? v.normalize('NFC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim() : '';
}
function nameProblem(v, which) {
  const label = which === 'first' ? 'first name' : 'last name';
  if (!v) return `Please enter your ${label}.`;
  if ([...v].length > 50) return `Your ${label} can be at most 50 characters.`;
  if (/\d/u.test(v)) return `Your ${label} cannot contain numbers — please write it as on your government ID.`;
  if (!/^[\p{L}\p{M} .'-]+$/u.test(v)) return `Your ${label} can only have letters, spaces, dots, apostrophes and hyphens.`;
  if (!/\p{L}/u.test(v)) return `Please enter your ${label} with letters.`;
  return null;
}

// Their own profile also carries the first and last name, for the
// "Your name" row (never shown on a profile someone else opens).
function ownNames(profile, row) {
  return Object.assign(profile, { firstName: String(row.first_name || '').trim(), lastName: String(row.last_name || '').trim() });
}

function toDateStr(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0];
  return String(val).slice(0, 10);
}


// The signed session payload, or null. payload.listingId is the guest's id
// (generically-named token field — see host-auth.js note).
function requireGuest(req) {
  const authHeader = req.headers['authorization'] || '';
  const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = sessionToken ? verifyToken(sessionToken) : null;
  if (!payload || payload.action !== 'guest-session') return null;
  return payload;
}

// ---- Contact-info redaction (server-side, authoritative) ----
// Lives in _redact.js so the messages Aerva sends on a host's behalf
// (_template-scheduling.js) go through exactly the same filter.
const { redactContactInfo } = require('./_redact');
const { guardMessage } = require('./_message-guard');
const { createInquiry, adoptInquiryThread, inquiryDetails } = require('./_inquiries');


// ---- "How was your stay / your guest?" inside a message thread ----
// For the person reading the thread: is their review still to be written,
// for which booking, and how many days are left. null when there is
// nothing to ask for (not checked out, already written, window closed).
async function threadReviewPrompt(sql, conversationId, role) {
  try {
    const o = (await sql`
      SELECT o.id, o.suite_name, COALESCE(o.order_type, 'stay') AS order_type, o.departure,
             COALESCE(NULLIF(btrim(g.name), ''), 'Guest') AS guest_name, o.deposit_status, o.deposit_amount,
             (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), ${DEFAULT_TIMEZONE}))::date AS local_today
      FROM conversations c JOIN orders o ON o.id = c.order_id
      JOIN listings l ON l.id = o.listing_id LEFT JOIN guests g ON g.id = o.guest_id
      WHERE c.id = ${conversationId} AND o.status = 'paid'
    `)[0];
    if (!o) return null;
    if (reviewWindowState(o.departure, o.local_today) !== 'open') return null;
    const done = role === 'host'
      ? (await sql`SELECT 1 FROM guest_reviews WHERE order_id = ${o.id} LIMIT 1`).length > 0
      : (await sql`SELECT 1 FROM listing_reviews WHERE order_id = ${o.id} LIMIT 1`).length > 0;
    if (done) return null;
    return { orderId: o.id, role, listingName: o.suite_name || '', listingType: o.order_type === 'experience' ? 'experience' : 'stay',
             guestName: o.guest_name || 'your guest', daysLeft: Math.max(0, REVIEW_WINDOW_DAYS - daysSinceCheckout(o.departure, o.local_today)),
             // The host may release a deposit still held, with their review.
             depositHeld: role === 'host' && o.deposit_status === 'held' && Number(o.deposit_amount) > 0 ? Math.round(Number(o.deposit_amount)) : 0 };
  } catch (err) {
    console.error('threadReviewPrompt skipped:', err.message);
    return null;   // never block a conversation over the prompt
  }
}

// A co-host may only see and change a template whose auto-send listings
// are all theirs (and there is at least one): an empty list means "every
// listing the host has", which is the host's to decide. A template tied
// to one of their listings (listing_id) counts too.
function templateListingIds(t) {
  let ids = t.auto_send_listing_ids;
  if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch (e) { ids = []; } }
  return Array.isArray(ids) ? ids.map(Number).filter(Number.isInteger) : [];
}
function cohostOwnsTemplate(ctx, t) {
  const ids = templateListingIds(t);
  if (ids.length) return ids.every(id => cohostHasListing(ctx, id)) && (t.listing_id == null || cohostHasListing(ctx, t.listing_id));
  return t.listing_id != null && cohostHasListing(ctx, t.listing_id);
}

// Unsent messages: within this many minutes of sending, and shown to both
// sides without their text (the text stays stored for Aerva's records).
const UNSEND_MINUTES = 60;
// Smileys a person can put on the other side's message.
const REACTIONS = ['👍', '❤️', '😊', '🙏', '😂', '👌'];
// A gift's recipient and a group booking's friends use the booking's Messages
// but never see its money (_gifts.js): amounts are hidden in Aerva's notices —
// the 'system' ones and the automatic ones posted in the host's name
// ("Booking changed. … Paid: ₹…", "Transfer accepted. … pay the difference of ₹…").
const AUTO_NOTICE_RE = /^(Booking (changed|transferred)\.|(Transfer|Change) accepted\.|The change was not made|Aerva has decided|I’d like to (move part of|change) this booking\.)/;
function hideMoneyForShared(text, senderType) {
  const t = String(text || '');
  if (senderType !== 'system' && !AUTO_NOTICE_RE.test(t)) return t;
  return t.replace(/(₹|Rs\.?|INR)\s?[\d,]+(\.\d+)?/g, 'an amount');
}
function unsentView(m) {
  if (!Array.isArray(m.photos) || !m.photos.length) delete m.photos;
  if (!m.guest_reaction) delete m.guest_reaction;
  if (!m.host_reaction) delete m.host_reaction;
  if (!m.unsent_at) { delete m.unsent_at; return m; }
  return { id: m.id, sender_type: m.sender_type, created_at: m.created_at, display_text: '', was_redacted: false, unsent: true, unsent_at: m.unsent_at };
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  // Typed text can never become markup — messages, names, templates,
  // profile answers (see _plain-text.js). It was imported but never called.
  sanitizeBody(req);

  const session = requireGuest(req);
  let guestId = session ? session.listingId : null; // `let`: a co-host request continues as the host's side (below)
  if (!guestId) return res.status(401).json({ error: 'Please log in again.' });
  // Deleted, or logged out everywhere since this token was issued (see
  // sessionStatus in _accounts.js). A check that cannot run answers 503,
  // not 401, so a database hiccup never signs anyone out of the page.
  {
    const st = await sessionStatus(sql, session);
    if (st === 'deleted') return res.status(401).json({ error: 'This account has been deleted.' });
    if (st === 'suspended') return res.status(401).json({ error: SUSPENDED_MESSAGE, suspended: true, signinHelp: true });
      if (st === 'revoked') return res.status(401).json({ error: 'Please log in again.' });
    if (st !== 'ok') return res.status(503).json({ error: 'Could not check your sign-in right now. Please try again.' });
  }

  // ---- ID verification (Account Settings) — see _id-verify.js ----
  // GET ?mode=idVerification → the outcome, the ID types, whether the Aadhaar ZIP option is on.
  // POST { mode: 'verifyId', docType, name, dob, last4, files: [{ type, data }] }
  // POST { mode: 'verifyAadhaarZip', zip, zipPassword }
  // The document is checked in memory and never stored; only the outcome is.
  if (req.method === 'GET' && (req.query || {}).mode === 'idVerification' && (req.query || {}).actingHost === undefined) {
    return res.status(200).json(await idVerify.status(sql, guestId));
  }
  if (req.method === 'POST' && req.body && (req.body.mode === 'verifyId' || req.body.mode === 'verifyAadhaarZip') && (req.query || {}).actingHost === undefined) {
    try {
      const out = req.body.mode === 'verifyId'
        ? await idVerify.verifyDocument(sql, logAudit, guestId, req.body)
        : await idVerify.verifyAadhaarZip(sql, logAudit, guestId, req.body);
      // The same proof counts for bookings when it meets the same rules: an
      // accepted type, in the profile's name, 18 or over (_guest-verify.js).
      if (req.body.mode === 'verifyId') {
        out.bookingVerified = await require('./_guest-verify').adoptFromIdVerify(sql, razorpayClient(), guestId, { docType: String(req.body.docType || ''), dob: req.body.dob, verification: out.verification });
      }
      return res.status(200).json(Object.assign({ success: true }, out));
    } catch (err) {
      if (err.isUserFacing) return res.status(err.status || 400).json({ error: err.message });
      console.error('ID verification failed:', err);
      return res.status(500).json({ error: 'ID verification is not available right now. Please try again later.' });
    }
  }

  // ---- A verified profile: name, phone code, photo ID (_guest-verify.js) ----
  // A booking is only confirmed once all three are done (owner, 10 Nov 2026).
  // GET ?mode=verification → the three steps, and any payments waiting on them
  // POST { mode: 'sendPhoneCode' }                 → a code by SMS to the account's number
  // POST { mode: 'checkPhoneCode', code }          → confirms the number
  // POST { mode: 'checkGuestId', files: [{ type, data }] } → the instant ID check (the image is never stored)
  // POST { mode: 'sendGuestIdForReview', url }     → "Send it to Aerva to check instead"
  // Each answer carries `confirmed`: the waiting payments that became bookings.
  const GV_MODES = ['sendPhoneCode', 'checkPhoneCode', 'checkGuestId', 'sendGuestIdForReview'];
  if ((req.method === 'GET' && (req.query || {}).mode === 'verification') || (req.method === 'POST' && req.body && GV_MODES.includes(req.body.mode))) {
    if ((req.query || {}).actingHost !== undefined) return res.status(403).json({ error: 'Open this from your own account.' });
    const GV = require('./_guest-verify');
    try {
      if (req.method === 'GET') return res.status(200).json(await GV.statusFor(sql, razorpayClient(), guestId));
      const b = req.body, ip = getClientIp(req);
      let out;
      if (b.mode === 'sendPhoneCode') out = await GV.sendPhoneCode(sql, { guestId, ip });
      else if (b.mode === 'checkPhoneCode') out = await GV.confirmPhoneCode(sql, razorpayClient(), { guestId, code: b.code, ip });
      else if (b.mode === 'checkGuestId') out = await GV.checkGuestId(sql, razorpayClient(), { guestId, files: b.files });
      else out = await GV.sendForReview(sql, { guestId, url: b.url });
      return res.status(200).json(Object.assign(out, { status: await GV.statusFor(sql, razorpayClient(), guestId) }));
    } catch (err) {
      if (err.isUserFacing) {
        return res.status(err.status || 400).json({ error: err.message, needs: err.needs || undefined, canSendForReview: err.canSendForReview || undefined,
          undecided: err.undecided || undefined, refusal: err.refusal || undefined, withAerva: err.withAerva || undefined, attemptsLeft: err.attemptsLeft });
      }
      console.error('guest verification failed:', err);
      return res.status(500).json({ error: 'Could not do this right now. Please try again.' });
    }
  }

  // ---- Privacy (Account Settings) ----
  // GET ?mode=privacy → { options, settings, isHost }; POST { mode: 'savePrivacy', settings: { id: bool } }.
  // See _profiles.js PRIVACY_OPTIONS for what each one hides, and where.
  if (req.method === 'GET' && (req.query || {}).mode === 'privacy') {
    const me = (await sql`SELECT host_id FROM guests WHERE id = ${guestId}`)[0] || {};
    return res.status(200).json({ options: PRIVACY_OPTIONS, settings: await readPrivacy(sql, guestId), isHost: !!me.host_id });
  }
  if (req.method === 'POST' && req.body && req.body.mode === 'savePrivacy') {
    const stored = sanitizePrivacy(req.body.settings);
    try {
      await sql`UPDATE guests SET privacy_settings = ${JSON.stringify(stored)}::jsonb WHERE id = ${guestId}`;
    } catch (err) {
      console.error('savePrivacy failed:', err);
      return res.status(503).json({ error: 'Privacy settings are not available yet. Please try again later.' });
    }
    await logAudit(sql, { action: 'privacy_settings_changed', success: true, actorType: 'guest', actorIdentifier: String(guestId),
      targetType: 'guest', targetId: guestId, metadata: { off: Object.keys(stored) } });
    return res.status(200).json({ success: true, settings: await readPrivacy(sql, guestId) });
  }

  // ---- Log out of all devices ----
  // POST { mode: 'logoutAllDevices' } — every session this account has
  // ends, this one included; the page then clears its own copy.
  if (req.method === 'POST' && req.body && req.body.mode === 'logoutAllDevices') {
    const v = await bumpSessionVersion(sql, guestId);
    if (v == null) return res.status(503).json({ error: 'This is not available yet. Please try again later.' });
    await logAudit(sql, { action: 'guest_logout_all_devices', success: true, actorType: 'guest', actorIdentifier: String(guestId),
      targetType: 'guest', targetId: guestId });
    return res.status(200).json({ success: true, loggedOut: true });
  }

  // ---- Delete my account (guest or host) ----
  // GET ?mode=deletionCheck → what still stops it; POST { mode: 'deleteAccount', confirm: 'DELETE' }.
  // See _accounts.js: refused while anything is open; otherwise personal
  // data is erased and the account can never be used again.
  if (req.method === 'GET' && (req.query || {}).mode === 'deletionCheck') {
    try { return res.status(200).json({ blockers: await deletionBlockers(sql, guestId) }); }
    catch (err) { return res.status(500).json({ error: 'Could not check this right now.' }); }
  }
  if (req.method === 'POST' && req.body && req.body.mode === 'deleteAccount') {
    if (req.body.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm.' });
    try {
      const r = await deleteAccount(sql, guestId);
      if (!r.ok) return res.status(409).json({ error: 'Your account cannot be deleted yet.', blockers: r.blockers });
      await logAudit(sql, { action: 'account_deleted', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId });
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('deleteAccount failed:', err);
      return res.status(500).json({ error: 'Could not delete your account right now. Please try again.' });
    }
  }

  // ---- Pause my account (guest or host) ----
  // POST { mode: 'deactivateAccount' }
  // Nothing is erased. The account takes no bookings, and a host's live
  // listings are hidden, exactly as "deactivate hosting" does. Logging in
  // again brings all of it back on its own (guest-auth.js), which is why
  // this is offered beside deleting rather than instead of it.
  // Bookings already paid for go ahead: a paused account does not cancel
  // a stay someone is counting on.
  if (req.method === 'POST' && req.body && req.body.mode === 'deactivateAccount') {
    try {
      const me = (await sql`SELECT host_id FROM guests WHERE id = ${guestId}`)[0] || {};
      let hidden = [];
      if (me.host_id) {
        hidden = await sql`UPDATE listings SET status = 'deactivated', deactivated_by = 'hosting', deactivated_at = now()
                           WHERE host_id = ${me.host_id} AND status = 'approved' RETURNING id`;
        try { await sql`UPDATE hosts SET hosting_status = 'deactivated' WHERE id = ${me.host_id}`; } catch (e) { /* column not added yet */ }
      }
      await sql`UPDATE guests SET account_status = 'deactivated', deactivated_at = now() WHERE id = ${guestId}`;
      // Every device is signed out by the pause itself; the next log in
      // (which checks the password, Google or a code) un-pauses.
      await bumpSessionVersion(sql, guestId);
      await logAudit(sql, { action: 'account_deactivated', success: true, actorType: 'guest', actorIdentifier: String(guestId),
        targetType: 'guest', targetId: guestId, metadata: { listingsHidden: hidden.length } });
      return res.status(200).json({ success: true, listingsHidden: hidden.length });
    } catch (err) {
      console.error('deactivateAccount failed:', err);
      return res.status(500).json({ error: 'Could not pause your account right now. Please try again.' });
    }
  }

  // This account's OWN host_id (if it has a linked hosts row) — needed
  // anywhere this file checks "is this account the host of X." Listings,
  // conversations, and orders all store host_id as a `hosts.id` value —
  // a completely separate id space from `guests.id` (guestId above).
  // Two spots below used to compare a hosts.id directly against guestId,
  // which only ever "worked" by numeric coincidence (they're different
  // sequences) — in practice a real host was almost never recognized as
  // the host of their own conversation. Resolved once here so every
  // mode below shares the same correct lookup rather than repeating
  // (and risking re-breaking) the same comparison.
  let myHostId = null;
  try {
    const hostRows = await sql`SELECT host_id FROM guests WHERE id = ${guestId}`;
    myHostId = hostRows[0] ? hostRows[0].host_id : null;
  } catch (err) {
    console.error('Failed to resolve host_id for account', guestId, err);
  }

  // ---- A co-host answering messages / editing templates for a host ----
  // ?actingHost=<hostId>. Only these modes are open to a co-host, each
  // behind its permission; the co-host then acts as the HOST side of the
  // host's conversations — never as the host's own guest-side trips —
  // and only on the listings they were given.
  let actingCtx = null; // set when a co-host works for a host (below)
  if (req.query && req.query.actingHost !== undefined) {
    const ctx = await resolveActingHost(sql, guestId, req.query.actingHost);
    // cohostEnded tells the page to leave co-host mode by itself (aerva-cohost.js).
    if (!ctx) return res.status(403).json({ error: 'You are not a co-host for this host, or your access has ended.', cohostEnded: true });
    const missingDetails = await cohostDetailsMissing(sql, guestId, ctx.hostId);
    if (missingDetails.length) return res.status(403).json({ error: DETAILS_REQUIRED_MESSAGE, detailsRequired: true, missing: missingDetails });
    const mode = req.method === 'GET' ? req.query.mode : (req.body || {}).mode;
    const MESSAGE_MODES = ['myConversations', 'conversationMessages', 'hostConversationMessages', 'unreadMessageCount', 'send', 'unsend', 'react', 'translate', 'conversationTemplates'];
    const TEMPLATE_MODES = ['templates', 'saveTemplate', 'deleteTemplate', 'myListingsGuidance', 'saveListingGuidance'];
    const isMessage = MESSAGE_MODES.includes(mode);
    const isTemplate = TEMPLATE_MODES.includes(mode);
    if (!isMessage && !isTemplate) return res.status(403).json({ error: 'Your co-host access does not include this.' });
    if (isMessage && !cohostCan(ctx, 'messages') && !(mode === 'conversationTemplates' && cohostCan(ctx, 'templates'))) {
      return res.status(403).json({ error: 'Your co-host access does not include messages.' });
    }
    if (isTemplate && !cohostCan(ctx, 'templates')) {
      return res.status(403).json({ error: 'Your co-host access does not include message templates.' });
    }
    // A specific conversation must be on one of their listings.
    const convId = Number(req.method === 'GET' ? req.query.conversationId : (req.body || {}).conversationId);
    if (convId) {
      const cr = await sql`SELECT listing_id, host_id FROM conversations WHERE id = ${convId}`;
      if (!cr[0] || Number(cr[0].host_id) !== ctx.hostId || !cohostHasListing(ctx, cr[0].listing_id)) {
        return res.status(403).json({ error: 'That conversation is not on a listing you co-host.' });
      }
    }
    const bodyListing = Number((req.body || {}).listingId);
    if (req.method === 'POST' && bodyListing && !cohostHasListing(ctx, bodyListing)) {
      return res.status(403).json({ error: 'That listing is not one you co-host.' });
    }
    // Messages: the host side only (guestId matches no guest-side row).
    // Templates: stored against the host's own account id.
    myHostId = ctx.hostId;
    guestId = isTemplate ? ctx.ownerGuestId : -1;
    actingCtx = ctx;
    // Templates: a co-host works only on templates scoped to their own
    // listings (see cohostOwnsTemplate) — never the host's account-wide
    // ones, which reach every listing the host has.
    if ((mode === 'saveTemplate' && (req.body || {}).templateId) || mode === 'deleteTemplate') {
      const t = (await sql`SELECT listing_id, auto_send_listing_ids FROM message_templates
                           WHERE id = ${Number((req.body || {}).templateId) || 0} AND host_id = ${ctx.ownerGuestId}`)[0];
      if (!t) return res.status(404).json({ error: 'Template not found.' });
      if (!cohostOwnsTemplate(ctx, t)) return res.status(403).json({ error: 'That template covers listings you do not co-host.' });
    }
    if (mode === 'myConversations') {
      const originalJson = res.json.bind(res);
      res.json = (body) => originalJson(body && Array.isArray(body.conversations)
        ? { ...body, conversations: body.conversations.filter(c => cohostHasListing(ctx, c.listing_id)) }
        : body);
    }
  }

  // ---- Fetch the full profile bundle, or a chat-related GET mode ----
  if (req.method === 'GET') {
    const mode = req.query.mode;
    try {
      // ---- What this account still needs to book ----
      // GET ?mode=bookingRequirements — a confirmed email and a phone number
      // are what it takes to START a checkout (_guest-id.js). What it takes
      // for the booking to be CONFIRMED — name, phone code, photo ID — is
      // GET ?mode=verification (_guest-verify.js).
      if (mode === 'bookingRequirements') {
        return res.status(200).json(await idSummary(sql, guestId));
      }

      // ---- Resolution Center: the person's own requests (_support.js) ----
      // GET ?mode=supportOptions          — bookings and listings a request can be about
      // GET ?mode=supportRequests         — every request they raised
      // GET ?mode=supportRequest&ref=SR-… — one request and its conversation
      if (mode === 'supportOptions' || mode === 'supportRequests' || mode === 'supportRequest') {
        if (actingCtx) return res.status(403).json({ error: 'Requests are raised from your own account.' });
        try {
          if (mode === 'supportOptions') return res.status(200).json(await support.requestOptions(sql, guestId));
          if (mode === 'supportRequests') return res.status(200).json({ requests: await support.listRequests(sql, guestId) });
          return res.status(200).json({ request: await support.getRequest(sql, guestId, req.query.ref) });
        } catch (err) {
          if (!err.isUserFacing) console.error(mode + ' failed:', err);
          return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not load this right now. Please try again.' });
        }
      }

      // GET ?mode=myHiddenListings — listings Aerva keeps away from this account (the site hides them)
      if (mode === 'myHiddenListings') {
        return res.status(200).json({ ids: await require('./_support-actions').blockedListingIds(sql, guestId) });
      }

      // ---- Aerva Support chat in Messages (_support-chat.js) ----
      // GET ?mode=supportChat        — the whole conversation and where it stands
      // GET ?mode=supportChatSummary — preview + unseen replies, for the conversation list
      if (mode === 'supportChat' || mode === 'supportChatSummary') {
        if (actingCtx) return res.status(403).json({ error: 'Aerva Support is reached from your own account.' });
        try {
          if (mode === 'supportChatSummary') return res.status(200).json(await supportChat.summary(sql, guestId));
          return res.status(200).json(await supportChat.getThread(sql, guestId));
        } catch (err) {
          if (!err.isUserFacing) console.error(mode + ' failed:', err);
          return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not load Aerva Support right now.' });
        }
      }

      // ---- Changing a booking: what can change, and the current booking ----
      // GET ?mode=changeOptions&orderId=
      // GET ?mode=setupSteps → the guest's own steps to finish their account (_setup-steps.js).
      if (mode === 'setupSteps') {
        try { const items = await require('./_setup-steps').guestSteps(sql, guestId); return res.status(200).json({ items, done: items.every(i => i.done || i.optional) }); }
        catch (err) { return res.status(500).json({ error: 'Could not load this right now.' }); }
      }
      // GET ?mode=transferTargets&orderId=&from=&to= → the host's other properties free for those nights
      if (mode === 'transferTargets') {
        try { return res.status(200).json(await require('./_booking-transfers').transferTargets(sql, Number(req.query.orderId) || 0, guestId, { moveFrom: req.query.from, moveTo: req.query.to })); }
        catch (err) {
          if (!err.isUserFacing) console.error('transferTargets failed:', err);
          return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not look for other properties right now.' });
        }
      }
      // ---- Gifts and group bookings (_gifts.js, _group-bookings.js) ----
      // GET ?mode=gift&token=… | &giftId=…  → the gift, whether this account may accept it, prefill
      // GET ?mode=group&token=…              → the group's live status for this account
      if (mode === 'gift' || mode === 'group') {
        if (actingCtx) return res.status(403).json({ error: 'Open this from your own account.' });
        try {
          if (mode === 'gift') return res.status(200).json(await require('./_gifts').viewForAccount(sql, { guestId, token: req.query.token || null, giftId: req.query.giftId || null }));
          return res.status(200).json(await require('./_group-bookings').status(sql, razorpayClient(), String(req.query.token || ''), guestId));
        } catch (err) {
          if (!err.isUserFacing) console.error(mode + ' failed:', err);
          return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not load this right now. Please try again.' });
        }
      }
      if (mode === 'changeOptions') {
        try { return res.status(200).json(await changeOptions(sql, Number(req.query.orderId) || 0, guestId)); }
        catch (err) { return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not load this right now.' }); }
      }

      // ---- What cancelling would refund, under the booking's policy ----
      // GET ?mode=cancellationQuote&orderId= — changes nothing.
      if (mode === 'cancellationQuote') {
        const q = await cancellationQuote(sql, Number(req.query.orderId) || 0, guestId);
        if (q.status) return res.status(q.status).json({ error: q.error });
        return res.status(200).json(q);
      }
      if (mode === 'conversation') {
        const orderId = Number(req.query.orderId);
        if (!orderId) return res.status(400).json({ error: 'Missing order.' });

        const orderRows = await sql`
          SELECT o.id, o.listing_id, o.guest_id, o.guest_email, o.status, o.arrival, o.departure, o.guests, o.nights, o.total,
                 to_jsonb(o)->>'confirmation_code' AS confirmation_code,
                 l.host_id, l.property_name
          FROM orders o
          JOIN listings l ON l.id = o.listing_id
          WHERE o.id = ${orderId}
        `;
        const order = orderRows[0];
        if (!order) return res.status(404).json({ error: 'Booking not found.' });
        // A conversation OPENS only on a confirmed booking. Once it exists
        // its history is kept for good — through checkout, and through a
        // cancellation — so either side can always read back what was
        // agreed. Nothing ever deletes messages.
        if (order.status !== 'paid' && order.status !== 'cancelled') {
          return res.status(403).json({ error: 'A conversation only opens once a booking is confirmed.' });
        }
        // A gift's accepted recipient and a group booking's payers use the
        // booking's Messages too (_gifts.js sharedRole) — never its money.
        const shared = order.guest_id === guestId ? null : await require('./_gifts').sharedRole(sql, guestId, orderId);
        const isGuest = order.guest_id === guestId || !!shared;
        let isHost = myHostId != null && order.host_id === myHostId;
        // A co-host opening the thread from Today (no ?actingHost: the page
        // cannot tell their own trips from the host's bookings there) answers
        // as the host would — only with messages access, on a listing they
        // co-host. Their own trips are matched as the guest above, first.
        if (!isGuest && !isHost && !actingCtx && guestId > 0) {
          const ctx = await resolveActingHost(sql, guestId, order.host_id);
          if (ctx && cohostCan(ctx, 'messages') && cohostHasListing(ctx, order.listing_id)) {
            if ((await cohostDetailsMissing(sql, guestId, ctx.hostId)).length) return res.status(403).json({ error: DETAILS_REQUIRED_MESSAGE, detailsRequired: true });
            isHost = true;
          }
        }
        if (!isGuest && !isHost) return res.status(403).json({ error: 'Not your booking.' });

        let convRows = await sql`SELECT id FROM conversations WHERE order_id = ${orderId}`;
        let conversationId;
        // A guest who asked about this listing before booking: the
        // booking joins that thread (_inquiries.js).
        if (!convRows.length && order.status === 'paid') {
          const adopted = await adoptInquiryThread(sql, { orderId, listingId: order.listing_id, guestId: order.guest_id });
          if (adopted) convRows = [{ id: adopted }];
        }
        if (convRows.length) {
          conversationId = convRows[0].id;
        } else if (order.status !== 'paid') {
          // Cancelled with no messages ever sent: nothing to keep, and no
          // reason to start a new thread now.
          return res.status(404).json({ error: 'There are no messages for this booking.' });
        } else {
          const inserted = await sql`
            INSERT INTO conversations (order_id, listing_id, guest_id, guest_email, host_id)
            VALUES (${orderId}, ${order.listing_id}, ${order.guest_id}, ${order.guest_email}, ${order.host_id})
            RETURNING id
          `;
          conversationId = inserted[0].id;
        }

        const messages = (await sql`
          SELECT id, sender_type, display_text, was_redacted, created_at, to_jsonb(messages)->>'unsent_at' AS unsent_at,
                 to_jsonb(messages)->>'guest_reaction' AS guest_reaction, to_jsonb(messages)->>'host_reaction' AS host_reaction,
                 to_jsonb(messages)->'photo_urls' AS photos
          FROM messages WHERE conversation_id = ${conversationId} ORDER BY created_at ASC
        `).map(unsentView);
        // This endpoint is only ever called from the guest-facing chat
        // widget in index.html (openChatForOrder/sendChatMessage) — so
        // when an account happens to be BOTH the guest on this booking
        // AND a host elsewhere (e.g. testing by booking your own
        // listing), the perspective here should still be "guest," since
        // that's which surface is actually being used. Checking isGuest
        // first (not isHost) is what makes that true — the previous
        // isHost-first priority meant such an account's own messages,
        // and the host's replies, all rendered identically as "mine,"
        // making it look like nothing was ever received.
        const viewerRole = isGuest ? 'guest' : 'host';
        if (shared) {
          // No price for a recipient or a friend: amounts in Aerva's notices are hidden,
          // and the booking's cards (cancel, change, dispute) are the organiser's or buyer's.
          return res.status(200).json({ photosAllowed: await require('./_message-guard').photosAllowed(sql, conversationId), messagingClosed: await require('./_message-guard').messagingClosed(sql, conversationId), conversationId, listingName: order.property_name, viewerRole, shared,
            messages: messages.map(m => Object.assign({}, m, { display_text: hideMoneyForShared(m.display_text, m.sender_type) })),
            booking: { orderId: order.id, confirmationCode: order.confirmation_code || null, arrival: order.arrival, departure: order.departure, guests: order.guests, nights: order.nights, status: order.status },
            reviewPrompt: null, cancellation: null, change: null, dispute: null });
        }
        return res.status(200).json({ photosAllowed: await require('./_message-guard').photosAllowed(sql, conversationId), messagingClosed: await require('./_message-guard').messagingClosed(sql, conversationId), conversationId, listingName: order.property_name, viewerRole, messages,
          booking: { orderId: order.id, confirmationCode: order.confirmation_code || null,
                     arrival: order.arrival, departure: order.departure, guests: order.guests, nights: order.nights,
                     total: order.total, status: order.status },
          reviewPrompt: await threadReviewPrompt(sql, conversationId, viewerRole),
          cancellation: await cancellationCard(sql, conversationId, viewerRole),
          change: await changeCard(sql, conversationId, viewerRole),
          dispute: await disputeCard(sql, conversationId, viewerRole) });
      }

      // Every conversation this account is part of — as host on some,
      // as guest on others, both shown the same way. Same bug as above
      // (c.host_id is a hosts.id, guestId is a guests.id) meant this used
      // to only ever match by numeric coincidence — in practice the
      // "Messages" inbox showed nothing for almost every real account,
      // even ones with genuine conversations, regardless of role.
      // my_role/counterpart_* let the frontend render one unified list
      // instead of two separate host-only and guest-only surfaces.
      if (mode === 'myConversations') {
        const conversations = await sql`
          SELECT c.id, c.listing_id, c.order_id, c.guest_email, c.guest_id, c.host_id,
                 l.property_name, l.cover_photo_url, l.latitude, l.longitude, h.name AS host_display_name,
                 l.check_in_time, l.check_out_time, l.wifi_name, l.wifi_password, l.access_code, l.guest_guidance,
                 l.checkin_photos,
                 COALESCE(l.formatted_address, NULLIF(TRIM(CONCAT_WS(', ', l.area, l.city)), '')) AS location_text,
                 NULLIF(TRIM(CONCAT_WS(', ', l.area, l.city)), '') AS area_text,
                 -- Aggregated into one JSON array per conversation so the
                 -- @checkininfo placeholder (see resolveTemplatePlaceholders
                 -- in index.html / resolveTemplateText in
                 -- _template-scheduling.js) can assemble the fixed fields
                 -- above PLUS every host-defined custom field into one
                 -- readable block — same assembly manage-listing.html's
                 -- own live preview builds, kept in sync by hand.
                 (SELECT COALESCE(json_agg(json_build_object('label', field_label, 'value', field_value) ORDER BY sort_order), '[]'::json)
                    FROM listing_custom_fields WHERE listing_id = l.id) AS custom_fields,
                 CASE WHEN c.host_id = ${myHostId} THEN 'host' ELSE 'guest' END AS my_role,
                 CASE WHEN c.host_id = ${myHostId} THEN COALESCE(NULLIF(btrim(g.name), ''), 'Guest') ELSE h.name END AS counterpart_name,
                 CASE WHEN c.host_id = ${myHostId} THEN g.profile_photo_url ELSE NULL END AS counterpart_photo_url,
                 -- Role-INDEPENDENT — always the actual booking guest's
                 -- name, regardless of who's viewing. Used for the
                 -- @guestname template placeholder: "the one who is
                 -- receiving the message should be the booker name,"
                 -- not whichever side happens to be looking at this row.
                 COALESCE(NULLIF(btrim(g.name), ''), 'Guest') AS guest_display_name,
                 o.arrival, o.departure, o.status AS booking_status, to_jsonb(o)->>'confirmation_code' AS confirmation_code,
                 o.nights, o.guests, o.subtotal, o.gst, GREATEST(0, o.total - COALESCE((to_jsonb(o)->>'coupon_discount')::numeric, 0)) AS guest_total,
                 -- the host's own part: after their co-hosts' shares, as in My Earnings
                 GREATEST(0, o.payout_amount - COALESCE((SELECT SUM(s.amount) FROM order_cohost_shares s WHERE s.order_id = o.id), 0)) AS payout_amount,
                 COALESCE((to_jsonb(o)->>'free_cancel_fee')::int, 0) AS free_cancel_fee, COALESCE((to_jsonb(o)->>'free_cancel_gst')::int, 0) AS free_cancel_gst,
                 (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), ${DEFAULT_TIMEZONE}))::date AS local_today,
                 COALESCE(NULLIF(btrim(l.timezone), ''), ${DEFAULT_TIMEZONE}) AS listing_tz, to_jsonb(l)->>'check_in_time' AS listing_check_in_time,
                 (SELECT CASE WHEN to_jsonb(m)->>'unsent_at' IS NOT NULL THEN 'Message unsent' ELSE display_text END
                    FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
                 (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
                 (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id
                    AND m.sender_type <> (CASE WHEN c.host_id = ${myHostId} THEN 'host' ELSE 'guest' END)
                    AND m.read_at IS NULL AND to_jsonb(m)->>'unsent_at' IS NULL) AS unread_count
          FROM conversations c
          JOIN listings l ON l.id = c.listing_id
          LEFT JOIN guests g ON g.id = c.guest_id
          LEFT JOIN hosts h ON h.id = c.host_id
          LEFT JOIN orders o ON o.id = c.order_id
          WHERE c.guest_id = ${guestId} OR c.host_id = ${myHostId} OR c.order_id = ANY(${await require('./_gifts').sharedOrderIds(sql, guestId)}::int[])
          ORDER BY last_message_at DESC NULLS LAST
        `;
        // A gift: the host sees the guest staying, marked as a gift (_gifts.js).
        try {
          const labels = await require('./_gifts').hostLabels(sql, conversations.filter(c => c.my_role === 'host' && c.order_id).map(c => c.order_id));
          conversations.forEach(c => { const l = c.my_role === 'host' && labels.get(Number(c.order_id)); if (l) { c.counterpart_name = l.label; c.guest_display_name = l.name; c.gift = { accepted: l.accepted, note: l.note }; } });
        } catch (e) { /* before the database update */ }
        const sharedIds = new Set(await require('./_gifts').sharedOrderIds(sql, guestId));
        // Dates normalized here (see toDateStr's comment) so the
        // frontend's status-tag logic (Enquiry / Check-in Today / etc.)
        // does plain string/date-object comparisons against a real date,
        // never a mangled concatenation.
        // Enquiry threads (no booking yet): the dates and party asked about.
        const inquiries = await inquiryDetails(sql, conversations.filter(c => !c.order_id).map(c => c.id));
        conversations.forEach(c => {
          if (!c.order_id && inquiries[c.id]) {
            c.inquiry = { arrival: toDateStr(inquiries[c.id].arrival), departure: toDateStr(inquiries[c.id].departure), guests: inquiries[c.id].guests, askedAt: inquiries[c.id].askedAt };
          }
          c.arrival = toDateStr(c.arrival);
          c.departure = toDateStr(c.departure);
          const localToday = toDateStr(c.local_today);
          delete c.local_today;
          // "Cancel this booking" on the host's side (owner, 10 Nov 2026):
          // 'open' until check-in time (the host can cancel — the same rule
          // host-listings cancelBooking enforces); then 'support' (only
          // Aerva can) until 10 AM on the check-out date; after that the
          // section is gone ('closed').
          {
            const R = require('./_booking-rules');
            let state = 'closed';
            if (c.booking_status === 'paid' && c.arrival && c.departure) {
              const endMs = R.localMidnightMs(c.departure, c.listing_tz) + R.STAY_WINDOW_HOUR * 3600e3;
              if (R.hoursUntilCheckInTime(c.arrival, c.listing_tz, c.listing_check_in_time) > 0) state = 'open';
              else if (Date.now() < endMs) state = 'support';
            }
            c.host_cancel_state = state;
            delete c.listing_tz; delete c.listing_check_in_time;
          }
          // The host's payout is the host's business: never to a guest, and
          // never to a co-host (payouts are the host's alone).
          if (c.my_role !== 'host' || actingCtx) delete c.payout_amount;
          // What the guest paid in all (service fee and deposit included): the guest's own view only.
          if (c.my_role === 'host' || c.guest_id !== guestId) delete c.guest_total;
          // A guest's email address is never shown to the host (owner, 11 Nov 2026).
          if (c.my_role === 'host') c.guest_email = null;
          // A gift's recipient or a group's friend: never the price.
          if (c.my_role !== 'host' && sharedIds.has(Number(c.order_id)) && c.guest_id !== guestId) { delete c.subtotal; delete c.gst; c.shared = true; c.guest_email = null; if (c.last_message) c.last_message = hideMoneyForShared(c.last_message, 'system'); }
          // Nor what the guest paid for the stay: the host's payout is that
          // less commission, so it is the host's earnings by another name.
          if (actingCtx) { delete c.subtotal; delete c.gst; }
          // Check-in secrets (WiFi, door code, check-in steps and photos,
          // the exact address and map position) are used by the HOST side
          // to fill templates. A guest gets them only while their paid
          // booking is still running, by the property's calendar — never
          // after check-out or a cancellation. A co-host reaches this list
          // only through their messages access and only for their own
          // listings (filtered above), which they manage anyway.
          const guestMayHave = c.booking_status === 'paid' && !!c.departure && !!localToday && c.departure >= localToday;
          if (c.my_role !== 'host' && !guestMayHave) {
            c.wifi_name = null; c.wifi_password = null; c.access_code = null;
            c.checkin_photos = []; c.custom_fields = []; c.guest_guidance = null;
            c.latitude = null; c.longitude = null;
            c.location_text = c.area_text || null;
          }
          delete c.area_text;
        });
        return res.status(200).json({ conversations });
      }

      // Lightweight — just a single number, meant to be called from the
      // main site's header on every page load for any logged-in account,
      // so it deliberately avoids the fuller myConversations query (which
      // pulls every conversation's last message) purely to check whether
      // the little badge on the Messages icon should show at all. Counts
      // unread messages from the OTHER party in either direction — as
      // host waiting on a guest reply, or as guest waiting on a host reply.
      // Which listings this account has liked — so hearts render filled.
      // The homes this account has hearted (guest_favorites), for every device.
      if (mode === 'myFavorites') {
        try {
          const rows = await sql`SELECT listing_id FROM guest_favorites WHERE guest_id = ${guestId} ORDER BY created_at`;
          return res.status(200).json({ listingIds: rows.map(r => r.listing_id), synced: true });
        } catch (err) {
          // Before migration_favourites_reactions.sql: the page keeps them on the device.
          return res.status(200).json({ listingIds: [], synced: false });
        }
      }

      if (mode === 'myLikes') {
        try {
          const rows = await sql`SELECT listing_id FROM listing_likes WHERE guest_id = ${guestId}`;
          return res.status(200).json({ listingIds: rows.map(r => r.listing_id) });
        } catch (err) {
          console.error('myLikes failed (table missing before migration?):', err.message);
          return res.status(200).json({ listingIds: [] });
        }
      }

      if (mode === 'unreadMessageCount') {
        // A co-host counts only the listings they were given.
        const coListings = actingCtx ? [...actingCtx.listingIds] : null;
        const rows = await sql`
          SELECT COUNT(*) AS count
          FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE to_jsonb(m)->>'unsent_at' IS NULL AND (
                (c.host_id = ${myHostId} AND m.sender_type = 'guest' AND m.read_at IS NULL
                 AND (${coListings}::int[] IS NULL OR c.listing_id = ANY(${coListings}::int[])))
             OR (c.guest_id = ${guestId} AND m.sender_type = 'host' AND m.read_at IS NULL))
        `;
        return res.status(200).json({ count: Number(rows[0]?.count || 0) });
      }

      // Reads a conversation's messages — either side can open this now
      // (not host-only), since a normal messaging system doesn't gate
      // "seeing your own conversation" by role.
      if (mode === 'conversationMessages' || mode === 'hostConversationMessages') {
        const conversationId = Number(req.query.conversationId);
        if (!conversationId) return res.status(400).json({ error: 'Missing conversation.' });
        const convRows = await sql`SELECT id, guest_id, host_id, order_id FROM conversations WHERE id = ${conversationId}`;
        const conv = convRows[0];
        if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
        const sharedView = conv.guest_id !== guestId && conv.order_id ? await require('./_gifts').sharedRole(sql, guestId, conv.order_id) : null;
        const isGuest = conv.guest_id === guestId || !!sharedView;
        const isHost = myHostId != null && conv.host_id === myHostId;
        if (!isGuest && !isHost) return res.status(403).json({ error: 'Not your conversation.' });

        const messages = (await sql`
          SELECT id, sender_type, display_text, was_redacted, created_at, to_jsonb(messages)->>'unsent_at' AS unsent_at,
                 to_jsonb(messages)->>'guest_reaction' AS guest_reaction, to_jsonb(messages)->>'host_reaction' AS host_reaction,
                 to_jsonb(messages)->'photo_urls' AS photos
          FROM messages WHERE conversation_id = ${conversationId} ORDER BY created_at ASC
        `).map(unsentView);
        // Opening a conversation marks the OTHER party's messages read.
        // If this account is BOTH the guest and the host here (a
        // self-booking — booking your own listing to test, for example),
        // there IS no other real participant, so mark everything read.
        // The one-sided version of this ("just mark whichever role I'm
        // NOT" — isHost ? 'guest' : 'host') always resolved to marking
        // only 'guest' messages in that case, since isHost is checked
        // first — any 'host'-sent message in a self-booked conversation
        // could then never be marked read at all, and kept counting
        // toward the unread badge forever, even though the conversation
        // list itself showed nothing unread (it has this same one-sided
        // assumption baked into its own per-row count).
        if (isGuest && isHost) {
          await sql`UPDATE messages SET read_at = NOW() WHERE conversation_id = ${conversationId} AND read_at IS NULL`;
        } else {
          const otherSenderType = isHost ? 'guest' : 'host';
          await sql`
            UPDATE messages SET read_at = NOW()
            WHERE conversation_id = ${conversationId} AND sender_type = ${otherSenderType} AND read_at IS NULL
          `;
        }
        const myRole = isHost ? 'host' : 'guest';
        // A gift's recipient or a group's friend (the inbox opens threads here): as in
        // mode 'conversation' — no amounts, and the booking's cards (cancel, change,
        // dispute, review) stay with the organiser or buyer.
        if (sharedView && !isHost) {
          return res.status(200).json({ photosAllowed: await require('./_message-guard').photosAllowed(sql, conversationId), messagingClosed: await require('./_message-guard').messagingClosed(sql, conversationId), myRole, shared: sharedView,
            messages: messages.map(m => Object.assign({}, m, { display_text: hideMoneyForShared(m.display_text, m.sender_type) })),
            reviewPrompt: null, cancellation: null, change: null, dispute: null });
        }
        return res.status(200).json({ photosAllowed: await require('./_message-guard').photosAllowed(sql, conversationId), messagingClosed: await require('./_message-guard').messagingClosed(sql, conversationId), messages, myRole, reviewPrompt: await threadReviewPrompt(sql, conversationId, myRole),
                                      cancellation: await cancellationCard(sql, conversationId, myRole),
                                      change: await changeCard(sql, conversationId, myRole),
                                      dispute: await disputeCard(sql, conversationId, myRole) });
      }

      if (mode === 'templates') {
        let templates = await sql`
          SELECT * FROM message_templates
          WHERE host_id = ${guestId} ORDER BY sort_order ASC, created_at ASC
        `;
        if (actingCtx) templates = templates.filter(t => cohostOwnsTemplate(actingCtx, t));
        return res.status(200).json({ templates: templates.map(t => ({
          id: t.id, listing_id: t.listing_id, title: t.title || '', body: t.body, sort_order: t.sort_order,
          send_trigger: t.send_trigger || (t.send_on_booking_confirmed ? 'booking_confirmed' : 'manual'),
          send_offset_days: Number(t.send_offset_days) || 0,
          send_offset_unit: t.send_offset_unit || (Number(t.send_offset_days) > 0 ? 'days' : null),
          send_offset_value: t.send_offset_minutes ? (t.send_offset_unit === 'minutes' ? Number(t.send_offset_minutes) : t.send_offset_unit === 'hours' ? Math.round(t.send_offset_minutes / 60) : Math.round(t.send_offset_minutes / 1440)) : (Number(t.send_offset_days) || 0),
          send_at_time: t.send_at_time || null,
          send_on_booking_confirmed: !!t.send_on_booking_confirmed,
          auto_send_listing_ids: t.auto_send_listing_ids || []
        })) });
      }

      // For the "Description" tab in the template manager — free-text
      // per-property guidance (house rules, parking, local tips, etc.),
      // distinct from both the structured check-in fields and the
      // clickable quick-reply templates. Small dataset (a host's own
      // listing count), so fetched all at once rather than one at a time
      // per dropdown selection.
      if (mode === 'myListingsGuidance') {
        if (myHostId == null) return res.status(200).json({ listings: [] });
        let listings = await sql`
          SELECT id, property_name, guest_guidance FROM listings
          WHERE host_id = ${myHostId} AND listing_type = 'stay'
          ORDER BY property_name ASC
        `;
        if (actingCtx) listings = listings.filter(l => cohostHasListing(actingCtx, l.id));
        return res.status(200).json({ listings });
      }

      // Guest-facing quick-question picker inside the chat window itself
      // — the same templates a host wrote in their own template manager,
      // but fetched by conversationId (proving the requester is actually
      // part of that conversation) rather than by host ownership, since
      // the guest obviously isn't the host. Only templates for this
      // exact listing, plus the host's account-wide ones (listing_id IS
      // NULL), are returned — never another listing's.
      if (mode === 'conversationTemplates') {
        const conversationId = Number(req.query.conversationId);
        if (!conversationId) return res.status(400).json({ error: 'Missing conversation.' });
        const convRows = await sql`SELECT id, guest_id, host_id, listing_id FROM conversations WHERE id = ${conversationId}`;
        const conv = convRows[0];
        if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
        if (conv.guest_id !== guestId && (myHostId == null || conv.host_id !== myHostId)) return res.status(403).json({ error: 'Not your conversation.' });

        // message_templates.host_id stores the owning account's own
        // guests.id (see the 'templates'/'saveTemplate' modes below —
        // they write/read it that way directly) — a DIFFERENT convention
        // from conversations.host_id/listings.host_id, which store a
        // hosts.id. Querying message_templates with conv.host_id
        // directly (as this used to) compares the wrong id space and
        // silently returns zero rows every time. This resolves the
        // actual owning account first.
        const ownerRows = await sql`SELECT id FROM guests WHERE host_id = ${conv.host_id}`;
        const ownerGuestId = ownerRows[0] ? ownerRows[0].id : null;
        const rows = ownerGuestId == null ? [] : await sql`
          SELECT id, body, auto_send_listing_ids FROM message_templates
          WHERE host_id = ${ownerGuestId} AND (listing_id = ${conv.listing_id} OR listing_id IS NULL)
          ORDER BY sort_order ASC, created_at ASC
        `;
        // A template limited to certain listings is offered only in their
        // threads (an empty list still means every listing).
        const templates = rows.filter(t => { const ids = templateListingIds(t); return !ids.length || ids.includes(Number(conv.listing_id)); })
          .map(t => ({ id: t.id, body: t.body }));
        return res.status(200).json({ templates });
      }

      const guestRows = await sql`
        SELECT id, email, phone, name, profile_photo_url, preferred_currency, created_at
        FROM guests WHERE id = ${guestId}
      `;
      const guest = guestRows[0];
      if (!guest) return res.status(404).json({ error: 'Account not found.' });

      // Payment/booking history — every completed booking tied to this
      // account. subtotal/discount/gst/total double as the "payment info"
      // the profile shows; there's no separate payment-methods table since
      // Razorpay handles card/UPI details on their end, never ours.
      const bookings = await sql`
        SELECT o.id, o.suite_name, o.listing_id, o.arrival, o.departure, o.guests, o.nights,
               o.subtotal, o.discount_amount, o.gst, o.total, o.status, o.created_at,
               to_jsonb(o)->>'confirmation_code' AS confirmation_code,
               COALESCE(l.listing_type, 'stay') AS listing_type,
               -- For the booking summary page (My Bookings → a booking).
               -- Read through to_jsonb so a column a migration has not
               -- added yet comes back null instead of failing the query.
               o.guest_email, o.razorpay_order_id, o.razorpay_payment_id,
               to_jsonb(o)->>'guest_service_fee' AS guest_service_fee,
               to_jsonb(o)->>'deposit_amount' AS deposit_amount,
               to_jsonb(o)->>'deposit_status' AS deposit_status,
               to_jsonb(o)->>'coupon_discount' AS coupon_discount,
               to_jsonb(o)->>'charge_currency' AS charge_currency,
               to_jsonb(o)->>'cancelled_at' AS cancelled_at,
               to_jsonb(o)->>'cancellation_reason' AS cancellation_reason,
               to_jsonb(o)->>'cancellation_policy' AS cancellation_policy,
               to_jsonb(o)->>'guest_first_name' AS guest_first_name,
               to_jsonb(o)->>'guest_last_name' AS guest_last_name,
               to_jsonb(o)->'pet_types' AS pet_types,
               to_jsonb(o)->>'transfer_change_id' AS transfer_change_id,
               -- The free cancellation add-on (_pricing.js): 0 on older rows.
               COALESCE((to_jsonb(o)->>'free_cancel_fee')::int, 0) AS free_cancel_fee,
               COALESCE((to_jsonb(o)->>'free_cancel_gst')::int, 0) AS free_cancel_gst,
               COALESCE((to_jsonb(o)->>'free_cancel_refunded')::boolean, false) AS free_cancel_refunded,
               ((to_jsonb(o)->>'free_cancel_fixed')::int = 0) IS TRUE AS free_cancel_included,
               l.property_name AS listing_name, l.city AS listing_city, to_jsonb(l)->>'area' AS listing_area,
               l.formatted_address AS listing_address, l.host_name AS host_name,
               to_jsonb(l)->>'check_in_time' AS check_in_time, to_jsonb(l)->>'check_out_time' AS check_out_time,
               to_jsonb(l)->>'cancellation_policy' AS listing_cancellation_policy,
               to_jsonb(l)->>'experience_start_time' AS experience_start_time,
               to_jsonb(l)->>'experience_duration_hours' AS experience_duration_hours,
               to_jsonb(l)->>'experience_meeting_point_address' AS meeting_point_address,
               to_jsonb(l)->>'experience_meeting_point_details' AS meeting_point_details,
               EXISTS (SELECT 1 FROM listing_reviews r WHERE r.order_id = o.id) AS reviewed,
               COALESCE(NULLIF(btrim(l.timezone), ''), ${DEFAULT_TIMEZONE}) AS listing_timezone,
               (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), ${DEFAULT_TIMEZONE}))::date AS local_today
        FROM orders o
        LEFT JOIN listings l ON l.id = o.listing_id
        WHERE o.guest_id = ${guestId}
        ORDER BY o.created_at DESC
      `;
      // The open change on each booking (waiting for the host, or for payment).
      try {
        const ids = bookings.map(b => b.id);
        if (ids.length) {
          const chs = await sql`SELECT DISTINCT ON (order_id) order_id, id, status, summary, difference FROM booking_changes
                                WHERE order_id = ANY(${ids}) AND status IN ('pending', 'awaiting_payment') ORDER BY order_id, id DESC`;
          const byOrder = {}; chs.forEach(c => { byOrder[c.order_id] = { id: c.id, status: c.status, summary: c.summary, difference: c.difference }; });
          bookings.forEach(b => { b.open_change = byOrder[b.id] || null; });
        }
      } catch (err) { /* booking_changes not created yet */ }

      // A transferred part: Aerva's transfer fee is stored inside its
      // guest_service_fee (_booking-transfers.js); send it apart so the
      // booking summary shows the two charges the guest agreed to.
      try {
        const tids = [...new Set(bookings.filter(b => b.transfer_change_id).map(b => Number(b.transfer_change_id)))];
        if (tids.length) {
          const tq = await sql`SELECT id, quote FROM booking_changes WHERE id = ANY(${tids})`;
          const byId = {}; tq.forEach(r => { byId[r.id] = r.quote; });
          bookings.forEach(b => {
            const q = b.transfer_change_id && byId[Number(b.transfer_change_id)];
            const part = q && Array.isArray(q.parts) ? q.parts.find(p => Number(p.listingId) === Number(b.listing_id) && String(p.arrival) === toDateStr(b.arrival)) : null;
            if (part && Number(part.transferFee) > 0) b.transfer_fee = Number(part.transferFee);
          });
        }
      } catch (err) { /* booking_changes not created yet */ }

      // Latest cancellation request per booking (guest's "Request cancellation").
      try {
        const ids = bookings.map(b => b.id);
        if (ids.length) {
          const reqs = await sql`SELECT DISTINCT ON (order_id) * FROM cancellation_requests WHERE order_id = ANY(${ids}) ORDER BY order_id, id DESC`;
          const byOrder = {}; reqs.forEach(r => { byOrder[r.order_id] = r; });
          const C = require('./_cancellations');
          for (const b of bookings) {
            const r = byOrder[b.id];
            b.cancel_request_status = r ? r.status : null;
            b.cancel_request_id = r ? r.id : null;
            b.cancel_request_reason = r ? (C.REASON_LABELS[r.reason_code] || null) : null;
            b.cancel_request_disaster = !!(r && C.isDisaster(r));
            // An old review of a host's decline (asked before 10 Nov 2026): where it stands.
            if (r && r.status === 'declined') {
              if (r.review_requested_at && !r.review_decided_at) b.cancel_review_state = 'Aerva is reviewing your emergency request (its decision is final)';
              else if (r.review_outcome === 'upheld') b.cancel_review_state = 'Aerva reviewed your request: the host’s decline stands';
            }
          }
          // An emergency request Aerva is chasing: where it stands (_emergency-escalation.js).
          const notes = await require('./_emergency-escalation').guestStatus(sql, ids);
          bookings.forEach(b => { if (notes[b.id]) b.cancel_request_note = notes[b.id]; });
        }
      } catch (err) { /* migration_cancellation_requests.sql not run yet */ }

      // What the guest may still do on each booking (the stay window,
      // _booking-rules.js): before check-in, change or request a
      // cancellation; once the stay has started, only change it (or report
      // a problem) until 10 AM on the day after check-in — or take a change
      // the host declined to Aerva within a day.
      try {
        const R = require('./_booking-rules');
        let declined = new Set();
        const ids = bookings.filter(b => b.status === 'paid').map(b => b.id);
        if (ids.length) {
          try {
            declined = new Set((await sql`SELECT DISTINCT order_id FROM booking_changes WHERE order_id = ANY(${ids}) AND status IN ('declined', 'expired')
                                            AND decided_at IS NOT NULL AND decided_at > now() - interval '24 hours'`).map(r => r.order_id));
          } catch (e) { /* booking_changes not created yet */ }
        }
        bookings.forEach(b => {
          const today = toDateStr(b.local_today), arr = toDateStr(b.arrival), dep = toDateStr(b.departure);
          const paid = b.status === 'paid' && today && dep > today;
          const started = !!today && arr <= today;
          const windowEnd = R.stayWindowEndMs(arr, b.listing_timezone);
          const inWindow = Date.now() < windowEnd;
          // A transfer to another property stays open until 10 AM on the day after check-in (_booking-transfers.js).
          const transferOpen = (b.listing_type || 'stay') === 'stay' && Date.now() < require('./_booking-transfers').transferWindowEndMs(arr, b.listing_timezone);
          b.can_change = !!paid && (!started || inWindow || transferOpen) && !b.transfer_change_id;
          b.transferred = !!b.transfer_change_id;
          b.can_cancel_request = !!paid && !started && !b.transfer_change_id && !b.open_change;   // not while a change is waiting   // a transferred booking: Aerva Support only
          b.can_report = !!paid && started && (b.listing_type || 'stay') === 'stay' && (inWindow || declined.has(b.id));
          b.stay_window_closed = !!paid && started && !inWindow && !transferOpen;
          // The free cancellation add-on: until when a cancellation is a full refund.
          if (Number(b.free_cancel_fee) > 0 || b.free_cancel_included === true) {
            const P = require('./_pricing');
            const ms = P.freeCancelUntilMs(arr, b.listing_timezone, b.check_in_time);
            b.free_cancel_until = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
            b.free_cancel_until_label = P.freeCancelLabel(ms, b.listing_timezone);
            b.free_cancel_active = !!paid && !b.transfer_change_id && Date.now() < ms;
          }
          delete b.listing_timezone;
        });
      } catch (err) { console.error('booking actions not worked out:', err.message); }

      // Money refunded on each booking (cancellations, deposit returns),
      // for the summary page. Only refunds Razorpay has taken on.
      try {
        const ids = bookings.map(b => b.id);
        if (ids.length) {
          const rf = await sql`SELECT order_id, COALESCE(SUM(amount), 0) AS paise, BOOL_OR(status = 'pending') AS any_pending
                               FROM refunds WHERE order_id = ANY(${ids}) AND status IN ('pending', 'processed') GROUP BY order_id`;
          const byOrder = {}; rf.forEach(r => { byOrder[r.order_id] = { amount: Math.round(Number(r.paise) / 100), pending: !!r.any_pending }; });
          bookings.forEach(b => { b.refunded = byOrder[b.id] || null; });
        }
      } catch (err) { /* refunds table not created yet */ }

      // Aerva's check-in promise: a booking moved to another place shows once
      // (the new one, with one summary); reports, places offered, and the
      // "This place is real and as listed" button (_checkin-promise.js).
      await require('./_checkin-promise').decorateGuestBookings(sql, bookings);

      // What the guest can do about a review on each booking. The page
      // shows a button only for 'open'; see index.html.
      //   open   — checked out, inside the 15-day window, not yet reviewed
      //   done   — already reviewed
      //   closed — the window has passed and the chance has gone
      //   null   — not checked out yet, or a booking that was cancelled
      // submissionOpen is the same rule the submit endpoint enforces, so
      // the button and the endpoint can never disagree.
      bookings.forEach(b => {
        if (b.reviewed) { b.review_state = 'done'; }
        else if (b.status !== 'paid') { b.review_state = null; }
        else {
          // On the property's calendar, same as the submit check below.
          const w = reviewWindowState(b.departure, b.local_today);
          b.review_state = w === 'upcoming' ? null : w;
        }
        // How long is left to review, so the guest can see the window
        // rather than discovering it closed. Counted on the property's
        // calendar, like the window itself.
        if (b.review_state === 'open') {
          const used = daysSinceCheckout(b.departure, b.local_today);
          b.review_days_left = used == null ? null : Math.max(0, REVIEW_WINDOW_DAYS - used);
        }
        b.review_window_days = REVIEW_WINDOW_DAYS;
        delete b.reviewed;
        // Sent as 'YYYY-MM-DD': My Bookings uses it to tell past stays from
        // upcoming ones (Change / Request cancellation only before check-out).
        b.local_today = toDateStr(b.local_today);
      });

      // Group bookings and gifts (_group-bookings.js, _gifts.js): the
      // organiser's and buyer's own bookings get their group / gift; a
      // friend's "Group booking — you paid for N places", a recipient's
      // "Gifted to you" (no money, no actions), and groups still open.
      await require('./_group-bookings').decorateBookings(sql, guestId, bookings);
      await require('./_gifts').decorateBookings(sql, guestId, bookings);
      // Payments waiting for this guest's details to be verified (no booking
      // exists yet), with the deadline; and those that lapsed (_guest-verify.js).
      if (!actingCtx) await require('./_guest-verify').decorateBookings(sql, razorpayClient(), guestId, bookings);

      // Published, non-reverted only — a held review must not move a
      // guest's standing any more than it shows on a listing.
      const reviews = await sql`
        SELECT rating, comment, created_at,
               cleanliness, communication, respectful, rules
        FROM guest_reviews
        WHERE guest_id = ${guestId}
          AND published_at IS NOT NULL AND admin_reverted_at IS NULL
        ORDER BY created_at DESC
      `;

      const reviewCount = reviews.length;
      const avgRating = reviewCount
        ? reviews.reduce((sum, r) => sum + Number(r.rating || 0), 0) / reviewCount
        : 0;

      // ---- Service-fee credits (a host cancelled; _fee-credits.js) ----
      // GET ?mode=feeCredits → { credits: [...], days }
      if (req.query.mode === 'feeCredits') {
        if (actingCtx) return res.status(200).json({ credits: [] });
        const FC = require('./_fee-credits');
        // The guest's coupons too: ready to use, or on their way (15 minutes
        // after a host's cancellation).
        let coupons = [];
        try {
          coupons = (await sql`SELECT c.code, c.amount, c.status, c.expires_at, c.release_at, o.suite_name FROM coupons c LEFT JOIN orders o ON o.id = c.source_order_id
                               WHERE c.guest_id = ${guestId} AND (c.status = 'scheduled' OR (c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at > now())))
                               ORDER BY c.expires_at NULLS LAST, c.id LIMIT 20`)
            .map(c => ({ code: c.status === 'active' ? c.code : null, amount: Number(c.amount), status: c.status, expiresAt: c.expires_at, releaseAt: c.release_at, from: c.suite_name || '' }));
        } catch (e) { coupons = []; }
        return res.status(200).json({ credits: await FC.forGuest(sql, guestId), coupons, days: FC.FEE_CREDIT_DAYS });
      }

      // ---- Their own profile ----
      // GET ?mode=profile — everything their profile page shows, plus the
      // questions themselves so the edit form can be built from one
      // source (see _profiles.js).
      if (req.query.mode === 'profile') {
        const rows = await sql`
          SELECT id, name, created_at, profile_photo_url, host_id,
                 profile_work, profile_hobbies, profile_about, profile_updated_at,
                 to_jsonb(guests)->>'first_name' AS first_name, to_jsonb(guests)->>'last_name' AS last_name
          FROM guests WHERE id = ${guestId}
        `;
        if (!rows[0]) return res.status(404).json({ error: 'Account not found.' });
        return res.status(200).json({ profile: ownNames(await buildProfile(sql, rows[0], { own: true }), rows[0]) });
      }

      // ---- The other person's profile ----
      // GET ?mode=hostProfile&orderId=<id> — the host of one of this
      // guest's own bookings. Gated on the booking, so a profile is never
      // a page a stranger can open, and it carries the same three
      // sections as their own.
      if (req.query.mode === 'hostProfile') {
        const orderId = Number(req.query.orderId);
        if (!orderId) return res.status(400).json({ error: 'Which booking?' });
        const rows = await sql`
          SELECT g.id, g.name, g.created_at, g.profile_photo_url, g.host_id,
                 g.profile_work, g.profile_hobbies, g.profile_about
          FROM orders o
          JOIN listings l ON l.id = o.listing_id
          JOIN guests g ON g.host_id = l.host_id
          WHERE o.id = ${orderId} AND o.guest_id = ${guestId}
            AND o.status IN ('paid', 'cancelled')
        `;
        // Same answer for "not yours" and "does not exist", so booking
        // ids cannot be probed from here.
        if (!rows[0]) return res.status(404).json({ error: 'Booking not found.' });
        return res.status(200).json({ profile: await buildProfile(sql, rows[0]) });
      }

      // ---- Guest tier ----
      // Read from the quarterly snapshot (tier_current), the same source as
      // the header badge, so the profile and the header always agree and
      // the badge only moves on a review day.
      let tier = null;
      try {
        const cur = await sql`
          SELECT tier_key FROM tier_current
          WHERE subject_type = 'guest' AND subject_id = ${guestId}
        `;
        tier = tierByKey(GUEST_TIERS, cur[0] && cur[0].tier_key);
      } catch (err) {
        // A badge is decoration; never fail the profile over it.
        console.error('guest tier lookup failed (non-fatal):', err);
      }

      return res.status(200).json({
        guest: {
          id: guest.id,
          email: guest.email,
          phone: guest.phone,
          name: guest.name,
          profilePhotoUrl: guest.profile_photo_url,
          preferredCurrency: guest.preferred_currency || null,
          memberSince: guest.created_at,
          // Kept for older clients; now the same label as `tier`, so there
          // is one set of rules. The old computeBadge ladder is gone.
          badge: tier ? tier.label : null,
          tier: tier ? { key: tier.key, label: tier.label, blurb: tier.blurb } : null,
          reviewCount,
          avgRating: reviewCount ? Number(avgRating.toFixed(2)) : null
        },
        bookings,
        reviews
      });
    } catch (err) {
      console.error('guest-profile (GET) error:', err);
      return res.status(500).json({ error: mode ? 'Could not load right now.' : 'Could not load your profile.' });
    }
  }

  // ---- Chat actions: send a message, or manage host templates ----
  if (req.method === 'POST') {
    const { mode } = req.body || {};
    try {
      // ---- Refund a service-fee credit now (the guest is not booking again) ----
      // POST { mode: 'refundFeeCredit', id }
      if (mode === 'refundFeeCredit') {
        if (actingCtx) return res.status(403).json({ error: 'Only the guest can do this.' });
        const id = Number((req.body || {}).id) || 0;
        const own = await sql`SELECT id FROM fee_credits WHERE id = ${id} AND guest_id = ${guestId}`;
        if (!own.length) return res.status(404).json({ error: 'Credit not found.' });
        try {
          const r = await require('./_fee-credits').refundCredit(sql, razorpayClient(), id, 'asked');
          await logAudit(sql, { action: 'fee_credit_refunded', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'fee_credit', targetId: id, metadata: { amount: r.refunded, reason: 'asked' } });
          return res.status(200).json({ success: true, refunded: r.refunded });
        } catch (err) {
          if (!err.isUserFacing) console.error('refundFeeCredit failed:', err);
          // The payment gateway refused (_refunds.js): its message is written for
          // Aerva's team (booking, Admin → Refunds). The credit is untouched.
          if (err.isUserFacing && err.status === 502) return res.status(502).json({ error: 'The refund could not be made right now. Your Aerva credit is still here and nothing was charged — please try again later, or raise a request in the Resolution Center (Help → Raise a request).' });
          return res.status(err.isUserFacing ? (err.status || 400) : 500).json({ error: err.isUserFacing ? err.message : 'Could not refund it right now. Please try again in a little while.' });
        }
      }

      // ---- Ask the host before booking (_inquiries.js) ----
      // POST { mode: 'inquiry', listingId, text, arrival?, departure?, guests? }
      if (mode === 'inquiry') {
        if (actingCtx) return res.status(403).json({ error: 'Co-hosts cannot send enquiries.' });
        try {
          const b = req.body || {};
          const out = await createInquiry(sql, { guestId, listingId: Number(b.listingId) || 0, text: b.text, arrival: b.arrival, departure: b.departure, guests: b.guests,
            ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null });
          return res.status(200).json({ success: true, ...out });
        } catch (err) {
          if (!err.isUserFacing) console.error('inquiry failed:', err);
          return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not send your question right now. Please try again.' });
        }
      }

      // ---- Resolution Center: raise, reply to or close a request (_support.js) ----
      // POST { mode: 'supportCreate', category, subject, description, orderId?, listingId?, attachments?, callback? }
      // POST { mode: 'supportReply', ref, text, attachments? }
      // POST { mode: 'supportClose', ref }
      // POST { mode: 'hostCancelAnswer', ref, accept, payment? } — the host confirms (or declines)
      // Aerva cancelling a booking for them (_host-cancel-confirm.js). Within 48 hours
      // of check-in, confirming needs the guest's 10% coupon paid first:
      // POST { mode: 'hostCancelPay', ref } opens the Razorpay payment, and its
      // answer comes back as payment: { couponId, razorpay_order_id, razorpay_payment_id, razorpay_signature }.
      if (mode === 'hostCancelAnswer' || mode === 'hostCancelPay') {
        if (actingCtx) return res.status(403).json({ error: 'Only the host can confirm this, from their own account.' });
        try {
          const b = req.body || {};
          const hcc = require('./_host-cancel-confirm');
          if (mode === 'hostCancelPay') return res.status(200).json(await hcc.startCouponPayment(sql, razorpayClient(), { guestId, ref: b.ref }));
          const payment = b.payment && typeof b.payment === 'object' ? b.payment : null;
          const r = await hcc.answer(sql, razorpayClient(), { guestId, ref: b.ref, accept: b.accept === true, payment });
          return res.status(200).json({ ...r, request: await support.getRequest(sql, guestId, b.ref) });
        } catch (err) {
          if (!err.isUserFacing) console.error(mode + ' failed:', err);
          return res.status(err.isUserFacing ? err.status : 500).json({ ...(err.isUserFacing && err.extra ? err.extra : {}), error: err.isUserFacing ? err.message : 'Could not do this right now. Please try again.' });
        }
      }
      if (mode === 'supportCreate' || mode === 'supportReply' || mode === 'supportClose' || mode === 'supportFeedback') {
        if (actingCtx) return res.status(403).json({ error: 'Requests are raised from your own account.' });
        try {
          const b = req.body || {};
          if (mode === 'supportCreate') {
            const out = await support.createRequest(sql, { guestId, category: b.category, subject: b.subject, description: b.description,
              orderId: Number(b.orderId) || null, listingId: Number(b.listingId) || null, attachments: b.attachments, callback: b.callback === true, callbackPhone: typeof b.callbackPhone === 'string' ? b.callbackPhone : null,
              ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null });
            return res.status(200).json({ success: true, ...out });
          }
          if (mode === 'supportReply') return res.status(200).json({ request: await support.replyToRequest(sql, { guestId, ref: b.ref, text: b.text, attachments: b.attachments }) });
          // POST { mode: 'supportFeedback', ref, resolved, rating?, comment? } — is it resolved? (closes, or opens again)
          if (mode === 'supportFeedback') return res.status(200).json({ request: await support.submitFeedback(sql, { guestId, ref: b.ref, resolved: b.resolved !== false, rating: b.rating, comment: b.comment }) });
          return res.status(200).json({ request: await support.closeRequest(sql, { guestId, ref: b.ref, rating: b.rating, comment: b.comment }) });
        } catch (err) {
          if (!err.isUserFacing) console.error(mode + ' failed:', err);
          return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not send this right now. Please try again in a few minutes.' });
        }
      }

      // POST { mode: 'supportChatSend', text } — to the assistant, or to the team once handed over
      // POST { mode: 'supportChatHandoff', how: 'chat'|'callback', phone?, note? } — "Speak to an agent"
      if (mode === 'supportChatSend' || mode === 'supportChatHandoff') {
        if (actingCtx) return res.status(403).json({ error: 'Aerva Support is reached from your own account.' });
        try {
          const b = req.body || {};
          if (mode === 'supportChatSend') return res.status(200).json(await supportChat.send(sql, guestId, b.text));
          return res.status(200).json(await supportChat.handoff(sql, guestId, { note: b.note, how: b.how === 'callback' ? 'callback' : 'chat', phone: typeof b.phone === 'string' ? b.phone : '' }));
        } catch (err) {
          if (!err.isUserFacing) console.error(mode + ' failed:', err);
          return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not send this right now. Please try again in a few minutes.' });
        }
      }

      // ---- Report a problem during the stay (_stay-disputes.js) ----
      // POST { mode: 'raiseDispute', orderId, reason, details, evidence: [urls] }
      if (mode === 'raiseDispute') {
        try {
          const b = req.body || {};
          const row = await raiseDispute(sql, { orderId: Number(b.orderId) || 0, guestId, reason: b.reason, details: b.details, evidence: b.evidence });
          return res.status(200).json({ success: true, disputeId: row.id });
        } catch (err) {
          return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not send your report right now.' });
        }
      }

      // ---- Aerva's check-in promise (_checkin-promise.js) ----
      // POST { mode: 'acceptRebook', orderId, option }  → one of the places Aerva sent
      //      (costs more: { changeId, pay } — paid through create-order { payChange })
      // POST { mode: 'declineRebook', orderId }          → none suits: refunded in full
      // POST { mode: 'confirmStay', orderId }            → "This place is real and as listed"
      // ---- Gifts (_gifts.js) ----
      // POST { mode: 'sendGift', orderId, recipient: { firstName, lastName, email, phone?, message? } } — make a booking a gift, or change who it is for
      // POST { mode: 'withdrawGift', orderId }
      // POST { mode: 'acceptGift', token | giftId, firstName, lastName, phone }
      // ---- Group bookings (_group-bookings.js) ----
      // POST { mode: 'groupAddGuest', token, places } — add places (never remove): while open, at the
      //      2-hour mark (organiser, once), or after confirmation (the same booking, re-priced)
      // ('groupDecide' — confirming a smaller booking — is gone: owner, 10 Nov 2026. At 2 hours
      //  the organiser pays the rest instead: create-order.js { groupGap }.)
      if (mode === 'sendGift' || mode === 'withdrawGift' || mode === 'acceptGift' || mode === 'groupDecide' || mode === 'groupAddGuest') {
        const b = req.body || {};
        try {
          const G = require('./_gifts');
          if (mode === 'sendGift') return res.status(200).json(await G.sendGift(sql, { orderId: Number(b.orderId) || 0, guestId, input: b.recipient || {} }));
          if (mode === 'withdrawGift') return res.status(200).json(await G.withdrawGift(sql, { orderId: Number(b.orderId) || 0, guestId }));
          if (mode === 'acceptGift') return res.status(200).json(await G.acceptGift(sql, { guestId, token: b.token || null, giftId: b.giftId || null, firstName: b.firstName, lastName: b.lastName, phone: b.phone, ip: getClientIp(req) }));
          if (mode === 'groupAddGuest') return res.status(200).json(await require('./_group-bookings').addGuests(sql, razorpayClient(), { token: String(b.token || '').slice(0, 64), guestId, places: b.places }));
          return res.status(410).json({ error: 'A group booking can no longer be confirmed for fewer guests. At 2 hours the organiser pays the rest to confirm it, or it does not go ahead and everyone is refunded in full.' });
        } catch (err) {
          if (!err.isUserFacing) console.error(mode + ' failed:', err);
          return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not do this right now. Please try again.', needs: err.needs || undefined, maxGuests: err.maxGuests || undefined });
        }
      }
      if (mode === 'acceptRebook' || mode === 'declineRebook' || mode === 'confirmStay') {
        try {
          const b = req.body || {};
          const CP = require('./_checkin-promise');
          const orderId = Number(b.orderId) || 0;
          if (mode === 'confirmStay') return res.status(200).json(await CP.confirmStay(sql, { orderId, guestId }));
          if (mode === 'declineRebook') return res.status(200).json(await CP.declineOffers(sql, razorpayClient(), { orderId, guestId }));
          return res.status(200).json(await CP.acceptOffer(sql, razorpayClient(), { orderId, guestId, option: Number(b.option) }));
        } catch (err) {
          if (!err.isUserFacing) console.error(mode + ' failed:', err);
          return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not do this right now. Please try again, or raise a request in the Resolution Center (Help → Raise a request).' });
        }
      }

      // ---- Confirming the account's email, and its one phone number ----
      // An account is ONE email address and ONE phone number. The code
      // goes to the email: email costs nothing to send, every SMS is
      // billed (_email-otp.js).
      //   POST { mode: 'emailOtpRequest', email }
      //   POST { mode: 'emailOtpVerify', email, code, currentPassword?, currentEmailCode? }
      //   POST { mode: 'savePhone', phone }
      //
      // Confirming the email already on the account (or adding one to an
      // account that has none) needs only the code. CHANGING the email
      // someone signs in with also needs proof it is the account's owner
      // and not someone at an unattended screen: the current password, or —
      // for an account without one (Google, phone) — a code sent to the
      // CURRENT address. The answer { reauth: 'password' | 'currentEmailCode' }
      // says which; the old address is told about the change afterwards,
      // and every other device is signed out (a fresh sessionToken comes
      // back for this one).
      if (mode === 'emailOtpRequest' || mode === 'emailOtpVerify') {
        const b = req.body || {};
        const wanted = emailOtp.normalizeEmail(b.email);
        if (!emailOtp.looksLikeEmail(wanted)) return res.status(400).json({ error: 'Please enter a valid email address.' });
        // One email per account: if another account already uses it, this
        // one cannot take it. That account's owner reached it first.
        const taken = await sql`SELECT id FROM guests WHERE lower(btrim(email)) = ${wanted} AND id <> ${guestId} AND deleted_at IS NULL`;
        if (taken.length) {
          return res.status(409).json({ error: 'That email address is already on another Aerva account. Log in with it instead, or use a different address.' });
        }
        const clientIp = getClientIp(req);
        try {
          if (mode === 'emailOtpRequest') {
            // Per account and per connection, on top of _email-otp.js's own
            // per-address limit: that one cannot stop one account (or one
            // script) cycling through many different addresses.
            const byAccount = await countRecentAttempts(sql, { action: 'guest_email_otp_requested', windowMinutes: 60, byActor: String(guestId) });
            const byIp = await countRecentAttempts(sql, { action: 'guest_email_otp_requested', windowMinutes: 60, byIp: clientIp });
            if (byAccount >= 10 || byIp >= 20) {
              return res.status(429).json({ error: 'Too many codes have been asked for. Please try again in an hour.' });
            }
            await logAudit(sql, { action: 'guest_email_otp_requested', success: true, actorType: 'guest', actorIdentifier: String(guestId),
              targetType: 'guest', targetId: guestId, metadata: { ip: clientIp } });
            const out = await emailOtp.requestCode(sql, wanted, { purpose: 'link' });
            return res.status(200).json({ sent: true, email: out.email, expiresInMinutes: out.expiresInMinutes });
          }

          const me = (await sql`SELECT id, email, password_hash, host_id, email_verified,
                                       to_jsonb(guests)->>'email_verified_at' AS email_verified_at
                                FROM guests WHERE id = ${guestId}`)[0];
          if (!me) return res.status(401).json({ error: 'Please log in again.' });
          const current = emailOtp.normalizeEmail(me.email);
          const currentConfirmed = !!(me.email_verified === true || me.email_verified_at);
          const changing = !!current && current !== wanted && currentConfirmed;
          if (changing) {
            const fails = await countRecentAttempts(sql, { action: 'guest_email_change_reauth', windowMinutes: 15, byActor: String(guestId), onlyFailures: true });
            if (fails >= 5) return res.status(429).json({ error: 'Too many attempts. Please try again in 15 minutes.' });
            if (me.password_hash) {
              if (typeof b.currentPassword !== 'string' || !b.currentPassword) {
                return res.status(403).json({ reauth: 'password', error: 'To change the email you log in with, please enter your current password.' });
              }
              if (!(await bcrypt.compare(b.currentPassword, me.password_hash))) {
                await logAudit(sql, { action: 'guest_email_change_reauth', success: false, actorType: 'guest', actorIdentifier: String(guestId),
                  targetType: 'guest', targetId: guestId, metadata: { how: 'password', ip: clientIp } });
                return res.status(401).json({ reauth: 'password', error: 'That password is not right.' });
              }
            } else {
              if (!b.currentEmailCode) {
                await emailOtp.requestCode(sql, current, { purpose: 'change' });
                return res.status(403).json({ reauth: 'currentEmailCode', sentTo: emailOtp.maskEmail(current),
                  error: `To change your email, enter the code we just sent to your current address, ${emailOtp.maskEmail(current)}.` });
              }
              const cur = await emailOtp.checkCode(sql, current, b.currentEmailCode);
              if (!cur.ok) {
                await logAudit(sql, { action: 'guest_email_change_reauth', success: false, actorType: 'guest', actorIdentifier: String(guestId),
                  targetType: 'guest', targetId: guestId, metadata: { how: 'current_email_code', ip: clientIp } });
                return res.status(400).json({ reauth: 'currentEmailCode', error: 'Code for your current address: ' + cur.error });
              }
            }
          }

          const check = await emailOtp.checkCode(sql, wanted, b.code);
          if (!check.ok) return res.status(400).json({ error: check.error });
          try {
            // Both flags: older code reads email_verified, newer reads
            // email_verified_at (_guest-id.js accepts either).
            await sql`UPDATE guests SET email = ${wanted}, email_verified = true, email_verified_at = now() WHERE id = ${guestId}`;
          } catch (err) {
            if (/unique|duplicate/i.test(err.message)) return res.status(409).json({ error: 'That email address is already on another Aerva account.' });
            throw err;
          }
          await logAudit(sql, { action: changing ? 'guest_email_changed' : 'guest_email_confirmed', success: true, actorType: 'guest', actorIdentifier: String(guestId),
            targetType: 'guest', targetId: guestId, metadata: { email: wanted, ...(changing ? { from: current } : {}), ip: clientIp } });
          if (!changing) return res.status(200).json({ confirmed: true, email: wanted });

          // The host record carries the same contact address (booking emails,
          // the admin tool). Bookings and conversations keep the address
          // they were made with.
          if (me.host_id) {
            try { await sql`UPDATE hosts SET email = ${wanted} WHERE id = ${me.host_id}`; } catch (e) { console.error('host email not updated:', e.message); }
            try { await sql`UPDATE listings SET host_email = ${wanted} WHERE host_id = ${me.host_id}`; } catch (e) { console.error('listing host_email not updated:', e.message); }
          }
          await emailOtp.sendEmailChangedNotice(current, wanted);
          await bumpSessionVersion(sql, guestId);
          const sessionToken = await newSessionToken(sql, guestId, SESSION_LIFETIME_MS);
          return res.status(200).json({ confirmed: true, changed: true, email: wanted, sessionToken });
        } catch (err) {
          if (err.isUserFacing) return res.status(err.status).json({ error: err.message });
          console.error('email OTP failed:', err);
          return res.status(500).json({ error: 'Could not do this right now. Please try again.' });
        }
      }
      // A typed number is stored UNVERIFIED (guests.phone_verified = false):
      // it is how a host reaches the guest, never a way to sign in. A person
      // who later proves the number by text-message code (guest-phone-auth.js)
      // takes it over from an unverified holder. Between two unverified
      // claims the first one keeps it (see the report's owner decisions).
      if (mode === 'savePhone') {
        const e164 = normalizeToE164(String((req.body || {}).phone || ''));
        if (!e164) return res.status(400).json({ error: 'Please enter a valid mobile number, with the country code if you are outside India.' });
        // One phone per account, same rule as the email.
        const d164 = e164.replace(/\D/g, '');   // by digits, so an older "9876543210" row is found too
        const taken = await sql`SELECT id FROM guests WHERE id <> ${guestId} AND deleted_at IS NULL AND phone IS NOT NULL
          AND (regexp_replace(phone, '[^0-9]', '', 'g') = ${d164} OR (${d164.startsWith('91') && d164.length === 12} AND regexp_replace(phone, '[^0-9]', '', 'g') IN (${d164.slice(2)}, ${'0' + d164.slice(2)})))`;
        if (taken.length) {
          return res.status(409).json({ error: 'This phone number is already linked to another Aerva account. Log in with it instead, or use a different number.' });
        }
        try {
          const before = (await sql`SELECT phone FROM guests WHERE id = ${guestId}`)[0];
          if (before && String(before.phone || '').trim() === e164) return res.status(200).json({ phone: e164 });
          await sql`UPDATE guests SET phone = ${e164} WHERE id = ${guestId}`;
          try { await sql`UPDATE guests SET phone_verified = false WHERE id = ${guestId}`; } catch (e) { /* before migration_session_version.sql */ }
          // A new number is not a confirmed number: its SMS confirmation is
          // cleared (the database does the same for any change of phone —
          // 2026-11-10-09-guest-verification.sql; this is for the record).
          try { await sql`UPDATE guests SET phone_verified_at = NULL, phone_verified_number = NULL WHERE id = ${guestId} AND phone_verified_number IS DISTINCT FROM phone`; } catch (e) { /* before that update */ }
          if (before && String(before.phone || '').trim()) {
            await logAudit(sql, { action: 'guest_phone_changed', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId,
              metadata: { phoneVerificationCleared: true, ip: getClientIp(req) } });
          }
          return res.status(200).json({ phone: e164, verified: false });
        } catch (err) {
          if (/unique|duplicate/i.test(err.message)) return res.status(409).json({ error: 'That number is already on another Aerva account.' });
          throw err;
        }
      }

      // ---- Their first and last name (owner, 9 Nov 2026) ----
      // POST { mode: 'saveName', firstName, lastName } → { firstName, lastName, name }
      // As on their government ID: the host checks it at check-in. Letters
      // of any script (with their accents and vowel signs), spaces, dots,
      // apostrophes and hyphens; no digits ("Tanish1" is refused). guests.name
      // follows as "First Last". Bookings already made keep the name they
      // were booked with (orders.guest_first_name / guest_last_name).
      if (mode === 'saveName') {
        const b = req.body || {};
        const first = cleanPersonName(b.firstName);
        const last = cleanPersonName(b.lastName);
        const bad = nameProblem(first, 'first') || nameProblem(last, 'last');
        if (bad) return res.status(400).json({ error: bad });
        const full = first + ' ' + last;
        const before = (await sql`SELECT name, to_jsonb(guests)->>'first_name' AS first_name, to_jsonb(guests)->>'last_name' AS last_name,
                                         (to_jsonb(guests)->>'guest_id_verified_at') IS NOT NULL AS id_verified
                                  FROM guests WHERE id = ${guestId}`)[0];
        if (!before) return res.status(401).json({ error: 'Please log in again.' });
        if (before.first_name === first && before.last_name === last && before.name === full) {
          return res.status(200).json({ firstName: first, lastName: last, name: full });
        }
        try {
          await sql`UPDATE guests SET first_name = ${first}, last_name = ${last}, name = ${full} WHERE id = ${guestId}`;
        } catch (err) {
          if (!/first_name|last_name/.test(err.message)) throw err;
          // Before migration_guest_details.sql: keep at least the full name.
          await sql`UPDATE guests SET name = ${full} WHERE id = ${guestId}`;
        }
        await logAudit(sql, { action: before.first_name || before.last_name ? 'guest_name_changed' : 'guest_name_added', success: true,
          actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId,
          metadata: { from: { firstName: before.first_name || null, lastName: before.last_name || null, name: before.name || null },
                      to: { firstName: first, lastName: last }, ip: getClientIp(req) } });
        // An ID verified for one name is not verified for another: a change
        // of name clears it (done by the database on any change of name,
        // 2026-11-10-09-guest-verification.sql). The page is told.
        let idCleared = false;
        if (before.id_verified) {
          try { idCleared = !((await sql`SELECT (to_jsonb(guests)->>'guest_id_verified_at') IS NOT NULL AS v FROM guests WHERE id = ${guestId}`)[0] || {}).v; } catch (e) { idCleared = false; }
          if (idCleared) await logAudit(sql, { action: 'guest_id_cleared', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'guest', targetId: guestId, metadata: { reason: 'name_changed' } });
        }
        // A name added while a payment waits for the guest's details may be the last step.
        let confirmed = [];
        try { confirmed = await require('./_guest-verify').confirmHoldsFor(sql, razorpayClient(), guestId); } catch (e) { confirmed = []; }
        return res.status(200).json({ firstName: first, lastName: last, name: full, idVerificationCleared: idCleared, confirmed });
      }

      // ---- Changing a booking ----
      // POST { mode: 'changeQuote',   orderId, change } → new price and difference
      // POST { mode: 'requestChange', orderId, change } → sent to the host in Messages
      // POST { mode: 'withdrawChange', changeId }
      // change: { arrival, departure, adults, children, infants, pets, petTypes, amenityIds }
      if (mode === 'changeQuote' || mode === 'requestChange' || mode === 'withdrawChange' || mode === 'confirmTransfer') {
        try {
          const b = req.body || {};
          // POST { mode: 'confirmTransfer', changeId } → the guest accepts the refund and completes an accepted transfer
          if (mode === 'confirmTransfer') return res.status(200).json(await require('./_booking-changes').confirmTransfer(sql, razorpayClient(), { changeId: Number(b.changeId) || 0, guestId }));
          if (mode === 'withdrawChange') return res.status(200).json(await withdrawChange(sql, { changeId: Number(b.changeId) || 0, guestId }));
          if (mode === 'changeQuote') return res.status(200).json(changeView(await quoteChange(sql, Number(b.orderId) || 0, guestId, b.change || {})));
          const row = await requestChange(sql, { orderId: Number(b.orderId) || 0, guestId, input: b.change || {} });
          return res.status(200).json({ requested: true, changeId: row.id });
        } catch (err) {
          if (!err.isUserFacing) console.error('booking change failed:', err);
          return res.status(err.isUserFacing ? err.status : 500).json({ error: err.isUserFacing ? err.message : 'Could not do this right now. Please try again.' });
        }
      }

      // ---- Guest asks to cancel (any reason) ----
      // POST { mode: 'cancelBooking' | 'requestCancellation', orderId, reasonCode, details, evidence }
      // reasonCode: 'change_of_plans', or a natural disaster ('environmental',
      // 'travel_restriction') with evidence — that one goes to Aerva.
      // A guest never cancels on their own: the request goes into the
      // booking's message thread and the host answers there (or in My
      // Earnings), seeing only the choice for this booking's bracket.
      // POST { mode: 'requestCancellationReview' } — removed on 10 Nov 2026
      // (owner): a natural disaster goes to Aerva directly; a host's decline
      // of a change of plans is final.
      if (mode === 'requestCancellationReview') {
        return res.status(410).json({ error: 'Asking Aerva to review a host’s decline is no longer available. For a natural disaster or a government order, send your cancellation request with proof: Aerva decides it.' });
      }
      if (mode === 'cancelBooking' || mode === 'requestCancellation') {
        try {
          const b = req.body || {};
          const out = await createCancellationRequest(sql, { orderId: Number(b.orderId) || 0, guestId, reasonCode: b.reasonCode || 'change_of_plans', details: b.details, evidence: b.evidence, razorpay: razorpayClient() });
          if (out.error) return res.status(out.status || 400).json({ error: out.error });
          // Free cancellation add-on, inside its window: cancelled at once.
          if (out.cancelled) return res.status(200).json({ success: true, cancelled: true, refundCash: out.cancelled.refundCash, couponBack: out.cancelled.couponBack || 0, creditBack: out.cancelled.creditBack || 0 });
          return res.status(200).json({ success: true, requested: true });
        } catch (err) {
          console.error('cancellation request failed:', err);
          return res.status(500).json({ error: 'Could not send the request right now. Please try again.' });
        }
      }

      // ---- Like / unlike a listing ----
      // POST { mode: 'toggleLike', listingId } -> { liked, likeCount }
      //
      // Likes only; there is no dislike. One per account per listing (the
      // table's primary key), so a double tap can never count twice. Any
      // live stay or experience can be liked, a host's own included.
      // POST { mode: 'setFavorite', listingId, on } — heart or un-heart one home.
      // POST { mode: 'setFavorite', listingIds: [...], on: true } — hearts saved
      // on a device before favourites lived on the account (merged once).
      if (mode === 'setFavorite') {
        const b = req.body || {};
        const on = b.on !== false;
        const ids = (Array.isArray(b.listingIds) ? b.listingIds : [b.listingId])
          .map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 200);
        if (!ids.length) return res.status(400).json({ error: 'Missing listing.' });
        try {
          if (on) {
            await sql`INSERT INTO guest_favorites (guest_id, listing_id)
                      SELECT ${guestId}, l.id FROM listings l WHERE l.id = ANY(${ids}) AND l.status = 'approved'
                      ON CONFLICT DO NOTHING`;
          } else {
            await sql`DELETE FROM guest_favorites WHERE guest_id = ${guestId} AND listing_id = ANY(${ids})`;
          }
        } catch (err) {
          if (/guest_favorites/.test(String(err && err.message))) return res.status(200).json({ synced: false });
          throw err;
        }
        return res.status(200).json({ success: true, synced: true, favorite: on });
      }

      if (mode === 'toggleLike') {
        const listingId = Number((req.body || {}).listingId);
        if (!Number.isInteger(listingId) || listingId <= 0) {
          return res.status(400).json({ error: 'Missing listing.' });
        }
        const live = await sql`SELECT id FROM listings WHERE id = ${listingId} AND status = 'approved'`;
        if (!live.length) return res.status(404).json({ error: 'This listing is not available.' });

        // Insert first: if it goes in, this is a like. If it was already
        // there, the same tap means unlike. Either way one statement
        // decides, so two quick taps land as like-then-unlike, never as
        // two likes.
        const added = await sql`
          INSERT INTO listing_likes (guest_id, listing_id) VALUES (${guestId}, ${listingId})
          ON CONFLICT (listing_id, guest_id) DO NOTHING
          RETURNING listing_id
        `;
        let liked = true;
        if (!added.length) {
          await sql`DELETE FROM listing_likes WHERE guest_id = ${guestId} AND listing_id = ${listingId}`;
          liked = false;
        }
        const countRows = await sql`SELECT COUNT(*)::int AS n FROM listing_likes WHERE listing_id = ${listingId}`;
        return res.status(200).json({ liked, likeCount: Number(countRows[0]?.n || 0) });
      }

      // ---- Guest reviews a property ----
      // POST { mode: 'submitReview', orderId, hygiene, communication,
      // services, value, location, comment, photos?: [url] (up to 5) }
      //
      // All five ratings and the comment are mandatory; the database
      // enforces that too (see migration_reviews.sql), so a malformed
      // insert fails loudly rather than storing a half review.
      //
      // Nothing is published here. published_at stays NULL and the daily
      // sweep decides — immediately if the host has also reviewed, or
      // after the window closes. See _review-policy.js.
      // ---- Save their own profile ----
      // POST { mode: 'saveProfile', work, hobbies, about: { <questionId>: answer } }
      // Everything is optional: a profile is built up over time, and a
      // half-filled one is better than an empty one.
      if (mode === 'saveProfile') {
        const clean = sanitizeProfileInput(req.body || {});
        await sql`
          UPDATE guests SET
            profile_work = ${clean.work},
            profile_hobbies = ${clean.hobbies},
            profile_about = ${JSON.stringify(clean.about)}::jsonb,
            profile_updated_at = now()
          WHERE id = ${guestId}
        `;
        const rows = await sql`
          SELECT id, name, created_at, profile_photo_url, host_id,
                 profile_work, profile_hobbies, profile_about, profile_updated_at,
                 to_jsonb(guests)->>'first_name' AS first_name, to_jsonb(guests)->>'last_name' AS last_name
          FROM guests WHERE id = ${guestId}
        `;
        return res.status(200).json({ success: true, profile: ownNames(await buildProfile(sql, rows[0], { own: true }), rows[0]) });
      }

      if (mode === 'submitReview') {
        const b = req.body || {};
        const orderId = Number(b.orderId);
        if (!orderId) return res.status(400).json({ error: 'Which booking is this review for?' });

        const rows = await sql`
          SELECT o.id, o.listing_id, o.room_id, o.departure, o.status, o.order_type,
                 l.host_id, COALESCE(l.listing_type, 'stay') AS listing_type,
                 (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), ${DEFAULT_TIMEZONE}))::date AS local_today
          FROM orders o JOIN listings l ON l.id = o.listing_id
          WHERE o.id = ${orderId} AND o.guest_id = ${guestId}
        `;
        const order = rows[0];
        if (!order) return res.status(404).json({ error: 'Booking not found.' });
        if (order.status !== 'paid') return res.status(400).json({ error: 'Only completed bookings can be reviewed.' });
        // Judged on the property's calendar, not the server's — the same
        // rule the host's review of the guest follows.
        if (!submissionOpen(order.departure, order.local_today)) {
          return res.status(400).json({ error: `Reviews can be left for ${REVIEW_WINDOW_DAYS} days after checkout. This window has closed.` });
        }

        // Which factors are mandatory depends on WHAT was booked. Asking a
        // guest to rate the hygiene of a guided walk is a question with no
        // sensible answer, and whatever they put would then carry the
        // heaviest weight in that experience's score.
        const isExperience = order.listing_type === 'experience';
        const FIELDS = isExperience
          ? ['organisation', 'safety', 'guide', 'value']
          : ['hygiene', 'communication', 'services', 'value', 'location'];
        const LABEL = { value: 'value for money', organisation: 'organisation', guide: 'the guide', safety: 'safety' };
        const vals = {};
        for (const f of FIELDS) {
          const v = Number(b[f]);
          if (!Number.isFinite(v) || v < 1 || v > 5) {
            return res.status(400).json({ error: `Please rate ${LABEL[f] || f} between 1 and 5.` });
          }
          vals[f] = v;
        }
        const comment = typeof b.comment === 'string' ? b.comment.trim() : '';
        if (comment.length < 10) {
          return res.status(400).json({ error: 'Please write at least 10 characters about your stay.' });
        }
        // Photos of the stay: up to 5, Aerva uploads only, each once
        // (_review-policy.js cleanReviewPhotos).
        const cleaned = cleanReviewPhotos(b.photos);
        if (cleaned.error) return res.status(400).json({ error: cleaned.error });
        const photos = cleaned.photos;

        try {
          // One table, two shapes. The unused set is written as NULL rather
          // than zero — a zero would be read as a rating of nothing, and
          // _tiers.js treats an absent factor as "not scored", which is
          // the truth here.
          const inserted = await sql`
            INSERT INTO listing_reviews
              (order_id, listing_id, room_id, guest_id, host_id,
               hygiene, communication, services, value_rating, location,
               organisation, guide, safety, comment)
            VALUES
              (${order.id}, ${order.listing_id}, ${order.room_id || null}, ${guestId}, ${order.host_id},
               ${vals.hygiene ?? null}, ${vals.communication ?? null}, ${vals.services ?? null},
               ${vals.value}, ${vals.location ?? null},
               ${vals.organisation ?? null}, ${vals.guide ?? null}, ${vals.safety ?? null},
               ${comment})
            RETURNING id
          `;
          // Photos in their own statement, so a review still goes in before
          // migration 2026-11-09-08-review-photos.sql has run (the guest is
          // then told photos are not switched on yet).
          let photosSaved = 0, photosOff = false;
          if (photos.length) {
            try {
              await sql`UPDATE listing_reviews SET photos = ${JSON.stringify(photos)}::jsonb WHERE id = ${inserted[0].id}`;
              photosSaved = photos.length;
            } catch (err) {
              if (err && err.code === '42703') photosOff = true;
              else console.error('review photos not saved:', err.message || err);
            }
          }
          await logAudit(sql, {
            action: 'listing_review_submitted', success: true, actorType: 'guest', actorIdentifier: String(guestId),
            targetType: 'listing_review', targetId: inserted[0].id,
            metadata: { orderId: order.id, listingId: order.listing_id, photos: photosSaved, ...(photosOff ? { photosOff: true } : {}) }
          });
          // A photo already found to show contact details is taken out at
          // once, silently; the admin is told (_photo-guard.js, the same as
          // a profile photo). Photos not checked yet are picked up by the
          // 5-minute photo check.
          if (photosSaved) await photoGuard.sweepReview(sql, inserted[0].id);
          return res.status(200).json({ success: true, held: true,
            ...(photosOff ? { photosOff: true, notice: 'Photos on reviews are not switched on yet, so your review was saved without them.' } : {}) });
        } catch (err) {
          // The one-per-order unique constraint is the expected failure.
          if (String(err && err.message || '').includes('one_per_order')) {
            return res.status(409).json({ error: 'You have already reviewed this stay.' });
          }
          console.error('submitReview error:', err);
          return res.status(500).json({ error: 'Could not save your review right now.' });
        }
      }

      if (mode === 'send') {
        const { conversationId, text, role } = req.body || {};
        const rawText = typeof text === 'string' ? text.trim().slice(0, 2000) : '';
        // Photos: Aerva-stored images only, up to 6 a message, and only in a
        // confirmed booking's chat until check-out (checked below).
        const { isAervaBlobUrl } = require('./_listing-rules');
        const photosIn = Array.isArray((req.body || {}).photos) ? req.body.photos : [];
        const photos = [...new Set(photosIn.filter(u => typeof u === 'string').map(u => u.trim()).filter(isAervaBlobUrl))].slice(0, 6);
        if (photosIn.length > 6) return res.status(400).json({ error: 'You can send up to 6 photos in one message.' });
        if (photosIn.length && photos.length !== photosIn.length) return res.status(400).json({ error: 'Those photos could not be sent. Please add them again.' });
        if (!conversationId || (!rawText && !photos.length)) return res.status(400).json({ error: 'Message can\'t be empty.' });
        // A template tapped in while its details are not set leaves filler such
        // as "(check-in time not set yet)": never sent that way (same rule as
        // the automatic messages, _template-scheduling.js).
        const missingBits = require('./_template-scheduling').missingDetails(rawText);
        if (missingBits.length) {
          return res.status(400).json({ error: `This message needs details that are not set yet: ${missingBits.join(', ')}. Add them in Manage listing → Guest Check-In Info, or remove those parts, then send.`, missingDetails: missingBits });
        }

        const convRows = await sql`SELECT id, guest_id, host_id, order_id FROM conversations WHERE id = ${conversationId}`;
        const conv = convRows[0];
        if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
        // A gift's recipient or a group booking's payer writes as the guest
        // side, with their first name in front so the host knows who it is.
        const sharedSender = conv.guest_id !== guestId && conv.order_id ? await require('./_gifts').sharedRole(sql, guestId, conv.order_id) : null;
        const isGuest = conv.guest_id === guestId || !!sharedSender;
        const isHost = myHostId != null && conv.host_id === myHostId;
        if (!isGuest && !isHost) return res.status(403).json({ error: 'Not your conversation.' });

        // Which "hat" is this account wearing right now? Identity alone
        // can't answer that when one account is both the guest on this
        // booking AND a host elsewhere (e.g. a host testing by booking
        // their own listing) — isHost-first priority used to mean EVERY
        // message from such an account got stored as sender_type='host',
        // regardless of which UI (guest chat widget vs. host inbox) it
        // was actually sent from, making the guest side look like it
        // never received anything (every bubble rendered as "mine").
        // The caller now says which surface it's sending from; that's
        // validated against real conversation membership, never trusted
        // blindly. Older clients that don't send `role` fall back to the
        // previous behavior so nothing breaks pre-deploy.
        let senderType;
        if (role === 'guest' || role === 'host') {
          if (role === 'guest' && !isGuest) return res.status(403).json({ error: 'You are not the guest on this booking.' });
          if (role === 'host' && !isHost) return res.status(403).json({ error: 'You are not the host on this booking.' });
          senderType = role;
        } else {
          senderType = isHost ? 'host' : 'guest';
        }

        if (await require('./_message-guard').messagingClosed(sql, conversationId)) {
          return res.status(400).json({ error: require('./_message-guard').MESSAGING_CLOSED_TEXT, messagingClosed: true });
        }
        if (photos.length && !(await require('./_message-guard').photosAllowed(sql, conversationId))) {
          return res.status(400).json({ error: 'Photos can be shared once the booking is confirmed, until the review period closes.' });
        }
        // Contact details in this message, or built up over the sender's
        // recent messages (_message-guard.js). Earlier pieces lose them too.
        const guard = rawText ? await guardMessage(sql, { conversationId, senderType, text: rawText }) : { displayText: '', wasRedacted: false, rewrite: [], by: null };
        let displayText = guard.displayText; const wasRedacted = guard.wasRedacted;
        if (sharedSender && senderType === 'guest' && displayText) {
          const me = (await sql`SELECT name, to_jsonb(guests)->>'first_name' AS first_name FROM guests WHERE id = ${guestId}`)[0] || {};
          displayText = `${me.first_name || String(me.name || 'Guest').split(/\s+/)[0]} (${sharedSender === 'recipient' ? 'guest staying' : 'group'}): ${displayText}`;
        }
        for (const m of guard.rewrite) {
          await sql`UPDATE messages SET display_text = ${m.display_text}, was_redacted = true WHERE id = ${m.id} AND conversation_id = ${conversationId}`;
        }
        if (guard.by) {
          await logAudit(sql, { action: 'message_contact_pieces_removed', success: true, actorType: 'guest', actorIdentifier: String(guestId),
            targetType: 'conversation', targetId: conversationId, metadata: { senderType, by: guard.by, what: guard.what, earlierMessages: guard.rewrite.map(m => m.id) } });
        }
        const inserted = photos.length
          ? await sql`
            INSERT INTO messages (conversation_id, sender_type, original_text, display_text, was_redacted, photo_urls, original_photo_urls)
            VALUES (${conversationId}, ${senderType}, ${rawText}, ${displayText}, ${wasRedacted}, ${JSON.stringify(photos)}::jsonb, ${JSON.stringify(photos)}::jsonb)
            RETURNING id, sender_type, display_text, was_redacted, created_at, photo_urls AS photos`
          : await sql`
            INSERT INTO messages (conversation_id, sender_type, original_text, display_text, was_redacted)
            VALUES (${conversationId}, ${senderType}, ${rawText}, ${displayText}, ${wasRedacted})
            RETURNING id, sender_type, display_text, was_redacted, created_at
          `;
        return res.status(200).json({ message: inserted[0] });
      }

      // Unsend: the sender takes back their own message within
      // UNSEND_MINUTES of sending it. Both sides then see "This message was
      // unsent". The text is kept in the database for Aerva's records
      // (disputes, safety) and is never shown on either screen again.
      if (mode === 'unsend') {
        const { conversationId, messageId, role } = req.body || {};
        const convRows = await sql`SELECT id, guest_id, host_id FROM conversations WHERE id = ${Number(conversationId) || 0}`;
        const conv = convRows[0];
        if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
        const isGuest = conv.guest_id === guestId;
        const isHost = myHostId != null && conv.host_id === myHostId;
        if (!isGuest && !isHost) return res.status(403).json({ error: 'Not your conversation.' });
        const side = role === 'guest' || role === 'host' ? role : (isHost ? 'host' : 'guest');
        if ((side === 'guest' && !isGuest) || (side === 'host' && !isHost)) return res.status(403).json({ error: 'Not your message.' });
        let rows;
        try {
          rows = await sql`SELECT id, sender_type, created_at, unsent_at FROM messages WHERE id = ${Number(messageId) || 0} AND conversation_id = ${conv.id}`;
        } catch (err) {
          if (/unsent_at/.test(String(err && err.message))) return res.status(503).json({ error: 'Unsending is being set up. Please try again later.' });
          throw err;
        }
        const m = rows[0];
        if (!m || m.sender_type !== side) return res.status(404).json({ error: 'You can only unsend your own messages.' });
        if (m.unsent_at) return res.status(200).json({ success: true, already: true });
        if (Date.now() - new Date(m.created_at).getTime() > UNSEND_MINUTES * 60000) {
          return res.status(409).json({ error: `Messages can only be unsent within ${UNSEND_MINUTES === 60 ? '1 hour' : UNSEND_MINUTES + ' minutes'} of sending.` });
        }
        await sql`UPDATE messages SET unsent_at = now() WHERE id = ${m.id} AND unsent_at IS NULL`;
        await logAudit(sql, { action: 'message_unsent', success: true, actorType: side === 'host' ? 'host' : 'guest', actorIdentifier: String(guestId),
          targetType: 'conversation', targetId: conv.id, metadata: { messageId: m.id, sentAt: m.created_at } });
        return res.status(200).json({ success: true });
      }

      // React: one smiley per person on the OTHER side's message, to
      // acknowledge it. POST { mode: 'react', conversationId, messageId,
      // emoji (one of REACTIONS, or '' to take it off), role }.
      if (mode === 'react') {
        const { conversationId, messageId, role } = req.body || {};
        const emoji = String((req.body || {}).emoji || '');
        if (emoji && !REACTIONS.includes(emoji)) return res.status(400).json({ error: 'That reaction is not available.' });
        const convRows = await sql`SELECT id, guest_id, host_id, order_id FROM conversations WHERE id = ${Number(conversationId) || 0}`;
        const conv = convRows[0];
        if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
        const isGuest = conv.guest_id === guestId || !!(conv.order_id && await require('./_gifts').sharedRole(sql, guestId, conv.order_id));
        const isHost = myHostId != null && conv.host_id === myHostId;
        if (!isGuest && !isHost) return res.status(403).json({ error: 'Not your conversation.' });
        const side = role === 'guest' || role === 'host' ? role : (isHost ? 'host' : 'guest');
        if ((side === 'guest' && !isGuest) || (side === 'host' && !isHost)) return res.status(403).json({ error: 'Not your conversation.' });
        const m = (await sql`SELECT id, sender_type, to_jsonb(messages)->>'unsent_at' AS unsent_at FROM messages
                             WHERE id = ${Number(messageId) || 0} AND conversation_id = ${conv.id}`)[0];
        if (!m) return res.status(404).json({ error: 'Message not found.' });
        if (m.sender_type === side) return res.status(400).json({ error: 'You can react to the other person\'s messages.' });
        if (m.unsent_at) return res.status(409).json({ error: 'This message was unsent.' });
        try {
          if (side === 'guest') await sql`UPDATE messages SET guest_reaction = ${emoji || null} WHERE id = ${m.id}`;
          else await sql`UPDATE messages SET host_reaction = ${emoji || null} WHERE id = ${m.id}`;
        } catch (err) {
          if (/_reaction/.test(String(err && err.message))) return res.status(503).json({ error: 'Reactions are being set up. Please try again later.' });
          throw err;
        }
        return res.status(200).json({ success: true, emoji: emoji || null });
      }

      // Real machine translation via Google Cloud Translation API — a
      // v2 REST call, same lightweight "just fetch() a Google endpoint
      // with an API key" pattern _social-auth.js already uses for
      // Google Sign-In, so no extra SDK dependency for this one feature.
      // Requires GOOGLE_TRANSLATE_API_KEY (a separate API key from
      // GOOGLE_CLIENT_ID — created in Google Cloud Console with the
      // Cloud Translation API enabled on that project's billing account).
      // Available to either party in a conversation, not just hosts —
      // translation is equally useful to a guest reading a host's reply
      // in a different language — but still requires a logged-in session
      // (requireGuest already ran above) so this can't be hit anonymously
      // and run up translation costs on Aerva's API key for free.
      if (mode === 'translate') {
        const { text, targetLang } = req.body || {};
        const rawText = typeof text === 'string' ? text.trim().slice(0, 2000) : '';
        const target = typeof targetLang === 'string' && targetLang.trim() ? targetLang.trim().slice(0, 10) : 'en';
        if (!rawText) return res.status(400).json({ error: 'Nothing to translate.' });
        if (!process.env.GOOGLE_TRANSLATE_API_KEY) {
          console.error('GOOGLE_TRANSLATE_API_KEY not set — translation is not available.');
          return res.status(503).json({ error: 'Translation isn\'t available right now.' });
        }
        try {
          const gRes = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${process.env.GOOGLE_TRANSLATE_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: rawText, target, format: 'text' })
          });
          const gData = await gRes.json().catch(() => null);
          const translation = gData && gData.data && gData.data.translations && gData.data.translations[0];
          if (!gRes.ok || !translation) {
            console.error('Google Translate request failed:', gRes.status, gData);
            return res.status(502).json({ error: 'Could not translate that message right now.' });
          }
          return res.status(200).json({
            translatedText: translation.translatedText,
            detectedSourceLanguage: translation.detectedSourceLanguage || null
          });
        } catch (err) {
          console.error('Google Translate request error:', err);
          return res.status(502).json({ error: 'Could not translate that message right now.' });
        }
      }

      // Saving the "Description" tab's free-text guidance for one
      // specific property. listings.host_id is a hosts.id (see myHostId's
      // comment up top) — checked directly here, same as saveTemplate's
      // own listing-ownership check below, rather than trusting whatever
      // listingId the browser sends.
      if (mode === 'saveListingGuidance') {
        const { listingId, guidance } = req.body || {};
        const safeGuidance = typeof guidance === 'string' ? guidance.trim().slice(0, 5000) : '';
        if (!listingId) return res.status(400).json({ error: 'Missing property.' });
        if (myHostId == null) return res.status(403).json({ error: 'Not your listing.' });
        const ownedRows = await sql`SELECT id FROM listings WHERE id = ${listingId} AND host_id = ${myHostId}`;
        if (!ownedRows.length) return res.status(403).json({ error: 'Not your listing.' });
        await sql`UPDATE listings SET guest_guidance = ${safeGuidance || null} WHERE id = ${listingId}`;
        return res.status(200).json({ success: true });
      }

      if (mode === 'saveTemplate') {
        const { templateId, listingId, body, sendOnBookingConfirmed, autoSendListingIds, title, sendTrigger, sendOffsetDays, sendOffsetValue, sendOffsetUnit, sendAtTime } = req.body || {};
        const safeBody = typeof body === 'string' ? body.trim().slice(0, 1500) : '';
        if (!safeBody) return res.status(400).json({ error: 'Template text can\'t be empty.' });
        const safeTitle = typeof title === 'string' ? title.trim().slice(0, 80) : '';
        // When it is sent. Older pages send only sendOnBookingConfirmed.
        const TRIGGERS = ['manual', 'booking_confirmed', 'before_checkin', 'after_checkin', 'before_checkout', 'after_checkout', 'checkin_day', 'checkout_day'];
        const safeTrigger = TRIGGERS.includes(sendTrigger) ? sendTrigger : (sendOnBookingConfirmed === true ? 'booking_confirmed' : 'manual');
        // Before / after check-in or check-out: minutes (1–720), hours
        // (1–72) or days (1–30), from the listing's check-in / check-out
        // time — in days, optionally at an exact time of day. On
        // confirmation: straight away, or after a delay in minutes or hours.
        // On check-in / check-out day: at an exact time (default 07:30).
        const timed = ['before_checkin', 'after_checkin', 'before_checkout', 'after_checkout'].includes(safeTrigger);
        const confirmDelay = safeTrigger === 'booking_confirmed' && Number(sendOffsetValue) > 0;
        const safeUnit = sendOffsetUnit === 'minutes' ? 'minutes' : sendOffsetUnit === 'hours' ? 'hours' : (confirmDelay ? 'minutes' : 'days');
        const rawValue = Math.floor(Number(sendOffsetValue !== undefined ? sendOffsetValue : sendOffsetDays)) || 1;
        const cap = { minutes: 720, hours: 72, days: 30 }[safeUnit];
        const safeValue = Math.max(1, Math.min(cap, rawValue));
        const perUnit = { minutes: 1, hours: 60, days: 1440 }[safeUnit];
        const safeMinutes = (timed || (confirmDelay && safeUnit !== 'days')) ? safeValue * perUnit : null;
        const safeOffset = timed && safeUnit === 'days' ? safeValue : 0; // legacy whole-day column
        const atOk = typeof sendAtTime === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(sendAtTime.trim());
        const safeAtTime = atOk && ((timed && safeUnit === 'days') || safeTrigger === 'checkin_day' || safeTrigger === 'checkout_day')
          ? sendAtTime.trim().padStart(5, '0') : null;

        if (listingId) {
          // listings.host_id is a hosts.id (see myHostId's comment up
          // top) — comparing it to guestId directly (as this used to)
          // meant this ownership check would reject a real host's own
          // listing almost every time, since guests.id and hosts.id are
          // different sequences that rarely coincide numerically.
          const ownedRows = myHostId != null ? await sql`SELECT id FROM listings WHERE id = ${listingId} AND host_id = ${myHostId}` : [];
          if (!ownedRows.length) return res.status(403).json({ error: 'Not your listing.' });
        }

        // Same ownership check, applied to every property this auto-send
        // is being scoped to — never trust a raw array of listing ids
        // from the browser without confirming they're actually this
        // host's own properties.
        const safeSendOnBooking = safeTrigger === 'booking_confirmed';
        let safeAutoSendListingIds = [];
        // A co-host's template keeps its listings even when sent by hand, so
        // it stays theirs (an empty list would mean every listing the host
        // has — see cohostOwnsTemplate).
        if ((safeTrigger !== 'manual' || actingCtx) && Array.isArray(autoSendListingIds) && autoSendListingIds.length) {
          const ids = autoSendListingIds.map(Number).filter(Number.isInteger);
          const ownedRows = myHostId != null && ids.length
            ? await sql`SELECT id FROM listings WHERE host_id = ${myHostId} AND id = ANY(${ids})`
            : [];
          safeAutoSendListingIds = ownedRows.map(r => r.id);
        }
        if (actingCtx) {
          safeAutoSendListingIds = safeAutoSendListingIds.filter(id => cohostHasListing(actingCtx, id));
          if (!safeAutoSendListingIds.length && !(listingId && cohostHasListing(actingCtx, listingId))) {
            return res.status(400).json({ error: 'Choose at least one of the listings you co-host for this template.' });
          }
        }
        // The exact time of day, kept apart so a save still works before the
        // database update adds the column.
        async function saveTemplateTime(id) {
          try { await sql`UPDATE message_templates SET send_at_time = ${safeAtTime} WHERE id = ${id}`; }
          catch (e) { if (e.code !== '42703') throw e; }
        }
        // The page never sends listingId: leaving it out keeps the listing
        // the template already has, rather than clearing it.
        const listingGiven = Object.prototype.hasOwnProperty.call(req.body || {}, 'listingId');

        if (templateId) {
          const updated = await sql`
            UPDATE message_templates SET body = ${safeBody}, title = ${safeTitle || null},
              listing_id = CASE WHEN ${listingGiven} THEN ${listingId || null}::int ELSE listing_id END,
              send_on_booking_confirmed = ${safeSendOnBooking},
              send_trigger = ${safeTrigger}, send_offset_days = ${safeOffset},
              send_offset_minutes = ${safeMinutes}, send_offset_unit = ${timed || safeMinutes ? safeUnit : null},
              auto_send_listing_ids = ${JSON.stringify(safeAutoSendListingIds)}
            WHERE id = ${templateId} AND host_id = ${guestId} RETURNING id
          `;
          if (!updated.length) return res.status(404).json({ error: 'Template not found.' });
          await saveTemplateTime(updated[0].id);
          return res.status(200).json({ id: updated[0].id });
        }
        const inserted = await sql`
          INSERT INTO message_templates (host_id, listing_id, title, body, send_on_booking_confirmed, send_trigger, send_offset_days, send_offset_minutes, send_offset_unit, auto_send_listing_ids)
          VALUES (${guestId}, ${listingId || null}, ${safeTitle || null}, ${safeBody}, ${safeSendOnBooking}, ${safeTrigger}, ${safeOffset}, ${safeMinutes}, ${timed || safeMinutes ? safeUnit : null}, ${JSON.stringify(safeAutoSendListingIds)})
          RETURNING id
        `;
        await saveTemplateTime(inserted[0].id);
        return res.status(200).json({ id: inserted[0].id });
      }

      if (mode === 'deleteTemplate') {
        const { templateId } = req.body || {};
        if (!templateId) return res.status(400).json({ error: 'Missing template.' });
        await sql`DELETE FROM message_templates WHERE id = ${templateId} AND host_id = ${guestId}`;
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Unknown mode.' });
    } catch (err) {
      console.error('guest-profile (POST/chat) error:', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }

  // ---- Update name and/or profile photo ----
  if (req.method === 'PATCH') {
    try {
      const { name, profilePhotoUrl, preferredCurrency } = req.body || {};

      // Only accept real Blob URLs for the photo, same defensive check
      // used for listing photos in submit-listing.js — never trust an
      // arbitrary URL string into this column.
      const safePhotoUrl = typeof profilePhotoUrl === 'string' && profilePhotoUrl.startsWith('https://')
        ? profilePhotoUrl
        : undefined;
      // An explicit null means "remove my photo", which COALESCE below
      // cannot express on its own — without this, clearing it silently
      // kept the old one. Only an explicit null counts: leaving the field
      // out still means "don't touch it".
      const clearPhoto = req.body && Object.prototype.hasOwnProperty.call(req.body, 'profilePhotoUrl') && profilePhotoUrl === null;
      const safeName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : undefined;
      // Whitelisted currency codes only — this is a display preference,
      // not something that should ever accept arbitrary input.
      // The same twelve the site header offers (aerva-header.js CURRENCIES).
      const SUPPORTED_CURRENCIES = ['INR', 'USD', 'GBP', 'EUR', 'AUD', 'CAD', 'SGD', 'AED', 'JPY', 'KRW', 'CHF', 'RUB'];
      const safeCurrency = typeof preferredCurrency === 'string' && SUPPORTED_CURRENCIES.includes(preferredCurrency.toUpperCase())
        ? preferredCurrency.toUpperCase()
        : undefined;

      if (safeName === undefined && safePhotoUrl === undefined && safeCurrency === undefined && !clearPhoto) {
        return res.status(400).json({ error: 'Nothing to update.' });
      }

      const updated = await sql`
        UPDATE guests SET
          name = COALESCE(${safeName ?? null}, name),
          profile_photo_url = CASE WHEN ${clearPhoto} THEN NULL
                                   ELSE COALESCE(${safePhotoUrl ?? null}, profile_photo_url) END,
          preferred_currency = COALESCE(${safeCurrency ?? null}, preferred_currency)
        WHERE id = ${guestId}
        RETURNING id, name, profile_photo_url, preferred_currency
      `;
      // A photo already found to show contact details is taken out,
      // silently (_photo-guard.js).
      if (safePhotoUrl) await photoGuard.sweepGuest(sql, guestId);

      await logAudit(sql, {
        action: 'guest_profile_updated', success: true, actorType: 'guest', actorIdentifier: String(guestId),
        targetType: 'guest', targetId: guestId,
        metadata: { updatedName: safeName !== undefined, updatedPhoto: safePhotoUrl !== undefined, updatedCurrency: safeCurrency !== undefined }
      });

      return res.status(200).json({ success: true, guest: updated[0] });
    } catch (err) {
      console.error('guest-profile (PATCH) error:', err);
      await logAudit(sql, {
        action: 'guest_profile_updated', success: false, actorType: 'guest', actorIdentifier: String(guestId),
        metadata: { reason: 'server_error' }
      });
      return res.status(500).json({ error: 'Could not save your changes right now.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
