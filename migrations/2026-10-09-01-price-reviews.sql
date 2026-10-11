-- 2026-10-09-01-price-reviews.sql — unusual price changes wait for approval
-- (api/_price-review.js). Applied from Admin → Database updates. Safe to
-- run more than once.
--
-- A host's price, discount or promotion change on a live listing that is
-- unusual (a sharp drop, below the minimum, or a very large discount) is
-- kept here instead of going live. Guests keep seeing the current price
-- until a reviewer or admin approves it in Admin → Approvals.
CREATE TABLE IF NOT EXISTS price_reviews (
  id                SERIAL PRIMARY KEY,
  listing_id        INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('rate', 'discount', 'promotion')),
  old_value         JSONB,
  new_value         JSONB NOT NULL,
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  requested_by      TEXT,
  requested_by_type TEXT,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by       TEXT,
  reviewed_at       TIMESTAMPTZ,
  review_note       TEXT
);
CREATE INDEX IF NOT EXISTS price_reviews_pending_idx ON price_reviews (status, listing_id);
