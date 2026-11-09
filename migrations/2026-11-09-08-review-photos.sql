-- 2026-11-09-08-review-photos.sql — guests can add photos to a review
-- (owner, 9 Nov 2026): up to 5 photos of the stay per review, Aerva Blob
-- URLs only. Each photo goes through the contact-details check
-- (_photo-guard.js); one that shows a phone number, email, QR code and so
-- on is taken out of the review silently and the admin is told
-- (Admin → Removed photos). Admin can also remove a single photo from a
-- review (Admin → Review policy → Reviews with photos).
--
-- Until this runs, reviews are still accepted, without photos, and the
-- guest is told photos are not switched on yet.
ALTER TABLE listing_reviews ADD COLUMN IF NOT EXISTS photos JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'listing_reviews_photos_max5') THEN
    ALTER TABLE listing_reviews ADD CONSTRAINT listing_reviews_photos_max5
      CHECK (jsonb_typeof(photos) = 'array' AND jsonb_array_length(photos) <= 5);
  END IF;
END $$;

-- The admin's "Reviews with photos" list reads only reviews that have some.
CREATE INDEX IF NOT EXISTS idx_listing_reviews_with_photos ON listing_reviews (created_at DESC)
  WHERE photos <> '[]'::jsonb;
