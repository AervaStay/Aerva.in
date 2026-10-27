-- 2026-10-28-03-host-cancel-confirm.sql — when Aerva cancels a booking for a
-- host (over their 3 cancellations a year, or when they cannot cancel
-- themselves), the host confirms it first, in a support request raised for
-- them. Nothing is cancelled or refunded until they confirm. Within 48 hours
-- of check-in an admin then issues the guest's 10% coupon (Aerva pays it;
-- it is deducted from the host's next payout).
CREATE TABLE IF NOT EXISTS host_cancel_confirmations (
  id            SERIAL PRIMARY KEY,
  order_id      INTEGER NOT NULL,
  host_id       INTEGER NOT NULL,
  ticket_id     INTEGER,
  reason        TEXT NOT NULL,
  refund_amount INTEGER NOT NULL DEFAULT 0,
  coupon_amount INTEGER NOT NULL DEFAULT 0,
  requested_by  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | confirmed | declined | withdrawn | failed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ,
  decided_by    INTEGER,
  note          TEXT,
  coupon_id         INTEGER,          -- the coupon an admin issued after the host confirmed
  coupon_issued_at  TIMESTAMPTZ,
  coupon_issued_by  TEXT
);
ALTER TABLE host_cancel_confirmations ADD COLUMN IF NOT EXISTS coupon_id INTEGER;
ALTER TABLE host_cancel_confirmations ADD COLUMN IF NOT EXISTS coupon_issued_at TIMESTAMPTZ;
ALTER TABLE host_cancel_confirmations ADD COLUMN IF NOT EXISTS coupon_issued_by TEXT;
CREATE INDEX IF NOT EXISTS idx_host_cancel_conf_order ON host_cancel_confirmations (order_id);
CREATE INDEX IF NOT EXISTS idx_host_cancel_conf_ticket ON host_cancel_confirmations (ticket_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_host_cancel_conf_one_pending ON host_cancel_confirmations (order_id) WHERE status = 'pending';
