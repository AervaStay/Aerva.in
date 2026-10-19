-- 2026-10-13-03-chat-numbers.sql — phone numbers in a booking's chat
-- (api/_message-guard.js). Applied from Admin → Database updates. Safe to
-- run more than once; adds one column, removes nothing.
--
-- While a booking is live (paid, check-out not yet passed) the guest and
-- host may share a phone number in its chat. Once check-out has passed or
-- the booking is cancelled, the numbers are removed from what both sides
-- see (the original text stays for Aerva's records); this marks the
-- conversations already cleaned.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS contacts_scrubbed_at TIMESTAMPTZ;
