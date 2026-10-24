-- 2026-10-25-01-razorpay-fees.sql — Razorpay's own charges, for Admin →
-- Accounts (api/_accounts-report.js). Applied from Admin → Database updates.
-- Safe to run more than once; adds one table, removes nothing.
--
-- One row per real Razorpay payment (pay_…) or RazorpayX payout (pout_…),
-- with the fee Razorpay charged Aerva and the GST on that fee, in paise,
-- exactly as Razorpay reports them. Filled in by the Accounts report the
-- first time it sees a transaction; a fee Razorpay has not settled yet is
-- fetched again next time. Nothing is ever deleted.
CREATE TABLE IF NOT EXISTS razorpay_fees (
  ref_id      TEXT PRIMARY KEY,           -- pay_… or pout_…
  kind        TEXT NOT NULL,              -- 'payment' or 'payout'
  order_id    INTEGER,                    -- Aerva booking
  fee_paise   BIGINT NOT NULL DEFAULT 0,  -- Razorpay's total fee, GST included
  tax_paise   BIGINT NOT NULL DEFAULT 0,  -- of which GST
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS razorpay_fees_order ON razorpay_fees (order_id);
