// aerva-header.js — the site header on every page that is not index.html
// (My Collection, Status, My Earnings, Manage Listing, Log In).
//
// Same options as index.html's header, so moving between pages never
// changes what is at the top: logo, Today (hosts), Suites, Aerva
// Experience, Host With Aerva, currency, messages, notifications and the
// account menu. Links that belong to index.html go there (?view=…), since
// that is where those views live.
//
// Self-contained: it builds its own markup and styles (aerva-header.css),
// reads the same session and preferences index.html writes, and never
// depends on anything a page defines. A page only needs the <link> and
// <script> tags.
(function(){
  'use strict';

  var API_BASE = 'https://aerva-in.vercel.app';
  var SESSION_KEY = 'aerva_guest_session';
  var CURRENCY_KEY = 'aerva_currency';           // same key as aerva.js
  var NOTIF_READ_KEY = 'aerva_notifications_read'; // same key as aerva.js
  var CURRENCIES = ['INR','USD','GBP','EUR','AUD','CAD','SGD','AED','JPY','KRW','CHF','RUB'];

  // localStorage throws in Safari Private Browsing; never let that stop
  // the header (or the page under it) from working.
  var store = {
    get: function(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
    set: function(k, v){ try{ localStorage.setItem(k, v); }catch(e){} },
    remove: function(k){ try{ localStorage.removeItem(k); }catch(e){} }
  };
  function esc(t){
    return String(t == null ? '' : t).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  var ICONS = {
    today: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3.5v3M16 3.5v3"/></svg>',
    suites: '<svg viewBox="0 0 24 24"><path d="M4 11 12 4l8 7"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/></svg>',
    experience: '<svg viewBox="0 0 24 24"><path d="M12 3a5 5 0 0 1 5 5c0 3-2 5-5 8-3-3-5-5-5-8a5 5 0 0 1 5-5z"/><path d="M9 20h6M10 16l-1 4M14 16l1 4"/></svg>',
    host: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="1.5"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M18 8a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/></svg>'
  };

  function build(){
    var currency = store.get(CURRENCY_KEY) || 'INR';
    var header = document.createElement('header');
    header.className = 'ah-header';
    header.id = 'ahHeader';
    header.innerHTML =
      '<div class="ah-inner">' +
        '<a href="index.html" class="ah-logo" aria-label="Aerva home">' +
          '<img src="aerva-logo.png" alt="">' +
          '<span class="ah-logo-text"><span class="ah-wordmark">Aerva</span><span class="ah-tagline">Stay Elegant</span></span>' +
        '</a>' +
        '<nav class="ah-cats" aria-label="Browse">' +
          '<a href="index.html?view=today" class="ah-cat" id="ahToday" hidden>' + ICONS.today + 'Today</a>' +
          '<a href="index.html?view=suites" class="ah-cat">' + ICONS.suites + 'Suites</a>' +
          '<a href="index.html?view=experiences" class="ah-cat">' + ICONS.experience + 'Aerva Experience</a>' +
          '<span class="ah-cat ah-dd" tabindex="0">' + ICONS.host + 'Host With Aerva' +
            '<span class="ah-dd-menu">' +
              '<a href="index.html?view=list-property" target="_blank" rel="noopener">List Property</a>' +
              '<a href="index.html?view=list-experience" target="_blank" rel="noopener">List Experience</a>' +
            '</span>' +
          '</span>' +
          // Phones: the hover menu cannot open on touch, so its links sit
          // in the strip directly (hidden on desktop).
          '<a href="index.html?view=list-property" class="ah-cat ah-mobile-only" target="_blank" rel="noopener">List Property</a>' +
          '<a href="index.html?view=list-experience" class="ah-cat ah-mobile-only" target="_blank" rel="noopener">List Experience</a>' +
        '</nav>' +
        '<div class="ah-right">' +
          '<div class="ah-currency">' +
            '<button type="button" class="ah-currency-btn" id="ahCurrencyBtn" aria-label="Change display currency">' + esc(currency) + '</button>' +
            '<div class="ah-pop" id="ahCurrencyPop">' +
              CURRENCIES.map(function(c){ return '<button type="button" data-cur="' + c + '"' + (c === currency ? ' class="is-on"' : '') + '>' + c + '</button>'; }).join('') +
            '</div>' +
          '</div>' +
          '<a href="guest-login.html" class="ah-link" id="ahLogin">Log In</a>' +
          '<span class="ah-account" id="ahAccount" hidden>' +
            '<a href="index.html?view=messages" class="ah-icon-btn" aria-label="Messages">' + ICONS.chat + '<span class="ah-count" id="ahMsgCount" hidden></span></a>' +
            '<span class="ah-bell-wrap">' +
              '<button type="button" class="ah-icon-btn" id="ahBell" aria-label="Notifications">' + ICONS.bell + '<span class="ah-count" id="ahBellCount" hidden></span></button>' +
              '<div class="ah-pop ah-notif" id="ahNotif"><div class="ah-notif-head">Notifications</div><div id="ahNotifList"></div></div>' +
            '</span>' +
            '<span class="ah-menu-wrap">' +
              '<button type="button" class="ah-trigger" id="ahTrigger">' +
                '<span class="ah-avatar"><span id="ahAvatar">?</span></span>' +
                '<span class="ah-name" id="ahName"></span>' +
                '<span class="ah-tier" id="ahTier" hidden></span>' +
              '</button>' +
              '<div class="ah-pop ah-menu" id="ahMenu">' + menuLinks() + '</div>' +
            '</span>' +
          '</span>' +
        '</div>' +
        '<button type="button" class="ah-toggle" id="ahToggle" aria-label="Open menu" aria-expanded="false"><span></span><span></span><span></span></button>' +
      '</div>' +
      '<nav class="ah-panel" id="ahPanel" aria-label="Menu">' +
        '<a href="guest-login.html" id="ahLoginMobile">Log In</a>' +
        '<span id="ahAccountMobile" hidden style="display:flex; flex-direction:column; gap:16px;">' +
          '<a href="index.html?view=messages">Messages</a>' +
          // Phones have no bell (the right-hand cluster is hidden), so the
          // same notifications open here, in the menu.
          '<button type="button" class="ah-panel-btn" id="ahNotifMobileBtn" aria-expanded="false">Notifications <span class="ah-panel-count" id="ahBellCountMobile" hidden></span></button>' +
          '<div class="ah-notif-inline" id="ahNotifListMobile" hidden></div>' +
          menuLinks() +
        '</span>' +
      '</nav>';
    return header;
  }

  function menuLinks(){
    return '<a href="index.html?view=profile">Profile</a>' +
      '<a href="index.html?view=my-bookings">My Bookings</a>' +
      // My Collection and My Earnings: hosts with a live listing, and active
      // co-hosts (the listings they were given live there). Status is the
      // host's own verification, so hosts only — as on index.html.
      '<a href="host-dashboard.html" class="ah-host-only" data-ah-cohost hidden>My Collection</a>' +
      '<a href="host-status.html" class="ah-host-only" hidden>Status</a>' +
      '<a href="host-earnings.html" class="ah-host-only" data-ah-cohost hidden>My Earnings</a>' +
      '<a href="index.html?view=cohost">Co-hosting</a>' +
      '<a href="host-dashboard.html?openProfile=1" data-ah-settings>Account Settings</a>' +
      '<hr>' +
      '<a href="#" data-ah-logout>Log Out</a>';
  }

  // One popover open at a time; clicking anywhere else closes it.
  function wirePopover(button, pop){
    button.addEventListener('click', function(e){
      e.stopPropagation();
      var open = pop.classList.contains('is-open');
      document.querySelectorAll('.ah-pop.is-open').forEach(function(p){ p.classList.remove('is-open'); });
      if(!open) pop.classList.add('is-open');
    });
    pop.addEventListener('click', function(e){ e.stopPropagation(); });
  }

  function logout(){
    // Same keys index.html clears, so a log out here is a log out everywhere.
    // The notifications already seen belong to this account, not the device.
    ['aerva_guest_session','aerva_guest_email','aerva_guest_name','aerva_clone_listing','aerva_clone_with_photos','aerva_acting_host','aerva_pending_cohost_invite', NOTIF_READ_KEY]
      .forEach(store.remove);
    try{ sessionStorage.removeItem('aerva_cohost_convs'); }catch(e){}
    window.location.href = 'index.html';
  }

  function readIds(){ try{ return JSON.parse(store.get(NOTIF_READ_KEY) || '[]'); }catch(e){ return []; } }
  function markRead(id){
    var seen = readIds();
    if(seen.indexOf(id) < 0){ seen.push(id); store.set(NOTIF_READ_KEY, JSON.stringify(seen.slice(-200))); }
  }

  function renderNotifications(items){
    var notes = Array.isArray(items) ? items : [];
    var seen = readIds();
    var unread = notes.filter(function(n){ return seen.indexOf(n.id) < 0; }).length;
    ['ahBellCount', 'ahBellCountMobile'].forEach(function(id){
      var count = document.getElementById(id);
      if(!count) return;
      count.textContent = unread > 9 ? '9+' : String(unread);
      count.hidden = !unread;
    });
    ['ahNotifList', 'ahNotifListMobile'].forEach(function(id){
      var list = document.getElementById(id);
      if(list) fillNotifications(list, notes, seen);
    });
  }
  function fillNotifications(list, notes, seen){
    if(!notes.length){
      list.innerHTML = '<p class="ah-notif-empty">Nothing needs your attention right now.</p>';
      return;
    }
    list.innerHTML = notes.map(function(n){
      // A review notice opens the review form on index.html; here that
      // means My Bookings, where the same form lives.
      var href = n.orderId ? 'index.html?view=my-bookings' : (n.href || '#');
      return '<a class="ah-notif-item' + (seen.indexOf(n.id) < 0 ? ' is-unread' : '') + '" data-id="' + esc(n.id) + '" href="' + esc(href) + '">' +
        '<div class="ah-notif-title">' + esc(n.title) + '</div>' +
        '<div class="ah-notif-body">' + esc(n.body) + '</div>' +
        (n.due ? '<div class="ah-notif-due">' + esc(n.due) + '</div>' : '') +
      '</a>';
    }).join('');
    list.querySelectorAll('.ah-notif-item').forEach(function(a){
      a.addEventListener('click', function(){ markRead(a.getAttribute('data-id')); });
    });
  }

  function showAccount(guest){
    var name = guest.name || guest.email || guest.phone || 'there';
    document.getElementById('ahName').textContent = 'Hi, ' + name;
    var avatar = document.getElementById('ahAvatar');
    if(guest.profile_photo_url){
      avatar.innerHTML = '<img src="' + esc(guest.profile_photo_url) + '" alt="">';
    } else {
      avatar.textContent = String(name).trim().charAt(0).toUpperCase() || '?';
    }
    var tier = document.getElementById('ahTier');
    if(guest.tier && guest.tier.label){ tier.textContent = guest.tier.label; tier.hidden = false; }
    // Host-only links appear once the account has a live listing — the
    // same rule index.html applies (hasActiveListing from guest-auth) — and
    // My Collection, My Earnings and Today for an active co-host too.
    var isHost = guest.hasActiveListing === true;
    var isCohost = guest.isCohost === true;
    document.querySelectorAll('#ahHeader .ah-host-only').forEach(function(el){
      el.hidden = !(isHost || (isCohost && el.hasAttribute('data-ah-cohost')));
    });
    document.getElementById('ahToday').hidden = !(isHost || isCohost);
    document.getElementById('ahLogin').hidden = true;
    document.getElementById('ahLoginMobile').hidden = true;
    document.getElementById('ahAccount').hidden = false;
    document.getElementById('ahAccountMobile').hidden = false;
    renderNotifications(guest.notifications || []);
  }

  function loadSession(){
    var token = store.get(SESSION_KEY);
    if(!token) return;
    var auth = { 'Authorization': 'Bearer ' + token };
    fetch(API_BASE + '/api/guest-auth', { headers: auth })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(data){ if(data && data.guest) showAccount(data.guest); })
      .catch(function(){ /* header stays in its logged-out state */ });
    fetch(API_BASE + '/api/guest-profile?mode=unreadMessageCount', { headers: auth })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        if(!d || !d.count) return;
        var el = document.getElementById('ahMsgCount');
        el.textContent = d.count > 9 ? '9+' : String(d.count);
        el.hidden = false;
      })
      .catch(function(){});
  }

  function chooseCurrency(code){
    store.set(CURRENCY_KEY, code);
    document.getElementById('ahCurrencyBtn').textContent = code;
    document.querySelectorAll('#ahCurrencyPop button').forEach(function(b){
      b.classList.toggle('is-on', b.getAttribute('data-cur') === code);
    });
    document.getElementById('ahCurrencyPop').classList.remove('is-open');
    // Saved to the account too, same as index.html, so it follows the
    // guest to other devices. Prices on host pages stay in INR — this is
    // the currency guests browse in.
    var token = store.get(SESSION_KEY);
    if(token){
      fetch(API_BASE + '/api/guest-profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ preferredCurrency: code })
      }).catch(function(){});
    }
  }

  function markCurrentPage(){
    var here = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('#ahHeader .ah-menu a, #ahHeader .ah-panel a').forEach(function(a){
      var target = (a.getAttribute('href') || '').split('?')[0];
      if(target === here && !a.hasAttribute('data-ah-settings')) a.classList.add('is-here');
    });
  }

  function mount(){
    if(document.getElementById('ahHeader')) return;
    var header = build();
    var body = document.body;
    body.insertBefore(header, body.firstChild);
    body.classList.add('ah-has-header');
    // Edge to edge, whatever side padding the page gives its content.
    var cs = window.getComputedStyle(body);
    header.style.marginLeft = '-' + cs.paddingLeft;
    header.style.marginRight = '-' + cs.paddingRight;

    wirePopover(document.getElementById('ahCurrencyBtn'), document.getElementById('ahCurrencyPop'));
    wirePopover(document.getElementById('ahBell'), document.getElementById('ahNotif'));
    wirePopover(document.getElementById('ahTrigger'), document.getElementById('ahMenu'));
    document.addEventListener('click', function(){
      document.querySelectorAll('.ah-pop.is-open').forEach(function(p){ p.classList.remove('is-open'); });
    });
    document.querySelectorAll('#ahCurrencyPop button').forEach(function(b){
      b.addEventListener('click', function(){ chooseCurrency(b.getAttribute('data-cur')); });
    });
    header.querySelectorAll('[data-ah-logout]').forEach(function(a){
      a.addEventListener('click', function(e){ e.preventDefault(); logout(); });
    });
    // On My Collection itself, Account Settings opens the profile panel in
    // place instead of reloading the page to do the same thing.
    header.querySelectorAll('[data-ah-settings]').forEach(function(a){
      a.addEventListener('click', function(e){
        var trigger = document.getElementById('hostProfileTrigger');
        if(trigger){ e.preventDefault(); document.getElementById('ahMenu').classList.remove('is-open'); trigger.click(); }
      });
    });
    var mobileNotifBtn = document.getElementById('ahNotifMobileBtn');
    mobileNotifBtn.addEventListener('click', function(){
      var list = document.getElementById('ahNotifListMobile');
      list.hidden = !list.hidden;
      mobileNotifBtn.setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
    });
    var toggle = document.getElementById('ahToggle');
    toggle.addEventListener('click', function(){
      var panel = document.getElementById('ahPanel');
      var open = panel.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    markCurrentPage();
    loadSession();
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
