-- 2026-10-13-04-offers-email.sql — the quarterly offers email to guests
-- who have not booked lately (api/_offers-email.js). Applied from Admin →
-- Database updates. Safe to run more than once; adds one table, removes nothing.
--
-- One row per guest per quarter ("2026-Q4"): the database itself refuses a
-- second email in the same quarter. A failed send is marked 'failed' and
-- tried again; nothing is deleted. Guests switch the emails off in Account
-- Settings → Privacy (guests.privacy_settings.offers_email = false).
CREATE TABLE IF NOT EXISTS offer_email_sends (
  guest_id     INTEGER NOT NULL,
  quarter      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'sending',
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guest_id, quarter)
);
