-- 2026-10-07-03-roles-approvals.sql — team roles, proposed actions with
-- reviewer approval, reports on hosts and guests, and blocking one guest
-- from one listing. Applied from Admin → Database updates. Safe to re-run.

-- Admin accounts get a role. Everyone who already has an account stays an
-- admin; Admin → Team sets the roles of the others.
--   admin    — everything
--   reviewer — approves or rejects proposed actions; Support and Lookup
--   agent    — customer representative: Support and Lookup, proposes actions
ALTER TABLE admins ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_role_check;
ALTER TABLE admins ADD CONSTRAINT admins_role_check CHECK (role IN ('admin', 'reviewer', 'agent'));

-- An action a representative proposes and a reviewer approves before
-- anything happens. Nobody approves their own proposal.
CREATE TABLE IF NOT EXISTS support_actions (
  id                SERIAL PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('cancel_refund', 'partial_refund', 'deposit_refund', 'report_guest', 'report_host', 'block_guest_listing')),
  ticket_id         INTEGER REFERENCES support_tickets(id) ON DELETE SET NULL,
  order_id          INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  guest_id          INTEGER REFERENCES guests(id) ON DELETE SET NULL,
  listing_id        INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  params            JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason            TEXT NOT NULL,
  summary           TEXT,                     -- the conversation, summarised for the reviewer
  preview           JSONB,                    -- what it would do, worked out when proposed
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approving', 'done', 'failed', 'rejected', 'withdrawn')),
  proposed_by       INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  proposed_by_email TEXT,
  proposed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by       INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  reviewed_by_email TEXT,
  reviewed_at       TIMESTAMPTZ,
  review_note       TEXT,
  result            JSONB,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS support_actions_status_idx ON support_actions (status, proposed_at DESC);
CREATE INDEX IF NOT EXISTS support_actions_ticket_idx ON support_actions (ticket_id);
CREATE INDEX IF NOT EXISTS support_actions_order_idx ON support_actions (order_id);

-- A report on a host or a guest (from an approved action, or by an admin).
CREATE TABLE IF NOT EXISTS user_reports (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('guest', 'host')),
  guest_id    INTEGER REFERENCES guests(id) ON DELETE SET NULL,   -- the guest reported, or the host's own account
  listing_id  INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  order_id    INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  ticket_id   INTEGER REFERENCES support_tickets(id) ON DELETE SET NULL,
  action_id   INTEGER REFERENCES support_actions(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  resolution  TEXT
);
CREATE INDEX IF NOT EXISTS user_reports_guest_idx ON user_reports (guest_id);
CREATE INDEX IF NOT EXISTS user_reports_listing_idx ON user_reports (listing_id);

-- One guest kept away from one listing: it no longer shows to them, and
-- they cannot book it or enquire about it.
CREATE TABLE IF NOT EXISTS listing_guest_blocks (
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  guest_id   INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  reason     TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, guest_id)
);
CREATE INDEX IF NOT EXISTS listing_guest_blocks_guest_idx ON listing_guest_blocks (guest_id);
