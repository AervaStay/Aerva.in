// aerva-policies.js — every Aerva policy, in one place.
//
// The public Policies page (index.html?view=policies) and the admin tool's
// Policies tab both render THIS file, so what guests and hosts read and
// what the admin documents can never drift apart. Change a rule here, and
// both change together.
//
// Wording rule: instructions only. Short, direct, no explanations.
// Every rule here matches how the site actually works (checked against the
// code, Sept 2026). Everything here is public (every visitor's browser
// downloads this file): nothing that could be used to game Aerva goes here.
// Internal rules and the to-do list live in api/_admin-notes.js, shown
// only in the admin tool.
window.AERVA_POLICIES = {
  version: '1.0',
  updated: '11 November 2026',

  // Changes to the agreements and policies (owner, 9 Nov 2026):
  //   • rewording / corrections that do not change the meaning: just edit
  //     the text and `updated` above — no entry here, nobody is emailed;
  //   • a material change: add an entry here, published at least 30 days
  //     before `effective`. Everyone in `audience` ('guests', 'hosts' or
  //     'all') is emailed once (job 'policy_update_notices') and sees a
  //     banner (site and/or host dashboard) until 14 days after it takes
  //     effect. Continuing to use Aerva after `effective` is acceptance.
  //   Dates are India dates (YYYY-MM-DD). Never edit a sent entry's id.
  updates: [
    // (9 Nov 2026: the Host Agreement 2026-11-09a rewording is a minor
    //  revision — owner — so it has no entry here and nobody is emailed.)
    // The check-in promise's payout timing (api/_checkin-promise.js) starts
    // on this entry's `effective` date: the server reads it from here, so
    // the notice and the payouts cannot disagree. Blocking a fake listing,
    // holds while a report is open, and recovering money Aerva refunded or
    // rebooked follow the existing terms and apply at once.
    { id: '2026-11-10-checkin-promise', audience: 'hosts', published: '2026-11-10', effective: '2026-12-10',
      title: 'Aerva’s check-in promise: when payouts are sent',
      summary: [
        'The first payout for each of your listings is sent after its first guest checks out, instead of the day after check-in. Every later booking is paid as usual.',
        'This applies to stays arriving on or after 10 December 2026. Stays arriving before then are paid as they are today.',
        'Already in place: if a guest reports on arrival that a listing does not exist and Aerva confirms it, that listing is blocked and you are not paid for that booking. While a guest’s report is open, that booking’s payout waits.',
        'Already in place: if Aerva moves or refunds a guest after the payout was sent, that amount is deducted from your later payouts (shown in My Earnings → Payout details).'
      ] },
    // Written into the Host Agreement 2026-11-11b (owner, 11 Nov 2026). The
    // rules themselves already apply under the Cancellation Policy and the
    // Security Deposit and Damage Policy.
    { id: '2026-11-11-host-agreement', audience: 'hosts', published: '2026-11-11', effective: '2026-12-11',
      title: 'Host Agreement: natural disasters, same-day bookings and security deposits',
      summary: [
        'Already in place: a guest may ask to cancel for a natural disaster, or a government order or travel restriction, with proof. Aerva decides it and you cannot decline it. If Aerva approves it, you are not paid for that booking; it carries no penalty and does not count as a cancellation by you.',
        'Already in place: a same-day booking that you cancel within 1 hour of it being made needs no coupon and does not count towards your 3 cancellations.',
        'Already in place: for a security deposit, you have 24 hours from check-out to report damage through Aerva, with photos or videos. After that the deposit is refunded to the guest.'
      ] }
  ],

  // Shown before payment (guest) and before listing (host). The version is
  // saved with every booking and every host acceptance; it must match
  // AGREEMENT_VERSION in api/_agreements.js. Change the text → change both.
  agreements: {
    version: '2026-11-11e',       // booking agreement (guests)
    hostVersion: '2026-11-11e',    // host agreement — accepted for every listing
    // How hosts already on an earlier version move to this one (_host-agreement.js):
    //   'minor'  — rewording / corrections, same meaning: nothing to do;
    //   'notice' — a material change: told at least 30 days ahead (email +
    //              dashboard, see `updates` below); continuing to host after
    //              `effective` is acceptance; nothing ends;
    //   'accept' — must be accepted in the dashboard within 30 days of the
    //              notice, or the agreement ends (only for real legal changes).
    // Shown above the booking agreement at checkout (owner, 9 Nov 2026: no
    // surprises) — a plain summary of what a guest can and cannot do, and
    // until when. Not part of the agreement's wording; the policies govern.
    beforeYouPay: [
      'Payment: pay within the 3-minute window, or the dates are released.',
      'Your details: Aerva may ask you to verify your first and last name, your phone number (with a code we text you) and a government photo ID (Aadhaar, passport, driving licence or voter ID) before a booking is confirmed. If it does, you are told right after paying, with the deadline, and the dates are held for you until then; if the details are not verified by the deadline, the booking is not made and everything you paid is refunded to your original payment. If you are not asked, or your details are already verified, the booking is confirmed as soon as you pay.',
      'Cancelling: only before check-in, for one of three reasons: a change of plans, a natural disaster, or a government order or travel restriction. A change of plans is a request to the host under this listing’s refund policy (shown above); if the host rejects it, there is no refund. Aerva’s service fee is not refunded; any security deposit always is, to your original payment method.',
      'Free cancellation (optional, offered only where the host has chosen to offer it, for a stay, when check-in is more than 48 hours away): add it at checkout for the amount set by the host (between 5% and 30% of the stay price), plus GST. Cancel until 48 hours before the check-in time (the property’s time) and the booking price, its GST and any security deposit are refunded in full, at once — no wait for the host. The add-on and Aerva’s service fee are not refunded. After that, the refund policy applies. A change of dates keeps it (the 48 hours move with the new check-in); if added nights take the stay price up so that the add-on would be under 5% of it, the difference is added.',
      'Natural disaster or government order (a lockdown, or a road closed by the authorities): any time before check-in, choose that reason and attach proof. Aerva checks it and decides — the host cannot decline it. If approved, what you paid (the booking price, its GST, Aerva’s service fee and any free cancellation add-on) becomes Aerva credit: use it for new dates, or have it refunded to your original payment method at any time from My Bookings. Any security deposit is always refunded to your original payment method, never as Aerva credit. If not, the booking stands.',
      'Changes (dates, guests, pets, add-ons): ask the host before the stay starts (it starts at 12 AM, the property’s time, on the check-in date), or until 10 AM (the property’s time) on the day after check-in — from the start, the check-in date itself cannot move. Before check-in, a cheaper change refunds the difference to your original payment method; Aerva’s service fee stays as charged. Leaving early: once the stay has started you can bring check-out forward, but you won’t get anything back for the nights you don’t stay — no refund and no Aerva credit — and the host is paid for the original dates.',
      'Moving nights to another property of the same host (a transfer): ask before check-in, or until 10 AM (the property’s time) on the day after check-in. At least one night stays where you booked. Aerva’s transfer fee is 5% of what the moved nights cost at the property you booked; a lower total comes back as Aerva credit. Once completed, the booking cannot be changed, cancelled or split again.',
      'Once the stay has started it cannot be cancelled. After 10 AM (the property’s time) on the day after check-in it cannot be changed.',
      'Aerva’s check-in promise: if, when you arrive, the place does not exist, is not as listed or is not available, report it from My Bookings → Report a problem, with a photo, on your check-in day — at the latest by 10 AM (the property’s time) the next day. Reporting late can cost you your booking payment. If Aerva confirms it, you are offered other places and pay only any difference, or everything you paid is refunded in full, including Aerva’s service fee.',
      'Other problems during the stay: report them the same way, with photos, by 10 AM (the property’s time) on the day after check-in. Aerva’s decisions are final.',
      'A gift or a split payment: Aerva may ask you to verify your own details before you pay. If it does, you are told at checkout, before any payment is taken.',
      'A gift (“This stay is for someone else”): you pay for and manage the booking, and any refund comes back to you. The person you name is the guest staying: they never see the price, and they accept the gift from their own Aerva account with their first name, last name and phone.',
      'Splitting with friends: the total is split equally per guest. You tick that you’ll pay for any places your friends don’t pay within 2 hours. The place is not held until the last payment: if someone else books it first, everyone is refunded in full. At 2 hours, any unpaid amount is yours to pay within 30 minutes, or nothing is booked and everyone is refunded. Once confirmed, a group booking is non-refundable — every payer ticks this before paying. Coupons, Aerva credit and free cancellation cannot be used on a split payment.'
    ],
    hostRevision: { kind: 'notice', effective: '2026-12-11' },   // 2026-11-11b: natural-disaster rule written in, with notice (owner, 11 Nov 2026); earlier ones were rewording
    guest: {
      title: 'Booking agreement',
      points: [
        'Your booking is an agreement between you and the host. Aerva is the platform that connects you and takes payment.',
        'You: give true details of every guest and pet, keep a confirmed email and a phone number on your account, carry a government photo ID for every adult guest to show the host at check-in, follow the house rules and the law, and pay for any damage you or your guests cause.',
        'Your booking is confirmed only when payment completes within the 3-minute payment window. A payment that does not match the booking amount, or completes after the window, is not a booking and is refunded.',
        'Aerva may ask you to verify your name, phone and a government photo ID before a booking is confirmed. If it does, you are told right after paying, with the deadline: 24 hours after paying, or 10 AM (the property’s time) on the check-in day if that is earlier, and never less than 1 hour. If your details are not verified by then, the booking is not made and your payment is refunded in full.',
        'You can cancel only before check-in, for one of three reasons: a change of plans, a natural disaster, or a government order or travel restriction. A change of plans is a request to the host through Aerva, under the refund policy shown before you pay; if the host rejects it, there is no refund, and Aerva’s service fee is not refunded. A natural disaster or government order needs proof and is decided by Aerva; if Aerva approves it, what you paid — the booking price, its GST, Aerva’s service fee and any free cancellation add-on — is held for you as Aerva credit.',
        'Changes are requests to the host through Aerva. Before check-in, a cheaper change refunds the difference; Aerva’s service fee stays as charged. A booking you have moved to another property of the same host (a transfer) cannot be changed or cancelled by you afterwards. A group (split-payment) booking is non-refundable once it is confirmed.',
        'If the host cancels your booking, everything you paid — the booking price, its GST and Aerva’s service fee — is held for you as Aerva credit for up to 6 months (its end date is shown in My Bookings): use it on another stay or experience, or have it refunded to your original payment method at any time from My Bookings. Whatever is left when it ends is refunded to your original payment method automatically. If the host cancels within 48 hours of check-in, you may also receive an Aerva coupon worth 10% of the booking, valid for 1 month.',
        'Only one coupon can be used on a booking. The part of a booking paid by coupon comes back to you, as a new coupon valid for 1 month, only if the host cancels, a problem you report is upheld, or Aerva approves a cancellation for a natural disaster or government order — not when you cancel for a change of plans or change the booking. If a payment does not go through, nothing is booked and your coupon stays valid.',
        'Once your stay has started, it cannot be cancelled. You can bring your check-out date forward in My Bookings until 10 AM (the property’s time) on the day after check-in, so the remaining dates are freed — but nothing comes back to you for the nights you no longer stay: no refund and no Aerva credit, and the host is paid for the original dates.',
        'If, when you arrive, the place does not exist, is not as listed or is not available, report it from My Bookings → Report a problem, with a photo, on your check-in day — at the latest by 10 AM (the property’s time) on the day after check-in. Reporting late can cost you your booking payment. Any other problem with the stay is reported the same way, with evidence, by the same time. Aerva reviews it and decides.',
        'After 10 AM (the property’s time) on the day after check-in, the booking can no longer be changed and nothing more is refunded.',
        'Any Aerva credit or coupon you are given stays exactly as issued: its value does not change, and no interest is paid on it. You can have your Aerva credit refunded to your original payment method whenever it suits you, from My Bookings. A coupon is not refundable and can be used, alone or with your credit, until the date shown on it — at most 1 month after it is issued.',
        'You can expect the home or experience to be as described, safe and clean.',
        'Aerva: takes your payment, handles refunds and complaints under Aerva’s Policies, and keeps your booking records.',
        'No violence, threats, verbal abuse, harassment or discrimination of any kind, including on gender.',
        'Any security deposit is always refunded to your original payment method — never as Aerva credit — under Aerva’s Security Deposit and Damage Policy, once 24 hours have passed after check-out with no damage reported (your bank may take a few working days to show it). It covers damage and extra cleaning, up to the deposit amount. If damage is reported, you are told and can give your side; Aerva decides how much of the deposit is refunded to you, and its decision is final. Damage above the deposit is between you and the host, and is to be settled directly with the host; Aerva provides no refund or compensation for it.',
        'Before a booking is confirmed, nothing you send through Aerva may contain a phone number, email address, social media handle, UPI ID or link to another website. Once it is confirmed, you and the host may share phone numbers, email addresses and photos in Aerva Messages until 15 days after check-out. Links to Aerva pages can be shared at any time.',
        'Aerva provides no support beyond the security deposit and your booking details.',
        'You are responsible for your own safety and for any physical, mental or emotional harm you or your guests cause or suffer that is beyond Aerva’s control.',
        'Aerva does not own, run or inspect properties or experiences, and does not control what hosts or guests do. To the extent the law allows, Aerva is not responsible for the acts or omissions of any host, guest or third party, including criminal acts, death, injury, self-harm or any life-threatening situation, and pays no claim for them.',
        'Aerva treats every guest fairly and without discrimination of any kind. Aerva’s decision on any matter under its policies is full and final.',
        'Cancellations, refunds, credits, coupons, deposits, pets and safety follow Aerva’s Policies.'
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
          'Aerva charges you a commission on each booking, at the commission rate shown in your dashboard. It is deducted from your payout. Any service fee Aerva charges guests is Aerva’s own and is not part of your earnings.',
          'Aerva may revise its commission. You are told in advance, by email and in your dashboard, with the date from which the revised commission applies; it applies to bookings made on or after that date. The rates in force when a booking is made apply to that booking.',
          'You do not need to confirm a commission revision. If you prefer not to host at the revised commission, you may deactivate your listings before the date it applies; continuing to host after that date means you accept it.'
        ] },
        { title: '6. Payouts and taxes', points: [
          'Your payout for a booking is sent the day after check-in (for an experience, the day after its date) to your verified bank account, after Aerva’s commission, any co-host share, applicable deductions and tax deducted at source.',
          'For stays arriving from 10 December 2026, the first payout for each of your listings is sent after its first guest checks out. Every later booking of that listing is paid as usual.',
          'Once your payout for a booking has been sent, the amount is settled. If Aerva later has to refund the guest for that booking, the part you are no longer owed is deducted from your next payout; if the booking’s amount goes up, the difference is paid to you separately.',
          'Aerva may hold, adjust or withhold a payout while a guest’s report, a refund, a damage claim or a dispute is open, where fraud is suspected, or where the law requires.',
          'If a guest reports on arrival that the property does not exist, is not as listed or is not available, that booking’s payout is held while the report is open. A listing reported as not existing is hidden at once while Aerva checks, and is blocked if Aerva confirms it. If Aerva confirms a report, you are not paid for that booking, and anything already paid out for it is deducted from your later payouts.',
          'GST on a booking is collected from the guest and paid to the government by Aerva; it is not part of your payout. Aerva charges no GST on its commission.',
          'You are solely responsible for your income tax, GST registration where applicable, and every other compliance on your earnings and your property — state, local, hotel or homestay rules, as applicable to you.'
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
          'You check a valid government photo ID for every adult guest at check-in, keep a copy of it as government instructions require, and report foreign guests on Form III within 24 hours of arrival and of departure, as the law requires.',
          'All communication about a booking stays on Aerva Messages. Once a booking is confirmed, phone numbers, email addresses and photos may be shared there until 15 days after check-out. Taking bookings or payments outside Aerva, or using a guest’s details to do so, is not allowed.',
          'You use guests’ personal information only for their booking and your legal duties, and keep it secure. No camera or recording device may be placed in a bedroom, bathroom or any private space; every device elsewhere must be disclosed in the listing.'
        ] },
        { title: '10. Check-in and check-out', points: [
          'Your listing states its check-in and check-out times, and you have the property ready at check-in.',
          'At check-in, you check a valid government photo ID for every adult guest; guests from outside India show their passport. Only the guests named in the booking, up to the number booked, may stay.',
          'You choose until what time a guest may book your home for the same night — from 6 PM to 12 AM, where the property is (12 AM unless you change it). A booking made before that time is for that night, and the guest may check in straight away.',
          'Check-in instructions and access details are given to the guest through Aerva only.'
        ] },
        { title: '11. Pets and service animals', points: [
          'Your listing states whether pets are allowed, how many and which types, and any pet fee. Pet fees are charged only through Aerva, as part of the booking.',
          'Guests declare every pet and service or support animal when they book. You may not ask for proof that a service or support animal is needed, or refuse one because of a disability.',
          'Damage caused by a pet is handled like any other damage, under the Security Deposit and Damage clause.'
        ] },
        { title: '12. Contact details and communication', points: [
          'Before a booking is confirmed, nothing sent through Aerva — a listing, photo, description, review, message or email — may contain a phone number, email address, website (other than a link to an aerva.in page), social media handle, UPI ID, QR code or any other contact detail of you or any other person.',
          'Once a booking is confirmed, you and the guest may share phone numbers, email addresses and photos in Aerva Messages until 15 days after check-out. Other contact details (links to other websites, social media or messaging accounts, UPI IDs) are never allowed. After those 15 days, or if the booking is cancelled, phone numbers, email addresses and any photo showing contact details are removed from the conversation. Links to Aerva pages, such as a listing on aerva.in, can be shared at any time — before, during and after a booking.',
          'Aerva may remove any such content at once, without notice. You are liable for any loss or claim arising from contact details you share in breach of this clause, and repeated breaches may lead to penalties, removal of the listing and suspension of your account.'
        ] },
        { title: '13. Cancellations', points: [
          'Each listing carries the refund policy you choose (Flexible or Firm). A booking keeps the policy it was paid under.',
          'You answer guests’ cancellation and change requests in Aerva Messages within 24 hours. An unanswered request is settled under Aerva’s Cancellation Policy.',
          'You may cancel a booking until its check-in time, with a reason, no more than 3 times in any 12 months. Further cancellations are handled only by Aerva, on your request, once you confirm them in the request Aerva raises for you in the Resolution Center. What the guest receives, and any coupon you owe, are set out in the Penalties clause.',
          'Free cancellation add-on: you choose, for each listing, whether to offer it, and you set its price — one fixed ₹ amount per booking, kept between 5% and 30% of the stay price. A guest who bought it may cancel until 48 hours before check-in and is refunded the booking price, its GST and any security deposit in full. The add-on is paid to you, less Aerva’s commission, whether or not the guest cancels.'
        ] },
        { title: '14. Refunds', points: [
          'Refunds to guests are made by Aerva under Aerva’s Cancellation Policy, Changing a Booking policy and Stay Issues and Refund Policy, and the amount you receive is adjusted accordingly.',
          'When a guest asks to change a stay that has started, or reports a problem, you are told and may give your side through Aerva. Until it is settled, only the first night of your payout for that booking is sent; the rest follows once it is settled, after any refund decided.',
          'If a guest leaves early once the stay has started, nothing is refunded to the guest and you are paid for the original dates.'
        ] },
        { title: '15. Penalties', points: [
          'Whenever you cancel a confirmed booking, everything the guest paid is held for them as Aerva credit, which they can have refunded at any time; any security deposit is refunded to them; and you are not paid for that booking.',
          'If you cancel a confirmed booking more than 48 hours before check-in, no coupon is owed and the penalty is limited to the cancellation counting towards your yearly limit. Aerva may decide further penalties for repeated cancellations.',
          'If you cancel within 48 hours of check-in, you first pay for an Aerva coupon for the guest worth 10% of the booking (for an experience that includes a stay: of the stay, paid by the stay’s host; none when the experience’s host cancels it). What you pay for the coupon is not refunded to you.',
          'A same-day booking (check-in on the day it is made) that you cancel within 1 hour of it being made needs no coupon and does not count towards your 3 cancellations.',
          'A guest may ask to cancel for a natural disaster, or a government order or travel restriction, at any time before check-in, with proof. Aerva decides it on the guest’s proof: you are told and can add information in Messages, but you cannot decline it. If Aerva approves it, you are not paid for that booking; it carries no penalty and does not count as a cancellation by you.',
          'To avoid cancelling, keep your calendar up to date: block any dates when your home is not available — for maintenance, repairs, your own use or any other reason — before guests can book them.',
          'When Aerva cancels for you (after your 3 cancellations, or when you cannot cancel yourself), you first confirm it in the request Aerva raises for you in the Resolution Center; nothing is cancelled until you do. If check-in is within 48 hours, you must first pay for an Aerva coupon worth 10% of the booking for the guest when you confirm; Aerva does not pay it or deduct it later.',
          'Cancellations count towards your yearly limit and lower your host badge. Each property’s listing card shows guests its host cancellation rate: the bookings you cancelled, out of all its bookings, in the last 12 months (0% when you have cancelled none).',
          'For any breach of this agreement or Aerva’s Policies, Aerva may withhold or adjust payouts, pause or remove listings, cancel bookings, and suspend or close your account.'
        ] },
        { title: '16. Security deposits and damage', points: [
          'If your listing holds a refundable security deposit, Aerva holds it and refunds it to the guest after check-out unless you report damage through Aerva within 24 hours of check-out.',
          'To keep any of the deposit, report the damage through Aerva, say how much of the deposit you ask to keep, and share photos or videos of the damage with Aerva; a report without proof is not accepted, and the deposit is then refunded in full.',
          'Nothing is kept from the deposit until Aerva approves it. Aerva reviews your proof and the guest’s side, and decides fairly how much of the deposit, and what percentage of it, is paid to you. You abide by Aerva’s decision, which is full and final.',
          'The deposit also covers extra cleaning: cleaning you do yourself, or a cleaner or other help you call in, to return the home to how it was. What you are paid for damage and cleaning together can never be more than the deposit.',
          'If you find no damage, confirm it when you review the guest.',
          'Aerva handles damage and cleaning claims only up to the security deposit. If the damage or cleaning costs more than the deposit, or no deposit is held, Aerva provides no refund, compensation or support of any kind for the rest; it is between you and the guest, to be settled directly. Aerva is not a party to that settlement and pays no part of it.'
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
          'If you invite co-hosts, you remain responsible for your listing and for everything your co-hosts do on it. Aerva pays each co-host their own share, based on the percentage share you set and they agreed to; any other arrangement between you and a co-host is for you to settle.',
          'A co-host who cancels a booking within 48 hours of check-in pays for the guest’s coupon themselves. Any money between you and a co-host for it is settled between the two of you, outside Aerva.'
        ] },
        { title: '22. Contacting Aerva', points: [
          'For any matter about a booking, a guest, a payout or your listing, raise a request in the Resolution Center. Every request receives a reference number.',
          'Formal complaints may be addressed to Aerva’s Grievance Officer, Tanish, at aervastudios@gmail.com.'
        ] },
        { title: '23. Aerva’s discretion on disputes', points: [
          'Aerva reviews every dispute between you and a guest, and decides it fairly on the facts and evidence both sides provide.',
          'Aerva’s decision on any matter under this agreement and Aerva’s Policies is full and final.'
        ] },
        { title: '24. Reputation and fair comment', points: [
          'Aerva supports hosts and guests alike. It decides every matter fairly, on the facts and evidence both sides provide, and does not discriminate against a host or a guest in any form; nothing other than those facts affects its decision.',
          'You will not make, publish or share any false, misleading, defamatory or disparaging statement about Aerva, its team or its services, on any platform or in any medium.',
          'Concerns about Aerva are to be raised with Aerva through the Resolution Center or the Grievance Officer. A breach of this clause may lead to suspension or closure of your account, without prejudice to Aerva’s legal rights.',
          'A host who, instead of raising a concern with Aerva, defames Aerva or any member of its team will be dealt with in accordance with the law.'
        ] },
        { title: '25. Liability and indemnity', points: [
          'To the extent the law allows, Aerva is not liable for the acts or omissions of any guest, host or third party, including criminal acts, death, injury, self-harm, loss of or damage to property, or any life-threatening situation, and pays no claim for them.',
          'To the extent the law allows, Aerva’s total liability for any claim is limited to the fees Aerva received for the booking concerned.',
          'You will compensate Aerva for any claim, loss, penalty or cost arising from your listing, your property, your hosting or your breach of this agreement, Aerva’s Policies or the law.',
          'You are responsible for your own property, contents and liability insurance.'
        ] },
        { title: '26. Acceptance, records and copies', points: [
          'This agreement is accepted for each listing you submit, and whenever Aerva asks you to accept a revision. Each acceptance is recorded with the version, the listing, the date and time.',
          'A copy of the agreement you accepted is emailed to you each time, and every agreement you have accepted can be viewed in your dashboard under Account → Host Agreement.',
          'The version published by Aerva is the binding version. Aerva’s interpretation of this agreement and its Policies is final.'
        ] },
        { title: '27. Revisions', points: [
          'Aerva may revise this agreement and its Policies. Corrections and rewording that do not change their meaning take effect when published, and the date of the last update is changed.',
          'Aerva tells you of any other revision at least 30 days before it takes effect, by email and in your dashboard, with a short summary of what is changing. Continuing to host after that date means you accept the revised agreement. If you do not accept it, you may end this agreement by deactivating your listings before then.',
          'Where the law or the nature of a revision requires it, Aerva asks you to accept the revised agreement in your dashboard; you accept it or decline it there.',
          'Commission revisions are announced in advance, as set out in the Commission and fees clause.',
          'Bookings already confirmed keep the commission and fees in force when they were made.'
        ] },
        { title: '28. Termination', points: [
          'If you decline a revised agreement that Aerva asks you to accept, or do not accept it within 30 days of Aerva’s notice, this agreement ends. Your listings are deactivated and removed from Aerva, and they take no new bookings.',
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
        'You are responsible for everything done through your account. Keep your login secure.',
        'A password must have at least 8 characters, with at least one letter and one number. Very common passwords are not accepted.'
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
        'Questions, complaints and grievances: raise a request in the Resolution Center (Help → Raise a request).',
        'Grievance Officer: Tanish, aervastudios@gmail.com'
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
        'To confirm your phone number: the number, and when it was confirmed by a code sent by text message.',
        'ID verification for bookings: you send a photo of one government photo ID. It is read automatically to check the type of ID, the name, the expiry date and that you are 18 or over, and the image is not kept after the check. Aerva stores only: the type of ID, the last 4 characters of its number, whether the name matched your profile, when it was verified, and whether it was checked automatically or by Aerva. Never the image, the full number, your date of birth or your address.',
        'If you send your ID to Aerva to check instead, the image is kept privately only until Aerva’s team has checked it, and is then deleted.',
        'If you verify through DigiLocker, you approve the sharing in DigiLocker itself. Aerva reads your name, your date of birth and the masked Aadhaar number from what you approve, checks them, and keeps only the type of ID, its last 4 digits, whether the name matched, when, and that DigiLocker was used. Your photo, your address and your full Aadhaar number are never stored.',
        'ID verification in Account Settings (hosts’ identity and address proof, or if you choose it): the result only (the type of ID, your name as on it, its last 4 characters and when it was verified). The ID itself is checked automatically and is never stored.',
        'Payment references. Card and UPI details are handled by the payment provider, not Aerva.',
        'Technical data such as IP address and device, for security.'
      ]},
      { id: 'use', title: 'Why', points: [
        'To run your account, bookings, payments, payouts and messages, to keep Aerva safe, and to meet legal duties.',
        'To send guests who have not booked lately an offers email about once a quarter. Switch it off in Account Settings → Privacy, or with the unsubscribe link in the email.',
        'Aerva does not sell your information.'
      ]},
      { id: 'share', title: 'Who receives it', points: [
        'The other party to your booking, as needed for the stay. A host is given your name and phone number only once the booking is confirmed, and never your ID or its details.',
        'Service providers that operate Aerva, such as payment, email, text-message, hosting, sign-in and automated checking providers (an ID you verify is read by one, and not kept by it or by Aerva).',
        'Authorities, where the law requires.'
      ]},
      { id: 'keep', title: 'How long', points: [
        'Until you delete your account. Deleting it erases your personal information; booking and payment records are kept without it, as the law requires.'
      ]},
      { id: 'contact', title: 'Contact', points: [
        'For anything about your information, raise a request in the Resolution Center and choose “My personal data”. Complaints may also be made to the Data Protection Board of India.'
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
        'A booking is confirmed only when payment succeeds. Aerva may also ask a guest to verify their name, phone and a government photo ID before the booking is confirmed (see Booking Requirements). If it does, the guest is told right after paying, with the deadline, and the payment is held: verified by the deadline, it becomes the booking; otherwise the booking is not made and the payment is refunded in full to the original payment method.'
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
        'Refunds, where due, go to the original payment method. Timing depends on your bank or card issuer.',
        'If the host cancels, or Aerva approves a cancellation for a natural disaster or government order, what you paid for the booking is held for you as Aerva credit first. Aerva credit lasts up to 6 months (its end date is shown in My Bookings): use it on any booking, or have it refunded to your original payment method at any time from My Bookings. Whatever is left when it ends is refunded automatically.',
        'A security deposit is always refunded to the original payment method, never as Aerva credit.',
        'If you move nights to another property of the same host and the new total is lower, the difference after Aerva’s transfer fee is held as Aerva credit in the same way. If it is higher, you pay the difference after the host accepts.'
      ]},
      { title: 'Coupons', points: [
        'A coupon covers the booking price only. The guest service fee, GST and any security deposit are charged in full, on the full booking price.',
        'If the booking price is more than the coupon, you pay the difference plus the service fee, GST and any deposit.',
        'If the coupon is worth more than the booking price, the unused balance is forfeited. It is not refunded, carried over or exchanged for cash.',
        'One coupon per booking. Coupons belong to the account they were issued to and expire on the date shown — at most 1 month after they are issued.',
        'Only one coupon can be used on a booking, even if you hold more than one.',
        'If your payment does not go through, nothing is booked and your coupon stays valid to use again.',
        'If the host cancels a booking you paid for partly by coupon, that part comes back as a new coupon valid for 1 month. If the host cancelled within 48 hours of check-in, you also receive the usual 10% coupon, also valid for 1 month. If you cancel for a change of plans, the part paid by coupon is not returned.'
      ]},
      { title: 'Payouts to hosts and co-hosts', points: [
        'Payouts are made automatically to a verified bank account at 5 PM (the property’s time) on the day after check-in (for an experience, the day after its date), after Aerva’s commission and TDS.',
        'If a booking changes after its payout has been sent, an amount the host or co-host is no longer owed is deducted from their next payout, and an amount added is paid separately.',
        'Payouts go only to a verified bank account held by the person or business named in the payout details (the host or someone else), alone or jointly. When a PAN is given, it must be in that same name, and TDS is deducted against it. A company, LLP or partnership firm is paid only to its own account, against its own PAN.',
        'When bank details change, payouts wait 48 hours, and the account owner is emailed about the change.',
        'Aerva may hold, adjust or withhold a payout for disputes, refunds, damage claims, suspected fraud or legal reasons.',
        'Check-in promise: for stays arriving from 10 December 2026, the first payout for each listing is sent after its first guest’s check-out time (if no report is open), instead of the day after check-in. Every later booking of that listing is paid as usual. While a guest’s report on arrival is open, that booking’s payout is held; while a report that a listing does not exist is open, or the listing is blocked, all of that listing’s unsent payouts are held. If Aerva upholds a report, the host is not paid for that booking, and anything already paid out for it is deducted from the host’s later payouts (shown in My Earnings → Payout details).',
        'Aerva pays hosts and co-hosts their own shares only. Each co-host’s share is the percentage the host set and the co-host agreed to, worked out on the final booking amount: while a guest’s request is open, a co-host’s share is held just like the host’s payout, so both match the booking once it is settled. Any other money between a host and a co-host is for them to settle between themselves.'
      ]}
    ]},
    { id: 'service-fees', title: 'Service Fees Policy', summary: 'How Aerva’s service fees are charged to hosts and guests.', sections: [
      { title: 'Guests', points: [
        'A guest service fee, a percentage of the booking price, is added to your total and shown before you pay.'
      ]},
      { title: 'Hosts', points: [
        'Aerva’s commission is a percentage of the stay price, paid amenities and pet fees, at the commission rate shown in your dashboard. It is deducted from your payout.',
        'A revised commission is announced to hosts in advance, by email and in their dashboard, and applies to bookings made from the date given. There is nothing to confirm: a host who prefers not to continue may deactivate their listings before that date.'
      ]},
      { title: 'General', points: [
        'Taxes are added separately (see the Taxes Policy). Security deposits carry no service fee.',
        'Aerva’s guest service fee is not refunded: not when a guest cancels, when a booking is changed to a lower price, or when a stay issue is upheld. When a host cancels (or Aerva cancels for the host), it is held for the guest as Aerva credit with everything else they paid, and can be refunded from there. When Aerva approves a cancellation for a natural disaster or government order, it is held as Aerva credit with everything else, and can be refunded from there too. It is refunded in full when a payment never becomes a booking (a payment outside the payment window, details not verified by the deadline, or a group booking that is not completed) and when Aerva refunds a booking under its check-in promise. Otherwise it is refunded only when a booking fails because of a mistake on Aerva’s side, or in an exceptional case where Aerva, at its sole discretion, decides to refund it.',
        'Moving nights to another property of the same host carries Aerva’s transfer fee: 5% of what the moved nights cost at the property booked, charged on every completed transfer and not refunded. It is shown in the summary before the request is sent.',
        'Aerva may change the guest service fee at any time, and its commission on the notice above. The fees shown when you book apply to that booking.'
      ]}
    ]},
    { id: 'offline-fees', title: 'Offline Fee Policy', summary: 'When a host may charge anything outside Aerva.', sections: [
      { title: 'Rule', points: [
        'Hosts may not charge guests any fee outside Aerva. Every charge must be part of the price shown on Aerva before booking.',
        'Security deposit claims — damage and extra cleaning — go through Aerva, up to the deposit; the host asks for an amount with photos or videos, and Aerva approves what is paid. Anything beyond the deposit is settled directly between the host and the guest.'
      ]}
    ]},
    { id: 'off-platform', title: 'Off-Platform Policy', summary: 'What must not happen outside Aerva.', sections: [
      { title: 'Rules', points: [
        'Do not ask for, offer or accept payment outside Aerva for a stay or experience found on Aerva.',
        'Do not use contact details from Aerva to book or pay outside it.',
        'Keep messages about a booking on Aerva. A guest can message the host in Aerva Messages until the review window closes, 15 days after check-out.',
        'Once a booking is confirmed, the guest and host may share phone numbers, email addresses and photos in its Aerva Messages until 15 days after check-out. Other contact details (links to other websites, social media or messaging accounts, UPI IDs) are not allowed in messages. Links to Aerva pages, such as a listing on aerva.in, can be shared at any time — before, during and after a booking.',
        'From 15 days after check-out, or once the booking is cancelled, phone numbers, email addresses and any photo showing contact details are removed from the conversation.',
        'Aerva may cancel bookings and suspend accounts that break this policy.'
      ]}
    ]},
    { id: 'taxes', title: 'Taxes Policy', summary: 'What taxes may apply to a booking.', sections: [
      { title: 'Guests', points: [
        'GST applies to the booking price — a stay, an experience, paid amenities, pet fees and the free cancellation add-on — and is added to your total. Aerva collects it and pays it to the government.',
        'Aerva’s service fee is a percentage of the booking price (the stay or experience, with paid amenities and pet fees). No GST is charged on Aerva’s service fee or on a security deposit.',
        'Other local taxes may apply to your stay under the law where the property is.'
      ]},
      { title: 'Hosts and co-hosts', points: [
        'Tax deducted at source (TDS) is deducted from every payment Aerva makes to a host or co-host, including security deposit compensation: 0.1% when a valid PAN is provided, 5% when it is not or the PAN is inoperative (not linked to Aadhaar).',
        'TDS is worked out on the amount due to you: for a host, the booking amount after Aerva’s commission and any co-host share; for a co-host, their share. GST and Aerva’s guest service fee are never part of it. A cancellation coupon is paid by the host (or the co-host who cancels) before the booking is cancelled and is never deducted from a payout by Aerva on its own; any amount you owe Aerva is deducted after TDS and does not reduce it.',
        'As Aerva’s policy, TDS is deducted on every payment from the first rupee, including for individuals and HUFs earning under ₹5,00,000 a year through Aerva. Any TDS deducted counts towards your income tax and can be claimed in your return.',
        'GST on a booking is collected and paid by Aerva and is not part of a payout. Aerva charges no GST on its commission.',
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
        'When a stay starts: a stay counts as started from 12 AM (the property’s time) on its check-in date. From then it cannot be cancelled, and its check-in date cannot be changed. The refund brackets below are counted to the listing’s check-in time, not to 12 AM.',
        'Flexible: 30 or more days before check-in, full refund; 10 to 29 days, 80%; 5 to 9 days, 50%; 2 to 4 days, 30%; less than 2 days, the host decides (0 to 100%).',
        'Firm: 30 or more days before check-in, full refund; 5 to 29 days, 50%; less than 5 days, the host decides (0 to 100%).',
        'Where the host decides, the host chooses the refund. If the host rejects the request, there is no refund.',
        'Days are counted to the listing’s check-in time, where the property is. For example, for check-in tomorrow at 1:00 PM, a request made today before 1:00 PM is 24 hours or more before check-in; a request at 2:00 PM is less.'
      ]},
      { title: 'How a guest cancels', points: [
        'A guest can cancel only before check-in, for one of three reasons: a change of plans, a natural disaster, or a government order or travel restriction.',
        'Change of plans: send a cancellation request from My Bookings or the booking’s Messages thread. The host accepts or rejects it.',
        'The refund percentage is fixed when you send the request.',
        'If the host does not answer within 24 hours, a request with a fixed refund is accepted at that refund, and a request where the host decides is settled with no refund. If the host rejects a request, there is no refund. A natural disaster or government order follows its own rules below.',
        'A request still open when the stay starts closes, and the booking stands.',
        'Refunds cover the booking price and its GST at the percentage above. Aerva’s guest service fee is not refunded. The security deposit is always refunded in full.',
        'Free cancellation add-on: if you added it at checkout, cancelling until 48 hours before check-in refunds the booking price, its GST and any security deposit in full, at once, with no request to the host. The add-on is not refunded. See the Free Cancellation Add-on policy.',
        'Natural disaster or government order: if a natural disaster (a flood, cyclone, earthquake, landslide, fire or similar), or a government order or travel restriction (such as a lockdown, or a road closed by the authorities), stops you reaching the stay, choose that reason at any time before check-in and attach proof (for example a photo or news report, or the official order or notice). Aerva checks the proof and decides; the host is told and can add information, but cannot decline it. Aerva’s decision is final and binds the guest and the host.',
        'If Aerva approves, the booking is cancelled and what you paid for it — the booking price, its GST, Aerva’s service fee and any free cancellation add-on — is held for you as Aerva credit, and any security deposit is refunded to your original payment method (a deposit is never kept as credit). Use it for new dates — it is taken off any later Aerva booking automatically — or have it refunded to your original payment method at any time from My Bookings; like any Aerva credit, whatever is left at the end of its period is refunded automatically. A part paid by coupon comes back as a new coupon, and a part paid with earlier Aerva credit goes back onto that credit. The host is not paid for the booking. If Aerva does not approve it, nothing changes and the booking stands.',
        'Any other reason is a change of plans: the refund policy above applies, and Aerva’s service fee is not refunded.',
        'Once the stay has started, a booking cannot be cancelled. To leave early, change the check-out date (see Changing a Booking) — nothing is refunded for the nights you don’t stay.',
        'Check-in promise: if, when you arrive, the place does not exist, is not as listed or is not available, report it straight away from My Bookings → Report a problem — on your check-in day, and no later than 10 AM (the property’s time) the next day (see Stay Issues and Refund Policy). Reporting late can cost you your booking payment, so do not wait. If Aerva confirms the problem, you are offered other places, or everything you paid is refunded in full, including Aerva’s service fee.',
        'A part paid by coupon is not returned when you cancel for a change of plans. It comes back as a new coupon, valid for 1 month, only if the host cancels the booking (or Aerva cancels it for the host), or Aerva approves a cancellation for a natural disaster or government order.',
        'A booking that has been transferred to another property of the same host (see Changing a Booking) cannot be cancelled by the guest, in whole or in part. If something is not working, raise a request in the Resolution Center; Aerva decides. Each part keeps the cancellation policy of its own property for a cancellation by the host or by Aerva.'
      ]},
      { title: 'Hosts', points: [
        'Hosts may cancel before check-in time, and must give a reason. The guest is told the reason.',
        'A host may cancel at most 3 bookings in any 12 months. Further cancellations are handled only by Aerva, on the host’s request and once the host confirms it in the request Aerva raises for them in the Resolution Center: everything the guest paid is held for them as Aerva credit (refundable at any time; any security deposit is refunded to the original payment method), and, if check-in is within 48 hours, the host must first pay for an Aerva coupon worth 10% of the booking for the guest; Aerva does not pay it or deduct it later. The booking is cancelled only once that payment goes through, and the coupon is sent to the guest automatically.',
        'Whenever the host cancels, everything the guest paid — the booking price, its GST and Aerva’s service fee — is held for them as Aerva credit for up to 6 months (its end date is shown in My Bookings); whatever is left when it ends is refunded automatically. They can use it on another stay or experience, or have it refunded in full to the original payment method at any time from My Bookings, and are reminded of it while it is unused: a pop-up when they sign in (3 times in the first 3 months, then once every 3 months), an email on 15 Feb, 15 May, 15 Aug and 15 Nov, and a final email 7 days before it ends. Any security deposit is refunded to the original payment method at once.',
        'Within 48 hours of check-in, the guest also receives an Aerva coupon worth 10% of the booking, valid for 1 month, sent automatically 15 minutes after the cancellation. The host pays for it before the booking is cancelled, and what the host pays is not refunded to them. More than 48 hours before check-in, Aerva may decide further penalties for a host’s repeated cancellations. No coupon is given when the host cancels more than 48 hours before check-in. The coupon is not refundable; the guest can use it together with Aerva credit.',
        'A same-day booking (check-in on the day it is made) that the host cancels within 1 hour of it being made carries no coupon and does not count towards the host’s 3 cancellations; the guest still receives everything they paid as Aerva credit.',
        'Each property shows its host cancellation rate on its listing card: the share of its bookings in the last 12 months that the host cancelled, whatever the timing. It starts at 0%, counts against the host’s badge, and lets guests and hosts see how reliable a booking is.',
        'What a guest is not refunded after cancelling is paid to the host, less Aerva’s commission on what the host receives, on the usual payout day. A free cancellation add-on the guest bought is always paid to the host, less Aerva’s commission, even when the guest cancels.',
        'A guest’s request for a natural disaster or government order is decided by Aerva on the guest’s proof; the host is told, can add information in Messages, and cannot decline it. If Aerva approves, the host is not paid for that booking; it carries no penalty and does not count as a host cancellation.'
      ]},
      { title: 'Gift and group bookings', points: [
        'A gift is cancelled, changed or transferred only by the person who booked and paid. Any refund goes back to their payment. The recipient is told the stay was cancelled, never the amounts.',
        'A group booking is managed by its organiser and is NON-REFUNDABLE once confirmed: if it is cancelled for any reason other than a natural disaster or government order, nothing is refunded, whatever the listing’s policy, and the host is paid as for a normal stay. The security deposit is not split: the organiser pays it with their own place, and it goes back to the organiser’s own payment method.',
        'If Aerva approves a cancellation for a natural disaster or government order, or the host cancels, each person who paid gets their own share as Aerva credit in their own account — usable for new dates, or refunded to their own payment at any time. If Aerva’s check-in promise is not kept, each person is refunded in full to their own payment.',
        'A group that never becomes a booking — the place got booked by someone else first, or the organiser did not pay the rest within 30 minutes of the 2-hour mark — is refunded to everyone in full, service fee included, automatically.'
      ]},
      { title: 'Co-hosts', points: [
        'The same rules apply when a co-host acts for the host. Within 48 hours of check-in, a co-host pays for the coupon from their own account before cancelling.',
        'Any money between a host and a co-host — this coupon included — is for them to settle between themselves, outside Aerva.'
      ]}
    ]},
    { id: 'free-cancellation', title: 'Free Cancellation Add-on', summary: 'The optional add-on that gives a full refund until 48 hours before check-in.', sections: [
      { title: 'Free cancellation add-on', points: [
        'It is offered only where the host has chosen to offer it for that listing; the listing then shows “Free cancellation available at checkout”. On such a stay, booked more than 48 hours before check-in, a guest may add free cancellation at checkout. It is not offered for experiences, for a stay that comes with an experience, for resort rooms, or for split (group) payments.',
        'Where the host includes it free, there is nothing to tick or pay: the listing and your booking say “Free cancellation included”, with the time it lasts until.',
        'Hosts choose, for each listing, whether to offer it (off unless they turn it on), and may change it at any time. A change applies to new bookings only: a booking keeps the add-on it was bought with.',
        'A host may also offer it free: free cancellation is then included in every booking of that listing at no charge, with the same 48-hour limit and the same refund.',
        'It costs the amount set by the host (between 5% and 30% of the stay price). The host sets one fixed amount per booking for the listing; for a very short or very long stay it is kept between 5% and 30% of the stay price — the stay after any offer, with paid amenities and pet fees, before GST, Aerva’s service fee and any deposit. The amount for each booking is shown at checkout before paying. GST is added on it at the stay’s rate.',
        'A listing whose host has not set a price for it does not offer it. A change of the host’s price applies to new bookings only.',
        'Until 48 hours before the listing’s check-in time, where the property is, the guest may cancel and is refunded the booking price, its GST and any security deposit in full, at once — no request to the host. The end of this window is shown at checkout, in the confirmation and in My Bookings.',
        'The add-on and its GST are not refunded, and Aerva’s guest service fee follows the Service Fees Policy (not refunded when a guest cancels). A part paid by coupon is not returned, as for any guest cancellation.',
        'After the window, the listing’s refund policy applies as usual, and the add-on is still not refunded.',
        'A change of dates keeps the add-on, and the 48 hours move with the new check-in. A change that adds nights works the add-on out again from the host’s amount the booking was sold with, kept between 5% and 30% of the new stay price; only if that is more than what was paid is the difference (and its GST) added. A shorter stay does not refund it (and leaving early after check-in refunds nothing at all).',
        'A transfer to another property of the same host keeps the add-on on the part that stays on the booking; a transferred booking cannot be cancelled by the guest.',
        'The add-on is paid to the host, less Aerva’s commission at the host’s rate, even when the guest cancels. If the host cancels, or Aerva cancels for the host or under its check-in promise, the add-on is returned to the guest with everything else.'
      ]}
    ]},
    { id: 'booking-changes', title: 'Changing a Booking', summary: 'How guests change dates, guests, pets or add-ons, or move nights to another property of the same host.', sections: [
      { title: 'What can change', points: [
        'Stays: dates (move, extend or shorten), the number of guests, pets and paid add-ons.',
        'One request at a time: while a change you asked for is waiting (for the host’s answer, or for your payment), the booking cannot be cancelled; and while a cancellation request is waiting, it cannot be changed. A stay counts as started from 12 AM (the property’s time) on its check-in date; from then the check-in date cannot move.',
        'Experiences: the date and the number of guests.',
        'An experience that includes a stay changes together with its stay: a new date moves both, and the number of guests applies to both.',
        'Any time before check-in. Once the stay has started, only until 10 AM (the property’s time) on the day after check-in. After that the booking cannot be changed and nothing more is refunded.',
        'During a stay, check-in cannot move; check-out, guests and add-ons can. The new check-out can be the day after check-in at the earliest. Nothing is refunded for nights not stayed.',
        'Leaving early: once the stay has started you may still bring check-out forward, so the dates are freed — but you won’t get anything back for the nights you don’t stay: no refund and no Aerva credit. The host is paid for the original dates, with Aerva’s commission as normal. Before check-in, a cheaper change refunds the difference to your original payment method.',
        'A request sent in time stands however long the host takes to answer. If the host declines it, or does not answer, you may raise it with Aerva within 24 hours from My Bookings (Report a problem); Aerva decides.'
      ]},
      { title: 'How', points: [
        'Choose the change in My Bookings. The new price and the difference are shown before you send it.',
        'The request goes to the host in Aerva Messages. The host accepts or rejects it. Until then, the booking stays as it is.',
        'Before check-in, if the new total is lower, the difference is refunded to your original payment method once the host accepts. Once the stay has started, a cheaper change gives nothing back: no refund and no Aerva credit.',
        'Aerva’s service fee stays as charged on the original booking. If you paid part of the price with a coupon, the coupon’s share of the difference is not returned.',
        'If the new total is higher, pay the difference within 24 hours of the host accepting, through the 3-minute payment window. The change applies only when that payment succeeds.',
        'If prices change before the host answers or before you pay, the request closes; send a new one.',
        'A booking that has been transferred to another property (below) can no longer be changed.'
      ]},
      { title: 'Moving nights to another property (transfers)', points: [
        'A stay can be split between its property and another property of the same host. The other property must have the same host and the same co-hosts; only those properties, free for the nights you choose, are shown.',
        'Choose the nights to move: the start, the end or the middle of your stay. At least one night stays at the property you booked, and your check-in and check-out dates do not change. The booking becomes separate bookings, one for each part, each with its own confirmation code.',
        'When: any time before check-in, or once the stay has started, until 10 AM (the property’s time) on the day after check-in — after that the option is no longer shown. Nights that have passed cannot move. Not possible once the host has been paid for the booking.',
        'Before you send it you see the full summary: each part and its price, Aerva’s transfer fee, the old and new totals, and what you pay or get back. The nights that stay are priced at your booking’s own rates; the moved nights at the other property’s rates. The other property’s own security deposit and pet fee apply to the moved nights; paid add-ons stay with their nights and are not carried over.',
        'Aerva’s transfer fee is 5% of what the moved nights cost at the property you booked. It is charged on every completed transfer, including a booking whose dates were changed before, and is not refunded.',
        'The host or a co-host accepts or declines. Then you complete it within 24 hours: if the new total is higher, by paying the difference through the 3-minute payment window; if it is lower, by accepting the difference, after the transfer fee, as Aerva credit — use it on another booking, or have it refunded to your original payment method at any time from My Bookings (whatever is left when it ends is refunded automatically). A part paid by coupon is not returned.',
        'If the host declines, or you do not complete it in time, nothing changes and nothing is charged — no fee.',
        'A completed transfer is final. It cannot be undone, and no part of the booking can be changed, moved, split again, shortened or cancelled by you — even if your plans change. You confirm that you understand this before sending the request.',
        'If something is not working after a transfer, raise a request in the Resolution Center and choose the booking. Aerva will look at it and its decision is final.',
        'A transfer is not a cancellation: no host penalty applies. Each part is paid out to the host separately, after Aerva’s commission and TDS on that part’s own amount.'
      ]}
    ]},
    { id: 'booking-requirements', title: 'Booking Requirements', summary: 'What every guest needs to book, verifying your details, and same-day bookings.', sections: [
      { title: 'To book', points: [
        'An Aerva account with a confirmed email address and a mobile number.',
        'Extra guests: the nightly rate covers the number of guests stated on the listing (for a Resort, on each room). Each guest above that number pays the host’s extra guest fee, per night; a host may set it to ₹0. The number and the fee are shown on the listing and as their own line in your total before you pay. It is part of the booking price, so GST and Aerva’s service fee apply to it.',
        'Your name, mobile number and the number of guests are shared with the host.',
        'Carry a government photo ID for every adult guest. The host checks it at check-in. Guests from outside India carry their passport.'
      ]},
      { title: 'Verifying your details', points: [
        'Aerva may ask you to verify your name, phone and a government photo ID before a booking is confirmed. If it does, you are told right after paying, with the deadline; if the details are not verified by then, the booking is not made and your payment is refunded in full. If you are not asked, your booking is confirmed as soon as you pay.',
        'Verifying is three things, done once on your profile: your first and last name; your phone number, confirmed with a code sent by text message; and a government photo ID — ONE of Aadhaar, passport, driving licence or voter ID. A PAN card is not accepted as a photo ID.',
        'The ID must be yours, in the name on your profile, not expired, and you must be 18 or over. It is checked in a few seconds. You have 5 tries a day; you can also send it to Aerva to check instead, and you are emailed the result.',
        'If DigiLocker is offered, it is the quickest way: you sign in to your own DigiLocker and approve sharing your Aadhaar, with nothing to photograph or upload. Aerva then keeps only the same few things it keeps for a photo ID — the type, the last 4 digits, whether the name matched, when, and that DigiLocker was used — and never your full Aadhaar number, your address or your photo.',
        'Once verified, you stay verified: you are not asked again, and your bookings are confirmed as soon as you pay. Changing your phone number means confirming the new number; changing your name means verifying your ID again.',
        'If you are asked to verify after paying: your payment is taken and the dates are held for you, but the booking is not confirmed yet — there is no confirmation code, and the host is not given your details. My Bookings shows “Waiting for your details” with the time left.',
        'The deadline is shown to you when you are asked: 24 hours after you pay, or 10 AM (the property’s time) on the check-in day if that is earlier — but never less than 1 hour after you pay (for example, for a same-day booking). Aerva reminds you by email and on the site.',
        'Verified in time: the booking is confirmed like any other and you get the confirmation. If your ID is with Aerva when the deadline arrives, the booking waits for Aerva’s answer, at the latest until 10 AM on the check-in day.',
        'Not verified by the deadline: no booking is made, the dates are released, everything you paid is refunded to your original payment method, and any coupon or Aerva credit you used is given back. You are emailed.',
        'Gifts and split payments: Aerva may ask the person buying a gift, and the organiser of a split payment, to verify their details before paying; they are told at checkout, before any payment is taken. The person receiving a gift accepts with their name and phone, and friends paying their share need only their name and phone.',
        'The host still checks a government photo ID for every adult guest at check-in.'
      ]},
      { title: 'Same-day bookings', points: [
        'Each host chooses until what time their home can be booked for the same night, between 6 PM and 12 AM where the property is. Before that time you can book tonight and check in straight away; after it, the earliest check-in is the next day. For example, with 12 AM, a booking made at 11:59 PM on 25 November is for the night of 25–26 November.'
      ]}
    ]},
    { id: 'gift-group-bookings', title: 'Gift and Group Bookings', summary: 'Booking a stay for someone else, and splitting the payment with friends.', sections: [
      { title: 'Gift bookings', points: [
        'At checkout choose “This stay is for someone else” and give the recipient’s first and last name (as on their government ID), email, and optionally a phone number and a message of up to 300 characters. Contact details in the message are removed.',
        'A problem on arrival at a gifted stay: the guest staying (the person who accepted the gift) can report it from their own My Bookings, under Aerva’s check-in promise. The report belongs to the booking: the person who paid is told, chooses any new place Aerva offers, and receives any refund. The guest staying is kept informed as it goes — on their own booking and by email, without prices — but makes no decisions and receives no money.',
        'An upcoming booking can also be sent as a gift from My Bookings before check-in. Until check-in, the person who booked can change the recipient (the old link stops working) or stop the gift.',
        'The person who booked and paid is the customer: the booking, its invoice, changes, cancellations, transfers and refunds stay with their account and payment.',
        'The recipient gets an email with the stay, dates, address, check-in details and confirmation code — never the price. To accept, they log in or create an Aerva account and give their first name, last name and a mobile number the host can reach them on.',
        'A gift link works once, for that booking only, until check-out. From an account with the email the gift was sent to, the gift can also be accepted from My Bookings.',
        'Until the gift is accepted, the host sees “Gift, not yet accepted” and no phone number. Once accepted, the host has the recipient’s name and phone, and checks the recipient’s government photo ID at check-in.',
        'If it is not accepted, Aerva reminds the recipient 3 days before check-in and the day before, and tells the person who booked.',
        'The recipient sees the booking in My Bookings as “Gifted to you” with the check-in details and the booking’s Messages, without prices or change and cancel options.'
      ]},
      { title: 'Group bookings (split payment)', points: [
        'At checkout the organiser can choose “Split the payment with friends”. The whole total — the stay, GST, Aerva’s service fee and any deposit — is split equally per guest, in whole rupees; any remaining rupees go on the last places.',
        'Starting the group, the organiser ticks “I’ll pay for any places my friends don’t pay within 2 hours” and pays for at least one place. The group is then open for 2 hours. Friends open the share link, log in, give their name and phone, and pay for one or more places, never more than are left.',
        'The place is NOT held while the money is collected: anyone else can still book those dates. If someone else books it before the group is complete, every payer is refunded their full amount to their own payment, automatically, with the reason “This place got booked by someone else. Try another listing.”, and the group ends.',
        'The payment of the last unpaid amount holds the place for its normal 3-minute payment window, so it cannot be taken mid-payment. If two people try to pay the last places at once, only one can.',
        'Before paying, every payer ticks “I understand: once the booking is confirmed it is non-refundable”.',
        'Each payment is for specific places and has its own 3-minute window. A payment that fails or is not completed gives its places back. A payment that does not match its places, or arrives after its window, after the group closed or after its places were taken, is not counted and is refunded in full at once.',
        'When the full amount is paid, the place is blocked and the booking is confirmed — one booking, one confirmation code — and everyone who paid is emailed. From that moment it is non-refundable.',
        'If places are still unpaid at 2 hours, the organiser is asked to pay the remaining amount within 30 minutes (the place is still not held). Paid: the booking is confirmed and everyone is told. Not paid: nothing is booked, every payer is refunded in full with the reason “The group’s booking wasn’t completed”, and the organiser’s unpaid commitment is recorded on their account. A group is never confirmed for fewer guests.',
        'Guests can be added (never removed): before confirmation the stay is priced again and split again (no dates are held either); after confirmation the same booking is priced again and the guests are confirmed once the extra amount is paid.',
        'After confirmation the organiser manages the booking. Friends see it in My Bookings as “Non-refundable group booking” with their own share, the check-in details and the group’s Messages with the host. A cancellation for any reason other than a natural disaster or government order refunds nothing (the security deposit, which the organiser alone paid, goes back to the organiser’s own payment method) and the host is paid as for a normal stay. A natural disaster or government order approved by Aerva, or a cancellation by the host, gives each payer their own share as Aerva credit in their own account (refundable to their own payment at any time); if Aerva’s check-in promise is not kept, each payer is refunded in full. Host payouts and TDS start only after confirmation, as for any booking.',
        'A confirmed group booking cannot be moved to another property, and a change that lowers its price (fewer nights, cheaper dates) cannot be made online, because it is non-refundable; for either, raise a request in the Resolution Center.',
        'Coupons, Aerva credit and free cancellation cannot be used on a split payment. A gift can use them (a gift cannot be split). Any payment that never became part of the booking (late, at an old price, mismatched, over the places left, abandoned) is refunded in full automatically.'
      ]}
    ]},
    { id: 'cancellation-experiences', title: 'Cancellation Policy for Experiences', summary: 'How cancellations work for experiences.', sections: [
      { title: 'Rule', points: [
        'An experience follows the same refund policy and the same brackets as a stay: Flexible or Firm, as shown on the experience before you book. The same three reasons apply, and Aerva’s service fee is not refunded.',
        'For an experience, the brackets are counted to its start time on its first day, where it takes place.',
        'An experience that includes a stay: if the experience’s host cancels it (with its stay), everything the guest paid, GST and Aerva’s service fee included, is held for them as Aerva credit to use on another stay or experience, or to have refunded; no coupon. If the stay’s host cancels, the stay’s rules apply and the coupon is worth 10% of the stay, paid for by the stay’s host.',
        'If a host or co-host cancels, everything the guest paid — the price, its GST and Aerva’s service fee — is held for them as Aerva credit for up to 6 months (its end date is shown in My Bookings) (whatever is left when it ends is refunded automatically): it is taken off what they pay for their next Aerva booking (anything left stays on the credit), or refunded in full to the original payment method at any time from My Bookings. If the cancellation is within 48 hours of check-in, 15 minutes later the guest also receives an Aerva coupon worth 10% of the booking, paid for by whoever cancelled.'
      ]}
    ]},
    { id: 'major-events', title: 'Major Disruptive Events Policy', summary: 'When events beyond anyone’s control stop a booking.', sections: [
      { title: 'Covered events', points: [
        'Events that arise after booking and make it impractical or illegal to complete, such as natural disasters, epidemics, government orders or travel restrictions, or major damage to the property.'
      ]},
      { title: 'What happens', points: [
        'A guest whose stay is stopped by a natural disaster or a government order or travel restriction sends a cancellation request with proof from My Bookings, before check-in. Aerva checks the proof and decides; if approved, what the guest paid for the booking is held as Aerva credit for the guest (for new dates, or refunded to their original payment method whenever they ask), any security deposit is refunded to their original payment method, and the host is not paid for the booking. See the Cancellation Policy for Stays.',
        'For anything else, raise a request in the Resolution Center with your booking and evidence. Aerva may cancel the booking and decide any refund or coupon.',
        'Known or foreseeable events at the time of booking, and personal circumstances, are not covered.'
      ]}
    ]},
    { id: 'stay-issues', title: 'Stay Issues and Refund Policy', summary: 'What happens when a guest is not happy during a stay.', sections: [
      { title: 'Check-in promise', points: [
        'If, when you arrive, the property does not exist, is not as listed or is not available, report it immediately from My Bookings → Report a problem, with at least one photo, on your check-in day. The last moment to report is 10 AM (the property’s time) on the day after check-in; any delay can cost you your booking payment. It is treated as urgent.',
        'Messages with your host stay open until 15 days after check-out. After that, raise a request in the Resolution Center (Help → Raise a request) for anything about the stay.',
        'A report that the property does not exist hides that listing from search at once while Aerva checks. If Aerva confirms it, that listing is blocked and its other guests are moved or refunded; if not, it goes back live.',
        'If Aerva confirms your report, you are offered up to 3 other places in the same city that are free for the rest of your stay and fit your party, nearest first. You pay only the difference: the new place’s price for those nights, with GST and Aerva’s service fee worked out the normal way, less what you paid for your booking. If it costs more, you pay the difference before it is confirmed; if it costs less, the difference is held for you as Aerva credit, which you can use or have refunded at any time.',
        'Your new stay shows as one booking in My Bookings, with one amount: what you paid, plus (or less) the difference.',
        'If none of the places suits you, or none is available, everything you paid is refunded in full to your original payment method — the booking price, its GST, any security deposit and Aerva’s service fee. The host is not paid for the booking.',
        'From check-in, guests of a listing that no guest has confirmed yet are asked, in My Bookings and by email, whether the place is real and as listed. Your answer helps other guests.',
        'Aerva’s decision is final.'
      ]},
      { title: 'Reporting a problem', points: [
        'Report the problem from My Bookings with at least one photo or document as evidence, once the stay has started and by 10 AM (the property’s time) on the day after check-in. A change you asked for in that time that the host declined, or did not answer, can be reported within 24 hours of that.',
        'After 10 AM (the property’s time) on the day after check-in, problems can no longer be reported for a refund.',
        'The host is told and gives their side through Aerva.'
      ]},
      { title: 'Aerva’s decision', points: [
        'Aerva reviews the guest’s report, the evidence and the host’s response, and decides whether a refund is due.',
        'If upheld, every night after the check-in night is refunded, with its GST. The check-in night is not refunded. Aerva’s service fee is not refunded. A part paid by coupon comes back as a new coupon valid for 1 month. The host is paid for the nights not refunded, less Aerva’s commission.',
        'The security deposit is handled separately under the Security Deposit and Damage Policy.',
        'Aerva’s decision is full and final.'
      ]}
    ]},
    { id: 'refund-experiences', title: 'Refund Policy for Experiences', summary: 'How refunds work when an experience is disrupted.', sections: [
      { title: 'Rule', points: [
        'If the host cancels, the Cancellation Policy for Experiences applies: everything the guest paid is held for them as Aerva credit, refundable at any time.',
        'If the experience does not take place as described, raise a request in the Resolution Center. Aerva may offer a refund or an Aerva coupon, at its discretion.'
      ]}
    ]},
    { id: 'resolution', title: 'Security Deposit and Damage Policy', summary: 'How security deposits are refunded and damage is handled.', sections: [
      { title: 'Security deposit', points: [
        'Some listings hold a refundable security deposit, shown before you pay.',
        'A Resort booked with several rooms in one payment has one security deposit for the booking, not one per room. When to expect it: with no damage reported, the refund is sent once 24 hours have passed after check-out, and usually shows in your account about 3 days after check-out, depending on your bank.',
        'It is always refunded to the original payment method, never as Aerva credit — after check-out, unless the host reports damage through Aerva within 24 hours of check-out. Once those 24 hours have passed, the refund is sent; the bank may take a few working days to show it.',
        'The deposit covers damage and extra cleaning — by the host, or a cleaner or other help the host calls in — up to the deposit amount, never more.',
        'To keep any of the deposit, the host must report it through Aerva, say how much they ask to keep, and share photos or videos of the damage with Aerva. Aerva reviews both sides and approves how much of the deposit, and what percentage, is paid to the host; the rest is refunded. Aerva’s decision is fair, full and final, and both the host and the guest abide by it.',
        'If the host confirms there is no damage when reviewing the guest, the deposit is refunded without waiting for the 24 hours.'
      ]},
      { title: 'Damage above the deposit', points: [
        'Aerva handles damage and cleaning claims only up to the security deposit.',
        'Damage above the deposit, or where no deposit is held, is between the host and the guest, and is to be settled directly between them.',
        'Aerva provides no refund, compensation or support beyond the security deposit and the booking details — to the guest or to the host. It is not a party to any settlement and pays no part of it.'
      ]}
    ]},
    { id: 'third-party', title: 'Nearby Places and Third-Party Services', summary: 'Things to do, transport and taxi links shown near a property.', sections: [
      { title: 'What is shown', points: [
        'Each property shows places nearby — things to do, metro and railway stations, bus stations, taxi stands, airports — and links to taxi apps, for information only.',
        'The places come from OpenStreetMap, a free map made by volunteers (© OpenStreetMap contributors, ODbL). They may be incomplete, out of date or wrong; distances are straight-line.'
      ]},
      { title: 'Third parties', points: [
        'Every place, activity, transport and taxi service shown is run by a third party. Aerva does not own, check, book, run or recommend any of them, and is not part of any arrangement you make with them.',
        'Aerva is not responsible for anything that happens at or through a third party — including fraud, scams, violence, injury, loss, damage, delays, prices, or the accuracy of what they show. Any booking, payment, ride or visit is between you and that provider, under their terms.',
        'Places and links under “Recommended by your host” are the host’s own suggestions. Aerva has not checked them and does not endorse them.',
        'Before a third-party link opens, you are shown this notice and must agree to it. Aerva keeps a record of that agreement (the place, the link and the time).',
        'Take care: check reviews, pay only through official channels, share your plans with someone you trust, and call 112 in an emergency.'
      ]}
    ]},
    { id: 'reviews', title: 'Reviews Policy', summary: 'The rules for reviews left on Aerva.', sections: [
      { title: 'Rules', points: [
        'Guests and hosts may review each other within 15 days of check-out.',
        'Reviews must be honest, first-hand and about the stay or experience. Do not offer or accept anything in return for a review, and do not use reviews to threaten or retaliate.',
        'Guests may add up to 5 photos of the stay to a review. Do not show anyone’s face without their consent, and no contact details. Aerva may remove any photo.',
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
        'Guests and hosts can delete their account once nothing is open: no upcoming or current stays or bookings (including a stay gifted to you, or a group booking you paid a place in or that is still collecting payments), no payment waiting for your details to be verified, no Aerva credit still to be used or refunded, no payouts waiting to be sent, and no cancellation coupons owed.',
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
  // The decision rules for the support team live in api/_admin-notes.js,
  // which only the admin tool shows.
  support: {
    // Contact options. A blank value hides that option on the page, so
    // nothing dead is ever shown. Fill these in when the numbers are live:
    //   tollFree: '1800 123 4567'          (shown as a tap-to-call button)
    //   whatsapp: '+91 98765 43210'        (opens WhatsApp to this number)
    //   hours:    'Every day, 9 AM – 9 PM IST'
    // No email option: every issue goes through the Resolution Center
    // (owner, 10 Nov 2026). The Grievance Officer's address is below.
    contacts: {
      tollFree: '',
      whatsapp: '',
      hours: ''
    },
    // Required by the Consumer Protection (E-Commerce) Rules, 2020: the
    // Grievance Officer's name, designation and contact. Fill in the name.
    grievanceOfficer: {
      name: 'Tanish',
      designation: 'Grievance Officer',
      email: 'aervastudios@gmail.com'
    },
    intro: 'Help with a booking, a stay, hosting or your account. Find answers below, or raise a request and our support team will take it from there.',
    emergency: 'If anyone is in danger or needs urgent medical help, call 112 first. Then tell Aerva.',

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
      { key: 'other',                 label: 'Something else',                        audience: 'both', booking: 'optional', bookingAs: 'any', listing: 'optional' },
      // Raised from “Can’t sign in?” only (signed out); never offered on the signed-in form.
      { key: 'account_access',        label: 'Account access',                        audience: 'signed_out', booking: 'none', bookingAs: 'any', listing: 'none' }
    ],

    // “Can’t sign in?” (index.html?view=help&signin=1): a request without an
    // account. Keys must match SIGNIN_PROBLEMS in api/_support.js.
    signinProblems: [
      { key: 'suspended',     label: 'My account is suspended' },
      { key: 'email_changed', label: 'Someone changed my email / I’m locked out' },
      { key: 'no_codes',      label: 'I don’t receive sign-in codes' },
      { key: 'other',         label: 'Other sign-in problem' }
    ],

    // Help topics. group: 'guest', 'host' or 'everyone'. category: what the
    // "Raise a request" button on the topic preselects. docs: policy
    // documents to link (ids in documents above, or 'terms' / 'privacy').
    topics: [
      // ---------------------------------------------------------- guests
      { id: 'booking-payment', group: 'guest', title: 'Booking and payment', category: 'booking_payment',
        summary: 'Payment taken but no booking, a failed payment, a charge you do not recognise, or a total higher than the nightly rate.',
        sections: [
          { title: 'Asked to verify your details', points: [
            'Aerva may ask you to verify your details before a booking is confirmed. If it does, My Bookings shows “Waiting for your details” with the deadline. See the help topic “Verifying your details”.'
          ]},
          { title: 'Paid, but no booking shows', points: [
            'Check My Bookings and the email address on your account for the confirmation. A confirmation can take a few minutes to appear.',
            'A payment made after the 3-minute payment window ended, or after it was closed, is not a booking. It is refunded in full to the original payment method.',
            'If money left your account and no booking appears after 30 minutes, raise a request with the payment reference, the date and the amount.'
          ]},
          { title: 'A payment that failed', points: [
            'A failed payment does not book the dates. If you were charged anyway, your bank normally reverses it on its own; if it does not, raise a request with the payment reference.',
            'You have 5 payment attempts per listing per day.'
          ]},
          { title: 'Extra guests, and why the total is higher than the nightly rate', points: [
            'The nightly rate covers the number of guests the host has included. The listing page shows this under “Extra guests”.',
            'Each guest above that number is charged the host’s extra-guest fee, per guest, per night. It appears as its own line in the price summary before you pay.',
            'GST and Aerva’s guest service fee apply to the extra-guest fee in the same way as to the nightly rate.',
            'The total also includes Aerva’s guest service fee, GST and any refundable security deposit, each shown as its own line.'
          ]},
          { title: 'What you pay', points: [
            'The total shown before you pay is the full price: the booking price, Aerva’s guest service fee, GST and any security deposit.',
            'Refunds, where due, go to the original payment method. Timing depends on your bank or card issuer.'
          ]}
        ], docs: ['payments', 'service-fees', 'taxes', 'booking-requirements'] },

      { id: 'verify-details', group: 'guest', title: 'Verifying your details', category: 'booking_payment',
        summary: 'Being asked to verify your name, phone and photo ID before a booking is confirmed.',
        sections: [
          { title: 'If you are asked (“Waiting for your details”)', points: [
            'Aerva may ask you to verify your details before a booking is confirmed. If it does, you are told right after paying, with the deadline, and My Bookings shows “Waiting for your details”. If you were not asked, there is nothing to do: your booking is confirmed as soon as you pay.',
            'If you were asked: your payment was received and the dates are held for you. The booking is confirmed once your details are verified: your first and last name, your phone number (with a code we text you) and a government photo ID.',
            'Open My Bookings and complete the steps shown there before the deadline. As soon as the last one is verified, the booking is confirmed and you are emailed the confirmation.',
            'No code by text message? Check the number on your profile, wait a minute and ask for it again. ID not accepted? Use a clear, straight photo of the whole ID — Aadhaar, passport, driving licence or voter ID, in the name on your profile — or choose “Send it to Aerva to check instead”.',
            'The deadline is 24 hours after you pay, or 10 AM (the property’s time) on the check-in day if that is earlier, and never less than 1 hour. If it passes, no booking is made and your payment is refunded in full to the original payment method; a coupon or Aerva credit you used is given back.'
          ]}
        ], docs: ['booking-requirements', 'payments', 'privacy'] },

      { id: 'gift-group', group: 'guest', title: 'Gifts and split payments', category: 'booking_payment',
        summary: 'Booking a stay for someone else, accepting a gift, and paying your place in a group booking.',
        sections: [
          { title: 'Sending a stay as a gift', points: [
            'Choose “This stay is for someone else” at checkout, or “Send as a gift” on an upcoming booking in My Bookings.',
            'You stay in charge of the booking: changes, cancellations and refunds are yours. The recipient never sees the price. A gift can use a coupon and Aerva credit; it cannot be split.',
            'My Bookings shows whether they have accepted. You can change the recipient or stop the gift until check-in.'
          ]},
          { title: 'Accepting a gift', points: [
            'Open the link in the gift email, log in or create your account, add your first name, last name (as on your ID) and your mobile number, then tap Accept the gift.',
            'The link works once, until check-out. If it was already used or has stopped working, ask the person who sent it to change the recipient, which sends a new link.'
          ]},
          { title: 'Paying your place in a group booking', points: [
            'Open the share link, log in, choose how many places you are paying for, tick that a confirmed group booking is non-refundable, and pay. The page shows who has paid, the places left and the time left.',
            'The place is not held until the last payment. If someone else books it first, you are refunded in full automatically (“This place got booked by someone else. Try another listing.”).',
            'If your payment fails or you close the window, your place opens again. A payment that is not counted is refunded in full automatically, and we email you why.',
            'At 2 hours the organiser pays for any places still unpaid. If they don’t within 30 minutes, nothing is booked and you are refunded in full.',
            'Guests can be added to a group booking, within the listing’s limit, but never removed. Coupons, Aerva credit and free cancellation cannot be used on a split payment.',
            'Once confirmed it is non-refundable: no refund if plans change. A natural disaster or government order approved by Aerva, or a host cancellation, gives you your own share as Aerva credit; if Aerva’s check-in promise is not kept, you are refunded in full.'
          ]}
        ], docs: ['gift-group-bookings', 'cancellation-stays', 'payments'] },

      { id: 'free-cancellation', group: 'guest', title: 'Free cancellation add-on', category: 'cancellation_refund',
        summary: 'Adding free cancellation at checkout, and cancelling with it.',
        sections: [
          { title: 'Adding it', points: [
            'On a stay’s booking page, tick “Free cancellation” under Your details. It shows its price (the amount set by the host, between 5% and 30% of the stay price, plus GST) and until when it lasts.',
            'It is offered only where the host has chosen to offer it (the listing shows “Free cancellation available at checkout”), while check-in is more than 48 hours away, and not for experiences, resort rooms or split payments.',
            'If the host stops offering it, a booking that already has it keeps it.'
          ]},
          { title: 'Cancelling with it', points: [
            'Until the time shown — 48 hours before check-in, the property’s time — open the booking in My Bookings, choose Request cancellation and “Change of plans”, then Cancel now. It is cancelled at once; the host does not need to answer.',
            'You get back the booking price, its GST and any security deposit. The add-on and Aerva’s service fee are not refunded.',
            'After that time, the listing’s refund policy applies as for any booking.',
            'Changing dates keeps it, and the 48 hours move with your new check-in. Adding nights adds to it only if the new stay price is so much higher that it would be under 5% of it. A shorter stay does not refund it.'
          ]}
        ], docs: ['free-cancellation', 'cancellation-stays', 'booking-changes'] },

      { id: 'cancellations', group: 'guest', title: 'Cancellations and refunds', category: 'cancellation_refund',
        summary: 'Cancelling a booking, what is refunded or held as Aerva credit, and a refund you are waiting for.',
        sections: [
          { title: 'To cancel', points: [
            'You can cancel only before check-in, for one of three reasons: a change of plans, a natural disaster, or a government order or travel restriction.',
            'Change of plans: open the booking in My Bookings, choose Request cancellation and send the request. The host has 24 hours to answer it.',
            'The refund follows the listing’s refund policy, shown before you paid. The percentage is fixed when you send the request.',
            'If the host rejects your request, there is no refund. Aerva’s service fee is never refunded when you cancel for a change of plans. Any security deposit is always refunded to your original payment method.',
            'A natural disaster, or a government order or travel restriction: choose that reason and attach proof. Aerva decides, and your host cannot decline it. See the help topic “Natural disaster or government order”.',
            'A booking can be cancelled only before check-in. Once your stay has started, change your check-out date instead (Changing a booking).',
            'A booking you have transferred to another property cannot be cancelled. If something is not working, raise a request and choose the booking: Aerva will look at it and decide.',
            'With the free cancellation add-on, a change of plans is cancelled at once, with a full refund of the booking price, its GST and any security deposit, until 48 hours before check-in.',
            'A group (split-payment) booking is non-refundable once confirmed: the organiser can cancel it at once, but nothing is refunded except any security deposit, whatever the listing’s refund policy. A natural disaster or government order approved by Aerva, or a cancellation by the host, gives each payer their own share as Aerva credit.'
          ]},
          { title: 'If the host cancels', points: [
            'Whenever the host cancels, everything you paid — the booking price, GST and Aerva’s service fee — is held for you as Aerva credit for up to 6 months (its end date is shown in My Bookings); whatever is left when it ends is refunded to your original payment method automatically. Use it on another stay or experience, or have it refunded to your original payment method at any time from My Bookings. Any security deposit is refunded to your original payment method at once.',
            'If the host cancelled within 48 hours of check-in, about 15 minutes later you also receive an Aerva coupon worth 10% of the booking, valid for 1 month. It is not refundable, and you can use it together with your Aerva credit.',
            'Book another stay or experience and the credit is taken off what you pay, automatically — checkout shows it as “Aerva credit”. If the new booking costs less than your credit, the rest stays on the credit; if it costs more, you pay the difference.',
            'What is left on your credit shows in My Bookings. Have it refunded in full to your original payment method at any time. While it is unused, Aerva sends you a reminder from time to time.',
            'Credit from a cancellation Aerva approved for a natural disaster or government order is ordinary Aerva credit: use it for new dates, or have it refunded to your original payment method at any time with “Refund to original payment” in My Bookings.',
            'Your credit is not used for a security deposit: the deposit is paid with your chosen payment method and always refunded to it, never as Aerva credit.',
            'If a booking paid partly with credit is later cancelled or refunded, the refund goes to your original payment method first, and the part paid with credit goes back onto your credit.'
          ]},
          { title: 'Waiting for a refund', points: [
            'Refunds go to the original payment method. Banks and card issuers usually take several working days to show them.',
            'If a refund has not arrived after 7 working days, raise a request and choose the booking.'
          ]}
        ], docs: ['cancellation-stays', 'cancellation-experiences', 'payments'] },

      { id: 'natural-disaster', group: 'guest', title: 'Natural disaster or government order', category: 'cancellation_refund',
        summary: 'Cancelling because a natural disaster, or a government order or travel restriction, stops you reaching the stay.',
        sections: [
          { title: 'How to ask', points: [
            'It covers a natural disaster (a flood, cyclone, earthquake, landslide, fire or similar), or a government order or travel restriction (such as a lockdown, or a road closed by the authorities), that stops you reaching the stay.',
            'At any time before check-in, open the booking in My Bookings, choose Request cancellation, pick that reason and attach proof — for example a photo or news report, or the official order or notice. Then choose “Send to Aerva with proof”.',
            'Aerva checks the proof and decides. Your host is told and can add information, but cannot decline it. Aerva’s decision is final. You can follow it in My Bookings.'
          ]},
          { title: 'If Aerva approves', points: [
            'The booking is cancelled, and what you paid for it — the booking price, its GST, Aerva’s service fee and any free cancellation add-on — is held for you as Aerva credit.',
            'Use the credit for new dates, or have it refunded to your original payment method at any time with “Refund to original payment” in My Bookings. It lasts up to 6 months; whatever is left when it ends is refunded automatically.',
            'Any security deposit is refunded to your original payment method, never as credit. A part paid by coupon comes back as a new coupon.',
            'In a group booking, each person who paid gets their own share as Aerva credit.'
          ]},
          { title: 'If Aerva does not approve', points: [
            'Nothing changes and the booking stands. For a change of plans, the listing’s refund policy applies.'
          ]}
        ], docs: ['cancellation-stays', 'major-events', 'payments'] },

      { id: 'changes', group: 'guest', title: 'Changing a booking', category: 'change_booking',
        summary: 'Moving dates, extending or shortening a stay, guests, pets and add-ons.',
        sections: [
          { title: 'How', points: [
            'Choose the change in My Bookings. The new price and the difference are shown before you send it.',
            'The host accepts or rejects the change in Aerva Messages. Until then, your booking stays as it is.',
            'If the new total is higher, pay the difference within 24 hours of the host accepting.',
            'During your stay, ask by 10 AM (the property’s time) on the day after check-in. Leaving early: you won’t get anything back for the nights you don’t stay — no refund and no Aerva credit; your host is paid for the original dates. After that time the booking cannot be changed.',
            'If the host declines a change you asked for during your stay, or does not answer, you can raise it with Aerva within 24 hours: My Bookings → Report a problem.',
            'Before check-in, a cheaper change refunds the difference to your original payment method, but Aerva’s service fee stays as charged, and any part paid by coupon is not returned.',
            'To move some nights to another property of the same host, see the help topic “Moving nights to another property”.'
          ]},
          { title: 'When we can help', points: [
            'If the change will not send, the price looks wrong, or you paid the difference and the booking did not change, raise a request and choose the booking.'
          ]}
        ], docs: ['booking-changes'] },

      { id: 'transfers', group: 'guest', title: 'Moving nights to another property', category: 'change_booking',
        summary: 'Splitting a stay between the property you booked and another property of the same host.',
        sections: [
          { title: 'How a transfer works', points: [
            'In My Bookings → Change booking → “Move nights to another property of this host”. Choose the nights, then pick one of the host’s properties with the same co-hosts that is free for them.',
            'At least one night stays where you booked; your check-in and check-out dates stay the same. Possible before check-in, or until 10 AM (the property’s time) on the day after check-in, and not once the host has been paid.',
            'The summary shows every part, Aerva’s 5% transfer fee, and what you pay or get back before you send it. The host accepts; then you complete it within 24 hours — paying the difference, or accepting it as Aerva credit (refundable at any time from My Bookings). If the host declines or you do not complete it, nothing is charged.',
            'Once completed, a transfer is final: the booking cannot be changed, split again, shortened or cancelled. Each part has its own confirmation code.',
            'If something is not working after a transfer, raise a request and choose the booking. Aerva will look at it and decide.'
          ]}
        ], docs: ['booking-changes', 'service-fees'] },

      { id: 'stay-problem', group: 'guest', title: 'A problem during your stay', category: 'stay_problem',
        summary: 'Something does not work, the home is not clean or safe, or another problem once you are there.',
        sections: [
          { title: 'First', points: [
            'If anyone is in danger, call 112.',
            'Message the host in Aerva Messages. Most problems are fixed fastest by the host, on the spot.',
            'Take clear photos or a short video of the problem as soon as you notice it.'
          ]},
          { title: 'If it is not fixed', points: [
            'Report it from My Bookings once your stay has started and by 10 AM (the property’s time) on the day after check-in, with at least one photo or document. After that time it can no longer be reported for a refund.',
            'Aerva looks into it and lets you know the outcome.',
            'For an experience that was cancelled or did not run as described, raise a request and choose the booking.'
          ]},
          { title: 'Cannot check in, or the place is not as listed', points: [
            'Message or call the host first. If the place does not exist, is not as listed or is not available, report it straight away from My Bookings → Report a problem, with a photo. See the help topic “Aerva’s check-in promise”.'
          ]}
        ], docs: ['stay-issues', 'refund-experiences'] },

      { id: 'check-in-promise', group: 'guest', title: 'Aerva’s check-in promise', category: 'stay_problem',
        summary: 'What to do if, when you arrive, the place does not exist, is not as listed or is not available.',
        sections: [
          { title: 'Report it on arrival', points: [
            'Open the booking in My Bookings → Report a problem. Choose “On arrival: the property does not exist” or “On arrival: not as listed, or not available”, describe it and add at least one photo.',
            'Report it on your check-in day. The last moment is 10 AM (the property’s time) on the day after check-in. Waiting can cost you your booking payment. Aerva treats it as urgent.'
          ]},
          { title: 'If Aerva confirms it', points: [
            'Aerva offers you up to 3 other places in My Bookings. You pay only any difference; if the new place costs less, the difference is held for you as Aerva credit. Your new stay shows as one booking.',
            'Or choose “None of these — refund me in full”: everything you paid is refunded to your original payment method, including Aerva’s service fee.'
          ]},
          { title: 'After you check in', points: [
            'You may be asked whether the place is real and as listed. Tap “This place is real and as listed” if it is. Your answer helps other guests.'
          ]}
        ], docs: ['stay-issues', 'cancellation-stays'] },

      { id: 'deposit', group: 'guest', title: 'Security deposits', category: 'deposit_damage',
        summary: 'When a deposit is refunded, and what happens if a host reports damage.',
        sections: [
          { title: 'Refund', points: [
            'A security deposit is always refunded to the original payment method, never as Aerva credit — once 24 hours have passed after check-out, unless damage is reported.',
            'When no damage is reported, it is often refunded sooner.',
            'The deposit covers damage and extra cleaning, up to the deposit amount.'
          ]},
          { title: 'If damage is reported', points: [
            'You are told and can send your side, with any photos you have. Aerva decides how much of the deposit is refunded to you.',
            'Damage above the deposit is between you and the host.'
          ]}
        ], docs: ['resolution'] },

      { id: 'coupons', group: 'guest', title: 'Coupons', category: 'coupon',
        summary: 'Using an Aerva coupon, and a coupon you expected but did not receive.',
        sections: [
          { title: 'Using a coupon', points: [
            'A coupon covers the booking price only. The service fee, GST and any deposit are paid in full.',
            'One coupon per booking. Coupons belong to the account they were issued to and expire on the date shown — at most 1 month after they are issued.',
            'Your coupons and your Aerva credit are shown at the top of My Bookings, with each coupon’s code, value and last day, and your credit balance. The bell shows them too.',
            'Only one coupon can be used on a booking, even if you hold more than one.',
            'If your payment does not go through, nothing is booked and your coupon stays valid to use again.',
            'If the host cancels a booking you paid for partly by coupon, that part comes back as a new coupon valid for 1 month, plus the usual 10% coupon if they cancelled within 48 hours of check-in. If you cancel for a change of plans, the part paid by coupon is not returned.',
            'A coupon is not Aerva credit: a coupon cannot be refunded, and Aerva credit can.'
          ]},
          { title: 'A coupon that did not arrive', points: [
            'A cancellation coupon (when a host cancels within 48 hours of check-in) arrives about 15 minutes after the cancellation. If it has not arrived after an hour, raise a request and choose the booking.'
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
            'Payouts are sent automatically at 5 PM (the property’s time) on the day after check-in — for an experience, the day after its date — to your verified bank account, after Aerva’s commission and TDS.',
            'If a guest has asked to change the stay or reported a problem by then, only the first night is sent; the rest follows once the request is settled.',
            'If the booking changes after a payout is sent, the difference is settled automatically: less is deducted from your next payout, more is paid to you separately.',
            'If a guest moves nights to another of your properties (you or a co-host accept it in Messages), each part becomes its own booking with its own confirmation code and is paid out on its own, with commission and TDS worked out on that part’s amount. A transfer is not a cancellation: no penalty applies.',
            'See every payout and its status in My Earnings.'
          ]},
          { title: 'A payout on hold or failed', points: [
            'A payout may be held while a guest’s report, a refund or a damage claim is open. It is released once that is settled.',
            'Check-in promise: for stays arriving from 10 December 2026, the first payout for each of your listings is sent after its first guest checks out (if no report is open), instead of the day after check-in. Every later booking is paid as usual.',
            'If a guest reports on arrival that the place is not as listed or not available, that booking’s payout is held until Aerva decides. If Aerva upholds it, you are not paid for that booking; anything already paid out for it is your balance owed to Aerva and is deducted from your later payouts (shown in Payout details).',
            'A failed payout is usually a bank detail that does not match. Check your bank details in your account; the payout is tried again.',
            'If a payout is late or the amount looks wrong, raise a request and choose the booking.'
          ]},
          { title: 'TDS', points: [
            'TDS is deducted from every payout under section 194-O (section 393 of the Income-tax Act, 2025): 0.1% with a valid PAN, 5% without one or if your PAN is not linked to Aadhaar. Add your PAN in Payout details before your first payout.',
            'TDS applies from the first rupee. No GST is charged on Aerva’s commission. TDS is worked out on what is due to you after Aerva’s commission. Example: a ₹10,000 booking with a 5% commission of ₹500, so ₹9,500 is due to you; TDS at 0.1% is ₹9.50 and ₹9,490.50 is paid. The TDS is credited against your PAN and shows in your Form 26AS.',
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
          ]},
          { title: 'Free cancellation for your guests', points: [
            'Choose “Offer free cancellation to guests” when you list a home, or any time in Manage listing. It is off unless you turn it on, and needs no review.',
            'Set its price when you turn it on: one fixed ₹ amount per booking (₹100 or more). Guests pay that amount per booking; for very short or very long stays it is kept between 5% and 30% of the stay price. The form shows an example from your nightly price.',
            'Guests can then pay the amount set by you to cancel for a full refund (except Aerva’s service fee and the add-on) until 48 hours before check-in. You keep the add-on, less Aerva’s commission. If they cancel in time, you don’t get the stay price. It is not offered on resort rooms, experiences or split payments.',
            'If free cancellation is on but has no price (turned on before hosts set the price), guests can’t add it until you set one in Manage listing.',
            'A change applies to new bookings only: a booking that already has it keeps it.'
          ]},
          { title: 'A guest reports the property does not exist', points: [
            'The listing is hidden from search at once and its unsent payouts are held while Aerva checks. Reply in Messages straight away with your side and photos.',
            'If Aerva confirms it, that listing is blocked: you cannot reactivate it, and only Aerva can unblock it. Its future guests are moved to other places or refunded in full, and you are not paid for those bookings. Your other listings are not affected.',
            'If Aerva does not uphold it, the listing goes back live and the payouts are released.'
          ]}
        ], docs: ['content', 'free-cancellation', 'experience-standards', 'experience-host-terms'] },

      { id: 'calendar', group: 'host', title: 'Calendar and availability', category: 'calendar_availability',
        summary: 'Blocking dates, syncing other calendars, and dates that look wrong.',
        sections: [
          { title: 'Keeping dates right', points: [
            'Block dates you cannot host in your calendar — for maintenance, repairs or any other reason — so a guest never books them and you never need to cancel. Linked calendars (Airbnb, Booking.com and others) sync about every hour.',
            'If dates show as free or booked when they should not, raise a request with the listing and the dates.'
          ]}
        ], docs: [] },

      { id: 'host-cancellations', group: 'host', title: 'Cancelling as a host', category: 'cancellation_refund',
        summary: 'When a host may cancel, and what it means for you.',
        sections: [
          { title: 'Rules', points: [
            'Cancel before the check-in time, and give a reason. The guest is told the reason. After the check-in time, only Aerva can cancel: raise a request.',
            'Whenever you cancel, everything the guest paid is held for them as Aerva credit (refundable at any time), any security deposit is refunded to them, and you are not paid for that booking.',
            'At most 3 cancellations in any 12 months. Beyond that, raise a request in the Resolution Center: Aerva opens a request for you to confirm the cancellation; once you confirm, Aerva cancels it. If check-in is within 48 hours when you confirm, you must first pay for an Aerva coupon worth 10% of the booking for the guest (“Pay ₹… and confirm” on the request); Aerva does not pay it or deduct it later.',
            'Cancelling within 48 hours of check-in: you pay for the guest’s coupon (10% of the booking) before the booking is cancelled. What you pay for it is not refunded to you.',
            'A same-day booking that you cancel within 1 hour of it being made needs no coupon and does not count towards your 3.',
            'Block dates for maintenance, repairs or anything else that stops you hosting, so guests cannot book them and you never need to cancel.',
            'More than 48 hours before check-in, no coupon is owed; Aerva may decide further penalties for repeated cancellations.'
          ]},
          { title: 'Instead of cancelling', points: [
            'If something at the property has gone wrong, raise a request before cancelling. We may be able to help the guest another way.'
          ]},
          { title: 'A guest’s natural-disaster cancellation', points: [
            'A guest may ask to cancel for a natural disaster or a government order (such as a lockdown or a road closed by the authorities), with proof. Aerva checks the proof and decides; you cannot accept or decline it. You see it in Messages and on your dashboard, and you can add anything Aerva should know in Messages.',
            'If Aerva approves, what the guest paid is held for them as Aerva credit and you are not paid for that booking. It carries no penalty and does not count as your cancellation. If not, the booking stands.',
            'For a change of plans, answer in Messages within 24 hours: accept or reject the refund for that bracket, or in the last window choose 0–100%. What is not refunded is paid to you, less Aerva’s commission on what you receive.'
          ]}
        ], docs: ['cancellation-stays', 'cancellation-experiences'] },

      { id: 'damage', group: 'host', title: 'Damage and deposit claims', category: 'damage_claim',
        summary: 'Claiming against a security deposit after a stay.',
        sections: [
          { title: 'How to claim', points: [
            'Report damage through Aerva within 24 hours of check-out, from the booking.',
            'Photos or videos of the damage are required, shared through Aerva; a report without them is not accepted. Add a repair or cleaning estimate or invoice if you have one.',
            'Enter how much of the deposit you ask to keep — for damage and extra cleaning, by you or someone you call in — up to the deposit amount.',
            'Aerva reviews your request with the guest’s side and approves how much of the deposit, and what percentage, is paid to you. Aerva’s decision is final.',
            'No damage? Tick it when you review the guest.'
          ]},
          { title: 'Above the deposit', points: [
            'Aerva handles claims only up to the security deposit. Anything above it, or where no deposit was held, is between you and the guest: Aerva provides no refund or compensation for it.'
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
        summary: 'Inviting a co-host, what they can do, how their share is paid, and a cancellation coupon a co-host paid.',
        sections: [
          { title: 'Basics', points: [
            'Invite a co-host from Co-hosting. They accept with their own Aerva account.',
            'Aerva pays each co-host their own share, based on the percentage share the host sets and the co-host agrees to. Anything else between a host and a co-host is for them to settle.',
            'A co-host who cancels within 48 hours of check-in pays the guest\u2019s 10% coupon themselves. Any money between the host and the co-host for it is settled between them, outside Aerva.',
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
            'A password must have at least 8 characters, with at least one letter and one number. Very common passwords are not accepted.',
            'If you cannot sign in — your account is suspended, someone changed your email, or sign-in codes do not arrive — use Help → “Can’t sign in?”. You do not need to sign in for it. See the help topic “Can’t sign in?”.'
          ]},
          { title: 'Deleting your account', points: [
            'Delete it in Account Settings once nothing is open. Deletion cannot be undone.'
          ]}
        ], docs: ['accounts', 'privacy'] },

      { id: 'cant-sign-in', group: 'everyone', title: 'Can’t sign in?', category: 'account_signin',
        summary: 'Your account is suspended, someone changed your email, or sign-in codes do not arrive.',
        sections: [
          { title: 'Tell us without signing in', points: [
            'Aerva will never ask for your password or a sign-in code.',
            'Open Help & Support and choose “Can’t sign in?”. Choose the problem, give the email on your Aerva account and a phone number we can call, and say what happened. If you can no longer use that email, add one we can reach you at now.',
            'You receive a reference number and a private link. Keep the link: it opens your request, where you follow it and talk to Aerva Support. We may also call you.',
            'Lost the link? In Help & Support choose “Get a new link to it”, and enter the reference number and the email address Aerva writes to about it. A new private link is emailed there, and earlier links stop working.'
          ]}
        ], docs: ['accounts', 'privacy'] },

      { id: 'reviews', group: 'everyone', title: 'Reviews', category: 'reviews_badges',
        summary: 'Leaving a review, and reporting one that breaks the rules.',
        sections: [
          { title: 'Leaving a review', points: [
            'Guests and hosts may review each other within 15 days of check-out. Reviews appear once both have reviewed, or the window closes.',
            'A guest can message the host in Aerva Messages until the review window closes.',
            'Guests may add up to 5 photos of the stay to their review: no one’s face without their consent, and no phone numbers or other contact details.'
          ]},
          { title: 'Reporting a review', points: [
            'Report a review that is false, abusive, not about the stay, or offered in exchange for something. Raise a request and say which review and why.',
            'A review is not removed only because it is critical.'
          ]}
        ], docs: ['reviews', 'content'] },

      { id: 'report-content', group: 'everyone', title: 'Reporting a listing, review or message', category: 'report_content',
        summary: 'Something on Aerva that is false, abusive or breaks the rules.',
        sections: [
          { title: 'How to report', points: [
            'Raise a request and choose “Report a listing, review or message”. Say which listing, review or message it is and why, and add a screenshot.',
            'Aerva may remove any content that breaks the Content Policy or the Reviews Policy.'
          ]}
        ], docs: ['content', 'reviews', 'off-platform'] },

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
  }
};
