-- migration_admin_lookup.sql — Admin → Lookup
-- Safe to run more than once. Run in the Neon SQL editor.
--
-- 1. Refunds: allow the new goodwill refunds an admin makes without
--    cancelling ("goodwill-1", "goodwill-1:<payment id>", …), alongside
--    every kind already in use.
-- 2. Guests: allow the "suspended" account status.
-- 3. Indexes so Lookup by phone, email, code and payment id stays fast.

DO $$
DECLARE c record;
BEGIN
  -- Any existing CHECK on refunds.kind is replaced by one that also allows goodwill refunds.
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'refunds'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE refunds DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE refunds ADD CONSTRAINT refunds_kind_check CHECK (
    kind IN ('cancellation', 'deposit', 'deposit_dispute')
    OR kind ~ '^cancellation:.+$'
    OR kind ~ '^change-[0-9]+:.+$'
    OR kind ~ '^change-pay-[0-9]+$'
    OR kind ~ '^dispute-[0-9]+:.+$'
    OR kind ~ '^goodwill-[0-9]+(:.+)?$'
  ) NOT VALID;   -- checks new refunds only; existing rows are left as they are

  -- Any existing CHECK on guests.account_status is replaced by one that allows "suspended".
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'guests'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%account_status%'
  LOOP
    EXECUTE format('ALTER TABLE guests DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE guests ADD COLUMN IF NOT EXISTS account_status TEXT;
ALTER TABLE guests DROP CONSTRAINT IF EXISTS guests_account_status_check;
ALTER TABLE guests ADD CONSTRAINT guests_account_status_check
  CHECK (account_status IS NULL OR account_status IN ('active', 'deactivated', 'suspended')) NOT VALID;

CREATE INDEX IF NOT EXISTS orders_razorpay_payment_idx ON orders (razorpay_payment_id);
CREATE INDEX IF NOT EXISTS orders_razorpay_order_idx ON orders (razorpay_order_id);
CREATE INDEX IF NOT EXISTS orders_guest_email_lower_idx ON orders (lower(guest_email));
CREATE INDEX IF NOT EXISTS guests_phone_last10_idx ON guests (right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 10));
CREATE INDEX IF NOT EXISTS orders_confirmation_code_upper_idx ON orders (upper(confirmation_code));
