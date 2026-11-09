-- 2026-11-09-11-gift-group.sql — gift bookings and group (split-payment)
-- bookings (owner's rules, 9 Nov 2026). api/_gifts.js, api/_group-bookings.js.
-- Safe to run more than once. Until it has run, both options answer
-- "not switched on yet" and normal bookings are untouched.

-- ---- Gift bookings ----
-- One gift per purchase (orders.razorpay_order_id of the booking row it is
-- attached to). The buyer keeps the booking; the recipient is the guest
-- staying. The link token is stored only as a hash; it is single-use and
-- ends at check-out. Accepting needs the recipient's name and a phone.
CREATE TABLE IF NOT EXISTS booking_gifts (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  buyer_guest_id INTEGER NOT NULL,
  buyer_first_name TEXT,
  recipient_first_name TEXT NOT NULL,
  recipient_last_name TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_phone TEXT,
  message TEXT,
  token_hash TEXT NOT NULL,
  token_used_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'sent',
  accepted_guest_id INTEGER,
  accepted_at TIMESTAMPTZ,
  accepted_first_name TEXT,
  accepted_last_name TEXT,
  accepted_phone TEXT,
  accepted_via TEXT,
  reminded_3d_at TIMESTAMPTZ,
  reminded_1d_at TIMESTAMPTZ,
  cancel_notified_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE booking_gifts DROP CONSTRAINT IF EXISTS booking_gifts_status_check;
ALTER TABLE booking_gifts ADD CONSTRAINT booking_gifts_status_check CHECK (status IN ('sent', 'accepted', 'withdrawn'));
ALTER TABLE booking_gifts DROP CONSTRAINT IF EXISTS booking_gifts_via_check;
ALTER TABLE booking_gifts ADD CONSTRAINT booking_gifts_via_check CHECK (accepted_via IS NULL OR accepted_via IN ('email', 'token'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_gifts_one_live ON booking_gifts (order_id) WHERE status <> 'withdrawn';
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_gifts_token ON booking_gifts (token_hash);
CREATE INDEX IF NOT EXISTS idx_booking_gifts_recipient ON booking_gifts (lower(recipient_email));
CREATE INDEX IF NOT EXISTS idx_booking_gifts_accepted ON booking_gifts (accepted_guest_id) WHERE accepted_guest_id IS NOT NULL;

-- ---- Group (split-payment) bookings ----
-- The organiser's checkout opens a group for the whole quote, split equally
-- by guests (shares[] per place, whole rupees, remainder on the last places).
-- Dates are held in booking_holds for the 2 hours (and the 30 minutes the
-- organiser has to confirm a smaller booking).
CREATE TABLE IF NOT EXISTS group_bookings (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  organiser_guest_id INTEGER NOT NULL,
  organiser_first_name TEXT,
  organiser_last_name TEXT,
  organiser_email TEXT NOT NULL,
  listing_id INTEGER NOT NULL,
  room_id INTEGER,
  arrival DATE NOT NULL,
  departure DATE NOT NULL,
  places INTEGER NOT NULL CHECK (places >= 2),
  stay JSONB NOT NULL,
  total INTEGER NOT NULL CHECK (total > 0),
  shares INTEGER[] NOT NULL,
  agreement TEXT,
  prices JSONB,
  status TEXT NOT NULL DEFAULT 'starting',
  hold_order_id TEXT,
  opened_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  confirm_by TIMESTAMPTZ,
  requote JSONB,
  requote_total INTEGER,
  paid_places INTEGER,
  gap INTEGER,
  order_id INTEGER REFERENCES orders(id),
  outcome TEXT,
  decided_at TIMESTAMPTZ,
  reminded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE group_bookings DROP CONSTRAINT IF EXISTS group_bookings_status_check;
ALTER TABLE group_bookings ADD CONSTRAINT group_bookings_status_check CHECK (status IN
  ('starting', 'open', 'awaiting_confirm', 'awaiting_gap', 'confirming', 'confirmed', 'cancelled', 'failed'));
CREATE INDEX IF NOT EXISTS idx_group_bookings_live ON group_bookings (status, closes_at) WHERE status IN ('starting', 'open', 'awaiting_confirm', 'awaiting_gap', 'confirming');
CREATE INDEX IF NOT EXISTS idx_group_bookings_organiser ON group_bookings (organiser_guest_id);
CREATE INDEX IF NOT EXISTS idx_group_bookings_order ON group_bookings (order_id) WHERE order_id IS NOT NULL;

-- One payment attempt: specific places (kind 'places') or the organiser's
-- top-up for a dearer smaller booking (kind 'gap'). amount in rupees;
-- refund_amount in paise (as refunds.amount).
CREATE TABLE IF NOT EXISTS group_claims (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES group_bookings(id),
  guest_id INTEGER NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  kind TEXT NOT NULL DEFAULT 'places',
  places INTEGER NOT NULL DEFAULT 0,
  seats INTEGER[] NOT NULL DEFAULT '{}',
  amount INTEGER NOT NULL CHECK (amount > 0),
  razorpay_order_id TEXT UNIQUE,
  razorpay_payment_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'open',
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  failed_reason TEXT,
  refund_amount INTEGER,
  refund_status TEXT,
  razorpay_refund_id TEXT,
  refund_reason TEXT,
  refund_claimed_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE group_claims DROP CONSTRAINT IF EXISTS group_claims_status_check;
ALTER TABLE group_claims ADD CONSTRAINT group_claims_status_check CHECK (status IN ('open', 'paid', 'failed', 'released', 'rejected'));
ALTER TABLE group_claims DROP CONSTRAINT IF EXISTS group_claims_kind_check;
ALTER TABLE group_claims ADD CONSTRAINT group_claims_kind_check CHECK (kind IN ('places', 'gap'));
ALTER TABLE group_claims DROP CONSTRAINT IF EXISTS group_claims_refund_status_check;
ALTER TABLE group_claims ADD CONSTRAINT group_claims_refund_status_check CHECK (refund_status IS NULL OR refund_status IN ('creating', 'pending', 'processed', 'failed'));
CREATE INDEX IF NOT EXISTS idx_group_claims_group ON group_claims (group_id, status);
CREATE INDEX IF NOT EXISTS idx_group_claims_guest ON group_claims (guest_id);

-- Each place can be held by one live claim only: the primary key makes
-- paying for the same place twice (two friends in the same instant)
-- impossible. A released, failed or refused claim gives its places back.
CREATE TABLE IF NOT EXISTS group_seats (
  group_id INTEGER NOT NULL REFERENCES group_bookings(id),
  seat INTEGER NOT NULL,
  claim_id INTEGER NOT NULL REFERENCES group_claims(id),
  PRIMARY KEY (group_id, seat)
);

-- The booking a group became.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS group_booking_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_orders_group_booking ON orders (group_booking_id) WHERE group_booking_id IS NOT NULL;

-- A group booking's deposit goes back to each payer's own payment, one
-- refund per payment ('deposit:<payment>'), as cancellations already do.
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_kind_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_kind_check CHECK (
  kind IN ('cancellation', 'deposit', 'deposit_dispute')
  OR kind ~ '^cancellation:.+$'
  OR kind ~ '^deposit:.+$'
  OR kind ~ '^change-[0-9]+:.+$'
  OR kind ~ '^change-pay-[0-9]+$'
  OR kind ~ '^dispute-[0-9]+:.+$'
  OR kind ~ '^goodwill-[0-9]+(:.+)?$'
) NOT VALID;
