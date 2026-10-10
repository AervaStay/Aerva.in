-- 2026-10-10-01-clean-city-names.sql — one clean name per place, so each
-- city has one "Stays in …" page (api/_city-names.js has the same rules for
-- new and edited listings). Applied from Admin → Database updates. Safe to
-- run more than once; it only rewrites city names, nothing is removed.

-- "Pune Division", "Mawal Subdistrict", "Kullu District" → the place itself.
UPDATE listings
SET city = btrim(regexp_replace(city, '\s+(division|sub-?district|district|tehsil|taluka|taluk)\.?$', '', 'i'))
WHERE city ~* '\s+(division|sub-?district|district|tehsil|taluka|taluk)\.?$'
  AND btrim(regexp_replace(city, '\s+(division|sub-?district|district|tehsil|taluka|taluk)\.?$', '', 'i')) <> '';

-- Misspellings and old names.
UPDATE listings SET city = 'Jabalpur' WHERE lower(btrim(city)) = 'jablpur';
UPDATE listings SET city = 'Mumbai'   WHERE lower(btrim(city)) = 'bombay';
UPDATE listings SET city = 'Pune'     WHERE lower(btrim(city)) = 'poona';
UPDATE listings SET city = 'Kochi'    WHERE lower(btrim(city)) = 'cochin';
UPDATE listings SET city = 'Gurugram' WHERE lower(btrim(city)) = 'gurgaon';

-- Mawal / Maval is the sub-district around Lonavala: homes within about
-- 20 km of Lonavala become Lonavala; any others keep "Maval".
UPDATE listings
SET city = CASE
  WHEN latitude IS NOT NULL AND longitude IS NOT NULL
   AND 6371 * 2 * asin(sqrt(
         power(sin(radians(latitude::float8 - 18.7546) / 2), 2)
       + cos(radians(18.7546)) * cos(radians(latitude::float8)) * power(sin(radians(longitude::float8 - 73.4062) / 2), 2)
       )) <= 20
  THEN 'Lonavala' ELSE 'Maval' END
WHERE lower(btrim(city)) IN ('mawal', 'maval');
