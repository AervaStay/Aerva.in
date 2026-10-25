-- 2026-10-25-04-fee-rates.sql — Aerva's commission (hosts) and service fee
-- (guests), set per property type from Admin → Commission settings
-- (api/_rates.js). Applied from Admin → Database updates. Safe to run more
-- than once; adds tables and two starting rows, removes nothing.
--
-- One row per rate ever set. The rate for a booking is the row for its
-- audience and property type ('*' = every type without its own rate) with
-- the latest effective_from on or before the moment the booking is made.
-- A host rate takes effect at least 33 days after it is set (31 days'
-- notice + 2 days for time zones); a guest rate at once. Rows are never
-- edited or deleted: a scheduled change is withdrawn by marking it
-- cancelled, before it takes effect.
CREATE TABLE IF NOT EXISTS fee_rates (
  id             SERIAL PRIMARY KEY,
  audience       TEXT NOT NULL CHECK (audience IN ('host', 'guest')),
  property_type  TEXT NOT NULL DEFAULT '*',
  rate           NUMERIC(5,2) NOT NULL CHECK (rate >= 0 AND rate <= 50),
  effective_from TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     TEXT,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'set' CHECK (status IN ('set', 'cancelled')),
  cancelled_at   TIMESTAMPTZ,
  cancelled_by   TEXT,
  -- The 33-day rule, held by the database itself: a host rate can never
  -- take effect sooner than 33 days after it was set.
  CONSTRAINT fee_rates_host_notice CHECK (audience <> 'host' OR effective_from >= created_at + interval '33 days' OR COALESCE(note, '') = 'starting rate')
);
CREATE INDEX IF NOT EXISTS fee_rates_lookup ON fee_rates (audience, property_type, effective_from DESC);

-- The rates in force before this update: 5% for hosts and 5% for guests.
INSERT INTO fee_rates (audience, property_type, rate, effective_from, created_by, note)
SELECT 'host', '*', 5, '2026-01-01T00:00:00+05:30', 'system', 'starting rate'
WHERE NOT EXISTS (SELECT 1 FROM fee_rates WHERE audience = 'host');
INSERT INTO fee_rates (audience, property_type, rate, effective_from, created_by, note)
SELECT 'guest', '*', 5, '2026-01-01T00:00:00+05:30', 'system', 'starting rate'
WHERE NOT EXISTS (SELECT 1 FROM fee_rates WHERE audience = 'guest');

-- Each host told of a host rate change, and their answer. Never deleted.
CREATE TABLE IF NOT EXISTS fee_rate_notices (
  id              SERIAL PRIMARY KEY,
  rate_id         INTEGER NOT NULL,
  host_id         INTEGER NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  emailed         BOOLEAN NOT NULL DEFAULT false,
  acknowledged_at TIMESTAMPTZ,
  declined_at     TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,          -- agreement ended: not acknowledged by the effective date
  UNIQUE (rate_id, host_id)
);
CREATE INDEX IF NOT EXISTS fee_rate_notices_host ON fee_rate_notices (host_id);
