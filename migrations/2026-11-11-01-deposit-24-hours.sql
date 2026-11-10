-- Security deposit (owner, 10 Nov 2026): the host has 24 hours from check-out
-- to report damage (was 7 days). Applies at once to every deposit still held.
-- deposit_release_at is the calendar day the 24 hours end (check-out + 1 day).
UPDATE orders
   SET deposit_release_at = LEAST(deposit_release_at, departure + 1)
 WHERE deposit_status = 'held' AND deposit_release_at IS NOT NULL AND departure IS NOT NULL;
