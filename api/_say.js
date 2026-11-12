// _say.js — the words Aerva uses for the same things everywhere.
// Owner, 12 Nov 2026 ("Do all", suggestions 6–9):
//
//   6  End every notice with what happens next, and by when.
//   7  Say the amount in the subject line where there is one.
//   8  Every email about a booking carries the confirmation code and the
//      request number in the same place, every time.
//   9  One name for one thing: credit, coupon and refund are three
//      different things, said in the same words wherever they appear.
//
// Nothing here decides anything. It is wording only, in one file, so the
// email, the notice, the bell and the page cannot drift apart.
//
//   nextStep(html)                  the closing line of an email
//   nextStepText(text)              the same for a plain-text notice
//   refBlock({ code, ref })         the reference line under the heading
//   subject(parts…)                 a subject with the amount in it
//   inr(n)                          ₹8,400 — whole rupees, Indian grouping
//   money.credit / coupon / refund  the one-line definition of each
//   moneyNote(kind)                 that definition, ready for an email
//   deposit                         the one line about a security deposit

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-IN');

// ---------------------------------------------------------------------
// 6 · What happens next, and by when.
// One line, bold, at the end — what people scan for. Pass the words;
// it is never built from a template, because every wait ends differently.
// ---------------------------------------------------------------------
function nextStep(html) {
  const t = String(html == null ? '' : html).trim();
  if (!t) return '';
  return `<p style="margin:18px 0 0; padding:12px 14px; background:#f7f1e6; border-left:3px solid #a9884f; font-weight:600; line-height:1.55;">${t}</p>`;
}
// The same sentence where there is no HTML: a thread notice, a bell, an SMS.
function nextStepText(text) {
  const t = String(text == null ? '' : text).trim();
  return t ? '\n\nWhat happens next: ' + t : '';
}
// The commonest ones, so they are worded identically everywhere.
const steps = {
  nothingToDo: (byWhen) => `Nothing for you to do${byWhen ? ` — your refund should be in your account by ${esc(byWhen)}` : ''}.`,
  answerBy: (when, orElse) => `Please answer by ${esc(when)}${orElse ? `, or ${esc(orElse)}` : ''}.`,
  weAnswerBy: (when) => `Aerva will come back to you by ${esc(when)}. You do not need to write again.`,
  yourTurn: (when) => `Your turn: add anything else by ${esc(when)} and Aerva picks it up from there.`
};

// ---------------------------------------------------------------------
// 8 · The reference, in the same place every time.
// Under the heading of every email about a booking or a request: the
// confirmation code, and the request number where there is one. Nobody
// should have to hunt for it, or be asked for it twice.
// ---------------------------------------------------------------------
function refBlock({ code, ref, listing } = {}) {
  const bits = [];
  if (code) bits.push(`Booking <strong>${esc(code)}</strong>`);
  if (ref) bits.push(`Request <strong>${esc(ref)}</strong>`);
  if (!bits.length) return '';
  const where = listing ? ` · ${esc(listing)}` : '';
  return `<p style="margin:0 0 16px; font-size:12.5px; letter-spacing:0.04em; text-transform:uppercase; opacity:0.7;">${bits.join(' · ')}${where}</p>`;
}
// The same, for a plain-text line or a thread notice.
function refText({ code, ref } = {}) {
  return [code ? 'Booking ' + code : '', ref ? 'Request ' + ref : ''].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------
// 7 · The amount in the subject line.
//   subject('Your cancellation is approved', 8400, 'on its way')
//     → 'Your cancellation is approved — ₹8,400 on its way'
// An amount of nothing is left out rather than written as ₹0.
// ---------------------------------------------------------------------
function subject(lead, amount, tail) {
  const a = Math.round(Number(amount) || 0);
  if (!a) return String(lead || '').trim();
  return `${String(lead || '').trim()} — ${inr(a)}${tail ? ' ' + tail : ''}`;
}

// ---------------------------------------------------------------------
// 9 · One name for one thing.
// The three kinds of money back, each in one line, in these words
// wherever they appear — email, booking page, the money panel, help.
// ---------------------------------------------------------------------
const money = {
  refund: { label: 'Refund', line: 'Goes back to the card or account you paid with. Banks usually show it within 5 to 7 working days.' },
  credit: { label: 'Aerva credit', line: 'Spend it on any Aerva stay or experience — or ask for it back to your original payment at any time.' },
  coupon: { label: 'Aerva coupon', line: 'Comes off one booking at checkout. It cannot be cashed and it has a last day to use it.' }
};
function moneyNote(kind) {
  const m = money[kind];
  return m ? `<p style="margin:10px 0 0; font-size:12.5px; opacity:0.75;"><strong>${m.label}:</strong> ${m.line}</p>` : '';
}
// A security deposit is not any of the three, and is asked about as often.
const deposit = 'Your security deposit is separate from all of this: it is refunded in full unless the host reports damage within 24 hours of check-out.';

module.exports = { nextStep, nextStepText, steps, refBlock, refText, subject, inr, money, moneyNote, deposit, esc };
