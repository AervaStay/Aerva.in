-- 2026-11-09-05-nearby-places.sql — "Nearby" on each listing: things to do
-- and getting around (metro, trains, buses, taxis, airports), from
-- OpenStreetMap, kept per listing for 30 days (api/_nearby.js).
CREATE TABLE IF NOT EXISTS nearby_places (
  listing_id INTEGER PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  lat        NUMERIC,
  lng        NUMERIC,
  data       JSONB,
  fetched_at TIMESTAMPTZ,
  failed_at  TIMESTAMPTZ
);
