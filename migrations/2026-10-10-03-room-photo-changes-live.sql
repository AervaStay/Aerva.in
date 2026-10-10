-- 2026-10-10-03-room-photo-changes-live.sql — room photo changes no longer
-- wait for review (api/update-listing-pricing.js). Applied from Admin →
-- Database updates. Safe to run more than once; nothing is removed.
--
-- A room change already in the review queue that changes ONLY photos (and
-- perhaps switches the room on or off) goes live now, exactly as a new one
-- would: the proposed photos replace the room's photos, the room takes the
-- on/off state the host asked for, and it leaves the queue. Its photos were
-- already checked for contact details when they were uploaded.
-- Changes to a room's name, guests, price or description, and brand-new
-- rooms, stay in the queue for review as before.
UPDATE listing_rooms
SET cover_photo_url = NULLIF(pending_changes->>'coverPhotoUrl', ''),
    photo_urls      = COALESCE(pending_changes->'photoUrls', '[]'::jsonb),
    is_active       = COALESCE((pending_changes->>'isActive')::boolean, is_active),
    pending_changes = NULL,
    pending_review  = FALSE,
    pending_since   = NULL
WHERE pending_review = TRUE
  AND pending_changes IS NOT NULL
  AND NOT (pending_changes ? 'newRoomIntendedActive')
  AND COALESCE(pending_changes->>'roomName', '') = COALESCE(room_name, '')
  AND (pending_changes->>'maxOccupancy')::numeric IS NOT DISTINCT FROM max_occupancy::numeric
  AND (pending_changes->>'nightlyRate')::numeric  IS NOT DISTINCT FROM nightly_rate::numeric
  AND COALESCE(pending_changes->>'description', '') = COALESCE(description, '');

-- Each resort's "from" price follows its bookable rooms again.
UPDATE listings l
SET nightly_rate = r.min_rate
FROM (SELECT listing_id, MIN(nightly_rate) AS min_rate
      FROM listing_rooms WHERE is_active = TRUE AND nightly_rate IS NOT NULL
      GROUP BY listing_id) r
WHERE l.id = r.listing_id AND l.property_type = 'Resort'
  AND l.nightly_rate IS DISTINCT FROM r.min_rate;
