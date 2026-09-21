// aerva-cohost.js — co-host mode, on every page.
//
// When someone is working as a co-host for a host, the host they are
// helping is remembered on this device (localStorage 'aerva_acting_host').
// While it is set:
//   - every request the page makes for host data (api/host-listings) and
//     for messages / templates (api/guest-profile, those modes only) gets
//     ?actingHost=<id> added, so the server answers for that host — and
//     only with what this co-host is allowed to see and do (the server
//     checks every request; this file only routes them);
//   - a bar at the bottom of the screen says whose listings these are,
//     with a button to stop.
//
// Loaded as a plain (not deferred) script in <head>, so it is in place
// before any page script makes its first request.
(function(){
  'use strict';
  var KEY = 'aerva_acting_host';

  function read(){
    try{ var v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v && v.hostId ? v : null; }
    catch(e){ return null; }
  }
  window.AervaCohost = {
    get: read,
    start: function(info){
      try{ localStorage.setItem(KEY, JSON.stringify(info)); }catch(e){}
    },
    stop: function(){
      try{ localStorage.removeItem(KEY); }catch(e){}
      // Take the bar away at once: the Co-hosting page redraws in place
      // rather than reloading, so nothing else would remove it.
      try{
        var bar = document.getElementById('cohostBar');
        if(bar) bar.remove();
        document.body.classList.remove('is-cohosting');
      }catch(e){}
    }
  };

  var acting = read();
  if(!acting) return;

  // Must match the co-host allowlists in guest-profile.js.
  var MESSAGE_MODES = ['myConversations', 'conversationMessages', 'hostConversationMessages', 'unreadMessageCount', 'send', 'translate', 'conversationTemplates'];
  var TEMPLATE_MODES = ['templates', 'saveTemplate', 'deleteTemplate', 'myListingsGuidance', 'saveListingGuidance'];
  var COHOST_ADMIN = ['inviteCohost', 'updateCohost', 'removeCohost', 'resendCohostInvite', 'acceptCohostInvite', 'declineCohostInvite', 'leaveCohost', 'saveCohostDetails'];

  function bodyJson(init){
    try{ return init && typeof init.body === 'string' ? JSON.parse(init.body) : null; }catch(e){ return null; }
  }

  var originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if(originalFetch){
    window.fetch = function(input, init){
      try{
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var isHostApi = url.indexOf('/api/host-listings') !== -1;
        var isProfileApi = url.indexOf('/api/guest-profile') !== -1;
        if(isHostApi || isProfileApi){
          var u = new URL(url, window.location.href);
          var body = bodyJson(init);
          var route = true;
          if(isProfileApi){
            var mode = u.searchParams.get('mode') || (body && body.mode);
            route = MESSAGE_MODES.indexOf(mode) !== -1 || TEMPLATE_MODES.indexOf(mode) !== -1;
          } else {
            // Managing co-hosts, or one's own co-hosting, is never done
            // "as" someone else.
            // Nor are one's own payouts (as host or co-host): personal, like myCohosting.
            if(u.searchParams.get('cohosts') || u.searchParams.get('myCohosting') || u.searchParams.get('myPayouts') || u.searchParams.has('payoutDetail')) route = false;
            if(body && COHOST_ADMIN.some(function(k){ return body[k]; })) route = false;
          }
          if(route){
            u.searchParams.set('actingHost', String(acting.hostId));
            input = typeof input === 'string' ? u.toString() : new Request(u.toString(), input);
          }
        }
      }catch(e){ /* anything odd: send the request untouched */ }
      // Details still pending (phone, about, commission): the server refuses
      // to act for the host; send the co-host to the Co-hosting tab to finish.
      return originalFetch(input, init).then(function(r){
        try{
          if(r && r.status === 403 && read() && window.location.search.indexOf('view=cohost') === -1){
            r.clone().json().then(function(d){ if(d && d.detailsRequired) window.location.href = 'index.html?view=cohost'; }).catch(function(){});
          }
        }catch(e){}
        return r;
      });
    };
  }

  function showBar(){
    if(document.getElementById('cohostBar')) return;
    document.body.classList.add('is-cohosting');
    var bar = document.createElement('div');
    bar.id = 'cohostBar';
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed; left:50%; bottom:calc(16px + env(safe-area-inset-bottom, 0px)); transform:translateX(-50%); z-index:500;'
      + 'display:flex; align-items:center; gap:14px; flex-wrap:wrap; justify-content:center; max-width:calc(100vw - 24px);'
      + 'background:#1c1a17; color:#fff; padding:10px 12px 10px 18px; border-radius:999px; box-shadow:0 10px 30px rgba(0,0,0,0.25);'
      + "font-family:'Jost', sans-serif; font-size:13px;";
    var label = document.createElement('span');
    label.textContent = 'Co-hosting for ' + (acting.hostName || 'a host') + ' \u00b7 ' + (acting.access === 'full' ? 'Full access' : 'Limited access');
    // Stopping is done on the Co-hosting tab, not here: this bar only says
    // whose listings you are working on, and takes you there.
    var go = document.createElement('span');
    go.textContent = '\u203a';
    go.style.cssText = 'opacity:0.7; font-size:18px; line-height:1;';
    bar.style.cursor = 'pointer';
    bar.addEventListener('click', function(){ window.location.href = 'index.html?view=cohost'; });
    bar.setAttribute('title', 'Open the Co-hosting page');
    bar.appendChild(label);
    bar.appendChild(go);
    document.body.appendChild(bar);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showBar);
  else showBar();
})();
