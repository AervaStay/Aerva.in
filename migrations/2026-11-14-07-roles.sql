-- 2026-11-14-07 · Roles the owner can create, each with the tabs it may use
-- (owner, 14 Nov 2026: "Admin can create roles and also can define tabs that
-- will be allowed against that role").
--
-- Until now the three roles were written into the code — admin, reviewer and
-- customer representative — and what each could reach was a hard-coded list
-- of request keys. Neither could be changed without a deploy.
--
--   key      what admins.role holds. Lower case, letters, digits and
--            underscores, so it is safe in a URL and in a CSS class.
--   label    what a person sees: "Payouts clerk", "Night shift".
--   tabs     the tabs this role may open, as a JSON array of tab keys.
--            It is the WHOLE permission: the server works out which
--            requests to allow from the tabs, so a role cannot reach an
--            endpoint belonging to a tab it does not have.
--   builtin  the three that shipped. They can have their tabs changed but
--            cannot be deleted, so there is always a role to fall back on.
--
-- admins.role becomes a foreign key. That matters for two reasons: a role
-- that somebody is using cannot be deleted (ON DELETE RESTRICT), and a typo
-- cannot put an admin into a role that does not exist — which used to mean
-- FULL ADMIN ACCESS, because roleOf() treated any unrecognised role as
-- 'admin'. That fallback is gone with this.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS admin_roles (
  key         TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  label       TEXT NOT NULL CHECK (btrim(label) <> ''),
  tabs        JSONB NOT NULL DEFAULT '[]'::jsonb,
  builtin     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT,
  updated_at  TIMESTAMPTZ,
  updated_by  TEXT
);

-- The three that already existed, with exactly what they could reach before
-- this migration, so nobody's access changes on the day it is run.
-- 'admin' keeps every tab; it is the role that manages the others.
INSERT INTO admin_roles (key, label, tabs, builtin) VALUES
  ('admin', 'Admin', '["approvals","approvals_decide","team","roles","safety","db","lookup","listings","live","compliance","verifications","contact","rates","insights","accounts","money","payouts","deposits","support","trust","policy","simulator","batch","traffic","audit","policies"]'::jsonb, true),
  ('reviewer', 'Reviewer', '["lookup","support","approvals","approvals_decide","policies"]'::jsonb, true),
  ('agent', 'Customer representative', '["lookup","support","approvals","policies"]'::jsonb, true)
ON CONFLICT (key) DO UPDATE SET builtin = true;

-- Anybody whose role is not one of the three (there should be none) is put
-- on 'agent' rather than left pointing at nothing, so the foreign key below
-- can be added without failing.
UPDATE admins SET role = 'agent'
 WHERE role IS NULL OR role NOT IN (SELECT key FROM admin_roles);

-- The old CHECK listed the three role names; it would refuse every new role.
ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_role_check;
ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_role_fkey;
ALTER TABLE admins
  ADD CONSTRAINT admins_role_fkey FOREIGN KEY (role)
  REFERENCES admin_roles (key) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS admins_role_idx ON admins (role);
