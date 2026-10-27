-- 2026-10-27-02-credit-and-payouts.sql — Aerva credit paying toward a whole
-- booking, and payouts sent the day after check-in. Applied from Admin →
-- Database updates. Safe to run more than once; adds columns, removes
-- nothing. Run after 2026-10-27-01-fee-credits.sql.

-- How much of each use of a credit has been given back (a booking paid
-- partly with credit, then refunded: the part the card cannot take goes
-- back onto the credit — api/_fee-credits.js giveBack).
ALTER TABLE fee_credit_uses ADD COLUMN IF NOT EXISTS restored_amount INTEGER NOT NULL DEFAULT 0;
UPDATE fee_credit_uses SET restored_amount = amount WHERE restored_at IS NOT NULL AND restored_amount = 0;

-- An amount a payee was paid for a booking and is no longer owed (the
-- booking was reduced after its payout was sent): recovered from their
-- next payout (api/_payouts.js settleAfterPayout). Existing rows are the
-- cancellation coupons ('coupon').
ALTER TABLE host_penalties ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'coupon';

-- Set while the rest of a booking's payout is held: a guest's request made
-- in the stay window (a change asked for, or a problem reported) was open
-- when the payout went, so only the first night was paid. Cleared when the
-- rest is paid (api/_payouts.js runAutoPayouts).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payout_rest_held_at TIMESTAMPTZ;

-- Why an Aerva credit was made: a host cancelled ('host_cancelled'), or a
-- stay was shortened during the stay with the host's agreement
-- ('stay_shortened' — the nights not stayed are held as credit, not refunded).
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'host_cancelled';

-- The Aerva credit ledger: one row for every movement of a credit, so the
-- accounts can show where each credit came from (the booking and the
-- Razorpay payment that paid it), where it went (the booking it paid, and
-- that booking's Razorpay payment) and every refund (Razorpay refund id).
--   issued     — credit made (a host cancelled, or a stay was shortened)
--   used       — taken off a new booking (order_id = that booking)
--   given_back — back onto the credit (a booking it paid was refunded)
--   refunded   — refunded to the original payment (asked, or at the end)
-- Never edited or deleted.
CREATE TABLE IF NOT EXISTS fee_credit_entries (
  id          SERIAL PRIMARY KEY,
  credit_id   INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('issued', 'used', 'given_back', 'refunded')),
  amount      INTEGER NOT NULL,           -- ₹, always positive
  order_id    INTEGER,                    -- the booking it came from / was used on / came back from
  reference   TEXT,                       -- Razorpay payment or refund id
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fee_credit_entries_credit ON fee_credit_entries (credit_id);
CREATE INDEX IF NOT EXISTS fee_credit_entries_day ON fee_credit_entries (created_at);
