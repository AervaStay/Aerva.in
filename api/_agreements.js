// /api/_agreements.js — the current agreement version. Not an endpoint.
// Must match AERVA_POLICIES.agreements.version in aerva-policies.js (the
// text guests and hosts actually see). When the wording changes, change
// both — a booking or listing that sends an older version is refused and
// the person is shown the new text.
const AGREEMENT_VERSION = '2026-09d';
module.exports = { AGREEMENT_VERSION };
