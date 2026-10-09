// /api/_inquiries.js — a guest asks the host a question before booking.
// Not an endpoint (guest-profile.js mode 'inquiry' calls it).
//
// An enquiry is an ordinary Messages thread (conversations) with no
// booking behind it yet: contact details are removed from it exactly as
// from a booking chat (_message-guard.js), the host is emailed and sees
// it in their inbox with the dates and party the guest asked about, and
// both sides keep talking there. One thread per guest per listing; a
// second question from the same guest goes into the same thread. When
// the guest later books that listing, the booking joins the thread
// (adoptInquiryThread), so nothing is said twice.
//
// Tables: sql/migration_inquiries.sql. Before it runs, enquiries are
// refused with a clear message.

const { guardMessage } = require('./_message-guard');
const { logAudit } = require('./_audit-log');
const { countRecentAttempts } = require('./_rate-limit');

const MAX_PER_DAY = 10;                          // questions per guest per day, across listings
const MAX_TEXT = 1500;
const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const niceDay = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

async function emailHost(to, { hostName, guestName, listingName, text, arrival, departure, guests }) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  const about = [arrival && departure ? `${niceDay(arrival)} – ${niceDay(departure)}` : '', guests ? `${guests} guest${guests === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject: `New enquiry about ${listingName}`,
        html: `<div style="font-family:sans-serif; max-width:480px;">
          <h2 style="font-family:Georgia,serif;">A guest has a question</h2>
          <p>Hi ${esc(hostName || 'there')}, <strong>${esc(guestName || 'A guest')}</strong> asked about <strong>${esc(listingName)}</strong>${about ? ` (${esc(about)})` : ''}:</p>
          <blockquote style="margin:12px 0; padding:10px 14px; background:#f6f1ea; border-left:3px solid #a9884f; white-space:pre-wrap;">${esc(text)}</blockquote>
          <p><a href="https://aerva.in/index.html?view=messages" style="background:#1c1a17; color:#f4eadc; padding:12px 24px; text-decoration:none; display:inline-block;">Reply in Messages</a></p>
          <p style="font-size:12px; opacity:0.6; margin-top:24px;">Guests who ask are more likely to book when they hear back within a few hours. Keep the conversation on Aerva.</p>
        </div>` }) });
    return r.ok;
  } catch (err) { console.error('enquiry email failed:', err.message); return false; }
}

// POST { mode: 'inquiry', listingId, text, arrival?, departure?, guests? }
// → { conversationId, message }
async function createInquiry(sql, { guestId, listingId, text, arrival, departure, guests, ip }) {
  const clean = typeof text === 'string' ? text.replace(/\r/g, '').trim().slice(0, MAX_TEXT) : '';
  if (!listingId) throw userError('Which listing is this about?');
  if (clean.length < 5) throw userError('Please write your question first.');
  const a = isDay(arrival) ? arrival : null, d = isDay(departure) ? departure : null;
  if ((a && !d) || (d && !a)) throw userError('Please choose both a check-in and a check-out date, or neither.');
  if (a && d && d <= a) throw userError('Check-out must be after check-in.');
  const n = Number.isInteger(Number(guests)) && Number(guests) > 0 ? Math.min(50, Number(guests)) : null;

  const l = (await sql`SELECT l.id, l.property_name, l.host_id, l.status, h.name AS host_name,
                              (SELECT g.email FROM guests g WHERE g.host_id = l.host_id ORDER BY g.id LIMIT 1) AS host_email
                       FROM listings l JOIN hosts h ON h.id = l.host_id WHERE l.id = ${listingId}`)[0];
  if (!l || l.status !== 'approved') throw userError('This listing is not taking questions right now.', 404);
  if (await require('./_support-actions').isBlocked(sql, guestId, l.id)) throw userError('This listing is not taking questions right now.', 404);
  const me = (await sql`SELECT id, name, email, host_id FROM guests WHERE id = ${guestId} AND deleted_at IS NULL`)[0];
  if (!me) throw userError('Please log in again.', 401);
  if (me.host_id && Number(me.host_id) === Number(l.host_id)) throw userError('This is your own listing.');

  const today = await countRecentAttempts(sql, { action: 'inquiry_sent', windowMinutes: 24 * 60, byActor: String(guestId) });
  if (today >= MAX_PER_DAY) throw userError('You have sent enough questions for today. Please try again tomorrow.', 429);

  // The guest's thread with this listing: the enquiry thread, or an open
  // booking's thread if they already have one.
  let conv;
  try {
    conv = (await sql`SELECT id, order_id FROM conversations WHERE listing_id = ${l.id} AND guest_id = ${guestId}
                      ORDER BY (order_id IS NULL) DESC, id DESC LIMIT 1`)[0];
    if (!conv) {
      const inq = (await sql`INSERT INTO listing_inquiries (listing_id, guest_id, host_id, arrival, departure, guests)
                             VALUES (${l.id}, ${guestId}, ${l.host_id}, ${a}, ${d}, ${n}) RETURNING id`)[0];
      conv = (await sql`INSERT INTO conversations (order_id, listing_id, guest_id, guest_email, host_id, inquiry_id)
                        VALUES (NULL, ${l.id}, ${guestId}, ${me.email || ''}, ${l.host_id}, ${inq.id})
                        ON CONFLICT DO NOTHING RETURNING id, order_id`)[0]
          || (await sql`SELECT id, order_id FROM conversations WHERE listing_id = ${l.id} AND guest_id = ${guestId} AND order_id IS NULL`)[0];
    } else if (conv.order_id === null && (a || n)) {
      // A new question with new dates: the thread's enquiry follows them.
      await sql`UPDATE listing_inquiries SET arrival = ${a}, departure = ${d}, guests = ${n}
                WHERE id = (SELECT inquiry_id FROM conversations WHERE id = ${conv.id})`;
    }
  } catch (err) {
    if (err && (err.code === '42P01' || err.code === '42703' || err.code === '23502')) {
      throw userError('Questions to hosts are not open yet. Please try again later.', 503);
    }
    throw err;
  }

  // The question itself, with contact details removed like any message.
  const guard = await guardMessage(sql, { conversationId: conv.id, senderType: 'guest', text: clean });
  for (const m of guard.rewrite) {
    await sql`UPDATE messages SET display_text = ${m.display_text}, was_redacted = true WHERE id = ${m.id} AND conversation_id = ${conv.id}`;
  }
  const head = a && d ? `Enquiry for ${niceDay(a)} – ${niceDay(d)}${n ? `, ${n} guest${n === 1 ? '' : 's'}` : ''}:\n` : (n ? `Enquiry for ${n} guest${n === 1 ? '' : 's'}:\n` : '');
  const msg = (await sql`
    INSERT INTO messages (conversation_id, sender_type, original_text, display_text, was_redacted)
    VALUES (${conv.id}, 'guest', ${head + clean}, ${head + guard.displayText}, ${guard.wasRedacted})
    RETURNING id, sender_type, display_text, was_redacted, created_at`)[0];
  await logAudit(sql, { action: 'inquiry_sent', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'listing', targetId: l.id,
    metadata: { conversationId: conv.id, arrival: a, departure: d, guests: n, redacted: guard.wasRedacted, ip: ip || null } });
  const emailed = await emailHost(l.host_email, { hostName: l.host_name, guestName: me.name, listingName: l.property_name, text: guard.displayText, arrival: a, departure: d, guests: n });
  return { conversationId: conv.id, message: msg, emailed };
}

// A booking on a listing the guest already asked about joins that thread:
// the enquiry thread becomes the booking's. Returns the conversation id,
// or null when there is no enquiry thread to adopt. Never throws.
async function adoptInquiryThread(sql, { orderId, listingId, guestId }) {
  if (!orderId || !listingId || !guestId) return null;
  try {
    const r = await sql`UPDATE conversations SET order_id = ${orderId}
                        WHERE listing_id = ${listingId} AND guest_id = ${guestId} AND order_id IS NULL RETURNING id`;
    return r[0] ? r[0].id : null;
  } catch (err) { return null; }
}

// Dates and party asked about, for the inbox: { conversationId: { arrival, departure, guests } }.
async function inquiryDetails(sql, conversationIds) {
  const ids = (conversationIds || []).filter(Boolean);
  if (!ids.length) return {};
  try {
    const rows = await sql`SELECT c.id, i.arrival, i.departure, i.guests, i.created_at
                           FROM conversations c JOIN listing_inquiries i ON i.id = c.inquiry_id WHERE c.id = ANY(${ids})`;
    const out = {};
    for (const r of rows) out[r.id] = { arrival: r.arrival, departure: r.departure, guests: r.guests, askedAt: r.created_at };
    return out;
  } catch (err) { return {}; }
}

module.exports = { createInquiry, adoptInquiryThread, inquiryDetails, MAX_PER_DAY };
