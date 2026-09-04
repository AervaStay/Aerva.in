// /api/guest-profile.js
// Everything a logged-in guest's profile page needs, in one call, plus the
// ability to update their own name and profile photo — and, folded in
// here rather than as a separate file (Vercel Hobby plan's 12-function
// cap), the host-guest chat feature: conversations, sending messages
// with contact-info redaction, and host quick-reply templates.
//
//   GET  (Authorization: Bearer <guestSessionToken>)
//     Returns { guest, bookings, reviews }. "guest" includes a computed
//     "badge" field derived from guest_reviews — see computeBadge() below.
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
//   POST { mode: 'send', conversationId, text }
//   POST { mode: 'saveTemplate', templateId?, listingId?, body }
//   POST { mode: 'deleteTemplate', templateId }
//
// A conversation only ever exists tied to a confirmed (status='paid')
// order — there is no path anywhere on the site for a guest to message a
// host without an actual booking. See redactContactInfo() below for the
// message-filtering approach and its real, worth-knowing limitations.

const { neon } = require('@neondatabase/serverless');
const { verifyToken } = require('./_approval-token');
const { logAudit } = require('./_audit-log');

const sql = neon(process.env.DATABASE_URL);

// Badge tiers, computed fresh from guest_reviews on every profile load —
// not stored, so it's always accurate as new reviews come in. Deliberately
// not called "Superhost" (that's Airbnb's term) — this is Aerva's own
// guest-reputation ladder.
function computeBadge(reviewCount, avgRating) {
  if (reviewCount >= 5 && avgRating >= 4.8) return 'Aerva Favorite';
  if (reviewCount >= 3 && avgRating >= 4.5) return 'Trusted Guest';
  if (reviewCount >= 1 && avgRating >= 4.0) return 'Valued Guest';
  return null; // not enough of a track record yet — profile just shows no badge
}

function requireGuest(req) {
  const authHeader = req.headers['authorization'] || '';
  const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = sessionToken ? verifyToken(sessionToken) : null;
  if (!payload || payload.action !== 'guest-session') return null;
  return payload.listingId; // generically-named token field — see host-auth.js note; here it's the guest's id
}

// ---- Contact-info redaction (server-side, authoritative) ----
// Never trust a client-side-only filter for this — this function is what
// actually gets enforced before anything is stored/shown, regardless of
// whatever input restrictions the browser itself already tried (see
// index.html). Worth being upfront: this is pattern-based (regex + a
// spelled-out-digits check). It catches the overwhelming majority of real
// attempts — plain digit sequences in any spacing, spelled-out numbers,
// emails, and Instagram/Facebook/WhatsApp/Telegram mentions and links —
// but no text filter can catch every possible obfuscation a determined
// person invents (letter-substituted digits, unicode lookalikes, a
// number split across two messages, etc.). That's a genuine, known limit
// of any pattern-based approach, not a bug fixable with more regex.
const NUMBER_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9', oh: '0'
};

function redactContactInfo(text) {
  let result = text;
  let redacted = false;

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

  return { displayText: result, wasRedacted: redacted };
}

module.exports = async (req, res) => {
  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const guestId = requireGuest(req);
  if (!guestId) return res.status(401).json({ error: 'Please log in again.' });

  // ---- Fetch the full profile bundle, or a chat-related GET mode ----
  if (req.method === 'GET') {
    const mode = req.query.mode;
    try {
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
        const isGuest = order.guest_id === guestId;
        const isHost = order.host_id === guestId;
        if (!isGuest && !isHost) return res.status(403).json({ error: 'Not your booking.' });

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
          WHERE c.host_id = ${guestId}
          ORDER BY last_message_at DESC NULLS LAST
        `;
        return res.status(200).json({ conversations });
      }

      if (mode === 'templates') {
        const templates = await sql`
          SELECT id, listing_id, body, sort_order FROM message_templates
          WHERE host_id = ${guestId} ORDER BY sort_order ASC, created_at ASC
        `;
        return res.status(200).json({ templates });
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
        if (conv.guest_id !== guestId && conv.host_id !== guestId) return res.status(403).json({ error: 'Not your conversation.' });

        const templates = await sql`
          SELECT id, body FROM message_templates
          WHERE host_id = ${conv.host_id} AND (listing_id = ${conv.listing_id} OR listing_id IS NULL)
          ORDER BY sort_order ASC, created_at ASC
        `;
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
        SELECT id, suite_name, listing_id, arrival, departure, guests, nights,
               subtotal, discount_amount, gst, total, status, created_at
        FROM orders
        WHERE guest_id = ${guestId}
        ORDER BY created_at DESC
      `;

      const reviews = await sql`
        SELECT rating, comment, created_at FROM guest_reviews
        WHERE guest_id = ${guestId}
        ORDER BY created_at DESC
      `;

      const reviewCount = reviews.length;
      const avgRating = reviewCount
        ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviewCount
        : 0;

      return res.status(200).json({
        guest: {
          id: guest.id,
          email: guest.email,
          phone: guest.phone,
          name: guest.name,
          profilePhotoUrl: guest.profile_photo_url,
          preferredCurrency: guest.preferred_currency || null,
          memberSince: guest.created_at,
          badge: computeBadge(reviewCount, avgRating),
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
      if (mode === 'send') {
        const { conversationId, text } = req.body || {};
        const rawText = typeof text === 'string' ? text.trim().slice(0, 2000) : '';
        if (!conversationId || !rawText) return res.status(400).json({ error: 'Message can\'t be empty.' });

        const convRows = await sql`SELECT id, guest_id, host_id FROM conversations WHERE id = ${conversationId}`;
        const conv = convRows[0];
        if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
        const isGuest = conv.guest_id === guestId;
        const isHost = conv.host_id === guestId;
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

        if (listingId) {
          const ownedRows = await sql`SELECT id FROM listings WHERE id = ${listingId} AND host_id = ${guestId}`;
          if (!ownedRows.length) return res.status(403).json({ error: 'Not your listing.' });
        }

        if (templateId) {
          const updated = await sql`
            UPDATE message_templates SET body = ${safeBody}, listing_id = ${listingId || null}
            WHERE id = ${templateId} AND host_id = ${guestId} RETURNING id
          `;
          if (!updated.length) return res.status(404).json({ error: 'Template not found.' });
          return res.status(200).json({ id: updated[0].id });
        }
        const inserted = await sql`
          INSERT INTO message_templates (host_id, listing_id, body) VALUES (${guestId}, ${listingId || null}, ${safeBody}) RETURNING id
        `;
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
      const safeName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : undefined;
      // Whitelisted currency codes only — this is a display preference,
      // not something that should ever accept arbitrary input.
      const SUPPORTED_CURRENCIES = ['INR', 'USD', 'GBP', 'EUR', 'AUD', 'CAD'];
      const safeCurrency = typeof preferredCurrency === 'string' && SUPPORTED_CURRENCIES.includes(preferredCurrency.toUpperCase())
        ? preferredCurrency.toUpperCase()
        : undefined;

      if (safeName === undefined && safePhotoUrl === undefined && safeCurrency === undefined) {
        return res.status(400).json({ error: 'Nothing to update.' });
      }

      const updated = await sql`
        UPDATE guests SET
          name = COALESCE(${safeName ?? null}, name),
          profile_photo_url = COALESCE(${safePhotoUrl ?? null}, profile_photo_url),
          preferred_currency = COALESCE(${safeCurrency ?? null}, preferred_currency)
        WHERE id = ${guestId}
        RETURNING id, name, profile_photo_url, preferred_currency
      `;

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
