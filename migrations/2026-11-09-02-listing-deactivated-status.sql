-- 2026-11-09-02-listing-deactivated-status.sql — let a listing be 'deactivated'.
-- The site switches listings off with status 'deactivated' (a host pausing
-- one listing, a host pausing all hosting, an agreement that has ended), but
-- the database only allowed draft/pending/approved/rejected/blocked/removed,
-- so each of those was refused (found 9 Nov 2026, uat structure).
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_status_check;
ALTER TABLE listings ADD CONSTRAINT listings_status_check
  CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'blocked', 'removed', 'deactivated'));
