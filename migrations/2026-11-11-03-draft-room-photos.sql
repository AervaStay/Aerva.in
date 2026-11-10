-- Opening a draft again (owner, 11 Nov 2026): every room's and space's
-- photos go back into their own sections of the List your property form.
-- Holds them as the form had them: [{ roomName, isBedroom, bedIndex, urls }].
-- Read only by the form (through to_jsonb, so nothing breaks before this runs).
ALTER TABLE listings ADD COLUMN IF NOT EXISTS draft_room_photos JSONB;
