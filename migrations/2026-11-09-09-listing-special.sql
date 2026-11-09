-- 2026-11-09-09-listing-special.sql — optional listing extras the host
-- writes on the list-property form and on Manage listing
-- (api/_listing-special.js):
--   special_highlights       "What's special about this place?" — up to 5 short highlights
--   special_story            "The story of this place" — one paragraph, up to 600 characters
--   host_recommendations     "Recommended by your host" — up to 10 { kind, name, note, distance, link }
--   suggested_experience_ids up to 6 live Aerva experiences shown while a guest books this stay
-- Safe to run more than once. Until it runs, listings save without these
-- (the save skips them with a note) and pages show nothing for them.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS special_highlights JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS special_story TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS host_recommendations JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS suggested_experience_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
