-- 2026-10-28-04-credit-reminders.sql — Aerva credit from a host's
-- cancellation no longer ends (the guest uses it, or has it refunded
-- whenever they ask), and guests are reminded every 15 days while it is
-- unused.
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS reminders_sent INTEGER NOT NULL DEFAULT 0;
-- Open credits keep their value with no end date (nothing is removed).
UPDATE fee_credits SET expires_at = 'infinity' WHERE status = 'active' AND expires_at <> 'infinity';
