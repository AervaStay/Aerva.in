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
//                       (send_offset_minutes > 0: that many minutes or
//                       hours after the booking, by the scheduled run)
//   before_checkin    ┐ a number of minutes, hours or days
//   after_checkin     │ (send_offset_minutes) before / after the listing's
//   before_checkout   │ check-in or check-out TIME on the booking's dates;
//   after_checkout    ┘ in days, optionally at an exact time (send_at_time)
//   checkin_day       — the arrival day   ┐ at send_at_time (default 07:30)
//   checkout_day      — the departure day ┘
//   All in the property's own time zone (listings.timezone).
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
           l.auto_send_checkin_instructions, l.checkin_photos, l.timezone,
           to_jsonb(l)->>'checkin_send_trigger' AS checkin_send_trigger,
           (to_jsonb(l)->>'checkin_send_offset_minutes')::int AS checkin_send_offset_minutes,
           to_jsonb(l)->>'checkin_send_at_time' AS checkin_send_at_time, o.created_at,
           COALESCE((to_jsonb(l)->>'checkin_send_also_on_confirm')::boolean, false) AS checkin_send_also_on_confirm,
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
  if (!existing.length) {   // the guest's enquiry thread for this listing, if any (_inquiries.js)
    const adopted = await require('./_inquiries').adoptInquiryThread(sql, { orderId: order.id, listingId: order.listing_id, guestId: order.guest_id });
    if (adopted) return adopted;
  }
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
               (t.send_trigger = 'booking_confirmed' AND COALESCE(t.send_offset_minutes, 0) <= 0)
            OR (t.send_trigger IS NULL AND t.send_on_booking_confirmed = true)
          )
        ORDER BY CASE WHEN t.send_trigger = 'booking_confirmed' THEN 0 ELSE 1 END, t.id`;
    } catch (err) {
      // Before migration_message_templates_v2.sql: the old flag only.
      templates = await sql`SELECT id, body, auto_send_listing_ids FROM message_templates WHERE host_id = ${ctx.ownerAccountId} AND send_on_booking_confirmed = true`;
    }
    const applicable = templates.filter(t => appliesToListing(t, ctx.order.listing_id));
    const plan = checkinPlan(ctx.order);
    if (!applicable.length && !plan.trigger) {
      await sendTimedTemplates(sql, { orderId: ctx.order.id, deadlineMs: 4000 }); // late booking: timed messages already due
      return;
    }
    const conversationId = await conversationFor(sql, ctx.order);
    for (const t of applicable) {
      if (!(await claimSend(sql, t.id, ctx.order.id))) continue;
      await postTemplate(sql, conversationId, t.body, ctx.data);
    }
    // The built-in check-in instructions (Manage → Guest Check-In Info →
    // Scheduling): now, when set to send on confirmation (or also on
    // confirmation); and now as well when a scheduled send is already due
    // because the guest booked late — but only one message either way.
    if (plan.trigger) {
      const now = Date.now();
      const wantConfirm = (plan.trigger === 'booking_confirmed' && !(plan.offset > 0)) || plan.alsoOnConfirm;
      const lateScheduled = plan.trigger !== 'booking_confirmed' && checkinDue(ctx.order, plan, now) === 'due';
      if (wantConfirm || lateScheduled) {
        const kinds = [wantConfirm ? 'confirmed' : null, lateScheduled ? 'scheduled' : null].filter(Boolean);
        let send = false;
        for (const k of kinds) if (await claimCheckin(sql, ctx.order.id, k)) send = true;
        if (send) await postHostMessage(sql, conversationId, buildCheckinInstructionsText(ctx.data));
      }
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
const SCHEDULED_TRIGGERS = TIMED_TRIGGERS.concat(['checkin_day', 'checkout_day']);
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
// A DATE column arrives as a Date at local midnight (pg-types), so its own
// local year/month/day are the stored date whatever the server's time zone.
function isoDate(v) {
  if (v instanceof Date) {
    if (isNaN(v)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
  }
  return String(v || '').slice(0, 10);
}
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
// "HH:MM" (24-hour) → [h, m], or null.
function atClock(v) {
  const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/);
  return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? [Number(m[1]), Number(m[2])] : null;
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
// When one scheduled message should reach one booking, and until when it
// may still be sent (a "before" message missed by a late booking still goes
// until check-in / check-out; an "after" one up to 12 hours late; a day
// message until that day ends). null if it does not apply.
//   row: send_trigger, send_offset_minutes, send_offset_unit, send_offset_days,
//        send_at_time, arrival, departure, check_in_time, check_out_time,
//        timezone, created_at (the booking, for a delayed confirmation message)
function timedSendWindow(row) {
  const tz = (row.timezone && String(row.timezone).trim()) || 'Asia/Kolkata';
  const trig = row.send_trigger;
  const at24 = atClock(row.send_at_time);
  if (trig === 'booking_confirmed') {
    const mins = Number(row.send_offset_minutes) || 0;
    const made = row.created_at ? new Date(row.created_at).getTime() : NaN;
    if (!(mins > 0) || !Number.isFinite(made)) return null;
    const at = made + mins * 60000;
    return { at, until: at + 24 * 3600000 };
  }
  if (trig === 'checkin_day' || trig === 'checkout_day') {
    const day = isoDate(trig === 'checkin_day' ? row.arrival : row.departure);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const c = at24 || [7, 30];
    return { at: zonedToUtc(day, c[0], c[1], tz), until: zonedToUtc(addDays(day, 1), 0, 0, tz) };
  }
  if (!TIMED_TRIGGERS.includes(trig)) return null;
  const isCheckin = trig === 'before_checkin' || trig === 'after_checkin';
  const clock = parseClock(isCheckin ? row.check_in_time : row.check_out_time) || (isCheckin ? DEFAULT_CHECKIN : DEFAULT_CHECKOUT);
  const day = isoDate(isCheckin ? row.arrival : row.departure);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const minutes = Number(row.send_offset_minutes) > 0 ? Number(row.send_offset_minutes) : Math.max(1, Number(row.send_offset_days) || 1) * 1440;
  const anchor = zonedToUtc(day, clock[0], clock[1], tz);
  const before = trig.startsWith('before_');
  let at;
  if (row.send_offset_unit === 'days' && at24) {
    // "2 days before check-in, at 6:00 pm": that day, at that time.
    const n = Math.max(1, Math.round(minutes / 1440));
    at = zonedToUtc(addDays(day, before ? -n : n), at24[0], at24[1], tz);
  } else {
    at = before ? anchor - minutes * 60000 : anchor + minutes * 60000;
  }
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
      ? sql`SELECT t.id AS template_id, t.body, t.send_trigger, t.send_offset_days, t.send_offset_minutes, t.send_offset_unit,
                   to_jsonb(t)->>'send_at_time' AS send_at_time, t.auto_send_listing_ids,
                   o.id AS order_id, o.listing_id, o.arrival, o.departure, o.created_at, l.check_in_time, l.check_out_time, l.timezone
            FROM message_templates t
            JOIN guests owner ON owner.id = t.host_id AND owner.host_id IS NOT NULL
            JOIN listings l ON l.host_id = owner.host_id
            JOIN orders o ON o.listing_id = l.id AND o.status = 'paid' AND COALESCE(o.order_type, 'stay') = 'stay'
            WHERE (t.send_trigger = ANY(${SCHEDULED_TRIGGERS}) OR (t.send_trigger = 'booking_confirmed' AND t.send_offset_minutes > 0))
              AND (${orderId}::int IS NULL OR o.id = ${orderId})
              AND (o.arrival BETWEEN CURRENT_DATE - 32 AND CURRENT_DATE + 32 OR o.departure BETWEEN CURRENT_DATE - 32 AND CURRENT_DATE + 32
                   OR o.created_at > now() - interval '3 days')
              AND NOT EXISTS (SELECT 1 FROM template_sends s WHERE s.template_id = t.id AND s.order_id = o.id)
            LIMIT 2000`
      : sql`SELECT t.id AS template_id, t.body, t.send_trigger, t.send_offset_days, NULL::int AS send_offset_minutes, NULL::text AS send_offset_unit,
                   NULL::text AS send_at_time, t.auto_send_listing_ids,
                   o.id AS order_id, o.listing_id, o.arrival, o.departure, o.created_at, l.check_in_time, l.check_out_time, l.timezone
            FROM message_templates t
            JOIN guests owner ON owner.id = t.host_id AND owner.host_id IS NOT NULL
            JOIN listings l ON l.host_id = owner.host_id
            JOIN orders o ON o.listing_id = l.id AND o.status = 'paid' AND COALESCE(o.order_type, 'stay') = 'stay'
            WHERE t.send_trigger = ANY(${SCHEDULED_TRIGGERS})
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

// ---- Check-in instructions on a schedule (Manage → Guest Check-In Info) ----
// trigger: booking_confirmed | before_checkin (offset minutes before the
// check-in time) | checkin_day (from 07:30 on the arrival day), all on the
// property's own clock. Homes saved before these settings existed and set
// to "send automatically" mean booking_confirmed.
const CHECKIN_TRIGGERS = ['booking_confirmed', 'before_checkin', 'checkin_day'];
function checkinPlan(row) {
  let trigger = row.checkin_send_trigger || null;
  if (!CHECKIN_TRIGGERS.includes(trigger)) trigger = row.auto_send_checkin_instructions === true ? 'booking_confirmed' : null;
  if (row.auto_send_checkin_instructions === false && row.checkin_send_trigger == null) trigger = null;
  const raw = Number(row.checkin_send_offset_minutes);
  // On confirmation: 0 = straight away, or a delay in minutes. Before
  // check-in: how long before (default a day).
  const offset = trigger === 'booking_confirmed' ? (raw > 0 ? raw : 0) : (raw > 0 ? raw : 1440);
  const atTime = atClock(row.checkin_send_at_time) ? row.checkin_send_at_time : null;
  const unit = trigger === 'before_checkin' && offset % 1440 === 0 && atTime ? 'days' : null;
  return { trigger, offset, atTime, unit, alsoOnConfirm: trigger !== 'booking_confirmed' && row.checkin_send_also_on_confirm === true };
}
// 'due' (send now), 'early' (not yet) or 'late' (its moment has passed),
// using the same timing as message templates (timedSendWindow).
function checkinDue(row, plan, ms = Date.now()) {
  const w = timedSendWindow({ send_trigger: plan.trigger, send_offset_minutes: plan.trigger === 'checkin_day' ? 0 : plan.offset,
    send_offset_unit: plan.unit, send_at_time: plan.atTime, arrival: row.arrival, departure: row.departure,
    check_in_time: row.check_in_time, timezone: row.timezone, created_at: row.created_at });
  if (!w) return 'late';
  return ms < w.at ? 'early' : ms > w.until ? 'late' : 'due';
}
// Once per booking and kind. Before the database update adds the table,
// the old behaviour (send on confirmation, no guard) carries on.
async function claimCheckin(sql, orderId, kind) {
  try {
    const r = await sql`INSERT INTO checkin_info_sends (order_id, kind) VALUES (${orderId}, ${kind}) ON CONFLICT DO NOTHING RETURNING order_id`;
    return r.length > 0;
  } catch (err) {
    return kind === 'confirmed';
  }
}
async function sendScheduledCheckinInfo(sql, { deadlineMs = 3000 } = {}) {
  const started = Date.now();
  const out = { sent: 0, failed: 0 };
  let rows;
  try {
    rows = await sql`
      SELECT o.id AS order_id, o.arrival, o.departure, o.created_at, l.check_in_time, l.timezone, l.auto_send_checkin_instructions,
             to_jsonb(l)->>'checkin_send_trigger' AS checkin_send_trigger,
             (to_jsonb(l)->>'checkin_send_offset_minutes')::int AS checkin_send_offset_minutes,
             to_jsonb(l)->>'checkin_send_at_time' AS checkin_send_at_time
      FROM orders o JOIN listings l ON l.id = o.listing_id
      WHERE o.status = 'paid' AND COALESCE(o.order_type, 'stay') = 'stay'
        AND o.arrival BETWEEN CURRENT_DATE - 1 AND CURRENT_DATE + 31
        AND (to_jsonb(l)->>'checkin_send_trigger' IN ('before_checkin', 'checkin_day')
             OR (to_jsonb(l)->>'checkin_send_trigger' = 'booking_confirmed' AND COALESCE((to_jsonb(l)->>'checkin_send_offset_minutes')::int, 0) > 0))
        AND NOT EXISTS (SELECT 1 FROM checkin_info_sends s WHERE s.order_id = o.id AND s.kind = 'scheduled')
      LIMIT 1000`;
  } catch (err) {
    return { ...out, skipped: true };   // before the database update
  }
  const now = Date.now();
  for (const row of rows) {
    if (Date.now() - started > deadlineMs) break;
    if (checkinDue(row, checkinPlan(row), now) !== 'due') continue;
    try {
      if (!(await claimCheckin(sql, row.order_id, 'scheduled'))) continue;
      const ctx = await loadBookingContext(sql, row.order_id);
      if (!ctx) continue;
      const conversationId = await conversationFor(sql, ctx.order);
      await postHostMessage(sql, conversationId, buildCheckinInstructionsText(ctx.data));
      out.sent++;
    } catch (err) {
      out.failed++;
      console.error('scheduled check-in instructions failed:', row.order_id, err.message);
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
  const checkin = await sendScheduledCheckinInfo(sql, { deadlineMs: Math.max(1000, deadlineMs - (Date.now() - started)) });
  const out = { sent: timed.sent + checkin.sent, failed: timed.failed + checkin.failed };
  return out;
}

module.exports = { atClock, checkinPlan, checkinDue, sendScheduledCheckinInfo, resolveTemplateText, resolveTemplateForSend, buildCheckinInstructionsText, buildCheckinStepsText, sendBookingConfirmedTemplates, sendScheduledTemplates, sendTimedTemplates, timedSendWindow, parseClock, zonedToUtc, loadBookingContext };
