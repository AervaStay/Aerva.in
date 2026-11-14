-- 2026-11-14-09-admin-password-set.sql
--
-- Owner, 14 Nov 2026: "I changed the Roles in admin account, I didn't
-- receive any email because I didn't login yet first time. Ideally, user
-- should get an email and then first time asked to setup password."
--
-- Nothing recorded whether an admin had ever set a password of their own.
-- An account added from Admin → Team is created with a hash of random
-- bytes, which no one can sign in with and which is indistinguishable from
-- a real one, so a role change could not tell "they have an account and a
-- password" from "they have never been able to get in at all".
ALTER TABLE admins ADD COLUMN IF NOT EXISTS password_set_at timestamptz;

-- Backfill. An account that has ever done anything in Admin has been
-- signed into, so its password works: those are marked as set. The ones
-- with no trace in the audit log at all have never been used, and are
-- left NULL — which is the case the owner hit. Marking on evidence rather
-- than marking everybody keeps set-password links from being sent to
-- people who do not need them, and marking everybody NULL would have sent
-- one to the whole team.
UPDATE admins a
   SET password_set_at = a.created_at
 WHERE a.password_set_at IS NULL
   AND EXISTS (
     SELECT 1 FROM admin_audit_log l
      WHERE l.admin_id = a.id
         OR lower(l.admin_email) = lower(a.email)
   );

COMMENT ON COLUMN admins.password_set_at IS
  'When this admin last chose their own password. NULL means they never have: they were invited and have not been in yet, so anything that changes their access emails them a link to set one.';
