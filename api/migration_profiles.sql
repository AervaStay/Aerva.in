-- migration_profiles.sql
-- Profile fields for the one account a person has, whether they book,
-- host, or both. Every statement is additive and IF NOT EXISTS guarded,
-- so it is safe to re-run and safe to apply while the current build is
-- still live: nothing here changes a column the deployed code reads.
--
-- Run in Neon BEFORE deploying the code that uses it. Without it, saving
-- a profile fails on a missing column.

-- What they do and what they enjoy. Two plain columns rather than free
-- text, because these two are asked of everyone and are what a host or
-- guest actually scans for.
ALTER TABLE guests ADD COLUMN IF NOT EXISTS profile_work    TEXT;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS profile_hobbies TEXT;

-- The "get to know" answers, keyed by question id (see PROFILE_QUESTIONS
-- in api/_profiles.js). jsonb rather than a column per question so a new
-- question is a code change, not another migration — and an answer to a
-- question later withdrawn simply stops being read.
ALTER TABLE guests ADD COLUMN IF NOT EXISTS profile_about   JSONB;

-- When they last touched it. Shown as "updated in March" on their own
-- profile, and useful for knowing whether a profile is stale.
ALTER TABLE guests ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ;
