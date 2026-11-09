-- 2026-11-09-01-policy-update-sends.sql — who has been emailed about each
-- material change to Aerva's agreements and policies (AERVA_POLICIES.updates
-- in aerva-policies.js; job 'policy_update_notices', api/_policy-updates.js).
-- One row per update per account, so nobody is emailed twice.
CREATE TABLE IF NOT EXISTS policy_update_sends (
  update_id  text        NOT NULL,
  guest_id   integer     NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  emailed    boolean     NOT NULL DEFAULT false,
  PRIMARY KEY (update_id, guest_id)
);
CREATE INDEX IF NOT EXISTS policy_update_sends_guest ON policy_update_sends (guest_id);
