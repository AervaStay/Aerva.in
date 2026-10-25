-- 2026-10-25-03-host-agreement.sql — the Aerva Host Agreement, accepted for
-- every listing, with revisions, records and copies (api/_host-agreement.js).
-- Applied from Admin → Database updates. Safe to run more than once; adds
-- columns and tables, removes nothing.

-- Which version each listing was submitted under, and when.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS host_agreement_version TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS host_agreement_accepted_at TIMESTAMPTZ;

-- On the host: the current acceptance (columns from migration_agreements.sql,
-- repeated here so this file works on its own), the revision notice sent,
-- and when the host last declined.
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS host_agreement_version TEXT;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS host_agreement_accepted_at TIMESTAMPTZ;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS host_agreement_ip TEXT;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS host_agreement_notice_version TEXT;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS host_agreement_notice_at TIMESTAMPTZ;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS host_agreement_declined_at TIMESTAMPTZ;

-- The exact text of every published version, as hosts saw it.
CREATE TABLE IF NOT EXISTS host_agreement_versions (
  version      TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  content      JSONB NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every acceptance (per listing, or per host for a revision), notice,
-- decline and termination. Never deleted.
CREATE TABLE IF NOT EXISTS host_agreement_acceptances (
  id          SERIAL PRIMARY KEY,
  host_id     INTEGER NOT NULL,
  guest_id    INTEGER,
  listing_id  INTEGER,
  version     TEXT NOT NULL,
  action      TEXT NOT NULL DEFAULT 'accepted',   -- accepted | notified | declined | terminated
  ip          TEXT,
  via         TEXT,
  emailed     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS host_agreement_acceptances_host ON host_agreement_acceptances (host_id, created_at);
