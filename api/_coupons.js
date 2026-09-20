// /api/_coupons.js — releasing cancellation coupons to guests. Not an endpoint.
//
// When a host (or co-host) cancels a booking, the guest is refunded at once
// and gets an Aerva coupon worth 10% of the booking. The coupon is released
// automatically 15 minutes after the cancellation: until then it is
// 'scheduled' and cannot be used. Nobody at Aerva releases it by hand.
//
// What releases it (Vercel Hobby runs cron only once a day, so there is no
// server job every few minutes):
//   • any request to get-listings (the site's page loads) or create-order
//     runs releaseDueCoupons() — cheap when nothing is due;
//   • GET get-listings?releaseCoupons=1 with the cron secret, for an
//     external every-5-minutes pinger (e.g. cron-job.org) for exact timing;
//   • the daily cron, as a backstop.
// The release is a single UPDATE … RETURNING, so two requests at once can
// never release (or email) the same coupon twice.

const COUPON_RELEASE_DELAY_MINUTES = 15;

async function sendCouponEmail(coupon, code, expiresAt){
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set — guest will not receive their coupon.');
    return;
  }
  const fmt = (n) => '₹' + Number(n).toLocaleString('en-IN');
  const expiresLabel = expiresAt.toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">You've received an Aerva coupon</h2>
      <p>Your host for <strong>${coupon.suite_name}</strong> has issued you a coupon worth <strong>${fmt(coupon.amount)}</strong>.</p>
      <p style="background:#f4eadc; padding:16px; text-align:center; font-size:20px; letter-spacing:0.05em; font-weight:600;">${code}</p>
      <p>Apply this code at checkout on any Aerva stay or experience. Valid until <strong>${expiresLabel}</strong> (3 months from today).</p>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">Questions about this coupon? Contact hello@aerva.in.</p>
    </div>
  `;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Aerva <hello@aerva.in>',
      to: coupon.guest_email,
      subject: 'You\'ve received an Aerva coupon',
      html
    })
  });
  if (!res.ok) {
    let detail;
    try { detail = await res.json(); } catch { detail = { message: res.statusText }; }
    console.error('Resend send failed (coupon notice):', res.status, detail);
  }
}

// Release every scheduled coupon whose time has come, and email each guest
// their code. Never throws. At most one run per warm server instance per
// 30 seconds, so busy page loads do not repeat the query needlessly.
let lastRun = 0;
async function releaseDueCoupons(sql, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastRun < 30000) return { released: 0, skipped: true };
  lastRun = now;
  try {
    const due = await sql`
      UPDATE coupons SET status = 'active', expires_at = now() + interval '3 months'
      WHERE status = 'scheduled' AND release_at <= now()
      RETURNING id, code, amount, expires_at, source_order_id
    `;
    for (const c of due) {
      try {
        const o = (await sql`SELECT guest_email, suite_name FROM orders WHERE id = ${c.source_order_id}`)[0] || {};
        await sendCouponEmail({ amount: c.amount, guest_email: o.guest_email, suite_name: o.suite_name }, c.code, new Date(c.expires_at));
      } catch (err) { console.error('coupon email failed:', c.id, err.message); }
      try {
        await sql`INSERT INTO audit_log (action, success, actor_type, target_type, target_id, metadata)
                  VALUES ('cancellation_coupon_released', true, 'system', 'coupon', ${c.id}, ${JSON.stringify({ orderId: c.source_order_id })})`;
      } catch (err) { /* audit is best-effort */ }
    }
    return { released: due.length };
  } catch (err) {
    // Before migration_coupon_release.sql runs, release_at does not exist.
    return { released: 0, error: err.message };
  }
}

module.exports = { COUPON_RELEASE_DELAY_MINUTES, releaseDueCoupons, sendCouponEmail };
