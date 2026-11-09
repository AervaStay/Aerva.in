-- 2026-11-09-06-emergency-proof-review.sql — emergency cancellations
-- (owner, 9 Nov 2026): the guest attaches proof (a medical note, a
-- government order, a photo or news report of the hazard); a host's
-- decline of a proven emergency can be taken to Aerva within 24 hours, and
-- Aerva's decision is final; on a proven emergency that is approved,
-- Aerva's service fee comes back as Aerva credit.
ALTER TABLE cancellation_requests ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE cancellation_requests ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMPTZ;
ALTER TABLE cancellation_requests ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE cancellation_requests ADD COLUMN IF NOT EXISTS review_decided_at TIMESTAMPTZ;
ALTER TABLE cancellation_requests ADD COLUMN IF NOT EXISTS review_outcome TEXT;
