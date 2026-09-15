# Changed files only

Everything here differs from the set you uploaded. Files not in this
bundle are untouched — leave them alone.

## Order

1. Run `migration_reviews.sql` in Neon. Additive and `IF NOT EXISTS`
   guarded, so it is safe to re-run and safe to apply while the current
   build is still live. The code below fails on a missing table without it.
2. Deploy everything in this bundle **together**. Several changes span a
   page and its endpoint.
3. Optional: `seed_dummy_reviews.sql` for test data, then hit
   `/api/get-listings?reviewSweep=1` once to let the sweep publish it.

## Contents

    api/_tiers.js              NEW — guest and host tier ladders
    api/_review-policy.js      NEW — publication rules + written policy
    api/get-listings.js        review sweep cron, host badges, star ratings
    api/get-pending-listings.js  admin policy tab, conflicts, revert
    api/guest-auth.js          hasActiveListing on the session check
    api/guest-profile.js       guest submits a property review
    api/host-listings.js       host reviews a guest; analytics endpoint
    api/verify-payment.js      booking-confirmed template trigger
    admin-...html              Review Policy tab
    host-dashboard.html        Resort gating; earnings moved out
    host-earnings.html         NEW — analytics + earnings page
    index.html                 XSS fix, filters, card restyle, ratings, menu
    package.json               adds pdfkit
    vercel.json                adds the review sweep cron

## Must ship together

- `index.html` + `api/guest-auth.js` — host nav is gated on
  `hasActiveListing`, which only the new auth returns. The page alone
  against the old endpoint hides the host nav from everyone.
- `index.html` + `api/get-listings.js` — ratings and badges.
- `host-earnings.html` + `api/host-listings.js` — analytics mode.
- `host-dashboard.html` + `host-earnings.html` — earnings moved between them.

## Check package.json first

It adds `pdfkit`, which `api/verify-payment.js` imports at the top level.
If your repo already lists it at a different version, keep yours — your
working build is the proof that version is fine.

## Function count

Two new files in `api/` both start with `_`, so neither counts as a
serverless function. You remain at exactly 12 of Vercel Hobby's 12.
