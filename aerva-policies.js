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

  // Shown before payment (guest) and before listing (host). The version is
  // saved with every booking and every host acceptance; it must match
  // AGREEMENT_VERSION in api/_agreements.js. Change the text → change both.
  agreements: {
    version: '2026-09c',
    guest: {
      title: 'Booking agreement',
      points: [
        'Your booking is an agreement between you and the host. Aerva is the platform that connects you and takes payment.',
        'You: give true details of every guest and pet, carry ID, follow the house rules and the law, and pay for any damage you or your guests cause.',
        'The host: provides the home or experience as described, keeps it safe and clean, and follows local laws.',
        'Aerva: takes your payment, handles refunds and complaints under Aerva’s Policies, and keeps your booking records.',
        'No violence, threats, verbal abuse, harassment or discrimination of any kind, including on gender.',
        'Any security deposit is refunded under Aerva’s Security Deposit and Damage Policy. Damage above the deposit is between you and the host, under the law.',
        'You are responsible for your own safety and for any physical, mental or emotional harm you or your guests cause or suffer that is beyond Aerva’s control.',
        'Aerva does not own, run or inspect properties or experiences, and does not control what hosts or guests do. To the extent the law allows, Aerva is not responsible for the acts or omissions of any host, guest or third party, including criminal acts, death, injury, self-harm or any life-threatening situation, and pays no claim for them.',
        'Aerva’s decision on any matter under its policies is full and final.',
        'Cancellations, refunds, deposits, pets and safety follow Aerva’s Policies.'
      ],
      accept: 'I agree to this booking agreement and Aerva’s Policies.'
    },
    host: {
      title: 'Host agreement',
      points: [
        'Each booking is an agreement between you and the guest. Aerva is the platform that connects you and takes payment.',
        'You: list accurately, keep your property safe, clean and legal, hold every registration your area requires, report foreign guests on Form III within 24 hours, and honour every confirmed booking.',
        'The guest: follows your house rules and the law, and pays for damage they cause.',
        'Aerva: takes payment, pays you your share after Aerva’s fees and taxes, and handles refunds and complaints under Aerva’s Policies.',
        'You are responsible for your own taxes, insurance and legal compliance.',
        'No violence, threats, verbal abuse, harassment or discrimination of any kind, including on gender.',
        'Damage claims go through Aerva, up to the security deposit. Damage above the deposit is between you and the guest, under the law.',
        'You are responsible for your guests’ safety at your property as the law requires, and for any physical, mental or emotional harm that is beyond Aerva’s control.',
        'Aerva does not own, run or inspect your property, and does not control what guests do. To the extent the law allows, Aerva is not responsible for the acts or omissions of any guest, host or third party, including criminal acts, death, injury, self-harm or any life-threatening situation, and pays no claim for them.',
        'Aerva’s decision on any matter under its policies is full and final.',
        'Aerva’s Policies apply to every booking.'
      ],
      accept: 'I agree to the host agreement and Aerva’s Policies.'
    }
  },

  // Aerva Privacy — what information Aerva collects, why, who it goes to,
  // how long it is kept, and your rights. Shown at index.html?view=privacy.
  // Every point matches what the site actually does (checked in the code).
  // Minimal by design: only what the law requires Aerva to show, and the
  // rules Aerva needs to enforce. No timelines or outcomes Aerva would be
  // held to; broad rights for Aerva to act. The Local laws guide is kept
  // for the admin only (publishing legal advice invites reliance claims).
  // Terms of Service — shown at index.html?view=terms, and accepted by
  // continuing on every login / sign-up screen. Minimal and protective:
  // Aerva is a platform, not a party to stays; broad rights for Aerva;
  // liability limited to the extent the law allows. Have a lawyer review.
  terms: {
    title: 'Terms of Service',
    // Which version applies, India first (shown as the notice box).
    regions: [
      { id: 'india', label: 'Terms of Service for Users in India',
        applies: 'If your country of residence or establishment is India, the Terms of Service for Users in India apply to you.' },
      { id: 'europe', label: 'Terms of Service for European Users',
        applies: 'If your country of residence or establishment is within the European Economic Area (“EEA”), Switzerland or the United Kingdom, the Terms of Service for European Users apply to you.' },
      { id: 'other', label: 'Terms of Service for Users outside India, the EEA, Switzerland and the UK',
        applies: 'If your country of residence or establishment is outside India, the EEA, Switzerland and the United Kingdom, the Terms of Service for Users outside India, the EEA, Switzerland and the UK apply to you.' }
    ],
    intro: 'These Terms apply to everyone who uses Aerva. By creating an account, logging in or booking, you agree to them.',
    // The same in every version.
    common: [
      { id: 'about', title: 'About Aerva', points: [
        'Aerva is an online platform that connects guests with hosts of stays and experiences.',
        'Aerva is not a party to any stay or experience. Aerva does not own, operate, inspect or control any property, experience, host or guest.'
      ]},
      { id: 'account', title: 'Your account', points: [
        'You must be 18 or older and give accurate information.',
        'You are responsible for everything done through your account. Keep your login secure.'
      ]},
      { id: 'bookings', title: 'Bookings and payments', points: [
        'Every booking is covered by the Booking Agreement you accept before payment and by the documents listed above.',
        'Pay only through Aerva. Fees and taxes are shown before you pay.'
      ]},
      { id: 'hosts', title: 'Hosts', points: [
        'Hosts accept the Host Agreement and are responsible for their listings, their guests’ stays and their legal compliance.'
      ]},
      { id: 'content', title: 'Your content', points: [
        'You keep ownership of what you post. You allow Aerva to use, display and adapt it to operate and promote Aerva.',
        'Aerva may remove any content at any time.'
      ]},
      { id: 'prohibited', title: 'What you must not do', points: [
        'Break the law, commit fraud, harass or discriminate against anyone.',
        'Take bookings or payments outside Aerva, or try to avoid Aerva’s fees.',
        'Copy, scrape or misuse Aerva, or interfere with its security.'
      ]},
      { id: 'closing', title: 'Deactivating and deleting', points: [
        'Hosts may deactivate listings or hosting at any time. Anyone may delete their account once nothing is open, as set out in the Deactivating, Removing and Deleting policy.'
      ]},
      { id: 'decisions', title: 'Aerva’s decisions', points: [
        'Aerva’s decision on any matter under these Terms and its policies is full and final.'
      ]},
      { id: 'suspension', title: 'Suspension and termination', points: [
        'Aerva may suspend or close any account, or cancel any booking or listing, if these Terms or Aerva’s policies are broken.'
      ]},
      { id: 'changes', title: 'Changes', points: [
        'Aerva may change these Terms at any time. Using Aerva after a change means you accept it.'
      ]},
      { id: 'contact', title: 'Contact', points: [
        'Grievance Officer: hello@aerva.in'
      ]}
    ],
    // What differs by country (shown after the common sections).
    specific: {
      india: [
        { id: 'liability', title: 'Liability', points: [
          'Aerva is provided “as is”. To the extent the law allows, Aerva is not liable for the acts or omissions of any host, guest or third party (including criminal acts, death, injury, self-harm or any life-threatening situation), for anything beyond its control, or for any indirect or consequential loss.',
          'To the extent the law allows, Aerva’s total liability for any claim is limited to the fees Aerva received for the booking concerned.'
        ]},
        { id: 'indemnity', title: 'Indemnity', points: [
          'To the extent the law allows, you will compensate Aerva for any claim, loss or cost arising from your breach of these Terms or your use of Aerva.'
        ]},
        { id: 'law', title: 'Governing law and disputes', points: [
          'These Terms are governed by the laws of India. Disputes are subject to the courts of competent jurisdiction in India.'
        ]}
      ],
      europe: [
        { id: 'adr', title: 'Dispute resolution bodies', points: [
          'Aerva is not committed or obliged to use an alternative dispute resolution entity to resolve disputes with consumers.'
        ]},
        { id: 'withdrawal', title: 'Dated bookings', points: [
          'Bookings of accommodation or experiences for specific dates cannot be withdrawn from once confirmed.'
        ]},
        { id: 'liability', title: 'Liability', points: [
          'Aerva is liable without limit for death or personal injury caused by its negligence, for fraud, for intent and gross negligence, and wherever the law does not allow liability to be limited.',
          'Otherwise, Aerva is liable only for foreseeable losses caused by its breach of essential obligations, limited to the fees Aerva received for the booking concerned. Aerva is not liable for the acts or omissions of any host or guest.'
        ]},
        { id: 'indemnity', title: 'Indemnity', points: [
          'If you use Aerva as a business, you will compensate Aerva for any claim, loss or cost arising from your breach of these Terms.'
        ]},
        { id: 'law', title: 'Governing law and disputes', points: [
          'These Terms are governed by the laws of India.'
        ]}
      ],
      other: [
        { id: 'liability', title: 'Liability', points: [
          'Aerva is provided “as is”. To the extent the law allows, Aerva is not liable for the acts or omissions of any host, guest or third party (including criminal acts, death, injury, self-harm or any life-threatening situation), for anything beyond its control, or for any indirect or consequential loss.',
          'To the extent the law allows, Aerva’s total liability for any claim is limited to the fees Aerva received for the booking concerned.'
        ]},
        { id: 'indemnity', title: 'Indemnity', points: [
          'To the extent the law allows, you will compensate Aerva for any claim, loss or cost arising from your breach of these Terms or your use of Aerva.'
        ]},
        { id: 'law', title: 'Governing law and disputes', points: [
          'These Terms are governed by the laws of India. Disputes are subject to the courts of competent jurisdiction in India.'
        ]}
      ]
    }
  },

  privacy: {
    title: 'Aerva Privacy',
    intro: 'What information Aerva collects and how it is used.',
    sections: [
      { id: 'collect', title: 'What Aerva collects', points: [
        'Details you give: name, email, phone, profile, bookings, messages and reviews.',
        'From hosts and co-hosts: verification results, PAN, bank details and listing details.',
        'Payment references. Card and UPI details are handled by the payment provider, not Aerva.',
        'Technical data such as IP address and device, for security.'
      ]},
      { id: 'use', title: 'Why', points: [
        'To run your account, bookings, payments, payouts and messages, to keep Aerva safe, and to meet legal duties.',
        'Aerva does not sell your information.'
      ]},
      { id: 'share', title: 'Who receives it', points: [
        'The other party to your booking, as needed for the stay.',
        'Service providers that operate Aerva, such as payment, email, hosting and sign-in providers.',
        'Authorities, where the law requires.'
      ]},
      { id: 'keep', title: 'How long', points: [
        'Until you delete your account. Deleting it erases your personal information; booking and payment records are kept without it, as the law requires.'
      ]},
      { id: 'contact', title: 'Contact', points: [
        'For anything about your information, write to hello@aerva.in. Complaints may also be made to the Data Protection Board of India.'
      ]},
      { id: 'changes', title: 'Changes', points: [
        'Aerva may update this policy at any time. The version on this page applies.'
      ]}
    ]
  },

  // The Policy Center (index.html?view=policies). Each document opens on
  // its own (…&doc=<id>). Minimal and protective: rules and Aerva’s rights,
  // no timelines or outcomes Aerva would be held to. Every point matches
  // what Aerva actually does (fees, windows and cut-offs checked in code).
  documents: [
    { id: 'payments', title: 'Payments Terms of Service', summary: 'How payments, refunds and payouts are handled on Aerva.', sections: [
      { title: 'Payments', points: [
        'Payments are processed by Aerva’s payment partner. Aerva does not store card, UPI or bank login details.',
        'Charges are in Indian Rupees. Amounts shown in other currencies are estimates.',
        'A booking is confirmed only when payment succeeds.'
      ]},
      { title: 'Refunds', points: [
        'Refunds, where due, go to the original payment method. Timing depends on your bank or card issuer.'
      ]},
      { title: 'Coupons', points: [
        'A coupon covers the booking price only. The guest service fee, GST and any security deposit are charged in full, on the full booking price.',
        'If the booking price is more than the coupon, you pay the difference plus the service fee, GST and any deposit.',
        'If the coupon is worth more than the booking price, the unused balance is forfeited. It is not refunded, carried over or exchanged for cash.',
        'One coupon per booking. Coupons belong to the account they were issued to and expire on the date shown.'
      ]},
      { title: 'Payouts to hosts and co-hosts', points: [
        'Payouts are made automatically to a verified bank account after check-out, after Aerva’s fees and TDS.',
        'Aerva may hold, adjust or withhold a payout for disputes, refunds, damage claims, suspected fraud or legal reasons.',
        'Aerva pays hosts and co-hosts their own shares only. Co-host shares are paid in full, without deductions. Any other money between a host and a co-host is for them to settle between themselves.'
      ]}
    ]},
    { id: 'service-fees', title: 'Service Fees Policy', summary: 'How Aerva’s service fees are charged to hosts and guests.', sections: [
      { title: 'Guests', points: [
        'A guest service fee of 8% of the booking price is added to your total and shown before you pay.'
      ]},
      { title: 'Hosts', points: [
        'Aerva’s commission is 10% of the stay price and 5% of paid amenities. It is deducted from your payout.'
      ]},
      { title: 'General', points: [
        'Taxes are added separately (see the Taxes Policy). Security deposits carry no service fee.',
        'Service fees are refunded only when a host cancels, or where Aerva decides or the law requires.',
        'Aerva may change its fees. The fees shown when you book apply to that booking.'
      ]}
    ]},
    { id: 'offline-fees', title: 'Offline Fee Policy', summary: 'When a host may charge anything outside Aerva.', sections: [
      { title: 'Rule', points: [
        'Hosts may not charge guests any fee outside Aerva. Every charge must be part of the price shown on Aerva before booking.',
        'Security deposits and damage claims go through Aerva only.'
      ]}
    ]},
    { id: 'off-platform', title: 'Off-Platform Policy', summary: 'What must not happen outside Aerva.', sections: [
      { title: 'Rules', points: [
        'Do not ask for, offer or accept payment outside Aerva for a stay or experience found on Aerva.',
        'Do not use contact details from Aerva to book or pay outside it.',
        'Keep messages about a booking on Aerva.',
        'Aerva may cancel bookings and suspend accounts that break this policy.'
      ]}
    ]},
    { id: 'taxes', title: 'Taxes Policy', summary: 'What taxes may apply to a booking.', sections: [
      { title: 'Guests', points: [
        'GST applies to bookings and is added to your total, where the law requires.',
        'Other local taxes may apply to your stay under the law where the property is.'
      ]},
      { title: 'Hosts and co-hosts', points: [
        'Tax deducted at source (TDS) is deducted from host and co-host payouts: 0.1% when a PAN is provided, 5% when it is not.',
        'You are responsible for your own income tax, GST registration and any other taxes on your earnings.'
      ]}
    ]},
    { id: 'host-privacy', title: 'Host Privacy Standards', summary: 'How hosts and co-hosts must handle guests’ personal information.', sections: [
      { title: 'Rules', points: [
        'Use a guest’s information only for their booking and to meet legal duties, such as reporting foreign guests.',
        'Do not share, sell or publish it. Keep ID copies secure and only as long as the law requires.',
        'Do not place cameras or recording devices in bedrooms, bathrooms or any private space. Disclose every device elsewhere on the property.'
      ]}
    ]},
    { id: 'experience-host-terms', title: 'Additional Terms for Experience Hosts', summary: 'Extra terms for hosts who offer experiences.', sections: [
      { title: 'Rules', points: [
        'Hold every licence, permit and insurance your experience requires.',
        'Describe the experience accurately, including its duration, group size, age limits, skill or fitness needs, and any risks.',
        'Run it safely and as described. You are responsible for your experience and everyone who helps you run it.',
        'Guests take part at their own risk, to the extent the law allows.'
      ]}
    ]},
    { id: 'cancellation-stays', title: 'Cancellation Policy for Stays', summary: 'How cancellations work for stays.', sections: [
      { title: 'Guests', points: [
        'For an environmental hazard, a life-threatening situation or an emergency, request a cancellation from My Bookings. If the host accepts, you are refunded in full.',
        'For any other cancellation, write to hello@aerva.in with your booking ID. Refunds, where due, follow the terms shown when you booked.'
      ]},
      { title: 'Hosts', points: [
        'Hosts may cancel only more than 48 hours before check-in, and must give a reason. The guest is told the reason.',
        'When a host cancels, the guest is refunded in full at once (booking and security deposit). The refund starts automatically.',
        'The guest also receives an Aerva coupon worth 10% of the booking, valid for 3 months. It is sent automatically 15 minutes after the cancellation.',
        'The host pays for the coupon, either before cancelling or by deduction from their next payout.'
      ]},
      { title: 'Co-hosts', points: [
        'The same rules apply when a co-host cancels on the host’s behalf.',
        'The co-host pays for the coupon from their own account before cancelling.',
        'Any money between a host and a co-host, including for cancellations, is for them to settle between themselves. Aerva is not involved.'
      ]}
    ]},
    { id: 'cancellation-experiences', title: 'Cancellation Policy for Experiences', summary: 'How cancellations work for experiences.', sections: [
      { title: 'Rule', points: [
        'Each experience shows its own refund terms before booking. Those terms apply.',
        'If a host or co-host cancels, the guest is refunded in full and, 15 minutes later, receives an Aerva coupon worth 10% of the booking, paid for by whoever cancelled.'
      ]}
    ]},
    { id: 'major-events', title: 'Major Disruptive Events Policy', summary: 'When events beyond anyone’s control stop a booking.', sections: [
      { title: 'Covered events', points: [
        'Events that arise after booking and make it impractical or illegal to complete, such as natural disasters, epidemics, government orders or travel restrictions, or major damage to the property.'
      ]},
      { title: 'What happens', points: [
        'Write to hello@aerva.in with your booking ID and evidence. Aerva may cancel the booking and decide any refund or coupon.',
        'Known or foreseeable events at the time of booking, and personal circumstances, are not covered.'
      ]}
    ]},
    { id: 'stay-issues', title: 'Stay Issues and Refund Policy', summary: 'What happens when a stay cannot go ahead as booked.', sections: [
      { title: 'When it applies', points: [
        'You cannot get in, or the property is unsafe, not clean, or significantly different from its listing.'
      ]},
      { title: 'What to do', points: [
        'Tell your host through Aerva Messages and write to hello@aerva.in with photos, before check-out.',
        'Aerva may offer a full or partial refund or an Aerva coupon, at its discretion.'
      ]}
    ]},
    { id: 'refund-experiences', title: 'Refund Policy for Experiences', summary: 'How refunds work when an experience is disrupted.', sections: [
      { title: 'Rule', points: [
        'If the host cancels or the experience does not take place as described, write to hello@aerva.in. Aerva may offer a refund or an Aerva coupon, at its discretion.'
      ]}
    ]},
    { id: 'resolution', title: 'Security Deposit and Damage Policy', summary: 'How security deposits are refunded and damage is handled.', sections: [
      { title: 'Security deposit', points: [
        'Some listings hold a refundable security deposit, shown before you pay.',
        'It is refunded to the original payment method after check-out, unless the host reports damage through Aerva within 7 days of check-out.',
        'If damage is reported, Aerva reviews it and decides how much of the deposit, if any, goes to the host. The rest is refunded. Aerva’s decision on the deposit is full and final.'
      ]},
      { title: 'Damage above the deposit', points: [
        'Aerva handles damage claims only up to the security deposit.',
        'Damage above the deposit, or where no deposit is held, is between the host and the guest, to be resolved under the law. Aerva is not a party to it and pays no part of it.'
      ]}
    ]},
    { id: 'reviews', title: 'Reviews Policy', summary: 'The rules for reviews left on Aerva.', sections: [
      { title: 'Rules', points: [
        'Guests and hosts may review each other within 15 days of check-out.',
        'Reviews must be honest, first-hand and about the stay or experience. Do not offer or accept anything in return for a review, and do not use reviews to threaten or retaliate.',
        'Aerva may remove any review.'
      ]}
    ]},
    { id: 'community', title: 'Community Policies', summary: 'What Aerva expects of everyone in its community.', sections: [
      { title: 'Safety and respect', points: [
        'Follow the law and the house rules. No parties or events unless the host allows them.',
        'No violence, threats, verbal abuse, harassment or discrimination of any kind, including on gender.',
        'In an emergency, call the local emergency number (112 in India).'
      ]},
      { title: 'Pets and service animals', points: [
        'Bring pets only to pet-friendly listings, within their limits. Declare every pet and service or support animal when you book.',
        'Hosts may not ask for proof that a service or support animal is needed.'
      ]},
      { title: 'Reliability', points: [
        'Hosts honour confirmed bookings and describe their listings accurately. Guests respect the property and pay for damage they cause.'
      ]},
      { title: 'Enforcement', points: [
        'Aerva may suspend or remove any account, booking or listing that breaks these policies.'
      ]}
    ]},
    { id: 'safety-liability', title: 'Personal Safety and Liability Policy', summary: 'Who is responsible for safety, harm and emergencies.', sections: [
      { title: 'Your responsibility', points: [
        'Guests and hosts are responsible for their own safety and conduct, and for any physical, mental or emotional harm they cause or suffer that is beyond Aerva’s control.',
        'In an emergency, call the local emergency number (112 in India) and the relevant authorities first.'
      ]},
      { title: 'What Aerva is not liable for', points: [
        'To the extent the law allows, Aerva is not liable for, and pays no claim for, criminal acts, death, injury, self-harm, medical or life-threatening situations, or any act or omission of a host, guest or third party.'
      ]},
      { title: 'Decisions', points: [
        'Aerva’s decision on any matter under its policies is full and final.',
        'Guests and hosts accept this policy when they accept the Booking Agreement or Host Agreement.'
      ]}
    ]},
    { id: 'accounts', title: 'Deactivating, Removing and Deleting', summary: 'Deactivating listings or hosting, removing co-hosts, and deleting an account.', sections: [
      { title: 'Deactivating a listing', points: [
        'A host can deactivate a listing at any time. It is hidden from search and takes no new bookings. Confirmed bookings go ahead.',
        'A host can reactivate it at any time. Nothing is deleted.'
      ]},
      { title: 'Deactivating hosting', points: [
        'A host can deactivate all hosting at once. Every live listing is deactivated; confirmed bookings go ahead. The account can still be used to book.',
        'Reactivating hosting restores those listings.'
      ]},
      { title: 'Removing a co-host', points: [
        'A host can remove a co-host, and a co-host can leave, at any time. Access ends at once. Shares already earned are still paid.'
      ]},
      { title: 'Deleting an account', points: [
        'Guests and hosts can delete their account once nothing is open: no upcoming or current stays or bookings, no payouts waiting to be sent, and no cancellation coupons owed.',
        'Deleting erases personal information: name, contact details, photos, profile, sign-in, verification and bank details, messages, review text and reviews about you, and listings with their photos, address and check-in details. Star ratings stay without your name. Booking and payment records are kept without personal details, as the law requires.',
        'Personal information is erased only when an account is deleted. Deactivating keeps everything.',
        'Deletion cannot be undone.'
      ]}
    ]},
    { id: 'content', title: 'Content Policy', summary: 'The rules for anything posted on Aerva.', sections: [
      { title: 'Not allowed', points: [
        'Content that is illegal, false or misleading, sexual, violent, hateful or harassing.',
        'Other people’s personal information, contact details or links for booking outside Aerva.',
        'Photos that are not of the actual listing, or that you do not have the right to use.',
        'Spam or advertising.'
      ]},
      { title: 'Enforcement', points: [
        'Aerva may remove any content, and suspend accounts that break this policy.'
      ]}
    ]},
    { id: 'nondiscrimination', title: 'Nondiscrimination Policy', summary: 'Inclusion and respect for every guest and host.', sections: [
      { title: 'Rule', points: [
        'Do not decline, cancel, charge differently or treat anyone differently because of race, colour, caste, religion, national origin, ethnicity, disability, sex, gender identity, sexual orientation, marital status or age.',
        'Hosts may set rules that apply equally to every guest, such as no smoking or no pets, where the law allows.',
        'Describe accessibility accurately. Do not refuse a guest because of a disability.'
      ]}
    ]},
    { id: 'experience-standards', title: 'Experience Standards and Requirements', summary: 'The standards every experience on Aerva must meet.', sections: [
      { title: 'Standards', points: [
        'The host has real knowledge or skill in what the experience offers.',
        'The experience offers something guests could not easily do on their own.',
        'It is accurate, safe, legal and runs as described.',
        'Aerva may decline or remove any experience that does not meet these standards.'
      ]}
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
    'Privacy policy is published (Aerva Privacy). Add a consent tick to sign-up that links to it (DPDP Rules).',
    'Update the Google consent screen’s privacy policy link to https://aerva.in/index.html?view=privacy, and its Terms of Service link to https://aerva.in/index.html?view=terms.',
    'Have a lawyer review the three Terms of Service versions (India, European users, everyone else), especially liability and indemnity.'
  ]
};
