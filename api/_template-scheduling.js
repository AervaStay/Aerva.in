// /api/_template-scheduling.js
// Shared by verify-payment.js (the actual trigger point — right after an
// order is marked 'paid') and kept alongside the rest of the messaging
// logic conceptually, even though guest-profile.js doesn't need to
// import this directly today. Not an API endpoint itself — the leading
// underscore is what tells Vercel that, same convention as
// _approval-token.js, _audit-log.js, etc.
//
// When a template is sent (message_templates.send_trigger):
//   manual            — only when the host taps it
//   booking_confirmed — the moment payment is confirmed (verify-payment.js)
//   before_checkin    ┐ a number of hours or days (send_offset_minutes)
//   after_checkin     │ before / after the listing's check-in or check-out
//   before_checkout   │ TIME on the booking's dates, in the property's own
//   after_checkout    ┘ time zone (listings.timezone)
//   checkin_day       — the morning of the arrival day   ┐ from 07:30
//   checkout_day      — the morning of the departure day ┘ local time
// Run by get-listings.js: ?runSchedules=1 (an external every-5-minutes
// pinger such as cron-job.org), the daily cron, and site traffic. A
// "before" message missed (late booking, or the job did not run) is still
// sent until the check-in / check-out time; an "after" message up to 12
// hours late, never later. Every send is recorded in template_sends, so a
// template never reaches the same booking twice.

// Same placeholder set index.html's client-side resolver uses (for a
// host manually clicking a template into the chat box) — kept in sync
// by hand since this is a separate serverless file with no shared
// module system to import from the frontend.
const { redactContactInfo } = require('./_redact');

function fmtDay(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d)) return null;
  // Built by hand so the server and every browser write it identically.
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${WD[d.getUTCDay()]}, ${d.getUTCDate()} ${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function mapLink(d) {
  const lat = Number(d.latitude), lng = Number(d.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  return d.locationText ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.locationText)}` : null;
}
const TEMPLATE_PLACEHOLDER_MAP = {
  '@guestname': d => d.guestName || d.guestEmail || 'Guest',
  '@guests': d => (Number(d.guests) > 0 ? String(Number(d.guests)) : '(guest count not set)'),
  '@listing': d => d.listingName || '(property name not set)',
  '@hostname': d => d.hostName || 'Your host',
  '@arrival': d => fmtDay(d.arrival) || '(arrival date)',
  '@departure': d => fmtDay(d.departure) || '(departure date)',
  '@nights': d => (Number(d.nights) > 0 ? String(Number(d.nights)) : '(nights)'),
  '@wifi': d => (d.wifiName || d.wifiPassword) ? `WiFi: ${d.wifiName || '—'} / Password: ${d.wifiPassword || '—'}` : '(WiFi not set yet)',
  '@maplink': d => mapLink(d) || '(map link not available)',
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
      // The lookahead is what stops a SHORTER key from eating a LONGER
      // placeholder that starts with it: '@checkin' is a prefix of
      // '@checkininfo', so without this, "@checkininfo" became
      // "2:00 PMinfo" — the check-in time plus a stray "info" — and the
      // @checkininfo handler below never saw anything left to replace.
      // Requiring the next character to not be alphanumeric means each
      // key only matches a whole placeholder word, and any future
      // '@checkin…'-prefixed placeholder stays safe too. Kept in sync by
      // hand with index.html's identical client-side resolver.
      result = result.replace(new RegExp(key + '(?![a-z0-9])', 'gi'), getValue(data));
    }
  }
  return result;
}

// Assembles the fixed check-in fields plus every host-defined custom
// field into one readable block — exactly what manage-listing.html's own
// live preview builds, and what index.html's client-side resolver builds
// for a host manually inserting @checkininfo. Kept in sync by hand
// across these three separate files, same as every other placeholder.
function buildCheckinInstructionsText(data) {
  const lines = [];
  if (data.checkInTime) lines.push(`Check-in: ${data.checkInTime}`);
  if (data.checkOutTime) lines.push(`Check-out: ${data.checkOutTime}`);
  if (data.wifiName || data.wifiPassword) lines.push(`WiFi: ${data.wifiName || '—'} / ${data.wifiPassword || '—'}`);
  if (data.accessCode) lines.push(`Access code: ${data.accessCode}`);
  (Array.isArray(data.customFields) ? data.customFields : []).forEach(f => {
    if (f.field_label && f.field_value) lines.push(`${f.field_label}: ${f.field_value}`);
  });
  // Messages are text-only — a photo becomes "Caption: link" so a guest
  // can tap through to see it, same convention manage-listing.html's own
  // live preview and index.html's client-side builder use.
  (Array.isArray(data.checkinPhotos) ? data.checkinPhotos : []).forEach(p => {
    if (p.url) lines.push(`${p.caption || 'Photo'}: ${p.url}`);
  });
  return lines.length ? lines.join('\n') : '(check-in instructions not set yet)';
}

function buildCheckinStepsText(data) {
  const lines = [];
  (Array.isArray(data.customFields) ? data.customFields : []).forEach(f => {
    if (f.field_label && f.field_value) lines.push(`${f.field_label}: ${f.field_value}`);
  });
  (Array.isArray(data.checkinPhotos) ? data.checkinPhotos : []).forEach(p => {
    if (p.url) lines.push(`${p.caption || 'Photo'}: ${p.url}`);
  });
  return lines.length ? lines.join('\n') : '(check-in steps not set yet)';
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
  // @checkinsteps — only the host's own check-in steps (custom fields and
  // photos from Manage → Check-in), without the times / WiFi / code.
  if (result.toLowerCase().includes('@checkinsteps')) {
    result = result.replace(/@checkinsteps/gi, buildCheckinStepsText(data));
  }
  // @checkininfo — the assembled fixed-fields-plus-custom-fields block.
  if (result.toLowerCase().includes('@checkininfo')) {
    result = result.replace(/@checkininfo/gi, buildCheckinInstructionsText(data));
  }
  return result;
}

// Everything a template can refer to, for one booking. null if the booking
// or its host cannot be found.
async function loadBookingContext(sql, orderId) {
  const rows = await sql`
    SELECT o.id, o.listing_id, o.guest_id, o.guest_email, o.arrival, o.departure, o.nights, o.guests,
           l.host_id, l.property_name, l.formatted_address, l.area, l.city, l.latitude, l.longitude,
           l.check_in_time, l.check_out_time, l.wifi_name, l.wifi_password, l.access_code, l.guest_guidance,
           l.auto_send_checkin_instructions, l.checkin_photos,
           g.name AS guest_name, h.name AS host_name
    FROM orders o JOIN listings l ON l.id = o.listing_id
    LEFT JOIN guests g ON g.id = o.guest_id
    LEFT JOIN hosts h ON h.id = l.host_id
    WHERE o.id = ${orderId}
  `;
  const r = rows[0];
  if (!r || !r.host_id) return null;
  // message_templates.host_id is the owning account's guests.id (not a
  // hosts.id) — see guest-profile.js's myHostId comment.
  const owner = (await sql`SELECT id FROM guests WHERE host_id = ${r.host_id} ORDER BY id LIMIT 1`)[0];
  if (!owner) return null;
  const customFields = await sql`SELECT field_label, field_value FROM listing_custom_fields WHERE listing_id = ${r.listing_id} ORDER BY sort_order ASC`;
  return {
    order: r, ownerAccountId: owner.id,
    data: {
      guestName: r.guest_name || r.guest_email, guestEmail: r.guest_email,
      guests: r.guests, nights: r.nights, arrival: r.arrival, departure: r.departure,
      listingName: r.property_name, hostName: r.host_name ? String(r.host_name).split(' ')[0] : null,
      checkInTime: r.check_in_time, checkOutTime: r.check_out_time,
      wifiName: r.wifi_name, wifiPassword: r.wifi_password, accessCode: r.access_code,
      locationText: r.formatted_address || [r.area, r.city].filter(Boolean).join(', ') || null,
      latitude: r.latitude, longitude: r.longitude,
      guestGuidance: r.guest_guidance, customFields,
      checkinPhotos: Array.isArray(r.checkin_photos) ? r.checkin_photos : []
    }
  };
}

async function conversationFor(sql, order) {
  const existing = await sql`SELECT id FROM conversations WHERE order_id = ${order.id}`;
  if (existing.length) return existing[0].id;
  const inserted = await sql`
    INSERT INTO conversations (order_id, listing_id, guest_id, guest_email, host_id)
    VALUES (${order.id}, ${order.listing_id}, ${order.guest_id}, ${order.guest_email}, ${order.host_id})
    RETURNING id
  `;
  return inserted[0].id;
}

// original_text is what was resolved; display_text what the guest sees.
async function postHostMessage(sql, conversationId, text, displayText = text, wasRedacted = false) {
  await sql`
    INSERT INTO messages (conversation_id, sender_type, original_text, display_text, was_redacted)
    VALUES (${conversationId}, 'host', ${text}, ${displayText}, ${wasRedacted})
  `;
}

// A template goes out under the host's name with no one pressing send, so
// it passes the same contact filter as a typed message (_redact.js) —
// except the host's own check-in details the placeholders put in (WiFi,
// access code, address, map link, check-in steps and photos), which are
// meant for the guest. So the text the HOST wrote (the template and the
// Description tab's guidance) is filtered first, and the placeholders are
// filled in afterwards.
function resolveTemplateForSend(body, data) {
  const bodyCheck = redactContactInfo(body);
  const guidanceCheck = data.guestGuidance ? redactContactInfo(data.guestGuidance) : { displayText: data.guestGuidance, wasRedacted: false };
  return {
    original: resolveTemplateText(body, data),
    display: resolveTemplateText(bodyCheck.displayText, { ...data, guestGuidance: guidanceCheck.displayText }),
    wasRedacted: bodyCheck.wasRedacted || (guidanceCheck.wasRedacted && /@guidance/i.test(body))
  };
}
async function postTemplate(sql, conversationId, body, data) {
  const t = resolveTemplateForSend(body, data);
  await postHostMessage(sql, conversationId, t.original, t.display, t.wasRedacted);
}

// Claim (template, booking) once. Returns true only for the first caller.
// If template_sends does not exist yet (migration not run), sending still
// works as before — without the duplicate guard.
async function claimSend(sql, templateId, orderId) {
  try {
    const r = await sql`INSERT INTO template_sends (template_id, order_id) VALUES (${templateId}, ${orderId}) ON CONFLICT DO NOTHING RETURNING template_id`;
    return r.length > 0;
  } catch (err) {
    return true;
  }
}

function appliesToListing(t, listingId) {
  const ids = Array.isArray(t.auto_send_listing_ids) ? t.auto_send_listing_ids.map(Number) : [];
  return ids.length === 0 || ids.includes(Number(listingId));
}

// Called right after a stay's order is saved as paid (verify-payment.js).
// order needs { id }. Never throws — a message failing must never break
// the booking confirmation that triggered it.
async function sendBookingConfirmedTemplates(sql, order) {
  try {
    const ctx = await loadBookingContext(sql, order.id);
    if (!ctx) return;
    let templates;
    try {
      // "On confirmation" templates, PLUS any "before check-in" / "check-in
      // day" template that is already due for this booking (booked late,
      // after its send day or after today's 07:30 run) — so a last-minute
      // guest still gets their check-in details, straight away.
      templates = await sql`
        SELECT t.id, t.body, t.auto_send_listing_ids FROM message_templates t
        CROSS JOIN LATERAL (
          SELECT (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date AS today, o.arrival
          FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${ctx.order.id}
        ) b
        WHERE t.host_id = ${ctx.ownerAccountId}
          AND (
               t.send_trigger = 'booking_confirmed'
            OR (t.send_trigger IS NULL AND t.send_on_booking_confirmed = true)
            OR (t.send_trigger = 'checkin_day' AND b.arrival = b.today)
          )
        ORDER BY CASE WHEN t.send_trigger = 'booking_confirmed' THEN 0 ELSE 1 END, t.id`;
    } catch (err) {
      // Before migration_message_templates_v2.sql: the old flag only.
      templates = await sql`SELECT id, body, auto_send_listing_ids FROM message_templates WHERE host_id = ${ctx.ownerAccountId} AND send_on_booking_confirmed = true`;
    }
    const applicable = templates.filter(t => appliesToListing(t, ctx.order.listing_id));
    if (!applicable.length && !ctx.order.auto_send_checkin_instructions) {
      await sendTimedTemplates(sql, { orderId: ctx.order.id, deadlineMs: 4000 }); // late booking: timed messages already due
      return;
    }
    const conversationId = await conversationFor(sql, ctx.order);
    for (const t of applicable) {
      if (!(await claimSend(sql, t.id, ctx.order.id))) continue;
      await postTemplate(sql, conversationId, t.body, ctx.data);
    }
    // The built-in check-in instructions auto-send (Manage → Check-in).
    if (ctx.order.auto_send_checkin_instructions) {
      await postHostMessage(sql, conversationId, buildCheckinInstructionsText(ctx.data));
    }
    // Booked late: any "before check-in / check-out" message whose time
    // has already come goes out now, not at the next scheduled run.
    await sendTimedTemplates(sql, { orderId: ctx.order.id, deadlineMs: 4000 });
  } catch (err) {
    console.error('sendBookingConfirmedTemplates failed:', err);
  }
}

// ---- Timing helpers ----
const TIMED_TRIGGERS = ['before_checkin', 'after_checkin', 'before_checkout', 'after_checkout'];
const DEFAULT_CHECKIN = [14, 0], DEFAULT_CHECKOUT = [11, 0];
// "14:00", "2:00 PM", "2 pm", "11" → [hour, minute]; null if unreadable.
function parseClock(v) {
  const m = String(v || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0);
  const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h <= 23 && min <= 59 ? [h, min] : null;
}
function isoDate(v) { return v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10); }
// A wall-clock time on a date, in an IANA time zone → UTC milliseconds.
function zonedToUtc(dateIso, h, min, tz) {
  const [y, mo, d] = dateIso.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, min);
  const offsetAt = (ms) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms)).reduce((a, x) => (a[x.type] = x.value, a), {});
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms) / 60000;
  };
  let ms = guess - offsetAt(guess) * 60000;
  ms = guess - offsetAt(ms) * 60000; // second pass settles daylight-saving edges
  return ms;
}
// When this template should reach this booking, and until when it may
// still be sent. null if it does not apply.
function timedSendWindow(row) {
  const tz = (row.timezone && String(row.timezone).trim()) || 'Asia/Kolkata';
  const isCheckin = row.send_trigger === 'before_checkin' || row.send_trigger === 'after_checkin';
  const clock = parseClock(isCheckin ? row.check_in_time : row.check_out_time) || (isCheckin ? DEFAULT_CHECKIN : DEFAULT_CHECKOUT);
  const day = isoDate(isCheckin ? row.arrival : row.departure);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const minutes = Number(row.send_offset_minutes) > 0 ? Number(row.send_offset_minutes) : Math.max(1, Number(row.send_offset_days) || 1) * 1440;
  const anchor = zonedToUtc(day, clock[0], clock[1], tz);
  const before = row.send_trigger.startsWith('before_');
  const at = before ? anchor - minutes * 60000 : anchor + minutes * 60000;
  return { at, until: before ? anchor : at + 12 * 3600000 };
}

// Hours-/days-based templates that are due now. orderId limits it to one
// booking (used right after a booking is confirmed). Never throws.
async function sendTimedTemplates(sql, { orderId = null, deadlineMs = 7000 } = {}) {
  const started = Date.now();
  const out = { sent: 0, failed: 0 };
  let rows = [];
  try {
    const load = (withMinutes) => withMinutes
      ? sql`SELECT t.id AS template_id, t.body, t.send_trigger, t.send_offset_days, t.send_offset_minutes, t.auto_send_listing_ids,
                   o.id AS order_id, o.listing_id, o.arrival, o.departure, l.check_in_time, l.check_out_time, l.timezone
            FROM message_templates t
            JOIN guests owner ON owner.id = t.host_id AND owner.host_id IS NOT NULL
            JOIN listings l ON l.host_id = owner.host_id
            JOIN orders o ON o.listing_id = l.id AND o.status = 'paid' AND COALESCE(o.order_type, 'stay') = 'stay'
            WHERE t.send_trigger = ANY(${TIMED_TRIGGERS})
              AND (${orderId}::int IS NULL OR o.id = ${orderId})
              AND (o.arrival BETWEEN CURRENT_DATE - 32 AND CURRENT_DATE + 32 OR o.departure BETWEEN CURRENT_DATE - 32 AND CURRENT_DATE + 32)
              AND NOT EXISTS (SELECT 1 FROM template_sends s WHERE s.template_id = t.id AND s.order_id = o.id)
            LIMIT 2000`
      : sql`SELECT t.id AS template_id, t.body, t.send_trigger, t.send_offset_days, NULL::int AS send_offset_minutes, t.auto_send_listing_ids,
                   o.id AS order_id, o.listing_id, o.arrival, o.departure, l.check_in_time, l.check_out_time, l.timezone
            FROM message_templates t
            JOIN guests owner ON owner.id = t.host_id AND owner.host_id IS NOT NULL
            JOIN listings l ON l.host_id = owner.host_id
            JOIN orders o ON o.listing_id = l.id AND o.status = 'paid' AND COALESCE(o.order_type, 'stay') = 'stay'
            WHERE t.send_trigger = ANY(${TIMED_TRIGGERS})
              AND (${orderId}::int IS NULL OR o.id = ${orderId})
              AND (o.arrival BETWEEN CURRENT_DATE - 32 AND CURRENT_DATE + 32 OR o.departure BETWEEN CURRENT_DATE - 32 AND CURRENT_DATE + 32)
              AND NOT EXISTS (SELECT 1 FROM template_sends s WHERE s.template_id = t.id AND s.order_id = o.id)
            LIMIT 2000`;
    try { rows = await load(true); } catch (err) { rows = await load(false); } // before migration_template_timing.sql
  } catch (err) {
    console.error('sendTimedTemplates skipped:', err.message);
    return { ...out, skipped: true };
  }
  const now = Date.now();
  for (const row of rows) {
    if (Date.now() - started > deadlineMs) break;
    if (!appliesToListing(row, row.listing_id)) continue;
    const w = timedSendWindow(row);
    if (!w || now < w.at || now > w.until) continue;
    try {
      if (!(await claimSend(sql, row.template_id, row.order_id))) continue;
      const ctx = await loadBookingContext(sql, row.order_id);
      if (!ctx) continue;
      const conversationId = await conversationFor(sql, ctx.order);
      await postTemplate(sql, conversationId, row.body, ctx.data);
      out.sent++;
    } catch (err) {
      out.failed++;
      console.error('timed template failed:', row.template_id, row.order_id, err.message);
    }
  }
  return out;
}

// Everything scheduled: the timed templates above, plus the morning-of
// messages (check-in day / check-out day), which wait until 07:30 in the
// property's time zone so frequent runs never send them at midnight.
async function sendScheduledTemplates(sql, { deadlineMs = 7000 } = {}) {
  const started = Date.now();
  const timed = await sendTimedTemplates(sql, { deadlineMs });
  const out = { sent: timed.sent, failed: timed.failed };
  try {
    const due = await sql`
      SELECT t.id AS template_id, t.body, t.auto_send_listing_ids, o.id AS order_id, o.listing_id
      FROM message_templates t
      JOIN guests owner ON owner.id = t.host_id AND owner.host_id IS NOT NULL
      JOIN listings l ON l.host_id = owner.host_id
      JOIN orders o ON o.listing_id = l.id AND o.status = 'paid' AND COALESCE(o.order_type, 'stay') = 'stay'
      CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata')) AS local_now) lt
      WHERE t.send_trigger IN ('checkin_day', 'checkout_day')
        AND lt.local_now::time >= time '07:30'
        AND ((t.send_trigger = 'checkin_day' AND o.arrival = lt.local_now::date)
          OR (t.send_trigger = 'checkout_day' AND o.departure = lt.local_now::date))
        AND NOT EXISTS (SELECT 1 FROM template_sends s WHERE s.template_id = t.id AND s.order_id = o.id)
      LIMIT 500
    `;
    for (const row of due) {
      if (Date.now() - started > deadlineMs) break;
      if (!appliesToListing(row, row.listing_id)) continue;
      try {
        if (!(await claimSend(sql, row.template_id, row.order_id))) continue;
        const ctx = await loadBookingContext(sql, row.order_id);
        if (!ctx) continue;
        const conversationId = await conversationFor(sql, ctx.order);
        await postTemplate(sql, conversationId, row.body, ctx.data);
        out.sent++;
      } catch (err) {
        out.failed++;
        console.error('scheduled template failed:', row.template_id, row.order_id, err.message);
      }
    }
  } catch (err) {
    console.error('sendScheduledTemplates (day-of) skipped:', err.message);
    out.skipped = true;
  }
  return out;
}

module.exports = { resolveTemplateText, resolveTemplateForSend, buildCheckinInstructionsText, buildCheckinStepsText, sendBookingConfirmedTemplates, sendScheduledTemplates, sendTimedTemplates, timedSendWindow, parseClock, zonedToUtc, loadBookingContext };
