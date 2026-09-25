// /api/_accounts.js — deleting an account. Not an endpoint.
//
// A guest or host deletes their account (guest-profile.js mode
// 'deleteAccount'). Refused while anything is still open: an upcoming or
// current stay (as guest), upcoming bookings on their listings, payouts
// not yet sent, or cancellation coupons owed. Otherwise their personal
// data is erased: name, email, phone, photo, ID proof, profile, sign-in, PAN, bank,
// GSTIN, co-host links and payout details, message text, review text (star
// ratings stay), reviews written about them, templates, calendar links, and
// their listings' photos, address, map position and check-in details; the
// listings are removed. Booking and payment amounts stay (tax and accounting
// records) without personal details. The admin audit log is kept.
// Only deletion erases data: deactivating a listing or hosting keeps it all. The account can never sign in or act again
// (isAccountDeleted, checked on every request that uses a session).

const DELETED_NAME = 'Deleted user';

async function isAccountDeleted(sql, guestId) {
  if (!guestId) return false;
  try {
    const r = await sql`SELECT deleted_at FROM guests WHERE id = ${guestId}`;
    return !!(r[0] && r[0].deleted_at);
  } catch (err) { return false; } // before migration_account_status.sql
}

// What still stops this account being deleted (empty = none).
async function deletionBlockers(sql, guestId) {
  const me = (await sql`SELECT id, host_id FROM guests WHERE id = ${guestId}`)[0];
  if (!me) return ['Account not found.'];
  const blockers = [];
  const asGuest = await sql`
    SELECT count(*)::int AS n FROM orders o JOIN listings l ON l.id = o.listing_id
    WHERE o.guest_id = ${guestId} AND o.status = 'paid'
      AND o.departure >= (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date`;
  if (asGuest[0].n) blockers.push(`You have ${asGuest[0].n} upcoming or current stay${asGuest[0].n === 1 ? '' : 's'}.`);
  if (me.host_id) {
    const asHost = await sql`
      SELECT count(*)::int AS n FROM orders o JOIN listings l ON l.id = o.listing_id
      WHERE l.host_id = ${me.host_id} AND o.status = 'paid'
        AND o.departure >= (now() AT TIME ZONE COALESCE(NULLIF(btrim(l.timezone), ''), 'Asia/Kolkata'))::date`;
    if (asHost[0].n) blockers.push(`Your listings have ${asHost[0].n} upcoming booking${asHost[0].n === 1 ? '' : 's'}.`);
  }
  const optional = async (q) => { try { return (await q)[0].n; } catch (e) { return 0; } };
  const payouts = await optional(sql`SELECT count(*)::int AS n FROM payouts WHERE status IN ('due', 'processing', 'failed')
                                     AND ((payee_type = 'host' AND host_id = ${me.host_id || 0}) OR (payee_type = 'cohost' AND payee_guest_id = ${guestId}))`);
  if (payouts) blockers.push('You have payouts that have not been sent yet.');
  const owed = await optional(sql`SELECT count(*)::int AS n FROM host_penalties WHERE status = 'owed'
                                  AND ((host_id = ${me.host_id || 0} AND payer_guest_id IS NULL) OR payer_guest_id = ${guestId})`);
  if (owed) blockers.push('You owe cancellation coupons.');
  return blockers;
}

async function blobUrlsOf(sql, guestId, hostId) {
  const urls = new Set();
  const scan = (v) => { (JSON.stringify(v || '').match(/https:\/\/[^"\s\\]+\.blob\.vercel-storage\.com\/[^"\s\\]+/g) || []).forEach(u => urls.add(u)); };
  scan((await sql`SELECT profile_photo_url FROM guests WHERE id = ${guestId}`)[0]);
  if (hostId) {
    // Every photo anywhere in the host's listings and rooms (whatever the field).
    scan(await sql`SELECT * FROM listings WHERE host_id = ${hostId}`);
    try { scan(await sql`SELECT r.* FROM listing_rooms r JOIN listings l ON l.id = r.listing_id WHERE l.host_id = ${hostId}`); } catch (e) { /* no rooms table */ }
  }
  return [...urls];
}

// Erase. Returns { ok, blockers? }.
async function deleteAccount(sql, guestId) {
  const blockers = await deletionBlockers(sql, guestId);
  if (blockers.length) return { ok: false, blockers };
  const me = (await sql`SELECT id, host_id FROM guests WHERE id = ${guestId}`)[0];
  const hostId = me.host_id || null;
  const placeholderEmail = `deleted-${guestId}@deleted.aerva.in`;
  const tryRun = async (label, q) => { try { await q; } catch (e) { console.error('deleteAccount step skipped:', label, e.message); } };

  // Photos in storage (profile and listings), and the guest's ID proof
  // (stored encrypted, so it is read back to find the file): best effort.
  const urls = await blobUrlsOf(sql, guestId, hostId);
  try {
    const idRow = (await sql`SELECT id_document_url FROM guests WHERE id = ${guestId}`)[0];
    const idUrl = idRow && idRow.id_document_url ? require('./_secure-fields').decryptField(idRow.id_document_url) : null;
    if (idUrl) urls.push(idUrl);
  } catch (e) { /* before migration_trust_rules.sql */ }
  if (urls.length && process.env.BLOB_READ_WRITE_TOKEN) {
    try { await require('@vercel/blob').del(urls); } catch (e) { console.error('photo deletion failed:', e.message); }
  }

  // Messages they wrote, templates, co-host links and payout details.
  await tryRun('guest messages', sql`UPDATE messages m SET original_text = '[deleted]', display_text = '[deleted]'
    FROM conversations c WHERE m.conversation_id = c.id AND c.guest_id = ${guestId} AND m.sender_type = 'guest'`);
  if (hostId) await tryRun('host messages', sql`UPDATE messages m SET original_text = '[deleted]', display_text = '[deleted]'
    FROM conversations c WHERE m.conversation_id = c.id AND c.host_id = ${hostId} AND m.sender_type = 'host'`);
  await tryRun('templates', sql`DELETE FROM message_templates WHERE host_id = ${guestId}`);
  await tryRun('co-host links', sql`UPDATE cohosts SET status = 'removed', removed_at = now(), invited_email = ${placeholderEmail}
    WHERE (cohost_guest_id = ${guestId} OR host_id = ${hostId || 0}) AND status <> 'removed'`);
  await tryRun('co-host payout details', sql`DELETE FROM cohost_payout_profiles WHERE guest_id = ${guestId}`);
  await tryRun('cancellation request details', sql`UPDATE cancellation_requests SET details = NULL WHERE guest_id = ${guestId}`);

  // Bookings they made: amounts stay (tax records), personal details go.
  await sql`UPDATE orders SET guest_email = ${placeholderEmail} WHERE guest_id = ${guestId}`;
  await tryRun('conversation emails', sql`UPDATE conversations SET guest_email = ${placeholderEmail} WHERE guest_id = ${guestId}`);
  // Reviews: the text they wrote goes; star ratings stay (listing standing).
  // Reviews written ABOUT them (by hosts) are removed.
  await tryRun('review text', sql`UPDATE listing_reviews SET comment = NULL WHERE guest_id = ${guestId}`);
  await tryRun('reviews about them', sql`DELETE FROM guest_reviews WHERE guest_id = ${guestId}`);
  // Payout records keep the amounts; the payee's name and account go.
  await tryRun('payout names', sql`UPDATE payouts SET bank_label = NULL WHERE payee_guest_id = ${guestId} OR (payee_type = 'host' AND host_id = ${hostId || 0})`);

  if (hostId) {
    await tryRun('calendar links', sql`DELETE FROM calendar_feeds WHERE listing_id IN (SELECT id FROM listings WHERE host_id = ${hostId})`);
    await tryRun('check-in details', sql`DELETE FROM listing_custom_fields WHERE listing_id IN (SELECT id FROM listings WHERE host_id = ${hostId})`);
    await tryRun('room photos', sql`UPDATE listing_rooms SET cover_photo_url = NULL, photo_urls = NULL, pending_changes = NULL
      WHERE listing_id IN (SELECT id FROM listings WHERE host_id = ${hostId})`);
    // Where the property is and every other photo field (separate, in case a column is missing).
    await tryRun('listing location', sql`UPDATE listings SET formatted_address = NULL, latitude = NULL, longitude = NULL, area = NULL WHERE host_id = ${hostId}`);
    await tryRun('experience meeting point', sql`UPDATE listings SET experience_meeting_point_address = NULL, experience_meeting_point_lat = NULL, experience_meeting_point_lng = NULL WHERE host_id = ${hostId}`);
    await tryRun('other photos', sql`UPDATE listings SET photos = NULL, photo_hashes = NULL, pending_room_photos = NULL WHERE host_id = ${hostId}`);
    await sql`UPDATE listings SET status = 'removed', host_name = 'Deleted host', host_email = ${placeholderEmail}, host_phone = '',
                cover_photo_url = NULL, photo_urls = NULL, exterior_photo_urls = NULL, interior_photo_urls = NULL, checkin_photos = '[]'::jsonb,
                wifi_name = NULL, wifi_password = NULL, access_code = NULL
              WHERE host_id = ${hostId}`;
    await sql`UPDATE hosts SET name = 'Deleted host', email = ${placeholderEmail}, phone = NULL, phone_country_code = NULL, phone_otp_hash = NULL,
                aadhaar_document_url = NULL, pan_document_url = NULL, pan_number = NULL, bank_account_number = NULL, bank_ifsc = NULL,
                bank_account_holder_name = NULL, aadhaar_rejection_reason = NULL, bank_rejection_reason = NULL, pan_rejection_reason = NULL
              WHERE id = ${hostId}`;
    await tryRun('hosting status', sql`UPDATE hosts SET hosting_status = 'deleted', razorpayx_fund_account_id = NULL WHERE id = ${hostId}`);
  }
  await sql`UPDATE guests SET name = ${DELETED_NAME}, email = ${placeholderEmail}, phone = NULL, password_hash = NULL, google_id = NULL,
              profile_photo_url = NULL, profile_work = NULL, profile_hobbies = NULL, profile_about = NULL, email_verified = false
            WHERE id = ${guestId}`;
  await tryRun('ID proof', sql`UPDATE guests SET id_document_url = NULL, id_document_type = NULL, id_status = NULL, id_rejection_reason = NULL WHERE id = ${guestId}`);
  await tryRun('stay dispute text', sql`UPDATE stay_disputes SET details = NULL, evidence = '[]'::jsonb WHERE guest_id = ${guestId}`);
  await tryRun('mark deleted', sql`UPDATE guests SET deleted_at = now() WHERE id = ${guestId}`);
  return { ok: true };
}

// Logging in un-pauses an account that was paused (guest-profile.js,
// mode 'deactivateAccount'): the person is back, so their account and the
// listings hidden with it come back too. Only listings hidden BY the pause
// are restored — one deactivated on its own stays that way. Never throws:
// a login must not fail because this could not run.
async function reactivateIfPaused(sql, guestId) {
  try {
    const back = await sql`UPDATE guests SET account_status = NULL, deactivated_at = NULL
                           WHERE id = ${guestId} AND account_status = 'deactivated' RETURNING host_id`;
    if (!back.length) return { reactivated: false };
    const hostId = back[0].host_id;
    let restored = [];
    if (hostId) {
      restored = await sql`UPDATE listings SET status = 'approved', deactivated_by = NULL, deactivated_at = NULL
                           WHERE host_id = ${hostId} AND status = 'deactivated' AND deactivated_by = 'hosting' RETURNING id`;
      try { await sql`UPDATE hosts SET hosting_status = 'active' WHERE id = ${hostId}`; } catch (e) { /* column not added yet */ }
    }
    return { reactivated: true, listingsRestored: restored.length };
  } catch (err) {
    console.error('reactivateIfPaused failed (non-fatal):', err.message);
    return { reactivated: false };
  }
}

module.exports = { isAccountDeleted, deletionBlockers, deleteAccount, reactivateIfPaused, DELETED_NAME };
