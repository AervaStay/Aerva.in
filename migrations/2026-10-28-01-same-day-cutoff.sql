-- 2026-10-28-01-same-day-cutoff.sql — until what time a host accepts a
-- booking for the same night (Manage listing → Same-day bookings).
-- Applied from Admin → Database updates. Safe to run more than once; adds
-- one column, removes nothing.
--
-- The hour on the property's clock (18 = 6 PM … 23 = 11 PM, 24 = 12 AM,
-- i.e. all day). Before it, a guest may book tonight; from it, the earliest
-- check-in is tomorrow. A booking at 11:59 PM on 25 November with 12 AM is
-- for 25–26 November. Every listing starts at 12 AM.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS same_day_until SMALLINT NOT NULL DEFAULT 24;
DO $$ BEGIN
  ALTER TABLE listings ADD CONSTRAINT listings_same_day_until_range CHECK (same_day_until BETWEEN 18 AND 24);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
