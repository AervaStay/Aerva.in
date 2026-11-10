// _help-link.js — where emails send people for help: the Resolution Center
// (Aerva Support, index.html?view=help). Owner, 10 Nov 2026: every issue
// goes through it, and no message tells anyone to email Aerva.
//
//   helpUrl({ category, order, listing })  a new request, prefilled
//                                          (category = a key from
//                                          AERVA_POLICIES.support.categories)
//   helpLink(opts, text)                   that URL as an email link
//   helpLine(opts, lead)                   "Need help? Raise a request in Aerva Support."
//   signinHelpUrl({ problem })             "Can't sign in?" — a request without an
//                                          account (index.html?view=help&signin=1;
//                                          problem = suspended | email_changed |
//                                          no_codes | other, preselected)
//   signinHelpLink(opts, text)             that URL as an email link
//   SIGNIN_HELP_TEXT                       the same, as plain words for an error
//                                          message ("Help → Can’t sign in?")
const SITE = 'https://aerva.in';

function helpUrl({ category, order, listing } = {}) {
  const q = ['view=help', 'new=1'];
  if (category) q.push('category=' + encodeURIComponent(category));
  if (order) q.push('order=' + encodeURIComponent(order));
  if (listing) q.push('listing=' + encodeURIComponent(listing));
  return SITE + '/index.html?' + q.join('&');
}

const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function helpLink(opts = {}, text = 'Raise a request in Aerva Support') {
  return `<a href="${attr(helpUrl(opts))}" style="color:#8a6c39;">${text}</a>`;
}

function helpLine(opts = {}, lead = 'Need help?') {
  return `${lead} ${helpLink(opts)}.`;
}

// "Can't sign in?" (owner, 10 Nov 2026): for a suspended account, someone
// locked out after an email change, or someone who gets no sign-in codes.
// Opens the form directly on the help page.
const SIGNIN_PROBLEMS = ['suspended', 'email_changed', 'no_codes', 'other'];
function signinHelpUrl({ problem } = {}) {
  const q = ['view=help', 'signin=1'];
  if (problem && SIGNIN_PROBLEMS.includes(problem)) q.push('problem=' + problem);
  return SITE + '/index.html?' + q.join('&');
}
function signinHelpLink(opts = {}, text = 'tell us through “Can’t sign in?” in Aerva Support') {
  return `<a href="${attr(signinHelpUrl(opts))}" style="color:#8a6c39;">${text}</a>`;
}
const SIGNIN_HELP_TEXT = 'Help → Can’t sign in? (aerva.in/index.html?view=help&signin=1)';

module.exports = { helpUrl, helpLink, helpLine, signinHelpUrl, signinHelpLink, SIGNIN_HELP_TEXT, SIGNIN_PROBLEMS };
