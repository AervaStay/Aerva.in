-- 2026-11-13-01 · "The place is real, but something is different."
--
-- The owner's rules (13 Nov 2026):
--   • A guest who can still stay, but found the listing wrong on some
--     point — the wall is a different colour, the sofa is not that sofa —
--     files a CORRECTION. It is not a dispute:
--       – no money moves, in either direction;
--       – the host's payout is not held;
--       – nothing is held against the host. They are ADVISED to put the
--         listing right, with no deadline and no penalty.
--   • Aerva reads it and either advises the host, drops it, or — if it
--     turns out to be serious — escalates it by hand into a stay dispute
--     or the check-in promise. There is no automatic escalation and no
--     count of corrections that trips anything: Aerva decides case by
--     case.
--   • Filing one still confirms the place is real, because it is: the
--     guest is standing in it. So it sets orders.guest_confirmed_stay_at
--     exactly as "This place is real and as listed" does.
--
-- Safe to run more than once. Nothing here changes existing rows.

CREATE TABLE IF NOT EXISTS listing_corrections (
  id              SERIAL PRIMARY KEY,
  order_id        INTEGER NOT NULL REFERENCES orders(id),
  listing_id      INTEGER NOT NULL,
  host_id         INTEGER,
  guest_id        INTEGER,
  what            TEXT NOT NULL,              -- the guest's own words
  photos          JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 'guest': the guest filed it from the check-in card.
  -- 'stepped_down': Aerva turned a heavier report into this one.
  source          TEXT NOT NULL DEFAULT 'guest' CHECK (source IN ('guest', 'stepped_down')),
  -- 'open'      : Aerva has not looked yet
  -- 'advised'   : Aerva asked the host to put the listing right
  -- 'dropped'   : the listing is right, or it is too small to act on
  -- 'escalated' : Aerva moved it to a dispute or the check-in promise
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'advised', 'dropped', 'escalated')),
  report_id       INTEGER,                    -- the check-in report it was stepped down from
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One open correction per booking, so the card cannot be used to spam.
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_corrections_open ON listing_corrections (order_id)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_listing_corrections_listing ON listing_corrections (listing_id, status);
CREATE INDEX IF NOT EXISTS idx_listing_corrections_queue ON listing_corrections (status, created_at DESC);

-- A check-in report can now end a third way: real, but the listing is
-- wrong. The payout is released, nothing is held against the host, and a
-- correction row is written in its place. This is what catches a guest who
-- picked the heavy option over something small — which will happen however
-- carefully the card is worded.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'checkin_reports') THEN
    ALTER TABLE checkin_reports DROP CONSTRAINT IF EXISTS checkin_reports_status_check;
    ALTER TABLE checkin_reports ADD CONSTRAINT checkin_reports_status_check
      CHECK (status IN ('open', 'cleared', 'confirmed', 'rebooking', 'refunding', 'rebooked', 'refunded', 'corrected'));
  END IF;
END $$;
