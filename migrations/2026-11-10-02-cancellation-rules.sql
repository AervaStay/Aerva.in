-- 2026-11-10-02-cancellation-rules.sql — the owner's cancellation rules of
-- 10 Nov 2026 (api/_cancellations.js, api/_fee-credits.js). Safe to run more
-- than once; adds columns, removes nothing.
--
-- A natural disaster (or a government order / travel restriction) approved
-- by Aerva: what the guest paid becomes ordinary Aerva credit with reason
-- 'natural_disaster' (owner, 01:25: the guest can have it refunded to the
-- original payment whenever they like; it lasts and is reminded like any
-- other credit, and what is left at its end is refunded automatically).
--   cash_refundable          true for every credit (the default)
--   cash_refund_allowed_at,  from the admin switch that allowed a refund of
--   cash_refund_allowed_by,  "credit for new dates only" (00:54). The switch
--   cash_refund_note         is gone; the columns stay, unused.
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS cash_refundable BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS cash_refund_allowed_at TIMESTAMPTZ;
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS cash_refund_allowed_by TEXT;
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS cash_refund_note TEXT;
-- Any natural-disaster credit made by the earlier code (credit for new dates
-- only, never expiring): ordinary, refundable credit with a normal 6-month
-- period from when it was made.
UPDATE fee_credits SET cash_refundable = true,
       expires_at = CASE WHEN expires_at = 'infinity' THEN created_at + interval '6 months' ELSE expires_at END
WHERE reason = 'natural_disaster' AND (NOT cash_refundable OR expires_at = 'infinity');
