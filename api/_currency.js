// /api/_currency.js
// Shared by create-order.js (charging a guest directly in their currency)
// and get-pending-listings.js (refunding a deposit in whatever currency
// it was originally charged in). Not an API endpoint itself — the
// leading underscore is what tells Vercel that, same convention as
// _approval-token.js and _audit-log.js.

// Razorpay requires whole-unit amounts (no fractional subunit) for these.
const ZERO_DECIMAL_CURRENCIES = ['JPY', 'KRW'];

// Reads which currencies (if any) are approved for direct international
// charging — empty/missing means the feature is fully off, which is the
// correct state until your Razorpay account is actually approved for
// International Payments (a request made from the Razorpay Dashboard,
// not something any code here can do).
async function getEnabledInternationalCurrencies(sql) {
  try {
    const rows = await sql`SELECT value FROM site_settings WHERE key = 'international_payment_currencies'`;
    return rows[0] && Array.isArray(rows[0].value) ? rows[0].value : [];
  } catch (err) {
    console.error('getEnabledInternationalCurrencies failed, defaulting to INR-only:', err);
    return [];
  }
}

// Converts a real INR amount into another currency's own smallest
// subunit, using the same cached daily rates the guest-facing display
// conversion uses (get-listings.js's ?currencyRates=1 reads the same
// site_settings row). Returns null if no cached rate exists for that
// currency — callers should fall back to INR rather than guessing.
async function convertInrToForeignSubunit(sql, amountInr, currencyCode) {
  const rows = await sql`SELECT value FROM site_settings WHERE key = 'currency_rates'`;
  const rates = rows[0] && rows[0].value;
  if (!rates || !rates[currencyCode]) return null;
  const converted = amountInr * rates[currencyCode];
  const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.includes(currencyCode);
  return isZeroDecimal ? Math.round(converted) : Math.round(converted * 100);
}

module.exports = { ZERO_DECIMAL_CURRENCIES, getEnabledInternationalCurrencies, convertInrToForeignSubunit };
