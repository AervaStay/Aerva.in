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
  other:                 { label: 'Something else', audience: 'both', booking: 'optional', bookingAs: 'any', listing: 'optional' }
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
const NOT_READY = () => userError('Raising a request online is not open yet. Please email hello@aerva.in, and we will reply there.', 503);

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

async function createRequest(sql, { guestId, category, subject, description, orderId, listingId, attachments, callback, callbackPhone: askedPhone, ip }) {
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

  const recent = await countRecentAttempts(sql, { action: 'support_request_created', windowMinutes: 24 * 60, byActor: String(guestId) });
  if (recent >= MAX_NEW_PER_DAY) throw userError('You have raised several requests today. Please add to an open one, or email hello@aerva.in.', 429);

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
                ${`Request raised: ${CATEGORIES[category].label}. Reference ${ticket.ref}.${callbackPhone ? ` Call back asked for on ${callbackPhone}.` : ''}`}, now() - interval '1 millisecond')`;
    await sql`INSERT INTO support_messages (ticket_id, sender, body, attachments) VALUES (${ticket.id}, 'user', ${text}, ${JSON.stringify(files)}::jsonb)`;
  } catch (err) {
    if (notReady(err)) throw NOT_READY();
    throw err;
  }
  await logAudit(sql, { action: 'support_request_created', success: true, actorType: 'guest', actorIdentifier: String(guestId),
    targetType: 'support_ticket', targetId: ticket.id, metadata: { ref: ticket.ref, category, role, orderId: oid, listingId: lid, files: files.length, ip: ip || null } });

  // The acknowledgement, with the reference number (what the E-Commerce
  // Rules ask for), and a heads-up to the support inbox.
  await sendEmail(me.email, `We have received your request ${ticket.ref}`,
    `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">We have received your request</h2>
     <p>Hi ${esc(String(me.name || '').split(' ')[0] || 'there')}, thank you for writing to Aerva. Your reference number is <strong>${esc(ticket.ref)}</strong>.</p>
     <p><strong>${esc(subj)}</strong><br><span style="color:#6e675d;">${esc(CATEGORIES[category].label)}</span></p>
     <p>A member of our support team will ${callbackPhone ? `call you on <strong>${esc(callbackPhone)}</strong> and ` : ''}reply within ${FIRST_RESPONSE_HOURS} hours, usually much sooner. You can follow your request and add to it at any time:</p>
     ${button(requestLink(ticket.ref), 'View your request')}
     <p style="font-size:13px; color:#6e675d;">If anyone is in danger, call 112 first.</p>`);
  await sendEmail(SUPPORT_INBOX(), `New request ${ticket.ref}: ${CATEGORIES[category].label}`,
    `<p><strong>${esc(subj)}</strong> · ${esc(CATEGORIES[category].label)} · as ${esc(role)}</p>
     <p>From ${esc(me.name || '')} (${esc(me.email || 'no email')}${callbackPhone ? ', asks for a call back on ' + esc(callbackPhone) : ''})${oid ? ' · booking #' + oid : ''}${lid ? ' · listing #' + lid : ''}</p>
     <blockquote style="margin:12px 0; padding:10px 14px; background:#f6f1ea; border-left:3px solid #a9884f; white-space:pre-wrap;">${esc(text)}</blockquote>
     ${files.length ? `<p>${files.length} file${files.length === 1 ? '' : 's'} attached.</p>` : ''}
     <p>Answer it in Admin → Support.</p>`, me.email || null);
  return { ref: ticket.ref, status: ticket.status };
}

function ticketView(t) {
  return {
    ref: t.ref, category: t.category, categoryLabel: (CATEGORIES[t.category] || {}).label || 'Request',
    subject: t.subject, status: t.status, statusLabel: STATUS_LABELS[t.status] || t.status, role: t.role,
    orderId: t.order_id, listingId: t.listing_id, bookingName: t.suite_name || null, listingName: t.property_name || null,
    createdAt: t.created_at, updatedAt: t.updated_at, callbackPhone: t.callback_phone || null,
    unread: !!(t.last_support_message_at && (!t.user_last_seen_at || new Date(t.last_support_message_at) > new Date(t.user_last_seen_at)))
  };
}

async function listRequests(sql, guestId) {
  try {
    const rows = await sql`
      SELECT t.*, o.suite_name, l.property_name FROM support_tickets t
      LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN listings l ON l.id = t.listing_id
      WHERE t.guest_id = ${guestId} ORDER BY t.updated_at DESC LIMIT 100`;
    return rows.map(ticketView);
  } catch (err) { if (notReady(err)) return []; throw err; }
}

async function ownTicket(sql, guestId, ref) {
  let t;
  try {
    t = (await sql`
      SELECT t.*, o.suite_name, l.property_name FROM support_tickets t
      LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN listings l ON l.id = t.listing_id
      WHERE t.ref = ${String(ref || '').trim().toUpperCase()} AND t.guest_id = ${guestId}`)[0];
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
  return {
    ...ticketView(t), unread: false,
    canReply: t.status !== 'closed', canClose: !['closed'].includes(t.status),
    // Resolved: the person is asked whether it is, and for a rating, before it closes.
    askFeedback: t.status === 'resolved',
    autoCloseAt: t.status === 'resolved' && t.resolved_at ? new Date(new Date(t.resolved_at).getTime() + FEEDBACK_HOURS * 3600e3).toISOString() : null,
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
  await sql`INSERT INTO support_messages (ticket_id, sender, body, attachments) VALUES (${t.id}, 'user', ${body || '(files attached)'}, ${JSON.stringify(files)}::jsonb)`;
  // A reply opens the request again for the team (a resolved one too).
  await sql`UPDATE support_tickets SET last_user_message_at = now(), updated_at = now(), user_last_seen_at = now(),
              status = CASE WHEN status IN ('waiting_on_you', 'resolved') THEN 'open' ELSE status END,
              resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END
            WHERE id = ${t.id}`;
  await logAudit(sql, { action: 'support_request_reply', success: true, actorType: 'guest', actorIdentifier: String(guestId),
    targetType: 'support_ticket', targetId: t.id, metadata: { ref: t.ref, files: files.length } });
  await sendEmail(SUPPORT_INBOX(), `Reply on ${t.ref}: ${t.subject}`,
    `<p>The person replied on <strong>${esc(t.ref)}</strong> (${esc(t.subject)}):</p>
     <blockquote style="margin:12px 0; padding:10px 14px; background:#f6f1ea; border-left:3px solid #a9884f; white-space:pre-wrap;">${esc(body)}</blockquote>
     ${files.length ? `<p>${files.length} file${files.length === 1 ? '' : 's'} attached.</p>` : ''}<p>Answer it in Admin → Support.</p>`);
  return getRequest(sql, guestId, t.ref);
}

// The person's feedback, and with it the end of the request.
//   resolved true:  closes it, with their rating (1–5) and any comment —
//                   asked when Aerva marks it resolved, and whenever they
//                   close it themselves.
//   resolved false: it is not sorted: opens again, with their comment as a
//                   message to the support team.
async function submitFeedback(sql, { guestId, ref, resolved, rating, comment }) {
  const t = await ownTicket(sql, guestId, ref);
  if (t.status === 'closed') throw userError('This request is already closed.', 409);
  const note = clean(comment, 1000);
  if (resolved === false) {
    if (note.length < 5) throw userError('Tell us what is still not right, so we can pick it up again.');
    await sql`INSERT INTO support_messages (ticket_id, sender, body) VALUES (${t.id}, 'user', ${note})`;
    try {
      await sql`UPDATE support_tickets SET status = 'open', resolved_at = NULL, updated_at = now(), last_user_message_at = now(), user_last_seen_at = now(),
                  feedback_resolved = false, feedback_rating = NULL, feedback_comment = ${note}, feedback_at = now()
                WHERE id = ${t.id}`;
    } catch (err) {
      if (!notReady(err)) throw err;      // before migration_support_cases.sql: reopened without the feedback columns
      await sql`UPDATE support_tickets SET status = 'open', resolved_at = NULL, updated_at = now(), last_user_message_at = now(), user_last_seen_at = now() WHERE id = ${t.id}`;
    }
    await sql`INSERT INTO support_messages (ticket_id, sender, body) VALUES (${t.id}, 'system', 'You said this is not resolved. It is open again.')`;
    await logAudit(sql, { action: 'support_feedback', success: true, actorType: 'guest', actorIdentifier: String(guestId),
      targetType: 'support_ticket', targetId: t.id, metadata: { ref: t.ref, resolved: false } });
    await sendEmail(SUPPORT_INBOX(), `Reopened ${t.ref}: not resolved`, `<p>The person says <strong>${esc(t.ref)}</strong> (${esc(t.subject)}) is not resolved:</p>
      <blockquote style="margin:12px 0; padding:10px 14px; background:#f6f1ea; border-left:3px solid #a9884f; white-space:pre-wrap;">${esc(note)}</blockquote><p>It is open again in Admin → Support.</p>`);
    return getRequest(sql, guestId, t.ref);
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
  await sql`INSERT INTO support_messages (ticket_id, sender, body) VALUES (${t.id}, 'system', ${`You confirmed this is resolved and closed it. Your rating: ${stars} of 5.`})`;
  await logAudit(sql, { action: 'support_feedback', success: true, actorType: 'guest', actorIdentifier: String(guestId),
    targetType: 'support_ticket', targetId: t.id, metadata: { ref: t.ref, resolved: true, rating: stars } });
  return getRequest(sql, guestId, t.ref);
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
                     RETURNING id, ref, subject, guest_id`;
  } catch (err) { if (notReady(err)) return { closed: 0 }; throw err; }
  for (const t of rows) {
    await sql`INSERT INTO support_messages (ticket_id, sender, body) VALUES (${t.id}, 'system', ${`Closed automatically ${FEEDBACK_HOURS} hours after it was resolved, with no feedback.`})`;
    await logAudit(sql, { action: 'support_auto_closed', success: true, actorType: 'system', actorIdentifier: 'support',
      targetType: 'support_ticket', targetId: t.id, metadata: { ref: t.ref } });
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
    const rows = await sql`SELECT ref, subject, last_support_message_at FROM support_tickets
                           WHERE guest_id = ${guestId} AND last_support_message_at IS NOT NULL
                             AND (user_last_seen_at IS NULL OR last_support_message_at > user_last_seen_at)
                           ORDER BY last_support_message_at DESC LIMIT 5`;
    const out = rows.map(r => ({
      id: 'support:' + r.ref + ':' + new Date(r.last_support_message_at).getTime(), kind: 'support',
      title: `Aerva Support replied: ${r.ref}`, body: r.subject,
      href: `index.html?view=help&request=${encodeURIComponent(r.ref)}`
    }));
    // Resolved and waiting for the person's word (closes by itself after 48 hours).
    const res = await sql`SELECT ref, subject, resolved_at FROM support_tickets WHERE guest_id = ${guestId} AND status = 'resolved' ORDER BY resolved_at DESC LIMIT 5`;
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
             (to_jsonb(t)->>'feedback_rating')::int AS feedback_rating, (to_jsonb(t)->>'auto_closed')::boolean AS auto_closed,
             t.created_at, t.updated_at, t.first_response_at, t.last_user_message_at, t.last_support_message_at,
             g.name AS person_name, g.email AS person_email,
             (t.first_response_at IS NULL AND t.status NOT IN ('resolved', 'closed')
               AND t.created_at < now() - make_interval(hours => ${FIRST_RESPONSE_HOURS})) AS overdue,
             (t.last_user_message_at IS NOT NULL AND (t.last_support_message_at IS NULL OR t.last_user_message_at > t.last_support_message_at)) AS awaiting_us
      FROM support_tickets t LEFT JOIN guests g ON g.id = t.guest_id
      WHERE (${want}::text[] IS NULL OR t.status = ANY(${want}::text[]))
        AND (${term} = '' OR t.ref ILIKE ${'%' + term + '%'} OR t.subject ILIKE ${'%' + term + '%'} OR g.email ILIKE ${'%' + term + '%'} OR g.name ILIKE ${'%' + term + '%'})
      ORDER BY (t.category = 'safety' AND t.status NOT IN ('resolved', 'closed')) DESC, (t.first_response_at IS NULL) DESC, t.updated_at DESC LIMIT 200`;
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
           l.property_name, l.status AS listing_status
    FROM support_tickets t LEFT JOIN guests g ON g.id = t.guest_id
    LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN listings l ON l.id = COALESCE(t.listing_id, o.listing_id)
    WHERE t.id = ${Number(id) || 0}`)[0];
  if (!t) throw userError('Request not found.', 404);
  const msgs = await sql`SELECT id, sender, internal, admin_email, body, attachments, created_at FROM support_messages WHERE ticket_id = ${t.id} ORDER BY created_at, id`;
  let caseNotes = [];
  try { caseNotes = await sql`SELECT * FROM support_case_notes WHERE ticket_id = ${t.id} ORDER BY created_at DESC, id DESC`; } catch (err) { if (!notReady(err)) throw err; }
  return { ticket: { ...t, categoryLabel: (CATEGORIES[t.category] || {}).label || t.category }, messages: msgs, statuses: STATUS_LABELS,
           caseNotes, caseRecord: caseNotes[0] || null, conduct: CONDUCT, otherParty: !!(t.order_id || t.listing_id) };
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
  if (t.person_email && (replied || (next !== t.status && ['resolved', 'closed', 'waiting_on_you'].includes(next)))) {
    const what = replied ? 'Aerva Support has replied' : `Your request is now: ${STATUS_LABELS[next]}`;
    await sendEmail(t.person_email, `${what} — ${t.ref}`,
      `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">${esc(what)}</h2>
       <p><strong>${esc(t.subject)}</strong> · ${esc(t.ref)}</p>
       ${replied ? `<blockquote style="margin:12px 0; padding:10px 14px; background:#f6f1ea; border-left:3px solid #a9884f; white-space:pre-wrap;">${esc(body)}</blockquote>` : ''}
       ${next === 'resolved' ? `<p><strong>Is it sorted?</strong> Tell us on the request — confirm it is resolved and rate how we did, or say what is still not right and it opens again. If we do not hear from you, it closes by itself in ${FEEDBACK_HOURS} hours.</p>` : ''}
       ${button(requestLink(t.ref), next === 'closed' ? 'View your request' : next === 'resolved' ? 'Tell us how we did' : 'View and reply')}
       <p style="font-size:13px; color:#6e675d;">Please reply on the request page rather than to this email, so everything stays in one place.</p>`);
  }
  return adminGet(sql, t.id);
}

// Deleting an account: what the person wrote goes; the record that a
// request existed stays (without their words), like booking records.
async function eraseForAccount(sql, guestId) {
  try {
    await sql`UPDATE support_messages m SET body = '[deleted]', attachments = '[]'::jsonb
              FROM support_tickets t WHERE m.ticket_id = t.id AND t.guest_id = ${guestId} AND m.sender = 'user'`;
    await sql`UPDATE support_tickets SET subject = '[deleted]', callback_phone = NULL WHERE guest_id = ${guestId}`;
    try { await sql`UPDATE support_tickets SET feedback_comment = NULL WHERE guest_id = ${guestId}`; } catch (e) { /* before migration_support_cases.sql */ }
  } catch (err) { if (!notReady(err)) throw err; }
}

module.exports = {
  CATEGORIES, STATUS_LABELS, STATUSES, FIRST_RESPONSE_HOURS, MAX_NEW_PER_DAY,
  CONDUCT, FEEDBACK_HOURS,
  requestOptions, createRequest, listRequests, getRequest, replyToRequest, closeRequest, submitFeedback, autoCloseResolved, bellNotifications,
  adminList, adminGet, adminReply, adminSaveCase, eraseForAccount, cleanFiles
};
