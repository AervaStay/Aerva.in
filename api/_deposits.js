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
             l.property_name, l.host_email, g.name AS guest_name,
             (SELECT x.email FROM guests x WHERE x.host_id = l.host_id ORDER BY x.id LIMIT 1) AS host_account_email
      FROM orders o JOIN listings l ON l.id = o.listing_id LEFT JOIN guests g ON g.id = o.guest_id
      WHERE o.id = ${orderId}`)[0];
    if (!o) return;
    const name = esc(o.property_name || o.suite_name);
    const ref = o.confirmation_code ? ` (${esc(o.confirmation_code)})` : '';
    const btn = (href, label) => `<p style="margin:20px 0;"><a href="${href}" style="background:#1c1a17; color:#f4eadc; padding:12px 22px; text-decoration:none; display:inline-block;">${esc(label)}</a></p>`;
    if (event === 'raised') {
      const reply = `https://aerva.in/index.html?view=help&new=1&category=deposit_damage&order=${Number(o.id)}`;
      await sendMail(o.guest_email, `The host reported damage after your stay at ${o.property_name || o.suite_name}`,
        `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">Your security deposit is on hold</h2>
         <p>Hi ${esc(String(o.guest_name || '').split(' ')[0] || 'there')}, the host of <strong>${name}</strong>${ref} has reported damage after your stay. Your ${inr(o.deposit_amount)} security deposit is held while Aerva reviews it.</p>
         <p style="padding:10px 14px; background:#f6f1ea; border-left:3px solid #a9884f;">“${esc(o.dispute_reason)}”</p>
         <p>If you would like to give your side, send it with any photos you have. Aerva will consider it before deciding.</p>
         ${btn(reply, 'Send your side')}
         <p style="font-size:13px; color:#6e675d;">Aerva decides how much of the deposit, if any, goes to the host, under the Security Deposit and Damage Policy. The rest is refunded to your original payment method.</p>`);
      await sendMail(process.env.ADMIN_ALERT_EMAIL || 'hello@aerva.in', `Deposit dispute: ${o.property_name || o.suite_name} · booking #${o.id}`,
        `<p>The host reported damage on booking #${Number(o.id)}${ref} (${inr(o.deposit_amount)} deposit):</p><p>“${esc(o.dispute_reason)}”</p><p>The guest has been told and invited to send their side. Decide it in Admin → Security Deposits.</p>`);
      return;
    }
    if (event === 'resolved') {
      await sendMail(o.guest_email, `Your security deposit for ${o.property_name || o.suite_name}`,
        `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">Aerva has reviewed the damage report</h2>
         <p>Booking at <strong>${name}</strong>${ref}. Security deposit: ${inr(o.deposit_amount)}.</p>
         <p>${refunded > 0 ? `<strong>${inr(refunded)}</strong> is being refunded to your original payment method. Your bank may take a few working days to show it.` : 'No part of the deposit is refunded.'}${compensation > 0 ? ` ${inr(compensation)} goes to the host for the damage.` : ''}</p>
         <p style="font-size:13px; color:#6e675d;">Questions? Raise a request in the Resolution Center: https://aerva.in/index.html?view=help</p>`);
      await sendMail(o.host_account_email || o.host_email, `Decision on your damage report: ${o.property_name || o.suite_name}`,
        `<h2 style="font-family:Georgia,serif; margin:0 0 8px;">Aerva has decided your damage report</h2>
         <p>Booking #${Number(o.id)}${ref} at <strong>${name}</strong>. Security deposit: ${inr(o.deposit_amount)}.</p>
         <p>${compensation > 0 ? `You receive <strong>${inr(compensation)}</strong>. It is paid to your bank account as a separate payout; you will get an email when it is sent.` : 'No part of the deposit is paid to you.'}${refunded > 0 ? ` ${inr(refunded)} is refunded to the guest.` : ''}</p>
         <p style="font-size:13px; color:#6e675d;">Damage above the deposit is between you and the guest, under Aerva’s Security Deposit and Damage Policy.</p>`);
    }
  } catch (err) { console.error('notifyDepositDispute failed:', err.message); }
}

module.exports = { releaseDueDeposits, notifyDepositDispute };
