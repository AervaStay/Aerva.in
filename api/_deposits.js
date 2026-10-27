// /api/_deposits.js — refund security deposits whose hold has ended. Not an endpoint.
//
// Runs on the scheduler (every 15 minutes) and from Admin's "Process
// Eligible Refunds". Each deposit is claimed ('held' → 'refunding') so two
// runs never both refund it; the refund itself goes through safeRefund
// (_refunds.js), which checks Razorpay first. A deposit whose refund has
// FAILED is skipped here: it waits in Admin → Refunds for a person to
// retry, so a failing refund is never retried automatically.

const { safeRefund } = require('./_refunds');
const { refundSubunitForInr } = require('./_currency');

// Two bank working days (Monday to Friday) after `day` (YYYY-MM-DD).
function addWorkingDays(day, n) {
  const d = new Date(String(day).slice(0, 10) + 'T00:00:00Z');
  let left = n;
  while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) left--; }
  return d.toISOString().slice(0, 10);
}
// The host confirms, with their review of the guest, that there is no
// damage: the deposit is refunded two bank working days later instead of
// at the end of the 7-day window (never later than it would have been).
// The host can no longer raise a concern about it. Returns { refundOn } or
// { error }. Never throws.
async function releaseEarly(sql, orderId, { hostId } = {}) {
  try {
    const o = (await sql`SELECT o.id, o.guest_email, o.suite_name, o.deposit_amount, o.deposit_status, o.deposit_release_at, l.host_id,
                                (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date::text AS today, o.departure::text AS departure
                         FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.id = ${Number(orderId) || 0}`)[0];
    if (!o || (hostId && Number(o.host_id) !== Number(hostId))) return { error: 'Booking not found.' };
    if (o.deposit_status !== 'held' || !(Number(o.deposit_amount) > 0)) return { error: 'There is no deposit held for this booking.' };
    const iso = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10);
    const today = iso(o.today);
    if (iso(o.departure) > today) return { error: 'The deposit can be released once the guest has checked out.' };
    const refundOn = addWorkingDays(today, 2);
    // The job refunds once the release date has passed: the day before refundOn.
    const d = new Date(refundOn + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
    const releaseAt = d.toISOString().slice(0, 10);
    let upd;
    try {
      upd = await sql`UPDATE orders SET deposit_release_at = LEAST(deposit_release_at, ${releaseAt}::date), deposit_released_by_host_at = now()
                      WHERE id = ${o.id} AND deposit_status = 'held' RETURNING deposit_release_at::text AS deposit_release_at`;
    } catch (e) {
      upd = await sql`UPDATE orders SET deposit_release_at = LEAST(deposit_release_at, ${releaseAt}::date) WHERE id = ${o.id} AND deposit_status = 'held' RETURNING deposit_release_at::text AS deposit_release_at`;
    }
    if (!upd.length) return { error: 'The deposit is no longer held.' };
    const on = new Date(new Date(iso(upd[0].deposit_release_at) + 'T00:00:00Z').getTime() + 86400e3).toISOString().slice(0, 10);
    if (process.env.RESEND_API_KEY && o.guest_email) {
      const nice = new Date(on + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
      const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      try {
        await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to: o.guest_email, subject: `Your security deposit for ${o.suite_name} is being released`,
            html: `<div style="font-family:sans-serif; max-width:480px; line-height:1.6;"><p>Your host has confirmed there is no damage from your stay at <strong>${esc(o.suite_name)}</strong>.</p>
              <p>Your security deposit of <strong>₹${Math.round(Number(o.deposit_amount)).toLocaleString('en-IN')}</strong> will be refunded to your original payment method on <strong>${esc(nice)}</strong>, instead of at the end of the 7-day period. Your bank may take a few working days to show it.</p>
              <p style="font-size:12px; opacity:0.6;">Questions: hello@aerva.in</p></div>` }) });
      } catch (e) { /* the refund goes ahead either way */ }
    }
    return { refundOn: on };
  } catch (err) {
    console.error('deposit not released early:', orderId, err.message);
    return { error: 'Could not release the deposit right now.' };
  }
}

async function releaseDueDeposits(sql, razorpay, { deadlineMs = 6000 } = {}) {
  const started = Date.now();
  const results = [];
  let eligible = [];
  try {
    eligible = await sql`
      SELECT o.id, o.razorpay_payment_id, o.razorpay_order_id, o.deposit_amount, o.charge_currency
      FROM orders o LEFT JOIN listings l ON l.id = o.listing_id
      -- Refunded only once the host's last day to report damage (the release
      -- date itself, on the property's own calendar) has fully passed.
      WHERE o.deposit_status = 'held' AND o.deposit_amount > 0
        AND o.deposit_release_at < (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date
        AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = o.id AND r.kind = 'deposit' AND r.status = 'failed')
      ORDER BY o.deposit_release_at LIMIT 50
    `;
  } catch (err) {
    // refunds table not there yet (before migration_refunds.sql): old rule.
    eligible = await sql`SELECT id, razorpay_payment_id, razorpay_order_id, deposit_amount, charge_currency FROM orders
                         WHERE deposit_status = 'held' AND deposit_release_at < (now() AT TIME ZONE 'Asia/Kolkata')::date AND deposit_amount > 0 LIMIT 50`;
  }
  for (const order of eligible) {
    if (Date.now() - started > deadlineMs) break;
    const claimed = await sql`UPDATE orders SET deposit_status = 'refunding' WHERE id = ${order.id} AND deposit_status = 'held' RETURNING id`;
    if (!claimed.length) { results.push({ orderId: order.id, success: false, error: 'Already being processed, or no longer held.' }); continue; }
    let refund;
    try {
      if (!order.razorpay_payment_id) throw new Error('No Razorpay payment is recorded for this booking, so the deposit cannot be refunded automatically.');
      const currency = order.charge_currency || 'INR';
      // A foreign-currency deposit: the same share of what was captured, never today's rate (_currency.js).
      const amount = currency === 'INR'
        ? Math.round(Number(order.deposit_amount) * 100)
        : await refundSubunitForInr(sql, { razorpayOrderId: order.razorpay_order_id, amountInr: Number(order.deposit_amount), currency });
      if (!amount) throw new Error(`No record of the amount charged in ${currency} for this booking — left 'held' for manual review.`);
      refund = await safeRefund(sql, razorpay, { orderId: order.id, paymentId: order.razorpay_payment_id, amountSubunit: amount, kind: 'deposit' });
    } catch (err) {
      await sql`UPDATE orders SET deposit_status = 'held' WHERE id = ${order.id} AND deposit_status = 'refunding'`;
      const msg = (err && err.error && err.error.description) ? 'Razorpay: ' + err.error.description : String((err && err.message) || err);
      results.push({ orderId: order.id, success: false, error: msg });
      continue;
    }
    try {
      await sql`UPDATE orders SET deposit_status = 'refunded', deposit_refund_id = ${refund.id} WHERE id = ${order.id}`;
      results.push({ orderId: order.id, success: true });
    } catch (saveErr) {
      // Locked as 'refunding' so nothing refunds it again; the refund is on record in refunds.
      results.push({ orderId: order.id, success: false, error: `Refund ${refund.id} was issued, but saving it failed. The booking is locked as 'refunding'.` });
    }
  }
  return { processed: results.length, refunded: results.filter(r => r.success).length, results };
}

// ---- Telling people about a deposit dispute ----
// 'raised': the guest is told the host reported damage and how to send their
// side (a Resolution Center request about the booking); the support inbox is
// alerted. 'resolved': the guest and the host are told the outcome.
// Never throws: an email that fails never undoes the dispute.
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
async function sendMail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to, subject, html: `<div style="font-family:sans-serif; max-width:520px; color:#1c1a17;">${html}</div>` }) });
    return r.ok;
  } catch (err) { console.error('deposit email failed:', err.message); return false; }
}
async function notifyDepositDispute(sql, orderId, event, { compensation = 0, refunded = 0 } = {}) {
  try {
    const o = (await sql`
      SELECT o.id, o.guest_email, o.suite_name, o.deposit_amount, o.dispute_reason, o.confirmation_code, o.departure,
             to_jsonb(o)->>'dispute_amount' AS dispute_amount, to_jsonb(o)->'dispute_evidence' AS dispute_evidence,
             l.property_name, l.host_email, g.name AS guest_name,
             (SELECT x.email FROM guests x WHERE x.host_id = l.host_id ORDER BY x.id LIMIT 1) AS host_account_email
      FROM orders o JOIN listings l ON l.id = o.listing_id LEFT JOIN guests g ON g.id = o.guest_id
      WHERE o.id = ${orderId}`)[0];
    if (!o) return;
    const name = esc(o.property_name || o.suite_name);
    const ref = o.confirmation_code ? ` (${esc(o.confirmation_code)})` : '';
    const pct = (n) => (Number(o.deposit_amount) > 0 ? Math.round(Number(n) / Number(o.deposit_amount) * 100) : 0) + '%';
    const btn = (href, label) => `<p style="margin:20px 0;"><a href="${href}" style="background:#1c1a17; color:#f4eadc; padding:12px 22px; text-decoration:none; display:inline-block;">${esc(label)}</a></p>`;
    if (event === 'raised') {
      const reply = `https://aerva.in/index.html?view=help&new=1&category=deposit_damage&order=${Number(o.id)}`;
      await sendMail(o.guest_email, `The host reported damage after your stay at ${o.property_name || o.suite_name}`,
        `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">Your security deposit is on hold</h2>
         <p>Hi ${esc(String(o.guest_name || '').split(' ')[0] || 'there')}, the host of <strong>${name}</strong>${ref} has reported damage or extra cleaning after your stay${o.dispute_amount != null ? `, and has asked to keep <strong>${inr(o.dispute_amount)}</strong> of your ${inr(o.deposit_amount)} security deposit` : ''}. The host has shared photos or videos with Aerva. Your deposit is held while Aerva reviews it.</p>
         <p style="padding:10px 14px; background:#f6f1ea; border-left:3px solid #a9884f;">“${esc(o.dispute_reason)}”</p>
         <p>If you would like to give your side, send it with any photos you have. Aerva considers both sides before deciding.</p>
         ${btn(reply, 'Send your side')}
         <p style="font-size:13px; color:#6e675d;">The deposit covers damage and extra cleaning, up to the deposit amount. Aerva approves how much, if any, goes to the host; the rest is refunded to your original payment method. Damage above the deposit is between you and the host, under Aerva’s Security Deposit and Damage Policy.</p>`);
      await sendMail(process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in', `Deposit dispute: ${o.property_name || o.suite_name} · booking #${o.id}`,
        `<p>The host reported damage on booking #${Number(o.id)}${ref} (${inr(o.deposit_amount)} deposit)${o.dispute_amount != null ? ` and asks to keep ${inr(o.dispute_amount)}` : ''}:</p><p>“${esc(o.dispute_reason)}”</p><p>Proof: ${(Array.isArray(o.dispute_evidence) ? o.dispute_evidence : []).map((u, i) => `<a href="${esc(u)}">file ${i + 1}</a>`).join(' · ') || 'none'}</p><p>The guest has been told and invited to send their side. Review it and approve the amount in Admin → Security Deposits.</p>`);
      return;
    }
    if (event === 'resolved') {
      await sendMail(o.guest_email, `Your security deposit for ${o.property_name || o.suite_name}`,
        `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">Aerva has decided on your security deposit</h2>
         <p>Booking at <strong>${name}</strong>${ref}. Security deposit: ${inr(o.deposit_amount)}.</p>
         <p>${refunded > 0 ? `<strong>${inr(refunded)}</strong> is being refunded to your original payment method. Your bank may take a few working days to show it.` : 'No part of the deposit is refunded.'}${compensation > 0 ? ` ${inr(compensation)} (${pct(compensation)} of the deposit) goes to the host for the damage.` : ''}</p>
         <p style="font-size:13px; color:#6e675d;">Aerva reviewed the host’s proof and your side. Its decision is final.</p>
         <p style="font-size:13px; color:#6e675d;">Questions? Raise a request in the Resolution Center: https://aerva.in/index.html?view=help</p>`);
      await sendMail(o.host_account_email || o.host_email, `Aerva’s decision on your damage report: ${o.property_name || o.suite_name}`,
        `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">Aerva has decided on your damage report</h2>
         <p>Booking #${Number(o.id)}${ref} at <strong>${name}</strong>. Security deposit: ${inr(o.deposit_amount)}.</p>
         <p>${o.dispute_amount != null ? `You asked for ${inr(o.dispute_amount)}. ` : ''}${compensation > 0 ? `Aerva approved <strong>${inr(compensation)}</strong> (${pct(compensation)} of the deposit). It is paid to your bank account as a separate payout; you will get an email when it is sent.` : 'No part of the deposit is paid to you.'}${refunded > 0 ? ` ${inr(refunded)} is refunded to the guest.` : ''}</p>
         <p style="font-size:13px; color:#6e675d;">Aerva’s decision is final. Damage or cleaning above the deposit is between you and the guest; Aerva pays no refund or compensation for it, under Aerva’s Security Deposit and Damage Policy.</p>`);
    }
  } catch (err) { console.error('notifyDepositDispute failed:', err.message); }
}

module.exports = { releaseDueDeposits, notifyDepositDispute, releaseEarly, addWorkingDays };
