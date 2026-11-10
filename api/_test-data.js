// /api/_test-data.js — Admin → Database updates → "Clear test data".
// Not an endpoint (get-pending-listings.js, admin role only).
//
// Before launch, PROD holds test accounts, listings and bookings. This
// removes them (owner, 9 Nov 2026): DUMMY = anything added through the
// back end (straight into the database, never through the site) and every
// listing named "[Test] …". What was made through the site stays — its
// listings, their logs, guests, bookings, payments, TDS… Kept:
//   • Aerva's admin logins, settings, fee rates, migrations — never touched;
//   • everything made through the site (ticked in the preview), except
//     "[Test]" listings and their bookings;
//   • every booking paid with REAL money (a live Razorpay payment), with its
//     guest, listing and host, so the CA's records and Razorpay match;
//   • the audit logs (cleared once, separately, at go-live — not here).
// Stored photo files are not deleted (stored files never are).
//
//   preview(sql)                 → "Dummy data only": what exists, what is kept
//   clear(sql, keep)             → deletes the rest in ONE transaction
//   previewAll(sql) / clearAll(sql) → "From the beginning": every account,
//       host, listing, booking, message, payment record… emptied (ids start
//       again at 1). Kept: admin logins, settings, fee rates, agreement
//       versions, database updates, job history and the audit logs.
// Who may run these, the owner's PIN, the backup taken first and the
// go-live switch are in _data-safety.js / get-pending-listings.js.
//
// The keep lists the admin sends are widened on the server ("closure"):
// a kept booking keeps its guest, listing, host and coupon; a kept listing
// keeps its host and the host's account; nothing kept is left pointing at
// something deleted.

const userError = (message, status = 400) => Object.assign(new Error(message), { isUserFacing: true, status });
// "[Test] Something" — always dummy (owner's naming).
const TEST_NAME = /^\s*\[\s*test\s*\]/i;
const BLOB = /\.blob\.vercel-storage\.com\//i;

const ids = (rows, k = 'id') => [...new Set(rows.map(r => r[k]).filter(v => v !== null && v !== undefined).map(Number))];
const nums = (a) => [...new Set((Array.isArray(a) ? a : []).map(Number).filter(n => Number.isInteger(n) && n > 0))];


// ---- Which payments were real money ----
// Only live keys can see live payments: a payment Razorpay finds with a
// rzp_live_ key is real money. With test keys (UAT) nothing here is real.
function liveKeys() { return /^rzp_live_/i.test(String(process.env.RAZORPAY_KEY_ID || '')) && !!process.env.RAZORPAY_KEY_SECRET; }
async function realPayments(paymentIds) {
  const list = [...new Set(paymentIds.filter(p => /^pay_[A-Za-z0-9]+$/.test(String(p || ''))))].slice(0, 400);
  const real = new Set();
  if (!liveKeys() || !list.length) return { real, checked: list.length, live: liveKeys(), failed: 0 };
  const auth = 'Basic ' + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  let failed = 0;
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(list.slice(i, i + 6).map(async (p) => {
      try {
        const r = await fetch(`https://api.razorpay.com/v1/payments/${p}`, { headers: { Authorization: auth } });
        if (r.ok) { const j = await r.json().catch(() => ({})); if (j && j.id === p) real.add(p); }
        else if (r.status !== 400 && r.status !== 404) { failed++; real.add(p); }   // unsure → treated as real (kept)
      } catch (e) { failed++; real.add(p); }
    }));
  }
  return { real, checked: list.length, live: true, failed };
}

// Everything the preview and the clear both need.
async function load(sql) {
  const [guests, hosts, listings, orders, coupons, changes, penalties, credits] = await Promise.all([
    sql`SELECT id, name, first_name, last_name, email, phone, host_id, created_at FROM guests ORDER BY id`,
    sql`SELECT id, guest_id, name, email FROM hosts ORDER BY id`,
    sql`SELECT id, property_name, city, status, listing_type, host_id, created_at, cover_photo_url, exterior_photo_urls::text AS ext FROM listings ORDER BY id`,
    sql`SELECT id, listing_id, guest_id, guest_email, suite_name, arrival, departure, total, status, coupon_id, razorpay_payment_id, razorpay_order_id, created_at FROM orders ORDER BY id`,
    sql`SELECT id, code, guest_id, paid_by_guest_id, issuing_host_id, source_order_id, redeemed_order_id, razorpay_payment_id FROM coupons`,
    sql`SELECT order_id, guest_id, razorpay_payment_id FROM booking_changes WHERE razorpay_payment_id IS NOT NULL`,
    sql`SELECT order_id, host_id, payer_guest_id, coupon_id, razorpay_payment_id FROM host_penalties WHERE razorpay_payment_id IS NOT NULL`,
    sql`SELECT id, guest_id, source_order_id, razorpay_payment_id FROM fee_credits WHERE razorpay_payment_id IS NOT NULL`
  ]);
  const pay = await realPayments([...orders, ...coupons, ...changes, ...penalties, ...credits].map(r => r.razorpay_payment_id));
  return { guests, hosts, listings, orders, coupons, changes, penalties, credits, pay };
}

// Made through the site, or added straight into the database? (owner,
// 9 Nov 2026). The back-end test data came with its own audit rows and
// payment records, so those prove nothing for bookings. The owner's rule:
//   • a BOOKING was made through the site only if it cost under ₹10 (every
//     real test booking was a few rupees) — or Razorpay shows real money;
//   • an ACCOUNT only if it actually signed in or signed up (OTP / login /
//     email confirmation recorded in the audit log under its id, email or
//     phone) — and never an @example.com / .org / .net address;
//   • a LISTING only if it was submitted through the listing form, its host
//     agreement was accepted, or its photos are in Aerva's own storage —
//     and never one named "[Test] …".
// The preview shows why for each row; the admin can change any tick.
const SITE_BOOKING_UNDER = 10;              // ₹
const SIGN_IN_ACTIONS = ['guest_login', 'guest_signup', 'guest_phone_otp_verified', 'guest_email_verified', 'guest_password_reset_completed',
  'guest_phone_linked', 'host_phone_otp_verified', 'host_account_created'];
const EXAMPLE_EMAIL = /@example\.(com|org|net)$/i;
async function origins(sql, d) {
  const [lsub, agree, gtarget, actors] = await Promise.all([
    sql`SELECT DISTINCT target_id FROM audit_log WHERE target_type = 'listing' AND target_id IS NOT NULL AND action = 'listing_submitted'`,
    sql`SELECT DISTINCT listing_id FROM host_agreement_acceptances WHERE listing_id IS NOT NULL`,
    sql`SELECT DISTINCT target_id FROM audit_log WHERE target_type = 'guest' AND target_id IS NOT NULL AND action = ANY(${SIGN_IN_ACTIONS}) AND success = true`,
    sql`SELECT DISTINCT lower(actor_identifier) AS who FROM audit_log WHERE action = ANY(${SIGN_IN_ACTIONS}) AND success = true AND actor_identifier IS NOT NULL`
  ]);
  const L = new Set([...lsub.map(r => Number(r.target_id)), ...agree.map(r => Number(r.listing_id))]);
  const G = new Set(gtarget.map(r => Number(r.target_id)));
  const who = new Set(actors.map(r => r.who));
  const phoneKey = (p) => String(p || '').replace(/\D/g, '').slice(-10);
  const whoPhones = new Set([...who].map(phoneKey).filter(x => x.length === 10));
  const listing = new Map(), guest = new Map(), order = new Map();
  d.listings.forEach(l => {
    const test = TEST_NAME.test(String(l.property_name || ''));
    const why = L.has(Number(l.id)) ? 'submitted through the site' : (BLOB.test(String(l.cover_photo_url || '')) || BLOB.test(String(l.ext || ''))) ? 'photos uploaded through the site' : null;
    listing.set(Number(l.id), { site: !!why && !test, test, why: test ? 'named [Test]' : (why || 'added through the back end') });
  });
  d.guests.forEach(g => {
    const em = String(g.email || '').toLowerCase();
    if (EXAMPLE_EMAIL.test(em)) { guest.set(Number(g.id), { site: false, why: 'example.com test address' }); return; }
    const site = G.has(Number(g.id)) || (em && who.has(em)) || (phoneKey(g.phone).length === 10 && whoPhones.has(phoneKey(g.phone)));
    guest.set(Number(g.id), { site, why: site ? 'signed in through the site' : 'never signed in — back end' });
  });
  d.orders.forEach(o => {
    const real = !!(o.razorpay_payment_id && d.pay.real.has(o.razorpay_payment_id));
    const small = Number(o.total) > 0 && Number(o.total) < SITE_BOOKING_UNDER;
    const site = real || small;
    order.set(Number(o.id), { site, real, why: real ? 'paid with real money' : small ? `under ₹${SITE_BOOKING_UNDER} — booked through the site` : `₹${SITE_BOOKING_UNDER} or more — dummy` });
  });
  return { listing, guest, order };
}

// Widen the keep lists until nothing kept depends on something deleted.
function closure(d, keep) {
  const G = new Set(nums(keep.guests)), L = new Set(nums(keep.listings)), O = new Set(nums(keep.orders));
  const H = new Set(), C = new Set();
  const isReal = (p) => p && d.pay.real.has(p);
  // Real money is always kept.
  d.orders.forEach(o => { if (isReal(o.razorpay_payment_id)) O.add(Number(o.id)); });
  d.changes.forEach(c => { if (isReal(c.razorpay_payment_id) && c.order_id) O.add(Number(c.order_id)); if (isReal(c.razorpay_payment_id) && c.guest_id) G.add(Number(c.guest_id)); });
  d.coupons.forEach(c => { if (isReal(c.razorpay_payment_id)) C.add(Number(c.id)); });
  d.penalties.forEach(p => { if (!isReal(p.razorpay_payment_id)) return; if (p.order_id) O.add(Number(p.order_id)); if (p.host_id) H.add(Number(p.host_id)); if (p.payer_guest_id) G.add(Number(p.payer_guest_id)); if (p.coupon_id) C.add(Number(p.coupon_id)); });
  d.credits.forEach(c => { if (!isReal(c.razorpay_payment_id)) return; if (c.guest_id) G.add(Number(c.guest_id)); if (c.source_order_id) O.add(Number(c.source_order_id)); });
  const hostOf = new Map(d.hosts.map(h => [Number(h.id), h]));
  const hostByGuest = new Map(d.hosts.filter(h => h.guest_id).map(h => [Number(h.guest_id), Number(h.id)]));
  const listingById = new Map(d.listings.map(l => [Number(l.id), l]));
  const orderById = new Map(d.orders.map(o => [Number(o.id), o]));
  const couponById = new Map(d.coupons.map(c => [Number(c.id), c]));
  const guestById = new Map(d.guests.map(g => [Number(g.id), g]));
  let size = -1;
  while (size !== G.size + L.size + O.size + H.size + C.size) {
    size = G.size + L.size + O.size + H.size + C.size;
    O.forEach(id => { const o = orderById.get(id); if (!o) return; if (o.listing_id) L.add(Number(o.listing_id)); if (o.guest_id) G.add(Number(o.guest_id)); if (o.coupon_id) C.add(Number(o.coupon_id)); });
    d.coupons.forEach(c => { if (O.has(Number(c.redeemed_order_id)) || O.has(Number(c.source_order_id))) C.add(Number(c.id)); });
    C.forEach(id => { const c = couponById.get(id); if (!c) return; if (c.guest_id) G.add(Number(c.guest_id)); if (c.paid_by_guest_id) G.add(Number(c.paid_by_guest_id)); if (c.issuing_host_id) H.add(Number(c.issuing_host_id)); });
    L.forEach(id => { const l = listingById.get(id); if (l && l.host_id) H.add(Number(l.host_id)); });
    H.forEach(id => { const h = hostOf.get(id); if (h && h.guest_id) G.add(Number(h.guest_id)); });
    G.forEach(id => { const g = guestById.get(id); if (g && g.host_id) H.add(Number(g.host_id)); if (hostByGuest.has(id)) H.add(hostByGuest.get(id)); });
  }
  // Only rows that exist.
  const keepIn = (set, rows) => new Set([...set].filter(id => rows.some(r => Number(r.id) === id)));
  const kG = keepIn(G, d.guests), kL = keepIn(L, d.listings), kO = keepIn(O, d.orders), kH = keepIn(H, d.hosts), kC = keepIn(C, d.coupons);
  return {
    keep: { guests: kG, listings: kL, orders: kO, hosts: kH, coupons: kC },
    del: {
      guests: d.guests.map(r => Number(r.id)).filter(id => !kG.has(id)),
      listings: d.listings.map(r => Number(r.id)).filter(id => !kL.has(id)),
      orders: d.orders.map(r => Number(r.id)).filter(id => !kO.has(id)),
      hosts: d.hosts.map(r => Number(r.id)).filter(id => !kH.has(id))
    }
  };
}

async function preview(sql) {
  const d = await load(sql);
  const src = await origins(sql, d);
  // Kept by default: made through the site — but never a "[Test]" listing
  // or a booking on one (real money is kept anyway, by the closure).
  const keepL = d.listings.filter(l => { const x = src.listing.get(Number(l.id)); return x.site && !x.test; }).map(l => Number(l.id));
  const defaults = {
    listings: keepL,
    guests: d.guests.filter(g => src.guest.get(Number(g.id)).site).map(g => Number(g.id)),
    orders: d.orders.filter(x => src.order.get(Number(x.id)).site && keepL.includes(Number(x.listing_id))).map(x => Number(x.id))
  };
  const c = closure(d, defaults);
  const realOrder = (o) => !!(o.razorpay_payment_id && d.pay.real.has(o.razorpay_payment_id));
  const bookingsOf = (field, id) => d.orders.filter(o => Number(o[field]) === id).length;
  const hostName = new Map(d.hosts.map(h => [Number(h.id), h.name || h.email]));
  return {
    environment: process.env.AERVA_ENV || process.env.VERCEL_ENV || 'unknown',
    payments: { checked: d.pay.checked, real: d.pay.real.size, liveKeys: d.pay.live, unsure: d.pay.failed },
    listings: d.listings.map(l => ({ id: Number(l.id), name: l.property_name, city: l.city, status: l.status, type: l.listing_type,
      host: hostName.get(Number(l.host_id)) || null, bookings: bookingsOf('listing_id', Number(l.id)),
      realBookings: d.orders.filter(o => Number(o.listing_id) === Number(l.id) && realOrder(o)).length,
      origin: src.listing.get(Number(l.id)).test ? 'test' : src.listing.get(Number(l.id)).site ? 'site' : 'backend', why: src.listing.get(Number(l.id)).why,
      keep: c.keep.listings.has(Number(l.id)) })),
    accounts: d.guests.map(g => ({ id: Number(g.id), name: g.name || [g.first_name, g.last_name].filter(Boolean).join(' ') || null, email: g.email, phone: g.phone,
      isHost: !!(g.host_id || d.hosts.some(h => Number(h.guest_id) === Number(g.id))), bookings: bookingsOf('guest_id', Number(g.id)),
      origin: src.guest.get(Number(g.id)).site ? 'site' : 'backend', why: src.guest.get(Number(g.id)).why,
      keep: c.keep.guests.has(Number(g.id)) })),
    bookings: d.orders.map(o => ({ id: Number(o.id), listing: (d.listings.find(l => Number(l.id) === Number(o.listing_id)) || {}).property_name || o.suite_name || null,
      guest: o.guest_email, arrival: o.arrival, departure: o.departure, total: Number(o.total) || 0, status: o.status,
      realMoney: realOrder(o), origin: src.order.get(Number(o.id)).site ? 'site' : 'backend', why: src.order.get(Number(o.id)).why,
      keep: c.keep.orders.has(Number(o.id)) })),
    remove: { accounts: c.del.guests.length, hosts: c.del.hosts.length, listings: c.del.listings.length, bookings: c.del.orders.length }
  };
}

// The keep lists after the server's closure — what the PIN is issued for.
async function settle(sql, keep) {
  const d = await load(sql);
  const c = closure(d, keep || {});
  const sorted = (set) => [...set].sort((a, b) => a - b);
  return { guests: sorted(c.keep.guests), listings: sorted(c.keep.listings), orders: sorted(c.keep.orders),
    remove: { accounts: c.del.guests.length, hosts: c.del.hosts.length, listings: c.del.listings.length, bookings: c.del.orders.length } };
}

async function clear(sql, keep) {
  const d = await load(sql);
  const c = closure(d, keep || {});
  const G = c.del.guests, L = c.del.listings, O = c.del.orders, H = c.del.hosts;
  if (!G.length && !L.length && !O.length && !H.length) return { deleted: {}, kept: sizes(c.keep), message: 'Nothing to clear.' };

  // Rows that hang off what is deleted, found before anything goes.
  const kC = [...c.keep.coupons];
  const [conv, tickets, tpls, coupons, cohosts, inqs, sacts, credits, rooms, rzpOrders] = await Promise.all([
    sql`SELECT id FROM conversations WHERE order_id = ANY(${O}) OR listing_id = ANY(${L}) OR guest_id = ANY(${G}) OR host_id = ANY(${H})
          OR inquiry_id IN (SELECT id FROM listing_inquiries WHERE guest_id = ANY(${G}) OR host_id = ANY(${H}) OR listing_id = ANY(${L}))`,
    sql`SELECT id FROM support_tickets WHERE guest_id = ANY(${G}) OR listing_id = ANY(${L}) OR order_id = ANY(${O})`,
    sql`SELECT id FROM message_templates WHERE host_id = ANY(${H}) OR listing_id = ANY(${L})`,
    sql`SELECT id FROM coupons WHERE NOT (id = ANY(${kC})) AND (guest_id = ANY(${G}) OR paid_by_guest_id = ANY(${G}) OR issuing_host_id = ANY(${H})
          OR redeemed_order_id = ANY(${O}) OR source_order_id = ANY(${O}))`,
    sql`SELECT id FROM cohosts WHERE host_id = ANY(${H}) OR cohost_guest_id = ANY(${G})`,
    sql`SELECT id FROM listing_inquiries WHERE guest_id = ANY(${G}) OR host_id = ANY(${H}) OR listing_id = ANY(${L})`,
    sql`SELECT id FROM support_actions WHERE guest_id = ANY(${G}) OR listing_id = ANY(${L}) OR order_id = ANY(${O})
          OR ticket_id IN (SELECT id FROM support_tickets WHERE guest_id = ANY(${G}) OR listing_id = ANY(${L}) OR order_id = ANY(${O}))`,
    sql`SELECT id FROM fee_credits WHERE guest_id = ANY(${G}) OR source_order_id = ANY(${O})`,
    sql`SELECT id FROM listing_rooms WHERE listing_id = ANY(${L})`,
    sql`SELECT razorpay_order_id FROM orders WHERE id = ANY(${O}) AND razorpay_order_id IS NOT NULL`
  ]);
  const CV = ids(conv), T = ids(tickets), TP = ids(tpls), C = ids(coupons), CH = ids(cohosts), INQ = ids(inqs), SA = ids(sacts), FC = ids(credits), R = ids(rooms);
  const RZ = [...new Set(rzpOrders.map(r => String(r.razorpay_order_id)))];
  const Lt = L.map(String), Ht = H.map(String);

  // Children first. One transaction: all of it or none of it.
  const steps = [
    ['messages', sql`DELETE FROM messages WHERE conversation_id = ANY(${CV})`],
    ['template_sends', sql`DELETE FROM template_sends WHERE order_id = ANY(${O}) OR template_id = ANY(${TP})`],
    ['conversations', sql`DELETE FROM conversations WHERE id = ANY(${CV})`],
    ['user_reports', sql`DELETE FROM user_reports WHERE guest_id = ANY(${G}) OR listing_id = ANY(${L}) OR order_id = ANY(${O}) OR ticket_id = ANY(${T}) OR action_id = ANY(${SA})`],
    ['support_actions', sql`DELETE FROM support_actions WHERE id = ANY(${SA})`],
    ['support_case_notes', sql`DELETE FROM support_case_notes WHERE ticket_id = ANY(${T})`],
    ['support_messages', sql`DELETE FROM support_messages WHERE ticket_id = ANY(${T})`],
    ['support_chat_messages', sql`DELETE FROM support_chat_messages WHERE ticket_id = ANY(${T}) OR guest_id = ANY(${G})`],
    ['host_cancel_confirmations', sql`DELETE FROM host_cancel_confirmations WHERE order_id = ANY(${O}) OR host_id = ANY(${H}) OR coupon_id = ANY(${C}) OR ticket_id = ANY(${T})`],
    ['support_tickets', sql`DELETE FROM support_tickets WHERE id = ANY(${T})`],
    ['listing_inquiries', sql`DELETE FROM listing_inquiries WHERE id = ANY(${INQ})`],
    ['order_amenities', sql`DELETE FROM order_amenities WHERE order_id = ANY(${O})`],
    ['order_cohost_shares', sql`DELETE FROM order_cohost_shares WHERE order_id = ANY(${O}) OR cohost_id = ANY(${CH}) OR cohost_guest_id = ANY(${G})`],
    ['cancellation_requests', sql`DELETE FROM cancellation_requests WHERE order_id = ANY(${O}) OR guest_id = ANY(${G}) OR decided_by = ANY(${G})`],
    ['booking_changes', sql`DELETE FROM booking_changes WHERE order_id = ANY(${O}) OR guest_id = ANY(${G})`],
    ['checkin_info_sends', sql`DELETE FROM checkin_info_sends WHERE order_id = ANY(${O})`],
    ['confirmation_codes', sql`DELETE FROM confirmation_codes WHERE order_id = ANY(${O})`],
    ['razorpay_fees', sql`DELETE FROM razorpay_fees WHERE order_id = ANY(${O})`],
    ['refunds', sql`DELETE FROM refunds WHERE order_id = ANY(${O})`],
    ['payouts', sql`DELETE FROM payouts WHERE order_id = ANY(${O}) OR host_id = ANY(${H}) OR payee_guest_id = ANY(${G})`],
    ['stay_disputes', sql`DELETE FROM stay_disputes WHERE order_id = ANY(${O}) OR guest_id = ANY(${G})`],
    ['guest_reviews', sql`DELETE FROM guest_reviews WHERE order_id = ANY(${O}) OR guest_id = ANY(${G}) OR host_id = ANY(${H}) OR listing_id = ANY(${L})`],
    ['listing_reviews', sql`DELETE FROM listing_reviews WHERE order_id = ANY(${O}) OR guest_id = ANY(${G}) OR host_id = ANY(${H}) OR listing_id = ANY(${L})`],
    ['host_penalties', sql`DELETE FROM host_penalties WHERE order_id = ANY(${O}) OR host_id = ANY(${H}) OR cohost_id = ANY(${CH}) OR coupon_id = ANY(${C}) OR payer_guest_id = ANY(${G})`],
    ['fee_credit_entries', sql`DELETE FROM fee_credit_entries WHERE credit_id = ANY(${FC}) OR order_id = ANY(${O})`],
    ['fee_credit_uses', sql`DELETE FROM fee_credit_uses WHERE credit_id = ANY(${FC}) OR order_id = ANY(${O})`],
    ['fee_credits', sql`DELETE FROM fee_credits WHERE id = ANY(${FC})`],
    ['payment_confirmations', sql`DELETE FROM payment_confirmations WHERE razorpay_order_id = ANY(${RZ})`],
    ['scheduled_refunds', sql`DELETE FROM scheduled_refunds WHERE razorpay_order_id = ANY(${RZ})`],
    // Orders and coupons point at each other: unlink, then delete both.
    ['orders (coupon links)', sql`UPDATE orders SET coupon_id = NULL WHERE id = ANY(${O}) AND coupon_id IS NOT NULL`],
    ['coupons', sql`DELETE FROM coupons WHERE id = ANY(${C})`],
    ['orders', sql`DELETE FROM orders WHERE id = ANY(${O})`],
    ['cohosts', sql`DELETE FROM cohosts WHERE id = ANY(${CH})`],
    ['cohost_payout_profiles', sql`DELETE FROM cohost_payout_profiles WHERE guest_id = ANY(${G})`],
    ['listing_blocked_dates', sql`DELETE FROM listing_blocked_dates WHERE listing_id = ANY(${L}) OR room_id = ANY(${R})`],
    ['listing_promotions', sql`DELETE FROM listing_promotions WHERE listing_id = ANY(${L}) OR room_id = ANY(${R})`],
    ['calendar_feeds', sql`DELETE FROM calendar_feeds WHERE listing_id = ANY(${L}) OR room_id = ANY(${R})`],
    ['listing_amenities', sql`DELETE FROM listing_amenities WHERE listing_id = ANY(${L})`],
    ['listing_custom_fields', sql`DELETE FROM listing_custom_fields WHERE listing_id = ANY(${L})`],
    ['listing_guest_blocks', sql`DELETE FROM listing_guest_blocks WHERE listing_id = ANY(${L}) OR guest_id = ANY(${G})`],
    ['listing_likes', sql`DELETE FROM listing_likes WHERE listing_id = ANY(${L}) OR guest_id = ANY(${G})`],
    ['guest_favorites', sql`DELETE FROM guest_favorites WHERE listing_id = ANY(${L}) OR guest_id = ANY(${G})`],
    ['compliance_flags', sql`DELETE FROM compliance_flags WHERE listing_id = ANY(${L})`],
    ['price_history', sql`DELETE FROM price_history WHERE listing_id = ANY(${L})`],
    ['price_reviews', sql`DELETE FROM price_reviews WHERE listing_id = ANY(${L})`],
    ['photo_locations', sql`DELETE FROM photo_locations WHERE listing_id = ANY(${L})`],
    ['photo_removals', sql`DELETE FROM photo_removals WHERE listing_id = ANY(${L}) OR guest_id = ANY(${G})`],
    ['host_agreement_acceptances', sql`DELETE FROM host_agreement_acceptances WHERE listing_id = ANY(${L}) OR host_id = ANY(${H}) OR guest_id = ANY(${G})`],
    ['booking_holds', sql`DELETE FROM booking_holds WHERE listing_id = ANY(${L})`],
    ['checkout_carts', sql`DELETE FROM checkout_carts WHERE guest_id = ANY(${G})`],
    ['message_templates', sql`DELETE FROM message_templates WHERE id = ANY(${TP})`],
    ['listing_rooms', sql`DELETE FROM listing_rooms WHERE id = ANY(${R})`],
    // A kept listing cloned from, or hosted at, a deleted one forgets that link.
    ['listings (links)', sql`UPDATE listings SET cloned_from_listing_id = CASE WHEN cloned_from_listing_id = ANY(${L}) THEN NULL ELSE cloned_from_listing_id END,
                                              hosting_listing_id = CASE WHEN hosting_listing_id = ANY(${L}) THEN NULL ELSE hosting_listing_id END
                             WHERE NOT (id = ANY(${L})) AND (cloned_from_listing_id = ANY(${L}) OR hosting_listing_id = ANY(${L}))`],
    ['listings', sql`DELETE FROM listings WHERE id = ANY(${L})`],
    ['fee_rate_notices', sql`DELETE FROM fee_rate_notices WHERE host_id = ANY(${H})`],
    ['tier_current', sql`DELETE FROM tier_current WHERE (subject_type = 'host' AND subject_id::text = ANY(${Ht})) OR (subject_type = 'listing' AND subject_id::text = ANY(${Lt}))`],
    ['tier_history', sql`DELETE FROM tier_history WHERE (subject_type = 'host' AND subject_id::text = ANY(${Ht})) OR (subject_type = 'listing' AND subject_id::text = ANY(${Lt}))`],
    ['hosts', sql`DELETE FROM hosts WHERE id = ANY(${H})`],
    ['offer_email_sends', sql`DELETE FROM offer_email_sends WHERE guest_id = ANY(${G})`],
    ['guests', sql`DELETE FROM guests WHERE id = ANY(${G})`]
  ];
  // Co-hosts' requests that the host cover a coupon (_cohost-coupon.js), once
  // their database update has run: they go with their booking, host or co-host.
  try {
    if ((await sql`SELECT to_regclass('public.cohost_coupon_requests') AS t`)[0].t) {
      steps.unshift(['cohost_coupon_requests', sql`DELETE FROM cohost_coupon_requests WHERE order_id = ANY(${O}) OR host_id = ANY(${H}) OR cohost_guest_id = ANY(${G})`]);
    }
  } catch (e) { /* table not there: nothing to remove */ }
  // RETURNING counts would need every statement rewritten; count first instead.
  const before = await counts(sql);
  try {
    await sql.transaction(steps.map(s => s[1]));
  } catch (err) {
    throw userError('Nothing was deleted — the clear was rolled back. ' + String(err && err.message || err).slice(0, 300), 500);
  }
  const after = await counts(sql);
  const deleted = {};
  Object.keys(before).forEach(t => { const n = before[t] - (after[t] || 0); if (n > 0) deleted[t] = n; });
  return { deleted, kept: sizes(c.keep),
    keptIds: { guests: [...c.keep.guests], listings: [...c.keep.listings], orders: [...c.keep.orders], hosts: [...c.keep.hosts] } };
}

const sizes = (k) => ({ accounts: k.guests.size, hosts: k.hosts.size, listings: k.listings.size, bookings: k.orders.size, coupons: k.coupons.size });

// Row counts of every table the clear touches (for the report).
const TABLES = ['messages', 'template_sends', 'conversations', 'user_reports', 'support_actions', 'support_case_notes', 'support_messages', 'support_chat_messages',
  'host_cancel_confirmations', 'support_tickets', 'listing_inquiries', 'order_amenities', 'order_cohost_shares', 'cancellation_requests', 'booking_changes',
  'checkin_info_sends', 'confirmation_codes', 'razorpay_fees', 'refunds', 'payouts', 'stay_disputes', 'guest_reviews', 'listing_reviews', 'host_penalties',
  'fee_credit_entries', 'fee_credit_uses', 'fee_credits', 'payment_confirmations', 'scheduled_refunds', 'orders', 'coupons', 'cohosts', 'cohost_payout_profiles',
  'listing_blocked_dates', 'listing_promotions', 'calendar_feeds', 'listing_amenities', 'listing_custom_fields', 'listing_guest_blocks', 'listing_likes',
  'guest_favorites', 'compliance_flags', 'price_history', 'price_reviews', 'photo_locations', 'photo_removals', 'host_agreement_acceptances', 'booking_holds',
  'checkout_carts', 'message_templates', 'listing_rooms', 'listings', 'fee_rate_notices', 'tier_current', 'tier_history', 'hosts', 'offer_email_sends', 'guests'];
async function counts(sql) {
  const q = TABLES.map(t => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(' UNION ALL ');
  const rows = typeof sql.query === 'function' ? await sql.query(q) : await sql(q);
  const out = {};
  (Array.isArray(rows) ? rows : rows.rows || []).forEach(r => { out[r.t] = r.n; });
  return out;
}

// ---- "From the beginning" ----
// Tables never emptied. Everything else in the database is.
const KEEP_TABLES = ['admins', 'admin_audit_log', 'audit_log', 'site_settings', 'fee_rates', 'host_agreement_versions', 'schema_migrations', 'job_runs', 'job_run_log'];
// Going live (owner, 9 Nov 2026): nothing from before launch day is kept —
// the logs are emptied too. Only the admin accounts (and the site's own
// settings, fee rates, agreement texts and database-update record, which
// are configuration, not history) remain.
const LOG_TABLES = ['admin_audit_log', 'audit_log', 'job_runs', 'job_run_log'];
async function allTables(sql, { includeLogs = false } = {}) {
  const keep = includeLogs ? KEEP_TABLES.filter(t => !LOG_TABLES.includes(t)) : KEEP_TABLES;
  const rows = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  return rows.map(r => r.tablename).filter(t => !keep.includes(t) && /^[a-z_][a-z0-9_]*$/.test(t));
}
async function previewAll(sql, opts = {}) {
  const tables = await allTables(sql, opts);
  const q = tables.map(t => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(' UNION ALL ');
  const rows = tables.length ? (typeof sql.query === 'function' ? await sql.query(q) : await sql(q)) : [];
  const list = (Array.isArray(rows) ? rows : rows.rows || []).filter(r => r.n > 0).sort((a, b) => b.n - a.n);
  return { tables: list.map(r => ({ table: r.t, rows: r.n })), total: list.reduce((a, r) => a + r.n, 0),
    kept: opts.includeLogs ? KEEP_TABLES.filter(t => !LOG_TABLES.includes(t)) : KEEP_TABLES };
}
async function clearAll(sql, opts = {}) {
  const before = await previewAll(sql, opts);
  const tables = await allTables(sql, opts);
  if (!tables.length) return { deleted: {} };
  const q = (text) => (typeof sql.query === 'function' ? sql.query(text) : sql(text));
  const steps = [];
  // admin_audit_log is append-only (a trigger refuses DELETE / TRUNCATE).
  // Going live is the one time it is emptied (owner, 9 Nov 2026): the
  // guard is lifted for this statement only and put straight back, in the
  // same transaction — if anything fails, the guard was never off.
  const guarded = tables.includes('admin_audit_log');
  if (guarded) steps.push(q('ALTER TABLE admin_audit_log DISABLE TRIGGER admin_audit_log_no_truncate'));
  steps.push(q(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY`));
  if (guarded) steps.push(q('ALTER TABLE admin_audit_log ENABLE TRIGGER admin_audit_log_no_truncate'));
  try { await sql.transaction(steps); }
  catch (err) { throw userError('Nothing was deleted — ' + String(err && err.message || err).slice(0, 300), 500); }
  const deleted = {};
  before.tables.forEach(r => { deleted[r.table] = r.rows; });
  return { deleted };
}

module.exports = { preview, settle, clear, previewAll, clearAll, closure, TABLES, KEEP_TABLES, LOG_TABLES };
