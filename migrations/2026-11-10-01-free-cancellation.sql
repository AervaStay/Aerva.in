-- 2026-11-10-01-free-cancellation.sql — the free cancellation add-on (owner, 9 Nov 2026).
-- Safe to run more than once. Until it has run, nothing new is offered or
-- charged: the code reads these columns through to_jsonb(o)->>'…' and
-- treats them as 0.
--
-- Free cancellation add-on (api/_pricing.js). Whole rupees, as every
--    money column on orders. The add-on's price and the commission on it
--    are ALSO inside commission_amount / payout_amount (the host is paid
--    it, less Aerva's commission); these columns keep its own parts so a
--    cancellation, change or transfer can treat it on its own.
--      free_cancel_fee         the add-on (15% of the booking price)
--      free_cancel_gst         GST on it, at the stay's rate
--      free_cancel_commission  Aerva's commission on it, at the host's rate
--      free_cancel_refunded    true when it went back to the guest (the
--                              host cancelled, or Aerva for the host)
--    Its window (48 hours before check-in) is never stored: it is worked
--    out from the arrival, so it moves with a change of dates.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS free_cancel_fee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS free_cancel_gst INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS free_cancel_commission INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS free_cancel_refunded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_free_cancel_check;
ALTER TABLE orders ADD CONSTRAINT orders_free_cancel_check CHECK (
  free_cancel_fee >= 0 AND free_cancel_gst >= 0 AND free_cancel_commission >= 0 AND free_cancel_commission <= free_cancel_fee
);
