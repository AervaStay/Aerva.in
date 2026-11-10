-- 2026-11-10-08-cohost-coupon-requests.sql — a co-host who paid the guest's
-- 10% cancellation coupon may ask the host to cover it (owner, 10 Nov 2026).
-- Safe to run more than once; adds a table, two columns and indexes, and
-- widens one check. Removes nothing. Code: api/_cohost-coupon.js.
--
-- The co-host still pays the coupon before the cancellation goes through.
-- Asking the host is optional: on the cancel screen, or later (within 30
-- days of the cancellation). The host's own account accepts or declines
-- within 7 days; no answer = expired. One request per cancelled booking,
-- ever (the unique index below) — a declined or expired one cannot be sent
-- again.
--
-- If the host accepts, Aerva only moves the amount between two payouts:
--   • host_penalties row, kind 'cohost_coupon' (one per request: unique
--     index) — deducted from the host's NEXT payout by api/_payouts.js,
--     after TDS, exactly like other amounts a host owes;
--   • when that payout is actually sent, a payout row of its own to the
--     co-host, payouts.kind 'cohost-coupon' (one per booking and co-host:
--     idx_payouts_once_per_kind) — no commission, no fee, no TDS
--     (tds 0, tds_base 0, tds_fy NULL: a reimbursement, not income).
-- Money is never paid to the co-host before it is taken from the host.
--
-- Before this has run nothing breaks: the option is simply not offered.

CREATE TABLE IF NOT EXISTS cohost_coupon_requests (
  id               SERIAL PRIMARY KEY,
  order_id         INTEGER NOT NULL,                            -- the cancelled booking (orders.id)
  host_id          INTEGER NOT NULL,                            -- who is asked (hosts.id)
  cohost_guest_id  INTEGER NOT NULL,                            -- who paid the coupon and asks (guests.id)
  coupon_id        INTEGER,                                     -- the coupon they paid for
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),   -- ₹, what the co-host paid
  note             TEXT,                                        -- to the host, up to 300 characters, contact details removed
  asked_from       TEXT NOT NULL DEFAULT 'cancel',              -- 'cancel' (tick box) | 'later' (earnings view)
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'accepted', 'reimbursed', 'declined', 'expired', 'closed')),
  --   pending     waiting for the host (until expires_at)
  --   accepted    the host agreed: waiting to be deducted from the host's next payout
  --   reimbursed  deducted from the host; the co-host's payout row exists (cohost_payout_id)
  --   declined    the host said no: nothing moves through Aerva
  --   expired     no answer in 7 days: nothing moves through Aerva
  --   closed      accepted, but Aerva wrote the host's amount off: nothing moves
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  decided_at       TIMESTAMPTZ,
  decided_by       INTEGER,                                     -- the host's account (guests.id); NULL when expired
  host_payout_id   INTEGER,                                     -- the host payout it was deducted from
  cohost_payout_id INTEGER,                                     -- the payout row that pays the co-host
  reimbursed_at    TIMESTAMPTZ
);
-- One request per cancelled booking, whatever became of it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cohost_coupon_requests_order ON cohost_coupon_requests (order_id);
CREATE INDEX IF NOT EXISTS idx_cohost_coupon_requests_host ON cohost_coupon_requests (host_id, status);
CREATE INDEX IF NOT EXISTS idx_cohost_coupon_requests_cohost ON cohost_coupon_requests (cohost_guest_id);

-- The host's deduction for an accepted request: at most one, ever.
ALTER TABLE host_penalties ADD COLUMN IF NOT EXISTS cohost_coupon_request_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_host_penalties_cohost_coupon_request ON host_penalties (cohost_coupon_request_id)
  WHERE cohost_coupon_request_id IS NOT NULL;

-- The co-host's reimbursement is a payout row of its own.
ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_kind_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_kind_check CHECK (
  (kind IN ('booking', 'deposit', 'cohost-coupon') OR kind ~ '^(adjustment|rest)-[0-9]+$')
  AND (kind <> 'deposit' OR payee_type = 'host')
  AND (kind <> 'cohost-coupon' OR payee_type = 'cohost')
);
