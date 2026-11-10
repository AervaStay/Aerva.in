// _help-link.js — where emails send people for help: the Resolution Center
// (Aerva Support, index.html?view=help). Owner, 10 Nov 2026: every issue
// goes through it, and no message tells anyone to email Aerva.
//
//   helpUrl({ category, order, listing })  a new request, prefilled
//                                          (category = a key from
//                                          AERVA_POLICIES.support.categories)
//   helpLink(opts, text)                   that URL as an email link
//   helpLine(opts, lead)                   "Need help? Raise a request in Aerva Support."
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

module.exports = { helpUrl, helpLink, helpLine };
