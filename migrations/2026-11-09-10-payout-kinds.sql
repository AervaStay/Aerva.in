-- 2026-11-09-10-payout-kinds.sql — payout rows for corrections after a
-- payout was sent. _payouts.js settleAfterPayout writes kind
-- 'adjustment-<n>' (a booking changed after its payout) and 'rest-<n>' (the
-- rest of a payout held while a guest's request was open), but the
-- database only allowed 'booking' and 'deposit', so those payouts failed.
-- Safe to run more than once.
ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_kind_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_kind_check CHECK (
  (kind IN ('booking', 'deposit') OR kind ~ '^(adjustment|rest)-[0-9]+$')
  AND (kind <> 'deposit' OR payee_type = 'host')
);
