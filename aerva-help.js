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
      + '<p class="policy-note">The rules behind every answer: <a href="index.html?view=policies">Aerva Policies</a> · <a href="index.html?view=terms">Terms of Service</a> · <a href="index.html?view=privacy">Privacy</a></p>';
    root.innerHTML = frame('home', html);
    wireLinks(root);
    document.title = 'Resolution Center — Aerva';
    if(token()) loadMineSummary();
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
    var bookings = (o.bookings || []), hostBookings = (o.hostBookings || []);
    var listings = (o.isHost && o.listings) || [];
    var chosen = { order: String(q.get('order') || ''), listing: String(q.get('listing') || '') };
    var ruleFor = function(key){ return cats.filter(function(c){ return c.key === key; })[0] || null; };

    var form = '<form class="hc-form" id="hcForm" novalidate>'
      + '<div class="hc-field"><label for="hcCategory">What is it about?</label><select id="hcCategory" required>' + catSelect + '</select>'
      + '<p class="hc-hint" id="hcTopicHint"></p></div>'
      + '<div id="hcLinks"></div>'
      + '<div class="hc-field"><label for="hcSubject">Title</label><input type="text" id="hcSubject" maxlength="' + SUBJECT_MAX + '" placeholder="For example: No hot water since check-in" autocomplete="off"></div>'
      + '<div class="hc-field"><label for="hcBody">What happened?</label>'
      + '<textarea id="hcBody" rows="8" maxlength="' + BODY_MAX + '" placeholder="What happened, when, what you have tried, and what you would like to happen."></textarea>'
      + '<p class="hc-hint"><span id="hcCount">0</span> / ' + BODY_MAX + '</p></div>'
      + filePicker('hcFiles')
      + '<label class="hc-check"><input type="checkbox" id="hcCallback">'
      + '<span>Please call me back</span></label>'
      + '<div class="hc-field hc-callback" id="hcCallbackField" hidden><label for="hcCallbackPhone">Phone number to call</label>'
      + '<input type="tel" id="hcCallbackPhone" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="+91 98765 43210" value="' + esc(o.phone || '') + '">'
      + '<p class="hc-hint">Our support team will call you on this number. Add the country code if it is not an Indian number.</p></div>'
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

    // Which booking or listing: follows the category. A guest topic offers
    // the person's own trips; a host topic offers bookings at their listings,
    // or their listings. A booking already names its listing, so once one is
    // chosen the listing field goes. Same rules as api/_support.js.
    var links = document.getElementById('hcLinks');
    var linkProblem = '';
    var drawLinks = function(){
      var r = ruleFor(cat.value);
      linkProblem = '';
      if(!r){ links.innerHTML = ''; return; }
      var html = '';
      var mine = r.bookingAs === 'host' ? [] : bookings;
      var theirs = r.bookingAs === 'guest' ? [] : hostBookings;
      var eligible = mine.concat(theirs);
      if(!eligible.some(function(b){ return String(b.id) === chosen.order; })) chosen.order = '';
      if(r.booking !== 'none'){
        if(eligible.length){
          var bOpt = function(b){ return '<option value="' + esc(b.id) + '"' + (String(b.id) === chosen.order ? ' selected' : '') + '>' + bLabel(b) + '</option>'; };
          html += '<div class="hc-field"><label for="hcOrder">' + (r.bookingAs === 'host' ? 'Which booking at your listing?' : 'Which booking?')
            + (r.booking === 'optional' ? ' <span class="label-hint">(optional)</span>' : '') + '</label><select id="hcOrder">'
            + '<option value="">' + (r.booking === 'required' ? 'Choose…' : 'Not about a booking') + '</option>'
            + (mine.length ? (theirs.length ? '<optgroup label="My trips">' : '') + mine.map(bOpt).join('') + (theirs.length ? '</optgroup>' : '') : '')
            + (theirs.length ? (mine.length ? '<optgroup label="Bookings at my listings">' : '') + theirs.map(bOpt).join('') + (mine.length ? '</optgroup>' : '') : '')
            + '</select></div>';
        } else if(r.booking === 'required'){
          linkProblem = r.bookingAs === 'host' ? 'There are no bookings at your listings to choose. Choose another topic, or write to us.'
                                               : 'You have no bookings to choose for this. Choose another topic, or write to us.';
          html += '<p class="hc-hint hc-link-note">' + esc(linkProblem) + '</p>';
        }
      }
      if(!listings.some(function(l){ return String(l.id) === chosen.listing; })) chosen.listing = '';
      if(r.listing !== 'none' && !chosen.order){
        if(listings.length){
          html += '<div class="hc-field"><label for="hcListing">Which listing?' + (r.listing === 'optional' ? ' <span class="label-hint">(optional)</span>' : '') + '</label>'
            + '<select id="hcListing"><option value="">' + (r.listing === 'required' ? 'Choose…' : 'Not about a listing') + '</option>'
            + listings.map(function(l){ return '<option value="' + esc(l.id) + '"' + (String(l.id) === chosen.listing ? ' selected' : '') + '>' + esc(l.name || ('Listing #' + l.id)) + '</option>'; }).join('')
            + '</select></div>';
        } else if(r.listing === 'required'){
          linkProblem = 'This is about a listing, and your account has none. Choose another topic, or write to us.';
          html += '<p class="hc-hint hc-link-note">' + esc(linkProblem) + '</p>';
        }
      }
      links.innerHTML = html;
      var orderEl = document.getElementById('hcOrder'), listingEl = document.getElementById('hcListing');
      if(orderEl) orderEl.addEventListener('change', function(){ chosen.order = orderEl.value; if(chosen.order) chosen.listing = ''; drawLinks(); });
      if(listingEl) listingEl.addEventListener('change', function(){ chosen.listing = listingEl.value; });
    };
    cat.addEventListener('change', drawLinks); drawLinks();
    var body = document.getElementById('hcBody'), count = document.getElementById('hcCount');
    body.addEventListener('input', function(){ count.textContent = body.value.length; });
    var picked = wireFilePicker('hcFiles');
    var cb = document.getElementById('hcCallback'), cbField = document.getElementById('hcCallbackField');
    cb.addEventListener('change', function(){
      cbField.hidden = !cb.checked;
      if(cb.checked){ var ph = document.getElementById('hcCallbackPhone'); if(!ph.value) ph.focus(); }
    });

    document.getElementById('hcForm').addEventListener('submit', async function(e){
      e.preventDefault();
      var errEl = document.getElementById('hcError');
      var btn = document.getElementById('hcSubmit');
      var fail = function(msg){ errEl.textContent = msg; errEl.hidden = false; btn.disabled = false; btn.textContent = 'Send request'; };
      errEl.hidden = true;
      var subject = document.getElementById('hcSubject').value.trim();
      var text = body.value.trim();
      if(!cat.value) return fail('Choose what your request is about.');
      var rule = ruleFor(cat.value) || {};
      if(linkProblem) return fail(linkProblem);
      if(rule.booking === 'required' && !chosen.order) return fail('Choose the booking this is about.');
      if(rule.listing === 'required' && !chosen.order && !chosen.listing) return fail('Choose the listing this is about.');
      var cbPhone = (document.getElementById('hcCallbackPhone').value || '').trim();
      if(cb.checked && cbPhone.replace(/\D/g, '').length < 8) return fail('Enter the phone number we should call you on.');
      if(subject.length < 4) return fail('Please give your request a short title.');
      if(text.length < BODY_MIN) return fail('Please describe what happened in a few sentences, so we can help the first time.');
      btn.disabled = true;
      var urls = [];
      try{
        if(picked.files.length){ btn.textContent = 'Uploading files…'; urls = await uploadFiles(picked.files); }
      }catch(err){ return fail('A file could not be uploaded: ' + (err && err.message ? err.message : 'please try again') + '.'); }
      btn.textContent = 'Sending…';
      try{
        var out = await api('POST', '', {
          mode: 'supportCreate', category: cat.value, subject: subject, description: text,
          orderId: (rule.booking !== 'none' && chosen.order) || null,
          listingId: (rule.listing !== 'none' && !chosen.order && chosen.listing) || null,
          attachments: urls, callback: cb.checked, callbackPhone: cb.checked ? cbPhone : undefined
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
      resolved: '',
      closed: r.autoClosed ? 'Closed automatically 48 hours after it was resolved, with no feedback. If you need more help, raise a new request and mention ' + r.ref + '.'
        : 'This request is closed. If you need more help, raise a new request and mention ' + r.ref + '.'
    }[r.status] || '';
    // Resolved: is it? Their answer closes it (with a rating), or opens it again.
    var stars = function(name){
      return '<div class="hc-stars" role="radiogroup" aria-label="Your rating">' + [5, 4, 3, 2, 1].map(function(n){
        return '<label><input type="radio" name="' + name + '" value="' + n + '"><span aria-hidden="true">★</span><span class="hc-sr">' + n + ' of 5</span></label>';
      }).join('') + '</div>';
    };
    var closesBy = r.autoCloseAt ? fmtDateTime(r.autoCloseAt) : '';
    var feedbackCard = r.askFeedback
      ? '<div class="hc-feedback" id="hcFeedback"><h2>We have marked this resolved. Is it?</h2>'
        + '<p class="hc-muted">Tell us before it closes' + (closesBy ? ' — it closes by itself on ' + esc(closesBy) + ' if we do not hear from you' : '') + '.</p>'
        + '<div class="hc-actions"><button type="button" class="btn solid" data-fb="yes">Yes, it is resolved</button><button type="button" class="btn" data-fb="no">No, something is still wrong</button></div>'
        + '<div class="hc-fb-panel" id="hcFbYes" hidden><p><strong>How did we do?</strong></p>' + stars('hcRating')
        + '<div class="hc-field"><label for="hcFbComment">Anything to add? <span class="label-hint">(optional)</span></label><textarea id="hcFbComment" rows="3" maxlength="1000"></textarea></div>'
        + '<button type="button" class="btn solid" id="hcFbConfirm">Confirm and close</button></div>'
        + '<div class="hc-fb-panel" id="hcFbNo" hidden><div class="hc-field"><label for="hcFbWhat">What is still not right?</label><textarea id="hcFbWhat" rows="4" maxlength="1000"></textarea></div>'
        + '<button type="button" class="btn solid" id="hcFbReopen">Open it again</button></div>'
        + '<p class="hc-error" id="hcFbErr" role="alert" hidden></p></div>'
      : '';
    var feedbackDone = r.status === 'closed' && r.feedback && r.feedback.resolved
      ? '<p class="hc-status-note hc-status-note-resolved">Your rating: <span class="hc-stars-static">' + '★★★★★'.slice(0, r.feedback.rating) + '<span>' + '★★★★★'.slice(r.feedback.rating) + '</span></span>'
        + (r.feedback.comment ? ' — “' + esc(r.feedback.comment) + '”' : '') + '. Thank you.</p>' : '';
    var reply = r.canReply
      ? '<form class="hc-form hc-reply" id="hcReplyForm" novalidate><div class="hc-field"><label for="hcReply">Reply</label>'
        + '<textarea id="hcReply" rows="5" maxlength="' + BODY_MAX + '" placeholder="Add information, answer our question, or tell us it is sorted."></textarea></div>'
        + filePicker('hcReplyFiles')
        + '<p class="hc-error" id="hcReplyErr" role="alert" hidden></p>'
        + '<div class="hc-actions"><button type="submit" class="btn solid" id="hcReplyBtn">Send reply</button>'
        + (r.canClose && !r.askFeedback ? '<button type="button" class="btn hc-close-btn" id="hcCloseBtn">Close this request</button>' : '') + '</div></form>'
        + (r.canClose && !r.askFeedback ? '<div class="hc-feedback" id="hcCloseCard" hidden><h2>Close this request</h2><p class="hc-muted">Before you close it, tell us how we did.</p>'
          + stars('hcCloseRating')
          + '<div class="hc-field"><label for="hcCloseComment">Anything to add? <span class="label-hint">(optional)</span></label><textarea id="hcCloseComment" rows="3" maxlength="1000"></textarea></div>'
          + '<div class="hc-actions"><button type="button" class="btn solid" id="hcCloseConfirm">Close with this rating</button><button type="button" class="btn" id="hcCloseCancel">Keep it open</button></div>'
          + '<p class="hc-error" id="hcCloseErr" role="alert" hidden></p></div>' : '')
      : '';
    var html = head
      + '<div class="hc-req-head"><div><div class="privacy-eyebrow">' + esc(r.ref) + ' · ' + esc(r.categoryLabel) + '</div>'
      + '<h1 class="policies-title hc-req-title">' + esc(r.subject) + '</h1>'
      + '<p class="hc-muted">' + (about ? about + ' · ' : '') + 'Raised ' + esc(fmtDate(r.createdAt))
      + (r.callbackPhone ? ' · We will call you on ' + esc(r.callbackPhone) : '') + '</p></div>'
      + statusChip(r.status, r.statusLabel) + '</div>'
      + (statusNote ? '<p class="hc-status-note hc-status-note-' + esc(r.status) + '">' + esc(statusNote) + '</p>' : '')
      + feedbackDone
      + feedbackCard
      + '<h2 class="hc-timeline-title">Timeline</h2><ol class="hc-thread">' + thread + '</ol>'
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
    var rated = function(name){ var c = root.querySelector('input[name="' + name + '"]:checked'); return c ? Number(c.value) : 0; };
    var showErr = function(id, msg){ var e = document.getElementById(id); e.textContent = msg; e.hidden = false; };
    // Closing it themselves: the rating is asked first.
    // Picking a star clears the "choose a rating" message.
    Array.prototype.forEach.call(document.querySelectorAll('.hc-stars input'), function(el){
      el.addEventListener('change', function(){ ['hcFbErr', 'hcCloseErr'].forEach(function(id){ var e = document.getElementById(id); if(e) e.hidden = true; }); });
    });
    var closeBtn = document.getElementById('hcCloseBtn');
    if(closeBtn) closeBtn.addEventListener('click', function(){
      var card = document.getElementById('hcCloseCard'); card.hidden = false; closeBtn.hidden = true; card.scrollIntoView({ block: 'center' });
    });
    var closeCancel = document.getElementById('hcCloseCancel');
    if(closeCancel) closeCancel.addEventListener('click', function(){ document.getElementById('hcCloseCard').hidden = true; closeBtn.hidden = false; });
    var closeConfirm = document.getElementById('hcCloseConfirm');
    if(closeConfirm) closeConfirm.addEventListener('click', async function(){
      var n = rated('hcCloseRating');
      if(!n) return showErr('hcCloseErr', 'Choose a rating from 1 to 5 stars first.');
      closeConfirm.disabled = true;
      try{ drawRequest((await api('POST', '', { mode: 'supportClose', ref: r.ref, rating: n, comment: document.getElementById('hcCloseComment').value })).request); }
      catch(x){ closeConfirm.disabled = false; showErr('hcCloseErr', x.message); }
    });
    // Resolved: yes (rate and close) or no (open it again).
    root.querySelectorAll('[data-fb]').forEach(function(b){
      b.addEventListener('click', function(){
        document.getElementById('hcFbYes').hidden = b.getAttribute('data-fb') !== 'yes';
        document.getElementById('hcFbNo').hidden = b.getAttribute('data-fb') !== 'no';
        document.getElementById('hcFbErr').hidden = true;
      });
    });
    var fbConfirm = document.getElementById('hcFbConfirm');
    if(fbConfirm) fbConfirm.addEventListener('click', async function(){
      var n = rated('hcRating');
      if(!n) return showErr('hcFbErr', 'Choose a rating from 1 to 5 stars first.');
      fbConfirm.disabled = true;
      try{ drawRequest((await api('POST', '', { mode: 'supportFeedback', ref: r.ref, resolved: true, rating: n, comment: document.getElementById('hcFbComment').value })).request); }
      catch(x){ fbConfirm.disabled = false; showErr('hcFbErr', x.message); }
    });
    var fbReopen = document.getElementById('hcFbReopen');
    if(fbReopen) fbReopen.addEventListener('click', async function(){
      var what = document.getElementById('hcFbWhat').value.trim();
      if(what.length < 5) return showErr('hcFbErr', 'Tell us what is still not right, so we can pick it up again.');
      fbReopen.disabled = true;
      try{ drawRequest((await api('POST', '', { mode: 'supportFeedback', ref: r.ref, resolved: false, comment: what })).request); }
      catch(x){ fbReopen.disabled = false; showErr('hcFbErr', x.message); }
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
