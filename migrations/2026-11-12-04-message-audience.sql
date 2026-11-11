-- 2026-11-12-04-message-audience.sql — a notice in a booking's thread can be
-- for one side only (owner, 12 Nov 2026). Safe to run more than once; adds
-- one column. Removes nothing. Code: api/_cancellations.js (postThreadMessage),
-- api/guest-profile.js (the thread, the inbox and the unread count).
--
-- Why: when Aerva cancels a booking, the guest is told what comes back to
-- them and the host is told what it means for their payout. Until now both
-- sentences went to the one thread, so the host could see the guest's refund.
-- Now each notice says who it is for:
--   'both'  — what both sides should read (the default, so nothing changes
--             for every notice already written);
--   'host'  — the payout side of it;
--   'guest' — the refund side of it.
-- Admin sees everything, as before.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'both';

DO $aud$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_audience_check') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_audience_check
      CHECK (audience IN ('both', 'host', 'guest'));
  END IF;
END
$aud$;

CREATE INDEX IF NOT EXISTS idx_messages_audience ON messages (conversation_id, audience);
