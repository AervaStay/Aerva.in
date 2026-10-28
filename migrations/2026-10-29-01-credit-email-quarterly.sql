-- 2026-10-29-01-credit-email-quarterly.sql — Aerva credit reminders.
-- The pop-up at sign-in keeps using last_reminder_at / reminders_sent.
-- The email now goes once a quarter (15 Feb, 15 May, 15 Aug, 15 Nov);
-- this records when each credit's guest was last emailed.
ALTER TABLE fee_credits ADD COLUMN IF NOT EXISTS last_email_at TIMESTAMPTZ;
-- The old 15-day emails used last_reminder_at; the pop-up count starts
-- fresh so guests see it on their next sign-ins.
UPDATE fee_credits SET reminders_sent = 0, last_reminder_at = NULL WHERE status = 'active' AND remaining > 0;
