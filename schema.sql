-- schema.sql
-- Run this in Neon's SQL Editor. Safe to re-run — every statement uses
-- IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, so running it again won't
-- error or duplicate anything if you already ran an earlier version.

-- =========================================================
-- LISTINGS — property submissions from "List Your Property"
-- =========================================================
CREATE TABLE IF NOT EXISTS listings (
  id SERIAL PRIMARY KEY,

  property_name TEXT NOT NULL,
  city TEXT NOT NULL,
  property_type TEXT,
  bedrooms TEXT,
  max_guests TEXT,
  nightly_rate INTEGER,
  description TEXT NOT NULL,

  amenities JSONB DEFAULT '[]',
  services JSONB DEFAULT '[]',

  host_name TEXT NOT NULL,
  host_email TEXT NOT NULL,
  host_phone TEXT NOT NULL,

  -- Every submission starts pending. Only 'approved' listings should ever
  -- be shown on the live site or accept bookings.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Discounts a host can offer (e.g. "10% off stays of 3+ nights").
-- discount_type: 'percentage', 'flat', or NULL if the host isn't offering one.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS discount_type TEXT
  CHECK (discount_type IN ('percentage', 'flat') OR discount_type IS NULL);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS discount_value NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS discount_min_nights INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS discount_description TEXT;

-- Public URLs of photos uploaded via Vercel Blob (browser uploads directly,
-- these URLs get saved here after upload — see api/blob-upload.js).
ALTER TABLE listings ADD COLUMN IF NOT EXISTS photo_urls JSONB DEFAULT '[]';

-- =========================================================
-- HOSTS — real accounts, one per property owner
-- =========================================================
CREATE TABLE IF NOT EXISTS hosts (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hosts_email ON hosts (email);

-- Links a listing to a real host account. Nullable and kept alongside the
-- existing host_name/host_email/host_phone text fields on purpose — older
-- listings submitted before accounts existed still work and display fine;
-- they're just not tied to a login. New submissions set this properly.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS host_id INTEGER REFERENCES hosts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_listings_host_id ON listings (host_id);

-- Photos split by category. photo_urls above is kept for backward
-- compatibility but no longer written to — these two are the real source
-- going forward.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS exterior_photo_urls JSONB DEFAULT '[]';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS interior_photo_urls JSONB DEFAULT '[]';

-- The host's explicit pick for the lead/thumbnail photo, from either
-- category — see submit-listing.js. NULL means no explicit choice was
-- made, in which case the site falls back to its automatic default
-- (interior photos shown first — see aerva.html's buildSuiteCard).
ALTER TABLE listings ADD COLUMN IF NOT EXISTS cover_photo_url TEXT;

-- Commission Aerva takes on this listing's bookings, as a percentage.
-- This is set by Aerva, not the host — same as Airbnb's host service fee.
-- Stored per-listing so you can vary it per property later if you want to,
-- even though every new submission gets the same default today.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS commission_rate NUMERIC NOT NULL DEFAULT 15;

-- Photo(s) for the listing. Since there's no separate file-storage service
-- set up (see README), photos are stored as data URIs (base64-encoded
-- images) directly in this column — the same technique the original 5
-- hardcoded suite cards used. This works fine at small scale but grows
-- the database fast; see README for the upgrade path (Vercel Blob) once
-- listing volume or photo count grows.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS photos JSONB DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings (status);

-- Allow a fourth status: 'draft', for listings a host has started but not
-- yet submitted for review. Postgres names an inline column CHECK
-- constraint <table>_<column>_check by default, which is what this
-- assumes — if this specific ALTER fails, check the real constraint name
-- with: SELECT conname FROM pg_constraint WHERE conrelid = 'listings'::regclass;
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_status_check;
ALTER TABLE listings ADD CONSTRAINT listings_status_check
  CHECK (status IN ('draft', 'pending', 'approved', 'rejected'));

-- Set when an admin rejects a listing (see approve-listing.js) — the host
-- sees this in their rejection email, explaining what to fix. NULL for
-- every other status.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Captured via Google Places Autocomplete on the listing form (see
-- aerva.html) — latitude/longitude power the "X km away" distance shown
-- to guests, and formatted_address is the clean, standardized address
-- string Google returns (more reliable than free-typed city text alone).
ALTER TABLE listings ADD COLUMN IF NOT EXISTS latitude NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS longitude NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS formatted_address TEXT;


-- =========================================================
-- PRICE_HISTORY — a running log of nightly-rate changes per listing
-- =========================================================
CREATE TABLE IF NOT EXISTS price_history (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  nightly_rate INTEGER NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_history_listing ON price_history (listing_id);


-- =========================================================
-- ORDERS — every completed booking, across both the current hardcoded
-- suites and (later) database-backed listings
-- =========================================================
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,

  -- Today's live Reserve form books one of 5 hardcoded suites by name —
  -- it isn't yet wired to the `listings` table. suite_name always gets
  -- filled in; listing_id only fills in once a booking is for a real
  -- database-backed listing (a feature not built yet — see README).
  suite_name TEXT NOT NULL,
  listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,

  guest_email TEXT NOT NULL,
  arrival DATE NOT NULL,
  departure DATE NOT NULL,
  guests INTEGER NOT NULL,
  nights INTEGER NOT NULL,

  subtotal INTEGER NOT NULL,      -- before GST, in rupees
  discount_amount INTEGER NOT NULL DEFAULT 0,
  gst INTEGER NOT NULL,
  total INTEGER NOT NULL,         -- what the guest actually paid, in rupees

  commission_rate NUMERIC NOT NULL,
  commission_amount INTEGER NOT NULL,  -- Aerva's cut, in rupees
  payout_amount INTEGER NOT NULL,      -- what the host is owed, in rupees

  razorpay_order_id TEXT NOT NULL,
  razorpay_payment_id TEXT,

  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'refunded', 'cancelled')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================
-- GUESTS — real guest accounts (email + password), separate from hosts.
-- Bookings can happen with or without an account (orders.guest_email
-- always gets filled in regardless), but a logged-in guest gets their
-- past/upcoming stays tied to a persistent account.
-- =========================================================
CREATE TABLE IF NOT EXISTS guests (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE,

  -- Never a plain-text password — always a bcrypt hash (see guest-auth.js).
  -- Even if this table were ever exposed, raw passwords are never sitting
  -- in it. Nullable because a guest who signs up via phone/OTP (see
  -- guest-phone-auth.js) never sets a password at all.
  password_hash TEXT,

  -- Phone-based accounts (OTP login via Twilio Verify — see
  -- guest-phone-auth.js). Stored in E.164 format (e.g. +919876543210).
  -- Nullable because an email/password guest may never provide one.
  phone TEXT,

  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A guest needs at least one way to log in — either an email account or a
-- verified phone, though nothing stops them having both.
ALTER TABLE guests DROP CONSTRAINT IF EXISTS guests_email_or_phone_check;
ALTER TABLE guests ADD CONSTRAINT guests_email_or_phone_check
  CHECK (email IS NOT NULL OR phone IS NOT NULL);

-- These two ALTERs are only needed because this table may already exist
-- from an earlier version of this schema with NOT NULL on both columns —
-- safe to run even on a fresh table where they're already nullable.
ALTER TABLE guests ALTER COLUMN email DROP NOT NULL;
ALTER TABLE guests ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS phone TEXT;

CREATE INDEX IF NOT EXISTS idx_guests_email ON guests (email);
-- A plain UNIQUE column constraint can't be conditional, but phone should
-- only be unique when it's actually set (many rows will have NULL phone).
CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_phone_unique ON guests (phone) WHERE phone IS NOT NULL;

-- Guest's own profile photo, uploaded via Vercel Blob (same pattern as
-- listing photos — see blob-upload.js). Nullable: shown as a letter
-- avatar in the nav/profile until the guest uploads one.
ALTER TABLE guests ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;

-- An email/password account can't log in until this flips to true — see
-- guest-auth.js. Defaults false for everyone, but only actually matters
-- for email+password accounts; a phone/OTP account (guest-phone-auth.js)
-- is inherently verified the moment Twilio confirms the code, so this
-- column is simply never checked on that login path.
ALTER TABLE guests ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- =========================================================
-- Linking one person's guest and host identities together.
-- Aerva has a single login (always through this guests table — see
-- guest-auth.js / guest-phone-auth.js) that can act as both a traveller
-- and a host. hosts stays a separate table (listings, approvals, and
-- payouts all key off it already), but each hosts row now points back to
-- the one guests row that owns it, and vice versa. Both are nullable —
-- most guests never become hosts — and UNIQUE, since a hosts row belongs
-- to exactly one guest account, never shared.
-- =========================================================
ALTER TABLE guests ADD COLUMN IF NOT EXISTS host_id INTEGER UNIQUE REFERENCES hosts(id) ON DELETE SET NULL;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS guest_id INTEGER UNIQUE REFERENCES guests(id) ON DELETE SET NULL;

-- guests is the single master account table — everyone signs up and logs
-- in through it. account_type reflects what that account can do: every
-- account can book stays ('guest'); once host_id gets linked (see
-- submit-listing.js, which sets it the first time someone lists a
-- property), the same account can also manage listings ('guest_host').
--
-- This is a GENERATED column rather than one the app sets directly —
-- Postgres computes it straight from host_id on every read, so it's
-- structurally impossible for it to drift out of sync with the actual
-- link (unlike a plain column, which some future code path could update
-- incorrectly or forget to update at all).
ALTER TABLE guests DROP COLUMN IF EXISTS account_type;
ALTER TABLE guests ADD COLUMN account_type TEXT GENERATED ALWAYS AS (
  CASE WHEN host_id IS NOT NULL THEN 'guest_host' ELSE 'guest' END
) STORED;

-- =========================================================
-- GUEST_REVIEWS — a host's review of a guest after a completed stay.
-- This is the guest-facing counterpart to how Airbnb hosts rate guests;
-- it's what the "Valued/Trusted Guest / Aerva Favorite" badges on a
-- guest's profile are computed from (see guest-profile.js).
-- =========================================================
CREATE TABLE IF NOT EXISTS guest_reviews (
  id SERIAL PRIMARY KEY,

  -- One review per completed booking — a host can't review the same
  -- stay twice. ON DELETE CASCADE: if the underlying order is ever
  -- deleted, its review goes with it rather than becoming orphaned.
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,

  guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  -- Who wrote it. ON DELETE SET NULL rather than CASCADE: if a host
  -- account is ever removed, the review itself (and its effect on the
  -- guest's badge) should still stand.
  host_id INTEGER REFERENCES hosts(id) ON DELETE SET NULL,
  listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,

  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_guest_reviews_guest ON guest_reviews (guest_id);

-- Links a booking to a real guest account, same nullable pattern as
-- listings.host_id — older/guest-checkout orders made without an account
-- simply have this NULL; orders.guest_email keeps working exactly as
-- before either way.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_orders_guest_id ON orders (guest_id);


CREATE INDEX IF NOT EXISTS idx_orders_listing ON orders (listing_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC);


-- =========================================================
-- AUDIT_LOG — a record of every meaningful action taken across the
-- platform, success and failure alike (host logins, listing approvals,
-- submissions, pricing changes, etc.) — kept separate from price_history
-- since that table is specifically about rate changes over time, while
-- this is general-purpose and spans every kind of action.
-- =========================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,

  -- What happened, e.g. 'listing_approved', 'host_login_requested',
  -- 'host_login_failed', 'listing_submitted', 'pricing_updated'.
  -- Free-text rather than an enum so new action types can be added from
  -- application code without a migration each time.
  action TEXT NOT NULL,

  -- Whether this action succeeded or failed — kept as its own column
  -- (rather than folded into `action` as e.g. 'host_login_failed') so you
  -- can filter/count failures across every action type in one query,
  -- without having to know every '_failed' variant that exists.
  success BOOLEAN NOT NULL,

  -- Who did it. actor_type is one of 'admin', 'host', 'guest', 'system'
  -- (for automated/background actions with no human actor).
  -- actor_identifier is whatever identifies them for that type — a host's
  -- email, 'admin', etc. Nullable: some failures happen before an actor
  -- can even be identified, e.g. an invalid token with no valid payload.
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'host', 'guest', 'system')),
  actor_identifier TEXT,

  -- What the action was performed on, e.g. target_type='listing',
  -- target_id=42. Nullable for actions with no single target, like a
  -- login request before a host row exists yet.
  target_type TEXT,
  target_id INTEGER,

  -- Action-specific detail that doesn't deserve its own column — e.g.
  -- {"old_rate": 4000, "new_rate": 4500} for a pricing change, or
  -- {"reason": "invalid_email", "resend_status": 422} for a failed send.
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);
