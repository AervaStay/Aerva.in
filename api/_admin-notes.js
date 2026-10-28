// /api/_admin-notes.js — the admin-only notes and open items. Not an endpoint.
//
// Kept on the server, never in aerva-policies.js (which every visitor's
// browser downloads): how Aerva weighs disputes, internal rules and the
// to-do list must not be readable by guests or hosts. Served only to
// signed-in admins, reviewers and customer representatives
// (get-pending-listings.js ?adminNotes=1) and shown in Admin → Policies.

module.exports = {
  adminNotes: [
    { title: 'Laws Aerva itself follows (India)', points: [
      'Consumer Protection (E-Commerce) Rules, 2020: display the Grievance Officer’s name, designation and contact; acknowledge complaints within 48 hours; resolve within one month; give a complaint reference number.',
      'Consumer Protection (E-Commerce) Rules, 2020: do not charge consumers cancellation fees unless Aerva bears similar charges when it cancels.',
      'Digital Personal Data Protection Act, 2023 and Rules, 2025: tell affected users without delay after a breach; send the Data Protection Board a detailed report within 72 hours; publish a contact for data requests; keep processing logs at least 1 year; give 48 hours’ notice before erasing inactive users’ data.',
      'Income-tax Act, section 194-O (s.393 of the 2025 Act): deduct TDS on every payment to hosts and co-hosts, deposit compensation included, on the amount due after commission (CA’s advice, Oct 2026); 5% without a PAN or with an inoperative one; issue certificates.',
      'CGST Act, section 9(5): Aerva collects and pays GST on accommodation booked through it.',
      'Immigration and Foreigners Act, 2025: hosts file Form III for foreign guests within 24 hours; ₹50,000 penalty per case.'
    ]},
    { title: 'How Aerva stores sensitive data', points: [
      'ID verification (guests, hosts and co-hosts): the ID is read in memory by an automated check and never stored, uploaded or logged. Only the result is kept: type of ID, name as on it, last 4 characters, date. Full ID numbers are never kept.',
      'Aadhaar documents uploaded for a manual check before October 2026: deleted on approve or reject, or as soon as the host verifies instantly; only the status is kept.',
      'Guest ID proofs uploaded before September 2026: erased from ID Verifications, or when the account is deleted.',
      'PAN: card image deleted on review; number kept encrypted (AES-256-GCM, key in Vercel).',
      'Bank account and co-host GSTIN: kept encrypted.',
      'Audit log: every admin, host, co-host and system action is recorded and never deleted.'
    ]},
    { title: 'How admins apply these policies', points: [
      'Deposit disputes: the host asks for an amount (up to the deposit) with photos or videos; review the proof and the guest’s side, then approve the amount in the dispute tab (prefilled with the host’s request). With no proof, refund the deposit in full.',
      'Stay disputes (Guest Safety tab): give the host’s account more weight; refund only when the guest’s evidence stands and the host cannot justify.',
      'Listing photos with phone numbers or other contact details: use “Block: phone number in photo” on the listing.',
      'Hazard reports: rebook or refund the guest when the property is unsafe; review the listing.',
      'Reviews: remove only when false, abusive or retaliatory; the badge recalculates.',
      'Compliance flags: hosts have 15 days; listings are blocked automatically after that.',
      'Every admin action is in the Audit Log tab, with the admin who did it.',
      'Host cancels a same-day booking (check-in on the day it was booked) within 1 hour of it being made: no coupon is owed and it does not count towards the 3-a-year limit. Applied automatically; not published, so it cannot be used to game the limit.',
      'Host cancellations more than 48 hours before check-in carry no coupon. Watch for repeated ones and decide further penalties case by case.'
    ]}
  ],

  // Gaps between these policies and the product, for the admin to close.
  openItems: [
    'Have the lawyer review the Aerva Host Agreement 2026-10-28a (every host cancellation: all as Aerva credit for up to 6 months, ending 175 days after payment so the bank can still refund it (refundable any time; what is left refunded automatically at the end); coupon not refundable; coupon from the host only within 48 hours of check-in; Aerva cancels for the host with the coupon from the next payout; commission revisions announced in advance with no fixed number of days, confirm or decline; offered again after it ends; commission revisions acknowledged and confirmed; payout the day after check-in; first night only while a guest’s request is open; amounts recovered from the next payout) and its earlier terms (29 clauses): accepted per listing; commission revisions on at least 33 days’ notice (31 + 2), acknowledged by each host, the agreement ending if declined or not acknowledged by the date; ending the agreement if a revision is declined or not accepted within 30 days; the non-disparagement clause; indemnity and liability limits.',
    'Add the Grievance Officer’s name to support.grievanceOfficer in this file (required by the E-Commerce Rules); it then shows in the Resolution Center.',
    'Resolution Center: fill in support.contacts.tollFree, whatsapp and hours in this file when the numbers are live. Until then those buttons stay hidden.',
    'Display Aerva’s legal entity name and registered office address on the site (required by the E-Commerce Rules).',
    'Have the lawyer review booking agreement 2026-10-29a — a host’s cancellation held as Aerva credit (refundable any time), plus a 10% coupon within 48 hours; coupon value returned only when the host cancels or a reported problem is upheld; the deposit decided by the host with photo or video proof, refunded within 2 bank working days when the host confirms no damage; contact details until 15 days after check-out, aerva.in links always allowed; credit and coupons earn no interest; no cancellation once a stay has started; changes and problem reports only until 10 AM on the day after check-in; the check-in night never refunded; a shorter stay agreed by the host returned as Aerva credit (never expires, refundable whenever the guest asks); nothing refunded after that time — and its earlier terms: ID checked by the host at check-in (not by Aerva), the 3-minute payment window and next-day refunds, stay disputes weighted to the host, and immediate blocking for contact details in photos.',
    'Erase the guest ID proofs uploaded before September 2026: Admin → ID Verifications → “Erase reviewed documents & encrypt stored numbers”.',
    'Confirm with the CA how GST is treated on the part of a booking price kept after a guest cancels.',
    'TDS rules follow the CA’s review of October 2026 (no ₹5 lakh exemption, base after commission, deposits included). Hosts or co-hosts outside India are not handled; flag any non-resident payee to the CA (s.195).',
    'Remind hosts to file Form III when a foreign guest books (not built).',
    'Aadhaar and PAN files waiting for review sit in public storage until reviewed. Review them promptly.',
    'Privacy policy is published (Aerva Privacy). Add a consent tick to sign-up that links to it (DPDP Rules).',
    'Update the Google consent screen’s privacy policy link to https://aerva.in/index.html?view=privacy, and its Terms of Service link to https://aerva.in/index.html?view=terms.',
    'Have a lawyer review the three Terms of Service versions (India, European users, everyone else), especially liability and indemnity.'
  ]
};
