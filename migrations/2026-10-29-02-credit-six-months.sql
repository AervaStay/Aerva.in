-- 2026-10-29-02-credit-six-months.sql — Aerva credit lasts 6 months.
-- Every credit now ends 6 months after it was issued (or earlier, when the
-- payment it came from would be too old for the bank to refund: 175 days
-- after the booking, if that still leaves 30 days). What is left then is
-- refunded automatically. A final email goes 7 days before the end.
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS ending_reminded_at TIMESTAMPTZ;
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS refund_failed_at TIMESTAMPTZ;
-- Open credits that had no end date get one, counted from when each was issued.
UPDATE fee_credits f SET expires_at = CASE
    WHEN o.created_at IS NOT NULL
     AND o.created_at + interval '175 days' < f.created_at + interval '6 months'
     AND o.created_at + interval '175 days' >= now() + interval '30 days'
    THEN o.created_at + interval '175 days'
    ELSE f.created_at + interval '6 months' END
FROM fee_credits f2 LEFT JOIN orders o ON o.id = f2.source_order_id
WHERE f2.id = f.id AND f.expires_at = 'infinity' AND f.status IN ('active', 'used', 'refunding');
