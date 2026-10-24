-- 2026-10-25-02-razorpay-settlements.sql — Razorpay's settlements to Aerva's
-- bank, for the "Receivable from Razorpay" part of Admin → Accounts
-- (api/_accounts-report.js). Applied from Admin → Database updates.
-- Safe to run more than once; adds one table, removes nothing.
--
-- One row per processed Razorpay settlement (setl_…), amounts in paise as
-- Razorpay reports them: amount is what reached the bank. Filled in by the
-- Accounts report from Razorpay; nothing is ever deleted.
CREATE TABLE IF NOT EXISTS razorpay_settlements (
  id           TEXT PRIMARY KEY,           -- setl_…
  amount_paise BIGINT NOT NULL DEFAULT 0,  -- credited to the bank
  fees_paise   BIGINT NOT NULL DEFAULT 0,
  tax_paise    BIGINT NOT NULL DEFAULT 0,
  utr          TEXT,
  settled_at   TIMESTAMPTZ NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS razorpay_settlements_at ON razorpay_settlements (settled_at);
