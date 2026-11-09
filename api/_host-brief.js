// /api/_host-brief.js — the host's morning brief (owner, 9 Nov 2026: keep
// hosts informed of today and upcoming bookings). Not an endpoint.
// Daily (get-listings.js job host_daily_brief, 7 AM India time): one email
// to each host with something happening — who checks in and out today
// (on each property's own calendar) and who arrives in the next 7 days.
// Nothing is sent to a host with nothing on. Also posted to the SMS /
// WhatsApp alert hook when that is switched on (_alerts.js).

const AHEAD_DAYS = 7;
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (d) => new Date(String(d).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

async function sendBriefs(sql, { deadlineMs = 8000 } = {}) {
  const started = Date.now();
  const out = { hosts: 0, emailed: 0 };
  const rows = await sql`
    SELECT l.host_id, o.id, o.suite_name, o.arrival, o.departure, o.guests, o.nights, COALESCE(g.name, split_part(o.guest_email, '@', 1)) AS guest_name,
           l.check_in_time, l.check_out_time, (o.arrival = local.today) AS arriving, (o.departure = local.today) AS departing, (o.arrival - local.today) AS days_away
    FROM orders o JOIN listings l ON l.id = o.listing_id LEFT JOIN guests g ON g.id = o.guest_id
    CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date AS today) local
    WHERE o.status = 'paid' AND COALESCE(o.order_type, 'stay') = 'stay'
      AND ((o.arrival >= local.today AND o.arrival <= local.today + ${AHEAD_DAYS}::int) OR o.departure = local.today)
    ORDER BY l.host_id, o.arrival, o.id LIMIT 2000`;
  const byHost = new Map();
  rows.forEach(r => { if (!byHost.has(r.host_id)) byHost.set(r.host_id, []); byHost.get(r.host_id).push(r); });
  for (const [hostId, list] of byHost) {
    if (Date.now() - started > deadlineMs) break;
    out.hosts++;
    const arrivals = list.filter(r => r.arriving), departures = list.filter(r => r.departing && !r.arriving), ahead = list.filter(r => Number(r.days_away) > 0);
    const host = (await sql`SELECT email, name FROM guests WHERE host_id = ${hostId} ORDER BY id LIMIT 1`)[0];
    if (!host || !host.email || !process.env.RESEND_API_KEY) continue;
    const li = (r, what) => `<li><strong>${esc(r.guest_name)}</strong>${Number(r.guests) > 1 ? ` (${Number(r.guests)} guests)` : ''} — ${esc(r.suite_name)} · ${what}</li>`;
    const html = `<div style="font-family:sans-serif; max-width:540px; color:#1c1a17; line-height:1.6;">
      <h2 style="font-family:Georgia,serif;">Your day on Aerva</h2>
      <p><strong>Checking in today:</strong> ${arrivals.length ? '' : 'nobody'}</p>${arrivals.length ? `<ul>${arrivals.map(r => li(r, `from ${esc(r.check_in_time || '1:00 pm')}, ${Number(r.nights)} night${Number(r.nights) === 1 ? '' : 's'}`)).join('')}</ul>` : ''}
      <p><strong>Checking out today:</strong> ${departures.length ? '' : 'nobody'}</p>${departures.length ? `<ul>${departures.map(r => li(r, `by ${esc(r.check_out_time || '11:00 am')}`)).join('')}</ul>` : ''}
      <p><strong>Coming up in the next ${AHEAD_DAYS} days:</strong> ${ahead.length ? '' : 'no arrivals'}</p>${ahead.length ? `<ul>${ahead.map(r => li(r, `arrives ${esc(day(r.arrival))}, ${Number(r.nights)} night${Number(r.nights) === 1 ? '' : 's'}`)).join('')}</ul>` : ''}
      <p><a href="https://aerva.in/index.html?view=today" style="color:#8a6c39;">Open Today on Aerva</a></p>
      <p style="font-size:12px; opacity:0.6;">You get this each morning when something is booked. Questions: hello@aerva.in</p></div>`;
    try {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to: host.email, subject: `Today: ${arrivals.length} in, ${departures.length} out · ${ahead.length} coming up`, html }) });
      if (r.ok) out.emailed++;
    } catch (e) { /* next host */ }
    if (arrivals.length || departures.length) {
      await require('./_alerts').alertHost(sql, hostId, `Aerva today: ${arrivals.length} check-in(s), ${departures.length} check-out(s), ${ahead.length} arriving in the next ${AHEAD_DAYS} days.`);
    }
  }
  return out;
}

module.exports = { sendBriefs, AHEAD_DAYS };
