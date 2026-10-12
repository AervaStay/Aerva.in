-- 2026-10-13-01-checkin-send-schedule.sql — when a home's check-in
-- instructions are sent to the guest (Manage → Guest Check-In Info →
-- Scheduling; api/_template-scheduling.js). Applied from Admin → Database
-- updates. Safe to run more than once; adds columns and a table, removes
-- nothing.
--
--   checkin_send_trigger          booking_confirmed | before_checkin | checkin_day
--   checkin_send_offset_minutes   for before_checkin: how long before check-in
--   checkin_send_also_on_confirm  also send once straight away on confirmation
-- Homes already set to send on confirmation keep exactly that.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS checkin_send_trigger TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS checkin_send_offset_minutes INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS checkin_send_also_on_confirm BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE listings SET checkin_send_trigger = 'booking_confirmed'
WHERE auto_send_checkin_instructions = TRUE AND checkin_send_trigger IS NULL;

-- One row per booking and send, so the instructions never reach the same
-- guest twice for the same reason ('confirmed' / 'scheduled').
CREATE TABLE IF NOT EXISTS checkin_info_sends (
  order_id INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, kind)
);

-- An exact time of day for scheduled messages: "on check-in day at 10:00",
-- "1 day before check-in at 18:00" (HH:MM, 24-hour, the property's clock).
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS send_at_time TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS checkin_send_at_time TEXT;
