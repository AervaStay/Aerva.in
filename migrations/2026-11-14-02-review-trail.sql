-- 2026-11-14-02 · Who proposed it, who changed it, who signed it off
-- (owner, 14 Nov 2026).
--
-- The case timeline showed three proposals and no way to tell what had
-- actually been done: a proposal, its approval and its rejection were three
-- separate notes scattered through the thread, and a proposal to decline
-- was even worded in the past tense. The fix is to read a proposal's state
-- from the row itself — which means the row has to carry the whole trail.
--
-- The owner's workflow:
--   • A customer representative PROPOSES an action, picked from the list.
--   • A REVIEWER may approve it, CHANGE it and approve in one go, send it
--     BACK to the representative, or reject it. A reviewer who changes the
--     action and approves is deciding alone, and the owner chose that
--     deliberately on 14 Nov 2026 — so the change itself is recorded here,
--     beside what was originally proposed, and shows on the case for ever.
--   • A SUPER ADMIN keeps every power they already have, and additionally
--     signs a case off: Good to proceed, Reject, or Revert.
--
-- Nothing here deletes or rewrites a row. Safe to run more than once.

-- Sent back to the representative to do again. Not a rejection: nothing is
-- decided, and the representative may change it and propose it afresh.
ALTER TABLE support_actions DROP CONSTRAINT IF EXISTS support_actions_status_check;
-- awaiting_admin: the reviewer has approved it, and it is money, so it
-- waits for a super admin. Nothing is paid in this state (owner,
-- 14 Nov 2026: "unless admin takes action - no refund or any kind of
-- payout can be sent to guest or to host").
ALTER TABLE support_actions ADD CONSTRAINT support_actions_status_check
  CHECK (status IN ('pending', 'approving', 'done', 'failed', 'rejected', 'withdrawn', 'returned', 'awaiting_admin'));

-- What the representative asked for, kept when a reviewer changes it. Both
-- are shown on the case: the reviewer's version is what runs, and the
-- representative's is what they will be judged on.
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS original_kind     TEXT;
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS original_params   JSONB;
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS changed_by        INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS changed_by_email  TEXT;
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS changed_at        TIMESTAMPTZ;
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS change_note       TEXT;

-- Sent back: who, when, and what they want done differently.
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS returned_by       INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS returned_by_email TEXT;
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS returned_at       TIMESTAMPTZ;

-- A super admin's sign-off on what the representative and the reviewer did.
--   good     — satisfied; the case is closed to review.
--   rejected — the decision was wrong, on the record.
--   reverted — put right: the action goes back to be done again.
-- Money that has already left Aerva is not pulled back by any of these. A
-- refund that has gone to a card is gone; reverting records the decision
-- and says what has to be done by hand. Nothing here moves money.
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS signoff           TEXT;
ALTER TABLE support_actions DROP CONSTRAINT IF EXISTS support_actions_signoff_check;
ALTER TABLE support_actions ADD CONSTRAINT support_actions_signoff_check
  CHECK (signoff IS NULL OR signoff IN ('pay', 'good', 'rejected', 'reverted', 'revert_cr'));
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS signoff_by        INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS signoff_by_email  TEXT;
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS signoff_at        TIMESTAMPTZ;
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS signoff_note      TEXT;

CREATE INDEX IF NOT EXISTS support_actions_signoff_idx ON support_actions (signoff, reviewed_at DESC);
