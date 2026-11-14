-- 2026-11-14-04 · Who is working a request, so the horizon on it is real
-- (owner, 14 Nov 2026: "I want to know horizon timeline that tells me where
-- we are with the issue").
--
-- The horizon reads every stage from somewhere that already exists — the
-- request's own status, the host step, the proposals and their sign-off —
-- except one: who it is assigned to. That is this.
--
--   assigned_to        the admin working it, or NULL for nobody
--   assigned_to_email  kept even if they later leave the team, so an old
--                      request still says who had it
--   assigned_at        when it was picked up
--
-- Assignment is by hand for now. The queue and its routing come next; this
-- column is what they will fill in.
--
-- Safe to run more than once. Adds columns only.

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_to       INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_to_email TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_at       TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS support_tickets_assigned_idx ON support_tickets (assigned_to, status);
