// /api/_admin-lookup.js — Admin → Lookup. Not an endpoint (used by
// get-pending-listings.js, so it adds no Vercel function).
//
// Find anything by what a person on the phone gives you — a confirmation
// code, booking id, Razorpay order or payment id, email, phone number,
// listing name or id, city — and act on it:
//   booking → cancel with a refund (any %, optionally the service fee too,
//             optionally counted against the host), or refund an amount
//             without cancelling (Aerva or the host pays);
//   guest   → sign out everywhere, suspend / unsuspend;
//   listing → block / unblock / remove / restore (setListingStatus, as before).
// Every action needs a written reason and is recorded in the Audit Log.

const { safeRefund, refundAcrossPayments, hasChangePayments } = require('./_refunds');
const { refundSubunitForInr } = require('./_currency');
const { logAudit } = require('./_audit-log');
const { postThreadMessage } = require('./_cancellations');

const userError = (msg, status = 400) => Object.assign(new Error(msg), { isUserFacing: true, status });
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const escH = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Each piece is optional: a table or column a migration has not added yet
// gives an empty result rather than failing the whole lookup.
const soft = async (q, fallback = []) => { try { return await q; } catch (e) { return fallback; } };

// ---------------------------------------------------------------------
// SEARCH
// ---------------------------------------------------------------------
// Booking columns every list shows (written out in each query: the
// driver does not nest query fragments).

async function search(sql, raw) {
  const q = String(raw || '').trim().slice(0, 120);
  if (q.length < 2) throw userError('Type at least two characters.');
  const digits = q.replace(/\D/g, '');
  const asId = /^#?\d{1,9}$/.test(q) ? Number(q.replace('#', '')) : null;
  const isEmail = q.includes('@');
  const isPhone = digits.length >= 10 && /^[+\d\s\-().]+$/.test(q);
  const last10 = digits.slice(-10);
  const like = '%' + q.replace(/[%_\\]/g, m => '\\' + m) + '%';
  const upper = q.toUpperCase();

  // ---- bookings ----
  const bookings = await soft(sql`
    SELECT o.id, to_jsonb(o)->>'confirmation_code' AS code, o.suite_name, o.listing_id, o.guest_id, o.guest_email,
           o.arrival, o.departure, o.guests, o.status, o.total, o.created_at, o.razorpay_order_id, o.razorpay_payment_id,
           COALESCE(o.order_type, 'stay') AS order_type,
           NULLIF(btrim(concat_ws(' ', to_jsonb(o)->>'guest_first_name', to_jsonb(o)->>'guest_last_name')), '') AS booked_name, g.name AS account_name, l.city
    FROM orders o
    LEFT JOIN guests g ON g.id = o.guest_id
    LEFT JOIN listings l ON l.id = o.listing_id
    WHERE upper(COALESCE(to_jsonb(o)->>'confirmation_code', '')) = ${upper}
       OR o.id = ${asId || -1}
       OR o.razorpay_order_id = ${q} OR o.razorpay_payment_id = ${q}
       OR (${isEmail} AND (o.guest_email ILIKE ${like} OR g.email ILIKE ${like}))
       OR (${isPhone} AND right(regexp_replace(COALESCE(g.phone, ''), '\\D', '', 'g'), 10) = ${last10})
       OR (${!isEmail && !isPhone && !asId} AND (o.suite_name ILIKE ${like} OR g.name ILIKE ${like}
            OR concat_ws(' ', to_jsonb(o)->>'guest_first_name', to_jsonb(o)->>'guest_last_name') ILIKE ${like}))
       OR (${asId != null} AND o.listing_id = ${asId || -1})
    ORDER BY (upper(COALESCE(to_jsonb(o)->>'confirmation_code', '')) = ${upper} OR o.id = ${asId || -1}) DESC,
             o.arrival DESC
    LIMIT 40`);

  // ---- guests (accounts) ----
  const guests = await soft(sql`
    SELECT g.id, g.name, g.email, g.phone, g.created_at, g.host_id, to_jsonb(g)->>'account_status' AS account_status,
           to_jsonb(g)->>'deleted_at' AS deleted_at,
           (SELECT count(*)::int FROM orders o WHERE o.guest_id = g.id) AS bookings
    FROM guests g
    WHERE g.id = ${asId || -1}
       OR (${isEmail} AND g.email ILIKE ${like})
       OR (${isPhone} AND right(regexp_replace(COALESCE(g.phone, ''), '\\D', '', 'g'), 10) = ${last10})
       OR (${!isEmail && !isPhone && !asId} AND g.name ILIKE ${like})
       OR g.id IN (SELECT o.guest_id FROM orders o WHERE o.guest_id IS NOT NULL AND (
            upper(COALESCE(to_jsonb(o)->>'confirmation_code', '')) = ${upper} OR o.razorpay_order_id = ${q} OR o.razorpay_payment_id = ${q}))
       OR g.host_id IN (SELECT h.id FROM hosts h WHERE (${isEmail} AND h.email ILIKE ${like})
            OR (${isPhone} AND right(regexp_replace(COALESCE(h.phone, ''), '\\D', '', 'g'), 10) = ${last10}))
    ORDER BY g.id = ${asId || -1} DESC, g.created_at DESC
    LIMIT 20`);

  // ---- listings ----
  const listings = await soft(sql`
    SELECT l.id, l.property_name, l.city, to_jsonb(l)->>'area' AS area, l.status, COALESCE(l.listing_type, 'stay') AS listing_type,
           l.host_id, l.host_name, l.host_email, l.host_phone
    FROM listings l
    WHERE l.id = ${asId || -1}
       OR (${isEmail} AND l.host_email ILIKE ${like})
       OR (${isPhone} AND right(regexp_replace(COALESCE(l.host_phone, ''), '\\D', '', 'g'), 10) = ${last10})
       OR (${!isEmail && !isPhone && !asId} AND (l.property_name ILIKE ${like} OR l.city ILIKE ${like}
            OR COALESCE(to_jsonb(l)->>'area', '') ILIKE ${like} OR l.host_name ILIKE ${like}))
       OR l.id IN (SELECT o.listing_id FROM orders o WHERE upper(COALESCE(to_jsonb(o)->>'confirmation_code', '')) = ${upper}
                     OR o.razorpay_order_id = ${q} OR o.razorpay_payment_id = ${q})
    ORDER BY l.id = ${asId || -1} DESC, (l.status = 'approved') DESC, l.property_name
    LIMIT 20`);

  const kind = asId != null ? 'id' : isEmail ? 'email' : isPhone ? 'phone' : 'text';
  return { query: q, matchedAs: kind, bookings, guests, listings };
}

// ---------------------------------------------------------------------
// DETAILS
// ---------------------------------------------------------------------
async function moneyState(sql, orderId) {
  const o = (await sql`SELECT id, total, to_jsonb(orders)->>'coupon_discount' AS coupon, charge_currency, razorpay_payment_id, razorpay_order_id
                       FROM orders WHERE id = ${orderId}`)[0];
  if (!o) return null;
  const changePaid = (await soft(sql`SELECT COALESCE(sum(difference), 0)::int AS n FROM booking_changes
                                     WHERE order_id = ${orderId} AND status = 'applied' AND razorpay_payment_id IS NOT NULL AND difference > 0`, [{ n: 0 }]))[0].n;
  const refunded = (await soft(sql`SELECT COALESCE(sum(amount), 0)::bigint AS p FROM refunds
                                   WHERE order_id = ${orderId} AND status <> 'failed'`, [{ p: 0 }]))[0].p;
  const charged = Math.max(0, Math.round(Number(o.total) || 0) - Math.round(Number(o.coupon) || 0)) + (Number(changePaid) || 0);
  const refundedInr = Math.round(Number(refunded) / 100);
  return { charged, refunded: refundedInr, refundable: Math.max(0, charged - refundedInr), currency: o.charge_currency || 'INR' };
}

async function bookingDetail(sql, id) {
  const o = (await sql`
    SELECT o.*, l.property_name, l.city, to_jsonb(l)->>'area' AS area, l.status AS listing_status, l.host_id,
           l.host_name, l.host_email, l.host_phone, COALESCE(l.listing_type, 'stay') AS listing_type,
           g.name AS account_name, g.email AS account_email, g.phone AS account_phone, to_jsonb(g)->>'account_status' AS account_status,
           hg.id AS host_guest_id
    FROM orders o
    LEFT JOIN listings l ON l.id = o.listing_id
    LEFT JOIN guests g ON g.id = o.guest_id
    LEFT JOIN LATERAL (SELECT id FROM guests WHERE host_id = l.host_id ORDER BY id LIMIT 1) hg ON TRUE
    WHERE o.id = ${Number(id) || 0}`)[0];
  if (!o) throw userError('Booking not found.', 404);
  // Never sent to the browser.
  ['agreement_ip', 'cancel_claim'].forEach(k => delete o[k]);
  const [refunds, payouts, requests, history, linked, conv] = await Promise.all([
    soft(sql`SELECT id, kind, amount, status, failure_reason, created_at FROM refunds WHERE order_id = ${o.id} ORDER BY id`),
    soft(sql`SELECT id, status, gross, net, created_at, sent_at, COALESCE(to_jsonb(payouts)->>'kind', 'booking') AS kind FROM payouts WHERE order_id = ${o.id} ORDER BY id`),
    soft(sql`SELECT id, status, reason_code, created_at FROM cancellation_requests WHERE order_id = ${o.id} ORDER BY id DESC LIMIT 5`),
    soft(sql`SELECT created_at, action, actor_type, actor_identifier, success, metadata FROM audit_log
             WHERE target_type = 'order' AND target_id = ${o.id} AND action <> 'admin_lookup_viewed' ORDER BY created_at DESC LIMIT 25`),
    soft(sql`SELECT id, suite_name, status FROM orders WHERE razorpay_order_id = ${o.razorpay_order_id} AND id <> ${o.id}`),
    soft(sql`SELECT id FROM conversations WHERE order_id = ${o.id}`)
  ]);
  return { booking: o, money: await moneyState(sql, o.id), refunds, payouts, requests, history, linked, conversationId: conv[0] ? conv[0].id : null };
}

async function guestDetail(sql, id) {
  const g = (await sql`
    SELECT id, name, email, phone, created_at, host_id, email_verified, profile_photo_url,
           to_jsonb(guests)->>'account_status' AS account_status, to_jsonb(guests)->>'deactivated_at' AS deactivated_at,
           to_jsonb(guests)->>'deleted_at' AS deleted_at, to_jsonb(guests)->>'id_status' AS id_status,
           to_jsonb(guests)->>'phone_verified' AS phone_verified, to_jsonb(guests)->>'session_version' AS session_version
    FROM guests WHERE id = ${Number(id) || 0}`)[0];
  if (!g) throw userError('Account not found.', 404);
  const [bookings, listings, tickets, history, host] = await Promise.all([
    soft(sql`SELECT o.id, to_jsonb(o)->>'confirmation_code' AS code, o.suite_name, o.listing_id, o.guest_id, o.guest_email,
           o.arrival, o.departure, o.guests, o.status, o.total, o.created_at, o.razorpay_order_id, o.razorpay_payment_id,
           COALESCE(o.order_type, 'stay') AS order_type,
           NULLIF(btrim(concat_ws(' ', to_jsonb(o)->>'guest_first_name', to_jsonb(o)->>'guest_last_name')), '') AS booked_name FROM orders o WHERE o.guest_id = ${g.id} ORDER BY o.arrival DESC LIMIT 60`),
    g.host_id ? soft(sql`SELECT id, property_name, city, status, COALESCE(listing_type, 'stay') AS listing_type FROM listings WHERE host_id = ${g.host_id} ORDER BY id`) : [],
    soft(sql`SELECT id, ref, subject, status, created_at FROM support_tickets WHERE guest_id = ${g.id} ORDER BY id DESC LIMIT 10`),
    soft(sql`SELECT created_at, action, actor_type, success, metadata FROM audit_log
             WHERE target_type = 'guest' AND target_id = ${g.id} AND action <> 'admin_lookup_viewed' ORDER BY created_at DESC LIMIT 20`),
    g.host_id ? soft(sql`SELECT id, email, phone, to_jsonb(hosts)->>'hosting_status' AS hosting_status, pan_status, bank_status, aadhaar_status FROM hosts WHERE id = ${g.host_id}`) : []
  ]);
  return { guest: g, host: host[0] || null, bookings, listings, tickets, history };
}

async function listingDetail(sql, id) {
  const l = (await sql`
    SELECT l.id, l.property_name, l.city, to_jsonb(l)->>'area' AS area, l.status, COALESCE(l.listing_type, 'stay') AS listing_type,
           l.host_id, l.host_name, l.host_email, l.host_phone, l.created_at, l.nightly_rate, l.max_guests,
           to_jsonb(l)->>'admin_status_reason' AS admin_status_reason, to_jsonb(l)->>'cancellation_policy' AS cancellation_policy,
           l.formatted_address, (SELECT id FROM guests WHERE host_id = l.host_id ORDER BY id LIMIT 1) AS host_guest_id
    FROM listings l WHERE l.id = ${Number(id) || 0}`)[0];
  if (!l) throw userError('Listing not found.', 404);
  const [bookings, history] = await Promise.all([
    soft(sql`SELECT o.id, to_jsonb(o)->>'confirmation_code' AS code, o.suite_name, o.listing_id, o.guest_id, o.guest_email,
           o.arrival, o.departure, o.guests, o.status, o.total, o.created_at, o.razorpay_order_id, o.razorpay_payment_id,
           COALESCE(o.order_type, 'stay') AS order_type,
           NULLIF(btrim(concat_ws(' ', to_jsonb(o)->>'guest_first_name', to_jsonb(o)->>'guest_last_name')), '') AS booked_name, g.name AS account_name FROM orders o LEFT JOIN guests g ON g.id = o.guest_id
             WHERE o.listing_id = ${l.id}
             ORDER BY (o.status = 'paid' AND o.departure >= current_date) DESC, o.arrival DESC LIMIT 80`),
    soft(sql`SELECT created_at, action, actor_type, success, metadata FROM audit_log
             WHERE target_type = 'listing' AND target_id = ${l.id} AND action <> 'admin_lookup_viewed' ORDER BY created_at DESC LIMIT 20`)
  ]);
  return { listing: l, bookings, history };
}

// ---------------------------------------------------------------------
// REFUND WITHOUT CANCELLING (goodwill / partial)
// ---------------------------------------------------------------------
// The booking stays as it is. hostPays: taken off the host's payout for
// this booking — only while that payout has not been sent.
async function partialRefund(sql, razorpay, { orderId, amount, reason, hostPays, adminLabel }) {
  const amt = Math.round(Number(amount) || 0);
  if (amt <= 0) throw userError('Enter an amount to refund.');
  if (!reason || String(reason).trim().length < 5) throw userError('Write the reason (the guest is told it).');
  const o = (await sql`SELECT o.*, l.host_id FROM orders o LEFT JOIN listings l ON l.id = o.listing_id WHERE o.id = ${Number(orderId) || 0}`)[0];
  if (!o) throw userError('Booking not found.', 404);
  if (!o.razorpay_payment_id) throw userError('No payment is recorded for this booking, so it cannot be refunded here.');
  if (!['paid', 'cancelled'].includes(o.status)) throw userError(`This booking is "${o.status}" — nothing more can be refunded.`);
  const money = await moneyState(sql, o.id);
  if (amt > money.refundable) throw userError(`At most ${inr(money.refundable)} can be refunded (charged ${inr(money.charged)}, already refunded ${inr(money.refunded)}).`);

  // Which goodwill refund this is (1, 2, …). Two clicks at once pick the
  // same number, and the refunds table lets only one through (_refunds.js).
  const n = (await soft(sql`SELECT count(*)::int AS n FROM refunds WHERE order_id = ${o.id} AND kind LIKE 'goodwill-%'`, [{ n: 0 }]))[0].n;
  const kindBase = `goodwill-${Number(n) + 1}`;

  // The host's share is taken first, so a refund never goes out while the
  // host is still paid in full for it.
  let payoutBefore = null;
  if (hostPays) {
    const pays = await soft(sql`SELECT status FROM payouts WHERE order_id = ${o.id} AND COALESCE(to_jsonb(payouts)->>'kind', 'booking') = 'booking'`);
    if (pays.some(p => !['due', 'failed'].includes(p.status))) throw userError('The host has already been paid for this booking, so it cannot come out of their payout. Choose "Aerva pays" instead.', 409);
    payoutBefore = Math.round(Number(o.payout_amount) || 0);
    if (amt > payoutBefore) throw userError(`The host's payout for this booking is ${inr(payoutBefore)} — less than the refund.`);
    await soft(sql`DELETE FROM payouts WHERE order_id = ${o.id} AND status IN ('due', 'failed') AND COALESCE(to_jsonb(payouts)->>'kind', 'booking') = 'booking'`);
    await sql`UPDATE orders SET payout_amount = ${payoutBefore - amt} WHERE id = ${o.id}`;
    await soft(sql`UPDATE order_cohost_shares SET amount = round(${payoutBefore - amt}::numeric * percent / 100) WHERE order_id = ${o.id}`);
  }

  let refundId = null;
  try {
    if (await hasChangePayments(sql, o.id)) {
      const r = await refundAcrossPayments(sql, razorpay, { orderId: o.id, amountInr: amt, kindBase });
      if (r.shortfallInr > 0) throw userError(`Only ${inr(r.refundedInr)} could be refunded — the payments have nothing more left.`, 409);
      refundId = r.firstRefundId;
    } else {
      const currency = o.charge_currency || 'INR';
      const sub = currency === 'INR' ? amt * 100 : await refundSubunitForInr(sql, { razorpayOrderId: o.razorpay_order_id, amountInr: amt, currency });
      if (!sub) throw userError(`There is no record of the amount charged in ${currency}, so this cannot be refunded automatically.`, 502);
      refundId = (await safeRefund(sql, razorpay, { orderId: o.id, paymentId: o.razorpay_payment_id, amountSubunit: sub, kind: kindBase })).id;
    }
  } catch (err) {
    if (hostPays && payoutBefore != null) {
      await soft(sql`UPDATE orders SET payout_amount = ${payoutBefore} WHERE id = ${o.id}`);
      await soft(sql`UPDATE order_cohost_shares SET amount = round(${payoutBefore}::numeric * percent / 100) WHERE order_id = ${o.id}`);
    }
    await logAudit(sql, { action: 'admin_partial_refund', success: false, actorType: 'admin', actorIdentifier: adminLabel || 'admin',
      targetType: 'order', targetId: o.id, metadata: { amount: amt, reason, hostPays: !!hostPays, error: String(err.message || err).slice(0, 300) } });
    throw err.isUserFacing ? err : userError('Razorpay could not make this refund: ' + String(err.error && err.error.description || err.message || 'unknown error'), 502);
  }

  await logAudit(sql, { action: 'admin_partial_refund', success: true, actorType: 'admin', actorIdentifier: adminLabel || 'admin',
    targetType: 'order', targetId: o.id, metadata: { amount: amt, reason, hostPays: !!hostPays, refundId, kind: kindBase } });
  await postThreadMessage(sql, o.id, 'system', `Aerva refunded ${inr(amt)} to the guest. Reason: ${String(reason).trim()}`);
  if (process.env.RESEND_API_KEY && o.guest_email) {
    try {
      await fetch('https://api.resend.com/emails', { method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to: o.guest_email, subject: `A refund for your booking at ${o.suite_name}`,
          html: `<div style="font-family:sans-serif; max-width:480px;"><h2 style="font-family:Georgia,serif;">We have refunded ${inr(amt)}</h2>
            <p>For your booking at <strong>${escH(o.suite_name)}</strong>${o.confirmation_code ? ` (confirmation code ${escH(o.confirmation_code)})` : ''}.</p>
            <p>${escH(String(reason).trim())}</p>
            <p>The refund goes to your original payment method and usually arrives in 5–7 working days.${o.status === 'paid' ? ' Your booking is unchanged.' : ''}</p>
            <p style="font-size:12px; opacity:0.6; margin-top:24px;">Questions? Contact hello@aerva.in.</p></div>` }) });
    } catch (e) { console.error('partial refund email failed:', e.message); }
  }
  return { refunded: amt, refundId, money: await moneyState(sql, o.id) };
}

// ---------------------------------------------------------------------
// ACCOUNTS
// ---------------------------------------------------------------------
// action: 'signOut' | 'suspend' | 'unsuspend'. A suspended account cannot
// sign in, and every session it has ends at once (_accounts.js).
async function accountAction(sql, { guestId, action, reason, adminLabel }) {
  const id = Number(guestId) || 0;
  const g = (await sql`SELECT id, email, name, to_jsonb(guests)->>'account_status' AS account_status, to_jsonb(guests)->>'deleted_at' AS deleted_at FROM guests WHERE id = ${id}`)[0];
  if (!g) throw userError('Account not found.', 404);
  if (g.deleted_at) throw userError('This account has been deleted.');
  const why = String(reason || '').trim().slice(0, 500);
  if (action !== 'signOut' && why.length < 5) throw userError('Write the reason.');
  const bump = () => sql`UPDATE guests SET session_version = COALESCE(session_version, 0) + 1 WHERE id = ${id}`;
  if (action === 'signOut') {
    await bump();
  } else if (action === 'suspend') {
    if (g.account_status === 'suspended') throw userError('Already suspended.');
    try { await sql`UPDATE guests SET account_status = 'suspended' WHERE id = ${id}`; }
    catch (err) { throw userError('Run migration_admin_lookup.sql first (it allows the "suspended" status).', 503); }
    await bump();
  } else if (action === 'unsuspend') {
    if (g.account_status !== 'suspended') throw userError('This account is not suspended.');
    await sql`UPDATE guests SET account_status = NULL WHERE id = ${id}`;
  } else {
    throw userError('Unknown action.');
  }
  await logAudit(sql, { action: `admin_account_${action === 'signOut' ? 'signed_out' : action === 'suspend' ? 'suspended' : 'unsuspended'}`, success: true,
    actorType: 'admin', actorIdentifier: adminLabel || 'admin', targetType: 'guest', targetId: id, metadata: { reason: why || null } });
  if (process.env.RESEND_API_KEY && g.email && action !== 'signOut') {
    const subject = action === 'suspend' ? 'Your Aerva account has been suspended' : 'Your Aerva account is active again';
    const body = action === 'suspend'
      ? `<p>Your Aerva account has been suspended, so you cannot sign in or book for now.</p><p>${escH(why)}</p><p>If you think this is a mistake, reply to this email or write to hello@aerva.in.</p>`
      : `<p>Your Aerva account is active again — you can sign in as usual.</p>`;
    try {
      await fetch('https://api.resend.com/emails', { method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Aerva <hello@aerva.in>', to: g.email, subject, html: `<div style="font-family:sans-serif; max-width:480px;">${body}</div>` }) });
    } catch (e) { console.error('account email failed:', e.message); }
  }
  return { ok: true };
}

module.exports = { search, bookingDetail, guestDetail, listingDetail, partialRefund, accountAction, moneyState };
