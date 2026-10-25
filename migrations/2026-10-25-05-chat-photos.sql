-- 2026-10-25-05-chat-photos.sql — photos in a booking's chat
-- (api/guest-profile.js 'send', api/_message-guard.js). Applied from Admin →
-- Database updates. Safe to run more than once; adds two columns, removes
-- nothing.
--
-- During a confirmed booking (until check-out) the guest and host may send
-- each other photos, up to 6 a message. photo_urls is what both sides see;
-- original_photo_urls is what was sent, kept for Aerva's records. After
-- check-out or a cancellation, photos that show a contact detail are taken
-- out of photo_urls, silently.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS photo_urls JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS original_photo_urls JSONB;
