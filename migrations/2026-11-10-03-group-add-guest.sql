-- 2026-11-10-03-group-add-guest.sql — "Add a guest" to a group (split-payment)
-- booking (owner's rules, 10 Nov 2026, 00:50 / 00:51). api/_group-bookings.js.
-- Safe to run more than once. Until it has run, "Add a guest" answers
-- "not switched on yet" and group bookings work exactly as before.

-- Each time places are added the per-place prices are set again: a new
-- price_version. A payment started at an older version is not counted
-- (refunded in full), so nobody can pay an old price after a change.
ALTER TABLE group_bookings ADD COLUMN IF NOT EXISTS price_version INTEGER NOT NULL DEFAULT 1;
-- The "balance to pay" (rupees) the places already paid owe at this
-- price_version, when adding a guest raised the per-place price.
ALTER TABLE group_bookings ADD COLUMN IF NOT EXISTS topup_due INTEGER NOT NULL DEFAULT 0;
-- How many times guests were added at the 2-hour decision (each gives one
-- short extra window).
ALTER TABLE group_bookings ADD COLUMN IF NOT EXISTS extensions INTEGER NOT NULL DEFAULT 0;
-- The group's notices ("Guest added — now 5 places, ₹1,900 each"), shown on
-- the group page and posted to the booking's Messages once it exists.
ALTER TABLE group_bookings ADD COLUMN IF NOT EXISTS notices JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE group_claims ADD COLUMN IF NOT EXISTS price_version INTEGER NOT NULL DEFAULT 1;
-- A payment for guests added after the booking was confirmed: the
-- booking_changes row it pays for.
ALTER TABLE group_claims ADD COLUMN IF NOT EXISTS change_id INTEGER;

-- New kinds of payment: 'topup' (the balance the paid places owe after a
-- guest was added) and 'change' (guests added after confirmation).
ALTER TABLE group_claims DROP CONSTRAINT IF EXISTS group_claims_kind_check;
ALTER TABLE group_claims ADD CONSTRAINT group_claims_kind_check CHECK (kind IN ('places', 'gap', 'topup', 'change'));

-- One open balance / added-guests payment per group at a time: two people
-- can never pay the same balance at once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_group_claims_one_open_extra ON group_claims (group_id, kind) WHERE status = 'open' AND kind IN ('topup', 'change');
