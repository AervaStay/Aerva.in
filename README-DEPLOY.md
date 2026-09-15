# Aerva — deploy notes

## Order matters

1. **Run `migration_reviews.sql` in Neon first.** Every statement is
   additive and `IF NOT EXISTS` guarded, so it is safe to re-run and safe
   to apply while the current build is still live. Deploying the code
   without it makes every review submission fail on a missing table.
2. **Check `package.json` against your repo before overwriting it.** The
   copy here adds `pdfkit`, which `api/verify-payment.js` imports at the
   top level. If your live `package.json` already lists it at a different
   version, keep yours — your working build is the proof that version is
   fine.
3. Deploy the whole tree together. Several changes span a page and its
   endpoint and will misbehave if only one side ships.

## Layout

    api/            23 files — 12 endpoints, 11 shared helpers (_ prefix)
    *.html          pages, served from the repo root
    vercel.json     two cron jobs (the Hobby limit)
    migration_reviews.sql

Vercel's Hobby plan caps serverless functions at 12. **You are at exactly
12.** Every file in `api/` without a leading underscore counts; the
underscore-prefixed helpers do not. A 13th endpoint fails the whole
deploy, which is why new features fold into existing endpoints as query
modes rather than new files.

## Pairs that must ship together

- `index.html` + `api/guest-auth.js` — the host-only nav is gated on
  `hasActiveListing`, which only the new auth returns. The page alone
  against the old endpoint hides the host nav from everyone.
- `index.html` + `api/_template-scheduling.js` — both carry the
  `@checkininfo` placeholder fix.
- `host-earnings.html` + `api/host-listings.js` — analytics reads a mode
  that only the new endpoint serves.
- `index.html` + `api/get-listings.js` — ratings and host badges.

## Crons

    0 0 * * *   /api/get-listings?refreshCurrencyRates=1
    0 2 * * *   /api/get-listings?reviewSweep=1

The review sweep publishes reviews that are due and prompts guests who
have checked out. Hobby caps cron at once per day, so "published
immediately once both sides review" is really "within a day". On Pro,
change the schedule alone — no code change.

## After deploying

- Open a booking chat as a guest and confirm messages render (the XSS fix
  path in `renderChatMessages`).
- Open the host dashboard with a Resort listing: Manage and Clone only,
  and no sidebar calendar should auto-open.
- Check the admin tool's new **Review Policy** tab loads.

Host badges and star ratings will not appear on any listing until real
reviews exist and the sweep has published them. That is expected, not a
fault.
