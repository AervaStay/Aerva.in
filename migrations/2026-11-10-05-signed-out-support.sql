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
--                  the account email when none was given) — replies go here,
--                  never to the account's own email
--   callback_phone the phone number they gave (E.164; existing column)
--   urgent         true: first in Admin → Support (added by 2026-11-09-04;
--                  repeated here so this file stands on its own)
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS account_email TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'web';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS urgent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE support_tickets ALTER COLUMN guest_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_tickets_account_email ON support_tickets (lower(account_email)) WHERE account_email IS NOT NULL;
