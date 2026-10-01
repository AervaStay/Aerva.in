// aerva-help.js — the Resolution Center (index.html?view=help).
//
// Everyone can read the help topics, the contact options and what each
// badge means. Raising and following a request needs an Aerva account.
//
//   ?view=help                          the Resolution Center home
//   ?view=help&topic=<id>               one help topic
//   ?view=help&new=1[&category=<key>][&order=<id>][&listing=<id>]
//                                       raise a request (signed in)
//   ?view=help&mine=1                   My requests
//   ?view=help&request=SR-12345678      one request and its conversation
//
// The words (topics, badges, contact numbers, commitments) live in
// aerva-policies.js under AERVA_POLICIES.support. The requests themselves
// are served by api/guest-profile.js (modes support*), backed by
// api/_support.js.
//
// aerva.js calls AervaHelp.show() for ?view=help after hiding the other
// views. Moving between pages of the Resolution Center does not reload the
// page (history.pushState), so the back button works as expected.
(function(){
  'use strict';

  var API = 'https://aerva-in.vercel.app';
  var MAX_FILES = 5, MAX_FILE_BYTES = 8 * 1024 * 1024;
  var SUBJECT_MAX = 120, BODY_MIN = 20, BODY_MAX = 4000;
  var FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

  var root = null;
  var options = null;          // supportOptions, once per page load
  var popWired = false;

  // ------------------------------------------------------------------ helpers
  function token(){ try{ return localStorage.getItem('aerva_guest_session'); }catch(e){ return null; } }
  function esc(t){
    return String(t == null ? '' : t).replace(/[&<>"']/g, function(c){
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function S(){ return (window.AERVA_POLICIES && window.AERVA_POLICIES.support) || {}; }
  function params(){ return new URLSearchParams(window.location.search); }
  function helpUrl(qs){ return 'index.html?view=help' + (qs ? '&' + qs : ''); }
  function policyUrl(id){
    if(id === 'terms') return 'index.html?view=terms';
    if(id === 'privacy') return 'index.html?view=privacy';
    return 'index.html?view=policies&doc=' + encodeURIComponent(id);
  }
  function policyTitle(id){
    if(id === 'terms') return 'Terms of Service';
    if(id === 'privacy') return 'Privacy Policy';
    var d = ((window.AERVA_POLICIES || {}).documents || []).filter(function(x){ return x.id === id; })[0];
    return d ? d.title : null;
  }
  function topicFor(category){
    return (S().topics || []).filter(function(t){ return t.category === category; })[0] || null;
  }
  function categoryLabel(key){
    var c = (S().categories || []).filter(function(x){ return x.key === key; })[0];
    return c ? c.label : key;
  }
  function fmtDate(v){
    if(!v) return '';
    var d = new Date(v);
    if(isNaN(d)) return '';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtDateTime(v){
    if(!v) return '';
    var d = new Date(v);
    if(isNaN(d)) return '';
    return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function dayOnly(v){
    // Booking dates are calendar dates: show them as written, never shifted by time zone.
    var s = String(v || '').slice(0, 10);
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if(!m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  function fileName(url){
    try{
      var last = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file');
      // Vercel adds "-<random>" before the extension; keep it readable.
      return last.replace(/-[A-Za-z0-9]{20,}(\.[a-z0-9]+)$/i, '$1');
    }catch(e){ return 'file'; }
  }
  function isImage(url){ return /\.(jpe?g|png|webp)$/i.test(String(url).split('?')[0]); }
  function phoneDigits(v){ return String(v || '').replace(/[^\d+]/g, ''); }
  function whatsappLink(v){
    var d = String(v || '').replace(/\D/g, '');
    if(d.length === 10) d = '91' + d;    // an Indian mobile written without +91
    return 'https://wa.me/' + d;
  }

  async function api(method, query, body){
    var headers = { 'Authorization': 'Bearer ' + (token() || '') };
    if(body) headers['Content-Type'] = 'application/json';
    var res = await fetch(API + '/api/guest-profile' + (query ? '?' + query : ''), {
      method: method, headers: headers, body: body ? JSON.stringify(body) : undefined
    });
    var data = {};
    try{ data = await res.json(); }catch(e){ data = {}; }
    if(!res.ok){
      var err = new Error(data.error || 'Something went wrong. Please try again, or email ' + (S().contacts || {}).email + '.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function uploadFiles(files){
    var mod = await import('https://esm.sh/@vercel/blob/client');
    var out = [];
    for(var i = 0; i < files.length; i++){
      var f = files[i];
      var r = await mod.upload(f.name, f, {
        access: 'public', handleUploadUrl: API + '/api/blob-upload',
        clientPayload: JSON.stringify({ purpose: 'support-evidence', token: token() || '' })
      });
      out.push(r.url);
    }
    return out;
  }

  // Moving within the Resolution Center: no reload.
  function go(qs, replace){
    var url = helpUrl(qs);
    try{ history[replace ? 'replaceState' : 'pushState']({ aervaHelp: true }, '', url); }
    catch(e){ window.location.href = url; return; }
    render();
    window.scrollTo(0, 0);
  }

  // Any link inside the view marked data-help="qs" moves without a reload.
  function wireLinks(scope){
    scope.querySelectorAll('a[data-help]').forEach(function(a){
      a.addEventListener('click', function(e){
        if(e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;   // new tab: let it be
        e.preventDefault();
        go(a.getAttribute('data-help'));
      });
    });
  }
  function hlink(qs, label, cls){
    return '<a href="' + esc(helpUrl(qs)) + '" data-help="' + esc(qs) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + label + '</a>';
  }

  function statusChip(status, label){
    return '<span class="hc-status hc-status-' + esc(status) + '">' + esc(label || status) + '</span>';
  }

  // -------------------------------------------------------------- page frame
  function frame(active, inner){
    var signedIn = !!token();
    var tabs = [
      ['', 'Help topics', 'home'],
      ['new=1', 'Raise a request', 'new'],
      ['mine=1', 'My requests', 'mine']
    ];
    return '<nav class="hc-tabs" aria-label="Resolution Center">' + tabs.map(function(t){
      return '<a href="' + esc(helpUrl(t[0])) + '" data-help="' + esc(t[0]) + '"' + (active === t[2] ? ' aria-current="page"' : '') + '>' + esc(t[1]) + '</a>';
    }).join('') + (signedIn ? '' : '<a href="' + esc(loginUrl()) + '" class="hc-tabs-login">Log in</a>') + '</nav>' + inner;
  }
  function loginUrl(){ return 'guest-login.html?next=' + encodeURIComponent(window.location.href); }

  function emergencyBar(){
    var s = S();
    return s.emergency ? '<p class="hc-emergency" role="note"><strong>Emergency?</strong> ' + esc(s.emergency) + '</p>' : '';
  }

  // The ways to reach support. A blank number hides that option.
  function contactBlock(){
    var c = S().contacts || {};
    var cards = [];
    cards.push('<div class="hc-contact hc-contact-primary">'
      + '<h3>Raise a request</h3>'
      + '<p>Tracked from start to finish, with a reference number. Best for anything about a booking, a stay or a payout.</p>'
      + hlink('new=1', 'Raise a request', 'btn solid') + '</div>');
    if(c.tollFree){
      cards.push('<div class="hc-contact"><h3>Call us, toll-free</h3>'
        + '<p>Speak to our support team. Have your booking or request reference ready.</p>'
        + '<a class="btn" href="tel:' + esc(phoneDigits(c.tollFree)) + '">' + esc(c.tollFree) + '</a></div>');
    }
    if(c.whatsapp){
      cards.push('<div class="hc-contact"><h3>WhatsApp</h3>'
        + '<p>Message our support team on WhatsApp. We never ask for payment there.</p>'
        + '<a class="btn" href="' + esc(whatsappLink(c.whatsapp)) + '" target="_blank" rel="noopener">Chat on WhatsApp</a></div>');
    }
    if(c.email){
      cards.push('<div class="hc-contact"><h3>Email</h3>'
        + '<p>Write to us any time. Include your booking ID or request reference.</p>'
        + '<a class="btn" href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a></div>');
    }
    return '<div class="hc-contacts">' + cards.join('') + '</div>'
      + (c.hours ? '<p class="hc-hours">Phone and WhatsApp: ' + esc(c.hours) + '</p>' : '');
  }

  // ------------------------------------------------------------------- home
  function renderHome(){
    var s = S();
    var groups = [['guest', 'For guests'], ['host', 'For hosts'], ['everyone', 'For everyone']];
    var topics = s.topics || [];
    var html = '<div class="privacy-eyebrow">Aerva Support</div>'
      + '<h1 class="policies-title">Resolution Center</h1>'
      + '<p class="hc-intro">' + esc(s.intro || '') + '</p>'
      + emergencyBar()
      + contactBlock()
      + '<div id="hcMineSummary"></div>'
      + '<h2 class="hc-h2">Help topics</h2>'
      + groups.map(function(g){
          var list = topics.filter(function(t){ return t.group === g[0]; });
          if(!list.length) return '';
          return '<div class="hc-group"><h3 class="hc-group-title">' + esc(g[1]) + '</h3><div class="hc-topics">'
            + list.map(function(t){
                return '<a class="hc-topic" href="' + esc(helpUrl('topic=' + t.id)) + '" data-help="topic=' + esc(t.id) + '">'
                  + '<span class="hc-topic-title">' + esc(t.title) + '</span>'
                  + '<span class="hc-topic-summary">' + esc(t.summary || '') + '</span></a>';
              }).join('') + '</div></div>';
        }).join('')
      + '<h2 class="hc-h2">How a request works</h2>'
      + '<ol class="hc-steps">' + (s.process || []).map(function(p){
          return '<li><strong>' + esc(p.title) + '</strong><span>' + esc(p.text) + '</span></li>';
        }).join('') + '</ol>'
      + '<h2 class="hc-h2">Our commitments</h2>'
      + '<div class="hc-commitments">' + (s.commitments || []).map(function(c){
          return '<div class="hc-commitment"><strong>' + esc(c.title) + '</strong><span>' + esc(c.text) + '</span></div>';
        }).join('') + '</div>'
      + grievanceBlock()
      + '<p class="policy-note">The rules behind every answer: <a href="index.html?view=policies">Aerva Policies</a> · <a href="index.html?view=terms">Terms of Service</a> · <a href="index.html?view=privacy">Privacy</a></p>';
    root.innerHTML = frame('home', html);
    wireLinks(root);
    document.title = 'Resolution Center — Aerva';
    if(token()) loadMineSummary();
  }

  function grievanceBlock(){
    var g = S().grievanceOfficer || {};
    if(!g.email && !g.name) return '';
    return '<div class="hc-grievance"><h2 class="hc-h2">Grievance Officer</h2>'
      + '<p>For a formal complaint under the Consumer Protection (E-Commerce) Rules, 2020, raise a request and choose “Formal grievance”, or write to the Grievance Officer. You receive a reference number at once; your complaint is acknowledged within 48 hours and resolved within one month of receipt.</p>'
      + '<dl>'
      + (g.name ? '<dt>Name</dt><dd>' + esc(g.name) + '</dd>' : '')
      + '<dt>Designation</dt><dd>' + esc(g.designation || 'Grievance Officer') + '</dd>'
      + (g.email ? '<dt>Email</dt><dd><a href="mailto:' + esc(g.email) + '">' + esc(g.email) + '</a></dd>' : '')
      + '</dl></div>';
  }

  async function loadMineSummary(){
    var box = document.getElementById('hcMineSummary');
    if(!box) return;
    try{
      var data = await api('GET', 'mode=supportRequests');
      var list = data.requests || [];
      if(!list.length) return;
      var open = list.filter(function(r){ return r.status !== 'resolved' && r.status !== 'closed'; }).length;
      var unread = list.filter(function(r){ return r.unread; }).length;
      box.innerHTML = '<div class="hc-mine-summary"><div><strong>My requests</strong><span>'
        + esc(open + ' open') + (unread ? ' · <b class="hc-unread-text">' + esc(unread + ' new ' + (unread === 1 ? 'reply' : 'replies')) + '</b>' : '')
        + '</span></div>' + hlink('mine=1', 'View my requests', 'btn') + '</div>';
      wireLinks(box);
    }catch(e){ /* the summary is a convenience; the rest of the page stands */ }
  }

  // ------------------------------------------------------------------ topic
  function renderTopic(id){
    var t = (S().topics || []).filter(function(x){ return x.id === id; })[0];
    if(!t){ go('', true); return; }
    var groupLabel = { guest: 'For guests', host: 'For hosts', everyone: 'For everyone' }[t.group] || 'Help';
    var docs = (t.docs || []).map(function(d){ var title = policyTitle(d); return title ? '<li><a href="' + esc(policyUrl(d)) + '">' + esc(title) + '</a></li>' : ''; }).join('');
    var html = '<p class="policy-back">' + hlink('', '‹ Resolution Center') + '</p>'
      + '<div class="privacy-eyebrow">' + esc(groupLabel) + '</div>'
      + '<h1 class="policies-title">' + esc(t.title) + '</h1>'
      + '<p class="hc-intro">' + esc(t.summary || '') + '</p>'
      + (t.id === 'safety' || t.id === 'stay-problem' || t.id === 'guest-conduct' ? emergencyBar() : '')
      + (t.sections || []).map(function(sec){
          return '<div class="policy-section"><h2>' + esc(sec.title) + '</h2><ul>'
            + sec.points.map(function(p){ return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></div>';
        }).join('')
      + (t.badges ? badgesBlock() : '')
      + (docs ? '<div class="policy-section"><h2>Related policies</h2><ul class="hc-doclinks">' + docs + '</ul></div>' : '')
      + '<div class="hc-cta"><div><h3>Still need help?</h3><p>Raise a request and our support team will reply within 48 hours.</p></div>'
      + hlink('new=1&category=' + encodeURIComponent(t.category), 'Raise a request', 'btn solid') + '</div>';
    root.innerHTML = frame('home', html);
    wireLinks(root);
    document.title = t.title + ' — Aerva Resolution Center';
  }

  function badgesBlock(){
    return (S().badges || []).map(function(g){
      return '<div class="policy-section hc-badges"><h2>' + esc(g.group) + '</h2>'
        + (g.intro ? '<p class="hc-badges-intro">' + esc(g.intro) + '</p>' : '')
        + '<dl>' + g.items.map(function(b){ return '<div class="hc-badge-row"><dt>' + esc(b.name) + '</dt><dd>' + esc(b.text) + '</dd></div>'; }).join('') + '</dl></div>';
    }).join('');
  }

  // ------------------------------------------------------- raise a request
  function signInPanel(what){
    var c = S().contacts || {};
    return '<div class="hc-signin"><h2>Log in to ' + esc(what) + '</h2>'
      + '<p>Requests are tied to your Aerva account, so we can see your bookings and keep you updated. It also keeps your details private.</p>'
      + '<a class="btn solid" href="' + esc(loginUrl()) + '">Log in or create an account</a>'
      + (c.email ? '<p class="hc-muted">Cannot sign in? Write to <a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a> from the email address on your account.</p>' : '')
      + '</div>';
  }

  async function renderNew(){
    var q = params();
    var head = '<p class="policy-back">' + hlink('', '‹ Resolution Center') + '</p>'
      + '<h1 class="policies-title">Raise a request</h1>'
      + '<p class="hc-intro">Tell us what happened. You will receive a reference number straight away, and a reply from our support team within 48 hours.</p>'
      + emergencyBar();
    document.title = 'Raise a request — Aerva Resolution Center';
    if(!token()){ root.innerHTML = frame('new', head + signInPanel('raise a request')); wireLinks(root); return; }
    root.innerHTML = frame('new', head + '<p class="hc-muted">Loading your bookings…</p>');
    wireLinks(root);
    try{
      if(!options) options = await api('GET', 'mode=supportOptions');
    }catch(e){
      if(e.status === 401){ root.innerHTML = frame('new', head + signInPanel('raise a request')); wireLinks(root); return; }
      root.innerHTML = frame('new', head + '<p class="hc-error">' + esc(e.message) + '</p>');
      wireLinks(root); return;
    }
    var o = options;
    var cats = S().categories || [];
    var want = q.get('category') || '';
    var opt = function(c){ return '<option value="' + esc(c.key) + '"' + (c.key === want ? ' selected' : '') + '>' + esc(c.label) + '</option>'; };
    var catSelect = '<option value="">Choose…</option>'
      + '<optgroup label="Bookings and stays">' + cats.filter(function(c){ return c.audience === 'guest'; }).map(opt).join('') + '</optgroup>'
      + (o.isHost ? '<optgroup label="Hosting">' + cats.filter(function(c){ return c.audience === 'host'; }).map(opt).join('') + '</optgroup>' : '')
      + '<optgroup label="Everyone">' + cats.filter(function(c){ return c.audience === 'both'; }).map(opt).join('') + '</optgroup>';
    var wantOrder = String(q.get('order') || '');
    var bLabel = function(b){
      return esc(b.name || 'Booking') + ' · ' + esc(dayOnly(b.arrival)) + (b.departure ? ' – ' + esc(dayOnly(b.departure)) : '')
        + (b.code ? ' · ' + esc(b.code) : ' · #' + esc(b.id)) + (b.status && b.status !== 'paid' ? ' (' + esc(b.status) + ')' : '');
    };
    var bOpt = function(b){ return '<option value="' + esc(b.id) + '"' + (String(b.id) === wantOrder ? ' selected' : '') + '>' + bLabel(b) + '</option>'; };
    var bookings = (o.bookings || []), hostBookings = (o.hostBookings || []);
    var bookingSelect = '<option value="">Not about a booking</option>'
      + (bookings.length ? '<optgroup label="My trips">' + bookings.map(bOpt).join('') + '</optgroup>' : '')
      + (hostBookings.length ? '<optgroup label="Bookings at my listings">' + hostBookings.map(bOpt).join('') + '</optgroup>' : '');
    var wantListing = String(q.get('listing') || '');
    var listings = o.listings || [];
    var listingField = (o.isHost && listings.length)
      ? '<div class="hc-field"><label for="hcListing">Which listing? <span class="label-hint">(optional)</span></label>'
        + '<select id="hcListing"><option value="">Not about a listing</option>'
        + listings.map(function(l){ return '<option value="' + esc(l.id) + '"' + (String(l.id) === wantListing ? ' selected' : '') + '>' + esc(l.name || ('Listing #' + l.id)) + '</option>'; }).join('')
        + '</select></div>' : '';

    var form = '<form class="hc-form" id="hcForm" novalidate>'
      + '<div class="hc-field"><label for="hcCategory">What is it about?</label><select id="hcCategory" required>' + catSelect + '</select>'
      + '<p class="hc-hint" id="hcTopicHint"></p></div>'
      + '<div class="hc-field"><label for="hcOrder">Which booking? <span class="label-hint">(choose one if it is about a booking)</span></label><select id="hcOrder">' + bookingSelect + '</select></div>'
      + listingField
      + '<div class="hc-field"><label for="hcSubject">Title</label><input type="text" id="hcSubject" maxlength="' + SUBJECT_MAX + '" placeholder="For example: No hot water since check-in" autocomplete="off"></div>'
      + '<div class="hc-field"><label for="hcBody">What happened?</label>'
      + '<textarea id="hcBody" rows="8" maxlength="' + BODY_MAX + '" placeholder="What happened, when, what you have tried, and what you would like to happen."></textarea>'
      + '<p class="hc-hint"><span id="hcCount">0</span> / ' + BODY_MAX + '</p></div>'
      + filePicker('hcFiles')
      + '<label class="hc-check"><input type="checkbox" id="hcCallback"' + (o.hasPhone ? '' : ' disabled') + '>'
      + '<span>Please call me back on the phone number on my account' + (o.hasPhone ? '' : ' <em>(add a phone number in Account Settings first)</em>') + '</span></label>'
      + '<p class="hc-error" id="hcError" role="alert" hidden></p>'
      + '<div class="hc-actions"><button type="submit" class="btn solid" id="hcSubmit">Send request</button>'
      + (o.email ? '<span class="hc-muted">We will email ' + esc(o.email) + ' with your reference number.</span>' : '') + '</div>'
      + '</form>';
    var aside = '<aside class="hc-tips"><h3>For a quick answer</h3><ul>' + (S().tips || []).map(function(t){ return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></aside>';
    root.innerHTML = frame('new', head + '<div class="hc-new">' + form + aside + '</div>');
    wireLinks(root);

    var cat = document.getElementById('hcCategory');
    var hint = document.getElementById('hcTopicHint');
    var showHint = function(){
      var t = topicFor(cat.value);
      hint.innerHTML = t ? 'Before you send: ' + hlink('topic=' + t.id, esc(t.title)) + ' may already answer it.' : '';
      wireLinks(hint);
    };
    cat.addEventListener('change', showHint); showHint();
    var body = document.getElementById('hcBody'), count = document.getElementById('hcCount');
    body.addEventListener('input', function(){ count.textContent = body.value.length; });
    var picked = wireFilePicker('hcFiles');

    document.getElementById('hcForm').addEventListener('submit', async function(e){
      e.preventDefault();
      var errEl = document.getElementById('hcError');
      var btn = document.getElementById('hcSubmit');
      var fail = function(msg){ errEl.textContent = msg; errEl.hidden = false; btn.disabled = false; btn.textContent = 'Send request'; };
      errEl.hidden = true;
      var subject = document.getElementById('hcSubject').value.trim();
      var text = body.value.trim();
      if(!cat.value) return fail('Choose what your request is about.');
      if(subject.length < 4) return fail('Please give your request a short title.');
      if(text.length < BODY_MIN) return fail('Please describe what happened in a few sentences, so we can help the first time.');
      btn.disabled = true;
      var urls = [];
      try{
        if(picked.files.length){ btn.textContent = 'Uploading files…'; urls = await uploadFiles(picked.files); }
      }catch(err){ return fail('A file could not be uploaded: ' + (err && err.message ? err.message : 'please try again') + '.'); }
      btn.textContent = 'Sending…';
      var listingEl = document.getElementById('hcListing');
      try{
        var out = await api('POST', '', {
          mode: 'supportCreate', category: cat.value, subject: subject, description: text,
          orderId: document.getElementById('hcOrder').value || null,
          listingId: listingEl && listingEl.value ? listingEl.value : null,
          attachments: urls, callback: document.getElementById('hcCallback').checked
        });
        renderSent(out.ref, o.email);
      }catch(err){
        if(err.status === 401) return fail('Please log in again, then send your request.');
        fail(err.message);
      }
    });
  }

  function renderSent(ref, email){
    var html = '<div class="hc-sent">'
      + '<div class="privacy-eyebrow">Request received</div>'
      + '<h1 class="policies-title">Thank you. We are on it.</h1>'
      + '<p class="hc-ref">Your reference number <strong>' + esc(ref) + '</strong></p>'
      + '<p>' + (email ? 'A confirmation is on its way to ' + esc(email) + '. ' : '') + 'A member of our support team will reply within 48 hours, usually much sooner. We will email you whenever we reply.</p>'
      + '<div class="hc-actions">' + hlink('request=' + encodeURIComponent(ref), 'View your request', 'btn solid') + hlink('', 'Back to the Resolution Center', 'btn') + '</div>'
      + '</div>';
    try{ history.replaceState({ aervaHelp: true }, '', helpUrl('request=' + encodeURIComponent(ref))); }catch(e){}
    // Shown in place; the address already points at the request, so a refresh opens it.
    root.innerHTML = frame('new', html);
    wireLinks(root);
    window.scrollTo(0, 0);
  }

  // A file picker: images and PDFs, up to MAX_FILES, 8 MB each.
  function filePicker(id){
    return '<div class="hc-field"><label for="' + id + '">Photos or documents <span class="label-hint">(optional · up to ' + MAX_FILES + ' · JPG, PNG, WebP or PDF · 8 MB each)</span></label>'
      + '<input type="file" id="' + id + '" multiple accept="image/jpeg,image/png,image/webp,application/pdf" class="hc-file-input">'
      + '<ul class="hc-file-list" id="' + id + 'List"></ul><p class="hc-error" id="' + id + 'Err" hidden></p></div>';
  }
  function wireFilePicker(id){
    var input = document.getElementById(id), list = document.getElementById(id + 'List'), err = document.getElementById(id + 'Err');
    var state = { files: [] };
    var draw = function(){
      list.innerHTML = state.files.map(function(f, i){
        return '<li><span>' + esc(f.name) + ' <span class="hc-muted">(' + Math.max(1, Math.round(f.size / 1024)) + ' KB)</span></span>'
          + '<button type="button" data-i="' + i + '" aria-label="Remove ' + esc(f.name) + '">Remove</button></li>';
      }).join('');
      list.querySelectorAll('button').forEach(function(b){
        b.addEventListener('click', function(){ state.files.splice(Number(b.getAttribute('data-i')), 1); draw(); });
      });
    };
    input.addEventListener('change', function(){
      err.hidden = true;
      var problems = [];
      Array.prototype.forEach.call(input.files || [], function(f){
        if(FILE_TYPES.indexOf(f.type) < 0) problems.push('“' + f.name + '” is not a JPG, PNG, WebP or PDF.');
        else if(f.size > MAX_FILE_BYTES) problems.push('“' + f.name + '” is larger than 8 MB.');
        else if(state.files.length >= MAX_FILES) problems.push('Up to ' + MAX_FILES + ' files.');
        else state.files.push(f);
      });
      input.value = '';
      if(problems.length){ err.textContent = problems.filter(function(p, i, a){ return a.indexOf(p) === i; }).join(' '); err.hidden = false; }
      draw();
    });
    return state;
  }

  // ------------------------------------------------------------ my requests
  async function renderMine(){
    var head = '<p class="policy-back">' + hlink('', '‹ Resolution Center') + '</p><h1 class="policies-title">My requests</h1>';
    document.title = 'My requests — Aerva Resolution Center';
    if(!token()){ root.innerHTML = frame('mine', head + signInPanel('see your requests')); wireLinks(root); return; }
    root.innerHTML = frame('mine', head + '<p class="hc-muted">Loading…</p>');
    wireLinks(root);
    var list;
    try{ list = (await api('GET', 'mode=supportRequests')).requests || []; }
    catch(e){
      if(e.status === 401){ root.innerHTML = frame('mine', head + signInPanel('see your requests')); wireLinks(root); return; }
      root.innerHTML = frame('mine', head + '<p class="hc-error">' + esc(e.message) + '</p>'); wireLinks(root); return;
    }
    var body = !list.length
      ? '<div class="hc-empty"><p>You have not raised any requests.</p>' + hlink('new=1', 'Raise a request', 'btn solid') + '</div>'
      : '<ul class="hc-list">' + list.map(function(r){
          return '<li><a href="' + esc(helpUrl('request=' + encodeURIComponent(r.ref))) + '" data-help="request=' + esc(encodeURIComponent(r.ref)) + '" class="hc-row' + (r.unread ? ' is-unread' : '') + '">'
            + '<span class="hc-row-main"><span class="hc-row-subject">' + (r.unread ? '<span class="hc-dot" aria-label="New reply"></span>' : '') + esc(r.subject) + '</span>'
            + '<span class="hc-row-meta">' + esc(r.ref) + ' · ' + esc(r.categoryLabel) + (r.bookingName ? ' · ' + esc(r.bookingName) : r.listingName ? ' · ' + esc(r.listingName) : '') + '</span></span>'
            + '<span class="hc-row-side">' + statusChip(r.status, r.statusLabel) + '<span class="hc-row-date">Updated ' + esc(fmtDate(r.updatedAt)) + '</span></span>'
            + '</a></li>';
        }).join('') + '</ul>'
        + '<p class="hc-muted">' + hlink('new=1', 'Raise a new request') + '</p>';
    root.innerHTML = frame('mine', head + body);
    wireLinks(root);
  }

  // -------------------------------------------------------- one request
  async function renderRequest(ref){
    var head = '<p class="policy-back">' + hlink('mine=1', '‹ My requests') + '</p>';
    document.title = ref + ' — Aerva Resolution Center';
    if(!token()){ root.innerHTML = frame('mine', head + signInPanel('see this request')); wireLinks(root); return; }
    root.innerHTML = frame('mine', head + '<p class="hc-muted">Loading…</p>');
    wireLinks(root);
    var r;
    try{ r = (await api('GET', 'mode=supportRequest&ref=' + encodeURIComponent(ref))).request; }
    catch(e){
      if(e.status === 401){ root.innerHTML = frame('mine', head + signInPanel('see this request')); wireLinks(root); return; }
      root.innerHTML = frame('mine', head + '<p class="hc-error">' + esc(e.message) + '</p>'); wireLinks(root); return;
    }
    drawRequest(r);
  }

  function drawRequest(r){
    var head = '<p class="policy-back">' + hlink('mine=1', '‹ My requests') + '</p>';
    var about = r.bookingName ? 'Booking: ' + esc(r.bookingName) + (r.orderId ? ' (#' + esc(r.orderId) + ')' : '')
              : r.listingName ? 'Listing: ' + esc(r.listingName) : '';
    var thread = (r.messages || []).map(function(m){
      var who = m.from === 'you' ? 'You' : m.from;
      var cls = m.from === 'you' ? 'is-you' : m.from === 'Aerva Support' ? 'is-support' : 'is-system';
      var files = (m.files || []).map(function(u){
        return isImage(u)
          ? '<a href="' + esc(u) + '" target="_blank" rel="noopener" class="hc-thumb"><img src="' + esc(u) + '" alt="' + esc(fileName(u)) + '" loading="lazy"></a>'
          : '<a href="' + esc(u) + '" target="_blank" rel="noopener" class="hc-filelink">' + esc(fileName(u)) + '</a>';
      }).join('');
      if(cls === 'is-system') return '<li class="hc-msg is-system"><span>' + esc(m.body) + ' · ' + esc(fmtDateTime(m.at)) + '</span></li>';
      return '<li class="hc-msg ' + cls + '"><div class="hc-msg-head"><strong>' + esc(who) + '</strong><span>' + esc(fmtDateTime(m.at)) + '</span></div>'
        + '<div class="hc-msg-body">' + esc(m.body) + '</div>' + (files ? '<div class="hc-msg-files">' + files + '</div>' : '') + '</li>';
    }).join('');
    var statusNote = {
      open: 'We have your request. A member of our support team will reply within 48 hours of when you raised it.',
      in_progress: 'Our support team is looking into this.',
      waiting_on_you: 'We need something from you. Please reply below.',
      resolved: 'We have marked this resolved. If something is still not right, reply below and it opens again.',
      closed: 'This request is closed. If you need more help, raise a new request and mention ' + r.ref + '.'
    }[r.status] || '';
    var reply = r.canReply
      ? '<form class="hc-form hc-reply" id="hcReplyForm" novalidate><div class="hc-field"><label for="hcReply">Reply</label>'
        + '<textarea id="hcReply" rows="5" maxlength="' + BODY_MAX + '" placeholder="Add information, answer our question, or tell us it is sorted."></textarea></div>'
        + filePicker('hcReplyFiles')
        + '<p class="hc-error" id="hcReplyErr" role="alert" hidden></p>'
        + '<div class="hc-actions"><button type="submit" class="btn solid" id="hcReplyBtn">Send reply</button>'
        + (r.canClose ? '<button type="button" class="btn hc-close-btn" id="hcCloseBtn">Close this request</button>' : '') + '</div></form>'
      : '';
    var html = head
      + '<div class="hc-req-head"><div><div class="privacy-eyebrow">' + esc(r.ref) + ' · ' + esc(r.categoryLabel) + '</div>'
      + '<h1 class="policies-title hc-req-title">' + esc(r.subject) + '</h1>'
      + '<p class="hc-muted">' + (about ? about + ' · ' : '') + 'Raised ' + esc(fmtDate(r.createdAt)) + '</p></div>'
      + statusChip(r.status, r.statusLabel) + '</div>'
      + (statusNote ? '<p class="hc-status-note hc-status-note-' + esc(r.status) + '">' + esc(statusNote) + '</p>' : '')
      + '<ol class="hc-thread">' + thread + '</ol>'
      + reply
      + (!r.canReply ? '<div class="hc-actions">' + hlink('new=1', 'Raise a new request', 'btn solid') + '</div>' : '');
    root.innerHTML = frame('mine', html);
    wireLinks(root);
    if(!r.canReply) return;

    var picked = wireFilePicker('hcReplyFiles');
    var form = document.getElementById('hcReplyForm');
    form.addEventListener('submit', async function(e){
      e.preventDefault();
      var err = document.getElementById('hcReplyErr'), btn = document.getElementById('hcReplyBtn');
      var text = document.getElementById('hcReply').value.trim();
      var fail = function(msg){ err.textContent = msg; err.hidden = false; btn.disabled = false; btn.textContent = 'Send reply'; };
      err.hidden = true;
      if(!text && !picked.files.length) return fail('Write your reply first.');
      btn.disabled = true;
      var urls = [];
      try{ if(picked.files.length){ btn.textContent = 'Uploading files…'; urls = await uploadFiles(picked.files); } }
      catch(x){ return fail('A file could not be uploaded: ' + (x && x.message ? x.message : 'please try again') + '.'); }
      btn.textContent = 'Sending…';
      try{
        var out = await api('POST', '', { mode: 'supportReply', ref: r.ref, text: text, attachments: urls });
        drawRequest(out.request);
      }catch(x){ fail(x.message); }
    });
    var closeBtn = document.getElementById('hcCloseBtn');
    if(closeBtn) closeBtn.addEventListener('click', async function(){
      if(!window.confirm('Close this request? You will not be able to reply to it again.')) return;
      closeBtn.disabled = true;
      try{
        var out = await api('POST', '', { mode: 'supportClose', ref: r.ref });
        drawRequest(out.request);
      }catch(x){
        closeBtn.disabled = false;
        var err = document.getElementById('hcReplyErr'); err.textContent = x.message; err.hidden = false;
      }
    });
  }

  // ----------------------------------------------------------------- router
  function render(){
    if(!root) return;
    var q = params();
    if(q.get('request')) return renderRequest(q.get('request'));
    if(q.get('new')) return renderNew();
    if(q.get('mine')) return renderMine();
    if(q.get('topic')) return renderTopic(q.get('topic'));
    return renderHome();
  }

  function show(){
    var section = document.getElementById('helpView');
    root = document.getElementById('helpBody');
    if(!section || !root) return;
    section.style.display = 'block';
    document.body.classList.remove('showing-hero');
    if(!popWired){
      popWired = true;
      window.addEventListener('popstate', function(){
        if(params().get('view') === 'help' && section.style.display !== 'none'){ render(); }
      });
    }
    render();
    window.scrollTo(0, 0);
  }

  window.AervaHelp = { show: show };
})();
