-- 2026-11-12-07-money-guards.sql — two things the database was not saying
-- about money (review of 12 Nov 2026). Safe to run more than once, and safe
-- on a database with any history: every check is added NOT VALID, so it
-- applies to new and changed rows only and never fails on what is already
-- there. Nothing is rewritten and nothing is deleted.
--
-- 1. WHICH UNIT. Some money columns are whole rupees and some are paise,
--    and nothing on the column said which. The mix is real:
--      orders.total, payouts.net, group_claims.amount      → rupees
--      refunds.amount, group_claims.refund_amount          → paise
--    A comment on the column shows it in psql \d and in every database
--    tool, so the next person does not have to read the code to find out.
--
-- 2. NO NEGATIVE MONEY. None of these columns may hold a negative amount:
--    a bug that worked one out would have been stored without complaint.
--    The checks below refuse that from now on.

-- ---------------------------------------------------------------- units
COMMENT ON COLUMN orders.total              IS 'Whole rupees (GST, service fee and any deposit included).';
COMMENT ON COLUMN orders.subtotal           IS 'Whole rupees, before GST.';
COMMENT ON COLUMN orders.gst                IS 'Whole rupees.';
COMMENT ON COLUMN orders.guest_service_fee  IS 'Whole rupees.';
COMMENT ON COLUMN orders.deposit_amount     IS 'Whole rupees. Refundable security deposit.';
COMMENT ON COLUMN orders.commission_amount  IS 'Whole rupees. Aerva''s commission.';
COMMENT ON COLUMN orders.payout_amount      IS 'Whole rupees. What the host is owed before TDS and deductions.';
COMMENT ON COLUMN orders.charge_amount      IS 'The amount actually charged, in charge_currency''s own unit (only when it is not INR).';
COMMENT ON COLUMN refunds.amount            IS 'PAISE (1/100 rupee) — as Razorpay takes it. Divide by 100 for rupees.';
COMMENT ON COLUMN payouts.gross             IS 'Whole rupees (2 decimals).';
COMMENT ON COLUMN payouts.net               IS 'Whole rupees (2 decimals). What reaches the bank, after TDS and deductions.';
COMMENT ON COLUMN payouts.tds               IS 'Whole rupees (2 decimals).';
COMMENT ON COLUMN fee_credits.amount        IS 'Whole rupees. Aerva credit given.';
COMMENT ON COLUMN fee_credits.remaining     IS 'Whole rupees. Aerva credit not yet used or refunded.';
COMMENT ON COLUMN coupons.amount            IS 'Whole rupees.';

DO $u$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='group_claims' AND column_name='amount') THEN
    EXECUTE 'COMMENT ON COLUMN group_claims.amount IS ''Whole rupees. What this person pays for their place(s).''';
    EXECUTE 'COMMENT ON COLUMN group_claims.refund_amount IS ''PAISE (1/100 rupee), as Razorpay takes it.''';
  END IF;
END
$u$;

-- ------------------------------------------------------- no negative money
DO $m$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('orders', 'total'), ('orders', 'subtotal'), ('orders', 'gst'), ('orders', 'guest_service_fee'),
      ('orders', 'commission_amount'), ('orders', 'payout_amount'), ('orders', 'deposit_amount'),
      ('refunds', 'amount'),
      ('payouts', 'gross'), ('payouts', 'net'), ('payouts', 'tds'),
      ('fee_credits', 'amount'), ('fee_credits', 'remaining'),
      ('coupons', 'amount'),
      ('group_claims', 'amount')
    ) AS t(tbl, col)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = c.tbl AND column_name = c.col)
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.tbl || '_' || c.col || '_not_negative') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I >= 0) NOT VALID',
                     c.tbl, c.tbl || '_' || c.col || '_not_negative', c.col);
    END IF;
  END LOOP;
END
$m$;
