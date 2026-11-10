-- 2026-11-10-09-deposit-24-hours.sql — the host has 24 hours from check-out
-- to report damage (owner, 10 Nov 2026; was 7 days). api/_deposits.js.
-- Safe to run more than once; changes only dates shown for deposits still held.
--
-- The deposit job already works out the 24 hours from the departure date and
-- the listing's check-out time, so deposits are refunded on time whether or
-- not this has run. This only moves the "refund goes out" date shown to hosts
-- (orders.deposit_release_at) from check-out + 7 days to check-out + 1 day for
-- deposits still held. Disputed, refunded and resolved deposits are untouched.
UPDATE orders
   SET deposit_release_at = departure + 1
 WHERE deposit_status = 'held'
   AND departure IS NOT NULL
   AND deposit_release_at > departure + 1;
