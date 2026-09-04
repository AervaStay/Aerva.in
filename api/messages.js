// /api/messages.js
// Host-guest chat, gated to confirmed bookings only. One conversation per
// paid order (see schema.sql) — a guest cannot message a host at all
// without an actual confirmed booking for that listing; there is no
// "contact host" path anywhere else on the site that reaches this.
//
// Modes (all require Authorization: Bearer <guestSessionToken> — the same
// shared login guests and hosts both use elsewhere on the site):
//   GET  ?mode=conversation&orderId=X     — fetch/create the conversation for one order, with its messages
//   GET  ?mode=hostConversations          — a host's inbox: every conversation across their listings
//   GET  ?mode=templates                  — a host's own quick-reply templates
//   POST { mode: 'send', conversationId, text }
//   POST { mode: 'saveTemplate', templateId?, listingId?, body }
//   POST { mode: 'deleteTemplate', templateId }
//
// IMPORTANT, and worth being upfront about: the phone-number/contact-info
// filtering below is pattern-based (regex + a spelled-out-digits check).
// It catches the overwhelming majority of real attempts — plain digit
// sequences, common separators, spelled-out numbers, emails, and
// Instagram/Facebook mentions — but no text filter can catch every
// possible obfuscation a determined person invents (letter-substituted
// digits, unicode lookalikes, numbers split across multiple messages,
// etc.). This is a real, known limitation of any keyword/pattern-based
// approach, not a bug — a fully robust version would need ML-based
// moderation, which is out of scope here.

const { neon } = require('@neondatabase/serverless');
const { verifyToken } = require('./_approval-token');

const sql = neon(process.env.DATABASE_URL);

function requireUser(req) {
  const authHeader = req.headers['authorization'] || '';
  const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = sessionToken ? verifyToken(sessionToken) : null;
  if (!payload || payload.action !== 'guest-session') return null;
  return payload.listingId; // generically-named token field (see guest-profile.js's own note) — this is the guest/host's account id
}

// ---- Contact-info redaction (server-side, authoritative) ----
// Never trust a client-side-only filter for this — this same function is
// the one actually enforced before anything is stored/shown, regardless
// of what the browser's own input restrictions (see index.html) already
// tried to block.
const NUMBER_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9', oh: '0'
};

function redactContactInfo(text) {
  let result = text;
  let redacted = false;

  // Email addresses.
  result = result.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, () => { redacted = true; return '[email removed]'; });

  // Phone numbers as digits, with or without spaces/dashes/dots/parens/
  // country code — 7+ digits total is long enough to be a real number,
  // short enough to still catch a 7-digit local-format one.
  result = result.replace(/(\+?\d[\d\s\-.()]{6,}\d)/g, (match) => {
    const digitCount = (match.match(/\d/g) || []).length;
    if (digitCount < 7) return match;
    redacted = true;
    return '[number removed]';
  });

  // Spelled-out digits — "nine eight seven six five four three two one
  // zero" or similar, 7+ consecutive number-words. Deliberately
  // conservative (whole-word matches only, separated by spaces/commas/
  // dashes) to avoid flagging ordinary sentences that just happen to
  // contain a couple of number-words.
  const words = result.split(/(\s+)/);
  let run = [];
  function flushRun(){
    if (run.length >= 7) {
      redacted = true;
      const runIndices = run.map(r => r.idx);
      for (const idx of runIndices) words[idx] = '[number removed]';
      // Collapse consecutive replacement tokens so it doesn't read as
      // "[number removed] [number removed] [number removed]...".
    }
    run = [];
  }
  words.forEach((w, idx) => {
    const clean = w.toLowerCase().replace(/[.,\-]/g, '');
    if (NUMBER_WORDS[clean] !== undefined) {
      run.push({ idx });
    } else if (w.trim() === '') {
      // whitespace — allow the run to continue across it
    } else {
      flushRun();
    }
  });
  flushRun();
  result = words.join('');
  // Collapse any run of consecutive "[number removed]" tokens into one.
  result = result.replace(/(\[number removed\]\s*){2,}/g, '[number removed] ');

  // Instagram / Facebook / other social handles — keyword-anchored
  // rather than bare "@", since "@" alone is too common in normal text
  // to safely strip.
  result = result.replace(/\b(instagram|insta|ig|facebook|fb|whatsapp|telegram|snapchat)\b\s*[:@]?\s*[a-zA-Z0-9._]{2,}/gi, () => { redacted = true; return '[contact info removed]'; });
  result = result.replace(/\b(instagram\.com|facebook\.com|fb\.com|wa\.me|t\.me)\/[a-zA-Z0-9._]+/gi, () => { redacted = true; return '[contact info removed]'; });

  return { displayText: result, wasRedacted: redacted };
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = requireUser(req);
  if (!userId) return res.status(401).json({ error: 'Please log in again.' });

  try {
    // ---- GET modes ----
    if (req.method === 'GET') {
      const mode = req.query.mode;

      if (mode === 'conversation') {
        const orderId = Number(req.query.orderId);
        if (!orderId) return res.status(400).json({ error: 'Missing order.' });

        const orderRows = await sql`
          SELECT o.id, o.listing_id, o.guest_id, o.guest_email, o.status, l.host_id, l.property_name
          FROM orders o
          JOIN listings l ON l.id = o.listing_id
          WHERE o.id = ${orderId}
        `;
        const order = orderRows[0];
        if (!order) return res.status(404).json({ error: 'Booking not found.' });
        if (order.status !== 'paid') {
          return res.status(403).json({ error: 'A conversation only opens once a booking is confirmed.' });
        }
        const isGuest = order.guest_id === userId;
        const isHost = order.host_id === userId;
        if (!isGuest && !isHost) return res.status(403).json({ error: 'Not your booking.' });

        // First message from either side creates the conversation row —
        // kept a no-op if it already exists (UNIQUE(order_id) in schema).
        let convRows = await sql`SELECT id FROM conversations WHERE order_id = ${orderId}`;
        let conversationId;
        if (convRows.length) {
          conversationId = convRows[0].id;
        } else {
          const inserted = await sql`
            INSERT INTO conversations (order_id, listing_id, guest_id, guest_email, host_id)
            VALUES (${orderId}, ${order.listing_id}, ${order.guest_id}, ${order.guest_email}, ${order.host_id})
            RETURNING id
          `;
          conversationId = inserted[0].id;
        }

        const messages = await sql`
          SELECT id, sender_type, display_text, was_redacted, created_at
          FROM messages WHERE conversation_id = ${conversationId} ORDER BY created_at ASC
        `;
        return res.status(200).json({ conversationId, listingName: order.property_name, viewerRole: isHost ? 'host' : 'guest', messages });
      }

      if (mode === 'hostConversations') {
        const conversations = await sql`
          SELECT c.id, c.listing_id, c.guest_email, l.property_name,
                 (SELECT display_text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
                 (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
          FROM conversations c
          JOIN listings l ON l.id = c.listing_id
          WHERE c.host_id = ${userId}
          ORDER BY last_message_at DESC NULLS LAST
        `;
        return res.status(200).json({ conversations });
      }

      if (mode === 'templates') {
        const templates = await sql`
          SELECT id, listing_id, body, sort_order FROM message_templates
          WHERE host_id = ${userId} ORDER BY sort_order ASC, created_at ASC
        `;
        return res.status(200).json({ templates });
      }

      return res.status(400).json({ error: 'Unknown mode.' });
    }

    // ---- POST modes ----
    if (req.method === 'POST') {
      const { mode } = req.body || {};

      if (mode === 'send') {
        const { conversationId, text } = req.body || {};
        const rawText = typeof text === 'string' ? text.trim().slice(0, 2000) : '';
        if (!conversationId || !rawText) return res.status(400).json({ error: 'Message can\'t be empty.' });

        const convRows = await sql`SELECT id, guest_id, host_id FROM conversations WHERE id = ${conversationId}`;
        const conv = convRows[0];
        if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
        const isGuest = conv.guest_id === userId;
        const isHost = conv.host_id === userId;
        if (!isGuest && !isHost) return res.status(403).json({ error: 'Not your conversation.' });

        const { displayText, wasRedacted } = redactContactInfo(rawText);
        const inserted = await sql`
          INSERT INTO messages (conversation_id, sender_type, original_text, display_text, was_redacted)
          VALUES (${conversationId}, ${isHost ? 'host' : 'guest'}, ${rawText}, ${displayText}, ${wasRedacted})
          RETURNING id, sender_type, display_text, was_redacted, created_at
        `;
        return res.status(200).json({ message: inserted[0] });
      }

      if (mode === 'saveTemplate') {
        const { templateId, listingId, body } = req.body || {};
        const safeBody = typeof body === 'string' ? body.trim().slice(0, 500) : '';
        if (!safeBody) return res.status(400).json({ error: 'Template text can\'t be empty.' });

        // A listing-scoped template must actually belong to this host —
        // never trust a listingId from the client without checking.
        if (listingId) {
          const ownedRows = await sql`SELECT id FROM listings WHERE id = ${listingId} AND host_id = ${userId}`;
          if (!ownedRows.length) return res.status(403).json({ error: 'Not your listing.' });
        }

        if (templateId) {
          const updated = await sql`
            UPDATE message_templates SET body = ${safeBody}, listing_id = ${listingId || null}
            WHERE id = ${templateId} AND host_id = ${userId} RETURNING id
          `;
          if (!updated.length) return res.status(404).json({ error: 'Template not found.' });
          return res.status(200).json({ id: updated[0].id });
        }
        const inserted = await sql`
          INSERT INTO message_templates (host_id, listing_id, body) VALUES (${userId}, ${listingId || null}, ${safeBody}) RETURNING id
        `;
        return res.status(200).json({ id: inserted[0].id });
      }

      if (mode === 'deleteTemplate') {
        const { templateId } = req.body || {};
        if (!templateId) return res.status(400).json({ error: 'Missing template.' });
        await sql`DELETE FROM message_templates WHERE id = ${templateId} AND host_id = ${userId}`;
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Unknown mode.' });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('messages.js error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
