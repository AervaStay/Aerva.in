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

// REFUNDS in a foreign currency: never re-converted at today's rate (the
// guest could get back more, or less, than they paid). A refund is the same
// share of what was actually captured as amountInr is of what the payment
// was worth in rupees — and never more than was captured.
//   captured subunit = orders.charge_amount (major units; zero-decimal
//   currencies are already whole units), the same on every row of a payment;
//   rupee value of the payment = what its rows were paid (allocatePaid).
// Returns the subunit amount, or null when the booking has no record of
// what was charged (callers must then refuse, never guess).
async function refundSubunitForInr(sql, { razorpayOrderId, amountInr, currency }) {
  const want = Math.max(0, Number(amountInr) || 0);
  if (!want) return 0;
  if (!razorpayOrderId) return null;
  const { allocatePaid } = require('./_booking-rules');
  const rows = await sql`SELECT id, subtotal, total, coupon_discount, charge_amount FROM orders WHERE razorpay_order_id = ${razorpayOrderId}`;
  const charged = rows.map(r => Number(r.charge_amount)).find(n => Number.isFinite(n) && n > 0);
  if (!charged) return null;
  const captured = ZERO_DECIMAL_CURRENCIES.includes(currency) ? Math.round(charged) : Math.round(charged * 100);
  const paid = allocatePaid(rows);
  const worthInr = Object.values(paid).reduce((t, p) => t + (p.paid || 0), 0);
  if (!(worthInr > 0)) return null;
  return proportionOfCaptured(captured, want, worthInr);
}
// Rounded down, so parts of one payment refunded separately never add up
// to more than was captured; the whole amount returns exactly what was captured.
function proportionOfCaptured(capturedSubunit, amountInr, worthInr) {
  const c = Math.max(0, Math.round(Number(capturedSubunit) || 0));
  if (Number(amountInr) >= Number(worthInr)) return c;
  return Math.min(c, Math.floor(c * Number(amountInr) / Number(worthInr)));
}

module.exports = { ZERO_DECIMAL_CURRENCIES, getEnabledInternationalCurrencies, convertInrToForeignSubunit, refundSubunitForInr, proportionOfCaptured };
