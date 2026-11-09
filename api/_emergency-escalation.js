// /api/_emergency-escalation.js — an emergency cancellation the host has not
// answered. Not an endpoint.
//
// THE OWNER'S RULES (9 Nov 2026):
//   • A guest may ask to cancel before check-in for an emergency (hazard,
//     life-threatening situation, medical or family emergency, travel
//     restriction). The host accepts → booking price, GST and deposit are
//     refunded in full; Aerva's service fee stays charged. The host
//     declines → no refund, the booking stands.
//   • The host does not answer within 24 hours (sooner when check-in is
//     close: once check-in is under ESCALATE_BEFORE_CHECKIN_HOURS away) →
//     Aerva reaches out to the host FIRST:
//       – 3 reminders to the host, by email and in the booking's Messages;
//       – a support request for the guest and one for the host, so each
//         sees "action needed" in their own Support section (and the bell);
//       – an urgent item for Aerva's support team (Admin → Support first,
//         and Admin → Approvals → cancellation requests) to call the host.
//     The host can still accept or decline at any time until Aerva decides.
//   • Only when all 3 reminders have gone unanswered (or check-in is under
//     DECIDE_BEFORE_CHECKIN_HOURS away) can Aerva decide — normally to
//     refund as the guest asked. Aerva's decision is final and binds the
//     host and the guest.
//   • Spacing: the reminders and the last wait are spread over the time
//     left before check-in — every quarter of it, between 1 and 8 hours —
//     so Aerva can decide before the stay starts (a request still open at
//     check-in closes and the booking stands, _cancellations.js).

const { logAudit } = require('./_audit-log');
const { hoursUntilCheckInTime, dateStr } = require('./_booking-rules');

const HOST_TIMEOUT_HOURS = 24;
const REMINDERS = 3;
const ESCALATE_BEFORE_CHECKIN_HOURS = 24;
const DECIDE_BEFORE_CHECKIN_HOURS = 3;
const MIN_GAP_HOURS = 1, MAX_GAP_HOURS = 8;

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

async function email(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html: `<div style="font-family:sans-serif; max-width:520px; color:#1c1a17; line-height:1.6;">${html}</div>` }) });
    return r.ok;
  } catch (e) { return false; }
}

async function ready(sql) {
  try { await sql`SELECT escalated_at, host_reminders, aerva_decides_at, contact_log FROM cancellation_requests LIMIT 0`; return true; }
  catch (e) { return false; }
}

// Hours left to check-in, and the gap between reminders.
function hoursLeft(r) { return hoursUntilCheckInTime(r.arrival, r.timezone, r.check_in_time); }
function gapHours(left) { return Math.max(MIN_GAP_HOURS, Math.min(MAX_GAP_HOURS, left / (REMINDERS + 1))); }

// One open emergency request with everything needed here.
async function load(sql, requestId) {
  return (await sql`
    SELECT r.*, o.suite_name, o.arrival, o.departure, o.guest_email, o.guest_id AS booking_guest_id, o.status AS order_status,
           COALESCE(o.confirmation_code, '#' || o.id) AS code, l.host_id, l.host_name,
           COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata') AS timezone, to_jsonb(l)->>'check_in_time' AS check_in_time,
           (SELECT g.id FROM guests g WHERE g.host_id = l.host_id ORDER BY g.id LIMIT 1) AS host_guest_id,
           (SELECT g.email FROM guests g WHERE g.host_id = l.host_id ORDER BY g.id LIMIT 1) AS host_email,
           (SELECT g.phone FROM guests g WHERE g.host_id = l.host_id ORDER BY g.id LIMIT 1) AS host_phone
    FROM cancellation_requests r JOIN orders o ON o.id = r.order_id JOIN listings l ON l.id = o.listing_id
    WHERE r.id = ${Number(requestId) || 0}`)[0] || null;
}
function isEmergency(r) { return !!require('./_cancellations').EMERGENCY_REASONS[r.reason_code]; }
function reasonLabel(r) { return require('./_cancellations').EMERGENCY_REASONS[r.reason_code] || r.reason_code; }
function stayLine(r) { return `${r.suite_name} (${dateStr(r.arrival)} → ${dateStr(r.departure)}, booking ${r.code})`; }

// May Aerva decide now? After every reminder went unanswered, or when
// check-in is very close.
function canAervaDecide(r) {
  return !!r.aerva_decides_at || (!!r.escalated_at && hoursLeft(r) <= DECIDE_BEFORE_CHECKIN_HOURS);
}

// ---------------------------------------------------------------------
// Opens the escalation: support requests for both sides, and the first
// reminder. Called by the scheduler.
async function openEscalation(sql, r) {
  const got = await sql`UPDATE cancellation_requests SET escalated_at = now() WHERE id = ${r.id} AND escalated_at IS NULL AND status = 'pending' AND decided_at IS NULL RETURNING id`;
  if (!got.length) return false;
  const S = require('./_support');
  const guestTicket = r.booking_guest_id ? await S.openSystemRequest(sql, { guestId: r.booking_guest_id, role: 'guest', category: 'cancellation_refund', orderId: r.order_id, urgent: true,
    subject: `Your emergency cancellation: Aerva is contacting your host`,
    body: `Your request to cancel ${stayLine(r)} (${reasonLabel(r)}) has not been answered by your host within ${HOST_TIMEOUT_HOURS} hours, so Aerva is now reaching out to them: ${REMINDERS} reminders by email and in Messages, and a call from our support team.\n\nWhat happens next:\n• If your host accepts: the booking price, GST and any deposit are refunded in full. Aerva’s service fee is not refunded.\n• If your host declines: there is no refund and the booking stands.\n• If your host still does not answer after the ${REMINDERS} reminders: Aerva decides, normally as you asked. Aerva’s decision is final for you and the host.\n\nYou do not need to do anything. We will update you here and by email. Add anything that helps (a document, a photo) by replying to this request.` }) : null;
  const hostTicket = r.host_guest_id ? await S.openSystemRequest(sql, { guestId: r.host_guest_id, role: 'host', category: 'cancellation_refund', orderId: r.order_id, urgent: true,
    subject: `Action needed: answer your guest’s emergency cancellation`,
    body: `Your guest asked to cancel ${stayLine(r)} for an emergency (${reasonLabel(r)})${r.details ? `: “${String(r.details).slice(0, 300)}”` : ''}. It has not been answered within ${HOST_TIMEOUT_HOURS} hours.\n\nPlease accept or decline it now in Messages (or My Earnings → Cancellation requests):\n• Accept: the guest gets the booking price, GST and any deposit back; no charge or penalty to you.\n• Decline: the booking stands and the guest gets no refund.\n\nAerva will remind you ${REMINDERS} times and our support team will try to call you. If there is still no answer, Aerva will decide, and its decision is final for you and the guest.` }) : null;
  await sql`UPDATE cancellation_requests SET guest_ticket_id = ${guestTicket ? guestTicket.id : null}, host_ticket_id = ${hostTicket ? hostTicket.id : null} WHERE id = ${r.id}`;
  await email(process.env.SUPPORT_EMAIL || process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in', `URGENT — call the host: emergency cancellation ${r.code}`,
    `<p><strong>${esc(stayLine(r))}</strong></p><p>The guest asked to cancel for an emergency (${esc(reasonLabel(r))}) and the host has not answered in ${HOST_TIMEOUT_HOURS} hours. Reminders are going out now.</p>
     <p>Host: ${esc(r.host_name || '')} · ${esc(r.host_email || 'no email')} · ${esc(r.host_phone || 'no phone')}</p>
     <p>Call the host and log it in Admin → Approvals → Cancellation requests. Aerva can decide once the ${REMINDERS} reminders have gone unanswered.</p>`);
  await logAudit(sql, { action: 'emergency_cancellation_escalated', success: true, actorType: 'system', actorIdentifier: 'aerva', targetType: 'order', targetId: r.order_id,
    metadata: { requestId: r.id, guestTicket: guestTicket && guestTicket.ref, hostTicket: hostTicket && hostTicket.ref } });
  return true;
}

// One reminder to the host: email and Messages; both requests updated.
async function sendReminder(sql, r, { by = 'system' } = {}) {
  const n = Number(r.host_reminders) + 1;
  if (n > REMINDERS) return false;
  const got = await sql`UPDATE cancellation_requests SET host_reminders = ${n}, last_host_reminder_at = now()
                        WHERE id = ${r.id} AND host_reminders = ${n - 1} AND status = 'pending' AND decided_at IS NULL RETURNING id`;
  if (!got.length) return false;
  const last = n === REMINDERS;
  const { postThreadMessage } = require('./_cancellations');
  await postThreadMessage(sql, r.order_id, 'system', `Reminder ${n} of ${REMINDERS} from Aerva: your guest’s emergency cancellation request is waiting for your answer. Please accept or decline it now.${last ? ' This is the last reminder: if there is no answer, Aerva will decide, and its decision is final for you and the guest.' : ''}`);
  await email(r.host_email, `${last ? 'Last reminder' : `Reminder ${n} of ${REMINDERS}`}: answer your guest’s emergency cancellation`,
    `<h2 style="font-family:Georgia,serif;">Your guest is waiting for your answer</h2>
     <p>Your guest asked to cancel <strong>${esc(stayLine(r))}</strong> for an emergency (${esc(reasonLabel(r))}).</p>
     <p>Please accept or decline it now in Messages. Accept: the guest is refunded the booking price, GST and any deposit, with no charge or penalty to you. Decline: the booking stands, with no refund.</p>
     <p>${last ? `<strong>This is the last reminder.</strong> If there is no answer, Aerva will decide — normally as the guest asked — and its decision is final for you and the guest.` : `Aerva will remind you ${REMINDERS} times in all. If there is still no answer, Aerva will decide, and its decision is final.`}</p>
     <p><a href="https://aerva.in/index.html?view=messages" style="color:#8a6c39;">Open Messages</a></p>`);
  await require('./_alerts').alertHost(sql, r.host_id, `Aerva: reminder ${n}/${REMINDERS} - your guest's emergency cancellation for ${r.suite_name} needs your answer now in Messages.`);
  const S = require('./_support');
  await S.systemUpdate(sql, r.host_ticket_id, `Reminder ${n} of ${REMINDERS} sent to you by email and in Messages. Please accept or decline the cancellation request now.${last ? ' If there is no answer, Aerva will decide, and its decision is final.' : ''}`);
  await S.systemUpdate(sql, r.guest_ticket_id, `Reminder ${n} of ${REMINDERS} sent to your host.`);
  await logAudit(sql, { action: 'emergency_cancellation_host_reminded', success: true, actorType: by === 'system' ? 'system' : 'admin', actorIdentifier: by, targetType: 'order', targetId: r.order_id,
    metadata: { requestId: r.id, reminder: n } });
  return true;
}

// All reminders unanswered: Aerva decides from here.
async function openAervaDecision(sql, r) {
  const got = await sql`UPDATE cancellation_requests SET aerva_decides_at = now() WHERE id = ${r.id} AND aerva_decides_at IS NULL AND status = 'pending' AND decided_at IS NULL RETURNING id`;
  if (!got.length) return false;
  const S = require('./_support');
  await S.systemUpdate(sql, r.guest_ticket_id, `Your host has not answered after ${REMINDERS} reminders, so Aerva will now decide your request. Aerva’s decision is final for you and the host. We will tell you as soon as it is made.`);
  await S.systemUpdate(sql, r.host_ticket_id, `There was no answer after ${REMINDERS} reminders, so Aerva will now decide your guest’s request. Aerva’s decision is final for you and the guest.`);
  await email(process.env.SUPPORT_EMAIL || process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in', `DECIDE NOW — emergency cancellation ${r.code}`,
    `<p><strong>${esc(stayLine(r))}</strong>: the host has not answered after ${REMINDERS} reminders. Decide it in Admin → Approvals → Cancellation requests before check-in.</p>`);
  await logAudit(sql, { action: 'emergency_cancellation_to_aerva', success: true, actorType: 'system', actorIdentifier: 'aerva', targetType: 'order', targetId: r.order_id, metadata: { requestId: r.id } });
  return true;
}

// ---------------------------------------------------------------------
// Scheduler (every 15 minutes): open, remind, hand to Aerva. Never throws.
async function runEscalations(sql, { deadlineMs = 4000 } = {}) {
  const started = Date.now();
  const out = { escalated: 0, reminders: 0, toAerva: 0 };
  if (!(await ready(sql))) return { ...out, skipped: 'database update not applied yet' };
  const C = require('./_cancellations');
  let rows = [];
  try {
    rows = await sql`SELECT r.id FROM cancellation_requests r JOIN orders o ON o.id = r.order_id
                     WHERE r.status = 'pending' AND r.decided_at IS NULL AND o.status = 'paid'
                       AND r.reason_code = ANY(${Object.keys(C.EMERGENCY_REASONS)}) AND r.aerva_decides_at IS NULL
                     ORDER BY o.arrival, r.id LIMIT 50`;
  } catch (err) { return { ...out, skipped: 'table not ready' }; }
  for (const { id } of rows) {
    if (Date.now() - started > deadlineMs) break;
    try {
      let r = await load(sql, id);
      if (!r) continue;
      const left = hoursLeft(r);
      if (left <= 0) continue;                       // check-in: closeRequestsAtCheckin closes it
      const ageH = (Date.now() - new Date(r.created_at).getTime()) / 3600e3;
      if (!r.escalated_at) {
        if (ageH < HOST_TIMEOUT_HOURS && !(left <= ESCALATE_BEFORE_CHECKIN_HOURS && ageH >= 1)) continue;
        if (await openEscalation(sql, r)) out.escalated++;
        r = await load(sql, id);
      }
      const gap = gapHours(left) * 3600e3;
      const since = r.last_host_reminder_at ? Date.now() - new Date(r.last_host_reminder_at).getTime() : Infinity;
      if (Number(r.host_reminders) < REMINDERS) {
        if (since >= gap || !r.last_host_reminder_at) { if (await sendReminder(sql, r)) out.reminders++; }
      } else if (since >= gap || left <= DECIDE_BEFORE_CHECKIN_HOURS) {
        if (await openAervaDecision(sql, r)) out.toAerva++;
      }
    } catch (err) { console.error('emergency escalation step failed:', id, err.message); }
  }
  return out;
}

// Admin: send the next reminder now (e.g. after a call that was not answered).
async function remindNow(sql, { requestId, adminLabel }) {
  const r = await load(sql, requestId);
  const err = (m, s = 400) => Object.assign(new Error(m), { isUserFacing: true, status: s });
  if (!r || !isEmergency(r)) throw err('Request not found.', 404);
  if (r.status !== 'pending' || r.decided_at) throw err('This request has already been answered.', 409);
  if (!r.escalated_at) throw err('The host still has time to answer on their own; reminders start once the 24 hours have passed.', 409);
  if (Number(r.host_reminders) >= REMINDERS) throw err(`All ${REMINDERS} reminders have been sent.`, 409);
  await sendReminder(sql, r, { by: adminLabel || 'admin' });
  const after = await load(sql, requestId);
  if (Number(after.host_reminders) >= REMINDERS && hoursLeft(after) <= DECIDE_BEFORE_CHECKIN_HOURS) await openAervaDecision(sql, after);
  return { reminders: Number(after.host_reminders) };
}

// Admin: record an attempt to reach the host (a call, a WhatsApp…).
async function logContact(sql, { requestId, outcome, note, adminLabel }) {
  const err = (m, s = 400) => Object.assign(new Error(m), { isUserFacing: true, status: s });
  const r = await load(sql, requestId);
  if (!r || !isEmergency(r)) throw err('Request not found.', 404);
  const OUT = { reached: 'Reached the host', no_answer: 'No answer', left_message: 'Left a message', wrong_number: 'Number not working' };
  if (!OUT[outcome]) throw err('Choose what happened.');
  const entry = { at: new Date().toISOString(), by: adminLabel || 'admin', outcome, note: String(note || '').trim().slice(0, 400) };
  await sql`UPDATE cancellation_requests SET contact_log = COALESCE(contact_log, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb WHERE id = ${r.id}`;
  if (r.host_ticket_id) {
    try { await sql`INSERT INTO support_messages (ticket_id, sender, body, internal, admin_email) VALUES (${r.host_ticket_id}, 'support', ${`Call log: ${OUT[outcome]}${entry.note ? ' — ' + entry.note : ''}`}, true, ${entry.by})`; } catch (e) { /* none */ }
  }
  await logAudit(sql, { action: 'emergency_cancellation_host_contacted', success: true, actorType: 'admin', actorIdentifier: entry.by, targetType: 'order', targetId: r.order_id,
    metadata: { requestId: r.id, outcome, note: entry.note } });
  return { logged: true };
}

// The host or Aerva answered (or the request closed): both requests closed with the outcome.
async function closeEscalation(sql, requestId, { guestText, hostText }) {
  try {
    const r = (await sql`SELECT guest_ticket_id, host_ticket_id FROM cancellation_requests WHERE id = ${Number(requestId) || 0}`)[0];
    if (!r) return;
    const S = require('./_support');
    if (guestText) await S.systemUpdate(sql, r.guest_ticket_id, guestText, { resolve: true });
    if (hostText) await S.systemUpdate(sql, r.host_ticket_id, hostText, { resolve: true });
  } catch (e) { /* before the database update */ }
}

// What Admin → Approvals shows for one request.
function adminView(r) {
  const left = hoursLeft(r);
  return {
    escalatedAt: r.escalated_at || null, reminders: Number(r.host_reminders) || 0, remindersMax: REMINDERS, lastReminderAt: r.last_host_reminder_at || null,
    aervaDecidesAt: r.aerva_decides_at || null, canDecide: canAervaDecide(r), hoursToCheckIn: Math.max(0, Math.round(left * 10) / 10),
    hostEmail: r.host_email || null, hostPhone: r.host_phone || null, contactLog: Array.isArray(r.contact_log) ? r.contact_log : [],
    decideRule: `Aerva decides only after ${REMINDERS} reminders to the host have gone unanswered (or when check-in is under ${DECIDE_BEFORE_CHECKIN_HOURS} hours away).`
  };
}

// The host's "action needed" list (host dashboard): emergency requests
// waiting for them, with Aerva's reminders so far.
async function hostActions(sql, hostId) {
  if (!(await ready(sql))) return [];
  try {
    const C = require('./_cancellations');
    const rows = await sql`SELECT r.id, r.order_id, r.reason_code, r.created_at, r.escalated_at, r.host_reminders, r.aerva_decides_at, o.suite_name, o.arrival, o.departure,
                                  COALESCE(o.confirmation_code, '#' || o.id) AS code
                           FROM cancellation_requests r JOIN orders o ON o.id = r.order_id JOIN listings l ON l.id = o.listing_id
                           WHERE l.host_id = ${hostId} AND r.status = 'pending' AND r.decided_at IS NULL AND o.status = 'paid'
                             AND r.reason_code = ANY(${Object.keys(C.EMERGENCY_REASONS)})
                           ORDER BY o.arrival`;
    return rows.map(x => ({ requestId: x.id, orderId: x.order_id, listing: x.suite_name, arrival: dateStr(x.arrival), departure: dateStr(x.departure), code: x.code,
      reason: C.EMERGENCY_REASONS[x.reason_code], askedAt: x.created_at, escalated: !!x.escalated_at, reminders: Number(x.host_reminders) || 0, remindersMax: REMINDERS,
      aervaDeciding: !!x.aerva_decides_at, answerBy: new Date(new Date(x.created_at).getTime() + HOST_TIMEOUT_HOURS * 3600e3).toISOString() }));
  } catch (e) { return []; }
}

// The guest's view of their own request (My Bookings): where it stands.
async function guestStatus(sql, orderIds) {
  const out = {};
  if (!orderIds.length || !(await ready(sql))) return out;
  try {
    const rows = await sql`SELECT DISTINCT ON (order_id) order_id, reason_code, escalated_at, host_reminders, aerva_decides_at, status
                           FROM cancellation_requests WHERE order_id = ANY(${orderIds}) AND status = 'pending' ORDER BY order_id, id DESC`;
    const C = require('./_cancellations');
    rows.forEach(x => {
      if (!C.EMERGENCY_REASONS[x.reason_code]) return;
      out[x.order_id] = x.aerva_decides_at ? 'Your host has not answered after 3 reminders · Aerva is deciding (final)'
        : x.escalated_at ? `With Aerva · contacting your host (reminder ${Number(x.host_reminders) || 0} of ${REMINDERS})`
        : 'Emergency cancellation requested · waiting for the host (24 hours)';
    });
  } catch (e) { /* none */ }
  return out;
}

module.exports = { HOST_TIMEOUT_HOURS, REMINDERS, DECIDE_BEFORE_CHECKIN_HOURS, ready, load, canAervaDecide, runEscalations, remindNow, logContact, closeEscalation, adminView, hostActions, guestStatus };
