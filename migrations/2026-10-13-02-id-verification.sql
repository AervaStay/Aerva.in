-- 2026-10-13-02-id-verification.sql — instant ID verification
-- (api/_id-verify.js). Applied from Admin → Database updates. Safe to run
-- more than once; adds two columns, removes nothing.
--
-- The ID itself is never stored. Only the outcome is kept, e.g.
-- {"method":"document","docType":"passport","country":"IN","name":"Priya Mehta",
--  "last4":"4567","verifiedAt":"…","phone":"+91…","email":"…"}
ALTER TABLE guests ADD COLUMN IF NOT EXISTS id_verification JSONB;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS id_verified_at TIMESTAMPTZ;
