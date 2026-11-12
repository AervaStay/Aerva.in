-- 2026-11-12-06-name-first-fill.sql — filling in a name for the first time is
-- not a change of name, so it must not clear a verified ID.
-- Safe to run more than once; replaces one trigger function. Nothing else
-- changes: a real change of name still clears the ID, as it must.
--
-- Found on 12 Nov 2026 while building the gift rules. An account can have
-- its full name (guests.name) without the separate first_name / last_name
-- columns ever having been written — every account from before
-- migration_guest_details.sql is like that. The first booking after that
-- writes those two columns from the name typed at checkout, and the guard
-- in 2026-11-10-09-guest-verification.sql read "NULL → Lodha" as a change
-- of name and quietly erased a verified ID. The guest then had to verify
-- all over again, with nothing on screen saying why.
--
-- Now: the ID is cleared only when there WAS a name on the account and the
-- new one is different. NULL → a name (and a name → the same name, spaced
-- or capitalised differently) leaves the verification alone.

-- Only once 2026-11-10-09-guest-verification.sql has made the columns this
-- guard reads: on a database without them there is no guard to replace, and
-- creating one would break every update to a guest's row.
DO $wrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'guests' AND column_name = 'guest_id_verified_at') THEN
    RETURN;
  END IF;

  EXECUTE $fn$
CREATE OR REPLACE FUNCTION aerva_guest_verification_guard() RETURNS trigger AS $g$
DECLARE
  old_first TEXT := lower(regexp_replace(btrim(COALESCE(OLD.first_name, '')), '\s+', ' ', 'g'));
  old_last  TEXT := lower(regexp_replace(btrim(COALESCE(OLD.last_name, '')), '\s+', ' ', 'g'));
  new_first TEXT := lower(regexp_replace(btrim(COALESCE(NEW.first_name, '')), '\s+', ' ', 'g'));
  new_last  TEXT := lower(regexp_replace(btrim(COALESCE(NEW.last_name, '')), '\s+', ' ', 'g'));
BEGIN
  -- A new phone number is not a verified phone number.
  IF NEW.phone IS DISTINCT FROM OLD.phone
     AND (NEW.phone IS NULL OR NEW.phone_verified_number IS DISTINCT FROM NEW.phone) THEN
    NEW.phone_verified_at := NULL;
    NEW.phone_verified_number := NULL;
  END IF;
  -- An ID verified for one name is not verified for another. Writing a name
  -- where there was none is not that: it is the same person, written down.
  IF (old_first <> '' OR old_last <> '')
     AND (new_first IS DISTINCT FROM old_first OR new_last IS DISTINCT FROM old_last) THEN
    IF OLD.guest_id_verified_at IS NOT NULL AND NEW.guest_id_verified_at IS NOT DISTINCT FROM OLD.guest_id_verified_at THEN
      NEW.guest_id_type := NULL;
      NEW.guest_id_last4 := NULL;
      NEW.guest_id_name_match := NULL;
      NEW.guest_id_verified_at := NULL;
      NEW.guest_id_method := NULL;
    END IF;
  END IF;
  RETURN NEW;
END
$g$ LANGUAGE plpgsql;

  $fn$;
  EXECUTE 'DROP TRIGGER IF EXISTS trg_aerva_guest_verification_guard ON guests';
  EXECUTE 'CREATE TRIGGER trg_aerva_guest_verification_guard BEFORE UPDATE ON guests FOR EACH ROW EXECUTE FUNCTION aerva_guest_verification_guard()';
END
$wrap$;
