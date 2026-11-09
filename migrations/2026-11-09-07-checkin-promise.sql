-- 2026-11-09-07-checkin-promise.sql — Aerva's check-in promise (owner's
-- rules, 9 Nov 2026; api/_checkin-promise.js). Safe to run more than once;
-- adds tables and columns, removes nothing.
--
--   • A guest reports on arrival (My Bookings → Report a problem), with
--     photos: "The property doesn't exist (fake listing)" or "Not as
--     listed / not available". Aerva confirms or clears the report.
--   • Fake listing: that listing is hidden at once and its unsent payouts
--     held; confirmed → that listing is blocked (only Aerva unblocks it) and
--     its future bookings go to Admin to rebook or refund each guest.
--   • Confirmed (either reason): the guest is offered other places (pays
--     only the difference; a cheaper place leaves Aerva credit) or is
--     refunded in full, service fee included. That booking's host is not
--     paid; anything already paid out is deducted from later payouts.
--   • Until one guest confirms "this place is real and as listed", every
--     booking of a listing has its payout held until that booking's
--     check-out time (released then if no report is open).

-- One report per row. status: open → confirmed → rebooked | refunded, or
-- open → cleared. reason: 'fake' | 'not_as_listed'. source: 'guest_report'
-- (the guest reported it) | 'listing_review' (a future booking of a listing
-- Aerva blocked as fake, sent by Aerva to rebook or refund).
CREATE TABLE IF NOT EXISTS checkin_reports (
  id                 SERIAL PRIMARY KEY,
  order_id           INTEGER NOT NULL REFERENCES orders(id),
  dispute_id         INTEGER REFERENCES stay_disputes(id) ON DELETE SET NULL,
  listing_id         INTEGER NOT NULL,
  host_id            INTEGER,
  guest_id           INTEGER,
  reason             TEXT NOT NULL CHECK (reason IN ('fake', 'not_as_listed')),
  source             TEXT NOT NULL DEFAULT 'guest_report' CHECK (source IN ('guest_report', 'listing_review')),
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cleared', 'confirmed', 'rebooking', 'refunding', 'rebooked', 'refunded')),
  listing_status_before TEXT,             -- what the listing was before it was hidden (fake reports)
  original           JSONB,               -- the booking as it was, for the guest's one summary
  offers             JSONB NOT NULL DEFAULT '[]'::jsonb,
  offers_sent_at     TIMESTAMPTZ,
  rebook_change_id   INTEGER,
  rebook_order_id    INTEGER,
  difference         INTEGER,             -- ₹: + paid by the guest, − held as Aerva credit
  credit_amount      INTEGER,
  refund_amount      INTEGER,
  recovered_from_host NUMERIC(12,2),
  guest_ticket_id    INTEGER,
  host_ticket_id     INTEGER,
  decided_by         TEXT,
  decided_at         TIMESTAMPTZ,
  decision_note      TEXT,
  closed_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One report being handled per booking at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_reports_active ON checkin_reports (order_id)
  WHERE status IN ('open', 'confirmed', 'rebooking', 'refunding');
CREATE INDEX IF NOT EXISTS idx_checkin_reports_listing ON checkin_reports (listing_id, status);

-- Listings: blocked by Aerva as fake (only Aerva unblocks), and checked
-- (a guest confirmed it is real and as listed: later bookings are not asked).
ALTER TABLE listings ADD COLUMN IF NOT EXISTS checkin_blocked_at TIMESTAMPTZ;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS checkin_verified_at TIMESTAMPTZ;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS checkin_verified_order_id INTEGER;

-- Bookings: the guest confirmed the place is real and as listed; the
-- check-in email asking them was sent; and, on a booking made under the
-- promise, the booking it replaced.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_confirmed_stay_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stay_confirm_emailed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkin_rebook_of INTEGER;
CREATE INDEX IF NOT EXISTS idx_orders_checkin_rebook_of ON orders (checkin_rebook_of) WHERE checkin_rebook_of IS NOT NULL;

-- A listing that has already hosted a completed paid stay is real: it
-- starts out checked, so its payouts keep their usual timing. Only listings
-- with no finished stay yet wait for a guest's confirmation.
UPDATE listings l SET checkin_verified_at = now(),
       checkin_verified_order_id = (SELECT o.id FROM orders o WHERE o.listing_id = l.id AND o.status = 'paid' AND o.departure < CURRENT_DATE ORDER BY o.departure LIMIT 1)
WHERE l.checkin_verified_at IS NULL
  AND EXISTS (SELECT 1 FROM orders o WHERE o.listing_id = l.id AND o.status = 'paid' AND o.departure < CURRENT_DATE);
