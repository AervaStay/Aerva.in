-- 2026-11-14-05 · What Aerva spends on the Anthropic API each day, and the
-- ceiling it will not go past (owner, 14 Nov 2026: "add both. Let me know
-- the cap").
--
-- Before this there was no record of AI spend at all and no platform-wide
-- limit. The guest chat assistant had a per-account message limit (20 an
-- hour, 80 a day), so one person could not loop it — but nothing capped the
-- platform as a whole, and the team's own suggestion clicks, which are the
-- expensive calls, had no limit whatsoever.
--
-- One row per IST day, per kind of call, per person who triggered it:
--
--   kind        'chat' (guest assistant), 'suggest' (reply cards for the
--               guest), 'host_suggest' (reply cards for the host),
--               'host_summary' (the neutral summary sent to the host)
--   by_email    the admin who clicked, or NULL for a guest-triggered call
--   by_key      by_email or '' — NULL does not group in a unique index, and
--               the daily totals are kept by upsert, so the key cannot be
--               nullable
--   cost_inr    worked out from the model's published rates and the token
--               counts the API itself reported, not estimated from calls
--
-- Caps are environment variables, not data, so they can be raised without a
-- deploy: AI_DAILY_RUPEES (400), AI_DAILY_CALLS (500),
-- AI_ADMIN_DAILY_CALLS (60), AI_USD_INR (89).
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS ai_usage (
  day                DATE    NOT NULL,
  kind               TEXT    NOT NULL,
  by_email           TEXT,
  by_key             TEXT GENERATED ALWAYS AS (COALESCE(by_email, '')) STORED,
  calls              INTEGER NOT NULL DEFAULT 0,
  input_tokens       BIGINT  NOT NULL DEFAULT 0,
  output_tokens      BIGINT  NOT NULL DEFAULT 0,
  cache_read_tokens  BIGINT  NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT  NOT NULL DEFAULT 0,
  cost_inr           NUMERIC(12, 4) NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_day_kind_by_idx ON ai_usage (day, kind, by_key);
CREATE INDEX IF NOT EXISTS ai_usage_day_idx ON ai_usage (day DESC);
