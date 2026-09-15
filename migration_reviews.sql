-- migration_reviews.sql
-- Run in Neon BEFORE deploying the code that uses it. Every statement is
-- additive and IF NOT EXISTS guarded, so it is safe to re-run and safe to
-- apply while the current code is still live: nothing here changes a
-- column the deployed build already reads.
--
-- Two tables, one per direction:
--   listing_reviews — a GUEST reviewing a PROPERTY, on five factors
--   guest_reviews   — a HOST reviewing a GUEST, extended here from a
--                     single blended rating to four factors
--
-- See _review-policy.js for the rules these columns exist to support.

-- ---------------------------------------------------------------------
-- Guest reviews a property.
CREATE TABLE IF NOT EXISTS listing_reviews (
  id             SERIAL PRIMARY KEY,
  order_id       INTEGER NOT NULL REFERENCES orders(id),
  listing_id     INTEGER NOT NULL REFERENCES listings(id),
  room_id        INTEGER,
  guest_id       INTEGER NOT NULL REFERENCES guests(id),
  host_id        INTEGER NOT NULL REFERENCES hosts(id),

  -- All five mandatory, 1-5. NOT NULL plus the CHECK is what makes the
  -- "a review without ratings is not a review" rule true in the database
  -- rather than only in the endpoint that happens to write it.
  hygiene        NUMERIC NOT NULL CHECK (hygiene       BETWEEN 1 AND 5),
  communication  NUMERIC NOT NULL CHECK (communication BETWEEN 1 AND 5),
  services       NUMERIC NOT NULL CHECK (services      BETWEEN 1 AND 5),
  value_rating   NUMERIC NOT NULL CHECK (value_rating  BETWEEN 1 AND 5),
  location       NUMERIC NOT NULL CHECK (location      BETWEEN 1 AND 5),

  -- Mandatory, and never scored. Length floor stops a single character
  -- satisfying "a comment is required".
  comment        TEXT NOT NULL CHECK (length(btrim(comment)) >= 10),

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- NULL while held. Set when both sides have reviewed, or when the
  -- 15-day window closes. A stored timestamp rather than a computed flag
  -- so "when did this become public" is answerable later.
  published_at   TIMESTAMPTZ,

  -- Admin override. A reverted review is withdrawn from display AND from
  -- every tier calculation. Kept rather than deleted so a dispute can be
  -- re-examined and the audit trail survives.
  admin_reverted_at    TIMESTAMPTZ,
  admin_reverted_by    INTEGER,
  admin_revert_reason  TEXT,

  reported_at    TIMESTAMPTZ,
  reported_reason TEXT,

  -- One review per booking. This is the constraint doing the real work:
  -- without it a guest could review the same stay repeatedly and drown a
  -- host's average.
  CONSTRAINT listing_reviews_one_per_order UNIQUE (order_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_reviews_listing ON listing_reviews (listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_reviews_host    ON listing_reviews (host_id);
CREATE INDEX IF NOT EXISTS idx_listing_reviews_pending ON listing_reviews (published_at) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------
-- Host reviews a guest. The table already exists with a single `rating`
-- and `comment`; these add the four-factor breakdown alongside it.
--
-- Deliberately NULLable, unlike listing_reviews above: rows written
-- before this migration have no factor scores and must stay valid. New
-- rows are required to carry all four by the endpoint, and _tiers.js
-- treats a row with no factors as no review at all — see the
-- unrated-review fallback there.
ALTER TABLE guest_reviews ADD COLUMN IF NOT EXISTS cleanliness   NUMERIC CHECK (cleanliness   BETWEEN 1 AND 5);
ALTER TABLE guest_reviews ADD COLUMN IF NOT EXISTS communication NUMERIC CHECK (communication BETWEEN 1 AND 5);
ALTER TABLE guest_reviews ADD COLUMN IF NOT EXISTS respectful    NUMERIC CHECK (respectful    BETWEEN 1 AND 5);
ALTER TABLE guest_reviews ADD COLUMN IF NOT EXISTS rules         NUMERIC CHECK (rules         BETWEEN 1 AND 5);

ALTER TABLE guest_reviews ADD COLUMN IF NOT EXISTS published_at        TIMESTAMPTZ;
ALTER TABLE guest_reviews ADD COLUMN IF NOT EXISTS admin_reverted_at   TIMESTAMPTZ;
ALTER TABLE guest_reviews ADD COLUMN IF NOT EXISTS admin_reverted_by   INTEGER;
ALTER TABLE guest_reviews ADD COLUMN IF NOT EXISTS admin_revert_reason TEXT;
ALTER TABLE guest_reviews ADD COLUMN IF NOT EXISTS reported_at         TIMESTAMPTZ;
ALTER TABLE guest_reviews ADD COLUMN IF NOT EXISTS reported_reason     TEXT;

-- Existing rows predate publication rules and are already visible. Backfill
-- published_at so they are not swept up as "held" by the daily job and
-- suddenly re-published weeks later.
UPDATE guest_reviews SET published_at = created_at WHERE published_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_reviews_one_per_order ON guest_reviews (order_id);
CREATE INDEX IF NOT EXISTS idx_guest_reviews_guest   ON guest_reviews (guest_id);
CREATE INDEX IF NOT EXISTS idx_guest_reviews_pending ON guest_reviews (published_at) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------
-- Tracks that the post-checkout prompt was sent, so the daily sweep does
-- not message the same guest every morning until they review.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_prompt_sent_at TIMESTAMPTZ;
