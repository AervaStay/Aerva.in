// /api/_support-chat.js — "Aerva Support" in Messages. Not an endpoint
// (guest-profile.js modes supportChat*).
//
// Every signed-in person has one Aerva Support conversation, pinned at the
// top of Messages:
//   1. The assistant (Claude, via the Anthropic API) answers first, from
//      Aerva's own policies and help topics (aerva-policies.js) and the
//      person's own bookings and requests — never anyone else's.
//   2. When it cannot resolve something, or the person asks for a person,
//      the person can "Speak to an agent" — live chat here, a call, or a
//      call back. That opens a support request (an SR-
//      reference, as in the Resolution Center) carrying the whole
//      conversation, so nobody has to repeat themselves. The team answers
//      in Admin → Support and the answer appears in the same chat.
//   3. When the team marks it resolved, the chat asks "Is it sorted?" and
//      for a 1–5 star rating; "not yet" opens it again.
// The assistant never acts on anything (no cancelling, refunding or
// changing): it explains, links to the right page, and hands over.
//
// Environment: ANTHROPIC_API_KEY (already used for photo and message
// checks); SUPPORT_CHAT_MODEL (optional, default below).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const support = require('./_support');
const { logAudit } = require('./_audit-log');
const { normalizeToE164 } = require('./_phone-validation');

const MODEL = () => process.env.SUPPORT_CHAT_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TEXT = 1000;
const PER_HOUR = 20, PER_DAY = 80;          // messages to the assistant, per account
const HISTORY = 24;                          // earlier messages the assistant sees
const SITE = 'https://aerva.in';
const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });
const ACTIVE = ['open', 'in_progress', 'waiting_on_you'];

// ---------------------------------------------------------------- what the assistant knows

let policiesText = null;
function loadPolicies() {
  if (policiesText !== null) return policiesText;
  const tries = [path.join(process.cwd(), 'aerva-policies.js'), path.join(__dirname, '..', 'aerva-policies.js')];
  const file = tries.find(f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
  if (!file) { policiesText = ''; return policiesText; }
  try {
    const box = { window: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), box, { timeout: 1000 });
    const P = box.window.AERVA_POLICIES || {};
    const out = [];
    const sec = (s) => `### ${s.title}\n` + (s.points || []).map(p => `- ${p}`).join('\n');
    (P.documents || []).forEach(d => {
      out.push(`## Policy: ${d.title} (link: ${SITE}/index.html?view=policies&doc=${d.id})\n${d.summary || ''}\n` + (d.sections || []).map(sec).join('\n'));
    });
    const S = P.support || {};
    if (S.intro) out.push(`## Resolution Center\n${S.intro}`);
    if (S.emergency) out.push(`Emergency: ${S.emergency}`);
    (S.commitments || []).forEach(c => out.push(`Commitment — ${c.title}: ${c.text}`));
    (S.process || []).forEach(p => out.push(`How a request works — ${p.title}: ${p.text}`));
    (S.topics || []).forEach(t => {
      out.push(`## Help topic: ${t.title} (for ${t.group}; link: ${SITE}/index.html?view=help&topic=${t.id})\n${t.summary || ''}\n` + (t.sections || []).map(sec).join('\n'));
    });
    if (S.badges) out.push('## Badges\n' + JSON.stringify(S.badges).slice(0, 4000));
    policiesText = out.join('\n\n');
  } catch (err) {
    console.error('policies not loaded for the assistant:', err.message);
    policiesText = '';
  }
  return policiesText;
}

const RULES = () => `You are Aerva Assistant, the support assistant inside Aerva Messages. Aerva (aerva.in) is a boutique platform in India for booking hand-picked homes ("stays") and experiences, and for hosts to list them.

How you work:
- Answer only about Aerva: bookings, payments, cancellations and refunds, changes, deposits, coupons, hosting, payouts, accounts, and Aerva's policies. Politely decline anything else.
- Use ONLY the policies and help topics below and the person's own account details. Never invent rules, amounts, dates, timelines or promises. If something is not covered, say so and offer a person.
- You cannot act: you cannot cancel, refund, change, approve, waive, unblock or decide anything, and you cannot see payment card details. Explain exactly how the person does it in Aerva (for example: My Bookings → open the booking → Request cancellation), with a link from below when one fits. Exceptions and decisions are made only by Aerva's support team.
- Never ask for card numbers, OTPs, passwords or bank details. Never share another person's details. Remind people that Aerva keeps all communication and payments on the platform.
- Safety: if anyone may be in danger, tell them to call 112 first, then hand over at once.
- Hand over to a person when: they ask for a person; it needs a decision, an exception or an investigation (money taken but no booking, a refund not received after its stated time, a dispute with a host or guest, damage, an account problem); they are upset or it is urgent; or you have not solved it after two tries. To hand over, write one short sentence saying a member of Aerva's support team will take it from here and they can tap "Speak to an agent" (live chat, a call, or a call back), then end your message with this exact tag on its own line:
[[HANDOFF:<category>|<booking id or 0>]]
  <category> is one of: ${Object.keys(support.CATEGORIES).join(', ')}.
- Style: warm, calm and brief — at most about 120 words. Plain text only: no markdown, no bold, no headings; "- " bullets only for steps. Use full links (https://…). Reply in the person's language.
- Useful links: My Bookings ${SITE}/index.html?view=my-bookings · Resolution Center ${SITE}/index.html?view=help · All policies ${SITE}/index.html?view=policies · Host dashboard ${SITE}/host-dashboard.html · My Earnings ${SITE}/host-earnings.html`;

const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const day = (d) => d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : '';

// The person's own account, bookings and requests — what the assistant may use.
async function personContext(sql, guestId) {
  const soft = async (q) => { try { return await q; } catch (e) { return []; } };
  const me = (await sql`SELECT id, name, email, host_id, created_at FROM guests WHERE id = ${guestId}`)[0];
  if (!me) throw userError('Please log in again.', 401);
  const bookings = await soft(sql`
    SELECT o.id, o.suite_name, o.arrival, o.departure, o.nights, o.guests, o.status, o.total,
           to_jsonb(o)->>'confirmation_code' AS code, COALESCE(o.order_type, 'stay') AS kind,
           to_jsonb(o)->>'coupon_discount' AS coupon, to_jsonb(o)->>'deposit_amount' AS deposit, to_jsonb(o)->>'deposit_status' AS deposit_status,
           COALESCE(to_jsonb(o)->>'cancellation_policy', l.cancellation_policy, 'flexible') AS policy, to_jsonb(o)->>'cancellation_reason' AS cancelled_why,
           to_jsonb(o)->>'refund_percent' AS refund_percent, l.city,
           (SELECT COALESCE(sum(r.amount), 0) / 100 FROM refunds r WHERE r.order_id = o.id AND r.status IN ('pending', 'processed')) AS refunded,
           (SELECT string_agg(r.status, ',') FROM refunds r WHERE r.order_id = o.id) AS refund_states,
           (SELECT cr.status FROM cancellation_requests cr WHERE cr.order_id = o.id ORDER BY cr.id DESC LIMIT 1) AS cancel_request
    FROM orders o LEFT JOIN listings l ON l.id = o.listing_id
    WHERE o.guest_id = ${guestId} AND (o.departure >= current_date - 180 OR o.created_at > now() - interval '180 days')
    ORDER BY o.arrival DESC LIMIT 12`);
  const listings = me.host_id ? await soft(sql`SELECT id, property_name, city, status, COALESCE(listing_type, 'stay') AS kind FROM listings WHERE host_id = ${me.host_id} ORDER BY id LIMIT 20`) : [];
  const hosting = me.host_id ? await soft(sql`
    SELECT o.id, o.suite_name, o.arrival, o.departure, o.status, to_jsonb(o)->>'confirmation_code' AS code, o.payout_amount
    FROM orders o JOIN listings l ON l.id = o.listing_id
    WHERE l.host_id = ${me.host_id} AND o.departure >= current_date - 30 ORDER BY o.arrival LIMIT 10`) : [];
  const requests = await soft(sql`SELECT ref, subject, status, created_at FROM support_tickets WHERE guest_id = ${guestId} ORDER BY id DESC LIMIT 5`);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const lines = [
    `Today (India time): ${today}.`,
    `The person: ${me.name || 'name not set'} (account #${me.id}${me.host_id ? ', also a host' : ''}, member since ${day(me.created_at)}).`,
    bookings.length ? 'Their bookings as a guest (most recent first):\n' + bookings.map(b =>
      `- Booking ${b.id}${b.code ? ' (confirmation code ' + b.code + ')' : ''}: ${b.suite_name}${b.city ? ', ' + b.city : ''} — ${b.kind}, ${day(b.arrival)}${b.kind === 'stay' ? ' to ' + day(b.departure) : ''}, ${b.guests} guest(s), status ${b.status}, paid ${inr(Number(b.total) - Number(b.coupon || 0))}`
      + `${Number(b.deposit) ? `, deposit ${inr(b.deposit)} (${b.deposit_status || 'held'})` : ''}, ${b.policy} policy`
      + `${b.cancel_request ? `, cancellation request ${b.cancel_request}` : ''}${b.cancelled_why ? `, cancelled: ${b.cancelled_why}` : ''}`
      + `${Number(b.refunded) ? `, refunded so far ${inr(b.refunded)}` : ''}${b.refund_states && /failed/.test(b.refund_states) ? ' (a refund attempt failed — hand over)' : ''}`).join('\n')
      : 'They have no recent bookings as a guest.',
    listings.length ? 'Their listings as host:\n' + listings.map(l => `- Listing ${l.id}: ${l.property_name}, ${l.city || ''} — ${l.kind}, ${l.status}`).join('\n') : '',
    hosting.length ? 'Upcoming and recent bookings at their listings:\n' + hosting.map(b => `- Booking ${b.id}${b.code ? ' (' + b.code + ')' : ''}: ${b.suite_name}, ${day(b.arrival)} to ${day(b.departure)}, ${b.status}, host payout ${inr(b.payout_amount)}`).join('\n') : '',
    requests.length ? 'Their support requests:\n' + requests.map(r => `- ${r.ref}: ${r.subject} — ${support.STATUS_LABELS[r.status] || r.status}`).join('\n') : ''
  ].filter(Boolean);
  return { me, text: lines.join('\n\n') };
}

// ---------------------------------------------------------------- the model

async function askModel(system, messages) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('ANTHROPIC_API_KEY not set'), { unavailable: true });
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 22000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL(), max_tokens: 700, system, messages })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error((d.error && d.error.message) || `Anthropic API ${r.status}`), { unavailable: true });
    return (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  } finally { clearTimeout(timer); }
}

const HANDOFF_RE = /\[\[HANDOFF:([a-z_]+)(?:\|(\d+))?\]\]/i;

// ---------------------------------------------------------------- state

async function chatTickets(sql, guestId) {
  return await sql`SELECT * FROM support_tickets WHERE guest_id = ${guestId} AND COALESCE(to_jsonb(support_tickets)->>'channel', 'web') = 'chat' ORDER BY id DESC LIMIT 10`;
}
function modeOf(t) {
  if (!t) return 'ai';
  if (ACTIVE.includes(t.status)) return 'human';
  if (t.status === 'resolved') return 'feedback';
  return 'ai';
}

// The whole conversation, oldest first: the assistant's part and every
// request it turned into (without the attached transcript or internal notes).
async function getThread(sql, guestId, { markSeen = true } = {}) {
  const tickets = await chatTickets(sql, guestId);
  const current = tickets.find(t => t.status !== 'closed') || null;
  const chat = await sql`SELECT id, role, body, meta, ticket_id, created_at FROM support_chat_messages WHERE guest_id = ${guestId} ORDER BY created_at DESC, id DESC LIMIT 200`;
  const ids = tickets.map(t => t.id);
  const tmsgs = ids.length ? await sql`SELECT id, ticket_id, sender, body, attachments, created_at, to_jsonb(m)->>'via' AS via FROM support_messages m
                                       WHERE ticket_id = ANY(${ids}) AND internal = false AND COALESCE(to_jsonb(m)->>'via', '') <> 'chat-transcript'
                                         AND NOT (sender = 'system' AND COALESCE(to_jsonb(m)->>'via', '') = 'chat')
                                       ORDER BY created_at, id` : [];
  const refOf = new Map(tickets.map(t => [t.id, t.ref]));
  const items = [
    ...chat.map(m => ({ key: 'c' + m.id, from: m.role === 'user' ? 'you' : m.role === 'assistant' ? 'assistant' : 'system', body: m.body, at: m.created_at,
                        handoff: m.meta && m.meta.handoff ? m.meta.handoff : null, ref: m.ticket_id ? refOf.get(m.ticket_id) || null : null })),
    ...tmsgs.map(m => ({ key: 's' + m.id, from: m.sender === 'user' ? 'you' : m.sender === 'support' ? 'support' : 'system', body: m.body, at: m.created_at,
                         files: Array.isArray(m.attachments) ? m.attachments : [], ref: refOf.get(m.ticket_id) || null }))
  ].sort((a, b) => new Date(a.at) - new Date(b.at) || (a.key < b.key ? -1 : 1)).slice(-160);
  // "Speak to an agent" only once the person has described the issue and
  // the assistant has answered it (or could not answer at all).
  const lastHandoverAt = chat.filter(m => m.role === 'system' && m.ticket_id).reduce((a, m) => Math.max(a, new Date(m.created_at).getTime()), 0);
  const since = chat.filter(m => new Date(m.created_at).getTime() > lastHandoverAt);
  const canAskAgent = modeOf(current) === 'ai' && since.some(m => m.role === 'user') && since.some(m => m.role === 'assistant');
  // Only the latest assistant suggestion to hand over still counts, and only while nothing is open.
  const lastAi = [...items].reverse().find(i => i.from === 'assistant' || i.from === 'support' || (i.from === 'system' && i.ref));
  const suggestHandoff = modeOf(current) === 'ai' && lastAi && lastAi.from === 'assistant' && !!lastAi.handoff;
  if (markSeen && current) await sql`UPDATE support_tickets SET user_last_seen_at = now() WHERE id = ${current.id}`;
  const phoneRow = (await sql`SELECT phone FROM guests WHERE id = ${guestId}`)[0];
  return {
    mode: modeOf(current),
    aiAvailable: !!process.env.ANTHROPIC_API_KEY,
    suggestHandoff,
    canAskAgent,
    accountPhone: phoneRow && phoneRow.phone ? String(phoneRow.phone).trim() : null,
    callbackPhone: current && current.callback_phone ? current.callback_phone : null,
    ticket: current ? { ref: current.ref, status: current.status, statusLabel: support.STATUS_LABELS[current.status] || current.status,
                        autoCloseAt: current.status === 'resolved' && current.resolved_at ? new Date(new Date(current.resolved_at).getTime() + support.FEEDBACK_HOURS * 3600e3).toISOString() : null } : null,
    messages: items
  };
}

// For the conversation list: a preview, and whether the team replied unseen.
async function summary(sql, guestId) {
  try {
    const last = (await sql`SELECT body, created_at FROM (
        SELECT body, created_at FROM support_chat_messages WHERE guest_id = ${guestId}
        UNION ALL
        SELECT m.body, m.created_at FROM support_messages m JOIN support_tickets t ON t.id = m.ticket_id
         WHERE t.guest_id = ${guestId} AND COALESCE(to_jsonb(t)->>'channel', 'web') = 'chat' AND m.internal = false AND COALESCE(to_jsonb(m)->>'via', '') <> 'chat-transcript'
      ) x ORDER BY created_at DESC LIMIT 1`)[0] || null;
    const unread = (await sql`SELECT count(*)::int AS n FROM support_tickets WHERE guest_id = ${guestId} AND COALESCE(to_jsonb(support_tickets)->>'channel', 'web') = 'chat'
                              AND last_support_message_at IS NOT NULL AND (user_last_seen_at IS NULL OR last_support_message_at > user_last_seen_at)`)[0].n;
    const open = (await chatTickets(sql, guestId)).find(t => t.status !== 'closed');
    return { preview: last ? String(last.body).replace(/\[\[HANDOFF[^\]]*\]\]/g, '').trim().slice(0, 120) : null, at: last ? last.created_at : null,
             unread: Number(unread) || 0, status: open ? (support.STATUS_LABELS[open.status] || open.status) : null };
  } catch (err) { return { preview: null, at: null, unread: 0, status: null, notReady: true }; }
}

// ---------------------------------------------------------------- sending

async function send(sql, guestId, rawText) {
  const text = String(rawText || '').replace(/\r/g, '').trim().slice(0, MAX_TEXT);
  if (!text) throw userError('Write a message first.');
  const tickets = await chatTickets(sql, guestId);
  const current = tickets.find(t => t.status !== 'closed') || null;

  // With a person: it goes on the request (a resolved one opens again).
  if (current && (ACTIVE.includes(current.status) || current.status === 'resolved')) {
    await support.appendUserMessage(sql, current, { body: text, actor: String(guestId), via: 'chat' });
    return getThread(sql, guestId);
  }

  // With the assistant.
  const hour = (await sql`SELECT count(*)::int AS n FROM support_chat_messages WHERE guest_id = ${guestId} AND role = 'user' AND created_at > now() - interval '1 hour'`)[0].n;
  const dayN = (await sql`SELECT count(*)::int AS n FROM support_chat_messages WHERE guest_id = ${guestId} AND role = 'user' AND created_at > now() - interval '1 day'`)[0].n;
  if (hour >= PER_HOUR || dayN >= PER_DAY) throw userError('You have sent a lot of messages to the assistant. Tap "Speak to an agent" and our team will help you.', 429);
  await sql`INSERT INTO support_chat_messages (guest_id, role, body) VALUES (${guestId}, 'user', ${text})`;

  let reply, handoff = null;
  try {
    const ctx = await personContext(sql, guestId);
    // Earlier conversation (since the last hand-over), alternating roles as the API needs.
    const hist = (await sql`SELECT role, body FROM support_chat_messages WHERE guest_id = ${guestId} AND role IN ('user', 'assistant')
                            AND created_at > COALESCE((SELECT max(created_at) FROM support_chat_messages WHERE guest_id = ${guestId} AND role = 'system' AND ticket_id IS NOT NULL), 'epoch')
                            ORDER BY created_at DESC, id DESC LIMIT ${HISTORY}`).reverse();
    const messages = [];
    for (const h of hist) {
      const content = String(h.body).replace(HANDOFF_RE, '').trim() || '…';
      if (messages.length && messages[messages.length - 1].role === h.role) messages[messages.length - 1].content += '\n\n' + content;
      else messages.push({ role: h.role, content });
    }
    while (messages.length && messages[0].role !== 'user') messages.shift();
    const system = [
      { type: 'text', text: RULES() },
      { type: 'text', text: 'AERVA POLICIES AND HELP TOPICS (the only rules you may state):\n\n' + loadPolicies(), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'THE PERSON YOU ARE HELPING (their own data — never reveal anyone else\'s):\n\n' + ctx.text }
    ];
    const raw = await askModel(system, messages);
    const m = HANDOFF_RE.exec(raw);
    if (m) handoff = { category: support.CATEGORIES[m[1]] ? m[1] : 'other', orderId: Number(m[2]) || null };
    reply = raw.replace(HANDOFF_RE, '').trim() || 'A member of Aerva’s support team can take this from here — tap “Speak to an agent”.';
  } catch (err) {
    if (err.isUserFacing) throw err;
    console.error('support assistant failed:', err.message);
    reply = 'Sorry — the assistant is not available right now. Tap “Speak to an agent” and a member of Aerva’s support team will help you.';
    handoff = { category: 'other', orderId: null, assistantDown: true };
  }
  await sql`INSERT INTO support_chat_messages (guest_id, role, body, meta) VALUES (${guestId}, 'assistant', ${reply}, ${JSON.stringify(handoff ? { handoff } : {})}::jsonb)`;
  return getThread(sql, guestId);
}

// "Speak to an agent": a request with the conversation attached.
// how: 'chat' (live chat here) or 'callback' (we phone them; phone = the
// number to call, or the one on their account).
async function handoff(sql, guestId, { note = '', how = 'chat', phone = '' } = {}) {
  const tickets = await chatTickets(sql, guestId);
  const open = tickets.find(t => ACTIVE.includes(t.status));
  if (open) return getThread(sql, guestId);                    // already with a person
  const state = await getThread(sql, guestId, { markSeen: false });
  if (!state.canAskAgent) throw userError('Please describe your issue to the assistant first — if it cannot sort it out, you can then speak to an agent.', 409);
  let callbackPhone = null;
  if (how === 'callback') {
    const typed = String(phone || '').trim();
    callbackPhone = typed ? normalizeToE164(typed) : (state.accountPhone ? normalizeToE164(state.accountPhone) || state.accountPhone : null);
    if (!callbackPhone) throw userError(typed ? 'Enter a valid phone number, with the country code if it is not an Indian number.' : 'Enter the number we should call you on.');
  }
  const since = (await sql`SELECT max(created_at) AS at FROM support_chat_messages WHERE guest_id = ${guestId} AND role = 'system' AND ticket_id IS NOT NULL`)[0].at;
  const rows = (await sql`SELECT role, body, meta, created_at FROM support_chat_messages WHERE guest_id = ${guestId} AND role IN ('user', 'assistant')
                          AND created_at > COALESCE(${since}::timestamptz, 'epoch') ORDER BY created_at DESC, id DESC LIMIT 30`).reverse();
  const extra = String(note || '').trim().slice(0, MAX_TEXT);

  const lastHint = [...rows].reverse().find(r => r.role === 'assistant' && r.meta && r.meta.handoff);
  const category = (lastHint && lastHint.meta.handoff.category) || 'other';
  const orderId = (lastHint && lastHint.meta.handoff.orderId) || null;
  const firstUser = rows.find(r => r.role === 'user');
  const t = (d) => new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
  const transcript = rows.map(r => `[${t(r.created_at)}] ${r.role === 'user' ? 'Guest' : 'Assistant'}: ${String(r.body).replace(HANDOFF_RE, '').trim()}`).join('\n')
    + (extra ? `\n[${t(new Date())}] Guest: ${extra}` : '');
  const ticket = await support.createChatRequest(sql, { guestId, category, orderId, callbackPhone, subject: (firstUser ? firstUser.body : extra).split('\n')[0], transcript });
  if (extra) await sql`INSERT INTO support_chat_messages (guest_id, role, body) VALUES (${guestId}, 'user', ${extra})`;
  await sql`INSERT INTO support_chat_messages (guest_id, role, body, ticket_id, meta) VALUES (${guestId}, 'system',
              ${callbackPhone
                ? `Call back requested. Your reference is ${ticket.ref}. A member of Aerva Support will call you on ${callbackPhone} — usually within a few hours, and always within ${support.FIRST_RESPONSE_HOURS} hours. Anything you write here goes to them too.`
                : `You are now connected with an Aerva Support agent. Your reference is ${ticket.ref}. They will reply here — usually within a few hours, and always within ${support.FIRST_RESPONSE_HOURS} hours. We will also email you when they do.`},
              ${ticket.id}, ${JSON.stringify({ handoffDone: true })}::jsonb)`;
  await logAudit(sql, { action: 'support_chat_handoff', success: true, actorType: 'guest', actorIdentifier: String(guestId), targetType: 'support_ticket', targetId: ticket.id,
    metadata: { ref: ticket.ref, category, messages: rows.length, how: callbackPhone ? 'callback' : 'chat' } });
  return getThread(sql, guestId);
}

module.exports = { getThread, summary, send, handoff, loadPolicies, personContext, _internals: { HANDOFF_RE, RULES } };
