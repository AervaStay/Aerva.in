// /api/_gifts.js — gift bookings ("This stay is for someone else").
// Not an endpoint (leading underscore). Owner's rules, 9 Nov 2026 (revised
// 23:27 and 23:28 the same night):
//
//   • The BUYER keeps the booking: changes, cancellations, transfers and
//     refunds stay with the buyer's account and payment; invoices stay in
//     the buyer's name (orders.guest_id / guest_email are never changed).
//   • The RECIPIENT is the guest staying. orders.guest_first_name /
//     guest_last_name carry the recipient's name, so every host view shows
//     who arrives, marked "Gift — booked by <buyer first name>".
//   • The recipient gets an email (the stay, dates, address, check-in
//     details, confirmation code, the gift message, the buyer's first name —
//     never the price) with a link: index.html?gift=<token>.
//   • ACCEPTING is an explicit step. The recipient must sign in (or create an
//     account), give their first and last name (letters only, as on Profile)
//     and a phone the host can reach them on. Until then the host sees
//     "Gift, not yet accepted" and no phone; the buyer sees "waiting for
//     <name> to accept". Accepting from an account whose confirmed email is
//     the gift's email works from My Bookings too; from any other account it
//     works only through the link's token — single-use, tied to the booking,
//     ending at check-out — and the accepting account is recorded.
//   • Reminders when not accepted: 3 days before check-in and the day
//     before, to the recipient, and the buyer is told the same.
//   • The buyer may change the recipient until check-in (a new link; the old
//     one stops working; any acceptance is reset) or stop the gift.
//
// The price is hidden everywhere the recipient sees the booking: the gift
// pages, My Bookings ("Gifted to you") and the booking's Messages.

const { helpLine } = require('./_help-link');
const crypto = require('crypto');
const { logAudit } = require('./_audit-log');
const { redactContactInfo } = require('./_redact');
const { normalizeToE164 } = require('./_phone-validation');
const { dateStr, checkInMomentMs } = require('./_booking-rules');

const MESSAGE_MAX = 300;
const userError = (message, status = 400, extra = {}) => Object.assign(new Error(message), { isUserFacing: true, status }, extra);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const NOT_ON = 'Gift bookings are not switched on yet. Please try again later.';

async function ready(sql) {
  try { await sql`SELECT 1 FROM booking_gifts LIMIT 0`; return true; } catch (err) { return false; }
}

// ---- Names, as on a government ID (same rule as Profile → saveName) ----
function cleanName(v) {
  return typeof v === 'string' ? v.normalize('NFC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim() : '';
}
function nameProblem(v, label) {
  if (!v) return `Please enter the ${label}.`;
  if ([...v].length > 50) return `The ${label} can be at most 50 characters.`;
  if (/\d/u.test(v)) return `The ${label} cannot contain numbers — please write it as on the government ID.`;
  if (!/^[\p{L}\p{M} .'-]+$/u.test(v)) return `The ${label} can only have letters, spaces, dots, apostrophes and hyphens.`;
  if (!/\p{L}/u.test(v)) return `Please enter the ${label} with letters.`;
  return null;
}
function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase().slice(0, 200);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}
// A gift message: at most 300 characters, contact details removed exactly
// as in Messages (_redact.js).
function cleanMessage(v) {
  const raw = String(v || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  if ([...raw].length > MESSAGE_MAX) throw userError(`The gift message can be at most ${MESSAGE_MAX} characters.`);
  const out = redactContactInfo(raw);
  const text = typeof out === 'string' ? out : (out && (out.displayText || out.text || out.redacted)) || raw;
  return String(text).slice(0, 600);
}

// What the buyer typed: { firstName, lastName, email, phone?, message? }.
// The phone is optional for the buyer (the recipient confirms one when
// accepting); when given it must be a real number.
function parseRecipient(input) {
  const i = input && typeof input === 'object' ? input : {};
  const first = cleanName(i.firstName), last = cleanName(i.lastName);
  const bad = nameProblem(first, 'recipient’s first name') || nameProblem(last, 'recipient’s last name');
  if (bad) throw userError(bad, 400, { needs: ['giftName'] });
  const email = cleanEmail(i.email);
  if (!email) throw userError('Please enter the recipient’s email address.', 400, { needs: ['giftEmail'] });
  let phone = null;
  if (String(i.phone || '').trim()) {
    phone = normalizeToE164(String(i.phone).slice(0, 40));
    if (!phone) throw userError('Please enter a valid mobile number for the recipient, with the country code if outside India — or leave it empty.', 400, { needs: ['giftPhone'] });
  }
  return { first, last, email, phone, message: cleanMessage(i.message) };
}

// ---- Email ----
async function sendMail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html })
    });
    return !!(r && r.ok);
  } catch (err) { console.error('gift email failed:', err.message); return false; }
}
const frame = (title, body) => `<div style="font-family:sans-serif; max-width:520px;"><h2 style="font-family:Georgia,serif;">${title}</h2>${body}
  <p style="font-size:12px; opacity:0.6; margin-top:24px;">${helpLine({}, 'Questions?')}</p></div>`;
const giftLink = (token) => `https://aerva.in/index.html?gift=${encodeURIComponent(token)}`;
const niceDate = (d) => { const s = dateStr(d); return s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : ''; };

// The booking a gift is for, with what a guest staying is told (no money).
async function stayFor(sql, orderId) {
  return (await sql`
    SELECT o.id, o.status, o.suite_name, o.arrival, o.departure, o.nights, o.guests, o.guest_id, o.guest_email,
           o.razorpay_order_id, to_jsonb(o)->>'confirmation_code' AS confirmation_code,
           to_jsonb(o)->>'group_booking_id' AS group_booking_id, to_jsonb(o)->>'transfer_change_id' AS transfer_change_id,
           l.id AS listing_id, l.property_name, l.city, to_jsonb(l)->>'area' AS area, l.formatted_address, l.host_id,
           l.check_in_time, l.check_out_time, l.timezone, l.host_email, l.cover_photo_url,
           COALESCE(l.listing_type, 'stay') AS listing_type,
           -- A transferred booking is several rows on this payment: the gift lasts until the last part still booked ends.
           (SELECT max(p.departure) FROM orders p WHERE p.razorpay_order_id = o.razorpay_order_id AND p.status = 'paid') AS last_departure,
           (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date AS local_today
    FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${orderId}`)[0] || null;
}
const beforeCheckout = (s) => !!s && (s.last_departure ? dateStr(s.last_departure) > dateStr(s.local_today) : (s.status === 'paid' && dateStr(s.departure) > dateStr(s.local_today)));
const beforeCheckin = (s) => s && s.status === 'paid' && Date.now() < checkInMomentMs(s.arrival, s.timezone, s.check_in_time);

function stayBlock(s, { address = true, code = true } = {}) {
  return `<div style="background:#f6efe3; border:1px solid #e0cda8; border-radius:10px; padding:14px 16px; margin:14px 0;">
    <p style="margin:0 0 4px; font-size:17px; font-weight:600;">${esc(s.property_name || s.suite_name)}</p>
    <p style="margin:0;">${esc(niceDate(s.arrival))} → ${esc(niceDate(s.departure))} · ${Number(s.nights) || 0} night${Number(s.nights) === 1 ? '' : 's'} · ${Number(s.guests) || 1} guest${Number(s.guests) === 1 ? '' : 's'}</p>
    ${s.check_in_time || s.check_out_time ? `<p style="margin:4px 0 0;">Check-in from ${esc(s.check_in_time || '2:00 PM')} · check-out by ${esc(s.check_out_time || '11:00 AM')}</p>` : ''}
    ${address ? `<p style="margin:4px 0 0;">${esc(s.formatted_address || [s.area, s.city].filter(Boolean).join(', '))}</p>` : `<p style="margin:4px 0 0;">${esc([s.area, s.city].filter(Boolean).join(', '))}</p>`}
    ${code && s.confirmation_code ? `<p style="margin:8px 0 0; font-size:13px; color:#6b5222;">Confirmation code — show this at check-in: <strong style="font-size:17px; color:#1c1b19;">${esc(s.confirmation_code)}</strong></p>` : ''}
  </div>`;
}

async function sendRecipientEmail(g, s, token, { changed = false } = {}) {
  const who = g.buyer_first_name || 'Someone';
  const html = frame(`${esc(who)} sent you a stay on Aerva`, `
    <p>Hello ${esc(g.recipient_first_name)},</p>
    <p><strong>${esc(who)}</strong> has booked a stay for you${changed ? ' (the booking was just passed to you)' : ''}.</p>
    ${stayBlock(s)}
    ${g.message ? `<p style="border-left:3px solid #A9885A; padding-left:10px; font-style:italic;">“${esc(g.message)}”<br><span style="font-style:normal; font-size:13px;">— ${esc(who)}</span></p>` : ''}
    <p><strong>Please accept the gift</strong> so your host knows you are the guest and has a number to reach you. Sign in or create an Aerva account, add your name as on your government ID and your mobile number, then accept.</p>
    <p><a href="${giftLink(token)}" style="display:inline-block; background:#1C1B19; color:#fff; padding:12px 20px; border-radius:8px; text-decoration:none;">Accept the gift</a></p>
    <p style="font-size:13px;">Your host checks a government photo ID at check-in: please carry yours. ${esc(who)} manages the booking (dates, changes and cancellations).</p>
    <p style="font-size:12px; opacity:0.7;">This link works once and only for this booking, until check-out.</p>`);
  return sendMail(g.recipient_email, `${who} sent you a stay at ${s.property_name || s.suite_name}`, html);
}

// ---- Which gift covers a booking row (any row of the same purchase) ----
async function giftForOrder(sql, orderId) {
  try {
    return (await sql`SELECT g.* FROM booking_gifts g JOIN orders a ON a.id = g.order_id
                      JOIN orders b ON b.razorpay_order_id = a.razorpay_order_id
                      WHERE b.id = ${orderId} AND g.status <> 'withdrawn' ORDER BY g.id DESC LIMIT 1`)[0] || null;
  } catch (err) { return null; }
}

// Writes the recipient's name onto every row of the purchase (the guest
// staying), or the buyer's own name back when a gift is stopped.
async function setStayingName(sql, orderId, first, last) {
  try {
    await sql`UPDATE orders SET guest_first_name = ${first}, guest_last_name = ${last}
              WHERE razorpay_order_id = (SELECT razorpay_order_id FROM orders WHERE id = ${orderId})`;
  } catch (err) { console.error('gift: staying name not written:', orderId, err.message); }
}

// ---- Creating a gift: at checkout (from _confirm-booking.js, after the
// booking is paid) or later from My Bookings (sendGift). ----
async function createGift(sql, { orderId, buyerGuestId, buyerFirst, recipient, source = 'checkout' }) {
  const token = newToken();
  const row = (await sql`
    INSERT INTO booking_gifts (order_id, buyer_guest_id, buyer_first_name, recipient_first_name, recipient_last_name, recipient_email, recipient_phone, message, token_hash)
    VALUES (${orderId}, ${buyerGuestId}, ${buyerFirst || null}, ${recipient.first}, ${recipient.last}, ${recipient.email}, ${recipient.phone || null}, ${recipient.message || null}, ${hashToken(token)})
    ON CONFLICT (order_id) WHERE status <> 'withdrawn' DO NOTHING RETURNING *`)[0];
  if (!row) throw userError('This booking is already a gift. Change the recipient instead.', 409);
  await setStayingName(sql, orderId, recipient.first, recipient.last);
  const s = await stayFor(sql, orderId);
  const sent = s ? await sendRecipientEmail(row, s, token) : false;
  await logAudit(sql, { action: 'gift_created', success: true, actorType: 'guest', actorIdentifier: String(buyerGuestId), targetType: 'order', targetId: orderId,
    metadata: { giftId: row.id, source, recipientEmail: recipient.email, emailed: sent } });
  return { gift: row, token };
}

// Buyer's first name, for "booked by …".
async function buyerFirstName(sql, guestId, fallback) {
  try {
    const g = (await sql`SELECT name, to_jsonb(guests)->>'first_name' AS first_name FROM guests WHERE id = ${guestId}`)[0];
    return (g && (g.first_name || String(g.name || '').trim().split(/\s+/)[0])) || fallback || null;
  } catch (err) { return fallback || null; }
}

// From My Bookings: make an upcoming booking a gift, or change who it is
// for. Buyer only, paid, before the check-in moment. Not for a group
// booking (shared already) or a booking split by a transfer.
async function sendGift(sql, { orderId, guestId, input }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  const s = await stayFor(sql, orderId);
  if (!s || Number(s.guest_id) !== Number(guestId)) throw userError('Booking not found.', 404);
  if (s.listing_type !== 'stay') throw userError('Only stays can be sent as a gift.');
  if (s.group_booking_id) throw userError('A group booking cannot be sent as a gift.');
  if (!beforeCheckin(s)) throw userError('A booking can be sent as a gift only before check-in.');
  const recipient = parseRecipient(input);
  const me = (await sql`SELECT email FROM guests WHERE id = ${guestId}`)[0] || {};
  if (String(me.email || '').toLowerCase() === recipient.email) throw userError('That is your own email. A gift goes to someone else.');
  const current = await giftForOrder(sql, orderId);
  const buyerFirst = await buyerFirstName(sql, guestId, null);
  // A booking split by a transfer is final (it cannot be changed in any way):
  // it cannot be made a gift afterwards. A gift made before the transfer stays one.
  if (!current && s.transfer_change_id) throw userError('This booking was transferred, so it can no longer be sent as a gift.');
  if (!current) {
    // As My Bookings shows (can_gift): a booking split by a transfer cannot be made a gift.
    if (s.transfer_change_id) throw userError('A transferred booking cannot be sent as a gift.');
    const out = await createGift(sql, { orderId: s.id, buyerGuestId: guestId, buyerFirst, recipient, source: 'my_bookings' });
    return { gift: buyerView(out.gift) };
  }
  // Changing the recipient: a new link (the old one stops working), and any
  // acceptance is undone — the new person accepts for themselves.
  const token = newToken();
  const wasAccepted = current.status === 'accepted';
  const upd = (await sql`
    UPDATE booking_gifts SET recipient_first_name = ${recipient.first}, recipient_last_name = ${recipient.last}, recipient_email = ${recipient.email},
      recipient_phone = ${recipient.phone || null}, message = ${recipient.message || null}, token_hash = ${hashToken(token)}, token_used_at = NULL,
      status = 'sent', accepted_guest_id = NULL, accepted_at = NULL, accepted_first_name = NULL, accepted_last_name = NULL, accepted_phone = NULL, accepted_via = NULL,
      reminded_3d_at = NULL, reminded_1d_at = NULL, version = version + 1, updated_at = now(), buyer_first_name = COALESCE(${buyerFirst}, buyer_first_name)
    WHERE id = ${current.id} AND version = ${current.version} AND status <> 'withdrawn' RETURNING *`)[0];
  if (!upd) throw userError('This gift was just changed. Please refresh and try again.', 409);
  await setStayingName(sql, current.order_id, recipient.first, recipient.last);
  await sendRecipientEmail(upd, s, token);
  if (current.recipient_email !== recipient.email) {
    await sendMail(current.recipient_email, `Update about your stay at ${s.property_name}`, frame('A change to your gift',
      `<p>Hello ${esc(current.recipient_first_name)},</p><p>${esc(current.buyer_first_name || 'The person who booked it')} has passed the stay at <strong>${esc(s.property_name)}</strong> (${esc(niceDate(s.arrival))}) to someone else, so it is no longer gifted to you. Your link no longer works.</p>`));
  }
  if (wasAccepted) await tellHost(sql, s, `The guest staying for this booking has changed. The new guest has not accepted yet, so there is no phone number for them for now. Booked by ${esc(upd.buyer_first_name || 'the buyer')}.`, 'Guest changed on a gifted booking');
  await logAudit(sql, { action: 'gift_recipient_changed', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'order', targetId: s.id,
    metadata: { giftId: upd.id, from: current.recipient_email, to: recipient.email, wasAccepted } });
  return { gift: buyerView(upd) };
}

// Stop the gift: the buyer is the guest staying again.
async function withdrawGift(sql, { orderId, guestId }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  const s = await stayFor(sql, orderId);
  if (!s || Number(s.guest_id) !== Number(guestId)) throw userError('Booking not found.', 404);
  if (!beforeCheckin(s)) throw userError('A gift can be stopped only before check-in.');
  const g = await giftForOrder(sql, orderId);
  if (!g) throw userError('This booking is not a gift.', 404);
  const done = await sql`UPDATE booking_gifts SET status = 'withdrawn', token_hash = ${'withdrawn:' + g.id + ':' + Date.now()}, updated_at = now()
                         WHERE id = ${g.id} AND status <> 'withdrawn' RETURNING id`;
  if (!done.length) return { withdrawn: true };
  const me = (await sql`SELECT name, to_jsonb(guests)->>'first_name' AS f, to_jsonb(guests)->>'last_name' AS l FROM guests WHERE id = ${guestId}`)[0] || {};
  const parts = String(me.name || '').trim().split(/\s+/);
  await setStayingName(sql, g.order_id, me.f || parts[0] || null, me.l || parts.slice(1).join(' ') || null);
  await sendMail(g.recipient_email, `Update about your stay at ${s.property_name}`, frame('A change to your gift',
    `<p>Hello ${esc(g.recipient_first_name)},</p><p>${esc(g.buyer_first_name || 'The person who booked it')} has taken back the stay at <strong>${esc(s.property_name)}</strong> (${esc(niceDate(s.arrival))}). Your link no longer works.</p>`));
  if (g.status === 'accepted') await tellHost(sql, s, 'This booking is no longer a gift: the person who booked it is now the guest staying.', 'Gifted booking: guest changed');
  await logAudit(sql, { action: 'gift_withdrawn', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'order', targetId: s.id, metadata: { giftId: g.id } });
  return { withdrawn: true };
}

async function tellHost(sql, s, text, subject) {
  try {
    const to = s.host_email || ((await sql`SELECT email FROM guests WHERE host_id = ${s.host_id} ORDER BY id LIMIT 1`)[0] || {}).email;
    await sendMail(to, subject + ` — ${s.property_name}`, frame(esc(subject), `<p><strong>${esc(s.property_name)}</strong> · ${esc(niceDate(s.arrival))} → ${esc(niceDate(s.departure))}${s.confirmation_code ? ` · code ${esc(s.confirmation_code)}` : ''}</p><p>${text}</p>`));
  } catch (err) { console.error('gift host email failed:', err.message); }
}

// ---- The recipient's side ----
// By link token (a hash lookup) or, from My Bookings, by gift id for the
// account whose confirmed email the gift was sent to.
async function findGift(sql, { token, giftId }) {
  if (token) {
    const t = String(token).trim();
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(t)) return null;
    return (await sql`SELECT * FROM booking_gifts WHERE token_hash = ${hashToken(t)} AND status <> 'withdrawn'`)[0] || null;
  }
  if (giftId) return (await sql`SELECT * FROM booking_gifts WHERE id = ${Number(giftId) || 0} AND status <> 'withdrawn'`)[0] || null;
  return null;
}
async function accountOf(sql, guestId) {
  return (await sql`SELECT id, email, phone, name, to_jsonb(guests)->>'first_name' AS first_name, to_jsonb(guests)->>'last_name' AS last_name,
                           (to_jsonb(guests)->>'email_verified_at') IS NOT NULL OR (to_jsonb(guests)->>'email_verified')::boolean IS TRUE AS email_ok
                    FROM guests WHERE id = ${guestId} AND deleted_at IS NULL`)[0] || null;
}
const emailMatches = (acct, g) => !!(acct && acct.email_ok && String(acct.email || '').toLowerCase() === String(g.recipient_email || '').toLowerCase());

// What the landing page shows before sign-in: the stay (no address, no
// price, no code), who sent it and the message. Public — the token is the key.
async function publicView(sql, token) {
  if (!(await ready(sql))) return { error: NOT_ON, status: 503 };
  const g = await findGift(sql, { token });
  if (!g) return { error: 'This gift link is not valid any more. Ask the person who sent it for a new one.', status: 404 };
  const s = await stayFor(sql, g.order_id);
  if (!s || !beforeCheckout(s)) return { error: 'This stay is over or was cancelled, so the gift link has ended.', status: 410 };
  return {
    gift: { from: g.buyer_first_name || 'Someone', to: g.recipient_first_name, message: g.message || null,
            accepted: g.status === 'accepted', linkUsed: !!g.token_used_at,
            // The link was sent to this address: its holder may see it (to sign up with it).
            email: g.recipient_email, emailHint: maskEmail(g.recipient_email) },
    stay: { name: s.property_name, city: s.city || null, area: s.area || null, arrival: dateStr(s.arrival), departure: dateStr(s.departure),
            nights: Number(s.nights) || null, guests: Number(s.guests) || null, checkIn: s.check_in_time || null, checkOut: s.check_out_time || null,
            photo: s.cover_photo_url || null }
  };
}
function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  return u && d ? (u.slice(0, 2) + '•••@' + d) : '';
}

// Signed in: may this account accept, and what is prefilled.
async function viewForAccount(sql, { guestId, token, giftId }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  const g = await findGift(sql, { token, giftId });
  if (!g) throw userError('This gift link is not valid any more. Ask the person who sent it for a new one.', 404);
  const acct = await accountOf(sql, guestId);
  const s = await stayFor(sql, g.order_id);
  if (!s || !beforeCheckout(s)) throw userError('This stay is over or was cancelled, so the gift has ended.', 410);
  const mine = g.status === 'accepted' && Number(g.accepted_guest_id) === Number(guestId);
  const byEmail = emailMatches(acct, g);
  const isBuyer = Number(s.guest_id) === Number(guestId);
  if (!token && !byEmail && !mine) throw userError('Gift not found.', 404);
  const parts = String((acct && acct.name) || '').trim().split(/\s+/).filter(Boolean);
  return {
    giftId: g.id, from: g.buyer_first_name || 'Someone', message: g.message || null,
    status: mine ? 'accepted_by_you' : g.status === 'accepted' ? 'accepted_by_other' : 'waiting',
    canAccept: !isBuyer && g.status === 'sent' && (byEmail || (!!token && !g.token_used_at)),
    isBuyer, emailMatches: byEmail,
    prefill: { firstName: (acct && acct.first_name) || parts[0] || g.recipient_first_name || '', lastName: (acct && acct.last_name) || parts.slice(1).join(' ') || g.recipient_last_name || '',
               phone: (acct && acct.phone) || g.recipient_phone || '' },
    stay: recipientStay(s, mine)
  };
}
// The stay as the recipient sees it: never any money. The address and the
// code once they have accepted (they are also in the gift email).
function recipientStay(s, accepted) {
  return { orderId: accepted ? s.id : undefined, name: s.property_name, city: s.city || null, area: s.area || null,
           address: accepted ? (s.formatted_address || null) : null, arrival: dateStr(s.arrival), departure: dateStr(s.departure),
           nights: Number(s.nights) || null, guests: Number(s.guests) || null, checkIn: s.check_in_time || null, checkOut: s.check_out_time || null,
           confirmationCode: accepted ? (s.confirmation_code || null) : null, photo: s.cover_photo_url || null };
}

// Accept: { token | giftId, firstName, lastName, phone }.
async function acceptGift(sql, { guestId, token, giftId, firstName, lastName, phone, ip }) {
  if (!(await ready(sql))) throw userError(NOT_ON, 503);
  const g = await findGift(sql, { token, giftId });
  if (!g) throw userError('This gift link is not valid any more. Ask the person who sent it for a new one.', 404);
  const acct = await accountOf(sql, guestId);
  if (!acct) throw userError('Please log in again.', 401);
  const s = await stayFor(sql, g.order_id);
  if (!s || !beforeCheckout(s)) throw userError('This stay is over or was cancelled, so the gift has ended.', 410);
  if (Number(s.guest_id) === Number(guestId)) throw userError('This is your own booking — the gift is for the person you sent it to.', 400);
  if (g.status === 'accepted') {
    if (Number(g.accepted_guest_id) === Number(guestId)) return { accepted: true, already: true, stay: recipientStay(s, true) };
    throw userError('This gift has already been accepted.', 409);
  }
  const byEmail = emailMatches(acct, g);
  if (!byEmail) {
    // Another account: only through the link, once.
    if (!token) throw userError('Open the link in the gift email to accept it from this account.', 403);
    if (g.token_used_at) throw userError('This gift link has already been used.', 409);
  }
  const first = cleanName(firstName), last = cleanName(lastName);
  const bad = nameProblem(first, 'first name') || nameProblem(last, 'last name');
  if (bad) throw userError(bad, 400, { needs: ['name'] });
  const e164 = normalizeToE164(String(phone || '').slice(0, 40));
  if (!e164) throw userError('Please enter a valid mobile number your host can reach you on, with the country code if you are outside India.', 400, { needs: ['phone'] });
  const via = byEmail ? 'email' : 'token';
  const done = (await sql`
    UPDATE booking_gifts SET status = 'accepted', accepted_guest_id = ${guestId}, accepted_at = now(), accepted_first_name = ${first}, accepted_last_name = ${last},
      accepted_phone = ${e164}, accepted_via = ${via}, token_used_at = CASE WHEN ${!!token} THEN now() ELSE token_used_at END, updated_at = now()
    WHERE id = ${g.id} AND status = 'sent' AND version = ${g.version} AND (${via} = 'email' OR token_used_at IS NULL) RETURNING *`)[0];
  if (!done) throw userError('This gift was just changed or accepted. Please refresh.', 409);
  // Their account: the name if it has none; the phone if it has none and no
  // other account uses it (otherwise it stays on this booking only).
  let phoneSaved = false;
  try {
    if (!acct.first_name && !acct.last_name) await sql`UPDATE guests SET first_name = ${first}, last_name = ${last}, name = COALESCE(NULLIF(btrim(name), ''), ${first + ' ' + last}) WHERE id = ${guestId}`;
  } catch (err) { /* before migration_guest_details.sql */ }
  try {
    const d = e164.replace(/\D/g, '');
    const r = await sql`UPDATE guests SET phone = ${e164} WHERE id = ${guestId} AND (phone IS NULL OR btrim(phone) = '')
      AND NOT EXISTS (SELECT 1 FROM guests o WHERE o.id <> ${guestId} AND o.deleted_at IS NULL AND o.phone IS NOT NULL AND regexp_replace(o.phone, '[^0-9]', '', 'g') IN (${d}, ${d.startsWith('91') ? d.slice(2) : d}))
      RETURNING id`;
    phoneSaved = r.length > 0;
  } catch (err) { phoneSaved = false; }
  await setStayingName(sql, g.order_id, first, last);
  await tellHost(sql, s, `<strong>${esc(first + ' ' + last)}</strong> accepted the gift and is the guest staying (booked by ${esc(g.buyer_first_name || 'the buyer')}). Mobile: <strong>${esc(e164)}</strong>. Check their government photo ID at check-in.`, 'Gift accepted: your guest’s details');
  const buyer = (await sql`SELECT email FROM guests WHERE id = ${s.guest_id}`)[0] || {};
  await sendMail(buyer.email || s.guest_email, `${first} accepted your gift`, frame(`${esc(first)} accepted your gift`,
    `<p>${esc(first + ' ' + last)} accepted the stay at <strong>${esc(s.property_name)}</strong> (${esc(niceDate(s.arrival))} → ${esc(niceDate(s.departure))}). Their host now has their name and number.</p><p>You still manage the booking from My Bookings.</p>`));
  await logAudit(sql, { action: 'gift_accepted', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'order', targetId: s.id,
    metadata: { giftId: g.id, via, giftEmail: g.recipient_email, accountEmail: acct.email, phoneSavedToAccount: phoneSaved, ip: ip || null } });
  return { accepted: true, phoneSavedToAccount: phoneSaved, stay: recipientStay(s, true) };
}

// ---- What each side sees ----
function buyerView(g) {
  if (!g) return null;
  const name = g.status === 'accepted' ? [g.accepted_first_name, g.accepted_last_name].join(' ') : [g.recipient_first_name, g.recipient_last_name].join(' ');
  return { id: g.id, status: g.status, recipientName: name, recipientFirstName: g.status === 'accepted' ? g.accepted_first_name : g.recipient_first_name,
           recipientEmail: g.recipient_email, message: g.message || null, acceptedAt: g.accepted_at || null,
           note: g.status === 'accepted' ? `Gift accepted by ${g.accepted_first_name}` : `Waiting for ${g.recipient_first_name} to accept` };
}

// My Bookings: the buyer's own bookings get their gift; the recipient's
// accepted gifts (and gifts waiting for them at their confirmed email) are
// added as "Gifted to you" — no money, no change/cancel actions.
async function decorateBookings(sql, guestId, bookings) {
  if (!(await ready(sql))) return bookings;
  try {
    const ids = bookings.map(b => Number(b.id)).filter(n => Number.isInteger(n) && n > 0);
    if (ids.length) {
      const gifts = await sql`SELECT b.id AS row_id, g.* FROM booking_gifts g JOIN orders a ON a.id = g.order_id
                              JOIN orders b ON b.razorpay_order_id = a.razorpay_order_id
                              WHERE b.id = ANY(${ids}) AND g.status <> 'withdrawn'`;
      const by = new Map(gifts.map(x => [Number(x.row_id), x]));
      bookings.forEach(b => {
        const g = by.get(Number(b.id));
        if (g) b.gift = buyerView(g);
        b.can_gift = !g && !b.group && b.status === 'paid' && (b.listing_type || 'stay') === 'stay' && !b.transfer_change_id
                     && String(b.arrival).slice(0, 10) > String(b.local_today || '').slice(0, 10);
        if (g) b.can_change_gift = b.status === 'paid' && String(b.arrival).slice(0, 10) > String(b.local_today || '').slice(0, 10);
      });
    }
    const acct = await accountOf(sql, guestId);
    const theirs = await sql`
      SELECT g.*, o.id AS oid FROM booking_gifts g JOIN orders o ON o.id = g.order_id
      WHERE g.status <> 'withdrawn' AND o.guest_id <> ${guestId}
        AND (g.accepted_guest_id = ${guestId} OR (g.status = 'sent' AND ${!!(acct && acct.email_ok)} AND lower(g.recipient_email) = ${String((acct && acct.email) || '').toLowerCase()}))`;
    for (const g of theirs) {
      // Every booking of the purchase: a gifted booking split by a transfer
      // (_booking-transfers.js) is several linked bookings, each with its own
      // property, address and code — the guest staying needs them all.
      const first = await stayFor(sql, g.oid);
      if (!first) continue;
      let rowIds = [first.id];
      try { if (first.razorpay_order_id) rowIds = (await sql`SELECT id FROM orders WHERE razorpay_order_id = ${first.razorpay_order_id} AND guest_id = ${first.guest_id} ORDER BY arrival, id`).map(r => r.id); } catch (e) { /* the gifted booking alone */ }
      const accepted = g.status === 'accepted';
      const rowsOf = [];
      for (const rid of rowIds) { const s = Number(rid) === Number(first.id) ? first : await stayFor(sql, rid); if (s) rowsOf.push(s); }
      // A booking Aerva moved (check-in promise) leaves a closed original: only the live booking is shown, as the buyer sees it.
      const live = rowsOf.some(s => s.status === 'paid');
      for (const s of rowsOf) {
      if (live && rowsOf.length > 1 && s.status !== 'paid') continue;
      bookings.push({
        id: s.id, shared: 'gift', gifted_to_you: true, gift_from: g.buyer_first_name || 'Someone', gift_message: g.message || null,
        gift_id: g.id, gift_accepted: accepted, suite_name: s.property_name, listing_id: s.listing_id, listing_type: s.listing_type,
        arrival: dateStr(s.arrival), departure: dateStr(s.departure), nights: s.nights, guests: s.guests, status: s.status,
        confirmation_code: accepted ? s.confirmation_code : null, listing_name: s.property_name, listing_city: s.city, listing_area: s.area,
        listing_address: accepted ? s.formatted_address : null, check_in_time: s.check_in_time, check_out_time: s.check_out_time,
        local_today: dateStr(s.local_today), can_change: false, can_cancel_request: false, can_report: false, review_state: null,
        // The guest staying may report a problem on arrival (check-in day, until 10 AM the next day).
        can_report_arrival: accepted && s.status === 'paid' && (s.listing_type || 'stay') === 'stay' && dateStr(s.local_today) >= dateStr(s.arrival)
          && dateStr(s.local_today) < dateStr(s.departure) && Date.now() < require('./_booking-rules').stayWindowEndMs(dateStr(s.arrival), s.timezone)
      });
      }
    }
  } catch (err) { console.error('gift bookings not added:', err.message); }
  return bookings;
}

// Who else may use a booking's Messages besides the account that booked:
// the gift's accepted recipient, and (_group-bookings.js) everyone who paid
// for a place in a group booking. Returns 'recipient' | 'group' | null.
async function sharedRole(sql, guestId, orderId) {
  if (!guestId || !orderId) return null;
  try {
    const r = await sql`SELECT 1 FROM booking_gifts g JOIN orders a ON a.id = g.order_id JOIN orders b ON b.razorpay_order_id = a.razorpay_order_id
                        WHERE b.id = ${orderId} AND g.status = 'accepted' AND g.accepted_guest_id = ${guestId} LIMIT 1`;
    if (r.length) return 'recipient';
  } catch (err) { /* before the database update */ }
  try {
    const r = await sql`SELECT 1 FROM orders o JOIN group_claims c ON c.group_id = o.group_booking_id
                        WHERE o.id = ${orderId} AND c.guest_id = ${guestId} AND c.status = 'paid' LIMIT 1`;
    if (r.length) return 'group';
  } catch (err) { /* before the database update */ }
  return null;
}
async function sharedOrderIds(sql, guestId) {
  const out = new Set();
  try { (await sql`SELECT b.id FROM booking_gifts g JOIN orders a ON a.id = g.order_id JOIN orders b ON b.razorpay_order_id = a.razorpay_order_id
                   WHERE g.status = 'accepted' AND g.accepted_guest_id = ${guestId}`).forEach(r => out.add(Number(r.id))); } catch (e) { /* none */ }
  try { (await sql`SELECT DISTINCT o.id FROM orders o JOIN group_claims c ON c.group_id = o.group_booking_id
                   WHERE c.guest_id = ${guestId} AND c.status = 'paid' AND o.guest_id <> ${guestId}`).forEach(r => out.add(Number(r.id))); } catch (e) { /* none */ }
  return [...out];
}

// Host views: the guest staying, marked as a gift. Map orderId → { name, phone, note }.
async function hostLabels(sql, orderIds) {
  const out = new Map();
  const ids = [...new Set((orderIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return out;
  try {
    const rows = await sql`SELECT b.id AS row_id, g.* FROM booking_gifts g JOIN orders a ON a.id = g.order_id
                           JOIN orders b ON b.razorpay_order_id = a.razorpay_order_id
                           WHERE b.id = ANY(${ids}) AND g.status <> 'withdrawn'`;
    rows.forEach(g => {
      const accepted = g.status === 'accepted';
      const name = accepted ? `${g.accepted_first_name} ${g.accepted_last_name}` : `${g.recipient_first_name} ${g.recipient_last_name}`;
      const tag = `Gift — booked by ${g.buyer_first_name || 'another guest'}`;
      out.set(Number(g.row_id), { name, phone: accepted ? g.accepted_phone : null, accepted,
        note: accepted ? tag : `${tag} · Gift, not yet accepted`, label: `${name} (${accepted ? tag : tag + ' · Gift, not yet accepted'})` });
    });
  } catch (err) { /* before the database update */ }
  return out;
}
// Applies hostLabels to rows with { id|orderId, guest_name|guestName, guest_phone }.
async function decorateHostRows(sql, rows, { idKey = 'id', nameKey = 'guest_name', phoneKey = 'guest_phone' } = {}) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const labels = await hostLabels(sql, rows.map(r => r[idKey]));
  rows.forEach(r => {
    const l = labels.get(Number(r[idKey]));
    if (!l) return;
    r[nameKey] = l.label;
    r.gift = { name: l.name, accepted: l.accepted, note: l.note };
    if (phoneKey in r) r[phoneKey] = l.phone || null;
  });
  return rows;
}

// ---- Scheduled: reminders while not accepted, and telling a recipient
// when the buyer cancelled. Job 'gift_reminders' (get-listings.js). ----
async function runReminders(sql, { deadlineMs = 4000 } = {}) {
  const started = Date.now();
  const out = { reminded: 0, cancelNotices: 0 };
  if (!(await ready(sql))) return { ...out, skipped: 'database update not applied yet' };
  const due = await sql`
    SELECT g.*, (o.arrival - (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date) AS days_before
    FROM booking_gifts g JOIN orders o ON o.id = g.order_id JOIN listings l ON l.id = o.listing_id
    WHERE g.status = 'sent' AND o.status = 'paid' AND g.updated_at < now() - interval '12 hours'
      AND o.arrival >= (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date
      AND ((g.reminded_3d_at IS NULL AND o.arrival - (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date BETWEEN 2 AND 3)
        OR (g.reminded_1d_at IS NULL AND o.arrival - (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date <= 1))
    ORDER BY o.arrival LIMIT 40`;
  for (const g of due) {
    if (Date.now() - started > deadlineMs) break;
    const which = Number(g.days_before) <= 1 ? '1d' : '3d';
    const claimed = which === '1d'
      ? await sql`UPDATE booking_gifts SET reminded_1d_at = now(), reminded_3d_at = COALESCE(reminded_3d_at, now()) WHERE id = ${g.id} AND reminded_1d_at IS NULL AND status = 'sent' RETURNING id`
      : await sql`UPDATE booking_gifts SET reminded_3d_at = now() WHERE id = ${g.id} AND reminded_3d_at IS NULL AND status = 'sent' RETURNING id`;
    if (!claimed.length) continue;
    const s = await stayFor(sql, g.order_id);
    if (!s) continue;
    // A fresh link: the old token is only a hash, so it cannot be re-sent.
    const token = newToken();
    await sql`UPDATE booking_gifts SET token_hash = ${hashToken(token)} WHERE id = ${g.id} AND status = 'sent' AND token_used_at IS NULL`;
    const when = which === '1d' ? 'tomorrow' : `in ${Number(g.days_before)} days`;
    await sendMail(g.recipient_email, `Reminder: accept your stay at ${s.property_name}`, frame('Your stay is coming up',
      `<p>Hello ${esc(g.recipient_first_name)},</p><p>Your stay from ${esc(g.buyer_first_name || 'a friend')} starts ${when}. Please accept the gift so your host has your name and a number to reach you.</p>
       ${stayBlock(s)}<p><a href="${giftLink(token)}" style="display:inline-block; background:#1C1B19; color:#fff; padding:12px 20px; border-radius:8px; text-decoration:none;">Accept the gift</a></p>`));
    const buyer = (await sql`SELECT email FROM guests WHERE id = ${s.guest_id}`)[0] || {};
    await sendMail(buyer.email || s.guest_email, `${g.recipient_first_name} has not accepted the gift yet`, frame('Your gift is not accepted yet',
      `<p>${esc(g.recipient_first_name)} has not accepted the stay at <strong>${esc(s.property_name)}</strong>, which starts ${when}. We have reminded them. You can change the recipient in My Bookings until check-in.</p>`));
    await logAudit(sql, { action: 'gift_reminder_sent', success: true, actorType: 'system', targetType: 'order', targetId: s.id,
      metadata: { giftId: g.id, which, recipientEmail: g.recipient_email, buyerEmail: buyer.email || s.guest_email } });
    out.reminded++;
  }
  // The buyer cancelled: the recipient is told (never the amounts).
  const cancelled = await sql`SELECT g.* FROM booking_gifts g JOIN orders o ON o.id = g.order_id
                              WHERE g.status <> 'withdrawn' AND o.status = 'cancelled' AND g.cancel_notified_at IS NULL LIMIT 20`;
  for (const g of cancelled) {
    const claimed = await sql`UPDATE booking_gifts SET cancel_notified_at = now() WHERE id = ${g.id} AND cancel_notified_at IS NULL RETURNING id`;
    if (!claimed.length) continue;
    const s = await stayFor(sql, g.order_id);
    await sendMail(g.recipient_email, `Your stay at ${s ? s.property_name : 'Aerva'} was cancelled`, frame('Your gifted stay was cancelled',
      `<p>Hello ${esc(g.recipient_first_name)},</p><p>The stay at <strong>${esc(s ? s.property_name : '')}</strong> (${esc(s ? niceDate(s.arrival) : '')}) that ${esc(g.buyer_first_name || 'a friend')} booked for you has been cancelled.</p>`));
    await logAudit(sql, { action: 'gift_cancel_notice', success: true, actorType: 'system', targetType: 'order', targetId: g.order_id, metadata: { giftId: g.id, recipientEmail: g.recipient_email } });
    out.cancelNotices++;
  }
  return out;
}

module.exports = { ready, parseRecipient, cleanName, nameProblem, cleanMessage, createGift, sendGift, withdrawGift, giftForOrder, publicView, viewForAccount,
  acceptGift, decorateBookings, sharedRole, sharedOrderIds, hostLabels, decorateHostRows, buyerView, runReminders, hashToken, NOT_ON, MESSAGE_MAX };
