// /api/_tds.js — TDS on what Aerva pays hosts and co-hosts. Not an endpoint.
//
// THE RULE (Income-tax Act 2025, s.393(1) Table 8(v) and s.393(4) Table 11,
// formerly s.194-O; checked 1 Oct 2026 — confirm with Aerva's CA):
//   • Aerva, as the e-commerce operator, deducts 0.1% of the GROSS amount of
//     each resident participant's supply through the platform (the host's
//     booking amount before Aerva's commission; GST is not part of it — see
//     _gst.js — and neither is the guest service fee).
//   • No PAN (or Aadhaar) furnished, or the PAN is inoperative (not linked to
//     Aadhaar): 5% (s.397(2), formerly s.206AA).
//   • An INDIVIDUAL or HUF (PAN 4th letter P or H) who has furnished PAN:
//     no TDS while their gross through Aerva in the financial year (April to
//     March) stays within ₹5,00,000. When the year's gross goes past it, TDS
//     applies to the whole year's gross: the payout that crosses the line
//     also carries 0.1% on the earlier payouts of that year that had none
//     ("catch-up"), and every later payout that year has 0.1%.
//   • Companies, firms, trusts, AOPs and others: 0.1% from the first rupee.
// The date that decides the financial year is the date the payout is
// credited: when its row is created on check-out day.
//
// Rates stay overridable in Vercel (TDS_RATE_WITH_PAN, TDS_RATE_WITHOUT_PAN,
// TDS_THRESHOLD_INDIVIDUAL) if the CA advises otherwise.

const RATE_WITH_PAN = () => Number(process.env.TDS_RATE_WITH_PAN || 0.1);
const RATE_WITHOUT_PAN = () => Number(process.env.TDS_RATE_WITHOUT_PAN || 5);
const THRESHOLD = () => Number(process.env.TDS_THRESHOLD_INDIVIDUAL || 500000);
const round2 = (n) => Math.round(n * 100) / 100;

// PAN: five letters, four digits, a letter. The 4th letter is the holder's
// kind: P person, H HUF, C company, F firm/LLP, A AOP, T trust, B BOI,
// L local authority, J artificial juridical person, G government.
const PAN_PATTERN = /^[A-Z]{3}[ABCFGHJLPT][A-Z][0-9]{4}[A-Z]$/;
const PAN_KINDS = { P: 'Individual', H: 'HUF', C: 'Company', F: 'Firm / LLP', A: 'AOP', T: 'Trust', B: 'BOI', L: 'Local authority', J: 'Artificial juridical person', G: 'Government' };
const cleanPan = (p) => String(p || '').trim().toUpperCase();
const isValidPan = (p) => PAN_PATTERN.test(cleanPan(p));
const panKind = (p) => (isValidPan(p) ? cleanPan(p)[3] : null);
const PAN_ERROR = 'Please enter a valid PAN, like ABCPE1234F. The 4th letter shows who holds it (P for a person, H for a HUF, C for a company, F for a firm).';

// Financial year a moment falls in (Indian time): 2026 means April 2026 – March 2027.
function financialYear(at) {
  const d = new Date(new Date(at || Date.now()).getTime() + 5.5 * 3600 * 1000);   // IST
  return d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}
const fyLabel = (fy) => `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`;

// Is the payee's PAN one Aerva can use?
//   pan: the plain PAN (or null); status: its review status; inoperative:
//   marked by the admin after checking it is not linked to Aadhaar.
//   present: a PAN is stored even if it could not be read (encryption key
//   missing): counted as furnished, but its kind is unknown, so the ₹5 lakh
//   exemption is not given — 0.1% from the first rupee.
function panStanding({ pan, status, inoperative, present = false }) {
  const p = cleanPan(pan);
  if (status === 'rejected' || status === 'not_submitted') return { furnished: false, reason: 'no_pan', kind: null };
  if (!p && present) return inoperative ? { furnished: false, reason: 'inoperative_pan', kind: null } : { furnished: true, reason: 'pan', kind: null };
  // Saved before the 4th-letter check: still a PAN, kind unknown.
  if (p && !isValidPan(p) && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p)) return inoperative ? { furnished: false, reason: 'inoperative_pan', kind: null } : { furnished: true, reason: 'pan', kind: null };
  if (!p || !isValidPan(p)) return { furnished: false, reason: 'no_pan', kind: null };
  if (inoperative) return { furnished: false, reason: 'inoperative_pan', kind: p[3] };
  return { furnished: true, reason: 'pan', kind: p[3] };
}

// TDS on one payout.
//   payee: { payeeType: 'host'|'cohost', hostId, payeeGuestId }
//   base:  the gross amount this payout is for (host: booking amount less
//          co-host shares, which are taxed on the co-hosts; co-host: share)
//   pan:   { pan, status, inoperative }
//   creditAt: when the payout is credited (row creation)
//   excludePayoutId: this payout's own row when recalculating it
// Returns { tds, rate, reason, catchupBase, fy, base }.
async function tdsForPayout(sql, { payee, base, pan, creditAt = new Date(), excludePayoutId = null }) {
  const b = Math.max(0, round2(Number(base) || 0));
  const fy = financialYear(creditAt);
  const standing = panStanding(pan || {});
  if (!standing.furnished) {
    const rate = RATE_WITHOUT_PAN();
    return { tds: round2(b * rate / 100), rate, reason: standing.reason, catchupBase: 0, fy, base: b };
  }
  const rate = RATE_WITH_PAN();
  if (standing.kind !== 'P' && standing.kind !== 'H') {
    return { tds: round2(b * rate / 100), rate, reason: 'pan', catchupBase: 0, fy, base: b };
  }
  // Individual / HUF: the year's gross so far (booking payouts only).
  const who = payee.payeeType === 'cohost'
    ? sql`SELECT COALESCE(sum(tds_base), 0) AS gross,
                 COALESCE(sum(tds_base) FILTER (WHERE tds_reason = 'below_threshold'), 0) AS untaxed,
                 COALESCE(sum(tds_catchup_base), 0) AS caught
          FROM payouts WHERE payee_type = 'cohost' AND payee_guest_id = ${payee.payeeGuestId}
            AND COALESCE(kind, 'booking') = 'booking' AND tds_fy = ${fy} AND id IS DISTINCT FROM ${excludePayoutId}`
    : sql`SELECT COALESCE(sum(tds_base), 0) AS gross,
                 COALESCE(sum(tds_base) FILTER (WHERE tds_reason = 'below_threshold'), 0) AS untaxed,
                 COALESCE(sum(tds_catchup_base), 0) AS caught
          FROM payouts WHERE payee_type = 'host' AND host_id = ${payee.hostId}
            AND COALESCE(kind, 'booking') = 'booking' AND tds_fy = ${fy} AND id IS DISTINCT FROM ${excludePayoutId}`;
  let y;
  try { y = (await who)[0]; }
  catch (err) {
    // Before sql/migration_tds.sql the year cannot be added up: 0.1% from
    // the first rupee, as before.
    if (err && err.code === '42703') return { tds: round2(b * rate / 100), rate, reason: 'pan', catchupBase: 0, fy, base: b };
    throw err;
  }
  const before = Number(y.gross) || 0;
  if (before + b <= THRESHOLD()) {
    return { tds: 0, rate: 0, reason: 'below_threshold', catchupBase: 0, fy, base: b };
  }
  const catchupBase = Math.max(0, round2((Number(y.untaxed) || 0) - (Number(y.caught) || 0)));
  return {
    tds: round2((b + catchupBase) * rate / 100), rate,
    reason: catchupBase > 0 ? 'threshold_crossed' : 'pan', catchupBase, fy, base: b
  };
}

// Words for a payout's TDS line.
function tdsLabel(row) {
  const rate = Number(row.tds_rate || 0);
  switch (row.tds_reason) {
    case 'no_pan': return `TDS (${rate}%, no PAN)`;
    case 'inoperative_pan': return `TDS (${rate}%, PAN not linked to Aadhaar)`;
    case 'threshold_crossed': return `TDS (${rate}%, including this year's earlier payouts)`;
    default: return row.pan_furnished === false ? `TDS (${rate}%, no PAN)` : `TDS (${rate}%)`;
  }
}
function tdsNote(row) {
  if (row.tds_reason === 'below_threshold') return `No TDS: your earnings through Aerva this financial year (${fyLabel(Number(row.tds_fy) || financialYear(row.created_at))}) are within ₹5,00,000.`;
  if (row.tds_reason === 'threshold_crossed') return 'Your earnings through Aerva this financial year went past ₹5,00,000, so TDS now applies to the whole year, as the law requires.';
  if (row.tds_reason === 'no_pan') return 'Add your PAN to have TDS cut to 0.1% (and nothing at all while you earn under ₹5 lakh a year as an individual).';
  if (row.tds_reason === 'inoperative_pan') return 'Your PAN is inoperative because it is not linked to your Aadhaar. Link them at incometax.gov.in, then tell hello@aerva.in, to have TDS cut to 0.1%.';
  return null;
}

// Dates the law sets for what was deducted in a month (financial year fy):
// deposit by the 7th of the next month (30 April for March); the quarter's
// return by 31 Jul / 31 Oct / 31 Jan / 31 May; certificates 15 days later.
function dueDates(creditAt) {
  const d = new Date(new Date(creditAt).getTime() + 5.5 * 3600 * 1000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();      // 0 = January
  const iso = (yy, mm, dd) => `${yy}-${String(mm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const deposit = m === 2 ? iso(y, 3, 30) : (m === 11 ? iso(y + 1, 0, 7) : iso(y, m + 1, 7));
  const fy = m >= 3 ? y : y - 1;
  const q = m >= 3 && m <= 5 ? 1 : m >= 6 && m <= 8 ? 2 : m >= 9 && m <= 11 ? 3 : 4;
  const ret = { 1: iso(fy, 6, 31), 2: iso(fy, 9, 31), 3: iso(fy + 1, 0, 31), 4: iso(fy + 1, 4, 31) }[q];
  const cert = { 1: iso(fy, 7, 15), 2: iso(fy, 10, 15), 3: iso(fy + 1, 1, 15), 4: iso(fy + 1, 5, 15) }[q];
  return { month: iso(y, m, 1).slice(0, 7), fy, quarter: 'Q' + q, depositBy: deposit, returnBy: ret, certificatesBy: cert };
}

module.exports = {
  tdsForPayout, panStanding, financialYear, fyLabel, tdsLabel, tdsNote, dueDates,
  isValidPan, panKind, cleanPan, PAN_PATTERN, PAN_KINDS, PAN_ERROR, RATE_WITH_PAN, RATE_WITHOUT_PAN, THRESHOLD
};
