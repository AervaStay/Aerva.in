-- 2026-11-10-06-whatsapp-otp.sql — mobile number codes on WhatsApp (owner,
-- 10 Nov 2026). api/_phone-otp.js, used by api/guest-phone-auth.js (phone
-- sign-in, confirming a guest's number) and api/host-listings.js (the host's
-- "Verify your phone number" step).
-- Safe to run more than once; adds one table, changes nothing else.
-- Until it has run, WhatsApp codes stay off (phone sign-in hidden, numbers
-- saved as typed, the host step says "not available yet").
--
-- One row per number and purpose ('guest' or 'host'): the latest code only.
-- The code itself is never stored — code_hash is an HMAC of it ('' once used
-- or when the message could not be sent). sent_count / created_at cap how
-- many codes one number gets in an hour; attempts caps wrong guesses.
CREATE TABLE IF NOT EXISTS phone_otps (
  phone        TEXT NOT NULL,
  purpose      TEXT NOT NULL CHECK (purpose IN ('guest', 'host')),
  code_hash    TEXT NOT NULL DEFAULT '',
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  sent_count   INTEGER NOT NULL DEFAULT 1,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (phone, purpose)
);
