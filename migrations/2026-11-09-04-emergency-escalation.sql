-- 2026-11-09-04-emergency-escalation.sql — an emergency cancellation the
-- host has not answered in 24 hours (owner's rule, 9 Nov 2026).
-- Aerva reaches out to the host first: 3 reminders by email and in the
-- booking's Messages, a support request for the guest and for the host
-- (their "action needed"), and an urgent item for Aerva's support team.
-- Only when the host still has not answered does Aerva decide; its decision
-- binds host and guest. A host who declines: no refund.
ALTER TABLE cancellation_requests ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
ALTER TABLE cancellation_requests ADD COLUMN IF NOT EXISTS host_reminders INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cancellation_requests ADD COLUMN IF NOT EXISTS last_host_reminder_at TIMESTAMPTZ;
ALTER TABLE cancellation_requests ADD COLUMN IF NOT EXISTS aerva_decides_at TIMESTAMPTZ;
ALTER TABLE cancellation_requests ADD COLUMN IF NOT EXISTS guest_ticket_id INTEGER REFERENCES support_tickets(id) ON DELETE SET NULL;
ALTER TABLE cancellation_requests ADD COLUMN IF NOT EXISTS host_ticket_id INTEGER REFERENCES support_tickets(id) ON DELETE SET NULL;
ALTER TABLE cancellation_requests ADD COLUMN IF NOT EXISTS contact_log JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Support requests Aerva must act on now come first in Admin → Support.
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS urgent BOOLEAN NOT NULL DEFAULT false;
