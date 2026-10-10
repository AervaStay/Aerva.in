-- 2026-10-10-02-privacy-settings.sql — Account Settings → Privacy
-- (api/_profiles.js PRIVACY_OPTIONS). Applied from Admin → Database
-- updates. Safe to run more than once; adds one column, removes nothing.
--
-- One small JSON object per account, e.g. {"show_photo": false}. A setting
-- that is not in it is ON, so every existing profile looks exactly as it
-- does today until its owner switches something off.
ALTER TABLE guests ADD COLUMN IF NOT EXISTS privacy_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
