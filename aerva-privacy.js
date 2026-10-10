// aerva-privacy.js — the Privacy switches in Account Settings.
// Used by index.html (?view=settings) and host-dashboard.html (the
// Account Settings window, Privacy tab), so both show the same switches.
// The options themselves, and what each one hides, come from the server
// (api/_profiles.js PRIVACY_OPTIONS); this file only draws and saves them.
//
//   AervaPrivacy.mount(element)  — draws the switches into element.
(function(){
  var API = (window.AERVA_API || 'https://aerva-in.vercel.app') + '/api/guest-profile';
  function token(){ try{ return localStorage.getItem('aerva_guest_session'); }catch(e){ return null; } }
  function esc(t){ return String(t == null ? '' : t).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function addStyles(){
    if(document.getElementById('aervaPrivacyStyles')) return;
    var st = document.createElement('style');
    st.id = 'aervaPrivacyStyles';
    st.textContent = [
      '.apv-group{margin:0 0 22px;}',
      '.apv-group-title{font-size:12px; letter-spacing:0.14em; text-transform:uppercase; color:#8a6c39; margin:0 0 4px;}',
      '.apv-group-note{font-size:13.5px; color:#6e675d; line-height:1.55; margin:0 0 6px;}',
      '.apv-row{display:flex; align-items:center; justify-content:space-between; gap:16px; padding:13px 0; border-bottom:1px solid #ece4d8;}',
      '.apv-row:last-child{border-bottom:none;}',
      '.apv-text{min-width:0;}',
      '.apv-label{font-size:15px; color:#1c1a17;}',
      '.apv-hint{font-size:12.5px; color:#6e675d; margin-top:2px; line-height:1.45;}',
      '.apv-switch{position:relative; flex:0 0 auto; width:46px; height:26px; border-radius:999px; border:none; background:#cfc6b8; cursor:pointer; padding:0; transition:background .18s;}',
      '.apv-switch::after{content:""; position:absolute; top:3px; left:3px; width:20px; height:20px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,0.25); transition:transform .18s;}',
      '.apv-switch[aria-checked="true"]{background:#8a6c39;}',
      '.apv-switch[aria-checked="true"]::after{transform:translateX(20px);}',
      '.apv-switch:focus-visible{outline:2px solid #1c1a17; outline-offset:2px;}',
      '.apv-switch:disabled{opacity:0.55; cursor:default;}',
      '.apv-state{font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:#6e675d; margin-right:8px; min-width:22px; text-align:right;}',
      '.apv-control{display:flex; align-items:center; flex:0 0 auto;}',
      '.apv-msg{font-size:13px; min-height:18px; margin:6px 0 0; color:#3a7d44;}',
      '.apv-msg.is-error{color:#a3402f;}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function row(o, on){
    return '<div class="apv-row">'
      + '<div class="apv-text"><div class="apv-label" id="apv-l-' + esc(o.id) + '">' + esc(o.label) + '</div>'
      + (o.hint ? '<div class="apv-hint">' + esc(o.hint) + '</div>' : '') + '</div>'
      + '<div class="apv-control"><span class="apv-state" aria-hidden="true">' + (on ? 'On' : 'Off') + '</span>'
      + '<button type="button" class="apv-switch" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" aria-labelledby="apv-l-' + esc(o.id) + '" data-apv="' + esc(o.id) + '"></button></div>'
      + '</div>';
  }

  async function mount(el){
    if(!el) return;
    addStyles();
    var t = token();
    if(!t){ el.innerHTML = '<p class="apv-group-note">Log in to change your privacy settings.</p>'; return; }
    el.innerHTML = '<p class="apv-group-note">Loading…</p>';
    var data;
    try{
      var r = await fetch(API + '?mode=privacy', { headers: { 'Authorization': 'Bearer ' + t } });
      data = await r.json();
      if(!r.ok) throw new Error(data.error || 'failed');
    }catch(e){
      el.innerHTML = '<p class="apv-group-note">Could not load your privacy settings. Please refresh.</p>';
      return;
    }
    var settings = data.settings || {};
    var opts = (data.options || []).filter(function(o){ return data.isHost || !o.hostOnly; });
    var browse = opts.filter(function(o){ return o.scope === 'browse'; });
    var booked = opts.filter(function(o){ return o.scope !== 'browse'; });
    el.innerHTML =
      (browse.length ? '<div class="apv-group"><div class="apv-group-title">Your host profile</div>'
        + '<p class="apv-group-note">What guests see when they open your profile from one of your homes, before they book. Your name, your homes’ reviews and rating always show. Once a guest books with you, they see your full profile.</p>'
        + browse.map(function(o){ return row(o, settings[o.id] !== false); }).join('') + '</div>' : '')
      + (booked.length ? '<div class="apv-group"><div class="apv-group-title">' + (browse.length ? 'Once you share a booking' : 'Your profile') + '</div>'
        + '<p class="apv-group-note">Your profile is only ever shown to a host once you book with them' + (data.isHost ? ', and to guests who book with you' : '') + '.</p>'
        + booked.map(function(o){ return row(o, settings[o.id] !== false); }).join('') + '</div>' : '')
      + '<p class="apv-msg" aria-live="polite"></p>';
    var msg = el.querySelector('.apv-msg');
    el.querySelectorAll('.apv-switch').forEach(function(sw){
      sw.addEventListener('click', async function(){
        var id = sw.getAttribute('data-apv');
        var next = sw.getAttribute('aria-checked') !== 'true';
        var state = sw.parentNode.querySelector('.apv-state');
        sw.setAttribute('aria-checked', next ? 'true' : 'false');
        state.textContent = next ? 'On' : 'Off';
        sw.disabled = true;
        msg.className = 'apv-msg'; msg.textContent = 'Saving…';
        var wanted = Object.assign({}, settings); wanted[id] = next;
        try{
          var r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() },
            body: JSON.stringify({ mode: 'savePrivacy', settings: wanted }) });
          var d = await r.json().catch(function(){ return {}; });
          if(!r.ok) throw new Error(d.error || 'Could not save. Please try again.');
          settings = d.settings || wanted;
          msg.textContent = 'Saved.';
        }catch(e){
          sw.setAttribute('aria-checked', next ? 'false' : 'true');
          state.textContent = next ? 'Off' : 'On';
          msg.className = 'apv-msg is-error'; msg.textContent = e.message;
        }
        sw.disabled = false;
      });
    });
  }

  window.AervaPrivacy = { mount: mount };
})();
