// /api/_alerts.js — urgent alerts by SMS and WhatsApp (owner, 9 Nov 2026:
// "build ready, switch on later"). Not an endpoint. Never throws.
//
// Provider: MSG91 (India). OFF until these are set in Vercel:
//   MSG91_AUTH_KEY            — the account's auth key
//   MSG91_SMS_TEMPLATE_ID     — a DLT-approved SMS "flow" template with one
//                               variable named `message` (Indian law requires
//                               every SMS text to be a registered template)
//   MSG91_WA_NUMBER           — the WhatsApp business number (optional)
//   MSG91_WA_TEMPLATE         — an approved WhatsApp template name with one
//                               body variable (optional; WhatsApp only sends
//                               approved templates to start a conversation)
//   ALERTS_ENABLED=1          — the switch
// With any of the required ones missing, nothing is sent and nothing fails:
// email and the in-app notices carry everything (they always do anyway).
// Every attempt is written to the audit log (alert_sms / alert_whatsapp).

const { logAudit } = require('./_audit-log');

function ready() {
  return process.env.ALERTS_ENABLED === '1' && !!process.env.MSG91_AUTH_KEY && !!process.env.MSG91_SMS_TEMPLATE_ID;
}
const digits = (p) => String(p || '').replace(/[^\d]/g, '');

async function send(sql, { phone, text, who }) {
  const to = digits(phone);
  if (!ready() || to.length < 10) return { sent: false, reason: ready() ? 'no phone' : 'alerts off' };
  const message = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 150);
  const out = { sms: false, whatsapp: false };
  try {
    const r = await fetch('https://control.msg91.com/api/v5/flow/', { method: 'POST',
      headers: { 'authkey': process.env.MSG91_AUTH_KEY, 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ template_id: process.env.MSG91_SMS_TEMPLATE_ID, short_url: '0', recipients: [{ mobiles: to, message }] }) });
    out.sms = r.ok;
  } catch (e) { out.sms = false; }
  if (process.env.MSG91_WA_NUMBER && process.env.MSG91_WA_TEMPLATE) {
    try {
      const r = await fetch('https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', { method: 'POST',
        headers: { 'authkey': process.env.MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrated_number: process.env.MSG91_WA_NUMBER, content_type: 'template',
          payload: { messaging_product: 'whatsapp', type: 'template', template: { name: process.env.MSG91_WA_TEMPLATE, language: { code: 'en', policy: 'deterministic' },
            to_and_components: [{ to: [to], components: { body_1: { type: 'text', value: message } } }] } } }) });
      out.whatsapp = r.ok;
    } catch (e) { out.whatsapp = false; }
  }
  try { await logAudit(sql, { action: 'alert_sms', success: out.sms, actorType: 'system', actorIdentifier: 'alerts', metadata: { who, whatsapp: out.whatsapp, length: message.length } }); } catch (e) { /* none */ }
  return { sent: out.sms || out.whatsapp, ...out };
}

// To the host's account phone (the owner account of the host).
async function alertHost(sql, hostId, text) {
  try {
    if (!ready()) return { sent: false, reason: 'alerts off' };
    const g = (await sql`SELECT phone FROM guests WHERE host_id = ${hostId} ORDER BY id LIMIT 1`)[0];
    return await send(sql, { phone: g && g.phone, text, who: 'host:' + hostId });
  } catch (e) { return { sent: false }; }
}
async function alertGuest(sql, guestId, text) {
  try {
    if (!ready()) return { sent: false, reason: 'alerts off' };
    const g = (await sql`SELECT phone FROM guests WHERE id = ${guestId}`)[0];
    return await send(sql, { phone: g && g.phone, text, who: 'guest:' + guestId });
  } catch (e) { return { sent: false }; }
}

module.exports = { ready, alertHost, alertGuest };
