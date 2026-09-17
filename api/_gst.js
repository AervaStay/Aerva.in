// /api/_gst.js
// GST on bookings. Not an API endpoint itself — the leading underscore is
// what tells Vercel that, same convention as _tiers.js, _currency.js, etc.
//
// Decisions (Sept 2026):
//   - GST is ADDED ON TOP at checkout, never folded into a listed price.
//   - Aerva keeps the GST it collects and pays it to the government (as
//     the e-commerce operator under section 9(5) of the CGST Act). It is
//     therefore never part of a host's payout or commission base.
//   - Charged on: the stay itself (room + extra guests, after discount),
//     paid amenities, pet fees, and experiences.
//   - NOT charged on: Aerva's guest service fee, or the refundable
//     security deposit (held, not a supply).
//   - A host-bought coupon is a VOUCHER — a way of paying, not a price
//     cut — so GST is worked out on the full price and the coupon then
//     reduces the amount the guest pays.
//
// index.html carries a display-only copy of these numbers
// (GST_ACCOMMODATION_SLABS / GST_EXPERIENCE_RATE there). This file is the
// one that decides what a guest is actually charged; keep them in step.
//
// TO CONFIRM WITH AERVA'S CA before relying on the numbers:
//   - whether stays of ₹1,000 a night or less are exempt (sources
//     disagree; no exemption is applied below — add { upTo: 1000, rate: 0 }
//     at the top of the list to apply one);
//   - the rate for experiences (18% below);
//   - that amenities and pet fees follow the stay's rate (treated here as
//     part of one composite supply whose principal part is the stay).

// Per-night value of the accommodation → rate. Read top to bottom; the
// first band whose upTo the value does not exceed wins. The value is
// per unit (one villa, or one resort room) per night, after discount —
// the value actually charged, not the pre-discount tariff.
const GST_ACCOMMODATION_SLABS = [
  { upTo: 7500, rate: 5 },
  { upTo: Infinity, rate: 18 }
];

const GST_EXPERIENCE_RATE = 18;

function accommodationGstRate(perNightValue) {
  const v = Number(perNightValue) || 0;
  const band = GST_ACCOMMODATION_SLABS.find(b => v <= b.upTo);
  return band ? band.rate : GST_ACCOMMODATION_SLABS[GST_ACCOMMODATION_SLABS.length - 1].rate;
}

// roomPortion: room + extra guests for the whole stay, after discount.
// extras: paid amenities + pet fees for the whole stay.
// Returns { rate, base, gst } in whole rupees.
function stayGst({ roomPortion, nights, extras = 0 }) {
  const n = Math.max(1, Number(nights) || 1);
  const room = Math.max(0, Number(roomPortion) || 0);
  const rate = accommodationGstRate(room / n);
  const base = room + Math.max(0, Number(extras) || 0);
  return { rate, base, gst: Math.round(base * rate / 100) };
}

function experienceGst(subtotal) {
  const base = Math.max(0, Number(subtotal) || 0);
  return { rate: GST_EXPERIENCE_RATE, base, gst: Math.round(base * GST_EXPERIENCE_RATE / 100) };
}

module.exports = {
  GST_ACCOMMODATION_SLABS, GST_EXPERIENCE_RATE,
  accommodationGstRate, stayGst, experienceGst
};
