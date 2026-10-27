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
  updated: '26 September 2026',
  contact: 'hello@aerva.in',

  // Shown before payment (guest) and before listing (host). The version is
  // saved with every booking and every host acceptance; it must match
  // AGREEMENT_VERSION in api/_agreements.js. Change the text → change both.
  agreements: {
    version: '2026-10-27a',       // booking agreement (guests)
    hostVersion: '2026-10-27b',    // host agreement — accepted for every listing
    guest: {
      title: 'Booking agreement',
      points: [
        'Your booking is an agreement between you and the host. Aerva is the platform that connects you and takes payment.',
        'You: give true details of every guest and pet, keep a confirmed email and a phone number on your account, carry a government photo ID for every adult guest to show the host at check-in, follow the house rules and the law, and pay for any damage you or your guests cause.',
        'Your booking is confirmed only when payment completes within the 3-minute payment window. A payment that does not match the booking amount, or completes after the window, is not a booking and is refunded.',
        'Cancellations and changes are requests to the host through Aerva, under the refund policy shown before you pay. A booking can be cancelled only before check-in.',
        'Once your stay has started: to leave early, ask your host to change your check-out date, or report a problem with evidence, in My Bookings by 10 AM (the property’s local time, the standard check-out time) on the day after check-in. The check-in night is never refunded. If the host agrees to the shorter stay, what you paid for the nights you no longer stay comes back to you as Aerva credit: use it on another booking, or have it refunded to your original payment method at any time from My Bookings (anything left after 30 days is refunded automatically). A request sent in time stands however long the host takes to answer. If the host declines it, or does not answer, you may raise it with Aerva within 24 hours, and Aerva decides.',
        'After 10 AM (the property’s local time) on the day after check-in, the booking can no longer be changed and nothing more is refunded.',
        'The host: provides the home or experience as described, keeps it safe and clean, and follows local laws.',
        'Aerva: takes your payment, handles refunds and complaints under Aerva’s Policies, and keeps your booking records.',
        'No violence, threats, verbal abuse, harassment or discrimination of any kind, including on gender.',
        'Any security deposit is refunded under Aerva’s Security Deposit and Damage Policy. Damage above the deposit is between you and the host, and is to be settled directly with the host.',
        'Aerva provides no support beyond the security deposit and your booking details.',
        'You are responsible for your own safety and for any physical, mental or emotional harm you or your guests cause or suffer that is beyond Aerva’s control.',
        'Aerva does not own, run or inspect properties or experiences, and does not control what hosts or guests do. To the extent the law allows, Aerva is not responsible for the acts or omissions of any host, guest or third party, including criminal acts, death, injury, self-harm or any life-threatening situation, and pays no claim for them.',
        'Aerva’s decision on any matter under its policies is full and final.',
        'Cancellations, refunds, deposits, pets and safety follow Aerva’s Policies.'
      ],
      accept: 'I agree to this booking agreement and Aerva’s Policies.'
    },
    host: {
      // The host agreement has its own version (hostVersion): it is accepted
      // for EVERY listing submitted for review, and saved on that listing
      // and on the host. Must match HOST_AGREEMENT_VERSION in api/_agreements.js.
      title: 'Aerva Host Agreement',
      intro: 'This agreement is between you (the host) and Aerva. It applies to this listing and to every booking made for it. Please read it carefully: by ticking the box below and submitting the listing, you accept it in full, together with Aerva’s Terms of Service and Aerva’s Policies, which form part of it.',
      clauses: [
        { title: '1. Aerva’s role', points: [
          'Aerva is an online platform that connects hosts with guests and collects payment for bookings on the host’s behalf.',
          'Aerva does not own, operate, manage, inspect or control any property or experience, and is not a party to the stay. Each booking is an agreement between you and the guest.',
          'Aerva is not your employer, agent, partner or insurer, and you are not Aerva’s representative.'
        ] },
        { title: '2. Your eligibility and authority to list', points: [
          'You are 18 or older and legally able to enter into this agreement.',
          'You own the property, or hold the written permission of its owner, landlord, housing society or any other party whose permission the law or your lease requires, to host guests there.',
          'You hold every registration, licence and permission your area requires for hosting, and keep them current.',
          'Aerva may ask for proof of ownership or authorisation, registrations and licences at any time. A listing may be declined, paused or removed until satisfactory proof is provided.'
        ] },
        { title: '3. Identity verification', points: [
          'You complete Aerva’s identity and address verification with a valid government ID (such as Aadhaar, passport, driving licence or voter ID) and keep your details current.',
          'Your ID is verified when you submit it and is not stored by Aerva.',
          'The information you give must be true, complete and your own. Aerva may decline, pause or remove a listing, withhold payouts or suspend an account where verification is incomplete, inaccurate or cannot be confirmed.'
        ] },
        { title: '4. PAN and bank details', points: [
          'Payouts are made only to a bank account verified by Aerva and held by the person or business named in your payout details, alone or jointly.',
          'Any PAN you provide must be correct, valid, linked to Aadhaar where the law requires, and in the same name as the payee. A PAN may be used on one Aerva account only.',
          'A company, LLP or partnership firm is paid only to its own bank account, against its own PAN.',
          'When bank details change, payouts are paused for a short security period and you are notified. Aerva is not responsible for delays or losses caused by incorrect, incomplete or outdated details you provide.'
        ] },
        { title: '5. Commission and fees', points: [
          'Aerva charges you a commission on each booking, at the commission rate shown in your dashboard. It is deducted from your payout. Aerva also charges guests a service fee, which is Aerva’s own and does not form part of your earnings.',
          'Aerva may revise its commission. A revised commission takes effect no sooner than 33 days after Aerva’s formal notice to you by email (31 days’ notice, plus 2 days to allow for time zones), and applies to bookings made on or after the date given in the notice. Aerva may revise the guest service fee at any time. The rates in force when a booking is made apply to that booking.',
          'You acknowledge and confirm each commission revision in your dashboard before the date it takes effect. If it is not confirmed by that date, this agreement ends, as set out in the Termination clause below.'
        ] },
        { title: '6. Payouts and taxes', points: [
          'Your payout for a booking is sent the day after check-in (for an experience, the day after its date) to your verified bank account, after Aerva’s commission, any co-host share, applicable deductions and tax deducted at source.',
          'If a booking changes after its payout has been sent — it is cancelled, shortened or extended, or a guest’s report during the stay is upheld — any amount you are no longer owed is deducted from your next payout, and any amount added is paid to you separately.',
          'Aerva may hold, adjust or withhold a payout while a guest’s report, a refund, a damage claim or a dispute is open, where fraud is suspected, or where the law requires.',
          'You are solely responsible for your income tax, GST registration where applicable, and every other tax on your earnings.'
        ] },
        { title: '7. Tax deducted at source (TDS)', points: [
          'Aerva deducts TDS under section 194-O of the Income-tax Act (section 393 of the Income-tax Act, 2025) from every payment it makes to you, including security deposit compensation, from the first rupee.',
          'TDS is deducted at 0.1% where a valid and operative PAN is provided, and at 5% where it is not, or where the PAN is inoperative.',
          'TDS deducted is deposited with the government against your PAN, appears in your Form 26AS, and may be claimed in your income tax return.'
        ] },
        { title: '8. Your listing', points: [
          'Your listing, photos, prices, amenities, house rules, capacity and availability are accurate, complete and kept up to date.',
          'Photos must be of the actual property and must not show phone numbers, email addresses, websites, social media handles or QR codes. Any such photo is removed.',
          'Every charge to a guest is included in the price shown on Aerva. You may not charge any fee outside Aerva.',
          'Every listing is reviewed before it goes live. Aerva may decline, edit, pause or remove any listing at its discretion.'
        ] },
        { title: '9. Bookings and the relationship with guests', points: [
          'You honour every confirmed booking and provide the property as described, safe, clean and ready at check-in.',
          'You check a valid government photo ID for every adult guest at check-in, and report foreign guests on Form III within 24 hours of arrival and of departure, as the law requires.',
          'All communication about a booking stays on Aerva Messages. Once a booking is confirmed, phone numbers and email addresses may be shared there until check-out, and photos until the review period closes (15 days after check-out). Taking bookings or payments outside Aerva, or using a guest’s details to do so, is not allowed.',
          'You use guests’ personal information only for their booking and your legal duties, and keep it secure. No camera or recording device may be placed in a bedroom, bathroom or any private space; every device elsewhere must be disclosed in the listing.'
        ] },
        { title: '10. Check-in and check-out', points: [
          'Your listing states its check-in and check-out times, and you have the property ready at check-in.',
          'At check-in, you check a valid government photo ID for every adult guest; guests from outside India show their passport. Only the guests named in the booking, up to the number booked, may stay.',
          'For a booking made late at night for the night that has already begun, the guest may check in straight away, as set out in Aerva’s Booking Requirements.',
          'Check-in instructions and access details are given to the guest through Aerva only.'
        ] },
        { title: '11. Pets and service animals', points: [
          'Your listing states whether pets are allowed, how many and which types, and any pet fee. Pet fees are charged only through Aerva, as part of the booking.',
          'Guests declare every pet and service or support animal when they book. You may not ask for proof that a service or support animal is needed, or refuse one because of a disability.',
          'Damage caused by a pet is handled like any other damage, under the Security Deposit and Damage clause.'
        ] },
        { title: '12. Contact details and communication', points: [
          'No listing, photo, description, review, message or email sent through Aerva may contain a phone number, email address, website, social media handle, UPI ID, QR code or any other contact detail of you or any other person.',
          'Once a booking is confirmed, you and the guest may share phone numbers and email addresses in Aerva Messages until check-out, and photos until the review period closes (15 days after check-out). Other contact details (links, social media or messaging accounts, UPI IDs) are removed from messages automatically. Once the stay has ended or been cancelled, phone numbers, email addresses and any photo showing contact details are removed from the conversation.',
          'Aerva may remove any such content at once, without notice. You are liable for any loss or claim arising from contact details you share in breach of this clause, and repeated breaches may lead to penalties, removal of the listing and suspension of your account.'
        ] },
        { title: '13. Cancellations', points: [
          'Each listing carries the cancellation policy you choose (Flexible or Firm). A booking keeps the policy it was paid under.',
          'You answer guests’ cancellation and change requests in Aerva Messages within 24 hours. An unanswered request is settled under Aerva’s Cancellation Policy.',
          'You may cancel a booking only 48 hours or more before check-in, with a reason, and no more than 3 times in any 12 months. Further cancellations are handled only by Aerva.'
        ] },
        { title: '14. Refunds', points: [
          'Refunds to guests are made by Aerva under Aerva’s Cancellation Policy, Changing a Booking policy and Stay Issues and Refund Policy, and the amount you receive is adjusted accordingly.',
          'When a guest asks to change a stay that has started, or reports a problem, you are told and may give your side through Aerva. Until it is settled, only the first night of your payout for that booking is sent; the rest follows once it is settled, after any refund decided.'
        ] },
        { title: '15. Penalties', points: [
          'If you cancel a confirmed booking, the guest receives an Aerva coupon worth 10% of the booking, paid for by you before the booking is cancelled, or deducted from your next payout.',
          'Cancellations count towards your yearly limit and may affect your standing on Aerva.',
          'For any breach of this agreement or Aerva’s Policies, Aerva may withhold or adjust payouts, pause or remove listings, cancel bookings, and suspend or close your account.'
        ] },
        { title: '16. Security deposits and damage', points: [
          'If your listing holds a refundable security deposit, Aerva holds it and refunds it to the guest after check-out unless you report damage through Aerva within 7 days of check-out.',
          'Aerva reviews each damage claim and decides how much of the deposit, if any, is paid to you. Aerva’s decision on the deposit is full and final.',
          'Aerva handles damage claims only up to the security deposit. Damage above the deposit, or where no deposit is held, is between you and the guest, to be settled directly. Aerva is not a party to that settlement and pays no part of it.'
        ] },
        { title: '17. Proof and evidence', points: [
          'Every claim, report or dispute must be supported by clear evidence: dated photos or videos, repair estimates or invoices, and messages on Aerva.',
          'Aerva decides only on the evidence provided through Aerva. A claim without sufficient evidence, or made after the time allowed, may be declined.',
          'Aerva may ask you for further documents at any time, including proof of identity, ownership or authorisation, registrations and invoices.'
        ] },
        { title: '18. Additional guests and misuse of the property', points: [
          'You state the maximum number of guests your property allows. Guests beyond the booking, parties and events are not permitted unless your listing allows them.',
          'Any charge for additional guests, pets, add-ons or any other service is paid only through Aerva, as a change to the booking. A charge taken outside Aerva, in cash or by any other means, is a breach of this agreement, and the booking is treated as a violation under the Penalties clause.',
          'Aerva is not responsible for additional or unregistered guests, or for any illegal, unauthorised or improper use of your property by a guest or any other person. Raise such a matter with Aerva and, where needed, the local authorities.'
        ] },
        { title: '19. Local laws, safety and environmental hazards', points: [
          'You comply with every law that applies to your property and your hosting, including building, fire, health, safety, zoning, tourism, housing society and tax rules.',
          'You keep the property safe and free of hazards, disclose any known risks (including environmental hazards such as flooding, landslides, wildlife or water bodies) in your listing, and maintain working safety equipment where required.',
          'You are responsible for your guests’ safety at your property as the law requires. In an emergency, contact the local emergency number (112 in India) and the relevant authorities first.'
        ] },
        { title: '20. Nondiscrimination and conduct', points: [
          'You may not decline, cancel, charge differently or treat anyone differently because of race, colour, caste, religion, national origin, ethnicity, disability, sex, gender identity, sexual orientation, marital status or age.',
          'House rules must apply equally to every guest. Accessibility must be described accurately.',
          'Violence, threats, verbal abuse, harassment and discrimination of any kind are not tolerated and lead to removal from Aerva.'
        ] },
        { title: '21. Co-hosts', points: [
          'If you invite co-hosts, you remain responsible for your listing and for everything your co-hosts do on it. Aerva pays each co-host their own share; any other arrangement between you and a co-host is for you to settle.'
        ] },
        { title: '22. Contacting Aerva', points: [
          'For any matter about a booking, a guest, a payout or your listing, raise a request in the Resolution Center or write to hello@aerva.in. Every request receives a reference number.',
          'Formal complaints may be addressed to Aerva’s Grievance Officer at hello@aerva.in.'
        ] },
        { title: '23. Aerva’s discretion on disputes', points: [
          'Aerva reviews every dispute between you and a guest on the information and evidence available to it, and decides at its sole discretion.',
          'Aerva’s decision on any matter under this agreement and Aerva’s Policies is full and final.'
        ] },
        { title: '24. Reputation and fair comment', points: [
          'You will not make, publish or share any false, misleading, defamatory or disparaging statement about Aerva, its team or its services, on any platform or in any medium.',
          'Concerns about Aerva are to be raised with Aerva through the Resolution Center or the Grievance Officer. A breach of this clause may lead to suspension or closure of your account, without prejudice to Aerva’s legal rights.'
        ] },
        { title: '25. Liability and indemnity', points: [
          'To the extent the law allows, Aerva is not liable for the acts or omissions of any guest, host or third party, including criminal acts, death, injury, self-harm, loss of or damage to property, or any life-threatening situation, and pays no claim for them.',
          'To the extent the law allows, Aerva’s total liability for any claim is limited to the fees Aerva received for the booking concerned.',
          'You will compensate Aerva for any claim, loss, penalty or cost arising from your listing, your property, your hosting or your breach of this agreement, Aerva’s Policies or the law.',
          'You are responsible for your own property, contents and liability insurance.'
        ] },
        { title: '26. Acceptance, records and copies', points: [
          'This agreement is accepted for each listing you submit, and again whenever Aerva revises it. Each acceptance is recorded with the version, the listing, the date and time.',
          'A copy of the agreement you accepted is emailed to you each time, and every agreement you have accepted can be viewed in your dashboard under Account → Host Agreement.',
          'The version published by Aerva is the binding version. Aerva’s interpretation of this agreement and its Policies is final.'
        ] },
        { title: '27. Revisions', points: [
          'Aerva may revise this agreement and its Policies at any time. A revision takes effect when it is published. Commission revisions follow the notice period in the Commission and fees clause.',
          'Aerva emails you a formal notice of every revision. You accept the revised agreement in your dashboard, or decline it.',
          'Bookings already confirmed keep the commission and fees in force when they were made.'
        ] },
        { title: '28. Termination', points: [
          'If you decline a revised agreement, or do not accept it within 30 days of Aerva’s notice, or you decline a commission revision, or have not acknowledged it by the date it takes effect, this agreement ends. Your listings are deactivated and removed from Aerva, and they take no new bookings.',
          'Confirmed bookings go ahead unless Aerva decides otherwise. Amounts due to you for completed stays are paid to your verified bank account, less any amounts you owe Aerva, such as cancellation coupons, refunds or penalties.',
          'You may end this agreement at any time by deactivating your listings or your hosting. Aerva may end it, or suspend or remove any listing or account, if this agreement, Aerva’s Policies or the law are broken.',
          'Your account and data are then handled under Aerva’s Deactivating, Removing and Deleting policy. You may delete your account once nothing is open; booking and payment records are kept as the law requires.',
          'After this agreement ends, you are offered the current agreement each time you sign in. Accepting it (with the commission then in force) before your account is deleted puts back the listings that were deactivated only because the agreement ended. If you do not accept it, the same applies at every later revision.'
        ] },
        { title: '29. General', points: [
          'This agreement, Aerva’s Terms of Service and Aerva’s Policies are the entire agreement between you and Aerva about hosting. If any part is found unenforceable, the rest remains in force.',
          'This agreement is governed by the laws of India. Disputes are subject to the courts of competent jurisdiction in India.'
        ] }
      ],
      accept: 'I have read and accept the Aerva Host Agreement, Aerva’s Terms of Service and Aerva’s Policies for this listing.'
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
        'Questions, complaints and grievances: the Resolution Center (index.html?view=help), or write to hello@aerva.in.',
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
        'Photos and documents you send as evidence when reporting a problem with a stay, and what you send in a Resolution Center request.',
        'From hosts and co-hosts: verification results, PAN, bank details and listing details.',
        'ID verification, if you choose to verify: the result only (the type of ID, your name as on it, its last 4 characters and when it was verified). The ID itself is checked automatically and is never stored.',
        'Payment references. Card and UPI details are handled by the payment provider, not Aerva.',
        'Technical data such as IP address and device, for security.'
      ]},
      { id: 'use', title: 'Why', points: [
        'To run your account, bookings, payments, payouts and messages, to keep Aerva safe, and to meet legal duties.',
        'To send guests who have not booked lately an offers email about once a quarter. Switch it off in Account Settings → Privacy, or with the unsubscribe link in the email.',
        'Aerva does not sell your information.'
      ]},
      { id: 'share', title: 'Who receives it', points: [
        'The other party to your booking, as needed for the stay.',
        'Service providers that operate Aerva, such as payment, email, hosting, sign-in and automated checking providers (an ID you verify is read by one, and not kept by it or by Aerva).',
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
      { title: 'The payment window', points: [
        'When you continue to payment, the dates are held for you for 3 minutes. No one else can book or see them as available during that time.',
        'Pay within the 3 minutes. Closing the payment window, a failed payment or the timer running out ends it at once and releases the dates.',
        'A payment completed after the window has ended, or after it was closed or cancelled, is not a booking. It is refunded in full.',
        'You have 5 payment attempts per listing per day.',
        'If the host changes a price after you open a listing, you are shown the new price before paying.'
      ]},
      { title: 'Amount checks', points: [
        'The amount you pay must equal the booking amount. If it does not, the booking is cancelled and the full amount paid is refunded the next day.'
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
        'Payouts are made automatically to a verified bank account the day after check-in (for an experience, the day after its date), after Aerva’s fees and TDS.',
        'If a booking changes after its payout has been sent, an amount the host or co-host is no longer owed is deducted from their next payout, and an amount added is paid separately.',
        'Payouts go only to a verified bank account held by the person or business named in the payout details (the host or someone else), alone or jointly. When a PAN is given, it must be in that same name, and TDS is deducted against it. A company, LLP or partnership firm is paid only to its own account, against its own PAN.',
        'When bank details change, payouts wait 48 hours, and the account owner is emailed about the change.',
        'Aerva may hold, adjust or withhold a payout for disputes, refunds, damage claims, suspected fraud or legal reasons.',
        'Aerva pays hosts and co-hosts their own shares only. Co-host shares are paid in full, without deductions. Any other money between a host and a co-host is for them to settle between themselves.'
      ]}
    ]},
    { id: 'service-fees', title: 'Service Fees Policy', summary: 'How Aerva’s service fees are charged to hosts and guests.', sections: [
      { title: 'Guests', points: [
        'A guest service fee, a percentage of the booking price, is added to your total and shown before you pay.'
      ]},
      { title: 'Hosts', points: [
        'Aerva’s commission is a percentage of the stay price, paid amenities and pet fees, at the commission rate shown in your dashboard. It is deducted from your payout.',
        'A revised commission is announced by email at least 33 days before it takes effect (31 days’ notice, plus 2 days for time zones), and applies to bookings made from the date given. Hosts acknowledge it in their dashboard.'
      ]},
      { title: 'General', points: [
        'Taxes are added separately (see the Taxes Policy). Security deposits carry no service fee.',
        'Aerva’s guest service fee is not refunded: not when a guest cancels, when Aerva cancels, when a booking is changed to a lower price, or when a stay issue is upheld. It is refunded only when a booking fails because of a mistake on Aerva’s side, or in an exceptional case where Aerva, at its sole discretion, decides to refund it.',
        'Aerva may change the guest service fee at any time, and its commission on the notice above. The fees shown when you book apply to that booking.'
      ]}
    ]},
    { id: 'offline-fees', title: 'Offline Fee Policy', summary: 'When a host may charge anything outside Aerva.', sections: [
      { title: 'Rule', points: [
        'Hosts may not charge guests any fee outside Aerva. Every charge must be part of the price shown on Aerva before booking.',
        'Security deposit claims go through Aerva, up to the deposit. Anything beyond the deposit is settled directly between the host and the guest.'
      ]}
    ]},
    { id: 'off-platform', title: 'Off-Platform Policy', summary: 'What must not happen outside Aerva.', sections: [
      { title: 'Rules', points: [
        'Do not ask for, offer or accept payment outside Aerva for a stay or experience found on Aerva.',
        'Do not use contact details from Aerva to book or pay outside it.',
        'Keep messages about a booking on Aerva.',
        'Once a booking is confirmed, the guest and host may share phone numbers and email addresses in its Aerva Messages until check-out, and photos until the review period closes (15 days after check-out). Other contact details (links, social media or messaging accounts, UPI IDs) are not allowed in messages.',
        'Once the stay has ended or the booking is cancelled, phone numbers, email addresses and any photo showing contact details are removed from the conversation.',
        'Aerva may cancel bookings and suspend accounts that break this policy.'
      ]}
    ]},
    { id: 'taxes', title: 'Taxes Policy', summary: 'What taxes may apply to a booking.', sections: [
      { title: 'Guests', points: [
        'GST applies to bookings and is added to your total, where the law requires.',
        'Other local taxes may apply to your stay under the law where the property is.'
      ]},
      { title: 'Hosts and co-hosts', points: [
        'Tax deducted at source (TDS) is deducted from every payment Aerva makes to a host or co-host, including security deposit compensation: 0.1% when a valid PAN is provided, 5% when it is not or the PAN is inoperative (not linked to Aadhaar).',
        'TDS is worked out on the amount due to you: for a host, the booking amount after Aerva’s commission and any co-host share; for a co-host, their share. GST and Aerva’s guest service fee are never part of it. A cancellation coupon you owe is deducted after TDS and does not reduce it.',
        'As Aerva’s policy, TDS is deducted on every payment from the first rupee, including for individuals and HUFs earning under ₹5,00,000 a year through Aerva. Any TDS deducted counts towards your income tax and can be claimed in your return.',
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
      { title: 'Refund policies', points: [
        'Each listing has a Flexible or Firm policy, shown before you pay. Your booking keeps the policy it was paid under.',
        'Flexible: 30 or more days before check-in, full refund; 10 to 29 days, 80%; 5 to 9 days, 50%; 2 to 4 days, 30%; less than 2 days, the host decides (0 to 100%).',
        'Firm: 30 or more days before check-in, full refund; 5 to 29 days, 50%; less than 5 days, the host decides (0 to 100%). If the host declines, there is no refund.',
        'Days are counted to the listing’s check-in time, where the property is. For example, for check-in tomorrow at 1:00 PM, a request made today before 1:00 PM is 24 hours or more before check-in; a request at 2:00 PM is less.'
      ]},
      { title: 'How a guest cancels', points: [
        'Send a cancellation request from My Bookings or the booking’s Messages thread. The host accepts or rejects it.',
        'The refund percentage is fixed when you send the request.',
        'If the host does not answer within 24 hours, a request with a fixed refund is accepted at that refund, and a request where the host decides is settled with no refund.',
        'Refunds cover the booking price and its GST at the percentage above. Aerva’s guest service fee is not refunded. The security deposit is always refunded in full.',
        'Before check-in, for an environmental hazard, a life-threatening situation, a medical or family emergency, or a travel restriction, choose that reason. If the host accepts, the booking price, GST and deposit are refunded in full.',
        'Once the stay has started, a booking cannot be cancelled. To leave early, change the check-out date (see Changing a Booking).',
        'A part paid by coupon is returned as a coupon, in the same proportion.'
      ]},
      { title: 'Hosts', points: [
        'Hosts may cancel only 48 hours or more before check-in time, and must give a reason. The guest is told the reason.',
        'A host may cancel at most 3 bookings in any 12 months. Further cancellations are handled only by Aerva.',
        'When a host cancels, the guest is refunded at once: the booking price, its GST and the security deposit. Aerva’s service fee is held for the guest as Aerva credit for 30 days: it is taken off what they pay for their next Aerva booking (anything left stays on the credit), or, if they decide not to book again, it is refunded in full to the original payment method — at any time from My Bookings, or automatically when the 30 days end.',
        'The guest also receives an Aerva coupon worth 10% of the booking, valid for 3 months, sent automatically 15 minutes after the cancellation. The host pays for it before the booking is cancelled.',
        'What a guest is not refunded after cancelling is paid to the host, less Aerva’s commission, on the usual payout day.'
      ]},
      { title: 'Co-hosts', points: [
        'The same rules apply when a co-host acts for the host. A co-host pays for the coupon from their own account before cancelling.',
        'Any money between a host and a co-host is for them to settle between themselves.'
      ]}
    ]},
    { id: 'booking-changes', title: 'Changing a Booking', summary: 'How guests change dates, guests, pets or add-ons.', sections: [
      { title: 'What can change', points: [
        'Stays: dates (move, extend or shorten), the number of guests, pets and paid add-ons.',
        'Experiences: the date and the number of guests.',
        'An experience that includes a stay changes together with its stay: a new date moves both, and the number of guests applies to both.',
        'Any time before check-in. Once the stay has started, only until 10 AM (the property’s local time, the standard check-out time) on the day after check-in. After that the booking cannot be changed and nothing more is refunded.',
        'During a stay, check-in cannot move; check-out, guests and add-ons can. The new check-out can be the day after check-in at the earliest: the check-in night is never refunded.',
        'If the host agrees to a shorter stay, what you paid for the nights you no longer stay is held for you as Aerva credit, not refunded to your payment. It is taken off your next Aerva booking automatically, or refunded to your original payment method whenever you ask from My Bookings; anything left after 30 days is refunded automatically.',
        'A request sent in time stands however long the host takes to answer. If the host declines it, or does not answer, you may raise it with Aerva within 24 hours from My Bookings (Report a problem); Aerva decides.'
      ]},
      { title: 'How', points: [
        'Choose the change in My Bookings. The new price and the difference are shown before you send it.',
        'The request goes to the host in Aerva Messages. The host accepts or rejects it. Until then, the booking stays as it is.',
        'If the new total is lower, the full difference is refunded once the host accepts. During a stay it is held for you as Aerva credit instead, which you can have refunded at any time.',
        'If the new total is higher, pay the difference within 24 hours of the host accepting, through the 3-minute payment window. The change applies only when that payment succeeds.',
        'If prices change before the host answers or before you pay, the request closes; send a new one.'
      ]}
    ]},
    { id: 'booking-requirements', title: 'Booking Requirements', summary: 'What every guest needs to book, and late-night bookings.', sections: [
      { title: 'To book', points: [
        'An Aerva account with a confirmed email address and a mobile number.',
        'Your name, mobile number and the number of guests are shared with the host.',
        'Carry a government photo ID for every adult guest. The host checks it at check-in. Guests from outside India carry their passport.',
        'You can also verify your ID on Aerva (Account Settings → ID verification) with Aadhaar, a passport, driving licence or voter ID. It takes under a minute, your ID is not stored, and hosts see that you are verified.'
      ]},
      { title: 'Late-night bookings', points: [
        'Between 12:00 AM and 6:00 AM, where the property is, you may still book the night that has already begun. It counts as the previous day’s night, with check-out that day or later. Once booked, you may check in straight away.'
      ]}
    ]},
    { id: 'cancellation-experiences', title: 'Cancellation Policy for Experiences', summary: 'How cancellations work for experiences.', sections: [
      { title: 'Rule', points: [
        'Each experience shows its own refund terms before booking. Those terms apply.',
        'If a host or co-host cancels, the guest is refunded the price and its GST at once and, 15 minutes later, receives an Aerva coupon worth 10% of the booking, paid for by whoever cancelled. Aerva’s service fee is held for the guest as Aerva credit for 30 days: it is taken off what they pay for their next Aerva booking (anything left stays on the credit), or, if they decide not to book again, it is refunded in full to the original payment method — at any time from My Bookings, or automatically when the 30 days end.'
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
    { id: 'stay-issues', title: 'Stay Issues and Refund Policy', summary: 'What happens when a guest is not happy during a stay.', sections: [
      { title: 'Reporting a problem', points: [
        'Report the problem from My Bookings with at least one photo or document as evidence, once the stay has started and by 10 AM (the property’s local time) on the day after check-in. A change you asked for in that time that the host declined, or did not answer, can be reported within 24 hours of that.',
        'After 10 AM (the property’s local time) on the day after check-in, problems can no longer be reported for a refund.',
        'The host is told and gives their side through Aerva.'
      ]},
      { title: 'Aerva’s decision', points: [
        'Aerva reviews the guest’s report, the evidence and the host’s response, and decides whether a refund is due.',
        'If upheld, every night after the check-in night is refunded, with its GST. The check-in night is not refunded. Aerva’s service fee is not refunded. The host is paid for the nights not refunded, less Aerva’s commission.',
        'The security deposit is handled separately under the Security Deposit and Damage Policy.',
        'Aerva’s decision is full and final.'
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
        'Damage above the deposit, or where no deposit is held, is between the host and the guest, and is to be settled directly between them.',
        'Aerva provides no support beyond the security deposit and the booking details. It is not a party to any settlement and pays no part of it.'
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
        'Phone numbers, email addresses, websites, social media handles or QR codes in listing photos. Any such photo is removed.',
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

  // The Resolution Center (index.html?view=help): how guests and hosts get
  // help, the help topics, and what each badge means. Rendered by
  // aerva-help.js.
  //
  // Wording rule: tell people what to do and what to expect, never how
  // Aerva weighs or decides (no internal rules, weights or thresholds).
  // The decision rules for the support team live in adminNotes, which only
  // the admin tool shows.
  support: {
    // Contact options. A blank value hides that option on the page, so
    // nothing dead is ever shown. Fill these in when the numbers are live:
    //   tollFree: '1800 123 4567'          (shown as a tap-to-call button)
    //   whatsapp: '+91 98765 43210'        (opens WhatsApp to this number)
    //   hours:    'Every day, 9 AM – 9 PM IST'
    contacts: {
      tollFree: '',
      whatsapp: '',
      email: 'hello@aerva.in',
      hours: ''
    },
    // Required by the Consumer Protection (E-Commerce) Rules, 2020: the
    // Grievance Officer's name, designation and contact. Fill in the name.
    grievanceOfficer: {
      name: '',
      designation: 'Grievance Officer',
      email: 'hello@aerva.in'
    },
    intro: 'Help with a booking, a stay, hosting or your account. Find answers below, or raise a request and our support team will take it from there.',
    emergency: 'If anyone is in danger or needs urgent medical help, call 112 first. Then tell us.',

    // Shown as "Our commitments".
    commitments: [
      { title: 'A reference number at once', text: 'Every request gets a reference number the moment you send it, confirmed by email.' },
      { title: 'A reply within 48 hours', text: 'A member of our support team replies within 48 hours, usually much sooner.' },
      { title: 'Resolved quickly', text: 'Most requests are resolved within a few days, and we keep you updated at every step.' },
      { title: 'One place for everything', text: 'Follow your request, reply and add files under My requests. We email you whenever we reply.' }
    ],

    // Shown as "How a request works". General steps only.
    process: [
      { title: 'Tell us', text: 'Choose what it is about, pick the booking or listing, describe what happened and add photos or documents.' },
      { title: 'We acknowledge it', text: 'You receive a reference number straight away. Keep it for anything about this request.' },
      { title: 'We look into it', text: 'We review the booking details and what you send us. Where another person is involved, we may ask them for their side. We may ask you for more information.' },
      { title: 'We let you know', text: 'We tell you the outcome under Aerva’s Policies, and what happens next.' }
    ],

    // Before raising a request: what makes it quick to resolve.
    tips: [
      'One request per problem. Add to an open request rather than raising a new one.',
      'Choose the booking or listing it is about, so we have the details at once.',
      'Say what happened, when, and what you would like to happen.',
      'Add clear photos, screenshots or documents. A payment reference (it starts with “pay_”) helps with any payment question.',
      'Keep messages and payments on Aerva. We can help only with what happened through Aerva.'
    ],

    // The form's "What is this about?" list. Keys must match CATEGORIES in
    // api/_support.js. audience: 'guest', 'host' (hosts only) or 'both'.
    // booking / listing: 'required', 'optional' or 'none'; bookingAs: whose
    // booking — 'guest' (their trips), 'host' (at their listings) or 'any'.
    // Same rules as api/_support.js; the server enforces them.
    categories: [
      { key: 'booking_payment',       label: 'Booking or payment',                    audience: 'guest', booking: 'optional', bookingAs: 'guest', listing: 'none' },
      { key: 'cancellation_refund',   label: 'Cancellation or refund',                audience: 'guest', booking: 'required', bookingAs: 'any', listing: 'none' },
      { key: 'change_booking',        label: 'Changing a booking',                    audience: 'guest', booking: 'required', bookingAs: 'guest', listing: 'none' },
      { key: 'stay_problem',          label: 'Problem during a stay or experience',   audience: 'guest', booking: 'required', bookingAs: 'guest', listing: 'none' },
      { key: 'deposit_damage',        label: 'Security deposit',                      audience: 'guest', booking: 'required', bookingAs: 'guest', listing: 'none' },
      { key: 'coupon',                label: 'Coupon',                                audience: 'guest', booking: 'optional', bookingAs: 'guest', listing: 'none' },
      { key: 'host_conduct',          label: 'A host’s behaviour',                    audience: 'guest', booking: 'optional', bookingAs: 'guest', listing: 'none' },
      { key: 'payout_tds',            label: 'Payouts and TDS',                       audience: 'host', booking: 'optional', bookingAs: 'host', listing: 'none' },
      { key: 'listing_photos',        label: 'Listing, photos or approval',           audience: 'host', booking: 'none', bookingAs: 'any', listing: 'required' },
      { key: 'calendar_availability', label: 'Calendar and availability',             audience: 'host', booking: 'none', bookingAs: 'any', listing: 'required' },
      { key: 'damage_claim',          label: 'Damage claim',                          audience: 'host', booking: 'required', bookingAs: 'host', listing: 'none' },
      { key: 'guest_conduct',         label: 'A guest’s behaviour',                   audience: 'host', booking: 'required', bookingAs: 'host', listing: 'none' },
      { key: 'cohosting',             label: 'Co-hosting',                            audience: 'host', booking: 'none', bookingAs: 'any', listing: 'optional' },
      { key: 'verification',          label: 'PAN, bank or Aadhaar verification',     audience: 'host', booking: 'none', bookingAs: 'any', listing: 'none' },
      { key: 'safety',                label: 'Safety concern',                        audience: 'both', booking: 'optional', bookingAs: 'any', listing: 'optional' },
      { key: 'off_platform',          label: 'Asked to pay or talk outside Aerva',    audience: 'both', booking: 'optional', bookingAs: 'any', listing: 'none' },
      { key: 'account_signin',        label: 'Account and sign-in',                   audience: 'both', booking: 'none', bookingAs: 'any', listing: 'none' },
      { key: 'reviews_badges',        label: 'Reviews and badges',                    audience: 'both', booking: 'optional', bookingAs: 'any', listing: 'optional' },
      { key: 'report_content',        label: 'Report a listing, review or message',   audience: 'both', booking: 'optional', bookingAs: 'any', listing: 'none' },
      { key: 'privacy_data',          label: 'My personal data',                      audience: 'both', booking: 'none', bookingAs: 'any', listing: 'none' },
      { key: 'grievance',             label: 'Formal grievance (Grievance Officer)',  audience: 'both', booking: 'optional', bookingAs: 'any', listing: 'optional' },
      { key: 'other',                 label: 'Something else',                        audience: 'both', booking: 'optional', bookingAs: 'any', listing: 'optional' }
    ],

    // Help topics. group: 'guest', 'host' or 'everyone'. category: what the
    // "Raise a request" button on the topic preselects. docs: policy
    // documents to link (ids in documents above, or 'terms' / 'privacy').
    topics: [
      // ---------------------------------------------------------- guests
      { id: 'booking-payment', group: 'guest', title: 'Booking and payment', category: 'booking_payment',
        summary: 'Payment taken but no booking, a failed payment, or a charge you do not recognise.',
        sections: [
          { title: 'Paid, but no booking shows', points: [
            'Check My Bookings and the email address on your account for the confirmation. A confirmation can take a few minutes to appear.',
            'A payment made after the 3-minute payment window ended, or after it was closed, is not a booking. It is refunded in full to the original payment method.',
            'If money left your account and no booking appears after 30 minutes, raise a request with the payment reference, the date and the amount.'
          ]},
          { title: 'A payment that failed', points: [
            'A failed payment does not book the dates. If you were charged anyway, your bank normally reverses it on its own; if it does not, raise a request with the payment reference.',
            'You have 5 payment attempts per listing per day.'
          ]},
          { title: 'What you pay', points: [
            'The total shown before you pay is the full price: the booking price, Aerva’s guest service fee, GST and any security deposit.',
            'Refunds, where due, go to the original payment method. Timing depends on your bank or card issuer.'
          ]}
        ], docs: ['payments', 'service-fees', 'taxes', 'booking-requirements'] },

      { id: 'cancellations', group: 'guest', title: 'Cancellations and refunds', category: 'cancellation_refund',
        summary: 'Cancelling a booking, what is refunded, and a refund you are waiting for.',
        sections: [
          { title: 'To cancel', points: [
            'Open the booking in My Bookings and send a cancellation request. The host has 24 hours to answer it.',
            'The refund follows the listing’s refund policy, shown before you paid. The percentage is fixed when you send the request.',
            'For an emergency, a hazard or a travel restriction, choose that reason when you cancel.',
            'A booking can be cancelled only before check-in. Once your stay has started, change your check-out date instead (Changing a booking).'
          ]},
          { title: 'If the host cancels', points: [
            'You are refunded at once: the booking price, its GST and any security deposit.',
            'About 15 minutes later you receive an Aerva coupon worth 10% of the booking, valid for 3 months.',
            'Aerva’s service fee is held for you as Aerva credit for 30 days. Book another stay or experience in that time and the credit is taken off what you pay, automatically — checkout shows it as “Aerva credit”. If the new booking costs less than your credit, the rest stays on the credit; if it costs more, you pay the difference.',
            'What is left on your credit shows in My Bookings. Have it refunded in full to your original payment method at any time. Anything left when the 30 days end is refunded automatically.',
            'Your credit is not used for a security deposit: the deposit is paid with your chosen payment method and refunded to it after the stay.',
            'If a booking paid partly with credit is later cancelled or refunded, the refund goes to your original payment method first, and the part paid with credit goes back onto your credit.'
          ]},
          { title: 'Waiting for a refund', points: [
            'Refunds go to the original payment method. Banks and card issuers usually take several working days to show them.',
            'If a refund has not arrived after 7 working days, raise a request and choose the booking.'
          ]}
        ], docs: ['cancellation-stays', 'cancellation-experiences', 'payments'] },

      { id: 'changes', group: 'guest', title: 'Changing a booking', category: 'change_booking',
        summary: 'Moving dates, extending or shortening a stay, guests, pets and add-ons.',
        sections: [
          { title: 'How', points: [
            'Choose the change in My Bookings. The new price and the difference are shown before you send it.',
            'The host accepts or rejects the change in Aerva Messages. Until then, your booking stays as it is.',
            'If the new total is higher, pay the difference within 24 hours of the host accepting.',
            'During your stay, ask by 10 AM (the property’s local time) on the day after check-in. The check-in night is never refunded. If your host agrees, the nights you no longer stay come back as Aerva credit — use it on another booking or have it refunded from My Bookings. After that time the booking cannot be changed.',
            'If the host declines a change you asked for during your stay, or does not answer, you can raise it with Aerva within 24 hours: My Bookings → Report a problem.'
          ]},
          { title: 'When we can help', points: [
            'If the change will not send, the price looks wrong, or you paid the difference and the booking did not change, raise a request and choose the booking.'
          ]}
        ], docs: ['booking-changes'] },

      { id: 'stay-problem', group: 'guest', title: 'A problem during your stay', category: 'stay_problem',
        summary: 'The home is not as described, something does not work, or you cannot check in.',
        sections: [
          { title: 'First', points: [
            'If anyone is in danger, call 112.',
            'Message the host in Aerva Messages. Most problems are fixed fastest by the host, on the spot.',
            'Take clear photos or a short video of the problem as soon as you notice it.'
          ]},
          { title: 'If it is not fixed', points: [
            'Report it from My Bookings once your stay has started and by 10 AM (the property’s local time) on the day after check-in, with at least one photo or document. After that time it can no longer be reported for a refund.',
            'The host is told and can give their side. Aerva reviews the report and lets you both know the outcome.',
            'For an experience that was cancelled or did not run as described, raise a request and choose the booking.'
          ]},
          { title: 'Cannot check in', points: [
            'Call or message the host first. If you cannot reach them, raise a request straight away, choose the booking, and tick the call back box.'
          ]}
        ], docs: ['stay-issues', 'refund-experiences'] },

      { id: 'deposit', group: 'guest', title: 'Security deposits', category: 'deposit_damage',
        summary: 'When a deposit is refunded, and what happens if a host reports damage.',
        sections: [
          { title: 'Refund', points: [
            'A security deposit is refunded to the original payment method after check-out, unless the host reports damage through Aerva within 7 days of check-out.'
          ]},
          { title: 'If damage is reported', points: [
            'You are told, and can send your side and your own photos.',
            'Aerva reviews the claim and decides how much of the deposit, if any, goes to the host. The rest is refunded.',
            'Damage above the deposit is between you and the host.'
          ]}
        ], docs: ['resolution'] },

      { id: 'coupons', group: 'guest', title: 'Coupons', category: 'coupon',
        summary: 'Using an Aerva coupon, and a coupon you expected but did not receive.',
        sections: [
          { title: 'Using a coupon', points: [
            'A coupon covers the booking price only. The service fee, GST and any deposit are paid in full.',
            'One coupon per booking. Coupons belong to the account they were issued to and expire on the date shown.'
          ]},
          { title: 'A coupon that did not arrive', points: [
            'A cancellation coupon arrives about 15 minutes after a host cancels. If it has not arrived after an hour, raise a request and choose the booking.'
          ]}
        ], docs: ['payments'] },

      { id: 'host-conduct', group: 'guest', title: 'Concerns about a host', category: 'host_conduct',
        summary: 'A host asked for extra money, was disrespectful, or broke Aerva’s rules.',
        sections: [
          { title: 'Tell us if a host', points: [
            'asks for money or any fee outside Aerva;',
            'treats you differently because of who you are;',
            'is abusive, threatening or harassing;',
            'has cameras in a bedroom, bathroom or other private space, or devices that were not disclosed;',
            'misuses your ID or personal information.'
          ]},
          { title: 'What to send', points: [
            'The booking, what happened and when, and screenshots of any messages. Keep your messages with the host on Aerva.',
            'If you feel unsafe, leave and call 112 first.'
          ]}
        ], docs: ['community', 'nondiscrimination', 'offline-fees', 'host-privacy'] },

      // ----------------------------------------------------------- hosts
      { id: 'payouts', group: 'host', title: 'Payouts and TDS', category: 'payout_tds',
        summary: 'When you are paid, why a payout may be held, and tax deducted at source.',
        sections: [
          { title: 'When you are paid', points: [
            'Payouts are sent automatically at 5 PM (your property’s local time) on the day after check-in — for an experience, the day after its date — to your verified bank account, after Aerva’s commission and TDS.',
            'If a guest has asked to change the stay or reported a problem by then, only the first night is sent; the rest follows once the request is settled.',
            'If the booking changes after a payout is sent, the difference is settled automatically: less is deducted from your next payout, more is paid to you separately.',
            'See every payout and its status in My Earnings.'
          ]},
          { title: 'A payout on hold or failed', points: [
            'A payout may be held while a guest’s report, a refund or a damage claim is open. It is released once that is settled.',
            'A failed payout is usually a bank detail that does not match. Check your bank details in your account; the payout is tried again.',
            'If a payout is late or the amount looks wrong, raise a request and choose the booking.'
          ]},
          { title: 'TDS', points: [
            'TDS is deducted from every payout under section 194-O (section 393 of the Income-tax Act, 2025): 0.1% with a valid PAN, 5% without one or if your PAN is not linked to Aadhaar. Add your PAN in Payout details before your first payout.',
            'It is worked out on what is due to you after Aerva’s commission. Example: a ₹10,000 booking with a 5% commission of ₹500, so ₹9,500 is due to you; TDS at 0.1% is ₹9.50 and ₹9,490.50 is paid. The TDS is credited against your PAN and shows in your Form 26AS.',
            'In Payout details, enter the name of the person or business to be paid exactly as their bank account holds it, and add that account. A PAN is optional; if you add one, it must be in that same name. Aerva verifies the account before the first payout.',
            'After you change your bank details, payouts wait 48 hours, and you are emailed about the change.'
          ]}
        ], docs: ['payments', 'taxes', 'service-fees'] },

      { id: 'listings', group: 'host', title: 'Listings, photos and approval', category: 'listing_photos',
        summary: 'Getting a listing approved, blocked photos, and editing a live listing.',
        sections: [
          { title: 'Approval', points: [
            'Every listing is reviewed before it goes live. You are emailed when it is approved, or told what to change.'
          ]},
          { title: 'Photos', points: [
            'Photos must be of the actual property and must not show phone numbers, email addresses, websites, social media handles or QR codes. Any such photo is removed.',
            'Add a replacement photo if needed. If you believe a photo was removed by mistake, raise a request and choose the listing.'
          ]}
        ], docs: ['content', 'experience-standards', 'experience-host-terms'] },

      { id: 'calendar', group: 'host', title: 'Calendar and availability', category: 'calendar_availability',
        summary: 'Blocking dates, syncing other calendars, and dates that look wrong.',
        sections: [
          { title: 'Keeping dates right', points: [
            'Block dates you cannot host in your calendar. Linked calendars (Airbnb, Booking.com and others) sync about every hour.',
            'If dates show as free or booked when they should not, raise a request with the listing and the dates.'
          ]}
        ], docs: [] },

      { id: 'host-cancellations', group: 'host', title: 'Cancelling as a host', category: 'cancellation_refund',
        summary: 'When a host may cancel, and what it means for the guest and for you.',
        sections: [
          { title: 'Rules', points: [
            'Cancel only 48 hours or more before check-in, and give a reason. The guest is told the reason.',
            'At most 3 cancellations in any 12 months. Beyond that, write to us.',
            'The guest is refunded the booking price, GST and any deposit, and receives a coupon worth 10% of the booking, paid for by you. Aerva’s service fee is held for the guest as a credit for their next booking, or refunded to them in full.'
          ]},
          { title: 'Instead of cancelling', points: [
            'If something at the property has gone wrong, raise a request before cancelling. We may be able to help the guest another way.'
          ]}
        ], docs: ['cancellation-stays', 'cancellation-experiences'] },

      { id: 'damage', group: 'host', title: 'Damage and deposit claims', category: 'damage_claim',
        summary: 'Claiming against a security deposit after a stay.',
        sections: [
          { title: 'How to claim', points: [
            'Report damage through Aerva within 7 days of check-out, from the booking.',
            'Send dated photos of the damage, and a repair estimate or invoice.',
            'The guest is told and can give their side. Aerva decides how much of the deposit, if any, is paid to you.'
          ]},
          { title: 'Above the deposit', points: [
            'Aerva handles claims only up to the security deposit. Anything above it, or where no deposit was held, is between you and the guest.'
          ]}
        ], docs: ['resolution'] },

      { id: 'guest-conduct', group: 'host', title: 'Concerns about a guest', category: 'guest_conduct',
        summary: 'More guests than booked, a party, rule-breaking or unsafe behaviour.',
        sections: [
          { title: 'First', points: [
            'If anyone is in danger, call 112.',
            'Keep calm, keep a record (dated photos, messages on Aerva), and remind the guest of the house rules in Aerva Messages.'
          ]},
          { title: 'Tell us', points: [
            'Raise a request, choose the booking, and say what happened and when. Tick the call back box if it is happening now.'
          ]}
        ], docs: ['community', 'nondiscrimination'] },

      { id: 'cohosting', group: 'host', title: 'Co-hosting', category: 'cohosting',
        summary: 'Inviting a co-host, what they can do, and how their share is paid.',
        sections: [
          { title: 'Basics', points: [
            'Invite a co-host from Co-hosting. They accept with their own Aerva account.',
            'Aerva pays each co-host their own share, in full. Anything else between a host and a co-host is for them to settle.',
            'Every co-host sees what the listings they co-host earn: each booking\u2019s total and the host\u2019s payout, next to their own share. They never see other listings, or the host\u2019s bank details, PAN or tax.',
            'A host can remove a co-host, and a co-host can leave, at any time. Shares already earned are still paid.'
          ]}
        ], docs: ['payments', 'accounts'] },

      { id: 'verification', group: 'host', title: 'PAN, bank and identity verification', category: 'verification',
        summary: 'Verifying your identity, PAN and bank account to host and be paid.',
        sections: [
          { title: 'What you need', points: [
            'The name of the person or business to be paid, exactly as their bank account holds it; that bank account; optionally their PAN, in the same name; and your identity and address proof.',
            'Identity and address proof: verify your Aadhaar, passport, driving licence or voter ID in Account Settings → Verification. It is checked in under a minute and the ID is never stored.',
            'Aerva verifies the bank account before paying into it. The payee must be one of its holders; a joint account is fine. An account the payee does not hold is not accepted.',
            'Hosting as a company, LLP or partnership firm: use the business’s own PAN and the business’s bank account. A sole proprietor uses their personal PAN, with a personal bank account, or a bank account in the business’s name together with the business’s GSTIN registered under that PAN.',
            'A PAN can be on one Aerva account only.'
          ]},
          { title: 'If verification is stuck', points: [
            'Check that each document is clear, complete and current, and that the bank account is in the name on your PAN. If it is still pending or was declined and you do not know why, raise a request.'
          ]}
        ], docs: ['taxes', 'payments'] },

      // -------------------------------------------------------- everyone
      { id: 'safety', group: 'everyone', title: 'Safety', category: 'safety',
        summary: 'Emergencies, and anything at a stay that feels unsafe.',
        sections: [
          { title: 'In an emergency', points: [
            'Call 112, India’s emergency number, for police, fire or ambulance.',
            'Once you are safe, raise a request with the booking and tick the call back box.'
          ]},
          { title: 'Not urgent, but worrying', points: [
            'A hazard at the property, a concern about someone’s behaviour, or anything that does not feel right: raise a safety request. Safety requests are looked at first.'
          ]}
        ], docs: ['safety-liability', 'community'] },

      { id: 'off-platform', group: 'everyone', title: 'Payments and contact outside Aerva', category: 'off_platform',
        summary: 'Someone asked you to pay, book or talk outside Aerva.',
        sections: [
          { title: 'Never', points: [
            'Never pay for a stay or experience found on Aerva anywhere but on Aerva. A payment outside Aerva is not protected by Aerva’s Policies.',
            'If anyone asks you to, do not pay. Raise a request with a screenshot.'
          ]}
        ], docs: ['off-platform', 'offline-fees'] },

      { id: 'account', group: 'everyone', title: 'Your account', category: 'account_signin',
        summary: 'Signing in, your email and phone number, and deleting your account.',
        sections: [
          { title: 'Signing in', points: [
            'Use the email address or phone number on your account. If a code does not arrive, check your spam folder and wait a minute before asking again.',
            'If you can no longer reach your email or phone number, raise a request from any account you can sign in to, or write to us from that email address.'
          ]},
          { title: 'Deleting your account', points: [
            'Delete it in Account Settings once nothing is open. Deletion cannot be undone.'
          ]}
        ], docs: ['accounts', 'privacy'] },

      { id: 'reviews', group: 'everyone', title: 'Reviews', category: 'reviews_badges',
        summary: 'Leaving a review, and reporting one that breaks the rules.',
        sections: [
          { title: 'Leaving a review', points: [
            'Guests and hosts may review each other within 15 days of check-out. Reviews appear once both have reviewed, or the window closes.'
          ]},
          { title: 'Reporting a review', points: [
            'Report a review that is false, abusive, not about the stay, or offered in exchange for something. Raise a request and say which review and why.',
            'A review is not removed only because it is critical.'
          ]}
        ], docs: ['reviews', 'content'] },

      { id: 'badges', group: 'everyone', title: 'Badges', category: 'reviews_badges',
        summary: 'What each badge on Aerva means, and how badges are earned.',
        badges: true,
        sections: [
          { title: 'About badges', points: [
            'Badges are earned, not bought or requested. They reflect recent standing on Aerva, so they can move up or down.',
            'They are reviewed at the start of every quarter. Between reviews, a badge stays as it is.',
            'Removing a review that breaks the Reviews Policy updates the badges it affected.',
            'If a badge looks wrong, raise a request. We can check that it was worked out correctly; we cannot change the standards behind it.'
          ]}
        ], docs: ['reviews'] },

      { id: 'privacy', group: 'everyone', title: 'Your personal data', category: 'privacy_data',
        summary: 'Seeing, correcting or erasing the information Aerva holds about you.',
        sections: [
          { title: 'Your rights', points: [
            'Ask to see, correct or erase your personal information. Most of it can be changed in Account Settings; deleting your account erases it.',
            'For anything else, raise a request. You may also complain to the Data Protection Board of India.'
          ]}
        ], docs: ['privacy', 'accounts'] },

      { id: 'grievance', group: 'everyone', title: 'Complaints and grievances', category: 'grievance',
        summary: 'Making a formal complaint, and reaching the Grievance Officer.',
        sections: [
          { title: 'Making a complaint', points: [
            'Raise a request and choose “Formal grievance”. It goes to the Grievance Officer.',
            'You receive a reference number at once. Your complaint is acknowledged within 48 hours and resolved within one month of receipt.'
          ]},
          { title: 'If you are not satisfied', points: [
            'Reply on the request and say why. You may also contact the National Consumer Helpline (1915) or the consumer commission.'
          ]}
        ], docs: ['terms'] }
    ],

    // What each badge means, and what it generally rests on. Meanings and
    // general factors only: never the thresholds (those are in api/_tiers.js).
    badges: [
      { group: 'Host badges', intro: 'Shown on a host’s profile and listings. They rest on guests’ ratings of the stays a host has hosted, how consistent those ratings are across every part of the stay, the number of reviewed stays, and the host’s hosting over the past twelve months. From the first rung to the top:', items: [
        { name: 'Rising Host', text: 'A new host, off to a good start.' },
        { name: 'Established Host', text: 'A proven track record of happy guests.' },
        { name: 'Signature Host', text: 'Consistently well reviewed, with no weak spots.' },
        { name: 'Elite', text: 'Exceptional across every part of the stay.' },
        { name: 'Golden Elite', text: 'Near-perfect reviews across a substantial body of stays.' },
        { name: 'Aerva Elite', text: 'The highest standard on Aerva, sustained over time.' }
      ]},
      { group: 'Guest badges', intro: 'Shown on a guest’s Aerva profile. They rest on a guest’s confirmed bookings over the past twelve months and how hosts have rated them, including cleanliness, communication, respect and following the house rules. From the first rung to the top:', items: [
        { name: 'Guest', text: 'Welcome to Aerva.' },
        { name: 'Valued Guest', text: 'A confirmed booking history with Aerva.' },
        { name: 'Trusted Guest', text: 'A strong booking history, well rated by hosts.' },
        { name: 'Aerva Favorite', text: 'A substantial booking history, consistently rated highly by hosts.' }
      ]},
      { group: 'Stay badges', intro: 'Shown on a stay. They rest on guests’ ratings of that stay, compared with other stays in the same city, and the number of reviews. From the first rung to the top:', items: [
        { name: 'Great Stay', text: 'Among the best-rated stays in its city.' },
        { name: 'Outstanding', text: 'Among the very best-rated stays in its city.' },
        { name: 'Exceptional', text: 'One of the top stays in its city.' },
        { name: 'Aerva Exceptional', text: 'The finest stays in its city.' }
      ]},
      { group: 'Stay highlights', intro: 'A stay shows one badge only: a highlight is shown when the stay has none of the badges above.', items: [
        { name: 'Spotless', text: 'Rated near-perfect on hygiene by every guest who scored it.' },
        { name: 'Hidden Treasure', text: 'Rated excellent by its guests, and not yet widely discovered.' }
      ]},
      { group: 'Experience badges', intro: 'Shown on an experience. They rest on guests’ ratings, including organisation, safety and the guide, and the number of reviews. From the first rung to the top:', items: [
        { name: 'Great Experience', text: 'Well reviewed by the guests who have been.' },
        { name: 'Unforgettable', text: 'Consistently rated among the best experiences on Aerva.' },
        { name: 'Wow Experience', text: 'Rated outstanding by a substantial number of guests.' }
      ]}
    ]
  },

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
      'Deposit disputes: decide within the dispute tab; record the reason.',
      'Stay disputes (Guest Safety tab): give the host’s account more weight; refund only when the guest’s evidence stands and the host cannot justify.',
      'Listing photos with phone numbers or other contact details: use “Block: phone number in photo” on the listing.',
      'Hazard reports: rebook or refund the guest when the property is unsafe; review the listing.',
      'Reviews: remove only when false, abusive or retaliatory; the badge recalculates.',
      'Compliance flags: hosts have 15 days; listings are blocked automatically after that.',
      'Every admin action is in the Audit Log tab, with the admin who did it.'
    ]}
  ],

  // Gaps between these policies and the product, for the admin to close.
  openItems: [
    'Have the lawyer review the Aerva Host Agreement 2026-10-27b (offered again after it ends; commission revisions acknowledged and confirmed; payout the day after check-in; first night only while a guest’s request is open; amounts recovered from the next payout) and its earlier terms (29 clauses): accepted per listing; commission revisions on at least 33 days’ notice (31 + 2), acknowledged by each host, the agreement ending if declined or not acknowledged by the date; ending the agreement if a revision is declined or not accepted within 30 days; the non-disparagement clause; indemnity and liability limits.',
    'Add the Grievance Officer’s name to support.grievanceOfficer in this file (required by the E-Commerce Rules); it then shows in the Resolution Center.',
    'Resolution Center: fill in support.contacts.tollFree, whatsapp and hours in this file when the numbers are live. Until then those buttons stay hidden.',
    'Display Aerva’s legal entity name and registered office address on the site (required by the E-Commerce Rules).',
    'Have the lawyer review booking agreement 2026-10-27a — no cancellation once a stay has started; changes and problem reports only until 10 AM on the day after check-in; the check-in night never refunded; a shorter stay agreed by the host returned as Aerva credit (refundable on request, refunded automatically after 30 days); nothing refunded after that time — and its earlier terms: ID checked by the host at check-in (not by Aerva), the 3-minute payment window and next-day refunds, stay disputes weighted to the host, and immediate blocking for contact details in photos.',
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
