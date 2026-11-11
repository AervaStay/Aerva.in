-- 2026-11-12-01-digilocker.sql — verifying a guest's ID through DigiLocker
-- (owner, 11 Nov 2026). Safe to run more than once; adds one table and
-- widens one CHECK. Removes nothing. Code: api/_digilocker.js.
--
-- The guest logs in to their own DigiLocker and approves sharing their
-- Aadhaar. Aerva reads the name, the date of birth and the masked number,
-- checks them, and keeps only what the photo-ID check already keeps:
-- guest_id_type / _last4 / _name_match / _verified_at / _method. The photo,
-- the address and the full Aadhaar number are never stored.

-- 'digilocker' joins 'auto' (read from a photo) and 'aerva' (checked by hand).
-- Only once 2026-11-10-09-guest-verification.sql has made the column.
DO $dl$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'guests' AND column_name = 'guest_id_method') THEN
    ALTER TABLE guests DROP CONSTRAINT IF EXISTS guests_guest_id_method_check;
    ALTER TABLE guests ADD CONSTRAINT guests_guest_id_method_check
      CHECK (guest_id_method IS NULL OR guest_id_method IN ('auto', 'aerva', 'digilocker'));
  END IF;
END
$dl$;

-- One row per time a guest is sent to DigiLocker. No personal data beyond
-- the profile name the check was started for, which is on the account anyway.
CREATE TABLE IF NOT EXISTS digilocker_checks (
  id              BIGSERIAL PRIMARY KEY,
  guest_id        BIGINT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  verification_id TEXT NOT NULL UNIQUE,
  reference_id    TEXT,
  provider        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'verified', 'refused', 'expired', 'denied')),
  reason          TEXT,
  profile_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS digilocker_checks_guest_idx ON digilocker_checks (guest_id, created_at DESC);
