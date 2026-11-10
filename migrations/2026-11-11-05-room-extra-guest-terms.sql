-- Extra guests per Resort room (owner, 11 Nov 2026): each room has its own
--   included_guests  how many guests the room's nightly rate covers (1 … its max guests)
--   extra_guest_fee  ₹ per extra guest, per night (0 = no charge)
-- Empty on both = 2 guests included and ₹1,500 per extra guest per night,
-- as every room had before. Read through to_jsonb, so nothing breaks before this runs.
ALTER TABLE listing_rooms ADD COLUMN IF NOT EXISTS included_guests INTEGER;
ALTER TABLE listing_rooms ADD COLUMN IF NOT EXISTS extra_guest_fee INTEGER;
ALTER TABLE listing_rooms DROP CONSTRAINT IF EXISTS listing_rooms_included_guests_check;
ALTER TABLE listing_rooms ADD CONSTRAINT listing_rooms_included_guests_check CHECK (included_guests IS NULL OR (included_guests >= 1 AND included_guests <= 100));
ALTER TABLE listing_rooms DROP CONSTRAINT IF EXISTS listing_rooms_extra_guest_fee_check;
ALTER TABLE listing_rooms ADD CONSTRAINT listing_rooms_extra_guest_fee_check CHECK (extra_guest_fee IS NULL OR (extra_guest_fee >= 0 AND extra_guest_fee <= 100000));
