-- 2026-10-27-01-fee-credits.sql — the service-fee credit a guest gets when
-- a HOST cancels their booking (api/_fee-credits.js). Applied from Admin →
-- Database updates. Safe to run more than once; adds two tables and one
-- column, removes nothing.
--
-- When a host cancels, Aerva's guest service fee is not kept: it becomes a
-- credit for FEE_CREDIT_DAYS. Booking another stay or experience in that
-- time, the credit pays that booking's service fee. Not booking again, the
-- guest asks for it back, or it is refunded in full automatically when the
-- credit period ends — to the original payment method.
CREATE TABLE IF NOT EXISTS fee_credits (
  id                  SERIAL PRIMARY KEY,
  guest_id            INTEGER,
  guest_email         TEXT,
  source_order_id     INTEGER NOT NULL,       -- the cancelled booking whose fee this is
  razorpay_payment_id TEXT,                   -- refunds go back to this payment
  amount              INTEGER NOT NULL,       -- ₹, the fee held
  remaining           INTEGER NOT NULL,       -- ₹, not yet used or refunded
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'refunding', 'refunded')),
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  refunded_amount     INTEGER NOT NULL DEFAULT 0,
  refunded_at         TIMESTAMPTZ,
  refund_reason       TEXT,                   -- 'asked' | 'expired'
  UNIQUE (source_order_id)
);
CREATE INDEX IF NOT EXISTS fee_credits_guest ON fee_credits (guest_id, status);

-- Each use of a credit on a booking (one row per booking row it paid for).
CREATE TABLE IF NOT EXISTS fee_credit_uses (
  id         SERIAL PRIMARY KEY,
  credit_id  INTEGER NOT NULL,
  order_id   INTEGER NOT NULL,
  amount     INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_at TIMESTAMPTZ                     -- given back: that booking was cancelled by its host
);
CREATE INDEX IF NOT EXISTS fee_credit_uses_order ON fee_credit_uses (order_id);

-- How much of a booking's service fee was paid by a credit (₹). The row's
-- guest_service_fee is what was paid in money; the two add up to the fee.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_credit_used INTEGER NOT NULL DEFAULT 0;
