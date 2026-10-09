// aerva-env.js — which Aerva this page is part of. Loaded first on every page.
//
// Production: the site at aerva.in (GitHub Pages) calls the API at
// aerva-in.vercel.app. Anywhere else — the UAT site (uat.aerva.in), a
// Vercel preview, or a local copy — the page calls the API on its OWN
// address, so UAT pages always talk to UAT code and the UAT database, and
// can never reach production by mistake.
(function () {
  var PROD_API = 'https://aerva-in.vercel.app';
  var h = location.hostname;
  var isProdSite = h === 'aerva.in' || h === 'www.aerva.in';
  var isProdApi = h === 'aerva-in.vercel.app';
  var isLocal = h === 'localhost' || h === '127.0.0.1' || location.protocol === 'file:';
  window.AERVA_API = (isProdSite || location.protocol === 'file:') ? PROD_API : location.origin;
  window.AERVA_ENV = isProdSite || isProdApi ? 'production' : isLocal ? 'local' : 'uat';

  if (window.AERVA_ENV !== 'uat') return;
  // Never in search results.
  var meta = document.createElement('meta'); meta.name = 'robots'; meta.content = 'noindex, nofollow';
  document.head.appendChild(meta);
  document.title = '[UAT] ' + document.title;
  // A banner on every page, so nobody mistakes UAT for the live site.
  function banner() {
    if (document.getElementById('aervaUatBanner')) return;
    var b = document.createElement('div');
    b.id = 'aervaUatBanner';
    b.setAttribute('role', 'note');
    b.textContent = 'UAT · test site';
    b.title = 'UAT — test site. Payments use Razorpay test mode; emails go only to the Aerva team.';
    b.style.cssText = 'position:fixed; left:8px; bottom:8px; z-index:2147483000; background:#7a2e25; color:#fff;'
      + ' font:600 11px/1 system-ui, sans-serif; letter-spacing:0.04em; padding:6px 10px; border-radius:999px;'
      + ' box-shadow:0 2px 8px rgba(0,0,0,0.25); pointer-events:none; opacity:0.92;';
    document.body.appendChild(b);
  }
  if (document.body) banner(); else document.addEventListener('DOMContentLoaded', banner);
})();
