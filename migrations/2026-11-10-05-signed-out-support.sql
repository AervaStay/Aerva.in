-- 2026-11-10-05-signed-out-support.sql — "Can't sign in?" (owner, 10 Nov 2026).
-- api/_support.js createSignedOutRequest, api/guest-auth.js mode
-- 'support-signed-out', aerva-help.js (index.html?view=help&signin=1).
-- Safe to run more than once; adds columns and an index, removes nothing.
-- Until it has run, the "Can't sign in?" form answers "not open yet" (503);
-- nothing else on the site is affected.
--
-- A person who cannot sign in (suspended, locked out after an email change,
-- or not receiving codes) raises a request without an account. It is a
-- support ticket with channel 'signed_out' and category 'account_access':
--   guest_id       the account whose email matches, or NULL (already nullable)
--   account_email  the email they say is on their account
--   contact_email  where Aerva writes to them (the "reach me at" email, or
--                  the account email when none was given) — the link to their
--                  request and "Aerva Support replied" notices go here, never
--                  to the account's own email
--   callback_phone the phone number they gave (E.164; existing column)
--   urgent         true: first in Admin → Support (added by 2026-11-09-04;
--                  repeated here so this file stands on its own)
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS account_email TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'web';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS urgent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE support_tickets ALTER COLUMN guest_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_tickets_account_email ON support_tickets (lower(account_email)) WHERE account_email IS NOT NULL;

-- Private request links (owner, 10 Nov 2026): the person follows their
-- request and chats with Aerva Support on index.html?view=help&request=SR-…&key=…
-- without signing in. Only a SHA-256 hash of each key is stored, never the key.
-- A ticket can have several live keys: the one given on creation, and one in
-- each "Aerva Support replied" email notice (the key itself cannot be read back
-- to put in a later email). "Get a new link" revokes every key of the request
-- and issues one. A key opens only its own request, and only while it is open
-- or for 30 days after it is resolved or closed (worked out from the ticket's
-- resolved_at / closed_at; nothing extra stored). "Read" uses the ticket's
-- existing user_last_seen_at. Before this table exists, requests are still
-- taken and the emails simply carry no link.
CREATE TABLE IF NOT EXISTS support_ticket_keys (
  id           BIGSERIAL PRIMARY KEY,
  ticket_id    INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL,
  issued_for   TEXT NOT NULL DEFAULT 'created',   -- created | notice | new_link
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_ticket_keys_hash ON support_ticket_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_support_ticket_keys_ticket ON support_ticket_keys (ticket_id) WHERE revoked_at IS NULL;
