-- 2026-11-10-09-guest-verification.sql — a booking is only confirmed once the
-- guest's details are submitted and verified (owner, 10 Nov 2026).
-- Safe to run more than once; adds columns, two tables, indexes, one
-- function and one trigger. Removes nothing. Code: api/_guest-verify.js.
--
-- A VERIFIED PROFILE is: first and last name saved, the phone confirmed with
-- an SMS code, and a government photo ID verified.
--
-- Before this has run nothing changes: bookings confirm as they always did.
-- After it, payments of an unverified guest are HELD only while the Vercel
-- setting GUEST_VERIFICATION_REQUIRED=1 is on; without it the Profile simply
-- offers "Verify phone" and "Verify ID" as optional steps.

-- ---- 1. What is kept on the account -----------------------------------
-- Phone: when the number now on the account was confirmed by SMS code, and
-- which number that was (a different number on the account = not confirmed).
ALTER TABLE guests ADD COLUMN IF NOT EXISTS phone_verified_at     TIMESTAMPTZ;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS phone_verified_number TEXT;
-- ID: ONLY these five values. Never the image, the full number, the date of
-- birth, the address or the name printed on the ID.
ALTER TABLE guests ADD COLUMN IF NOT EXISTS guest_id_type        TEXT;         -- aadhaar | passport | driving_licence | voter_id
ALTER TABLE guests ADD COLUMN IF NOT EXISTS guest_id_last4       TEXT;         -- last 4 characters of the ID number
ALTER TABLE guests ADD COLUMN IF NOT EXISTS guest_id_name_match  TEXT;         -- exact | middle_names | checked_by_aerva
ALTER TABLE guests ADD COLUMN IF NOT EXISTS guest_id_verified_at TIMESTAMPTZ;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS guest_id_method      TEXT;         -- auto | aerva
ALTER TABLE guests DROP CONSTRAINT IF EXISTS guests_guest_id_method_check;
ALTER TABLE guests ADD CONSTRAINT guests_guest_id_method_check CHECK (guest_id_method IS NULL OR guest_id_method IN ('auto', 'aerva'));
ALTER TABLE guests DROP CONSTRAINT IF EXISTS guests_guest_id_type_check;
ALTER TABLE guests ADD CONSTRAINT guests_guest_id_type_check CHECK (guest_id_type IS NULL OR guest_id_type IN ('aadhaar', 'passport', 'driving_licence', 'voter_id'));

-- Whatever part of the site changes them: a new phone number is not a
-- confirmed number, and an ID verified for one name is not verified for
-- another. (A change of capitals or spacing only is not a change of name.)
CREATE OR REPLACE FUNCTION aerva_guest_verification_guard() RETURNS trigger AS $guard$
BEGIN
  IF NEW.phone IS DISTINCT FROM OLD.phone
     AND (NEW.phone IS NULL OR NEW.phone_verified_number IS DISTINCT FROM NEW.phone) THEN
    NEW.phone_verified_at := NULL;
    NEW.phone_verified_number := NULL;
  END IF;
  IF lower(regexp_replace(btrim(COALESCE(NEW.first_name, '')), '\s+', ' ', 'g')) IS DISTINCT FROM lower(regexp_replace(btrim(COALESCE(OLD.first_name, '')), '\s+', ' ', 'g'))
     OR lower(regexp_replace(btrim(COALESCE(NEW.last_name, '')), '\s+', ' ', 'g')) IS DISTINCT FROM lower(regexp_replace(btrim(COALESCE(OLD.last_name, '')), '\s+', ' ', 'g')) THEN
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
$guard$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_aerva_guest_verification_guard ON guests;
CREATE TRIGGER trg_aerva_guest_verification_guard BEFORE UPDATE ON guests
  FOR EACH ROW EXECUTE FUNCTION aerva_guest_verification_guard();

-- ---- 2. An ID sent to Aerva to check by hand ---------------------------
-- The image is in private storage only until an admin decides (Admin →
-- Verifications → Guest ID); it is then deleted and document_url cleared.
CREATE TABLE IF NOT EXISTS guest_id_reviews (
  id            SERIAL PRIMARY KEY,
  guest_id      INTEGER NOT NULL,
  document_url  TEXT,                                  -- cleared once the image is deleted
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  reason        TEXT,                                  -- why it was rejected (shown to the guest)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ,
  decided_by    TEXT,                                  -- the admin
  erased_at     TIMESTAMPTZ                            -- when the image was deleted from storage
);
-- One ID waiting per account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_id_reviews_one_pending ON guest_id_reviews (guest_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_guest_id_reviews_status ON guest_id_reviews (status, created_at);

-- ---- 3. A payment held until the guest's details are verified ----------
-- One row per Razorpay payment. No booking row exists while it waits: the
-- dates are kept by booking_holds, the coupon and any Aerva credit stay
-- claimed, and nothing is owed to the host. Verified in time → the booking
-- is written exactly as a normal one (order_ids). Not verified by
-- deadline_at → refunded in full to the payment, everything given back.
--   amount_paise / refund_amount: paise (as refunds.amount).
CREATE TABLE IF NOT EXISTS verification_holds (
  id                  SERIAL PRIMARY KEY,
  guest_id            INTEGER NOT NULL,
  guest_email         TEXT,
  razorpay_order_id   TEXT NOT NULL UNIQUE,
  razorpay_payment_id TEXT NOT NULL,
  amount_paise        BIGINT NOT NULL CHECK (amount_paise >= 0),
  charge_currency     TEXT NOT NULL DEFAULT 'INR',
  ctx                 JSONB NOT NULL,                  -- the checkout as paid (what _confirm-booking.js writes from)
  summary             JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{ listingId, roomId, name, arrival, departure, nights, guests, type }]
  listing_ids         INTEGER[] NOT NULL DEFAULT '{}',
  arrival             DATE NOT NULL,                   -- the earliest check-in in the payment
  timezone            TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  coupon_claimed      BOOLEAN NOT NULL DEFAULT false,
  credit_claimed      BOOLEAN NOT NULL DEFAULT false,
  status              TEXT NOT NULL DEFAULT 'waiting'
                      CHECK (status IN ('waiting', 'confirming', 'confirmed', 'conflict', 'refunding', 'refunded', 'attention')),
  --   waiting     paid; the guest's details are not verified yet
  --   confirming  being written as a booking (a few seconds)
  --   confirmed   the booking exists (order_ids)
  --   conflict    verified, but the dates had been blocked meanwhile: written cancelled and refunded by the normal rules
  --   refunding   the deadline passed: being refunded (a few seconds)
  --   refunded    refunded in full; no booking was made (refund_status says how the refund itself stands)
  --   attention   only partly written: for a person to finish (also in the audit log)
  paid_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at         TIMESTAMPTZ NOT NULL,            -- 24 h, or 10 AM on the check-in day, or 1 h (same-day)
  deadline_rule       TEXT NOT NULL DEFAULT '24h',     -- 24h | checkin_10am | same_day_1h
  cap_at              TIMESTAMPTZ NOT NULL,            -- 10 AM (property's time) on the check-in day
  extended_until      TIMESTAMPTZ,                     -- set when an ID was with Aerva at the deadline
  half_reminded_at    TIMESTAMPTZ,
  hour_reminded_at    TIMESTAMPTZ,
  claimed_at          TIMESTAMPTZ,
  decided_at          TIMESTAMPTZ,
  outcome             TEXT,                            -- what the guest was told
  order_ids           INTEGER[],
  refund_status       TEXT CHECK (refund_status IS NULL OR refund_status IN ('creating', 'pending', 'processed', 'failed')),
  refund_amount       BIGINT,
  razorpay_refund_id  TEXT,
  refund_claimed_at   TIMESTAMPTZ,
  refunded_at         TIMESTAMPTZ,
  refund_error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_verification_holds_guest ON verification_holds (guest_id, status);
CREATE INDEX IF NOT EXISTS idx_verification_holds_open ON verification_holds (deadline_at) WHERE status IN ('waiting', 'confirming', 'refunding');
CREATE INDEX IF NOT EXISTS idx_verification_holds_listings ON verification_holds USING gin (listing_ids);
