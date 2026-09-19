// aerva-policies.js — every Aerva policy, in one place.
//
// The public Policies page (index.html?view=policies) and the admin tool's
// Policies tab both render THIS file, so what guests and hosts read and
// what the admin documents can never drift apart. Change a rule here, and
// both change together.
//
// Wording rule: instructions only. Short, direct, no explanations.
// Every rule here matches how the site actually works (checked against the
// code, Sept 2026). "adminNotes" and "openItems" are shown ONLY in the
// admin tool.
window.AERVA_POLICIES = {
  version: '1.0',
  updated: 'September 2026',
  contact: 'hello@aerva.in',

  guest: [
    { id: 'booking', title: 'Booking and payment', points: [
      'Book and pay only on Aerva.',
      'All charges are in Indian Rupees (INR). Prices in other currencies are estimates.',
      'Your total shows the stay, GST, the guest service fee, any security deposit, paid amenities and pet fees before you pay.',
      'Your booking is confirmed only after payment succeeds and you receive a confirmation.',
      'You must be 18 or older to book.',
      'Do not book for more guests than the listing allows.'
    ]},
    { id: 'checkin', title: 'Check-in and check-out', points: [
      'Arrive and leave within the times shown on the listing. Times follow the property’s local time.',
      'Carry a valid government photo ID for every adult guest.',
      'Foreign nationals: carry your passport and visa. Your host must report your stay to the immigration authorities.',
      'Children must stay with an adult at all times.',
      'Leave the property as you found it. Return all keys and access cards.'
    ]},
    { id: 'cancellations', title: 'Cancellations and refunds', points: [
      'To cancel, write to hello@aerva.in with your booking ID.',
      'Experiences: the refund terms shown on the experience apply.',
      'If your host cancels, you get a full refund. You may instead accept an Aerva coupon of the same value, valid for 3 months on any listing.',
      'Hosts cannot cancel within 48 hours of check-in.',
      'Refunds go back to your original payment method. Your bank usually takes 5–7 working days.',
      'Security deposits are refunded under “Security deposit” below.'
    ]},
    { id: 'deposit', title: 'Security deposit', points: [
      'Some listings hold a refundable security deposit.',
      'It is refunded automatically after 7 days from check-out.',
      'If your host reports damage within those 7 days, Aerva reviews it and decides how much, if any, is kept.',
      'Any amount not kept is refunded to your original payment method.'
    ]},
    { id: 'pets', title: 'Pets', points: [
      'Bring pets only to listings marked pet-friendly.',
      'Stay within the listing’s pet limit and allowed pet types.',
      'Choose a type for each pet when you book. You may change the type later, but not the number of pets.',
      'The listing’s pet fee is charged per pet, per stay.',
      'Add young ones (under 1 year) to the pet they travel with. They are not counted or charged. A pet older than 1 year is added as its own pet. Carry proof of age if the host asks.',
      'Keep vaccinations current. Clean up after your pet.',
      'Do not leave pets alone unless the host allows it.',
      'You are responsible for any damage or injury your pet causes.'
    ]},
    { id: 'service-animals', title: 'Service and support animals', points: [
      'When you add a pet, answer whether it is a service or support animal.',
      'One service or support animal per booking is free.',
      'Each additional one is charged at the listing’s pet fee.',
      'Service and support animals do not count toward the pet limit.',
      'At check-in, the host may only ask whether the animal is needed because of a disability. No proof or further questions are required.'
    ]},
    { id: 'health-safety', title: 'Health, safety and hazards', points: [
      'In an emergency in India, call 112. For an ambulance, call 108.',
      'Report any hazard to your host at once in Messages: gas smell, electrical fault, fire risk, structural damage, unsafe water, pests, bed bugs or mould.',
      'If the property is unsafe, leave it first, then report it.',
      'Report problems found at check-in within 24 hours, with photos, in Messages and to hello@aerva.in. Aerva reviews and may rebook you or refund you.',
      'Do not check in with a contagious illness. Tell your host and write to hello@aerva.in.',
      'Follow any government health advisory in force.',
      'Supervise children near pools, water, balconies, stairs and roads.',
      'Do not tamper with smoke alarms, extinguishers or safety equipment.'
    ]},
    { id: 'conduct', title: 'House rules and conduct', points: [
      'Follow the listing’s house rules.',
      'No parties or events unless the host allows them in writing.',
      'Keep noise low at night and follow local noise rules.',
      'Do not smoke unless the host allows it.',
      'No illegal activity or illegal substances.',
      'Respect neighbours and shared spaces.',
      'You are responsible for damage you or your guests cause.'
    ]},
    { id: 'messages', title: 'Messages', points: [
      'Messages open once your booking is confirmed.',
      'Keep all communication and payments on Aerva.',
      'Phone numbers, emails and social handles are hidden in messages.'
    ]},
    { id: 'reviews', title: 'Reviews', points: [
      'Leave your review within 15 days of check-out.',
      'Rate every factor and write a comment.',
      'Be honest and specific. Do not review in return for anything.',
      'Aerva removes reviews that are false, abusive or retaliatory.'
    ]},
    { id: 'privacy', title: 'Your data', points: [
      'Aerva uses your details only to run your bookings, payments, messages and account.',
      'To see, correct or delete your data, write to hello@aerva.in.',
      'Aerva tells you promptly if a data breach affects you.'
    ]},
    { id: 'complaints', title: 'Complaints', points: [
      'Write to the Grievance Officer at hello@aerva.in with your booking ID.',
      'Aerva acknowledges complaints within 48 hours and resolves them within one month.',
      'You receive a reference number to track your complaint.'
    ]},
    { id: 'force-majeure', title: 'Events beyond control', points: [
      'If a natural disaster, government order or similar event stops a stay, write to hello@aerva.in. Aerva reviews each case for a refund or rebooking.'
    ]}
  ],

  host: [
    { id: 'verification', title: 'Verification and payouts', points: [
      'Complete Aadhaar, PAN and bank verification before you receive payouts.',
      'Aadhaar documents and PAN card images are deleted after they are checked. Only the result is kept.',
      'Your PAN and bank account number are stored encrypted.',
      'A changed bank account is checked again before the next payout.',
      'Tax deducted at source (TDS) is applied as required by law.'
    ]},
    { id: 'fees', title: 'Fees', points: [
      'Aerva’s commission is 10% of the stay and 5% of paid amenities.',
      'GST is added to the guest’s bill and paid to the government by Aerva. It is not part of your payout.',
      'Co-host shares are paid from your payout, at the percentage you approve.'
    ]},
    { id: 'listing', title: 'Your listing', points: [
      'Use real, current photos of the actual property.',
      'Describe amenities, rules and hazards accurately.',
      'Set the maximum number of guests.',
      'Use a property name no other stay in your pincode uses. Resorts are exempt.',
      'Keep your calendar accurate. Block dates you cannot host.',
      'Fix any “action needed” notice within 15 days, or the listing is taken off Aerva until it is fixed.'
    ]},
    { id: 'legal', title: 'Registrations and legal duties (India)', points: [
      'Register your property as your state requires (see Local laws).',
      'Get your society, landlord or building permission where needed.',
      'Hold any trade licence, fire safety or other certificate your area requires.',
      'Check with your accountant whether you must register for GST.',
      'Report every foreign guest, including OCI cardholders, on Form III at indianfrro.gov.in within 24 hours of arrival and of departure. The penalty is ₹50,000 per missed report.'
    ]},
    { id: 'checkin-host', title: 'Check-in', points: [
      'Check a government photo ID for every adult guest.',
      'Keep a guest register if your state or area requires it.',
      'Share check-in details through Messages before arrival.',
      'Service and support animals: you may only ask whether the animal is needed because of a disability. Do not ask for proof or anything else.'
    ]},
    { id: 'cancellations-host', title: 'Cancelling a booking', points: [
      'Cancel only more than 48 hours before check-in.',
      'Your guest gets a full refund, or an Aerva coupon of the same value if they accept it.',
      'Repeated cancellations lead to a review of your listing.'
    ]},
    { id: 'safety-host', title: 'Safety', points: [
      'Keep a working fire extinguisher, smoke alarm and first-aid kit.',
      'Display local emergency numbers (112, 108) and your contact number.',
      'Check gas, electrical and water systems regularly.',
      'Keep pools, balconies, stairs and water bodies safe, and disclose them.',
      'Carry out regular pest control.',
      'Reply to a hazard report as soon as you receive it.',
      'Do not install cameras in bedrooms, bathrooms or any private space. Disclose every camera elsewhere on the property.'
    ]},
    { id: 'pets-host', title: 'Pets', points: [
      'Set whether pets are allowed, the pet limit, allowed types and the pet fee.',
      'Keep pet-friendly listings safe for animals.',
      'Accept service and support animals as described in the guest policy.'
    ]},
    { id: 'deposit-host', title: 'Security deposit claims', points: [
      'Report damage within 7 days of check-out, with photos and a description.',
      'Aerva reviews the claim and decides the amount.',
      'Do not ask guests for payment outside Aerva.'
    ]},
    { id: 'reviews-host', title: 'Reviewing guests', points: [
      'Review your guest within 15 days of check-out.',
      'Rate every factor and write a comment.',
      'Be honest and fair. Never retaliate.'
    ]},
    { id: 'cohosts', title: 'Co-hosts', points: [
      'Invite co-hosts by email and choose their listings and access.',
      'Only you can rename a listing, change your account settings or manage co-hosts.',
      'Co-hosts never see or change your bank details, payouts or verification.',
      'Approve a co-host’s share before it applies.',
      'Co-hosts must verify their PAN and bank account to be paid.'
    ]},
    { id: 'conduct-host', title: 'Conduct', points: [
      'Hosts and co-hosts may not book their own listings.',
      'Do not take bookings or payments outside Aerva.',
      'Do not discriminate against any guest.',
      'Use guest details only to host their stay. Do not share them.'
    ]}
  ],

  // Local laws: what hosts must check where the property is. Instructions
  // only. Rules change; hosts must confirm with the local authority.
  localLaws: {
    note: 'Rules change often. Confirm with the local authority before you list.',
    countries: [
      { country: 'India', points: [
        'Report every foreign guest, including OCI cardholders, on Form III at indianfrro.gov.in within 24 hours of arrival and of departure.',
        'Check ID for every adult guest.',
        'Register with your state tourism department where required.',
        'Get society, landlord or municipal permission where required.',
        'Check GST registration with your accountant.'
      ], states: [
        { state: 'Himachal Pradesh', text: 'Register under the state Home Stay Scheme with the Tourism Department.' },
        { state: 'Maharashtra', text: 'Register with Maharashtra Tourism (Bed & Breakfast or homestay registration). Get your housing society’s permission.' },
        { state: 'Goa', text: 'Register with the Goa Tourism Department under the Goa Registration of Tourist Trade Act.' },
        { state: 'Uttarakhand', text: 'Register under the state Homestay Scheme.' },
        { state: 'Kerala', text: 'Get homestay classification from Kerala Tourism.' },
        { state: 'Karnataka', text: 'Register the homestay with the Karnataka Tourism Department.' },
        { state: 'Rajasthan', text: 'Register under the state Paying Guest / homestay scheme.' },
        { state: 'Other states', text: 'Check with the state tourism department and the local municipality.' }
      ]},
      { country: 'United Arab Emirates', points: ['Dubai: get a Holiday Home permit from the Department of Economy and Tourism and register every guest.', 'Other emirates: check the emirate’s tourism authority.'] },
      { country: 'United Kingdom', points: ['London: whole homes may be let short-term for up to 90 nights a year without planning permission.', 'Keep a current gas safety check and meet fire safety rules.'] },
      { country: 'Sri Lanka', points: ['Register with the Sri Lanka Tourism Development Authority.'] },
      { country: 'Nepal', points: ['Register the homestay under the national homestay procedure.'] },
      { country: 'Thailand', points: ['Short stays need a hotel licence under the Hotel Act.', 'Report foreign guests on form TM30 within 24 hours.'] },
      { country: 'Singapore', points: ['Short-term stays under 3 months are not allowed in private homes. HDB flats have a 6-month minimum.'] },
      { country: 'Indonesia (Bali)', points: ['Get a business licence (NIB) through the OSS system and pay local taxes.'] },
      { country: 'Japan', points: ['Register under the Private Lodging Business Act (minpaku). Stays are capped at 180 nights a year.'] },
      { country: 'Italy', points: ['Display the national identification code (CIN).', 'Report every guest to the police (Alloggiati Web) within 24 hours.'] },
      { country: 'Spain', points: ['Get the national short-term rental registration number and any regional licence.'] },
      { country: 'France', points: ['Paris and many cities: register the listing and respect the yearly night limit for primary residences.'] },
      { country: 'Germany', points: ['Berlin and other cities: get a permit before letting short-term.'] },
      { country: 'United States', points: ['Rules are set by each city. New York City: register under Local Law 18.'] },
      { country: 'Canada', points: ['Rules are set by province and city. Many cities allow short-term rentals only in your principal residence.'] },
      { country: 'Australia', points: ['Rules vary by state. New South Wales: register, and follow the 180-night cap for unhosted stays in Greater Sydney.'] },
      { country: 'Maldives, Bhutan, Bangladesh, New Zealand', points: ['Register with the national or local tourism authority before hosting.'] }
    ]
  },

  // ---- Admin only ----------------------------------------------------
  adminNotes: [
    { title: 'Laws Aerva itself follows (India)', points: [
      'Consumer Protection (E-Commerce) Rules, 2020: display the Grievance Officer’s name, designation and contact; acknowledge complaints within 48 hours; resolve within one month; give a complaint reference number.',
      'Consumer Protection (E-Commerce) Rules, 2020: do not charge consumers cancellation fees unless Aerva bears similar charges when it cancels.',
      'Digital Personal Data Protection Act, 2023 and Rules, 2025: tell affected users without delay after a breach; send the Data Protection Board a detailed report within 72 hours; publish a contact for data requests; keep processing logs at least 1 year; give 48 hours’ notice before erasing inactive users’ data.',
      'Income-tax Act, section 194-O: deduct TDS on host payouts and issue certificates; a missing PAN means a higher rate. Confirm rates with the CA.',
      'CGST Act, section 9(5): Aerva collects and pays GST on accommodation booked through it.',
      'Immigration and Foreigners Act, 2025: hosts file Form III for foreign guests within 24 hours; ₹50,000 penalty per case.'
    ]},
    { title: 'How Aerva stores sensitive data', points: [
      'Aadhaar: document deleted on approve or reject; only the status is kept. Aadhaar numbers are never collected.',
      'PAN: card image deleted on review; number kept encrypted (AES-256-GCM, key in Vercel).',
      'Bank account and co-host GSTIN: kept encrypted.',
      'Audit log: every admin, host, co-host and system action is recorded and never deleted.'
    ]},
    { title: 'How admins apply these policies', points: [
      'Deposit disputes: decide within the dispute tab; record the reason.',
      'Hazard reports: rebook or refund the guest when the property is unsafe; review the listing.',
      'Reviews: remove only when false, abusive or retaliatory; the badge recalculates.',
      'Compliance flags: hosts have 15 days; listings are blocked automatically after that.',
      'Every admin action is in the Audit Log tab, with the admin who did it.'
    ]}
  ],

  // Gaps between these policies and the product, for the admin to close.
  openItems: [
    'Add the Grievance Officer’s name and designation to the Complaints section (required by the E-Commerce Rules).',
    'Display Aerva’s legal entity name and registered office address on the site (required by the E-Commerce Rules).',
    'Guests cannot cancel online yet; cancellations come by email. Decide stay cancellation terms (e.g. flexible / firm) before building self-cancellation.',
    'TDS under section 194-O is not yet deducted from payouts. Confirm the rate with the CA before real payouts.',
    'Remind hosts to file Form III when a foreign guest books (not built).',
    'Aadhaar and PAN files waiting for review sit in public storage until reviewed. Review them promptly.',
    'Publish a full privacy notice with consent at signup (DPDP Rules).'
  ]
};
