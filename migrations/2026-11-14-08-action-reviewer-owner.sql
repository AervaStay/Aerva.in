-- 2026-11-14-08-action-reviewer-owner.sql
--
-- Owner, 14 Nov 2026: "Reveiwers cant take action on other reviewer request."
--
-- reviewed_by says who last decided a proposal and returned_by says who sent
-- it back, and both are wiped or overwritten as the proposal moves: a
-- repropose clears returned_by, and the super admin's gate run deliberately
-- leaves reviewed_by alone. So neither can answer "whose proposal is this?"
-- after a round trip — a reviewer could send one back, the representative
-- could raise it again, and a DIFFERENT reviewer could then decide it, which
-- is the thing the owner ruled out.
--
-- reviewer_owner is set the first time any reviewer touches a proposal and is
-- never cleared or moved. It is a claim, not a decision: it says who the
-- proposal belongs to for the rest of its life, whatever the status does
-- afterwards. A super admin stands outside it and may always act.
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS reviewer_owner integer REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE support_actions ADD COLUMN IF NOT EXISTS reviewer_owner_email text;

-- Proposals already decided keep the reviewer whose name is on them.
UPDATE support_actions
   SET reviewer_owner = COALESCE(reviewed_by, returned_by),
       reviewer_owner_email = COALESCE(reviewed_by_email, returned_by_email)
 WHERE reviewer_owner IS NULL
   AND COALESCE(reviewed_by, returned_by) IS NOT NULL;

CREATE INDEX IF NOT EXISTS support_actions_reviewer_owner_idx ON support_actions (reviewer_owner) WHERE reviewer_owner IS NOT NULL;
