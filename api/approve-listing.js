// /api/approve-listing.js
// Three ways in:
//   GET  ?token=...(action=approve)  — clicked "Approve" in the admin
//                                       email. Shows a confirmation page
//                                       with one button; nothing changes
//                                       until that button POSTs back
//                                       (mail scanners open links, they
//                                       don't press buttons).
//   GET  ?token=...(action=reject)   — clicked "Reject" in the admin
//                                       email. Shows a short form asking
//                                       for a reason FIRST — rejection
//                                       isn't finalized until that's
//                                       submitted (see the POST-with-token
//                                       path below).
//   POST { token, reason }           — submitted from that reason form.
//                                       Finalizes the rejection and emails
//                                       the host with the specific reason.
//   POST { token } (approve token)   — the confirmation page's button.
//
// Every one of these acts ONLY on a listing that is still pending. An
// emailed link stays valid for 7 days, so without that check an old link
// could approve a listing an admin had since rejected (or reject a live
// one), any number of times.
//   POST { listingId, action, reason? } with header x-admin-secret
//                                     — clicked a button on admin.html
//                                       instead. reason is optional here.
//
// On approval, this also emails the host a long-lived link to manage their
// own listing's price and discount going forward (manage-listing.html) —
// best-effort, same pattern as the admin notification email in
// submit-listing.js: if RESEND_API_KEY isn't set, it's skipped quietly
// rather than failing the approval/rejection itself.

const { neon } = require('@neondatabase/serverless');
const { verifyToken, createToken, secretMatches } = require('./_approval-token');
const { logAudit, adminContext, requestContext } = require('./_audit-log');
const { sanitizeBody } = require('./_plain-text');
const { countRecentAttempts, getClientIp } = require('./_rate-limit');
const { findNameClashInPincode } = require('./_listing-rules');

const sql = neon(process.env.DATABASE_URL);

const SITE_BASE = 'https://aerva.in';
// Distinct from SITE_BASE — see the note in submit-listing.js. This file
// IS the API, so its own self-referencing links (the reason form's submit
// target) need to point here, not at the static frontend.
const API_BASE = 'https://aerva-in.vercel.app';
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

// Everything dropped into the pages below is escaped: a property name is
// host-typed text, and these pages are opened by an admin.
function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// title and message are plain text.
function htmlPage(title, message, isError) {
  title = esc(title); message = esc(message);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="robots" content="noindex"><title>${title}</title>
  <style>
    body{font-family:'Jost',sans-serif;background:#f4eadc;color:#1c1a17;
      display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}
    .box{max-width:420px;padding:40px;}
    h1{font-family:'Bodoni Moda',serif;font-size:24px;margin-bottom:12px;color:${isError ? '#a3402f' : '#1c1a17'};}
    p{opacity:0.75;line-height:1.6;}
  </style></head>
  <body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

// The reason-entry page shown when an admin clicks "Reject" — rejection
// only actually happens once this form is submitted, not on the initial
// click. Self-contained: submits via fetch to this same endpoint (POST
// with the token), then swaps in a confirmation message inline.
function rejectionReasonPage(listing, token) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Reject Listing</title>
  <style>
    body{font-family:'Jost',sans-serif;background:#f4eadc;color:#1c1a17;
      display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box;}
    .box{max-width:440px;width:100%;}
    h1{font-family:'Bodoni Moda',serif;font-size:24px;margin-bottom:8px;}
    .subtitle{opacity:0.7;line-height:1.6;margin-bottom:24px;font-size:14px;}
    label{font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#8a7f6c;display:block;margin-bottom:6px;}
    textarea{width:100%;box-sizing:border-box;background:white;border:1px solid #ddd0bc;padding:12px;
      font-family:'Jost',sans-serif;font-size:15px;color:#1c1a17;min-height:110px;resize:vertical;}
    .btn{background:#a3402f;color:#f4eadc;border:none;padding:14px 28px;font-size:12px;
      letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;width:100%;margin-top:16px;}
    .btn:disabled{opacity:0.5;cursor:default;}
    .error{font-size:13px;color:#a3402f;margin-top:12px;display:none;}
    .confirm{font-size:15px;line-height:1.7;display:none;}
  </style></head>
  <body><div class="box">
    <div id="formState">
      <h1>Reject "${esc(listing.property_name)}"</h1>
      <p class="subtitle">This note goes directly to the host by email, so please make it specific and actionable — e.g. "Exterior photos are too dark, please retake in daylight" rather than just "photos need work."</p>
      <label for="reason">Reason for the host</label>
      <textarea id="reason" placeholder="What needs to change before this can be approved?"></textarea>
      <p class="error" id="reasonError">Please enter a reason before rejecting — the host needs to know what to fix.</p>
      <button class="btn" id="submitBtn">Reject &amp; Notify Host</button>
    </div>
    <div id="confirmState" class="confirm">
      <h1>Listing rejected</h1>
      <p>"${esc(listing.property_name)}" has been marked as rejected, and the host has been emailed the reason.</p>
    </div>
  </div>
  <script>
    document.getElementById('submitBtn').addEventListener('click', async function(){
      var reasonEl = document.getElementById('reason');
      var errorEl = document.getElementById('reasonError');
      var reason = reasonEl.value.trim();
      if(!reason){
        errorEl.style.display = 'block';
        return;
      }
      errorEl.style.display = 'none';
      this.disabled = true;
      this.textContent = 'Submitting…';
      try{
        var res = await fetch('${API_BASE}/api/approve-listing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: ${JSON.stringify(String(token))}, reason: reason })
        });
        if(res.ok){
          document.getElementById('formState').style.display = 'none';
          document.getElementById('confirmState').style.display = 'block';
        } else {
          var data = await res.json();
          errorEl.textContent = data.error || 'Something went wrong. Please try again.';
          errorEl.style.display = 'block';
          this.disabled = false;
          this.textContent = 'Reject & Notify Host';
        }
      } catch(err){
        errorEl.textContent = 'Something went wrong. Please try again.';
        errorEl.style.display = 'block';
        this.disabled = false;
        this.textContent = 'Reject & Notify Host';
      }
    });
  </script>
  </body></html>`;
}

// The page an emailed "Approve" link opens. Approving needs this button:
// a GET must never change anything, because mail scanners and link
// previews open every link in an email before the admin does.
function approveConfirmPage(listing, token) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="robots" content="noindex"><title>Approve Listing</title>
  <style>
    body{font-family:'Jost',sans-serif;background:#f4eadc;color:#1c1a17;
      display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box;text-align:center;}
    .box{max-width:440px;width:100%;}
    h1{font-family:'Bodoni Moda',serif;font-size:24px;margin-bottom:8px;}
    p{opacity:0.75;line-height:1.6;}
    .btn{background:#1c1a17;color:#f4eadc;border:none;padding:14px 28px;font-size:12px;
      letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;width:100%;margin-top:16px;}
  </style></head>
  <body><div class="box">
    <h1>Approve "${esc(listing.property_name)}"?</h1>
    <p>The listing goes live for guests at once and the host is emailed.</p>
    <form method="POST" action="${API_BASE}/api/approve-listing">
      <input type="hidden" name="token" value="${esc(token)}">
      <button class="btn" type="submit">Approve &amp; Go Live</button>
    </form>
  </div></body></html>`;
}

async function sendHostApprovalEmail(listing, { needsRoomSetup = false } = {}) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping host approval email.');
    return;
  }
  const manageToken = createToken(listing.id, 'manage-pricing', TWO_YEARS_MS);
  const manageLink = `${SITE_BASE}/manage-listing.html?token=${manageToken}`;

  // "Aerva Host" status is awarded the moment a host has at least one
  // approved listing (see host-listings.js, which computes this the same
  // way for the dashboard). Only call it out here the first time it
  // actually happens — a host's second, third, etc. approval is still
  // good news, just not a new milestone worth re-announcing.
  let isFirstApproval = false;
  if (listing.host_id) {
    const approvedCount = await sql`
      SELECT COUNT(*)::int AS count FROM listings WHERE host_id = ${listing.host_id} AND status = 'approved'
    `;
    isFirstApproval = approvedCount[0].count === 1;
  }

  const badgeAnnouncement = isFirstApproval ? `
      <div style="background:#faf3e6; border:1px solid #ddc9a3; padding:16px 20px; margin:20px 0; border-radius:4px;">
        <p style="margin:0; font-size:13px; letter-spacing:0.06em; text-transform:uppercase; color:#8a6c39;">New status unlocked</p>
        <p style="margin:6px 0 0; font-size:16px; font-family:Georgia,serif;">You're now an <strong>Aerva Host</strong> 🎉</p>
      </div>
  ` : '';

  // needsRoomSetup is only ever true now if something's genuinely
  // incomplete (an older listing that predates submission requiring a
  // real price/occupancy per bedroom, or a Resort declared with zero
  // rooms) — a normal Resort submission already provided everything
  // needed for its rooms to go live immediately on approval, so this
  // warning shouldn't show for the common case anymore.
  const resortRoomsReminder = needsRoomSetup ? `
      <div style="background:#fdf1ea; border:1px solid #e3b892; padding:16px 20px; margin:20px 0; border-radius:4px;">
        <p style="margin:0; font-size:13px; letter-spacing:0.06em; text-transform:uppercase; color:#a3402f;">One more step for your Resort</p>
        <p style="margin:6px 0 0; font-size:14px;">Guests can't book yet — you still need to add your rooms (each with its own price, capacity, and photo) using the link below. Until you do, your listing page will show "no rooms set up yet."</p>
      </div>
  ` : (listing.property_type === 'Resort' ? `
      <div style="background:#faf3e6; border:1px solid #ddc9a3; padding:16px 20px; margin:20px 0; border-radius:4px;">
        <p style="margin:0; font-size:14px;">Your rooms are already set up and bookable, using the details you provided at submission. Head to the link below anytime you want to update a room's price or add more.</p>
      </div>
  ` : '');

  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">Your listing is live on Aerva</h2>
      <p><strong>${esc(listing.property_name)}</strong> is now approved and visible to guests.</p>
      ${badgeAnnouncement}
      ${resortRoomsReminder}
      <p>${listing.property_type === 'Resort' ? 'Use this link to update room pricing, add more rooms, or set up an offer' : "Whenever you'd like to change your nightly rate or set up an offer, use this link"} — it's yours to keep and reuse anytime:</p>
      <p><a href="${manageLink}" style="background:#1c1a17; color:#f4eadc; padding:12px 24px; text-decoration:none; display:inline-block;">${needsRoomSetup ? 'Add Your Rooms' : (listing.property_type === 'Resort' ? 'Manage Your Rooms' : 'Manage listing')}</a></p>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">Keep this email — this link doesn't expire for two years. If you ever lose it, contact hello@aerva.in for a new one.</p>
    </div>
  `;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Aerva <hello@aerva.in>',
      to: listing.host_email,
      subject: isFirstApproval ? `You're an Aerva Host — ${listing.property_name} is live!` : `${listing.property_name} is live on Aerva`,
      html
    })
  });
}

async function sendHostRejectionEmail(listing) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping host rejection email.');
    return;
  }

  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2 style="font-family:Georgia,serif;">About your listing submission</h2>
      <p><strong>${esc(listing.property_name)}</strong> wasn't approved this time. Here's why:</p>
      <div style="background:#faf3e6; border-left:3px solid #a3402f; padding:14px 18px; margin:16px 0;">
        <p style="margin:0; white-space:pre-wrap;">${esc(listing.rejection_reason)}</p>
      </div>
      <p>Once you've made those changes and submitted them, we'll review your listing again and send you an update.</p>
      <p><a href="${SITE_BASE}/host-dashboard.html" style="color:#8a6c39;">Go to your dashboard</a> to edit and resubmit this listing.</p>
      <p style="font-size:12px; opacity:0.6; margin-top:24px;">Questions about this decision? Just reply — a real person reads every message.</p>
    </div>
  `;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Aerva <hello@aerva.in>',
      to: listing.host_email,
      subject: `Update on your Aerva listing: ${listing.property_name}`,
      html
    })
  });
}

// Only a PENDING listing is ever approved or rejected here: the status
// check is part of the UPDATE itself, so two clicks (or an old emailed
// link) can never decide the same listing twice. Returns the listing, or
// null when nothing was changed — whyNot(listingId) then says why.
async function applyDecision(listingId, action, reason = null, actor = { actorIdentifier: 'email approval link' }) {
  if (action !== 'approve' && action !== 'reject') {
    throw new Error('Invalid action');
  }
  const newStatus = action === 'approve' ? 'approved' : 'rejected';

  // One property name per pincode (_listing-rules.js; Resorts exempt).
  // Checked again here: another listing may have taken the name while this
  // one waited for review. Refused with a message for the admin.
  if (action === 'approve') {
    const cur = (await sql`SELECT property_name, pincode, property_type, listing_type FROM listings WHERE id = ${listingId} AND status = 'pending'`)[0];
    if (cur && (cur.listing_type || 'stay') === 'stay') {
      const clash = await findNameClashInPincode(sql, { propertyName: cur.property_name, pincode: cur.pincode, propertyType: cur.property_type, excludeListingId: Number(listingId) });
      if (clash) {
        throw Object.assign(new Error(`Not approved: listing #${clash.id} (${clash.status}) in ${String(cur.pincode).trim()} already uses the name "${String(cur.property_name).trim()}". Ask the host to rename this one, or reject one of the two.`),
          { isUserFacing: true, status: 409, code: 'NAME_CLASH' });
      }
    }
  }

  const result = await sql`
    UPDATE listings SET status = ${newStatus}, rejection_reason = ${action === 'reject' ? reason : null}
    WHERE id = ${listingId} AND status = 'pending'
    RETURNING id, property_name, status, host_email, host_id, rejection_reason, property_type, pending_room_photos, listing_type
  `;
  const listing = result[0] || null;

  if (listing) {
    await logAudit(sql, {
      action: action === 'approve' ? 'listing_approved' : 'listing_rejected',
      success: true, actorType: 'admin', ...actor,
      targetType: listing.listing_type === 'experience' ? 'experience' : 'listing', targetId: listing.id,
      metadata: { propertyType: listing.property_type, rejectionReason: action === 'reject' ? reason : undefined }
    });
  }

  // Pre-populate a Resort's rooms from whatever named, priced bedroom
  // photos were staged at submission (see submit-listing.js) — a host
  // who already named, photographed, AND priced every bedroom shouldn't
  // have to redo that from a blank Rooms tab just because approval is
  // what actually happens next. Only runs once per listing: gated on
  // listing_rooms being genuinely empty, so a SECOND approval of the
  // same listing (shouldn't normally happen, but defensively) never
  // overwrites rooms a host has since reconfigured. Each room is now
  // created fully active — submit-listing.js already required a real
  // price and occupancy for every bedroom before allowing submission at
  // all, so unlike the earlier version of this, there's nothing left
  // for the host to fill in before it's genuinely bookable. They can
  // still update the price anytime from the Rooms tab afterward.
  if (listing && action === 'approve' && listing.property_type === 'Resort' && Array.isArray(listing.pending_room_photos) && listing.pending_room_photos.length) {
    try {
      const existingRoomCount = await sql`SELECT COUNT(*)::int AS count FROM listing_rooms WHERE listing_id = ${listing.id}`;
      if (existingRoomCount[0].count === 0) {
        for (let i = 0; i < listing.pending_room_photos.length; i++) {
          const room = listing.pending_room_photos[i];
          // typeof room.roomName === 'string' alone doesn't catch an
          // EMPTY string — a room whose name was cleared but still had
          // photos could otherwise slip through with a blank name.
          if (!room || typeof room.roomName !== 'string' || !room.roomName.trim() || !Array.isArray(room.urls) || !room.urls.length) continue;
          const maxOccupancy = Number(room.maxOccupancy) > 0 ? Number(room.maxOccupancy) : null;
          const price = Number(room.price) > 0 ? Number(room.price) : null;
          // A room's whole gallery — no forced washroom/balcony
          // labeling, just however many photos the host added. First
          // photo becomes the cover shown on cards/search results; the
          // rest live in photo_urls for that room's own detail view.
          const [coverUrl, ...restUrls] = room.urls;
          // Only created active if it's genuinely complete (real price,
          // occupancy, AND at least one photo) — a room that somehow
          // arrives here incomplete (an older submission from before
          // this was required, for instance) still gets created so
          // nothing is silently lost, just inactive until the host
          // finishes it in the Rooms tab, same fallback behavior as
          // before this change.
          await sql`
            INSERT INTO listing_rooms (listing_id, room_name, cover_photo_url, photo_urls, max_occupancy, nightly_rate, sort_order, is_active)
            VALUES (${listing.id}, ${room.roomName.trim().slice(0, 100)}, ${coverUrl}, ${JSON.stringify(restUrls.map(url => ({ url })))}, ${maxOccupancy}, ${price}, ${i}, ${maxOccupancy != null && price != null})
          `;
        }
      }
      // Consumed — cleared regardless of whether it actually inserted
      // anything, so a later resubmission-and-reapproval cycle (rejected
      // → fixed → approved again) doesn't try to replay stale photos
      // from a much earlier submission.
      await sql`UPDATE listings SET pending_room_photos = NULL WHERE id = ${listing.id}`;
    } catch (roomErr) {
      console.error('Resort room pre-population failed:', roomErr);
      // Never blocks the approval itself — worst case, the host just
      // sees an empty Rooms tab and adds rooms manually, same as before
      // this existed.
    }
  }

  if (listing && action === 'approve') {
    try {
      // Whether the email needs the "you still need to add your rooms"
      // warning depends on whether pre-population above actually left
      // this Resort with a real, bookable room — which it normally will
      // now that submit-listing.js requires full price/occupancy for
      // every bedroom before allowing submission at all. Checked fresh
      // here rather than assumed, so an older listing that predates that
      // requirement (or a Resort with zero declared rooms) still gets
      // the accurate warning instead of a false "you're all set."
      let hasActiveRoom = true;
      if (listing.property_type === 'Resort') {
        const activeRoomRows = await sql`SELECT COUNT(*)::int AS count FROM listing_rooms WHERE listing_id = ${listing.id} AND is_active = TRUE`;
        hasActiveRoom = activeRoomRows[0].count > 0;
      }
      await sendHostApprovalEmail(listing, { needsRoomSetup: listing.property_type === 'Resort' && !hasActiveRoom });
    } catch (emailErr) {
      console.error('Host approval email failed:', emailErr);
    }
  }
  if (listing && action === 'reject' && listing.rejection_reason) {
    try {
      await sendHostRejectionEmail(listing);
    } catch (emailErr) {
      console.error('Host rejection email failed:', emailErr);
    }
  }

  return listing;
}

// Why applyDecision changed nothing: { notFound } or { status }.
async function whyNot(listingId) {
  const rows = await sql`SELECT property_name, status FROM listings WHERE id = ${listingId}`;
  return rows[0] ? { status: rows[0].status, name: rows[0].property_name } : { notFound: true };
}

// Applies or discards a SINGLE room's staged change (see
// update-listing-pricing.js, which stages per-room now, not per-
// listing) — a room-level decision, separate from approving the
// listing itself, since this only ever runs on an already-approved,
// already-live listing's individual room.
async function applyRoomChangeDecision(roomId, action, reason = null, actor = { actorIdentifier: 'email approval link' }) {
  const rows = await sql`
    SELECT lr.id, lr.listing_id, lr.pending_changes, l.host_email, l.property_name
    FROM listing_rooms lr JOIN listings l ON l.id = lr.listing_id
    WHERE lr.id = ${roomId} AND lr.pending_review = TRUE
  `;
  const room = rows[0];
  if (!room) return null;

  // A brand-new room's pending_changes holds only its
  // newRoomIntendedActive marker (see update-listing-pricing.js) —
  // nothing to "restore" it to, since it never had a prior live state.
  // An edit to a previously-live room carries the full proposed field
  // set instead.
  const isNewRoomProposal = room.pending_changes && Object.prototype.hasOwnProperty.call(room.pending_changes, 'newRoomIntendedActive');

  if (action === 'approve_room') {
    if (isNewRoomProposal) {
      await sql`
        UPDATE listing_rooms SET is_active = ${!!room.pending_changes.newRoomIntendedActive},
          pending_changes = NULL, pending_review = FALSE, pending_since = NULL,
          last_rejection_reason = NULL, last_rejected_at = NULL
        WHERE id = ${room.id}
      `;
    } else {
      const p = room.pending_changes || {};
      await sql`
        UPDATE listing_rooms SET
          room_name = ${p.roomName}, max_occupancy = ${p.maxOccupancy}, nightly_rate = ${p.nightlyRate},
          description = ${p.description || null}, is_active = ${p.isActive !== false},
          cover_photo_url = COALESCE(${p.coverPhotoUrl || null}, cover_photo_url),
          photo_urls = ${JSON.stringify(p.photoUrls || [])},
          pending_changes = NULL, pending_review = FALSE, pending_since = NULL,
          last_rejection_reason = NULL, last_rejected_at = NULL
        WHERE id = ${room.id}
      `;
    }
    // Same "lowest active room price drives the card" recompute as
    // update-listing-pricing.js — a room's price only takes effect on
    // the listing's own display price once its change is actually live.
    const cheapestActiveRoom = await sql`
      SELECT MIN(nightly_rate) AS min_rate FROM listing_rooms
      WHERE listing_id = ${room.listing_id} AND is_active = TRUE AND nightly_rate IS NOT NULL
    `;
    await sql`UPDATE listings SET nightly_rate = ${cheapestActiveRoom[0].min_rate} WHERE id = ${room.listing_id}`;
  } else if (action === 'reject_room') {
    // Both branches now KEEP the row rather than deleting a rejected new
    // room outright — a room that's simply gone with no trace tells the
    // host nothing; this way manage-listing.html can show exactly which
    // room was rejected and why, and the host can either fix it and
    // resubmit or remove it themselves once they've seen the reason.
    //
    // An edited room goes back to exactly how it was before the edit.
    // Staging switches it off while under review, so its state from
    // before is only known if the staged change recorded it (wasActive).
    // Without that, is_active is left as it is: switching on a room the
    // host had taken off sale would open it to bookings they never meant
    // to take.
    const p = room.pending_changes || {};
    const restoreActive = isNewRoomProposal ? false
      : (typeof p.wasActive === 'boolean' ? p.wasActive : null);
    await sql`
      UPDATE listing_rooms SET
        pending_changes = NULL, pending_review = FALSE, pending_since = NULL,
        is_active = COALESCE(${restoreActive}::boolean, is_active),
        last_rejection_reason = ${reason || null}, last_rejected_at = now()
      WHERE id = ${room.id}
    `;
    // A room switched back on counts toward the listing's card price again.
    if (restoreActive) {
      const cheapest = await sql`
        SELECT MIN(nightly_rate) AS min_rate FROM listing_rooms
        WHERE listing_id = ${room.listing_id} AND is_active = TRUE AND nightly_rate IS NOT NULL
      `;
      await sql`UPDATE listings SET nightly_rate = ${cheapest[0].min_rate} WHERE id = ${room.listing_id}`;
    }
  }

  await logAudit(sql, {
    action: action === 'approve_room' ? 'room_change_approved' : 'room_change_rejected',
    success: true, actorType: 'admin', ...actor,
    targetType: 'listing_room', targetId: room.id,
    metadata: { listingId: room.listing_id, isNewRoom: isNewRoomProposal, reason: reason || null }
  });
  return room;
}

// Wrong x-admin-secret guesses allowed per 15 minutes: per address, and
// in total (so spreading guesses over many addresses does not help).
const SECRET_WINDOW_MINUTES = 15;
const SECRET_MAX_PER_IP = 5;
const SECRET_MAX_TOTAL = 30;

// An admin session is a signed token, so on its own it cannot be taken
// back. It stops working here when the admin account is deleted, or when
// its session_version (migration_admin_session_version.sql) is raised —
// tokens carry the version they were issued under as { sv }; tokens
// without one are version 0. Before that migration the column is simply
// absent and every existing admin's version is 0. Fails closed.
async function adminSessionActive(payload) {
  try {
    const rows = await sql`SELECT to_jsonb(a)->>'session_version' AS sv FROM admins a WHERE a.id = ${Number(payload.listingId) || 0}`;
    if (!rows[0]) return false;
    return (Number(payload.sv) || 0) === (Number(rows[0].sv) || 0);
  } catch (err) {
    console.error('admin session check failed (refusing):', err.message);
    return false;
  }
}

module.exports = async (req, res) => {
  // Typed text can never become markup — see _plain-text.js.
  sanitizeBody(req);

  const allowedOrigin = 'https://aerva.in';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ---- Path 1: email magic link ----
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html');
    // Tokens in the URL must not travel on to other sites.
    res.setHeader('Referrer-Policy', 'no-referrer');
    const token = req.query.token;
    const payload = token ? verifyToken(token) : null;

    if (!payload || (payload.action !== 'approve' && payload.action !== 'reject')) {
      return res.status(400).send(htmlPage(
        'Link expired or invalid',
        'This link is no longer valid — it may be more than 7 days old. Use the admin page instead to review this listing.',
        true
      ));
    }

    try {
      // Nothing is changed by opening the link — approve and reject both
      // show a page first. Look the listing up without changing anything.
      const rows = await sql`SELECT id, property_name, status FROM listings WHERE id = ${payload.listingId}`;
      const listing = rows[0];
      if (!listing) {
        return res.status(404).send(htmlPage('Listing not found', 'This listing may have already been removed.', true));
      }
      if (listing.status !== 'pending') {
        return res.status(409).send(htmlPage(
          'Already reviewed',
          `"${listing.property_name}" is already ${listing.status}. Nothing was changed.`,
          true
        ));
      }
      if (payload.action === 'approve') return res.status(200).send(approveConfirmPage(listing, token));
      return res.status(200).send(rejectionReasonPage(listing, token));
    } catch (err) {
      console.error('approve-listing (GET) error:', err);
      return res.status(500).send(htmlPage('Something went wrong', 'Please try again from the admin page.', true));
    }
  }

  // ---- Path 2: a token-carrying POST (reject reason form, or approve button) ----
  if (req.method === 'POST' && req.body && req.body.token) {
    const { token, reason } = req.body;
    const payload = verifyToken(token);

    // The approve confirmation page: a plain form post, answered with a page.
    if (payload && payload.action === 'approve') {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Referrer-Policy', 'no-referrer');
      try {
        const listing = await applyDecision(payload.listingId, 'approve', null, { actorIdentifier: 'email approval link', ...requestContext(req) });
        if (!listing) {
          const why = await whyNot(payload.listingId);
          if (why.notFound) return res.status(404).send(htmlPage('Listing not found', 'This listing may have already been removed.', true));
          return res.status(409).send(htmlPage('Already reviewed', `"${why.name}" is already ${why.status}. Nothing was changed.`, true));
        }
        return res.status(200).send(htmlPage('Listing approved', `"${listing.property_name}" is now approved and live.`, false));
      } catch (err) {
        if (err.code === 'NAME_CLASH') return res.status(409).send(htmlPage('Not approved', err.message, true));
        console.error('approve-listing (POST approve token) error:', err);
        return res.status(500).send(htmlPage('Something went wrong', 'Please try again from the admin page.', true));
      }
    }

    try {
      if (!payload || payload.action !== 'reject') {
        return res.status(400).json({ error: 'This link is no longer valid. Please use the admin page instead.' });
      }
      const cleanReason = typeof reason === 'string' ? reason.trim() : '';
      if (!cleanReason) {
        return res.status(400).json({ error: 'Please enter a reason before rejecting — the host needs to know what to fix.' });
      }
      const listing = await applyDecision(payload.listingId, 'reject', cleanReason, { actorIdentifier: 'email approval link', ...requestContext(req) });
      if (!listing) {
        const why = await whyNot(payload.listingId);
        if (why.notFound) return res.status(404).json({ error: 'Listing not found' });
        return res.status(409).json({ error: `Already reviewed — this listing is ${why.status}. Nothing was changed.` });
      }
      return res.status(200).json({ success: true, listing: { id: listing.id, status: listing.status } });
    } catch (err) {
      console.error('approve-listing (POST token) error:', err);
      return res.status(500).json({ error: 'Could not reject the listing right now. Please try again.' });
    }
  }

  // ---- Path 3: admin page button ----
  if (req.method === 'POST') {
    // Same dual-auth as get-pending-listings.js: a real admin login
    // session (the normal way now) or the master ADMIN_SECRET (kept
    // working as a fallback / for creating new admin accounts).
    const adminSecret = req.headers['x-admin-secret'];
    const authHeader = req.headers['authorization'] || '';
    const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const sessionPayload = sessionToken ? verifyToken(sessionToken) : null;
    const hasValidSession = !!(sessionPayload && sessionPayload.action === 'admin-session' && await adminSessionActive(sessionPayload));

    // The shared secret can be guessed at, so wrong guesses are counted
    // (audit_log) and a caller that keeps guessing is turned away before
    // the secret is even compared.
    let hasValidSecret = false;
    if (adminSecret) {
      const ip = getClientIp(req);
      const [fromIp, fromAll] = await Promise.all([
        countRecentAttempts(sql, { action: 'admin_secret_failed', windowMinutes: SECRET_WINDOW_MINUTES, byIp: ip, onlyFailures: true }),
        countRecentAttempts(sql, { action: 'admin_secret_failed', windowMinutes: SECRET_WINDOW_MINUTES, onlyFailures: true })
      ]);
      if (fromIp >= SECRET_MAX_PER_IP || fromAll >= SECRET_MAX_TOTAL) {
        return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      }
      hasValidSecret = secretMatches(adminSecret, process.env.ADMIN_SECRET);
      if (!hasValidSecret) {
        await logAudit(sql, { action: 'admin_secret_failed', success: false, actorType: 'system', actorIdentifier: 'approve-listing',
          metadata: { ip, userAgent: requestContext(req).userAgent } });
      }
    }
    if (!hasValidSession && !hasValidSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const { listingId, roomId, action, reason } = req.body || {};
      const actor = await adminContext(sql, req, hasValidSession ? sessionPayload : null, hasValidSecret);
      if (action === 'approve_room' || action === 'reject_room') {
        const room = await applyRoomChangeDecision(roomId, action, reason || null, actor);
        if (!room) return res.status(404).json({ error: 'This room change was already reviewed or withdrawn.' });
        return res.status(200).json({ success: true, listing: room });
      }
      if (action !== 'approve' && action !== 'reject') return res.status(400).json({ error: 'Unknown action.' });
      // The admin page only ever approves or rejects a PENDING listing;
      // live listings are blocked or removed from the Live Listings tab.
      const result = await applyDecision(listingId, action, reason || null, actor);
      if (!result) {
        const why = await whyNot(listingId);
        if (why.notFound) return res.status(404).json({ error: 'Listing not found' });
        return res.status(409).json({ error: `Already reviewed — this listing is ${why.status}. Refresh to see the current list.` });
      }
      return res.status(200).json({ success: true, listing: result });
    } catch (err) {
      if (err.code === 'NAME_CLASH') return res.status(409).json({ error: err.message });
      console.error('approve-listing (POST) error:', err);
      return res.status(500).json({ error: 'Could not update listing' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
