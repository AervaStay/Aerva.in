// /api/_contact-checks.js — Admin → Contact Checks, and the daily audit.
// Not an endpoint (get-pending-listings.js ?contactChecks=1, admins only;
// get-listings.js JOBS 'contact_check_audit').
//
// The rules being checked (see _message-guard.js):
//   • Enquiries (no confirmed booking): no contact detail of any kind.
//   • A confirmed booking, until check-out: phone numbers, email addresses
//     and photos may be shared; links, handles and UPI IDs may not.
//   • After check-out, or once cancelled: no contact detail at all — the
//     'chat_number_cleanup' job removes phone numbers and emails, and
//     photos that show a contact detail, silently.
//
// The check reads what people can SEE now (messages.display_text) and
// flags anything that breaks the rule for its chat. A finished chat whose
// cleanup is simply not due yet (the stay ended under 2 hours ago) is
// counted as waiting, not missed. "Fix now" (and the daily audit) removes
// whatever is left; the original text is always kept for the admin.

const { redactContactInfo } = require('./_redact');
const { stayEndsAt, scrubEndedConversations } = require('./_message-guard');
const GRACE_MS = 2 * 3600e3;

// The rule for a conversation now: 'enquiry' | 'booking' (phones allowed) | 'ended'.
function contextOf(c, now = Date.now()) {
  if (!c.order_id) return 'enquiry';
  if (c.status === 'paid' && now < stayEndsAt(c)) return 'booking';
  if (c.status === 'paid' || c.status === 'cancelled') return 'ended';
  return 'enquiry';                       // an unpaid booking request
}
const LABEL = { enquiry: 'Enquiry', booking: 'Confirmed booking', ended: 'After the stay / cancelled' };

// What the rule says this text should look like.
function cleaned(text, context) {
  return redactContactInfo(String(text || ''), { keepNumbers: context === 'booking', keepEmails: context === 'booking' }).displayText;
}

async function scan(sql, { days = 120, limit = 4000 } = {}) {
  const rows = await sql`
    SELECT m.id, m.conversation_id, m.sender_type, m.display_text, m.created_at,
           c.order_id, c.contacts_scrubbed_at, o.status, o.departure, to_jsonb(o)->>'confirmation_code' AS code, o.razorpay_order_id,
           l.check_out_time, l.timezone, l.property_name
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN orders o ON o.id = c.order_id LEFT JOIN listings l ON l.id = COALESCE(o.listing_id, c.listing_id)
    WHERE m.display_text IS NOT NULL AND m.unsent_at IS NULL AND m.created_at > now() - make_interval(days => ${days})
    ORDER BY m.id DESC LIMIT ${limit}`;
  const now = Date.now();
  const found = [];
  for (const m of rows) {
    const ctx = contextOf(m, now);
    const shouldBe = cleaned(m.display_text, ctx);
    if (shouldBe === m.display_text) continue;
    const ended = ctx === 'ended' ? (m.status === 'cancelled' ? null : stayEndsAt(m)) : null;
    const waiting = ctx === 'ended' && !m.contacts_scrubbed_at && ended && now - ended < GRACE_MS;
    found.push({ messageId: m.id, conversationId: m.conversation_id, context: ctx, contextLabel: LABEL[ctx], waiting: !!waiting,
      sender: m.sender_type, at: m.created_at, booking: m.code || m.razorpay_order_id || (m.order_id ? '#' + m.order_id : ''), listing: m.property_name || '',
      shown: m.display_text, shouldBe });
  }
  return { scanned: rows.length, found };
}

async function checks(sql) {
  const out = { aiOn: !!process.env.ANTHROPIC_API_KEY };
  try {
    out.job = (await sql`SELECT last_started_at, last_finished_at, last_ok, last_result FROM job_runs WHERE name = 'chat_number_cleanup'`)[0] || null;
    out.audit = (await sql`SELECT last_started_at, last_finished_at, last_ok, last_result FROM job_runs WHERE name = 'contact_check_audit'`)[0] || null;
  } catch (e) { out.job = null; out.audit = null; }
  const s = await scan(sql);
  out.scanned = s.scanned;
  out.missed = s.found.filter(f => !f.waiting);
  out.waiting = s.found.filter(f => f.waiting).length;
  // Removed in the last 30 days, by kind of chat.
  const rem = await sql`
    SELECT m.id, m.sender_type, m.original_text, m.display_text, m.created_at, c.order_id, o.status, o.departure,
           to_jsonb(o)->>'confirmation_code' AS code, o.razorpay_order_id, l.check_out_time, l.timezone, l.property_name, c.contacts_scrubbed_at
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN orders o ON o.id = c.order_id LEFT JOIN listings l ON l.id = COALESCE(o.listing_id, c.listing_id)
    WHERE (m.was_redacted = true OR m.display_text IS DISTINCT FROM m.original_text
           OR (to_jsonb(m)->'photo_urls') IS DISTINCT FROM (to_jsonb(m)->'original_photo_urls'))
      AND m.created_at > now() - interval '30 days'
    ORDER BY m.id DESC LIMIT 300`;
  const by = { enquiry: 0, booking: 0, ended: 0 };
  out.removed = rem.map(m => {
    // Which rule removed it: a finished chat that was cleaned up → 'ended'.
    const k = m.contacts_scrubbed_at ? 'ended' : (m.order_id && m.status === 'paid' ? 'booking' : (m.order_id && m.status === 'cancelled' ? 'ended' : 'enquiry'));
    by[k]++;
    return { at: m.created_at, sender: m.sender_type, context: LABEL[k], booking: m.code || m.razorpay_order_id || (m.order_id ? '#' + m.order_id : ''),
      listing: m.property_name || '', original: String(m.original_text || '').slice(0, 300), shown: String(m.display_text || '').slice(0, 300) };
  }).slice(0, 40);
  out.removedCounts = by;
  out.removedTotal = rem.length;
  return out;
}

// Removes everything the scan finds (and runs the cleanup for finished
// chats first). Returns how many messages changed.
async function fixNow(sql) {
  const job = await scrubEndedConversations(sql, { deadlineMs: 8000, limit: 500 });
  const s = await scan(sql);
  let fixed = 0;
  for (const f of s.found) {
    // After a stay it is silent (no 'content removed' note); otherwise as when sent.
    const r = f.context === 'ended'
      ? await sql`UPDATE messages SET display_text = ${f.shouldBe} WHERE id = ${f.messageId} AND display_text = ${f.shown} RETURNING id`
      : await sql`UPDATE messages SET display_text = ${f.shouldBe}, was_redacted = true WHERE id = ${f.messageId} AND display_text = ${f.shown} RETURNING id`;
    if (r.length) fixed++;
  }
  return { cleanedConversations: job.conversations || 0, cleanedMessages: job.messages || 0, fixed, total: fixed + (job.messages || 0) };
}

// Daily: fix anything missed and email the admin if there was any.
async function dailyAudit(sql) {
  const s = await scan(sql);
  const missed = s.found.filter(f => !f.waiting);
  if (!missed.length) return { scanned: s.scanned, missed: 0 };
  const r = await fixNow(sql);
  const to = process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in';
  if (process.env.RESEND_API_KEY) {
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    try {
      await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject: `Contact check: ${missed.length} message${missed.length === 1 ? '' : 's'} fixed`,
          html: `<div style="font-family:sans-serif; line-height:1.6;"><p>The daily contact check found ${missed.length} message${missed.length === 1 ? '' : 's'} still showing a contact detail where the rules do not allow it, and removed ${r.total}.</p>
            <ul>${missed.slice(0, 20).map(f => `<li>${esc(f.contextLabel)} · ${esc(f.booking || 'enquiry')} · ${esc(f.listing)} · message #${esc(f.messageId)}</li>`).join('')}</ul>
            <p>Details: Admin → Contact Checks.</p></div>` }) });
    } catch (e) { /* the admin page shows it anyway */ }
  }
  return { scanned: s.scanned, missed: missed.length, fixed: r.total };
}

// Try a message against the rules, without saving anything.
async function tryMessage(text, context) {
  const ctx = ['enquiry', 'booking', 'ended'].includes(context) ? context : 'enquiry';
  const t = String(text || '').slice(0, 2000);
  let shown = cleaned(t, ctx), by = shown !== t ? 'rules' : null;
  // Pieces and spelled-out details need the second check (as live chats do).
  if (!by) {
    const { askClaude } = require('./_message-guard');
    const digits = (t.match(/\d/g) || []).length;
    const ask = ctx === 'booking' ? /@|mail|insta|telegram|upi|whatsapp|wa\.me|facebook|fb|snap|http|www|\.com/i.test(t) : (digits >= 5 || /@|mail|insta|telegram|upi|whatsapp/i.test(t));
    if (ask) {
      const v = await askClaude([t], ctx === 'booking');
      if (v && v.contact) { shown = '[contact info removed]'; by = 'second check'; }
    }
  }
  return { context: LABEL[ctx], shown, removed: !!by, by };
}

module.exports = { checks, fixNow, dailyAudit, tryMessage, scan, contextOf };
