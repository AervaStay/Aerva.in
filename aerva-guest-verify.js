// aerva-guest-verify.js — a guest's own details (owner, 10 Nov 2026).
// Used by index.html (aerva.js) and host-dashboard.html.
//
//   1. "Complete your profile": a pop-up at each sign-in, and when a booking
//      is started, while the account has no first name, last name or phone.
//      "Do it later" closes it; it is not shown when nothing is missing.
//        AervaGuestVerify.sessionSeen(guest, token, freshSignIn)   after the session check
//        AervaGuestVerify.promptIfNeeded({ reason, then })         'login' | 'booking'
//      Listing a property (aerva.js) REQUIRES the name and phone to submit:
//        AervaGuestVerify.openProfilePrompt(pp, { required: true, lead, then })
//      — no "Do it later" there; "Back to the form" returns without submitting.
//
//   2. The three steps of a verified profile — name, phone code, photo ID
//      (api/_guest-verify.js) — as one panel, used on the Profile, on the
//      "waiting for your details" screen after paying, and in My Bookings.
//        AervaGuestVerify.mountSteps(el, { onConfirmed })
//
//   3. A payment that waits for those details:
//        AervaGuestVerify.showHeld(held)          the screen right after payment (no skip)
//        AervaGuestVerify.heldCardHtml(b) / wireCards(container)   the My Bookings card, with its countdown
//
// The ID photo is made smaller here and sent straight to the check; it is
// read in memory and not kept. Every text from the server is escaped.
(function(){
  var API = function(){ return (window.AERVA_API || 'https://aerva-in.vercel.app') + '/api/'; };
  var HELD_TEXT = 'Your booking will be confirmed once your details are submitted and verified.';
  function token(){ try{ return localStorage.getItem('aerva_guest_session'); }catch(e){ return null; } }
  function esc(t){ return String(t == null ? '' : t).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function store(k, v){ try{ if(v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); }catch(e){ return null; } }

  function addStyles(){
    if(document.getElementById('agvStyles')) return;
    var st = document.createElement('style');
    st.id = 'agvStyles';
    st.textContent = [
      '.agv-overlay{position:fixed; inset:0; z-index:9500; background:rgba(28,26,23,0.5); display:flex; align-items:center; justify-content:center; padding:16px; overflow-y:auto; -webkit-overflow-scrolling:touch;}',
      '.agv-dialog{background:#fff; color:#1c1a17; border-radius:16px; width:100%; max-width:460px; padding:26px 24px 22px; box-shadow:0 18px 60px rgba(28,26,23,0.25); font-family:inherit; font-size:15px; line-height:1.55; margin:auto; box-sizing:border-box;}',
      '.agv-dialog.is-wide{max-width:560px;}',
      '.agv-eyebrow{font-size:11.5px; letter-spacing:0.14em; text-transform:uppercase; color:#8a6c39; margin:0 0 6px;}',
      '.agv-dialog h2{font-family:"Bodoni Moda", Georgia, serif; font-weight:500; font-size:26px; line-height:1.2; margin:0 0 8px; color:#1c1a17;}',
      '.agv-lead{margin:0 0 16px; color:#3d3a35;}',
      '.agv-field{display:block; margin:0 0 12px;}',
      '.agv-field > span{display:block; font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#6e675d; margin:0 0 5px;}',
      '.agv-field input, .agv input[type=text], .agv input[type=tel]{width:100%; box-sizing:border-box; border:1px solid #d9cdb8; border-radius:10px; padding:11px 12px; font:inherit; font-size:16px; background:#fff; color:#1c1a17; min-height:46px;}',
      '.agv-field input:focus, .agv input:focus{outline:2px solid #a9884f; outline-offset:1px; border-color:#a9884f;}',
      '.agv-two{display:grid; grid-template-columns:1fr 1fr; gap:12px;}',
      '@media (max-width:480px){ .agv-two{grid-template-columns:1fr; gap:0;} .agv-dialog{padding:22px 18px 18px;} .agv-dialog h2{font-size:23px;} }',
      '.agv-actions{display:flex; gap:10px; flex-wrap:wrap; margin-top:6px;}',
      '.agv-btn{background:#1c1a17; color:#fff; border:1px solid #1c1a17; border-radius:999px; padding:12px 22px; font:inherit; font-size:14.5px; letter-spacing:0.02em; cursor:pointer; min-height:46px; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box;}',
      '.agv-btn:disabled{opacity:0.55; cursor:default;}',
      '.agv-btn.is-quiet{background:#fff; color:#1c1a17; border-color:#d9cdb8;}',
      '.agv-btn:focus-visible, .agv-link:focus-visible{outline:2px solid #a9884f; outline-offset:2px;}',
      '.agv-link{background:none; border:none; color:#7c6030; font:inherit; font-size:14px; cursor:pointer; padding:10px 0; text-decoration:underline; min-height:44px;}',
      '.agv-msg{font-size:14px; min-height:20px; margin:10px 0 0; line-height:1.5;}',
      '.agv-msg.is-error{color:#a3402f;}',
      '.agv-msg.is-ok{color:#2f6b37;}',
      '.agv-small{font-size:13px; color:#6e675d; margin:8px 0 0; line-height:1.5;}',
      '.agv{font-size:14.5px; color:#1c1a17; line-height:1.55;}',
      '.agv-step{display:flex; gap:12px; align-items:flex-start; padding:14px 0; border-top:1px solid #eee5d8;}',
      '.agv-step:first-child{border-top:none; padding-top:4px;}',
      '.agv-num{flex:0 0 28px; width:28px; height:28px; border-radius:50%; border:1px solid #d9cdb8; display:flex; align-items:center; justify-content:center; font-size:13px; color:#6e675d; margin-top:1px;}',
      '.agv-step.is-done .agv-num{background:#2f6b37; border-color:#2f6b37; color:#fff;}',
      '.agv-step.is-wait .agv-num{background:#f6efe3; border-color:#e0cda8; color:#7c6030;}',
      '.agv-body{flex:1 1 auto; min-width:0;}',
      '.agv-title{font-weight:600; margin:2px 0 2px;}',
      '.agv-state{color:#3d3a35; margin:0; overflow-wrap:anywhere;}',
      '.agv-row{display:flex; gap:8px; flex-wrap:wrap; align-items:stretch; margin-top:8px;}',
      '.agv-row input{flex:1 1 150px; min-width:0;}',
      '.agv-row .agv-btn{flex:0 0 auto;}',
      '.agv-file{display:block; width:100%; box-sizing:border-box; margin-top:8px; font:inherit; font-size:14px; padding:10px; border:1px dashed #d9cdb8; border-radius:10px; background:#fbf8f3; min-height:46px;}',
      '.agv-held-items{margin:0 0 14px; padding:12px 14px; border:1px solid #e6ded3; border-radius:12px; background:#fbf8f3;}',
      '.agv-held-items p{margin:0; }',
      '.agv-held-items p + p{margin-top:6px;}',
      '.agv-deadline{margin:0 0 14px; padding:12px 14px; border-radius:12px; background:#f6efe3; border:1px solid #e0cda8; color:#3d3a35;}',
      '.agv-deadline strong{color:#1c1a17;}',
      '.agv-count{font-variant-numeric:tabular-nums; font-weight:600; color:#7c6030; white-space:nowrap;}',
      '.agv-count.is-soon{color:#a3402f;}',
      '.agv-card{margin:0 0 14px; padding:18px 18px 14px; border:1px solid #e0cda8; border-radius:14px; background:#fff;}',
      '.agv-card h3{font-family:"Bodoni Moda", Georgia, serif; font-weight:500; font-size:21px; margin:0 0 2px;}',
      '.agv-pill{display:inline-block; font-size:12px; letter-spacing:0.06em; text-transform:uppercase; padding:4px 10px; border-radius:999px; background:#f6efe3; color:#7c6030; border:1px solid #e0cda8; margin:0 0 8px;}',
      '.agv-pill.is-off{background:#f4f1ec; color:#6e675d; border-color:#e6ded3;}',
      'html.agv-open{overflow:hidden;}'
    ].join('\n');
    document.head.appendChild(st);
  }

  async function call(method, body, query){
    var r = await fetch(API() + 'guest-profile' + (query || ''), {
      method: method, headers: Object.assign({ 'Authorization': 'Bearer ' + token() }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    var d = await r.json().catch(function(){ return {}; });
    if(!r.ok){ var e = new Error(d.error || 'Could not do this right now. Please try again.'); e.data = d; e.status = r.status; throw e; }
    return d;
  }

  // ------------------------------------------------------------ dialogs
  // A proper modal dialog: labelled, focus kept inside, focus returned to
  // where it was. onEscape: what Escape does (nothing when not given).
  function openDialog(html, opts){
    opts = opts || {};
    addStyles();
    var prev = document.activeElement;
    var ov = document.createElement('div');
    ov.className = 'agv-overlay';
    ov.innerHTML = '<div class="agv-dialog' + (opts.wide ? ' is-wide' : '') + '" role="dialog" aria-modal="true" aria-labelledby="' + opts.labelId + '"' + (opts.describedBy ? ' aria-describedby="' + opts.describedBy + '"' : '') + ' tabindex="-1">' + html + '</div>';
    if(opts.id) ov.id = opts.id;
    document.body.appendChild(ov);
    document.documentElement.classList.add('agv-open');
    var dlg = ov.firstChild;
    function focusables(){
      return Array.prototype.slice.call(dlg.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter(function(el){ return el.offsetParent !== null || el === document.activeElement; });
    }
    function onKey(e){
      if(e.key === 'Escape'){ if(typeof opts.onEscape === 'function'){ e.preventDefault(); e.stopPropagation(); opts.onEscape(); } return; }
      if(e.key !== 'Tab') return;
      var f = focusables(); if(!f.length){ e.preventDefault(); dlg.focus(); return; }
      var first = f[0], last = f[f.length - 1];
      if(e.shiftKey && (document.activeElement === first || document.activeElement === dlg)){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    function close(){
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      if(!document.querySelector('.agv-overlay')) document.documentElement.classList.remove('agv-open');
      try{ if(prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus(); }catch(e){}
    }
    setTimeout(function(){
      var want = opts.focus ? dlg.querySelector(opts.focus) : null;
      try{ (want || focusables()[0] || dlg).focus(); }catch(e){}
    }, 30);
    return { el: dlg, overlay: ov, close: close };
  }

  // ------------------------------------------------------------ 1. Complete your profile
  var NAME_OK = /^[\p{L}\p{M} .'’-]+$/u;
  function nameProblem(v, label){
    if(!v) return 'Please enter your ' + label + '.';
    if(Array.from(v).length > 50) return 'Your ' + label + ' can be at most 50 characters.';
    if(/\d/.test(v)) return 'Your ' + label + ' cannot contain numbers — please write it as on your government ID.';
    if(!NAME_OK.test(v)) return 'Your ' + label + ' can only have letters, spaces, dots, apostrophes and hyphens.';
    return '';
  }
  var lastPrompt = null;          // the newest profilePrompt the server sent
  var promptOpen = false;
  function openProfilePrompt(pp, opts){
    opts = opts || {};
    if(promptOpen || !pp || !pp.needed) { if(typeof opts.then === 'function') opts.then(false); return false; }
    promptOpen = true;
    var askName = pp.missing.indexOf('firstName') !== -1 || pp.missing.indexOf('lastName') !== -1;
    var askPhone = pp.missing.indexOf('phone') !== -1;
    var d = openDialog(
      '<p class="agv-eyebrow">' + (opts.required ? 'Before you submit' : 'Welcome to Aerva') + '</p>'
      + '<h2 id="agvPpTitle">Complete your profile</h2>'
      + '<p class="agv-lead" id="agvPpLead">' + (opts.lead ? esc(opts.lead) : askName && askPhone ? 'Your name and mobile number, so your host knows who is coming and can reach you about your stay.'
          : askName ? 'Your first and last name, as on your government ID — your host checks it at check-in.'
          : 'Your mobile number, so your host can reach you about your stay.') + '</p>'
      + '<form novalidate>'
      + (askName ? '<div class="agv-two">'
          + '<label class="agv-field"><span>First name</span><input name="first" maxlength="50" autocomplete="given-name" autocapitalize="words" spellcheck="false" value="' + esc(pp.firstName || '') + '" placeholder="As on your ID"></label>'
          + '<label class="agv-field"><span>Last name</span><input name="last" maxlength="50" autocomplete="family-name" autocapitalize="words" spellcheck="false" value="' + esc(pp.lastName || '') + '" placeholder="As on your ID"></label>'
          + '</div>' : '')
      + (askPhone ? '<label class="agv-field"><span>Mobile number</span><input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="10-digit mobile number"></label>' : '')
      + '<div class="agv-actions"><button type="submit" class="agv-btn">Save and continue</button><button type="button" class="agv-btn is-quiet" data-agv-later>' + (opts.required ? 'Back to the form' : 'Do it later') + '</button></div>'
      + '<p class="agv-msg" role="alert" aria-live="assertive"></p>'
      + '</form>',
      { id: 'agvProfilePrompt', labelId: 'agvPpTitle', describedBy: 'agvPpLead', onEscape: function(){ later(); },
        focus: askName ? (pp.firstName ? (pp.lastName ? 'input[name=first]' : 'input[name=last]') : 'input[name=first]') : 'input[name=phone]' });
    var form = d.el.querySelector('form'), msg = d.el.querySelector('.agv-msg'), btn = d.el.querySelector('button[type=submit]');
    function finish(done){
      promptOpen = false; d.close();
      if(done && typeof window.aervaRefreshIdentity === 'function'){ try{ window.aervaRefreshIdentity(); }catch(e){} }
      if(typeof opts.then === 'function') opts.then(!!done);
    }
    function later(){ finish(false); }
    d.el.querySelector('[data-agv-later]').addEventListener('click', later);
    form.addEventListener('submit', async function(e){
      e.preventDefault();
      if(btn.disabled) return;
      var fe = form.elements;
      var bad = function(t, el){ msg.className = 'agv-msg is-error'; msg.textContent = t; if(el) el.focus(); };
      var first = askName ? fe['first'].value.replace(/\s+/g, ' ').trim() : '', last = askName ? fe['last'].value.replace(/\s+/g, ' ').trim() : '';
      var phone = askPhone ? fe['phone'].value.trim() : '';
      if(askName){
        var p1 = nameProblem(first, 'first name'); if(p1) return bad(p1, fe['first']);
        var p2 = nameProblem(last, 'last name'); if(p2) return bad(p2, fe['last']);
      }
      if(askPhone && phone.replace(/\D/g, '').length < 8) return bad('Please enter a valid mobile number, with the country code if you are outside India.', fe['phone']);
      btn.disabled = true; btn.textContent = 'Saving…'; msg.className = 'agv-msg'; msg.textContent = '';
      try{
        if(askName){
          var n = await call('POST', { mode: 'saveName', firstName: first, lastName: last });
          askName = false;                         // saved: a phone error must not ask for it again
          var grid = form.querySelector('.agv-two'); if(grid) grid.remove();
          try{ if(n && n.name) localStorage.setItem('aerva_guest_name', n.name); }catch(e2){}
          if(lastPrompt){ lastPrompt.firstName = first; lastPrompt.lastName = last; lastPrompt.missing = lastPrompt.missing.filter(function(m){ return m !== 'firstName' && m !== 'lastName'; }); }
        }
        if(askPhone){
          await call('POST', { mode: 'savePhone', phone: phone });
          if(lastPrompt) lastPrompt.missing = lastPrompt.missing.filter(function(m){ return m !== 'phone'; });
        }
        if(lastPrompt) lastPrompt.needed = lastPrompt.missing.length > 0;
        finish(true);
      }catch(err){
        btn.disabled = false; btn.textContent = 'Save and continue';
        bad(err.message || 'Could not save. Please try again.', askPhone && !askName ? fe['phone'] : null);
      }
    });
    return true;
  }
  // After the session check: at a new sign-in, the pop-up comes first.
  function sessionSeen(guest, tok, freshSignIn){
    lastPrompt = guest && guest.profilePrompt ? JSON.parse(JSON.stringify(guest.profilePrompt)) : null;
    if(!lastPrompt || !lastPrompt.needed) return false;
    var mark = String(tok || '').slice(-24);
    var seen = store('aerva_profile_prompt_seen') === mark;
    if(!freshSignIn && seen) return false;
    store('aerva_profile_prompt_seen', mark);
    return openProfilePrompt(lastPrompt);
  }
  // reason 'booking': every time a booking is started, until done.
  // reason 'login': once per sign-in (for pages that do their own session check).
  async function promptIfNeeded(opts){
    opts = opts || {};
    var then = typeof opts.then === 'function' ? opts.then : function(){};
    var tok = token();
    if(!tok){ then(false); return; }
    try{
      if(!lastPrompt || opts.fresh){
        var r = await fetch(API() + 'guest-auth', { headers: { 'Authorization': 'Bearer ' + tok } });
        var d = r.ok ? await r.json() : null;
        lastPrompt = d && d.guest && d.guest.profilePrompt ? d.guest.profilePrompt : null;
      }
      if(!lastPrompt || !lastPrompt.needed){ then(false); return; }
      if(opts.reason === 'login'){
        var mark = String(tok).slice(-24);
        if(store('aerva_profile_prompt_seen') === mark){ then(false); return; }
        store('aerva_profile_prompt_seen', mark);
      }
      if(!openProfilePrompt(lastPrompt, { then: then })) return;
    }catch(e){ then(false); }
  }

  // ------------------------------------------------------------ 2. the three steps
  function shrink(file){
    return new Promise(function(resolve, reject){
      if(file.type === 'application/pdf' || /\.pdf$/i.test(file.name)){
        if(file.size > 4 * 1024 * 1024) return reject(new Error('That PDF is too large. Use a photo of the ID instead.'));
        var fr = new FileReader();
        fr.onload = function(){ resolve({ type: 'application/pdf', data: String(fr.result).split(',')[1] }); };
        fr.onerror = function(){ reject(new Error('That file could not be read.')); };
        return fr.readAsDataURL(file);
      }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function(){
        var max = 2000, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.round(w * k); c.height = Math.round(h * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        var data = c.toDataURL('image/jpeg', 0.88);
        c.width = c.height = 0;
        resolve({ type: 'image/jpeg', data: data.split(',')[1] });
      };
      img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error('That photo could not be opened. Use a JPG or PNG photo, or a PDF.')); };
      img.src = url;
    });
  }
  async function uploadForReview(file){
    if(file.size > 8 * 1024 * 1024) throw new Error('That file is larger than 8 MB. Use a smaller photo.');
    var mod = await import('https://esm.sh/@vercel/blob/client');
    var r = await mod.upload('guest-id-' + Date.now() + (/\.pdf$/i.test(file.name) ? '.pdf' : '.jpg'), file, { access: 'public', handleUploadUrl: API() + 'blob-upload',
      clientPayload: JSON.stringify({ purpose: 'guest-id', token: token() || '' }) });
    return r.url;
  }

  // el: where it goes. opts.onConfirmed(list): a waiting payment became a
  // booking. opts.onChange(status): after every step. opts.focusStep: 'phone' | 'id'.
  async function mountSteps(el, opts){
    if(!el) return;
    opts = opts || {};
    addStyles();
    if(!token()){ el.innerHTML = '<p class="agv-small">Log in to verify your details.</p>'; return; }
    el.innerHTML = '<p class="agv-small">Loading…</p>';
    var st;
    try{ st = await call('GET', null, '?mode=verification'); }
    catch(e){ el.innerHTML = '<p class="agv-small">Could not load this right now. Please refresh.</p>'; return; }
    if(!st.available){ el.innerHTML = ''; if(typeof opts.onUnavailable === 'function') opts.onUnavailable(); return; }
    var ui = { codeSent: false, changePhone: false, idError: '', idCanSend: false, sentTo: '' };
    function after(d){
      if(d && d.status) st = d.status;
      render();
      if(typeof opts.onChange === 'function') opts.onChange(st);
      if(d && d.confirmed && d.confirmed.length && typeof opts.onConfirmed === 'function') opts.onConfirmed(d.confirmed, st);
    }
    async function reload(){ try{ st = await call('GET', null, '?mode=verification'); }catch(e){} render(); if(typeof opts.onChange === 'function') opts.onChange(st); }
    function step(n, state, title, body){
      return '<div class="agv-step' + (state === 'done' ? ' is-done' : state === 'wait' ? ' is-wait' : '') + '" data-agv-step="' + n + '">'
        + '<div class="agv-num" aria-hidden="true">' + (state === 'done' ? '✓' : n) + '</div>'
        + '<div class="agv-body"><p class="agv-title">' + title + (state === 'done' ? ' <span class="agv-small" style="font-weight:400;">· done</span>' : '') + '</p>' + body + '</div></div>';
    }
    function render(){
      var html = '';
      // 1. name
      html += step(1, st.name.done ? 'done' : '', 'Your first and last name', st.name.done
        ? '<p class="agv-state">' + esc(st.name.firstName + ' ' + st.name.lastName) + '</p>'
        : '<p class="agv-state">As on your government ID.</p><form data-agv-form="name" novalidate><div class="agv-row">'
          + '<input type="text" name="first" maxlength="50" autocomplete="given-name" autocapitalize="words" aria-label="First name" placeholder="First name" value="' + esc(st.name.firstName || '') + '">'
          + '<input type="text" name="last" maxlength="50" autocomplete="family-name" autocapitalize="words" aria-label="Last name" placeholder="Last name" value="' + esc(st.name.lastName || '') + '">'
          + '<button type="submit" class="agv-btn">Save</button></div><p class="agv-msg" role="alert"></p></form>');
      // 2. phone
      var phoneBody;
      if(st.phone.done) phoneBody = '<p class="agv-state">' + esc(st.phone.number) + ' · confirmed by code</p>';
      else if(!st.phone.hasNumber || ui.changePhone) phoneBody = '<p class="agv-state">' + (ui.changePhone ? 'Your new mobile number.' : 'Your mobile number — your host uses it to reach you about your stay.') + '</p>'
        + '<form data-agv-form="phone" novalidate><div class="agv-row"><input type="tel" name="phone" inputmode="tel" autocomplete="tel" maxlength="20" aria-label="Mobile number" placeholder="10-digit mobile number">'
        + '<button type="submit" class="agv-btn">Save</button></div>' + (ui.changePhone ? '<button type="button" class="agv-link" data-agv-keep>Keep ' + esc(st.phone.number) + '</button>' : '') + '<p class="agv-msg" role="alert"></p></form>';
      else if(!ui.codeSent) phoneBody = '<p class="agv-state">' + esc(st.phone.number) + ' — we text you a code to confirm it is yours.</p>'
        + '<div class="agv-row"><button type="button" class="agv-btn" data-agv-send' + (st.smsAvailable ? '' : ' disabled') + '>Text me a code</button><button type="button" class="agv-link" data-agv-change>Change number</button></div>'
        + '<p class="agv-msg' + (st.smsAvailable ? '' : ' is-error') + '" role="alert">' + (st.smsAvailable ? '' : 'Text-message codes are not available right now. Please try again later.') + '</p>';
      else phoneBody = '<p class="agv-state">We texted a code to ' + esc(ui.sentTo || st.phone.number) + '.</p>'
        + '<form data-agv-form="code" novalidate><div class="agv-row"><input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" aria-label="The code we texted you" placeholder="Enter the code">'
        + '<button type="submit" class="agv-btn">Confirm</button></div><button type="button" class="agv-link" data-agv-send>Send it again</button><p class="agv-msg" role="alert"></p></form>';
      html += step(2, st.phone.done ? 'done' : '', 'Your phone number, confirmed with a code', phoneBody);
      // 3. ID
      var idBody;
      if(st.id.done) idBody = '<p class="agv-state">' + esc(st.id.label) + (st.id.last4 ? ' ending ' + esc(st.id.last4) : '') + ' · verified. The image was not kept.</p>';
      else if(st.id.withAerva) idBody = '<p class="agv-state">Sent to Aerva — we are checking it and will email you as soon as it is done. The image is deleted once it is checked.</p>';
      else idBody = '<p class="agv-state">A photo of ONE of: Aadhaar, passport, driving licence or voter ID. Checked in a few seconds; the image is not kept.</p>'
        + (st.id.rejectedReason && !ui.idError ? '<p class="agv-msg is-error" style="margin-top:6px;">Aerva could not accept the ID you sent: ' + esc(st.id.rejectedReason) + ' You can try again.</p>' : '')
        + (!st.name.done ? '<p class="agv-small">Add your name first — the ID is checked against it.</p>' : '')
        + '<form data-agv-form="id" novalidate><input class="agv-file" type="file" name="file" accept="image/*,.pdf" aria-label="Photo of your ID"' + (st.name.done ? '' : ' disabled') + '>'
        + '<div class="agv-row"><button type="submit" class="agv-btn"' + (st.name.done && st.id.attemptsLeft > 0 ? '' : ' disabled') + '>Check my ID</button>'
        + '<button type="button" class="agv-link" data-agv-review' + (st.name.done ? '' : ' disabled') + '>Send it to Aerva to check instead</button></div>'
        + '<p class="agv-msg' + (ui.idError ? ' is-error' : '') + '" role="alert">' + esc(ui.idError || (st.id.attemptsLeft > 0 ? '' : 'No more tries today. Send it to Aerva to check instead, or try again tomorrow.')) + '</p></form>';
      html += step(3, st.id.done ? 'done' : st.id.withAerva ? 'wait' : '', 'A government photo ID', idBody);
      el.innerHTML = '<div class="agv">' + html + '</div>';
      wire();
    }
    function say(form, text, ok){ var m = form.querySelector('.agv-msg'); if(m){ m.className = 'agv-msg ' + (ok ? 'is-ok' : 'is-error'); m.textContent = text; } }
    function busy(btn, label){ btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = label; }
    function idle(btn){ btn.disabled = false; if(btn.dataset.label) btn.textContent = btn.dataset.label; }
    function wire(){
      var nameForm = el.querySelector('[data-agv-form="name"]');
      if(nameForm) nameForm.addEventListener('submit', async function(e){
        e.preventDefault();
        var f = nameForm.elements['first'].value.replace(/\s+/g, ' ').trim(), l = nameForm.elements['last'].value.replace(/\s+/g, ' ').trim();
        var bad = nameProblem(f, 'first name') || nameProblem(l, 'last name');
        if(bad) return say(nameForm, bad);
        var b = nameForm.querySelector('button[type=submit]'); busy(b, 'Saving…');
        try{
          var d = await call('POST', { mode: 'saveName', firstName: f, lastName: l });
          try{ localStorage.setItem('aerva_guest_name', d.name); }catch(e2){}
          if(d.confirmed && d.confirmed.length){ await reload(); if(typeof opts.onConfirmed === 'function') opts.onConfirmed(d.confirmed, st); }
          else await reload();
        }catch(err){ idle(b); say(nameForm, err.message); }
      });
      var phoneForm = el.querySelector('[data-agv-form="phone"]');
      if(phoneForm) phoneForm.addEventListener('submit', async function(e){
        e.preventDefault();
        var v = phoneForm.elements['phone'].value.trim();
        if(v.replace(/\D/g, '').length < 8) return say(phoneForm, 'Please enter a valid mobile number, with the country code if you are outside India.');
        var b = phoneForm.querySelector('button[type=submit]'); busy(b, 'Saving…');
        try{ await call('POST', { mode: 'savePhone', phone: v }); ui.changePhone = false; ui.codeSent = false; await reload(); }
        catch(err){ idle(b); say(phoneForm, err.message); }
      });
      var keep = el.querySelector('[data-agv-keep]'); if(keep) keep.addEventListener('click', function(){ ui.changePhone = false; render(); });
      var change = el.querySelector('[data-agv-change]'); if(change) change.addEventListener('click', function(){ ui.changePhone = true; render(); var i = el.querySelector('[data-agv-form="phone"] input'); if(i) i.focus(); });
      Array.prototype.forEach.call(el.querySelectorAll('[data-agv-send]'), function(b){
        b.addEventListener('click', async function(){
          var holder = b.closest('.agv-body');
          busy(b, 'Sending…');
          try{
            var d = await call('POST', { mode: 'sendPhoneCode' });
            if(d.alreadyVerified){ after(d); return; }
            ui.codeSent = true; ui.sentTo = d.to || '';
            if(d.status) st = d.status;
            render();
            var i = el.querySelector('[data-agv-form="code"] input'); if(i) i.focus();
          }catch(err){ idle(b); var m = holder.querySelector('.agv-msg'); if(m){ m.className = 'agv-msg is-error'; m.textContent = err.message; } }
        });
      });
      var codeForm = el.querySelector('[data-agv-form="code"]');
      if(codeForm) codeForm.addEventListener('submit', async function(e){
        e.preventDefault();
        var v = codeForm.elements['code'].value.replace(/\D/g, '');
        if(v.length < 4) return say(codeForm, 'Please enter the code you received.');
        var b = codeForm.querySelector('button[type=submit]'); busy(b, 'Checking…');
        try{ var d = await call('POST', { mode: 'checkPhoneCode', code: v }); ui.codeSent = false; after(d); }
        catch(err){ idle(b); say(codeForm, err.message); }
      });
      var idForm = el.querySelector('[data-agv-form="id"]');
      if(idForm){
        idForm.addEventListener('submit', async function(e){
          e.preventDefault();
          var file = idForm.elements['file'].files && idForm.elements['file'].files[0];
          if(!file) return say(idForm, 'Add a photo of your ID.');
          var b = idForm.querySelector('button[type=submit]'); busy(b, 'Checking…');
          say(idForm, 'Checking your ID… this takes a few seconds.', true);
          try{
            var payload = await shrink(file);
            var d = await call('POST', { mode: 'checkGuestId', files: [payload] });
            payload = null; ui.idError = '';
            after(d);
          }catch(err){
            ui.idError = err.message || 'We could not verify this ID.';
            if(err.data && typeof err.data.attemptsLeft === 'number') st.id.attemptsLeft = err.data.attemptsLeft;
            if(err.data && err.data.withAerva){ ui.idError = ''; await reload(); return; }
            idle(b); say(idForm, ui.idError);
            if(st.id.attemptsLeft <= 0) b.disabled = true;
          }
        });
        var review = idForm.querySelector('[data-agv-review]');
        if(review) review.addEventListener('click', async function(){
          var file = idForm.elements['file'].files && idForm.elements['file'].files[0];
          if(!file) return say(idForm, 'Add a photo of your ID first, then send it to Aerva.');
          busy(review, 'Sending…');
          say(idForm, 'Sending your ID to Aerva…', true);
          try{
            var url = await uploadForReview(file);
            var d = await call('POST', { mode: 'sendGuestIdForReview', url: url });
            ui.idError = '';
            after(d);
          }catch(err){ idle(review); say(idForm, err.message || 'Could not send it right now. Please try again.'); }
        });
      }
      if(opts.focusStep){
        var target = el.querySelector('[data-agv-step="' + (opts.focusStep === 'phone' ? 2 : 3) + '"]');
        opts.focusStep = null;
        if(target){ try{ target.scrollIntoView({ block: 'center' }); var f = target.querySelector('button:not([disabled]), input:not([disabled])'); if(f) f.focus({ preventScroll: true }); }catch(e){} }
      }
    }
    render();
    if(typeof opts.onChange === 'function') opts.onChange(st);
    return { reload: reload, status: function(){ return st; } };
  }

  // ------------------------------------------------------------ 3. a payment waiting for the details
  function niceDay(d){ try{ return new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); }catch(e){ return String(d || ''); } }
  function itemsHtml(items){
    return (items || []).map(function(i){
      var when = i.departure && i.departure !== i.arrival ? niceDay(i.arrival) + ' → ' + niceDay(i.departure) : niceDay(i.arrival);
      var facts = [i.nights ? i.nights + ' night' + (Number(i.nights) === 1 ? '' : 's') : '', i.guests ? i.guests + ' guest' + (Number(i.guests) === 1 ? '' : 's') : ''].filter(Boolean).join(' · ');
      return '<p><strong>' + esc(i.name || 'Your booking') + '</strong><br>' + esc(when) + (facts ? ' · ' + esc(facts) : '') + '</p>';
    }).join('');
  }
  function leftText(msLeft){
    if(msLeft <= 0) return 'Time is up';
    var s = Math.floor(msLeft / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if(d > 0) return d + ' d ' + h + ' h left';
    if(h > 0) return h + ' h ' + m + ' min left';
    if(m >= 5) return m + ' min left';
    return m + ' min ' + String(sec).padStart(2, '0') + ' s left';
  }
  // Every [data-agv-countdown="ISO"] inside root, kept up to date. One timer.
  var countTimer = null;
  function tickCounts(){
    var els = document.querySelectorAll('[data-agv-countdown]');
    if(!els.length){ if(countTimer){ clearInterval(countTimer); countTimer = null; } return; }
    Array.prototype.forEach.call(els, function(el){
      var left = Date.parse(el.getAttribute('data-agv-countdown')) - Date.now();
      el.textContent = leftText(left);
      el.classList.toggle('is-soon', left < 3600e3);
      if(left <= 0 && !el.dataset.done){ el.dataset.done = '1'; document.dispatchEvent(new CustomEvent('aerva:verify-deadline')); }
    });
  }
  function startCounts(){ tickCounts(); if(!countTimer) countTimer = setInterval(tickCounts, 1000); }
  function deadlineHtml(v){
    return '<p class="agv-deadline">Complete these by <strong>' + esc(v.deadlineText || '') + '</strong>'
      + ' · <span class="agv-count" data-agv-countdown="' + esc(v.deadlineAt) + '" aria-live="off"></span>'
      + (v.extended ? '<br><span class="agv-small">Your ID is with Aerva: your booking keeps waiting for the answer.</span>' : '')
      + '<br><span class="agv-small">If they are not verified by then, the booking is not made and your payment is refunded in full.</span></p>';
  }

  // The screen right after paying. There is no skip: it stays until the
  // details are verified (→ "Your booking is confirmed") or until nothing
  // more can be done here (the ID is with Aerva).
  function showHeld(held, opts){
    opts = opts || {};
    var old = document.getElementById('agvHeld'); if(old) old.remove();
    var money = function(n, cur){ return (cur && cur !== 'INR' ? cur + ' ' : '₹') + Number(n).toLocaleString('en-IN'); };
    var d = openDialog(
      '<p class="agv-eyebrow">Payment received' + (held.paid != null ? ' · ' + esc(money(held.paid, held.currency)) : '') + '</p>'
      + '<h2 id="agvHeldTitle">One more step</h2>'
      + '<p class="agv-lead" id="agvHeldLead"><strong>' + esc(held.message || HELD_TEXT) + '</strong></p>'
      + '<div class="agv-held-items">' + itemsHtml(held.items) + '</div>'
      + deadlineHtml(held)
      + '<div data-agv-held-steps></div>'
      + '<div data-agv-held-foot></div>',
      { id: 'agvHeld', labelId: 'agvHeldTitle', describedBy: 'agvHeldLead', wide: true });
    var foot = d.el.querySelector('[data-agv-held-foot]');
    function confirmed(list){
      var codes = [];
      (list || []).forEach(function(c){ (c.codes || []).forEach(function(x){ codes.push(x); }); });
      var ok = (list || []).some(function(c){ return c.status === 'confirmed'; });
      d.el.innerHTML = ok
        ? '<p class="agv-eyebrow">Details verified</p><h2 id="agvHeldTitle">Your booking is confirmed</h2>'
          + '<p class="agv-lead">We have emailed you the confirmation. Show your confirmation code at check-in.</p>'
          + codes.map(function(c){ return '<div class="agv-held-items"><p><strong>' + esc(c.item || 'Your booking') + '</strong><br>Confirmation code: <strong style="letter-spacing:0.06em;">' + esc(c.code) + '</strong></p></div>'; }).join('')
          + '<div class="agv-actions"><a class="agv-btn" href="index.html?view=my-bookings">View my bookings</a><button type="button" class="agv-btn is-quiet" data-agv-close>Done</button></div>'
        : '<p class="agv-eyebrow">Details verified</p><h2 id="agvHeldTitle">We could not complete this booking</h2>'
          + '<p class="agv-lead">The dates became unavailable before your details were verified, so the booking was not made. Your payment is being refunded in full — we have emailed you the details.</p>'
          + '<div class="agv-actions"><a class="agv-btn" href="index.html?view=my-bookings">View my bookings</a><button type="button" class="agv-btn is-quiet" data-agv-close>Close</button></div>';
      d.el.querySelector('[data-agv-close]').addEventListener('click', function(){ d.close(); if(typeof opts.onClose === 'function') opts.onClose(ok); });
      try{ d.el.querySelector('.agv-btn').focus(); }catch(e){}
      if(typeof opts.onConfirmed === 'function') opts.onConfirmed(list);
    }
    mountSteps(d.el.querySelector('[data-agv-held-steps]'), {
      onConfirmed: confirmed,
      onChange: function(st){
        // Nothing more to do here while Aerva checks the ID: the guest may leave.
        var waiting = st && st.name.done && st.phone.done && st.id.withAerva;
        foot.innerHTML = waiting ? '<p class="agv-small">That is everything we need from you for now. We will email you as soon as Aerva has checked your ID.</p>'
          + '<div class="agv-actions"><a class="agv-btn" href="index.html?view=my-bookings">View my bookings</a></div>' : '';
      }
    });
    startCounts();
    return d;
  }

  // My Bookings: the card for a payment waiting (or one that lapsed).
  function heldCardHtml(b){
    addStyles();
    var v = b.waiting_details || {};
    var money = function(n, cur){ return (cur && cur !== 'INR' ? cur + ' ' : '₹') + Number(n).toLocaleString('en-IN'); };
    if(v.lapsed){
      return '<div class="agv-card" data-booking="' + esc(b.id) + '"><span class="agv-pill is-off">Not made · refunded in full</span>'
        + '<h3>' + esc(b.suite_name || 'Your booking') + '</h3><div class="agv-held-items" style="margin-top:10px;">' + itemsHtml(v.items) + '</div>'
        + '<p class="agv-state">' + esc(v.outcome || 'Your details were not submitted and verified in time.') + ' The booking was not made and your payment'
        + (v.paid != null ? ' of ' + esc(money(v.paid, v.currency)) : '') + ' ' + (v.refundPending ? 'is being refunded in full' : 'was refunded in full') + ' to your original payment method.</p>'
        + '<p class="agv-small">Verify your details in <a href="index.html?view=profile" style="color:#7c6030;">your profile</a> and your next booking is confirmed at once.</p></div>';
    }
    return '<div class="agv-card" data-booking="' + esc(b.id) + '" data-agv-held-card><span class="agv-pill">Waiting for your details</span>'
      + '<h3>' + esc(b.suite_name || 'Your booking') + '</h3>'
      + '<p class="agv-state" style="margin:4px 0 10px;"><strong>' + esc(v.message || HELD_TEXT) + '</strong>' + (v.paid != null ? ' Paid: ' + esc(money(v.paid, v.currency)) + '.' : '') + '</p>'
      + '<div class="agv-held-items">' + itemsHtml(v.items) + '</div>'
      + deadlineHtml(v)
      + '<div data-agv-card-steps></div></div>';
  }
  function wireCards(container, opts){
    opts = opts || {};
    if(!container) return;
    var cards = container.querySelectorAll('[data-agv-held-card]');
    Array.prototype.forEach.call(cards, function(card, i){
      var box = card.querySelector('[data-agv-card-steps]');
      if(!box || box.dataset.mounted) return;
      box.dataset.mounted = '1';
      // The steps are the account's, the same for every card: shown once.
      if(i > 0){ box.innerHTML = '<p class="agv-small">Complete the steps above — they confirm this booking too.</p>'; return; }
      mountSteps(box, { focusStep: opts.focusStep, onConfirmed: function(list){ if(typeof opts.onConfirmed === 'function') opts.onConfirmed(list); } });
    });
    startCounts();
  }

  window.AervaGuestVerify = {
    sessionSeen: sessionSeen, promptIfNeeded: promptIfNeeded, openProfilePrompt: openProfilePrompt,
    // is the pop-up still needed, as far as the last session check knows?
    pending: function(){ return !!(lastPrompt && lastPrompt.needed); },
    mountSteps: mountSteps, showHeld: showHeld, heldCardHtml: heldCardHtml, wireCards: wireCards, HELD_TEXT: HELD_TEXT
  };
})();
