-- Extra guests, set by the host per listing (owner, 11 Nov 2026):
--   included_guests  how many guests the nightly rate covers (1 … max guests)
--   extra_guest_fee  ₹ per extra guest, per night (0 = no charge)
-- Empty on both = the rule every listing had before: 2 guests included,
-- ₹1,500 per extra guest per night. Read through to_jsonb, so nothing breaks
-- before this has run.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS included_guests INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS extra_guest_fee INTEGER;
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_included_guests_check;
ALTER TABLE listings ADD CONSTRAINT listings_included_guests_check CHECK (included_guests IS NULL OR (included_guests >= 1 AND included_guests <= 100));
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_extra_guest_fee_check;
ALTER TABLE listings ADD CONSTRAINT listings_extra_guest_fee_check CHECK (extra_guest_fee IS NULL OR (extra_guest_fee >= 0 AND extra_guest_fee <= 100000));
