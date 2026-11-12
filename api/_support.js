// /api/_support.js — the Resolution Center's requests. Not an endpoint.
//
// A guest or host raises a request (a "ticket") from the Resolution Center
// (index.html?view=help). It gets a reference number (SR-12345678), an
// emailed acknowledgement straight away, and a page where they follow it
// and reply. Aerva's support team answers from Admin → Support, where they
// can also leave internal notes the person never sees.
//
// Who calls this:
//   guest-profile.js  — the person's own requests (signed in only)
//   get-pending-listings.js — the support team (admin session)
//   guest-auth.js     — the header bell: requests with a reply not yet seen
//   _accounts.js      — deleting an account erases what the person wrote
//   guest-auth.js     — "Can't sign in?": a request raised WITHOUT an account
//                       (createSignedOutRequest; channel 'signed_out'), and
//                       following it with its private link (signedOutView,
//                       signedOutReplyTo, signedOutNewLink)
//
// Tables: sql/migration_support.sql. Before it runs, raising a request
// answers 503 "not open yet"; nothing else on the site is affected.

const crypto = require('crypto');
const { normalizeToE164 } = require('./_phone-validation');
const { logAudit } = require('./_audit-log');
const { countRecentAttempts } = require('./_rate-limit');

const SITE = 'https://aerva.in';
const SUPPORT_INBOX = () => process.env.SUPPORT_EMAIL || process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in';
const MAX_NEW_PER_DAY = 5;           // requests per account per 24 hours
const MAX_REPLIES_PER_HOUR = 30;
const MAX_FILES = 5;
const SUBJECT_MIN = 4, SUBJECT_MAX = 120;
const BODY_MIN = 20, BODY_MAX = 4000;
const REPLY_MAX = 4000;
const FIRST_RESPONSE_HOURS = 48;     // acknowledged on creation; a person answers within this

// What a request can be about. Kept in step by hand with
// AERVA_POLICIES.support.categories in aerva-policies.js (the form's list).
// audience: who the form offers it to — 'guest', 'host' or 'both'.
// booking / listing: 'required' | 'optional' | 'none' — what the request
// must, may or may not be linked to. bookingAs: whose booking it may be —
// 'guest' (one of their trips), 'host' (a booking at their listing) or 'any'.
// A request is linked to a booking OR a listing, never both: a booking
// already names its listing. The form (aerva-help.js) applies the same rules.
const CATEGORIES = {
  booking_payment:       { label: 'Booking or payment', audience: 'guest', booking: 'optional', bookingAs: 'guest', listing: 'none' },
  cancellation_refund:   { label: 'Cancellation or refund', audience: 'guest', booking: 'required', bookingAs: 'any', listing: 'none' },
  change_booking:        { label: 'Changing a booking', audience: 'guest', booking: 'required', bookingAs: 'guest', listing: 'none' },
  stay_problem:          { label: 'Problem during a stay or experience', audience: 'guest', booking: 'required', bookingAs: 'guest', listing: 'none' },
  deposit_damage:        { label: 'Security deposit', audience: 'guest', booking: 'required', bookingAs: 'guest', listing: 'none' },
  coupon:                { label: 'Coupon', audience: 'guest', booking: 'optional', bookingAs: 'guest', listing: 'none' },
  host_conduct:          { label: 'A host’s behaviour', audience: 'guest', booking: 'optional', bookingAs: 'guest', listing: 'none' },
  payout_tds:            { label: 'Payouts and TDS', audience: 'host', booking: 'optional', bookingAs: 'host', listing: 'none' },
  listing_photos:        { label: 'Listing, photos or approval', audience: 'host', booking: 'none', bookingAs: 'any', listing: 'required' },
  calendar_availability: { label: 'Calendar and availability', audience: 'host', booking: 'none', bookingAs: 'any', listing: 'required' },
  damage_claim:          { label: 'Damage claim', audience: 'host', booking: 'required', bookingAs: 'host', listing: 'none' },
  guest_conduct:         { label: 'A guest’s behaviour', audience: 'host', booking: 'required', bookingAs: 'host', listing: 'none' },
  cohosting:             { label: 'Co-hosting', audience: 'host', booking: 'none', bookingAs: 'any', listing: 'optional' },
  verification:          { label: 'PAN, bank or Aadhaar verification', audience: 'host', booking: 'none', bookingAs: 'any', listing: 'none' },
  safety:                { label: 'Safety concern', audience: 'both', booking: 'optional', bookingAs: 'any', listing: 'optional' },
  off_platform:          { label: 'Asked to pay or talk outside Aerva', audience: 'both', booking: 'optional', bookingAs: 'any', listing: 'none' },
  account_signin:        { label: 'Account and sign-in', audience: 'both', booking: 'none', bookingAs: 'any', listing: 'none' },
  reviews_badges:        { label: 'Reviews and badges', audience: 'both', booking: 'optional', bookingAs: 'any', listing: 'optional' },
  report_content:        { label: 'Report a listing, review or message', audience: 'both', booking: 'optional', bookingAs: 'any', listing: 'none' },
  privacy_data:          { label: 'My personal data', audience: 'both', booking: 'none', bookingAs: 'any', listing: 'none' },
  grievance:             { label: 'Formal grievance (Grievance Officer)', audience: 'both', booking: 'optional', bookingAs: 'any', listing: 'optional' },
  other:                 { label: 'Something else', audience: 'both', booking: 'optional', bookingAs: 'any', listing: 'optional' },
  // "Can't sign in?" only (raised signed out; never offered on the signed-in form).
  account_access:        { label: 'Account access', audience: 'signed_out', booking: 'none', bookingAs: 'any', listing: 'none' }
};
const HOST_CATEGORIES = Object.keys(CATEGORIES).filter(k => CATEGORIES[k].audience === 'host');

// What the person sees for each status.
const STATUS_LABELS = {
  open: 'Received',
  in_progress: 'Being looked at',
  waiting_on_you: 'Waiting for your reply',
  resolved: 'Resolved',
  closed: 'Closed'
};
const STATUSES = Object.keys(STATUS_LABELS);
// How someone behaved while the request was handled (the support team's record).
const CONDUCT = { cooperative: 'Cooperative', neutral: 'Neutral', difficult: 'Difficult', abusive: 'Abusive or threatening', not_involved: 'Not involved' };
const FEEDBACK_HOURS = 48;          // a resolved request closes by itself after this, with no feedback

const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (v) => { if (!v) return ''; const d = new Date(String(v instanceof Date ? v.toISOString() : v).slice(0, 10) + 'T00:00:00Z');
  return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };
const clean = (t, max) => (typeof t === 'string' ? t.replace(/\r/g, '').trim() : '').slice(0, max);
// Missing tables or columns (before migration_support.sql).
const notReady = (err) => !!err && (err.code === '42P01' || err.code === '42703');
const NOT_READY = () => userError('Raising a request online is not open yet. Please try again shortly.', 503);

// Files: Aerva's own storage only, at most MAX_FILES.
function cleanFiles(list) {
  return (Array.isArray(list) ? list : []).map(u => String(u || '').trim())
    .filter(u => /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/[^\s"'<>`\\]+$/i.test(u) && u.length <= 600)
    .slice(0, MAX_FILES);
}

// SR- and eight digits, never issued twice (unique column; a clash redraws).
function randomRef() {
  let out = '';
  while (out.length < 8) { const b = crypto.randomBytes(1)[0]; if (b < 250) out += String(b % 10); }
  return 'SR-' + out;
}

async function sendEmail(to, subject, html, replyTo = null) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const body = { from: 'Aerva Support <hello@aerva.in>', to, subject, html: `<div style="font-family:sans-serif; max-width:520px; color:#1c1a17;">${html}</div>` };
    if (replyTo) body.reply_to = replyTo;
    const r = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) console.error('support email refused:', r.status);
    return r.ok;
  } catch (err) { console.error('support email failed:', err.message); return false; }
}
// One wording for the reference line, the closing step and the names of
// the three kinds of money (api/_say.js, owner 12 Nov 2026).
const SAY = require('./_say');
// A request about a booking carries that booking's code too, so nobody is
// asked for it twice. Never throws: no code, no line.
async function bookingCode(sql, orderId) {
  try {
    const r = (await sql`SELECT to_jsonb(orders)->>'confirmation_code' AS code FROM orders WHERE id = ${Number(orderId) || 0}`)[0];
    return (r && r.code) || null;
  } catch (e) { return null; }
}
const requestLink = (ref) => `${SITE}/index.html?view=help&request=${encodeURIComponent(ref)}`;
const button = (href, label) => `<p style="margin:20px 0;"><a href="${href}" style="background:#1c1a17; color:#f4eadc; padding:12px 22px; text-decoration:none; display:inline-block;">${esc(label)}</a></p>`;

// ---------------------------------------------------------------- the person's side

// What the form can link a request to: the person's own bookings, bookings
// on their listings (as host), and their listings.
async function requestOptions(sql, guestId) {
  const me = (await sql`SELECT id, host_id, phone, email FROM guests WHERE id = ${guestId}`)[0];
  if (!me) throw userError('Please log in again.', 401);
  const asGuest = await sql`
    SELECT o.id, o.suite_name, o.arrival, o.departure, o.status, o.confirmation_code
    FROM orders o WHERE o.guest_id = ${guestId}
    ORDER BY o.arrival DESC, o.id DESC LIMIT 25`;
  let asHost = [], listings = [];
  if (me.host_id) {
    asHost = await sql`
      SELECT o.id, o.suite_name, o.arrival, o.departure, o.status, o.confirmation_code
      FROM orders o JOIN listings l ON l.id = o.listing_id
      WHERE l.host_id = ${me.host_id}
      ORDER BY o.arrival DESC, o.id DESC LIMIT 25`;
    listings = await sql`SELECT id, property_name, status FROM listings WHERE host_id = ${me.host_id} AND status <> 'removed' ORDER BY id DESC LIMIT 50`;
  }
  const b = (o) => ({ id: o.id, name: o.suite_name, arrival: o.arrival, departure: o.departure, status: o.status, code: o.confirmation_code || null });
  return {
    isHost: !!me.host_id, hasPhone: !!(me.phone && String(me.phone).trim()), phone: me.phone ? String(me.phone).trim() : null, email: me.email || null,
    bookings: asGuest.map(b), hostBookings: asHost.map(b),
    listings: listings.map(l => ({ id: l.id, name: l.property_name, status: l.status }))
  };
}

// Is this booking the person's (as guest, or on their listing)? → 'guest' | 'host' | null
async function bookingRole(sql, me, orderId) {
  const o = (await sql`SELECT o.guest_id, l.host_id FROM orders o LEFT JOIN listings l ON l.id = o.listing_id WHERE o.id = ${orderId}`)[0];
  if (!o) return null;
  if (Number(o.guest_id) === Number(me.id)) return 'guest';
  if (me.host_id && Number(o.host_id) === Number(me.host_id)) return 'host';
  return null;
}

// raisedBy: { email, name } when Aerva's support team raises the request on
// the customer's behalf (Admin → Lookup), e.g. after a phone call. It is
// the customer's request in every way (their reference number, their
// emails), and says who raised it.
async function createRequest(sql, { guestId, category, subject, description, orderId, listingId, attachments, callback, callbackPhone: askedPhone, ip, raisedBy = null }) {
  if (!CATEGORIES[category]) throw userError('Choose what your request is about.');
  const subj = clean(subject, SUBJECT_MAX);
  const text = clean(description, BODY_MAX);
  if (subj.length < SUBJECT_MIN) throw userError('Please give your request a short title.');
  if (text.length < BODY_MIN) throw userError('Please describe what happened in a few sentences, so we can help the first time.');
  const me = (await sql`SELECT id, name, email, phone, host_id, deleted_at FROM guests WHERE id = ${guestId}`)[0];
  if (!me || me.deleted_at) throw userError('Please log in again.', 401);

  let role = HOST_CATEGORIES.includes(category) ? 'host' : 'guest';
  let oid = null, lid = null;
  const rule = CATEGORIES[category];
  if (orderId && rule.booking === 'none') orderId = null;           // not about a booking: ignored
  if (listingId && (rule.listing === 'none' || orderId)) listingId = null;   // a booking already names its listing
  if (rule.booking === 'required' && !orderId) throw userError('Choose the booking this is about.');
  if (rule.listing === 'required' && !listingId) throw userError('Choose the listing this is about.');
  if (orderId) {
    const r = await bookingRole(sql, me, Number(orderId));
    if (!r) throw userError('That booking could not be found on your account.', 404);
    if (rule.bookingAs === 'guest' && r !== 'guest') throw userError('Choose one of your own trips for this.');
    if (rule.bookingAs === 'host' && r !== 'host') throw userError('Choose a booking at one of your listings for this.');
    oid = Number(orderId); role = r;
  }
  if (listingId) {
    const l = (await sql`SELECT id, host_id FROM listings WHERE id = ${Number(listingId)}`)[0];
    // Only the person's own listings can be chosen (the form offers no others).
    if (!l || !me.host_id || Number(l.host_id) !== Number(me.host_id)) throw userError('That listing could not be found on your account.', 404);
    lid = l.id; role = 'host';
  }
  if (role === 'host' && !me.host_id) role = 'guest';
  const files = cleanFiles(attachments);
  // A call back: on the number the person gives here (checked, in +country
  // form), or the one on their account. Asking for one without any number is refused.
  let callbackPhone = null;
  if (callback === true) {
    const typed = typeof askedPhone === 'string' ? askedPhone.trim() : '';
    if (typed) {
      callbackPhone = normalizeToE164(typed);
      if (!callbackPhone) throw userError('Enter a valid phone number for the call back, with the country code if it is not an Indian number.');
    } else if (me.phone) callbackPhone = String(me.phone).trim();
    else throw userError('Enter the phone number we should call you on.');
  }

  const recent = raisedBy ? 0 : await countRecentAttempts(sql, { action: 'support_request_created', windowMinutes: 24 * 60, byActor: String(guestId) });
  if (recent >= MAX_NEW_PER_DAY) throw userError('You have raised several requests today. Please add to an open one under My requests.', 429);

  let ticket;
  try {
    for (let i = 0; i < 20 && !ticket; i++) {
      ticket = (await sql`
        INSERT INTO support_tickets (ref, guest_id, role, category, subject, order_id, listing_id, callback_phone, last_user_message_at)
        VALUES (${randomRef()}, ${guestId}, ${role}, ${category}, ${subj}, ${oid}, ${lid}, ${callbackPhone}, now())
        ON CONFLICT (ref) DO NOTHING RETURNING *`)[0];
    }
    if (!ticket) throw new Error('could not draw a free reference number');
    // The timeline starts with the request being raised.
    await sql`INSERT INTO support_messages (ticket_id, sender, body, created_at) VALUES (${ticket.id}, 'system',
                ${`Request raised${raisedBy ? ' by Aerva Support (' + (raisedBy.name || raisedBy.email) + ') on the customer’s behalf' : ''}: ${CATEGORIES[category].label}. Reference ${ticket.ref}.${callbackPhone ? ` Call back asked for on ${callbackPhone}.` : ''}`}, now() - interval '1 millisecond')`;
    await sql`INSERT INTO support_messages (ticket_id, sender, body, attachments) VALUES (${ticket.id}, 'user', ${text}, ${JSON.stringify(files)}::jsonb)`;
  } catch (err) {
    if (notReady(err)) throw NOT_READY();
    throw err;
  }
  await logAudit(sql, { action: 'support_request_created', success: true, actorType: raisedBy ? 'admin' : 'guest', actorIdentifier: raisedBy ? String(raisedBy.email) : String(guestId),
    targetType: 'support_ticket', targetId: ticket.id, metadata: { ref: ticket.ref, category, role, orderId: oid, listingId: lid, files: files.length, ip: ip || null, onBehalfOf: raisedBy ? Number(guestId) : undefined } });

  // The acknowledgement, with the reference number (what the E-Commerce
  // Rules ask for), and a heads-up to the support inbox.
  await sendEmail(me.email, `We have received your request ${ticket.ref}`,
    `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">We have received your request</h2>
     ${SAY.refBlock({ code: oid ? await bookingCode(sql, oid) : null, ref: ticket.ref })}
     <p>Hi ${esc(String(me.name || '').split(' ')[0] || 'there')}, ${raisedBy ? 'as discussed with our support team, we have raised this request for you' : 'thank you for writing to Aerva'}. Your reference number is <strong>${esc(ticket.ref)}</strong>.</p>
     <p><strong>${esc(subj)}</strong><br><span style="color:#6e675d;">${esc(CATEGORIES[category].label)}</span></p>
     <p>A member of our support team will ${callbackPhone ? `call you on <strong>${esc(callbackPhone)}</strong> and ` : ''}reply within ${FIRST_RESPONSE_HOURS} hours, usually much sooner. You can follow your request and add to it at any time:</p>
     ${button(requestLink(ticket.ref), 'View your request')}
     ${SAY.nextStep(SAY.steps.weAnswerBy(`${FIRST_RESPONSE_HOURS} hours from now`))}
     <p style="font-size:13px; color:#6e675d;">If anyone is in danger, call 112 first.</p>`);
  await sendEmail(SUPPORT_INBOX(), `New request ${ticket.ref}: ${CATEGORIES[category].label}`,
    `<p><strong>${esc(subj)}</strong> · ${esc(CATEGORIES[category].label)} · as ${esc(role)}</p>
     <p>${raisedBy ? 'Raised by ' + esc(raisedBy.name || raisedBy.email) + ' for ' : 'From '}${esc(me.name || '')} (${esc(me.email || 'no email')}${callbackPhone ? ', asks for a call back on ' + esc(callbackPhone) : ''})${oid ? ' · booking #' + oid : ''}${lid ? ' · listing #' + lid : ''}</p>
     <blockquote style="margin:12px 0; padding:10px 14px; background:#f6f1ea; border-left:3px solid #a9884f; white-space:pre-wrap;">${esc(text)}</blockquote>
     ${files.length ? `<p>${files.length} file${files.length === 1 ? '' : 's'} attached.</p>` : ''}
     <p>Answer it in Admin → Support.</p>`, me.email || null);
  return { ref: ticket.ref, status: ticket.status };
}

// A request raised from the Aerva Support chat in Messages, when the
// assistant hands the conversation to a person (_support-chat.js). The
// whole conversation so far comes with it (via 'chat-transcript'), so the
// team never asks the person to repeat themselves. A booking is linked only
// if it is the person's own (as guest, or at their listing as host).
async function createChatRequest(sql, { guestId, category, subject, transcript, orderId = null, callbackPhone = null }) {
  if (!CATEGORIES[category]) category = 'other';
  const me = (await sql`SELECT id, name, email, host_id, deleted_at FROM guests WHERE id = ${guestId}`)[0];
  if (!me || me.deleted_at) throw userError('Please log in again.', 401);
  const recent = await countRecentAttempts(sql, { action: 'support_request_created', windowMinutes: 24 * 60, byActor: String(guestId) });
  if (recent >= MAX_NEW_PER_DAY) throw userError('You have raised several requests today. Please keep writing here on the open one.', 429);
  let oid = null, role = HOST_CATEGORIES.includes(category) && me.host_id ? 'host' : 'guest';
  if (orderId) { const r = await bookingRole(sql, me, Number(orderId)); if (r) { oid = Number(orderId); role = r; } }
  let subj = clean(subject, 80);
  if (subj.length < SUBJECT_MIN) subj = CATEGORIES[category].label;
  const text = clean(transcript, BODY_MAX) || '(no messages)';
  let ticket;
  for (let i = 0; i < 20 && !ticket; i++) {
    ticket = (await sql`
      INSERT INTO support_tickets (ref, guest_id, role, category, subject, order_id, callback_phone, last_user_message_at, channel)
      VALUES (${randomRef()}, ${me.id}, ${role}, ${category}, ${subj}, ${oid}, ${callbackPhone}, now(), 'chat')
      ON CONFLICT (ref) DO NOTHING RETURNING *`)[0];
  }
  if (!ticket) throw new Error('could not draw a free reference number');
  await sql`INSERT INTO support_messages (ticket_id, sender, body, created_at, via) VALUES (${ticket.id}, 'system',
              ${`Request raised from the Aerva Support chat: ${CATEGORIES[category].label}. Reference ${ticket.ref}.${callbackPhone ? ` Call back asked for on ${callbackPhone}.` : ''}`}, now() - interval '1 millisecond', 'chat')`;
  await sql`INSERT INTO support_messages (ticket_id, sender, body, via) VALUES (${ticket.id}, 'user', ${text}, 'chat-transcript')`;
  await logAudit(sql, { action: 'support_request_created', success: true, actorType: 'guest', actorIdentifier: String(guestId),
    targetType: 'support_ticket', targetId: ticket.id, metadata: { ref: ticket.ref, category, role, orderId: oid, via: 'chat' } });
  await sendEmail(SUPPORT_INBOX(), `${callbackPhone ? 'CALL BACK — ' : ''}New chat request ${ticket.ref}: ${CATEGORIES[category].label}`,
    `<p><strong>${esc(subj)}</strong> · ${esc(CATEGORIES[category].label)} · from ${esc(me.name || '')} (${esc(me.email || 'no email')})${oid ? ' · booking #' + oid : ''}</p>
     ${callbackPhone ? `<p style="font-size:16px;"><strong>Call them back on ${esc(callbackPhone)}</strong></p>` : ''}
     <p>The assistant handed this conversation over:</p>
     <blockquote style="margin:12px 0; padding:10px 14px; background:#f6f1ea; border-left:3px solid #a9884f; white-space:pre-wrap;">${esc(text)}</blockquote>
     <p>Answer it in Admin → Support — your reply appears in their Aerva Support chat in Messages.</p>`);
  return ticket;
}

function ticketView(t) {
  return {
    ref: t.ref, category: t.category, categoryLabel: (CATEGORIES[t.category] || {}).label || 'Request',
    subject: t.subject, status: t.status, statusLabel: STATUS_LABELS[t.status] || t.status, role: t.role,
    orderId: t.order_id, listingId: t.listing_id, bookingName: t.suite_name || null, bookingCode: t.confirmation_code || null, listingName: t.property_name || null,
    createdAt: t.created_at, updatedAt: t.updated_at, callbackPhone: t.callback_phone || null,
    unread: !!(t.last_support_message_at && (!t.user_last_seen_at || new Date(t.last_support_message_at) > new Date(t.user_last_seen_at)))
  };
}

async function listRequests(sql, guestId) {
  try {
    const rows = await sql`
      SELECT t.*, o.suite_name, o.confirmation_code, l.property_name FROM support_tickets t
      LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN listings l ON l.id = t.listing_id
      WHERE t.guest_id = ${guestId} AND COALESCE(to_jsonb(t)->>'channel', 'web') <> 'signed_out' ORDER BY t.updated_at DESC LIMIT 100`;
    return rows.map(ticketView);
  } catch (err) { if (notReady(err)) return []; throw err; }
}

async function ownTicket(sql, guestId, ref) {
  let t;
  try {
    t = (await sql`
      SELECT t.*, o.suite_name, o.confirmation_code, l.property_name FROM support_tickets t
      LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN listings l ON l.id = t.listing_id
      WHERE t.ref = ${String(ref || '').trim().toUpperCase()} AND t.guest_id = ${guestId}
        AND COALESCE(to_jsonb(t)->>'channel', 'web') <> 'signed_out'`)[0];
  } catch (err) { if (notReady(err)) throw NOT_READY(); throw err; }
  if (!t) throw userError('That request could not be found on your account.', 404);
  return t;
}

// The request and its conversation (never the support team's internal notes).
// Opening it marks the replies as seen.
async function getRequest(sql, guestId, ref) {
  const t = await ownTicket(sql, guestId, ref);
  const msgs = await sql`SELECT id, sender, body, attachments, created_at FROM support_messages
                         WHERE ticket_id = ${t.id} AND internal = false ORDER BY created_at, id`;
  await sql`UPDATE support_tickets SET user_last_seen_at = now() WHERE id = ${t.id}`;
  const hostCancel = await require('./_host-cancel-confirm').forTicket(sql, t.id, guestId);
  return {
    ...ticketView(t), unread: false, hostCancel,
    canReply: t.status !== 'closed', canClose: !['closed'].includes(t.status),
    // Resolved: the person is asked whether it is, and for a rating, before it closes.
    askFeedback: t.status === 'resolved',
    autoCloseAt: t.status === 'resolved' && t.resolved_at ? new Date(new Date(t.resolved_at).getTime() + FEEDBACK_HOURS * 3600e3).toISOString() : null,
    // When Aerva's first answer is promised by — the status strip says it,
    // so nobody has to count 48 hours themselves (owner, 12 Nov 2026).
    firstReplyBy: t.first_response_at ? null : new Date(new Date(t.created_at).getTime() + FIRST_RESPONSE_HOURS * 3600e3).toISOString(),
    feedback: t.feedback_at ? { rating: t.feedback_rating, comment: t.feedback_comment, resolved: t.feedback_resolved, at: t.feedback_at } : null,
    autoClosed: t.auto_closed === true,
    messages: msgs.map(m => ({ id: m.id, from: m.sender === 'user' ? 'you' : m.sender === 'support' ? 'Aerva Support' : 'Aerva',
                               body: m.body, files: Array.isArray(m.attachments) ? m.attachments : [], at: m.created_at }))
  };
}

async function replyToRequest(sql, { guestId, ref, text, attachments }) {
  const t = await ownTicket(sql, guestId, ref);
  if (t.status === 'closed') throw userError('This request is closed. Please raise a new one and mention ' + t.ref + '.', 409);
  const body = clean(text, REPLY_MAX);
  const files = cleanFiles(attachments);
  if (!body && !files.length) throw userError('Write your reply first.');
  const recent = await countRecentAttempts(sql, { action: 'support_request_reply', windowMinutes: 60, byActor: String(guestId) });
  if (recent >= MAX_REPLIES_PER_HOUR) throw userError('Too many replies in a short time. Please wait a little and try again.', 429);
  await appendUserMessage(sql, t, { body, files, actor: String(guestId) });
  return getRequest(sql, guestId, t.ref);
}

// The person adds to their request (web, or the Support chat with via = 'chat').
// It opens again for the team if it was waiting on them or resolved.
async function appendUserMessage(sql, t, { body, files = [], actor, via = null, notify = true, auditAction = 'support_request_reply', auditExtra = {} }) {
  const row = via
    ? (await sql`INSERT INTO support_messages (ticket_id, sender, body, attachments, via) VALUES (${t.id}, 'user', ${body || '(files attached)'}, ${JSON.stringify(files)}::jsonb, ${via}) RETURNING id`)[0]
    : (await sql`INSERT INTO support_messages (ticket_id, sender, body, attachments) VALUES (${t.id}, 'user', ${body || '(files attached)'}, ${JSON.stringify(files)}::jsonb) RETURNING id`)[0];
  await sql`UPDATE support_tickets SET last_user_message_at = now(), updated_at = now(), user_last_seen_at = now(),
              status = CASE WHEN status IN ('waiting_on_you', 'resolved') THEN 'open' ELSE status END,
              resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END
            WHERE id = ${t.id}`;
  await logAudit(sql, { action: auditAction, success: true, actorType: 'guest', actorIdentifier: String(actor || ''),
    targetType: 'support_ticket', targetId: t.id, metadata: { ref: t.ref, files: files.length, via: via || (t.channel === 'signed_out' ? 'private_link' : 'web'), ...auditExtra } });
  if (notify) await sendEmail(SUPPORT_INBOX(), `Reply on ${t.ref}: ${t.subject}`,
    `<p>The person replied${via === 'chat' ? ' in the Support chat' : ''} on <strong>${esc(t.ref)}</strong> (${esc(t.subject)}):</p>
     <blockquote style="margin:12px 0; padding:10px 14px; background:#f6f1ea; border-left:3px solid #a9884f; white-space:pre-wrap;">${esc(body)}</blockquote>
     ${files.length ? `<p>${files.length} file${files.length === 1 ? '' : 's'} attached.</p>` : ''}<p>Answer it in Admin → Support.</p>`);
  return row;
}

// The person's feedback, and with it the end of the request.
//   resolved true:  closes it, with their rating (1–5) and any comment —
//                   asked when Aerva marks it resolved, and whenever they
//                   close it themselves.
//   resolved false: it is not sorted: opens again, with their comment as a
//                   message to the support team.
async function submitFeedback(sql, { guestId, ref, resolved, rating, comment }) {
  const t = await ownTicket(sql, guestId, ref);
  await applyFeedback(sql, t, { resolved, rating, comment, actor: String(guestId) });
  return getRequest(sql, guestId, t.ref);
}

// The feedback itself, for a ticket row (web or the Support chat). via: how it came in.
async function applyFeedback(sql, t, { resolved, rating, comment, actor, via = null }) {
  if (t.status === 'closed') throw userError('This request is already closed.', 409);
  const note = clean(comment, 1000);
  if (resolved === false) {
    if (note.length < 5) throw userError('Tell us what is still not right, so we can pick it up again.');
    if (via) await sql`INSERT INTO support_messages (ticket_id, sender, body, via) VALUES (${t.id}, 'user', ${note}, ${via})`;
    else await sql`INSERT INTO support_messages (ticket_id, sender, body) VALUES (${t.id}, 'user', ${note})`;
    try {
      await sql`UPDATE support_tickets SET status = 'open', resolved_at = NULL, updated_at = now(), last_user_message_at = now(), user_last_seen_at = now(),
                  feedback_resolved = false, feedback_rating = NULL, feedback_comment = ${note}, feedback_at = now()
                WHERE id = ${t.id}`;
    } catch (err) {
      if (!notReady(err)) throw err;      // before migration_support_cases.sql: reopened without the feedback columns
      await sql`UPDATE support_tickets SET status = 'open', resolved_at = NULL, updated_at = now(), last_user_message_at = now(), user_last_seen_at = now() WHERE id = ${t.id}`;
    }
    await sql`INSERT INTO support_messages (ticket_id, sender, body) VALUES (${t.id}, 'system', 'You said this is not resolved. It is open again.')`;
    await logAudit(sql, { action: 'support_feedback', success: true, actorType: 'guest', actorIdentifier: String(actor || ''),
      targetType: 'support_ticket', targetId: t.id, metadata: { ref: t.ref, resolved: false, via: via || 'web' } });
    await sendEmail(SUPPORT_INBOX(), `Reopened ${t.ref}: not resolved`, `<p>The person says <strong>${esc(t.ref)}</strong> (${esc(t.subject)}) is not resolved:</p>
      <blockquote style="margin:12px 0; padding:10px 14px; background:#f6f1ea; border-left:3px solid #a9884f; white-space:pre-wrap;">${esc(note)}</blockquote><p>It is open again in Admin → Support.</p>`);
    return { reopened: true };
  }
  const stars = Math.round(Number(rating));
  if (!(stars >= 1 && stars <= 5)) throw userError('Choose a rating from 1 to 5 stars first.');
  try {
    await sql`UPDATE support_tickets SET status = 'closed', closed_at = now(), updated_at = now(),
                feedback_resolved = true, feedback_rating = ${stars}, feedback_comment = ${note || null}, feedback_at = now()
              WHERE id = ${t.id} AND status <> 'closed'`;
  } catch (err) {
    if (!notReady(err)) throw err;        // before migration_support_cases.sql: closed, rating kept in the message below
    await sql`UPDATE support_tickets SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = ${t.id} AND status <> 'closed'`;
  }
  await sql`INSERT INTO support_messages (ticket_id, sender, body) VALUES (${t.id}, 'system', ${`You confirmed this is resolved and closed it. Your rating: ${stars} of 5.${note ? ' Comment: ' + note : ''}`})`;
  await logAudit(sql, { action: 'support_feedback', success: true, actorType: 'guest', actorIdentifier: String(actor || ''),
    targetType: 'support_ticket', targetId: t.id, metadata: { ref: t.ref, resolved: true, rating: stars, via: via || 'web' } });
  return { closed: true, rating: stars };
}
// Closing it themselves: the same feedback is asked for.
const closeRequest = (sql, { guestId, ref, rating, comment }) => submitFeedback(sql, { guestId, ref, resolved: true, rating, comment });

// Resolved requests nobody answered: closed 48 hours after being resolved,
// with no feedback. Run by the scheduler.
async function autoCloseResolved(sql, { limit = 100 } = {}) {
  let rows;
  try {
    rows = await sql`UPDATE support_tickets SET status = 'closed', closed_at = now(), updated_at = now(), auto_closed = true
                     WHERE id IN (SELECT id FROM support_tickets WHERE status = 'resolved'
                                    AND resolved_at < now() - make_interval(hours => ${FEEDBACK_HOURS}) ORDER BY resolved_at LIMIT ${limit})
                       AND status = 'resolved'
                     RETURNING id, ref, subject, guest_id, to_jsonb(support_tickets)->>'channel' AS channel,
                               COALESCE(to_jsonb(support_tickets)->>'contact_email', to_jsonb(support_tickets)->>'account_email') AS contact_email`;
  } catch (err) { if (notReady(err)) return { closed: 0 }; throw err; }
  for (const t of rows) {
    await sql`INSERT INTO support_messages (ticket_id, sender, body) VALUES (${t.id}, 'system', ${`Closed automatically ${FEEDBACK_HOURS} hours after it was resolved, with no feedback.`})`;
    await logAudit(sql, { action: 'support_auto_closed', success: true, actorType: 'system', actorIdentifier: 'support',
      targetType: 'support_ticket', targetId: t.id, metadata: { ref: t.ref } });
    // Raised without signing in: only ever the address the person gave (never the account's).
    if (t.channel === 'signed_out') {
      await signedOutNotice(sql, t, { closed: true, auto: true });
      continue;
    }
    const g = t.guest_id ? (await sql`SELECT email FROM guests WHERE id = ${t.guest_id}`)[0] : null;
    if (g && g.email) await sendEmail(g.email, `Your request ${t.ref} is closed`,
      `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">Your request is closed</h2>
       <p><strong>${esc(t.subject)}</strong> · ${esc(t.ref)}</p>
       <p>We marked it resolved ${FEEDBACK_HOURS} hours ago and did not hear back, so it is now closed. If you still need help, raise a new request and mention ${esc(t.ref)}.</p>
       ${button(requestLink(t.ref), 'View your request')}`);
  }
  return { closed: rows.length, refs: rows.map(r => r.ref) };
}

// The header bell: requests with a reply the person has not opened yet.
async function bellNotifications(sql, guestId) {
  try {
    const rows = await sql`SELECT ref, subject, last_support_message_at FROM support_tickets t
                           WHERE guest_id = ${guestId} AND last_support_message_at IS NOT NULL
                             AND COALESCE(to_jsonb(t)->>'channel', 'web') <> 'signed_out'
                             AND (user_last_seen_at IS NULL OR last_support_message_at > user_last_seen_at)
                           ORDER BY last_support_message_at DESC LIMIT 5`;
    const out = rows.map(r => ({
      id: 'support:' + r.ref + ':' + new Date(r.last_support_message_at).getTime(), kind: 'support',
      title: `Aerva Support replied: ${r.ref}`, body: r.subject,
      href: `index.html?view=help&request=${encodeURIComponent(r.ref)}`
    }));
    // Resolved and waiting for the person's word (closes by itself after 48 hours).
    const res = await sql`SELECT ref, subject, resolved_at FROM support_tickets t WHERE guest_id = ${guestId} AND status = 'resolved'
                          AND COALESCE(to_jsonb(t)->>'channel', 'web') <> 'signed_out' ORDER BY resolved_at DESC LIMIT 5`;
    res.forEach(r => {
      if (out.some(o => o.href.endsWith(encodeURIComponent(r.ref)))) return;
      out.push({ id: 'support-feedback:' + r.ref + ':' + new Date(r.resolved_at).getTime(), kind: 'action',
        title: `Is ${r.ref} resolved? Tell us`, body: `${r.subject} — rate how we did. It closes by itself 48 hours after it was resolved.`,
        href: `index.html?view=help&request=${encodeURIComponent(r.ref)}` });
    });
    return out;
  } catch (err) { return []; }
}

// ---------------------------------------------------------------- the support team's side

async function adminList(sql, { status = 'active', q = '' } = {}) {
  const want = status === 'all' ? null : status === 'active' ? ['open', 'in_progress', 'waiting_on_you'] : STATUSES.includes(status) ? [status] : ['open', 'in_progress', 'waiting_on_you'];
  const term = String(q || '').trim().slice(0, 80);
  let rows, counts;
  try {
    rows = await sql`
      SELECT t.id, t.ref, t.category, t.subject, t.status, t.role, t.order_id, t.listing_id, t.callback_phone,
             COALESCE(to_jsonb(t)->>'channel', 'web') AS channel, COALESCE((to_jsonb(t)->>'urgent')::boolean, false) AS urgent,
             (to_jsonb(t)->>'feedback_rating')::int AS feedback_rating, (to_jsonb(t)->>'auto_closed')::boolean AS auto_closed,
             t.created_at, t.updated_at, t.first_response_at, t.last_user_message_at, t.last_support_message_at,
             g.name AS person_name, COALESCE(g.email, to_jsonb(t)->>'contact_email') AS person_email,
             to_jsonb(t)->>'contact_email' AS contact_email, to_jsonb(t)->>'account_email' AS account_email,
             (COALESCE(to_jsonb(t)->>'channel', 'web') = 'signed_out') AS signed_out,
             (t.first_response_at IS NULL AND t.status NOT IN ('resolved', 'closed')
               AND t.created_at < now() - make_interval(hours => ${FIRST_RESPONSE_HOURS})) AS overdue,
             (t.status NOT IN ('resolved', 'closed') AND t.last_user_message_at IS NOT NULL AND (t.last_support_message_at IS NULL OR t.last_user_message_at > t.last_support_message_at)) AS awaiting_us
      FROM support_tickets t LEFT JOIN guests g ON g.id = t.guest_id
      WHERE (${want}::text[] IS NULL OR t.status = ANY(${want}::text[]))
        AND (${term} = '' OR t.ref ILIKE ${'%' + term + '%'} OR t.subject ILIKE ${'%' + term + '%'} OR g.email ILIKE ${'%' + term + '%'} OR g.name ILIKE ${'%' + term + '%'}
             OR to_jsonb(t)->>'contact_email' ILIKE ${'%' + term + '%'} OR to_jsonb(t)->>'account_email' ILIKE ${'%' + term + '%'})
      -- "Can't sign in?" first (the person has no other way to reach us), then other urgent requests, then safety.
      ORDER BY (COALESCE(to_jsonb(t)->>'channel', 'web') = 'signed_out' AND t.status NOT IN ('resolved', 'closed')) DESC,
               (COALESCE((to_jsonb(t)->>'urgent')::boolean, false) AND t.status NOT IN ('resolved', 'closed')) DESC, (t.category = 'safety' AND t.status NOT IN ('resolved', 'closed')) DESC, (t.first_response_at IS NULL) DESC, t.updated_at DESC LIMIT 200`;
    counts = await sql`SELECT status, count(*)::int AS n FROM support_tickets GROUP BY status`;
  } catch (err) { if (notReady(err)) return { ready: false, tickets: [], counts: {} }; throw err; }
  return {
    ready: true, categories: CATEGORIES, statuses: STATUS_LABELS,
    counts: Object.fromEntries(counts.map(c => [c.status, c.n])),
    tickets: rows.map(r => ({ ...r, categoryLabel: (CATEGORIES[r.category] || {}).label || r.category }))
  };
}

async function adminGet(sql, id) {
  const t = (await sql`
    SELECT t.*, g.name AS person_name, g.email AS person_email, g.phone AS person_phone,
           o.suite_name, o.arrival, o.departure, o.status AS booking_status, o.confirmation_code, o.total, o.guest_id AS booking_guest_id,
           to_jsonb(o)->>'deposit_amount' AS deposit_amount, to_jsonb(o)->>'deposit_status' AS deposit_status, o.payout_amount, to_jsonb(o)->>'guest_service_fee' AS guest_service_fee,
           l.property_name, l.status AS listing_status
    FROM support_tickets t LEFT JOIN guests g ON g.id = t.guest_id
    LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN listings l ON l.id = COALESCE(t.listing_id, o.listing_id)
    WHERE t.id = ${Number(id) || 0}`)[0];
  if (!t) throw userError('Request not found.', 404);
  const msgs = await sql`SELECT m.id, m.sender, m.internal, m.admin_email, m.body, m.attachments, m.created_at, to_jsonb(m)->>'via' AS via
                         FROM support_messages m WHERE m.ticket_id = ${t.id} ORDER BY m.created_at, m.id`;
  // The timeline in numbers: how long until the first reply, and until resolved.
  const mins = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)) : null);
  t.timings = { firstResponseMinutes: mins(t.created_at, t.first_response_at), resolvedMinutes: mins(t.created_at, t.resolved_at || t.closed_at),
                firstResponseDueAt: new Date(new Date(t.created_at).getTime() + FIRST_RESPONSE_HOURS * 3600e3).toISOString() };
  let caseNotes = [];
  try { caseNotes = await sql`SELECT * FROM support_case_notes WHERE ticket_id = ${t.id} ORDER BY created_at DESC, id DESC`; } catch (err) { if (!notReady(err)) throw err; }
  // The person's bookings, so the team can investigate without leaving the
  // request (owner, 10 Nov 2026): as a guest, and — for a host — the
  // bookings at their listings. Running and upcoming first, then the latest
  // past ones. Never fails the request view.
  const bookings = { asGuest: [], asHost: [] };
  if (t.guest_id) {
    const cols = (rows) => rows.map(r => ({ id: r.id, code: r.confirmation_code || null, suite: r.suite_name, arrival: String(r.arrival_day), departure: String(r.departure_day),
      nights: Number(r.nights) || 0, guests: Number(r.guests) || 0, status: r.status, when: r.stay_when, total: r.total == null ? null : Math.round(Number(r.total)),
      deposit: Math.round(Number(r.deposit_amount) || 0), depositStatus: r.deposit_status || null, refundPercent: r.refund_percent == null ? null : Number(r.refund_percent),
      cancelledBy: r.cancelled_by || null, openChange: !!r.open_change, openCancel: !!r.open_cancel, guestName: r.guest_name || null, thisRequest: Number(r.id) === Number(t.order_id) }));
    // "Today" is the property's own day (India time unless the listing says otherwise), not the database's UTC day:
    // before 5:30 am a stay starting today read "Upcoming" and one that ended yesterday "Staying now".
    const pick = (who) => sql`
      SELECT o.id, to_jsonb(o)->>'confirmation_code' AS confirmation_code, o.suite_name, o.arrival::text AS arrival_day, o.departure::text AS departure_day, o.nights, o.guests, o.status, o.total,
             to_jsonb(o)->>'deposit_amount' AS deposit_amount, to_jsonb(o)->>'deposit_status' AS deposit_status, to_jsonb(o)->>'refund_percent' AS refund_percent, to_jsonb(o)->>'cancelled_by' AS cancelled_by,
             CASE WHEN o.status <> 'paid' THEN 'cancelled' WHEN o.departure < (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date THEN 'past' WHEN o.arrival <= (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date THEN 'now' ELSE 'upcoming' END AS stay_when,
             EXISTS (SELECT 1 FROM booking_changes c WHERE c.order_id = o.id AND c.status IN ('pending', 'accepted')) AS open_change,
             EXISTS (SELECT 1 FROM cancellation_requests c WHERE c.order_id = o.id AND c.status = 'pending') AS open_cancel,
             gg.name AS guest_name
      FROM orders o JOIN listings l ON l.id = o.listing_id LEFT JOIN guests gg ON gg.id = o.guest_id
      WHERE o.status IN ('paid', 'cancelled') AND ${who === 'guest'} = (o.guest_id = ${t.guest_id})
        AND (${who === 'guest'} OR l.host_id = (SELECT host_id FROM guests WHERE id = ${t.guest_id}))
        AND (${who === 'guest'} OR o.guest_id IS DISTINCT FROM ${t.guest_id})
      ORDER BY (o.id = ${Number(t.order_id) || 0}) DESC,
               CASE WHEN o.status = 'paid' AND o.departure >= (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date THEN 0 ELSE 1 END,
               CASE WHEN o.status = 'paid' AND o.departure >= (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date THEN o.arrival END ASC, o.arrival DESC
      LIMIT 10`;
    try { bookings.asGuest = cols(await pick('guest')); } catch (err) { console.error('support: person bookings', err && err.message); }
    try { bookings.asHost = cols(await pick('host')); } catch (err) { console.error('support: host bookings', err && err.message); }
  }
  return { ticket: { ...t, categoryLabel: (CATEGORIES[t.category] || {}).label || t.category }, messages: msgs, statuses: STATUS_LABELS,
           caseNotes, caseRecord: caseNotes[0] || null, conduct: CONDUCT, otherParty: !!(t.order_id || t.listing_id), bookings };
}

// The support team's record of a request: the issue as understood, the
// outcome, and how the person who raised it (and the other party) behaved.
// Every save is a new row, so the whole history stays with the reference.
async function adminSaveCase(sql, { id, summary, outcome, requesterConduct, otherConduct, conductNote, adminEmail = 'admin', audit = {} }) {
  const t = (await sql`SELECT id, ref FROM support_tickets WHERE id = ${Number(id) || 0}`)[0];
  if (!t) throw userError('Request not found.', 404);
  const sum = clean(summary, 4000), out = clean(outcome, 4000), note = clean(conductNote, 1000);
  if (requesterConduct && !CONDUCT[requesterConduct]) throw userError('Choose how the person behaved.');
  if (otherConduct && !CONDUCT[otherConduct]) throw userError('Choose how the other party behaved.');
  if (!sum && !out && !requesterConduct && !otherConduct && !note) throw userError('Write the summary, the outcome or the behaviour first.');
  try {
    await sql`INSERT INTO support_case_notes (ticket_id, summary, outcome, requester_conduct, other_party_conduct, conduct_note, admin_email)
              VALUES (${t.id}, ${sum || null}, ${out || null}, ${requesterConduct || null}, ${otherConduct || null}, ${note || null}, ${adminEmail})`;
  } catch (err) { if (notReady(err)) throw userError('Run migration_support_cases.sql in Neon first.', 503); throw err; }
  await logAudit(sql, { action: 'support_case_recorded', success: true, actorType: 'admin', ...audit, targetType: 'support_ticket', targetId: t.id,
    metadata: { ref: t.ref, requesterConduct: requesterConduct || null, otherConduct: otherConduct || null } });
  return adminGet(sql, t.id);
}

// A reply (emailed to the person) or an internal note (never shown), and/or
// a new status. status: one of STATUSES, or null to leave it.
async function adminReply(sql, { id, text, status = null, internal = false, adminEmail = 'admin', audit = {} }) {
  const t = (await sql`SELECT t.*, g.email AS person_email, g.name AS person_name FROM support_tickets t LEFT JOIN guests g ON g.id = t.guest_id WHERE t.id = ${Number(id) || 0}`)[0];
  if (!t) throw userError('Request not found.', 404);
  // Raised without signing in ("Can't sign in?"): the person follows it on
  // their private request page (signedOutView). A reply or a new status sends
  // a short notice with a link to it — never the reply itself — to the
  // address they gave, never to the email on the account.
  const signedOut = t.channel === 'signed_out';
  if (signedOut) t.person_email = t.contact_email || t.account_email || null;
  const body = clean(text, REPLY_MAX);
  if (status !== null && !STATUSES.includes(status)) throw userError('Unknown status.');
  if (!body && status === null) throw userError('Write a reply, or choose a new status.');
  if (t.status === 'closed' && body && !internal) throw userError('This request is closed. Reopen it first (set a status) to reply.', 409);
  // Resolved or closed only with a complete case record: the issue as
  // understood, the outcome, and the behaviour (of the other party too, when
  // a booking or listing is involved).
  if ((status === 'resolved' || status === 'closed') && status !== t.status) {
    let c = null;
    try { c = (await sql`SELECT * FROM support_case_notes WHERE ticket_id = ${t.id} ORDER BY created_at DESC, id DESC LIMIT 1`)[0] || null; }
    catch (err) { if (!notReady(err)) throw err; c = undefined; }
    if (c !== undefined) {
      const missing = [];
      if (!c || !c.summary) missing.push('the summary of the issue');
      if (!c || !c.outcome) missing.push('the outcome');
      if (!c || !c.requester_conduct) missing.push('how the person behaved');
      if ((t.order_id || t.listing_id) && (!c || !c.other_party_conduct)) missing.push('how the other party behaved');
      if (missing.length) throw userError(`Record ${missing.join(', ')} in the case record first.`, 409);
    }
  }
  if (body) {
    await sql`INSERT INTO support_messages (ticket_id, sender, internal, admin_email, body) VALUES (${t.id}, 'support', ${!!internal}, ${adminEmail}, ${body})`;
  }
  const replied = !!body && !internal;
  const next = status || (replied && ['open', 'in_progress'].includes(t.status) ? 'waiting_on_you' : t.status);
  await sql`UPDATE support_tickets SET
              status = ${next}, updated_at = now(),
              first_response_at = CASE WHEN ${replied} THEN COALESCE(first_response_at, now()) ELSE first_response_at END,
              last_support_message_at = CASE WHEN ${replied} THEN now() ELSE last_support_message_at END,
              resolved_at = CASE WHEN ${next} = 'resolved' THEN COALESCE(resolved_at, now()) WHEN ${next} IN ('open', 'in_progress', 'waiting_on_you') THEN NULL ELSE resolved_at END,
              closed_at = CASE WHEN ${next} = 'closed' THEN COALESCE(closed_at, now()) ELSE NULL END
            WHERE id = ${t.id}`;
  if (next !== t.status) {
    await sql`INSERT INTO support_messages (ticket_id, sender, body) VALUES (${t.id}, 'system', ${'Status: ' + STATUS_LABELS[next]})`;
    // Resolved (again): a fresh question to the person.
    if (next === 'resolved') {
      try { await sql`UPDATE support_tickets SET feedback_rating = NULL, feedback_comment = NULL, feedback_resolved = NULL, feedback_at = NULL WHERE id = ${t.id}`; }
      catch (err) { if (!notReady(err)) throw err; }
    }
  }
  await logAudit(sql, { action: internal ? 'support_internal_note' : replied ? 'support_replied' : 'support_status_changed', success: true,
    actorType: 'admin', ...audit, targetType: 'support_ticket', targetId: t.id, metadata: { ref: t.ref, from: t.status, to: next } });
  // The person hears about a reply, or the request being resolved or closed.
  if (signedOut && t.person_email && (replied || next !== t.status)) {
    const sent = await signedOutNotice(sql, { ...t, contact_email: t.person_email, status: next }, { replied, closed: next === 'closed' });
    if (sent) await sql`INSERT INTO support_messages (ticket_id, sender, internal, body) VALUES (${t.id}, 'system', true,
                ${'Notice emailed to ' + t.person_email + ' (' + (replied ? 'a reply' : 'status ' + STATUS_LABELS[next]) + '; without the reply text, with a private link to the request).'})`;
  } else if (!signedOut && t.person_email && (replied || (next !== t.status && ['resolved', 'closed', 'waiting_on_you'].includes(next)))) {
    const what = replied ? 'Aerva Support has replied' : `Your request is now: ${STATUS_LABELS[next]}`;
    await sendEmail(t.person_email, `${what} — ${t.ref}`,
      `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">${esc(what)}</h2>
       ${SAY.refBlock({ code: t.order_id ? await bookingCode(sql, t.order_id) : null, ref: t.ref })}
       <p><strong>${esc(t.subject)}</strong> · ${esc(t.ref)}</p>
       ${replied ? `<blockquote style="margin:12px 0; padding:10px 14px; background:#f6f1ea; border-left:3px solid #a9884f; white-space:pre-wrap;">${esc(body)}</blockquote>` : ''}
       ${next === 'resolved' ? `<p><strong>Is it sorted?</strong> Tell us on the request — confirm it is resolved and rate how we did, or say what is still not right and it opens again. If we do not hear from you, it closes by itself in ${FEEDBACK_HOURS} hours.</p>` : ''}
       ${button(requestLink(t.ref), next === 'closed' ? 'View your request' : next === 'resolved' ? 'Tell us how we did' : 'View and reply')}
       ${SAY.nextStep(next === 'resolved'
          ? `Your turn: confirm it is sorted, or say what is still wrong. If we do not hear from you it closes by itself in ${FEEDBACK_HOURS} hours.`
          : next === 'closed' ? 'Nothing for you to do. If it comes back, raise a new request and mention this number.'
          : replied ? 'Your turn: reply on the request page whenever you are ready — nothing closes while you are answering.'
          : 'Nothing for you to do — Aerva comes back to you on the request page.')}
       <p style="font-size:13px; color:#6e675d;">Please reply on the request page rather than to this email, so everything stays in one place.</p>`);
  }
  const out = await adminGet(sql, t.id);
  return out;
}

// Deleting an account: what the person wrote goes; the record that a
// request existed stays (without their words), like booking records.
async function eraseForAccount(sql, guestId) {
  try {
    await sql`UPDATE support_messages m SET body = '[deleted]', attachments = '[]'::jsonb
              FROM support_tickets t WHERE m.ticket_id = t.id AND t.guest_id = ${guestId} AND m.sender = 'user'`;
    await sql`UPDATE support_tickets SET subject = '[deleted]', callback_phone = NULL WHERE guest_id = ${guestId}`;
    try { await sql`UPDATE support_tickets SET feedback_comment = NULL WHERE guest_id = ${guestId}`; } catch (e) { /* before migration_support_cases.sql */ }
    try { await sql`DELETE FROM support_chat_messages WHERE guest_id = ${guestId}`; } catch (e) { /* before the support chat migration */ }
  } catch (err) { if (!notReady(err)) throw err; }
}

// ---------------------------------------------------------------- requests Aerva opens itself
// A request Aerva opens for a person about a booking (e.g. an emergency
// cancellation the host has not answered, _cancellations.js): it shows in
// their Support → My requests and in the bell as a message from Aerva
// Support, and in Admin → Support (urgent first). Returns the ticket, or
// null before the support tables exist. Never sends the generic
// acknowledgement — the caller emails what matters.
async function openSystemRequest(sql, { guestId, role = 'guest', category = 'cancellation_refund', subject, body, orderId = null, urgent = false }) {
  try {
    let ticket;
    for (let i = 0; i < 20 && !ticket; i++) {
      ticket = (await sql`
        INSERT INTO support_tickets (ref, guest_id, role, category, subject, order_id, status, last_support_message_at, first_response_at)
        VALUES (${randomRef()}, ${guestId}, ${role}, ${category}, ${clean(subject, SUBJECT_MAX)}, ${orderId}, 'in_progress', now(), now())
        ON CONFLICT (ref) DO NOTHING RETURNING *`)[0];
    }
    if (!ticket) return null;
    if (urgent) { try { await sql`UPDATE support_tickets SET urgent = true WHERE id = ${ticket.id}`; } catch (e) { /* column not there yet */ } }
    await sql`INSERT INTO support_messages (ticket_id, sender, body, created_at) VALUES (${ticket.id}, 'system', ${`Request opened by Aerva. Reference ${ticket.ref}.`}, now() - interval '1 millisecond')`;
    await sql`INSERT INTO support_messages (ticket_id, sender, body) VALUES (${ticket.id}, 'support', ${String(body || '').slice(0, BODY_MAX)})`;
    await logAudit(sql, { action: 'support_request_created', success: true, actorType: 'system', actorIdentifier: 'aerva',
      targetType: 'support_ticket', targetId: ticket.id, metadata: { ref: ticket.ref, category, role, orderId, opened: 'by_aerva' } });
    return ticket;
  } catch (err) { if (notReady(err)) return null; throw err; }
}
// Adds an update from Aerva to such a request (shows as unread for the person).
// resolve: true closes it as resolved. Never throws.
async function systemUpdate(sql, ticketId, body, { resolve = false } = {}) {
  if (!ticketId) return;
  try {
    await sql`INSERT INTO support_messages (ticket_id, sender, body) VALUES (${ticketId}, 'support', ${String(body || '').slice(0, BODY_MAX)})`;
    if (resolve) {
      await sql`UPDATE support_tickets SET last_support_message_at = now(), updated_at = now(), status = 'resolved', resolved_at = now() WHERE id = ${ticketId} AND status NOT IN ('resolved', 'closed')`;
      try { await sql`UPDATE support_tickets SET urgent = false WHERE id = ${ticketId}`; } catch (e) { /* column not there yet */ }
    } else {
      await sql`UPDATE support_tickets SET last_support_message_at = now(), updated_at = now() WHERE id = ${ticketId}`;
    }
  } catch (err) { console.error('support update not written:', ticketId, err.message); }
}

// ---------------------------------------------------------------- "Can't sign in?"
// A request raised WITHOUT an account (owner, 10 Nov 2026), from Help →
// "Can't sign in?" (index.html?view=help&signin=1), for three people who
// otherwise could not reach Aerva: a suspended account, someone locked out
// after their email was changed without their permission, and someone who
// does not receive sign-in codes. Called by guest-auth.js (mode
// 'support-signed-out'); needs 2026-11-10-05-signed-out-support.sql.
//
// It is a support ticket with channel 'signed_out', category
// 'account_access', urgent, first in Admin → Support. If the email matches
// an account (now, or one it had before an email change) the ticket is
// linked to it for the team — the person is never told whether it did. The
// answer is the same either way. The ticket never shows in that account's
// own Support pages or bell (whoever holds the account now may not be the
// person writing), and every email about it goes to the address the person
// gave, never to the account's.
const SIGNIN_PROBLEMS = {
  suspended:     'My account is suspended',
  email_changed: 'Someone changed my email / I’m locked out',
  no_codes:      'I don’t receive sign-in codes',
  other:         'Other sign-in problem'
};
const SIGNED_OUT_PER_IP_HOUR = 3;       // requests from one address per hour
const SIGNED_OUT_PER_EMAIL_DAY = 3;     // requests for one account email per 24 hours
const SIGNED_OUT_BODY_MIN = 20, SIGNED_OUT_BODY_MAX = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const signedOutAnswer = (ref) => `Thanks — reference ${ref}; Aerva will contact you by phone or at the email you gave.`;

// The account an email belongs to now, or belonged to before an email
// change (guest-profile.js logs 'guest_email_changed' with the new address
// and, from 10 Nov 2026, the old one as 'from'). null when none.
async function accountForEmail(sql, email) {
  const now = (await sql`SELECT id, name, host_id FROM guests WHERE lower(email) = ${email} AND deleted_at IS NULL ORDER BY id LIMIT 1`)[0];
  if (now) return { ...now, how: 'the email on the account' };
  try {
    const a = (await sql`SELECT target_id FROM audit_log WHERE action = 'guest_email_changed' AND target_id IS NOT NULL
                           AND (lower(metadata->>'from') = ${email} OR lower(metadata->>'email') = ${email})
                         ORDER BY created_at DESC LIMIT 1`)[0];
    if (a) {
      const g = (await sql`SELECT id, name, host_id FROM guests WHERE id = ${Number(a.target_id)} AND deleted_at IS NULL`)[0];
      if (g) return { ...g, how: 'an earlier email of the account (since changed)' };
    }
  } catch (err) { console.error('signed-out request: earlier email lookup skipped:', err.message); }
  return null;
}

async function createSignedOutRequest(sql, { problem, accountEmail, phone, contactEmail, description, honeypot, ip }) {
  const acct = String(accountEmail || '').trim().toLowerCase().slice(0, 254);
  // A filled hidden field: a bot. The same answer, nothing stored or sent.
  if (honeypot != null && String(honeypot).trim()) {
    await logAudit(sql, { action: 'support_signed_out_request', success: false, actorType: 'guest', actorIdentifier: acct || null,
      metadata: { reason: 'honeypot', ip: ip || null } });
    const ref = randomRef();
    return { ref, key: crypto.randomBytes(32).toString('base64url'), message: signedOutAnswer(ref), ignored: true };
  }
  if (!SIGNIN_PROBLEMS[problem]) throw userError('Choose what the problem is.');
  if (!EMAIL_RE.test(acct)) throw userError('Enter the email address on your Aerva account.');
  const e164 = normalizeToE164(String(phone || '').trim());
  if (!e164) throw userError('Enter a valid phone number we can call you on, with the country code if it is not an Indian number.');
  let reach = String(contactEmail || '').trim().toLowerCase().slice(0, 254);
  if (reach && !EMAIL_RE.test(reach)) throw userError('Enter a valid email address we can reach you at, or leave it empty.');
  if (reach === acct) reach = '';
  // Contact details are NOT removed here: the person has to give them.
  const text = clean(description, SIGNED_OUT_BODY_MAX + 1);
  if (text.length < SIGNED_OUT_BODY_MIN) throw userError('Please describe the problem in a few sentences (at least 20 characters).');
  if (text.length > SIGNED_OUT_BODY_MAX) throw userError(`Please keep the description under ${SIGNED_OUT_BODY_MAX} characters.`);

  const byIp = ip ? await countRecentAttempts(sql, { action: 'support_signed_out_request', windowMinutes: 60, byIp: ip }) : 0;
  const byEmail = await countRecentAttempts(sql, { action: 'support_signed_out_request', windowMinutes: 24 * 60, byActor: acct });
  if (byIp >= SIGNED_OUT_PER_IP_HOUR || byEmail >= SIGNED_OUT_PER_EMAIL_DAY) {
    await logAudit(sql, { action: 'support_signed_out_limited', success: false, actorType: 'guest', actorIdentifier: acct,
      metadata: { reason: byIp >= SIGNED_OUT_PER_IP_HOUR ? 'ip_hour' : 'email_day', ip: ip || null } });
    throw userError(byIp >= SIGNED_OUT_PER_IP_HOUR
      ? 'Several requests have been sent from here in the last hour. Please try again later.'
      : 'Several requests have already been sent for this email today. Aerva will contact you about them.', 429);
  }

  const match = await accountForEmail(sql, acct);
  const sendTo = reach || acct;
  const label = SIGNIN_PROBLEMS[problem];
  let ticket;
  try {
    for (let i = 0; i < 20 && !ticket; i++) {
      ticket = (await sql`
        INSERT INTO support_tickets (ref, guest_id, role, category, subject, callback_phone, last_user_message_at, channel, urgent, account_email, contact_email)
        VALUES (${randomRef()}, ${match ? match.id : null}, ${match && match.host_id ? 'host' : 'guest'}, 'account_access', ${label}, ${e164}, now(),
                'signed_out', true, ${acct}, ${sendTo})
        ON CONFLICT (ref) DO NOTHING RETURNING *`)[0];
    }
    if (!ticket) throw new Error('could not draw a free reference number');
    // What the person sees on their request page: no contact details (anyone
    // holding the link would see them). The details are for the team only.
    await sql`INSERT INTO support_messages (ticket_id, sender, body, created_at) VALUES (${ticket.id}, 'system',
                ${`Request raised without signing in (Can’t sign in?): ${label}. Reference ${ticket.ref}.`}, now() - interval '3 milliseconds')`;
    await sql`INSERT INTO support_messages (ticket_id, sender, internal, body, created_at) VALUES (${ticket.id}, 'system', true,
                ${`Account email given: ${acct}. Phone: ${e164}.${reach ? ' Reach them at: ' + reach + '.' : ''} Notices (no reply text, a private link to the request) go to ${sendTo}.`}, now() - interval '2 milliseconds')`;
    await sql`INSERT INTO support_messages (ticket_id, sender, internal, body, created_at) VALUES (${ticket.id}, 'system', true,
                ${match ? `Matches account #${match.id}${match.name ? ' (' + match.name + ')' : ''} by ${match.how}. The person was not told. Confirm who they are (phone call) before acting on the account.`
                        : 'No Aerva account has this email (now or before an email change). The person was not told.'}, now() - interval '1 millisecond')`;
    await sql`INSERT INTO support_messages (ticket_id, sender, body) VALUES (${ticket.id}, 'user', ${text})`;
  } catch (err) {
    if (notReady(err)) throw NOT_READY();
    throw err;
  }
  // The private link: only its hash is stored; the key is never logged.
  const key = await issueKey(sql, ticket.id, 'created');
  await logAudit(sql, { action: 'support_signed_out_request', success: true, actorType: 'guest', actorIdentifier: acct,
    targetType: 'support_ticket', targetId: ticket.id,
    metadata: { ref: ticket.ref, problem, linked: !!match, guestId: match ? match.id : undefined, ip: ip || null } });

  // To Aerva's support inbox, like every new request.
  await sendEmail(SUPPORT_INBOX(), `ACCOUNT ACCESS — New request ${ticket.ref}: ${label}`,
    `<p><strong>Can’t sign in</strong> · ${esc(label)} · urgent, first in Admin → Support</p>
     <p>Account email given: <strong>${esc(acct)}</strong> — ${match ? `matches account #${match.id}${match.name ? ' (' + esc(match.name) + ')' : ''} by ${esc(match.how)}` : 'no account has this email'}<br>
        Phone: <strong>${esc(e164)}</strong>${reach ? `<br>Reach them at: <strong>${esc(reach)}</strong>` : ''}</p>
     <blockquote style="margin:12px 0; padding:10px 14px; background:#f6f1ea; border-left:3px solid #a9884f; white-space:pre-wrap;">${esc(text)}</blockquote>
     <p>Confirm who they are before changing anything on an account. Answer in Admin → Support: the person reads your replies and answers on their private request page; ${esc(sendTo)} gets a short notice (without your reply) each time you reply or change the status.</p>`);
  // The acknowledgement: the same words whether or not an account exists,
  // and nothing the person typed (so it cannot carry someone else's message).
  await sendEmail(sendTo, `We have received your request ${ticket.ref}`,
    `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">We have received your request</h2>
     <p>Thank you for contacting Aerva. Your reference number is <strong>${esc(ticket.ref)}</strong>.</p>
     <p><strong>${esc(label)}</strong></p>
     ${key ? `<p>Follow your request and talk to Aerva Support on its private page. You do not need to sign in.</p>
     ${button(privateLink(ticket.ref, key), 'Open your request')}
     <p style="font-size:13px; color:#6e675d; word-break:break-all;">Save this link — it’s how you follow your request: ${esc(privateLink(ticket.ref, key))}<br>Do not share it: anyone with the link can read and reply to this request.</p>`
     : '<p>Aerva will contact you by phone or at this email address. You do not need to sign in.</p>'}
     <p style="font-size:13px; color:#6e675d;">If you did not ask Aerva for help signing in, you can ignore this email. Aerva will never ask for your password or a sign-in code.</p>`);
  return { ref: ticket.ref, key, message: signedOutAnswer(ticket.ref) };
}

// ---------------------------------------------------------------- the private link
// A signed-out request is followed on index.html?view=help&request=SR-…&key=…
// The key (32 random bytes, url-safe) is the only proof: it opens that one
// request (never the account, never another request), only while it is open
// or for KEY_DAYS after it is resolved or closed. Only its SHA-256 is stored
// (support_ticket_keys); it is compared timing-safe and never logged — audit
// rows carry the reference only. Every guest-auth.js mode below is POST, so
// the key is never in a URL the server logs.
const KEY_DAYS = 30;
const SO_REPLY_MAX = 2000;
const SO_REPLIES_PER_HOUR = 20;          // per request, and per IP
const SO_REFUSED_PER_IP_HOUR = 30;       // wrong keys from one address
const SO_NEW_LINK_PER_IP_HOUR = 3;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const REF_RE = /^SR-\d{8}$/;
const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
const privateLink = (ref, key) => `${SITE}/index.html?view=help&request=${encodeURIComponent(ref)}&key=${encodeURIComponent(key)}`;
const LINK_INVALID = () => userError('This link does not open a request. Check that you copied all of it, or get a new link below.', 404);
const LINK_EXPIRED = () => userError('This request is closed. Raise a new one if you still need help.', 410);
const NEW_LINK_ANSWER = 'If the details match, we’ve emailed a new link.';

// A new key for a ticket; returns the key (to show or email once) or null
// before support_ticket_keys exists.
async function issueKey(sql, ticketId, purpose) {
  const key = crypto.randomBytes(32).toString('base64url');
  try {
    await sql`INSERT INTO support_ticket_keys (ticket_id, key_hash, issued_for) VALUES (${ticketId}, ${hashKey(key)}, ${purpose})`;
    return key;
  } catch (err) { if (notReady(err)) return null; throw err; }
}

// The day a closed or resolved request's links stop working (null: open).
function linkEndsAt(t) {
  const end = t.status === 'closed' ? (t.closed_at || t.resolved_at) : t.status === 'resolved' ? t.resolved_at : null;
  return end ? new Date(new Date(end).getTime() + KEY_DAYS * 86400e3) : null;
}

// The ticket this ref + key opens, or a refusal. Wrong keys are logged
// (reference and IP only) and limited per IP.
async function keyTicket(sql, { ref, key, ip }) {
  const r = String(ref || '').trim().toUpperCase().slice(0, 20);
  const k = String(key || '');
  if (ip && await countRecentAttempts(sql, { action: 'support_signed_out_key_refused', windowMinutes: 60, byIp: ip }) >= SO_REFUSED_PER_IP_HOUR)
    throw userError('Too many attempts from here. Please try again later.', 429);
  let t = null, keys = [];
  if (REF_RE.test(r) && KEY_RE.test(k)) {
    try {
      t = (await sql`SELECT * FROM support_tickets t WHERE ref = ${r} AND COALESCE(to_jsonb(t)->>'channel', 'web') = 'signed_out'`)[0] || null;
      if (t) keys = await sql`SELECT id, key_hash FROM support_ticket_keys WHERE ticket_id = ${t.id} AND revoked_at IS NULL`;
    } catch (err) { if (notReady(err)) throw NOT_READY(); throw err; }
  }
  // Every live key of the request is compared, timing-safe, with no early exit.
  const want = Buffer.from(hashKey(k), 'hex');
  let hit = null;
  for (const row of keys) {
    const have = Buffer.from(String(row.key_hash), 'hex');
    if (have.length === want.length && crypto.timingSafeEqual(have, want) && !hit) hit = row;
  }
  if (!t || !hit) {
    await logAudit(sql, { action: 'support_signed_out_key_refused', success: false, actorType: 'guest', actorIdentifier: null,
      metadata: { ref: REF_RE.test(r) ? r : null, ip: ip || null } });
    throw LINK_INVALID();
  }
  const ends = linkEndsAt(t);
  if (ends && ends < new Date()) throw LINK_EXPIRED();
  await sql`UPDATE support_ticket_keys SET last_used_at = now() WHERE id = ${hit.id}`;
  return t;
}

// The request as its private page shows it (never internal notes).
// Opening it marks Aerva's replies as read.
async function signedOutView(sql, { ref, key, ip }, t = null) {
  t = t || await keyTicket(sql, { ref, key, ip });
  const msgs = await sql`SELECT id, sender, body, created_at FROM support_messages
                         WHERE ticket_id = ${t.id} AND internal = false ORDER BY created_at, id`;
  await sql`UPDATE support_tickets SET user_last_seen_at = now() WHERE id = ${t.id}`;
  const phone = String(t.callback_phone || '');
  const ends = linkEndsAt(t);
  return {
    ref: t.ref, categoryLabel: (CATEGORIES[t.category] || {}).label || 'Request', subject: t.subject,
    status: t.status, statusLabel: STATUS_LABELS[t.status] || t.status, createdAt: t.created_at, updatedAt: t.updated_at,
    phoneEnding: phone.length >= 4 ? phone.slice(-4) : null,
    signedOut: true, canReply: t.status !== 'closed', replyMax: SO_REPLY_MAX,
    firstReplyBy: t.first_response_at ? null : new Date(new Date(t.created_at).getTime() + FIRST_RESPONSE_HOURS * 3600e3).toISOString(),
    autoCloseAt: t.status === 'resolved' && t.resolved_at ? new Date(new Date(t.resolved_at).getTime() + FEEDBACK_HOURS * 3600e3).toISOString() : null,
    linkEndsAt: ends ? ends.toISOString() : null,
    messages: msgs.map(m => ({ id: m.id, from: m.sender === 'user' ? 'you' : m.sender === 'support' ? 'Aerva Support' : 'Aerva',
                               body: m.body, files: [], at: m.created_at }))
  };
}

// The person replies on the private page: up to 2000 characters, contact
// details allowed (as on the form), no files. 20 an hour per request and per IP.
async function signedOutReplyTo(sql, { ref, key, text, ip }) {
  const t = await keyTicket(sql, { ref, key, ip });
  if (t.status === 'closed') throw userError('This request is closed. Raise a new one if you still need help.', 409);
  const body = clean(text, SO_REPLY_MAX + 1);
  if (!body) throw userError('Write your reply first.');
  if (body.length > SO_REPLY_MAX) throw userError(`Please keep your reply under ${SO_REPLY_MAX} characters.`);
  const byReq = await countRecentAttempts(sql, { action: 'support_signed_out_reply', windowMinutes: 60, byActor: t.ref });
  const byIp = ip ? await countRecentAttempts(sql, { action: 'support_signed_out_reply', windowMinutes: 60, byIp: ip }) : 0;
  if (byReq >= SO_REPLIES_PER_HOUR || byIp >= SO_REPLIES_PER_HOUR) {
    await logAudit(sql, { action: 'support_signed_out_limited', success: false, actorType: 'guest', actorIdentifier: t.ref,
      targetType: 'support_ticket', targetId: t.id, metadata: { ref: t.ref, reason: byReq >= SO_REPLIES_PER_HOUR ? 'reply_request_hour' : 'reply_ip_hour', ip: ip || null } });
    throw userError('Too many replies in a short time. Please wait a little and try again.', 429);
  }
  await appendUserMessage(sql, t, { body, actor: t.ref, auditAction: 'support_signed_out_reply', auditExtra: { ip: ip || null } });
  return signedOutView(sql, { ref, key, ip }, (await sql`SELECT * FROM support_tickets WHERE id = ${t.id}`)[0]);
}

// "Get a new link": the reference and the contact email the person gave.
// If both match (and the request can still be opened), every earlier link
// stops working and a new one is emailed to that address. The answer is
// always the same. 3 an hour per IP.
async function signedOutNewLink(sql, { ref, contactEmail, ip }) {
  const r = String(ref || '').trim().toUpperCase().slice(0, 20);
  const email = String(contactEmail || '').trim().toLowerCase().slice(0, 254);
  const n = ip ? await countRecentAttempts(sql, { action: 'support_signed_out_new_link', windowMinutes: 60, byIp: ip }) : 0;
  const audit = (sent, reason) => logAudit(sql, { action: 'support_signed_out_new_link', success: sent, actorType: 'guest', actorIdentifier: null,
    targetType: t ? 'support_ticket' : null, targetId: t ? t.id : null, metadata: { ref: REF_RE.test(r) ? r : null, ip: ip || null, reason } });
  let t = null;
  if (n >= SO_NEW_LINK_PER_IP_HOUR) { await audit(false, 'ip_hour'); return { message: NEW_LINK_ANSWER }; }
  if (REF_RE.test(r) && EMAIL_RE.test(email)) {
    try { t = (await sql`SELECT * FROM support_tickets t WHERE ref = ${r} AND COALESCE(to_jsonb(t)->>'channel', 'web') = 'signed_out'`)[0] || null; }
    catch (err) { if (notReady(err)) throw NOT_READY(); throw err; }
  }
  const given = t ? String(t.contact_email || t.account_email || '').toLowerCase() : '';
  const a = Buffer.from(hashKey(given)), b = Buffer.from(hashKey(email));
  const match = !!t && given.length > 0 && crypto.timingSafeEqual(a, b);
  const ends = t ? linkEndsAt(t) : null;
  if (!match || (ends && ends < new Date())) { await audit(false, !match ? 'no_match' : 'closed'); return { message: NEW_LINK_ANSWER }; }
  try { await sql`UPDATE support_ticket_keys SET revoked_at = now() WHERE ticket_id = ${t.id} AND revoked_at IS NULL`; }
  catch (err) { if (notReady(err)) throw NOT_READY(); throw err; }
  const key = await issueKey(sql, t.id, 'new_link');
  await sql`INSERT INTO support_messages (ticket_id, sender, internal, body) VALUES (${t.id}, 'system', true, ${'New private link emailed to ' + given + ' (asked for on the request page); earlier links no longer work.'})`;
  await audit(true, 'sent');
  await sendEmail(given, `A new link to your request ${t.ref}`,
    `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">A new link to your request</h2>
     <p><strong>${esc(t.subject)}</strong> · reference <strong>${esc(t.ref)}</strong></p>
     <p>Here is a new private link to your request. Earlier links to it no longer work.</p>
     ${button(privateLink(t.ref, key), 'Open your request')}
     <p style="font-size:13px; color:#6e675d; word-break:break-all;">Save this link — it’s how you follow your request: ${esc(privateLink(t.ref, key))}<br>Do not share it: anyone with the link can read and reply to this request.</p>
     <p style="font-size:13px; color:#6e675d;">If you did not ask for a new link, someone may have your reference number and email address. Your request is safe: only this email has the new link. Aerva will never ask for your password or a sign-in code.</p>`);
  return { message: NEW_LINK_ANSWER };
}

// The notice to the person (reply, status change, auto-close): a short
// email with a fresh private link — never the reply itself. Returns true
// when an email went out.
async function signedOutNotice(sql, t, { replied = false, closed = false, auto = false } = {}) {
  const to = t.contact_email || t.account_email;
  if (!to) return false;
  const key = await issueKey(sql, t.id, 'notice');
  const link = key ? privateLink(t.ref, key) : null;
  const headline = replied ? `Aerva Support replied to your request ${t.ref}` : closed ? `Your request ${t.ref} is now closed` : `Your request ${t.ref} is now: ${STATUS_LABELS[t.status] || t.status}`;
  return sendEmail(to, replied ? headline : closed ? `Your request ${t.ref} is closed` : headline,
    `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">${esc(replied ? 'Aerva Support replied' : closed ? 'Your request is closed' : 'Your request has an update')}</h2>
     <p>${esc(headline)}${link ? ' — open your request:' : '.'}</p>
     ${link ? button(link, 'Open your request') + `<p style="font-size:13px; color:#6e675d; word-break:break-all;">${esc(link)}</p>` : ''}
     ${auto ? `<p>We marked it resolved ${FEEDBACK_HOURS} hours ago and did not hear back, so it is now closed.</p>` : ''}
     ${closed ? `<p>You can still read it for ${KEY_DAYS} days. If you still need help, raise a new request from Help → Can’t sign in? and mention ${esc(t.ref)}.</p>` : ''}
     <p style="font-size:13px; color:#6e675d;">Do not share this link: anyone with it can read and reply to your request. Aerva will never ask for your password or a sign-in code.</p>`);
}

// The request types, for Admin → Lookup "Raise a request for this customer".
function categoryList() {
  return Object.keys(CATEGORIES).map(k => ({ key: k, label: CATEGORIES[k].label, audience: CATEGORIES[k].audience, booking: CATEGORIES[k].booking, bookingAs: CATEGORIES[k].bookingAs, listing: CATEGORIES[k].listing }));
}

module.exports = {
  categoryList,
  CATEGORIES, STATUS_LABELS, STATUSES, FIRST_RESPONSE_HOURS, MAX_NEW_PER_DAY,
  CONDUCT, FEEDBACK_HOURS,
  requestOptions, createRequest, listRequests, getRequest, replyToRequest, closeRequest, submitFeedback, autoCloseResolved, bellNotifications,
  createChatRequest, appendUserMessage, applyFeedback, ticketView, bookingRole,
  adminList, adminGet, adminReply, adminSaveCase, eraseForAccount, cleanFiles, openSystemRequest, systemUpdate,
  createSignedOutRequest, signedOutView, signedOutReplyTo, signedOutNewLink, KEY_DAYS, SO_REPLY_MAX, SO_REPLIES_PER_HOUR, SO_NEW_LINK_PER_IP_HOUR, NEW_LINK_ANSWER, SIGNIN_PROBLEMS, SIGNED_OUT_PER_IP_HOUR, SIGNED_OUT_PER_EMAIL_DAY, SIGNED_OUT_BODY_MIN, SIGNED_OUT_BODY_MAX
};
