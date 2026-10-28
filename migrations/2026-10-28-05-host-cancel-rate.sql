-- 2026-10-28-05-host-cancel-rate.sql — each property's host cancellation
-- rate (cancelled by the host / bookings, last 12 months), shown to guests
-- and hosts and counted in host badges. A booking cancelled by its host (or
-- by Aerva for the host) is marked here; a same-day booking the host
-- cancels within 1 hour of it being made is not.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by_host_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_orders_listing_created ON orders (listing_id, created_at);
-- Past host cancellations, from the audit log (nothing is removed).
UPDATE orders o SET cancelled_by_host_at = a.created_at
FROM audit_log a
WHERE a.action = 'booking_cancelled_by_host' AND a.success = true AND a.target_type = 'order'
  AND a.target_id::text = o.id::text AND o.cancelled_by_host_at IS NULL;
