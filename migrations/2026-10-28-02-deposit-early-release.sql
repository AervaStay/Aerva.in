-- 2026-10-28-02-deposit-early-release.sql — deposits. A host who confirms, with their
-- review of the guest, that there is no damage releases the security
-- deposit early: it is refunded two bank working days later instead of 7
-- days after check-out (api/_deposits.js releaseEarly). Applied from Admin →
-- Database updates. Safe to run more than once; adds one column, removes nothing.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit_released_by_host_at TIMESTAMPTZ;

-- A host's concern about the deposit must come with proof: photos or videos
-- of the damage, shared with Aerva (links to the uploaded files).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_evidence JSONB;

-- The host decides how much of the deposit to keep (damage or extra
-- cleaning, never more than the deposit).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_amount NUMERIC(12,2);
