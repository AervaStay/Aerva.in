// /api/_template-scheduling.js
// Shared by verify-payment.js (the actual trigger point — right after an
// order is marked 'paid') and kept alongside the rest of the messaging
// logic conceptually, even though guest-profile.js doesn't need to
// import this directly today. Not an API endpoint itself — the leading
// underscore is what tells Vercel that, same convention as
// _approval-token.js, _audit-log.js, etc.
//
// Only one trigger exists right now: "once a guest confirms a booking."
// Delayed/timed triggers (after N minutes, before check-in, on check-in
// day) need something checking every few minutes to fire accurately —
// Vercel's Hobby plan only allows cron jobs to run once per day, so
// those are deferred until either upgrading to Pro or wiring an
// external frequent-cron pinger.

// Same placeholder set index.html's client-side resolver uses (for a
// host manually clicking a template into the chat box) — kept in sync
// by hand since this is a separate serverless file with no shared
// module system to import from the frontend.
const TEMPLATE_PLACEHOLDER_MAP = {
  '@guestname': d => d.guestName || d.guestEmail || 'Guest',
  '@checkin': d => d.checkInTime || '(check-in time not set yet)',
  '@checkout': d => d.checkOutTime || '(check-out time not set yet)',
  '@wifiname': d => d.wifiName || '(WiFi name not set yet)',
  '@wifipassword': d => d.wifiPassword || '(WiFi password not set yet)',
  '@accesscode': d => d.accessCode || '(access code not set yet)',
  '@location': d => d.locationText || '(location not set yet)'
};

function resolveBasePlaceholders(text, data) {
  let result = text;
  for (const [key, getValue] of Object.entries(TEMPLATE_PLACEHOLDER_MAP)) {
    if (result.toLowerCase().includes(key)) {
      result = result.replace(new RegExp(key, 'gi'), getValue(data));
    }
  }
  return result;
}

function resolveTemplateText(text, data) {
  let result = resolveBasePlaceholders(text, data);
  // @guidance is handled separately — the Description tab's own free
  // text may itself contain @checkin/@wifiname/etc. (a host writing
  // their property description using the same keywords), resolved one
  // level deep before being dropped into whatever template used
  // @guidance. Kept in sync with index.html's identical client-side
  // logic (resolveTemplatePlaceholders/resolveBasePlaceholders there).
  if (result.toLowerCase().includes('@guidance')) {
    const rawGuidance = data.guestGuidance || '(no additional guidance set yet)';
    const resolvedGuidance = resolveBasePlaceholders(rawGuidance, data);
    result = result.replace(/@guidance/gi, resolvedGuidance);
  }
  return result;
}

// Called right after a stay's order is inserted with status='paid'.
// order needs: { id, listing_id, guest_id, guest_email }. Never throws —
// an auto-message failing to send should never break the actual booking
// confirmation that triggered it, same principle as _audit-log.js's own
// "never let a side-effect break the main action" rule.
async function sendBookingConfirmedTemplates(sql, order) {
  try {
    if (!order.listing_id) return;

    const listingRows = await sql`
      SELECT id, host_id, formatted_address, area, city,
             check_in_time, check_out_time, wifi_name, wifi_password, access_code, guest_guidance
      FROM listings WHERE id = ${order.listing_id}
    `;
    const listing = listingRows[0];
    if (!listing || !listing.host_id) return;

    // message_templates.host_id stores the owning account's own
    // guests.id (a different convention from listings.host_id, which is
    // a hosts.id — see guest-profile.js's myHostId comment for the full
    // explanation of this distinction). Resolved here the same way.
    const ownerRows = await sql`SELECT id, name FROM guests WHERE host_id = ${listing.host_id}`;
    const owner = ownerRows[0];
    if (!owner) return;

    const templates = await sql`
      SELECT id, body, auto_send_listing_ids FROM message_templates
      WHERE host_id = ${owner.id} AND send_on_booking_confirmed = true
    `;
    if (!templates.length) return;

    const applicable = templates.filter(t => {
      const ids = Array.isArray(t.auto_send_listing_ids) ? t.auto_send_listing_ids : [];
      return ids.length === 0 || ids.includes(listing.id);
    });
    if (!applicable.length) return;

    let guestName = order.guest_email;
    if (order.guest_id) {
      const guestRows = await sql`SELECT name FROM guests WHERE id = ${order.guest_id}`;
      if (guestRows[0] && guestRows[0].name) guestName = guestRows[0].name;
    }

    const locationText = listing.formatted_address
      || [listing.area, listing.city].filter(Boolean).join(', ')
      || null;
    const placeholderData = {
      guestName, guestEmail: order.guest_email,
      checkInTime: listing.check_in_time, checkOutTime: listing.check_out_time,
      wifiName: listing.wifi_name, wifiPassword: listing.wifi_password,
      accessCode: listing.access_code, locationText, guestGuidance: listing.guest_guidance
    };

    // Same find-or-create pattern as guest-profile.js's mode=conversation
    // — a conversation may already exist if the guest messaged first
    // for some reason before this fires (rare, but the order+message
    // flow shouldn't assume ordering).
    let convRows = await sql`SELECT id FROM conversations WHERE order_id = ${order.id}`;
    let conversationId;
    if (convRows.length) {
      conversationId = convRows[0].id;
    } else {
      const inserted = await sql`
        INSERT INTO conversations (order_id, listing_id, guest_id, guest_email, host_id)
        VALUES (${order.id}, ${order.listing_id}, ${order.guest_id}, ${order.guest_email}, ${listing.host_id})
        RETURNING id
      `;
      conversationId = inserted[0].id;
    }

    for (const t of applicable) {
      const resolvedText = resolveTemplateText(t.body, placeholderData);
      await sql`
        INSERT INTO messages (conversation_id, sender_type, original_text, display_text, was_redacted)
        VALUES (${conversationId}, 'host', ${resolvedText}, ${resolvedText}, false)
      `;
    }
  } catch (err) {
    console.error('sendBookingConfirmedTemplates failed:', err);
  }
}

module.exports = { resolveTemplateText, sendBookingConfirmedTemplates };
