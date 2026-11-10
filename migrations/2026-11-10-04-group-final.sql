-- 2026-11-10-04-group-final.sql — group (split-payment) bookings, the
-- owner's FINAL rules of 10 Nov 2026 (01:08–01:25). api/_group-bookings.js,
-- api/_fee-credits.js. Safe to run more than once; adds columns and indexes,
-- removes nothing (one NOT NULL is relaxed, see fee_credits below).
-- Until it has run, "Split the payment with friends" answers "not switched
-- on yet" (nothing is charged).
--
-- • The organiser's commitment: when starting, the organiser ticks "I'll pay
--   for any places my friends don't pay within 2 hours" (commitment_at).
--   If at 2 hours places are unpaid, the organiser has 30 minutes to pay the
--   rest (status 'awaiting_gap', gap = the rest, confirm_by = the deadline).
--   Not paid → no booking, everyone refunded in full, and the unpaid
--   commitment is recorded on the organiser's account (commitment_unpaid,
--   rupees; commitment_unpaid_at) and shown to admin.
ALTER TABLE group_bookings ADD COLUMN IF NOT EXISTS commitment_at TIMESTAMPTZ;
ALTER TABLE group_bookings ADD COLUMN IF NOT EXISTS commitment_unpaid INTEGER;
ALTER TABLE group_bookings ADD COLUMN IF NOT EXISTS commitment_unpaid_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_group_bookings_commitment ON group_bookings (organiser_guest_id) WHERE commitment_unpaid IS NOT NULL;

-- • Dates are not held while the money is collected. Only the payment of the
--   LAST unpaid amount holds the place, for its normal 3-minute window: the
--   booking_holds row it took (hold_id), released with the payment window.
-- • Every payer ticks "I understand: once the booking is confirmed it is
--   non-refundable…" before paying (nonrefundable_ack_at).
ALTER TABLE group_claims ADD COLUMN IF NOT EXISTS hold_id INTEGER;
ALTER TABLE group_claims ADD COLUMN IF NOT EXISTS nonrefundable_ack_at TIMESTAMPTZ;

-- • After confirmation, a natural disaster / government order approved by
--   Aerva, or a host cancellation, gives EACH PAYER their own share as Aerva
--   credit in their own account (refundable to their own payment). Such a
--   credit belongs to one group payment (group_claim_id, one credit per
--   payment) and to the booking (group_order_id); source_order_id stays
--   empty, so a booking can hold several of them.
-- (source_order_id may now be empty: relaxing NOT NULL is safe to repeat.)
ALTER TABLE fee_credits ALTER COLUMN source_order_id DROP NOT NULL;
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS group_claim_id INTEGER;
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS group_order_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_credits_group_claim ON fee_credits (group_claim_id);
CREATE INDEX IF NOT EXISTS idx_fee_credits_group_order ON fee_credits (group_order_id) WHERE group_order_id IS NOT NULL;
