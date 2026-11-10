-- 2026-11-10-07-free-cancel-fee.sql — the host sets the PRICE of the free
-- cancellation add-on (owner, 10 Nov 2026; replaces the flat 15%).
-- Safe to run more than once. Run after 2026-11-10-01-free-cancellation.sql
-- and 2026-11-10-06-free-cancel-optin.sql.
--
-- listings.free_cancel_fee  The host's fixed price for the add-on, whole
--   rupees per booking, whatever the length of the stay (₹100 – ₹1,00,000;
--   required by the site when "Offer free cancellation to guests" is on).
--   Each booking pays it kept between 5% and 30% of that booking's stay
--   subtotal (api/_pricing.js freeCancelCharge). Empty (NULL) for every
--   existing listing: a listing switched on before this has no price and
--   counts as NOT offering the add-on until the host sets one ("Set a
--   price to keep offering free cancellation" in Manage listing).
--
-- orders.free_cancel_fixed  The host's fixed price a booking bought the
--   add-on with, so a change that adds nights re-works it out on the new
--   subtotal from the amount sold (never the listing's current price).
--   NULL for bookings without the add-on and for bookings made before this
--   (they keep the rule they were sold with: added nights add 15%).
--   What the booking actually paid stays in orders.free_cancel_fee.
--
-- The code reads both through to_jsonb(...)->>'…', so before this has run
-- nothing breaks and the add-on is simply not offered.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS free_cancel_fee INTEGER;
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_free_cancel_fee_check;
ALTER TABLE listings ADD CONSTRAINT listings_free_cancel_fee_check CHECK (
  free_cancel_fee IS NULL OR (free_cancel_fee >= 100 AND free_cancel_fee <= 100000)
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS free_cancel_fixed INTEGER;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_free_cancel_fixed_check;
ALTER TABLE orders ADD CONSTRAINT orders_free_cancel_fixed_check CHECK (free_cancel_fixed IS NULL OR free_cancel_fixed > 0);
