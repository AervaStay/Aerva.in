-- 2026-11-12-02-group-deposit-organiser.sql — in a group booking the security
-- deposit is paid by the ORGANISER alone, not split over the places
-- (owner, 12 Nov 2026). Safe to run more than once; adds one column.
-- Code: api/_group-bookings.js, api/_refunds.js, api/_deposits.js.
--
-- Before: the whole quote, deposit included, was split equally over the
-- places, so every friend paid a part of the deposit and every friend got a
-- part of it back.
-- Now: the places split the stay, its GST and the service fee; the deposit
-- is added to the organiser's own first payment and goes back to that same
-- payment when the stay is over.

ALTER TABLE group_claims ADD COLUMN IF NOT EXISTS carries_deposit BOOLEAN NOT NULL DEFAULT false;

-- Groups that were already paid for keep the old split: their claims are
-- untouched, so their deposit still goes back the way it was collected.
