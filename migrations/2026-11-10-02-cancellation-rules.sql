-- 2026-11-10-02-cancellation-rules.sql — the owner's cancellation rules of
-- 10 Nov 2026 (api/_cancellations.js, api/_fee-credits.js). Safe to run more
-- than once; adds columns, removes nothing. Until it has run, the code marks
-- credit for new dates only by its reason ('natural_disaster') alone, and
-- the admin switch below is refused with a message.
--
-- A natural disaster (or a government order / travel restriction) approved
-- by Aerva: everything the guest paid becomes Aerva credit for NEW DATES
-- ONLY. It never expires and is never refunded — not on request, not when
-- it ends (it does not end).
--   cash_refundable          false for that credit (true for every other)
--   cash_refund_allowed_at   set when an admin allows THIS guest's credit to
--                            be refunded to its original payment (owner,
--                            00:54); NULL again when switched off
--   cash_refund_allowed_by   the admin who last switched it on or off
--   cash_refund_note         their note (optional)
-- The deposit of such a booking goes into the credit too: orders.deposit_status
-- is then 'credited' (a text column, no check constraint to change).
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS cash_refundable BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS cash_refund_allowed_at TIMESTAMPTZ;
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS cash_refund_allowed_by TEXT;
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS cash_refund_note TEXT;
-- Credits made before this update ran (marked by their reason only).
UPDATE fee_credits SET cash_refundable = false, expires_at = 'infinity'
WHERE reason = 'natural_disaster' AND (cash_refundable OR expires_at <> 'infinity');
