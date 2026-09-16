# Changed files only

Everything here differs from your original upload. Anything not in this
bundle is untouched — leave it alone. 19 files are deliberately absent.

## Order

1. `migration_reviews.sql` in Neon
2. `migration_tier_history.sql` in Neon
3. Deploy everything here together
4. Hit `/api/get-listings?reviewSweep=1` once by hand, or `tier_history`
   stays empty until 02:00 and the admin History view shows nothing

Both migrations are additive and `IF NOT EXISTS` guarded — safe to re-run,
safe to apply while the current build is live.

## Contents

    api/_tiers.js              NEW  guest, host and property ladders
    api/_review-policy.js      NEW  publication rules + written policy
    api/_tier-history.js       NEW  records standing changes
    api/get-listings.js             review sweep, badges, ratings, tier snapshot
    api/get-pending-listings.js     policy, conflicts, revert, simulator, history
    api/guest-auth.js               hasActiveListing + header tier badge
    api/guest-profile.js            guest submits a review; guest tier
    api/host-listings.js            host reviews a guest; analytics
    api/verify-payment.js           booking-confirmed template trigger
    admin-...html                   Review Policy tab + separate Simulator tab
    host-dashboard.html             Resort gating, earnings moved out, profile fields
    host-earnings.html         NEW  analytics + earnings page
    index.html                      XSS fix, filters, card restyle, ratings,
                                    badges, per-account storage, nav tier badge
    package.json                    adds pdfkit
    vercel.json                     adds the review sweep cron

Seeds are optional test data, not deployed code.

## Must ship together

- `index.html` + `api/guest-auth.js` — the host nav and the header badge
  read `hasActiveListing` and `tier`, which only the new auth returns.
  The page alone against the old endpoint hides the host nav from everyone.
- `index.html` + `api/get-listings.js` — ratings and badges.
- `host-earnings.html` + `api/host-listings.js` — analytics mode.
- `admin-...html` + `api/get-pending-listings.js` — policy, simulator, history.

## Check package.json first

It adds `pdfkit`, which `api/verify-payment.js` imports at the top level.
If your repo already lists it at a different version, keep yours.

## Function count

Three new `api/` files all start with `_`, so none counts as a serverless
function. Still exactly 12 of Vercel Hobby's 12.
