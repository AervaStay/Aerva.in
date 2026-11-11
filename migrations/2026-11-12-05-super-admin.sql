-- 2026-11-12-05-super-admin.sql — a super admin, and taking a team member off
-- the team (owner, 12 Nov 2026: "I see no option to remove team member. Only
-- Super Admin is allowed to take such action"). Safe to run more than once;
-- adds two columns and names the first super admin. Removes nothing.
--
--   admins.super_admin — may add and remove team members, and may make or
--                        unmake another super admin. Ordinary admins keep
--                        everything else they could already do.
--   admins.removed_at  — when they were taken off the team. The row itself
--                        is kept for ever: every approval, case record and
--                        audit line still names who did it. A removed member
--                        cannot sign in, cannot be emailed a reset link, and
--                        does not count as an admin.
--
-- The first super admin is the oldest admin account (the owner's own), so
-- there is always exactly one person who can do this from the start. Another
-- can be named from Admin → Team afterwards.

ALTER TABLE admins ADD COLUMN IF NOT EXISTS super_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

DO $sa$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins WHERE super_admin = true) THEN
    UPDATE admins SET super_admin = true
     WHERE id = (SELECT id FROM admins
                  WHERE COALESCE(role, 'admin') = 'admin' AND removed_at IS NULL
                  ORDER BY id LIMIT 1);
  END IF;
END
$sa$;
