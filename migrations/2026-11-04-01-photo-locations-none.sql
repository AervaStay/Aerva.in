-- 2026-11-04-01-photo-locations-none.sql — photos without a location.
-- Most phone uploads carry no location (phones strip it). Those are meant to
-- be recorded with an empty location (source 'none') so Admin → Live
-- Listings → "Photo locations to check" lists them, but the table required
-- a location, so every such photo failed to save and stopped the rest of
-- that save's photos being recorded.
ALTER TABLE photo_locations ALTER COLUMN lat DROP NOT NULL;
ALTER TABLE photo_locations ALTER COLUMN lng DROP NOT NULL;
-- The source rule allowed only located photos; add 'none'.
ALTER TABLE photo_locations DROP CONSTRAINT IF EXISTS photo_locations_source_check;
ALTER TABLE photo_locations ADD CONSTRAINT photo_locations_source_check CHECK (source IN ('photo', 'device', 'copied', 'none'));
