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
const budget = require('./_ai-budget');
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
- Say only what the person needs: what happens for them, what they should do, and by when. Never describe how Aerva works behind the scenes — who Aerva contacts, what is being checked or reviewed, whose answer is being waited for, or what Aerva will decide (owner, 12 Nov 2026). "Aerva is on it, and you will hear within 24 hours" is enough.
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
  const requests = await soft(sql`SELECT ref, subject, status, created_at FROM support_tickets t WHERE guest_id = ${guestId} AND COALESCE(to_jsonb(t)->>'channel', 'web') <> 'signed_out' ORDER BY id DESC LIMIT 5`);
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

// The policy corpus, as a system block the API will cache. It is the same
// bytes on every call and it is the bulk of what we send — around 27,000
// tokens — so it goes FIRST, before the per-path rules. A cache entry is
// keyed by the prefix it sits in, so putting the invariant first lets the
// guest assistant and the team's suggestion cards share one entry instead
// of warming two. A cached read costs a tenth of a fresh one.
// Caching has a minimum block size. The corpus is far above it in normal
// running, but if aerva-policies.js is missing or fails to parse the block
// would be a few words, and asking for that to be cached is pointless and
// can be rejected — so the marker is only set when there is something worth
// caching.
const CACHE_MIN_CHARS = 8000;
const policyBlock = () => {
  const text = 'AERVA POLICIES AND HELP TOPICS (the only rules you may state):\n\n' + loadPolicies();
  return text.length >= CACHE_MIN_CHARS
    ? { type: 'text', text, cache_control: { type: 'ephemeral' } }
    : { type: 'text', text };
};

// `opts.sql` opts the call into the budget: the day's ceiling is checked
// before the call and the API's own token counts are recorded after it.
// Without it the call still works — the photo and message checks elsewhere
// do not meter — but nothing is written down.
async function askModel(system, messages, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('ANTHROPIC_API_KEY not set'), { unavailable: true });
  const { sql = null, kind = 'other', by = null } = opts;
  if (sql) await budget.check(sql, { kind, by });
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 22000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL(), max_tokens: opts.maxTokens || 700, system, messages })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error((d.error && d.error.message) || `Anthropic API ${r.status}`), { unavailable: true });
    if (sql) await budget.record(sql, { kind, by, model: d.model || MODEL(), usage: d.usage || {} });
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
      policyBlock(),
      { type: 'text', text: RULES() },
      { type: 'text', text: 'THE PERSON YOU ARE HELPING (their own data — never reveal anyone else\'s):\n\n' + ctx.text }
    ];
    const raw = await askModel(system, messages, { sql, kind: 'chat' });
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

// ---------------------------------------------------------------- reply suggestions for the team

// Admin → Support: three replies the agent could send next, drafted from
// the request so far, Aerva's policies and the person's own bookings. The
// agent picks one, edits it if needed, and presses Send — nothing is ever
// sent by itself. Internal notes are shown to the model as the team's own
// context, never quoted back to the person.
const SUGGEST_RULES = () => `You help a member of Aerva's support team reply to a customer. Aerva (aerva.in) is a boutique platform in India for booking hand-picked homes ("stays") and experiences, and for hosts to list them.

Write THREE different replies the agent could send next, to the customer's latest message. Make them genuinely different: for example one that answers directly, one that asks for the one detail still needed, and one that reassures and says what happens next.

Rules:
- Use ONLY Aerva's policies and help topics below and the person's own account details. Never invent rules, amounts, dates or timelines.
- Do not promise a refund, an exception, a waiver or a decision. If one is needed, say the agent will check and come back, or that it has been passed to the team that decides.
- Never ask for card numbers, OTPs, passwords or full bank details. Never share another person's details.
- If anyone may be in danger, the first reply tells them to call 112 now.
- Warm, calm and professional, as a person writing (not "As an AI"). Address the person by first name when known. At most about 70 words each. Plain text only: no markdown.
- Reply in the language the customer is writing in.
- Internal notes in the conversation are the team's own context: use them, never mention or quote them.

Reply with JSON only, no other text: {"suggestions": ["…", "…", "…"]}`;

async function suggestReplies(sql, ticketId, by = null) {
  const t = (await sql`SELECT id, ref, subject, category, guest_id, status FROM support_tickets WHERE id = ${Number(ticketId) || 0}`)[0];
  if (!t) throw userError('Request not found.', 404);
  const msgs = await sql`SELECT sender, internal, body, created_at, to_jsonb(m)->>'via' AS via
                         FROM support_messages m WHERE ticket_id = ${t.id} ORDER BY created_at DESC, id DESC LIMIT 40`;
  const lines = msgs.reverse().filter(m => m.body).map(m => {
    const who = m.sender === 'user' ? 'Customer' : m.sender === 'system' ? 'System' : (m.internal ? 'Internal note (team only)' : 'Aerva Support');
    return `${who}: ${String(m.body).slice(0, 3000)}`;
  });
  let person = '';
  try { if (t.guest_id) person = (await personContext(sql, t.guest_id)).text; } catch (e) { person = ''; }
  // Cached policy block first, so this shares the cache entry the guest
  // assistant warms. It used to send a 60,000-character slice of the
  // policies fresh on every click, which was the whole cost of a suggestion.
  const system = [
    policyBlock(),
    { type: 'text', text: SUGGEST_RULES() + '\n\n# The customer\n' + (person || 'Account details unavailable.') }
  ];
  const user = `Request ${t.ref} — ${t.subject} (category: ${t.category}, status: ${t.status}).\n\nConversation so far, oldest first:\n${lines.join('\n\n') || '(no messages yet)'}\n\nWrite the three suggested replies now.`;
  let text;
  try { text = await askModel(system, [{ role: 'user', content: user }], { sql, kind: 'suggest', by }); }
  catch (err) { if (err.unavailable) throw userError('Suggestions are not available right now.', 503); throw err; }
  const m = String(text || '').match(/\{[\s\S]*\}/);
  let list = [];
  try { list = m ? JSON.parse(m[0]).suggestions : []; } catch (e) { list = []; }
  list = (Array.isArray(list) ? list : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 3).map(x => x.slice(0, 1200));
  if (!list.length) throw userError('No suggestions this time. Try again.', 502);
  return { suggestions: list };
}

// ---------------------------------------------------------------- the host side
//
// The owner's rule (14 Nov 2026): "AI should just summarise the issue and
// send to host. Further reply should be done by CR or reviewer only and ai
// suggestions should be given to them."
//
// So the model does exactly two things on the host channel, and neither of
// them sends anything:
//   • draftHostSummary — writes the opening message to the host: what the
//     booking is, what is being looked into, and the one question the host
//     needs to answer. A representative reads it, edits it if they like,
//     and sends it. Nothing reaches the host unsent.
//   • suggestHostReplies — after the host answers, offers three replies a
//     representative could send next, as cards. They pick one, or type
//     their own.
//
// Confidentiality is the hard part and it is in the prompt, not in review:
// the host must never be shown the guest's words, the guest's name beyond a
// first name, what the guest is asking Aerva for, or any accusation
// attributed to them. Aerva asks the host what happened in Aerva's own
// voice. The representative sees both sides; neither side sees the other's
// chat. The guest's own requested amounts and threats of a review are
// exactly the material that must not cross.

const HOST_CONFIDENTIALITY = `Confidentiality — these are absolute:
- NEVER quote or paraphrase the guest's message, and never say "the guest said", "the guest claims" or "the guest is asking for".
- NEVER mention what the guest wants from Aerva: no refund amount, no compensation, no cancellation request, no threat of a review, no mention of money at all.
- Use the guest's FIRST NAME only, or "the guest". Never their surname, email, phone number or account details.
- Do not take sides, do not suggest the host is at fault, and do not repeat an accusation. Aerva is asking what happened, not accusing.
- Write as Aerva ("we"), not as the guest's messenger.`;

const HOST_SUMMARY_RULES = () => `You write the first message Aerva's support team sends to a HOST about a stay of theirs. Aerva (aerva.in) is a boutique platform in India for booking hand-picked homes.

A guest has raised something about this booking. Your job is to tell the host, neutrally, what is being looked into and ask them the one thing Aerva needs from them.

${HOST_CONFIDENTIALITY}

Shape of the message:
- Open by naming the booking: the listing and the dates.
- One or two sentences on the subject in neutral terms ("a question has come up about the hot water during their stay"), never as a complaint or a claim.
- Then the single most useful question for the host to answer, so one reply settles it.
- Close by saying when Aerva needs to hear back (24 hours) and that their reply is not shared with the guest.
- Warm, calm, respectful of the host. At most about 110 words. Plain text only: no markdown, no headings, no bullet points. Do not sign off with a name.

Reply with JSON only, no other text: {"summary": "…"}`;

const HOST_SUGGEST_RULES = () => `You help a member of Aerva's support team reply to a HOST on Aerva's private channel with that host. Aerva (aerva.in) is a boutique platform in India for booking hand-picked homes.

Write THREE different replies the team member could send the host next, in answer to what the host has just said. Make them genuinely different: for example one that thanks them and closes the exchange, one that asks for the single detail still missing (a photo, a date, a meter reading), and one that tells them what happens next.

${HOST_CONFIDENTIALITY}

Rules:
- Use ONLY Aerva's policies below and the facts in this conversation. Never invent rules, amounts, dates or timelines.
- Do NOT tell the host what Aerva will decide, pay, refund, withhold or deduct, and never promise them an outcome either way. If that is coming, say the team is reviewing it and they will hear.
- Never ask the host for bank details, a password or an OTP.
- Internal notes in the conversation are the team's own context: use them, never mention or quote them.
- Warm, calm and professional, as a person writing. At most about 70 words each. Plain text only: no markdown.
- Reply in the language the host is writing in.

Reply with JSON only, no other text: {"suggestions": ["…", "…", "…"]}`;

// What both host-side calls are allowed to know about the case. The guest's
// own messages are summarised down to a subject line and the team's internal
// notes, never passed through verbatim — the cheapest confidentiality
// guarantee is not sending the material at all.
async function hostCaseFacts(sql, t) {
  const booking = (await sql`SELECT o.id, o.confirmation_code, o.arrival, o.departure, o.guests,
                                    l.property_name AS listing, l.city,
                                    NULLIF(COALESCE(NULLIF(btrim(g.first_name), ''), split_part(btrim(g.name), ' ', 1)), '') AS guest_first
                             FROM support_tickets st
                             LEFT JOIN orders o   ON o.id = st.order_id
                             LEFT JOIN listings l ON l.id = o.listing_id
                             LEFT JOIN guests g   ON g.id = st.guest_id
                             WHERE st.id = ${t.id}`)[0] || {};
  const notes = await sql`SELECT body FROM support_messages
                          WHERE ticket_id = ${t.id} AND internal = true AND body IS NOT NULL
                          ORDER BY created_at ASC, id ASC LIMIT 10`;
  const parts = [
    `Request ${t.ref} — subject as the guest titled it: ${t.subject}`,
    `Category: ${support.CATEGORIES[t.category] || t.category}`,
    booking.listing ? `Booking: ${booking.listing}${booking.city ? ', ' + booking.city : ''}` : 'Booking: not linked to this request',
    booking.confirmation_code ? `Confirmation code: ${booking.confirmation_code}` : '',
    booking.arrival ? `Dates: ${String(booking.arrival).slice(0, 10)} to ${String(booking.departure).slice(0, 10)}${booking.guests ? ` · ${booking.guests} guest(s)` : ''}` : '',
    booking.guest_first ? `Guest's first name: ${booking.guest_first}` : '',
    notes.length ? 'The team\'s internal notes on the case (your context — never repeat these to the host):\n' + notes.map(n => `- ${String(n.body).slice(0, 1200)}`).join('\n') : ''
  ].filter(Boolean);
  return { text: parts.join('\n'), booking };
}

// Did the draft carry the guest's own words or their money across? Returns
// why, or null when it is clean.
//
//  • Money: a host being asked what happened has no business being told a
//    sum. Any amount in the draft is a leak, whether or not the guest named
//    that figure — Aerva does not discuss money with a host through this
//    channel at all.
//  • Wording: a run of six or more words shared with what the guest wrote
//    is a quote however it is introduced. Short overlaps are ordinary
//    English ("the hot water in the bathroom") and are left alone.
const STOP_WORDS = 6;
function normWords(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9₹\s]/g, ' ').split(/\s+/).filter(Boolean);
}
function leakedFromGuest(draft, guestBodies) {
  const d = String(draft || '');
  if (/(?:₹|rs\.?\s*|inr\s*)\s*\d/i.test(d)) return 'the draft names an amount of money';
  // A bare figure is only a leak if the guest actually wrote that figure —
  // otherwise a year, a pin code or the booking's own confirmation code
  // would be rejected for looking like a price. So the guest's numbers are
  // the list, and the draft must not repeat any of them.
  const theirs = new Set();
  for (const body of guestBodies || []) {
    for (const n of String(body || '').match(/\d[\d,]{2,}/g) || []) theirs.add(n.replace(/,/g, ''));
  }
  if (theirs.size) {
    for (const n of d.match(/\d[\d,]{2,}/g) || []) {
      if (theirs.has(n.replace(/,/g, ''))) return 'the draft repeats a figure the guest named';
    }
  }
  const dw = normWords(d);
  if (dw.length < STOP_WORDS) return null;
  for (const body of guestBodies || []) {
    const gw = normWords(body);
    if (gw.length < STOP_WORDS) continue;
    const spans = new Set();
    for (let i = 0; i + STOP_WORDS <= gw.length; i++) spans.add(gw.slice(i, i + STOP_WORDS).join(' '));
    for (let i = 0; i + STOP_WORDS <= dw.length; i++) {
      if (spans.has(dw.slice(i, i + STOP_WORDS).join(' '))) return 'the draft repeats the guest’s own wording';
    }
  }
  return null;
}

// The opening message to the host. Returned for a representative to read,
// edit and send — this function never sends it. No policy corpus: writing a
// neutral summary of one case needs the case, not Aerva's rule book, and
// the corpus is the expensive part of a call.
async function draftHostSummary(sql, ticketId, by = null) {
  const t = (await sql`SELECT id, ref, subject, category, guest_id, order_id, status, host_ask
                       FROM support_tickets WHERE id = ${Number(ticketId) || 0}`)[0];
  if (!t) throw userError('Request not found.', 404);
  const facts = await hostCaseFacts(sql, t);
  const guestWords = await sql`SELECT body FROM support_messages
                               WHERE ticket_id = ${t.id} AND sender = 'user' AND internal = false AND body IS NOT NULL
                               ORDER BY created_at ASC, id ASC LIMIT 6`;
  const system = [{ type: 'text', text: HOST_SUMMARY_RULES() }];
  const user = `${facts.text}

What the guest wrote, for YOUR understanding only — you must not quote it, paraphrase it as theirs, or pass on anything they are asking Aerva for:
${guestWords.map(m => `- ${String(m.body).slice(0, 1500)}`).join('\n') || '- (nothing in writing yet)'}

Write the message to the host now.`;
  let text;
  try { text = await askModel(system, [{ role: 'user', content: user }], { sql, kind: 'host_summary', by, maxTokens: 500 }); }
  catch (err) { if (err.unavailable) throw userError('The draft is not available right now — write the question to the host yourself.', 503); throw err; }
  const m = String(text || '').match(/\{[\s\S]*\}/);
  let summary = '';
  try { summary = m ? String(JSON.parse(m[0]).summary || '') : ''; } catch (e) { summary = ''; }
  summary = summary.replace(/\*\*/g, '').replace(/^#+\s*/gm, '').trim().slice(0, 1500);
  if (!summary) throw userError('No draft this time. Try again, or write the question yourself.', 502);
  // The model has to see the complaint to summarise it, so the rule against
  // passing it on is an instruction — and an instruction is not a
  // guarantee. This is the guarantee: the draft is checked against what the
  // guest actually wrote before a representative is ever shown it. A draft
  // that borrows the guest's own wording, or carries a sum of money, is
  // thrown away rather than offered for sending.
  const leak = leakedFromGuest(summary, guestWords.map(x => x.body));
  if (leak) {
    await logAudit(sql, { action: 'support_host_draft_withheld', success: false, actorType: 'admin',
      actorIdentifier: by || 'unknown', targetType: 'support_ticket', targetId: t.id, metadata: { why: leak } }).catch(() => {});
    throw userError('The draft came back carrying the guest’s own words, so it has not been shown. Try again, or write the question to the host yourself.', 502);
  }
  return { summary, booking: facts.booking.confirmation_code || null, draft: true };
}

// Three replies a representative could send the host next. Cards only —
// nothing is sent until they choose one and press send.
async function suggestHostReplies(sql, ticketId, by = null) {
  const t = (await sql`SELECT id, ref, subject, category, guest_id, order_id, status, host_ask, host_reply
                       FROM support_tickets WHERE id = ${Number(ticketId) || 0}`)[0];
  if (!t) throw userError('Request not found.', 404);
  const facts = await hostCaseFacts(sql, t);
  // The host channel itself: what Aerva has said to this host and what the
  // host said back. The guest's chat is deliberately not here.
  // The host channel is the booking's own thread, restricted to what the
  // host is shown — the same rows Admin puts in the right-hand column. The
  // guest-only messages of that thread are excluded by the audience filter,
  // so nothing the guest wrote can reach this prompt through it.
  let thread = [];
  if (t.order_id) {
    try {
      thread = await sql`SELECT m.sender_type, m.display_text, m.created_at
                         FROM messages m JOIN conversations c ON c.id = m.conversation_id
                         WHERE c.order_id = ${t.order_id} AND m.unsent_at IS NULL
                           AND m.display_text IS NOT NULL
                           AND COALESCE(m.audience, 'both') IN ('both', 'host')
                         ORDER BY m.created_at ASC, m.id ASC LIMIT 30`;
    } catch (err) { thread = []; }
  }
  // The booking thread can carry messages the guest sent the host directly.
  // Those the host has already read, so they are fair context — but they
  // must be labelled as the guest's, never as Aerva's.
  const WHO = { host: 'Host', guest: 'The guest, writing to the host directly', system: 'Aerva Support', admin: 'Aerva Support' };
  const lines = thread.map(m => `${WHO[m.sender_type] || 'Aerva Support'}: ${String(m.display_text).slice(0, 2000)}`);
  if (!lines.length) {
    if (t.host_ask) lines.push(`Aerva Support: ${String(t.host_ask).slice(0, 2000)}`);
    if (t.host_reply) lines.push(`Host: ${String(t.host_reply).slice(0, 2000)}`);
  }
  const system = [
    policyBlock(),
    { type: 'text', text: HOST_SUGGEST_RULES() + '\n\n# The case\n' + facts.text }
  ];
  const user = `Aerva's private channel with the host, oldest first:
${lines.join('\n\n') || '(nothing sent to the host yet)'}

Write the three suggested replies to the host now.`;
  let text;
  try { text = await askModel(system, [{ role: 'user', content: user }], { sql, kind: 'host_suggest', by }); }
  catch (err) { if (err.unavailable) throw userError('Suggestions are not available right now.', 503); throw err; }
  const m = String(text || '').match(/\{[\s\S]*\}/);
  let list = [];
  try { list = m ? JSON.parse(m[0]).suggestions : []; } catch (e) { list = []; }
  list = (Array.isArray(list) ? list : []).map(x => String(x || '').replace(/\*\*/g, '').trim()).filter(Boolean).slice(0, 3).map(x => x.slice(0, 1200));
  if (!list.length) throw userError('No suggestions this time. Try again.', 502);
  return { suggestions: list };
}

module.exports = {
  getThread, summary, send, handoff, loadPolicies, personContext, suggestReplies,
  draftHostSummary, suggestHostReplies,
  _internals: { HANDOFF_RE, RULES, HOST_CONFIDENTIALITY, hostCaseFacts, leakedFromGuest }
};
