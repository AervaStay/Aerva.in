-- 2026-11-14-03 · "Do we need the host on this?" — the first decision a
-- customer representative makes on a request (owner, 14 Nov 2026, step 3 of
-- the support flow).
--
-- Before this, a representative could propose a refund without anyone ever
-- having asked the host what happened, and a reviewer had no way of
-- telling whether they had. Now it is a step of its own: answered before
-- an action can be submitted, with the host's own words kept beside it, so
-- the reviewer and the super admin can both see whether the other side was
-- heard before money was promised.
--
--   host_needed   NULL  = not decided yet (an action cannot be submitted)
--                 FALSE = the representative decided the host is not needed,
--                         and said why in host_no_reason
--                 TRUE  = the host was asked; host_ask holds the question
--   host_reply          what the host said, in their words
--   host_no_answer      set when the window passed with nothing from them —
--                       a silent host cannot stall a guest indefinitely
--
-- Safe to run more than once. Adds columns only.

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS host_needed      BOOLEAN;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS host_no_reason   TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS host_ask         TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS host_asked_at    TIMESTAMPTZ;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS host_asked_by    TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS host_reply       TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS host_replied_at  TIMESTAMPTZ;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS host_no_answer   BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS support_tickets_host_step_idx ON support_tickets (host_needed, host_asked_at DESC);
