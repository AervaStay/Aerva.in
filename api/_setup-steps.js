// /api/_setup-steps.js — the steps a host or a guest still has to take,
// in ONE fixed order (owner, 9 Nov 2026). Not an endpoint.
//
// Hosts: list the property, then Aadhaar → bank account → PAN, then the
// rest. Each can be skipped for now; anything still to do is shown, in the
// same order, on the dashboard ("Getting set up"), in the profile's
// Verification tab, and in the bell. The aim: a host listed and sorted in
// about 10 minutes, a guest in under 5 — every step one clear action.
// Guests: confirm email → name → phone → profile photo (optional).

const V = 'host-dashboard.html?openProfile=1&profileTab=verification';

async function hostSteps(sql, accountId) {
  const g = (await sql`SELECT id, host_id, profile_photo_url, profile_about FROM guests WHERE id = ${accountId}`)[0];
  if (!g || !g.host_id) return [];
  const h = (await sql`SELECT phone_verified, aadhaar_status, pan_status, bank_status, host_agreement_version FROM hosts WHERE id = ${g.host_id}`)[0] || {};
  const l = (await sql`SELECT count(*) FILTER (WHERE status = 'approved')::int AS live, count(*) FILTER (WHERE status = 'pending')::int AS pending,
                              count(*) FILTER (WHERE status = 'draft')::int AS drafts FROM listings WHERE host_id = ${g.host_id}`)[0] || {};
  let about = g.profile_about; if (typeof about === 'string') { try { about = JSON.parse(about); } catch (e) { about = {}; } }
  return [
    { key: 'listing', label: 'List your property', why: 'Photos, price and house rules — Aerva reviews it before it goes live.', done: Number(l.live) > 0, waiting: Number(l.pending) > 0,
      waitingText: 'Submitted — Aerva is reviewing it', href: 'index.html?view=list-property' },
    { key: 'identity', label: 'Verify your identity (Aadhaar)', why: 'Required before your listing goes live and before any payout.', done: h.aadhaar_status === 'verified', waiting: h.aadhaar_status === 'pending_review', waitingText: 'Sent — waiting for Aerva', href: V },
    { key: 'bank', label: 'Add your bank account for payouts', why: 'Where your earnings are paid, the day after each check-in.', done: h.bank_status === 'verified', waiting: h.bank_status === 'pending_review', waitingText: 'Added — being verified', href: 'host-payouts.html' },
    { key: 'pan', label: 'Add your PAN', why: 'Optional: without it TDS is 5% of each payout instead of 0.1%.', optional: true, done: h.pan_status === 'verified', waiting: h.pan_status === 'pending_review', waitingText: 'Sent — being checked', href: V },
    { key: 'phone', label: 'Verify your phone number', why: 'So guests and Aerva can reach you about a booking.', done: !!h.phone_verified, href: V },
    { key: 'profile', label: 'Add a photo and a few lines about you', why: 'Guests book hosts they can put a face to.', optional: true, done: !!(g.profile_photo_url && about && String(about.about_me || '').trim()), href: 'host-dashboard.html?openProfile=1' }
  ];
}

async function guestSteps(sql, guestId) {
  const g = (await sql`SELECT id, phone, profile_photo_url, email_verified, to_jsonb(guests)->>'email_verified_at' AS email_verified_at,
                              to_jsonb(guests)->>'first_name' AS first_name, to_jsonb(guests)->>'last_name' AS last_name, name
                       FROM guests WHERE id = ${guestId}`)[0];
  if (!g) return [];
  return [
    { key: 'email', label: 'Confirm your email', why: 'Booking confirmations and receipts go there.', done: !!(g.email_verified || g.email_verified_at), href: 'index.html?view=profile' },
    { key: 'name', label: 'Add your first and last name', why: 'As on your government ID — the host checks it at check-in.', done: !!(String(g.first_name || '').trim() && String(g.last_name || '').trim()), href: 'index.html?view=profile' },
    { key: 'phone', label: 'Add your phone number', why: 'Your host uses it to reach you about the stay.', done: !!String(g.phone || '').trim(), href: 'index.html?view=profile' },
    { key: 'photo', label: 'Add a profile photo', why: 'Optional — hosts like to know who is coming.', optional: true, done: !!g.profile_photo_url, href: 'index.html?view=profile' }
  ];
}

// One bell item: the next step, and how many are left (required ones first).
function bellItem(steps, role) {
  const left = steps.filter(s => !s.done && !s.waiting);
  const req = left.filter(s => !s.optional);
  if (!req.length) return null;
  const next = req[0];
  return { id: `setup:${role}:${next.key}:${req.length}`, kind: 'action',
    title: role === 'host' ? `Finish setting up: ${next.label}` : `Complete your account: ${next.label}`,
    body: `${next.why} ${req.length > 1 ? `${req.length - 1} more step${req.length - 1 === 1 ? '' : 's'} after this.` : 'Last step.'}`,
    href: next.href };
}

module.exports = { hostSteps, guestSteps, bellItem };
