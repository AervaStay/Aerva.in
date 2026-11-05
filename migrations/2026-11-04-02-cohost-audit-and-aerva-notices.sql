-- 2026-11-04-02-cohost-audit-and-aerva-notices.sql — two records the database refused.
-- 1. Co-host actions (prices, blocked dates, cancellations, calendar sync)
--    are written to audit_log as actor 'cohost', but the table only accepted
--    admin/host/guest/system, so those records were lost.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('admin', 'host', 'guest', 'system', 'cohost'));
-- 2. Aerva's notices in a booking's chat ("Aerva cancelled this booking",
--    "Aerva refunded …") are sent as 'system', which the chat shows as a
--    notice, but messages only accepted guest/host, so they never appeared.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sender_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_sender_type_check CHECK (sender_type IN ('guest', 'host', 'system'));
