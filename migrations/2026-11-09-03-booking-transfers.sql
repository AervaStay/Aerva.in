-- 2026-11-09-03-booking-transfers.sql — moving nights to another property
-- of the same host (api/_booking-transfers.js).
-- Every part of a transferred booking (the original and the new parts) is
-- marked with the change that split it. A marked booking can no longer be
-- changed, split again or shortened (owner's rule, 9 Nov 2026); each part
-- can still be cancelled under its own cancellation policy.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS transfer_change_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_orders_transfer_change ON orders (transfer_change_id) WHERE transfer_change_id IS NOT NULL;
