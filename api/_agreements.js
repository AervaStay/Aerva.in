// /api/_agreements.js — the current agreement version. Not an endpoint.
// Must match AERVA_POLICIES.agreements.version in aerva-policies.js (the
// text guests and hosts actually see). When the wording changes, change
// both — a booking or listing that sends an older version is refused and
// the person is shown the new text.
const AGREEMENT_VERSION = '2026-10-27a';          // booking agreement (guests)
// The host agreement has its own version: it is accepted for EVERY listing
// submitted for review (saved on the listing and on the host). Must match
// AERVA_POLICIES.agreements.hostVersion in aerva-policies.js.
const HOST_AGREEMENT_VERSION = '2026-10-27b';
module.exports = { AGREEMENT_VERSION, HOST_AGREEMENT_VERSION };
