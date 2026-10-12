// aerva-id-verify.js — "Verify your ID" in Account Settings.
// Used by index.html (?view=settings, everyone) and host-dashboard.html
// (Account Settings → Verification, where it is also the host's identity
// and address proof).
//
// The ID is checked in a few seconds and never stored: the photo is made
// smaller here, sent straight to api/guest-profile.js (mode verifyId), read
// in memory and dropped (api/_id-verify.js). Only the result is kept.
//
//   AervaIdVerify.mount(element, { onVerified })
(function(){
  var API = (window.AERVA_API || 'https://aerva-in.vercel.app') + '/api/guest-profile';
  function token(){ try{ return localStorage.getItem('aerva_guest_session'); }catch(e){ return null; } }
  function esc(t){ return String(t == null ? '' : t).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function addStyles(){
    if(document.getElementById('aervaIdVerifyStyles')) return;
    var st = document.createElement('style');
    st.id = 'aervaIdVerifyStyles';
    st.textContent = [
      '.aiv{font-size:14.5px; color:#1c1a17;}',
      '.aiv-note{font-size:13.5px; color:#6e675d; line-height:1.55; margin:0 0 12px;}',
      '.aiv-done{display:flex; gap:12px; align-items:flex-start; padding:14px 16px; border:1px solid #cfe3d1; background:#f3f9f3; border-radius:12px; margin:0 0 12px;}',
      '.aiv-done strong{display:block; color:#2f6b37; font-weight:600;}',
      '.aiv-done span{font-size:13.5px; color:#3f4a40;}',
      '.aiv-tabs{display:flex; gap:8px; flex-wrap:wrap; margin:0 0 14px;}',
      '.aiv-tab{border:1px solid #d9cdb8; background:#fff; border-radius:999px; padding:8px 14px; font:inherit; font-size:13px; cursor:pointer; min-height:38px;}',
      '.aiv-tab[aria-selected="true"]{background:#1c1a17; color:#fff; border-color:#1c1a17;}',
      '.aiv-field{display:block; margin:0 0 12px;}',
      '.aiv-field > span{display:block; font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#6e675d; margin:0 0 5px;}',
      '.aiv-field input, .aiv-field select{width:100%; box-sizing:border-box; border:1px solid #d9cdb8; border-radius:10px; padding:11px 12px; font:inherit; font-size:15px; background:#fff; color:#1c1a17; min-height:44px;}',
      '.aiv-two{display:grid; grid-template-columns:1fr 1fr; gap:12px;}',
      '@media (max-width:520px){ .aiv-two{grid-template-columns:1fr; gap:0;} }',
      '.aiv-btn{background:#1c1a17; color:#fff; border:none; border-radius:999px; padding:12px 22px; font:inherit; font-size:14px; letter-spacing:0.04em; cursor:pointer; min-height:44px;}',
      '.aiv-btn:disabled{opacity:0.55; cursor:default;}',
      '.aiv-link{background:none; border:none; color:#8a6c39; font:inherit; font-size:13.5px; cursor:pointer; padding:6px 0; text-decoration:underline;}',
      '.aiv-msg{font-size:13.5px; min-height:18px; margin:10px 0 0; line-height:1.5;}',
      '.aiv-msg.is-error{color:#a3402f;}',
      '.aiv-msg.is-ok{color:#2f6b37;}',
      '.aiv-steps{margin:0 0 12px; padding-left:20px; font-size:13.5px; color:#3d3a35; line-height:1.6;}',
      '.aiv-lock{font-size:12.5px; color:#6e675d; margin:12px 0 0; line-height:1.5;}'
    ].join('\n');
    document.head.appendChild(st);
  }

  // A phone photo can be 5–10 MB: make it at most 2000 px on its long side
  // (still sharp enough to read every line) before it leaves the device.
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
        var max = 2000, w = img.naturalWidth, h = img.naturalHeight;
        var k = Math.min(1, max / Math.max(w, h));
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
  function readZip(file){
    return new Promise(function(resolve, reject){
      if(file.size > 4 * 1024 * 1024) return reject(new Error('That file is too large to be the Aadhaar ZIP file.'));
      var fr = new FileReader();
      fr.onload = function(){ resolve(String(fr.result).split(',')[1]); };
      fr.onerror = function(){ reject(new Error('That file could not be read.')); };
      fr.readAsDataURL(file);
    });
  }

  async function post(body){
    var r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() }, body: JSON.stringify(body) });
    var d = await r.json().catch(function(){ return {}; });
    if(!r.ok) throw new Error(d.error || 'Could not verify right now. Please try again.');
    return d;
  }

  var PRIVACY_NOTE = 'Your ID is checked automatically in a few seconds and is <strong>never stored</strong>. Aerva keeps only the result: the type of ID, your name as on it and its last 4 characters.';

  async function mount(el, opts){
    if(!el) return;
    opts = opts || {};
    addStyles();
    if(!token()){ el.innerHTML = '<p class="aiv-note">Log in to verify your ID.</p>'; return; }
    el.innerHTML = '<p class="aiv-note">Loading…</p>';
    var s;
    try{
      var r = await fetch(API + '?mode=idVerification', { headers: { 'Authorization': 'Bearer ' + token() } });
      s = await r.json();
      if(!r.ok) throw new Error(s.error || 'failed');
    }catch(e){ el.innerHTML = '<p class="aiv-note">Could not load ID verification. Please refresh.</p>'; return; }
    render(el, s, opts, false);
  }

  function render(el, s, opts, again){
    var v = s.verification;
    if(v && !again){
      var when = '';
      try{ when = new Date(v.verifiedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }catch(e){}
      el.innerHTML = '<div class="aiv">'
        + '<div class="aiv-done"><div style="font-size:20px; line-height:1; color:#2f6b37;">✓</div><div><strong>ID verified</strong>'
        + '<span>' + esc(v.document) + (v.last4 ? ' ending ' + esc(v.last4) : '') + (v.name ? ' · ' + esc(v.name) : '') + (when ? ' · ' + esc(when) : '') + '</span></div></div>'
        + '<p class="aiv-note">' + (s.isHost ? 'This is also your identity and address proof for hosting. ' : 'Hosts see that your ID is verified, never the ID itself. ') + 'Your ID was not stored.</p>'
        + '<button type="button" class="aiv-link" data-aiv-again>Verify with a different ID</button></div>';
      el.querySelector('[data-aiv-again]').addEventListener('click', function(){ render(el, s, opts, true); });
      return;
    }
    var types = s.docTypes || [];
    el.innerHTML = '<div class="aiv">'
      + '<p class="aiv-note">' + (s.isHost
          ? 'Verify your identity and address in under a minute with your Aadhaar, passport, driving licence or voter ID. '
          : 'Verify your identity in under a minute with any government photo ID: Aadhaar, passport, driving licence or voter ID (from outside India: your passport or national ID card). Hosts see that your ID is verified. ')
      + PRIVACY_NOTE + '</p>'
      + (s.aadhaarZip ? '<div class="aiv-tabs" role="tablist">'
          + '<button type="button" class="aiv-tab" role="tab" aria-selected="true" data-aiv-tab="doc">Photo of your ID</button>'
          + '<button type="button" class="aiv-tab" role="tab" aria-selected="false" data-aiv-tab="zip">Aadhaar offline e-KYC (ZIP)</button></div>' : '')
      + '<form data-aiv-form="doc" novalidate>'
      + '<label class="aiv-field"><span>Type of ID</span><select name="docType">' + types.map(function(t){ return '<option value="' + esc(t.key) + '">' + esc(t.label) + '</option>'; }).join('') + '</select></label>'
      + '<label class="aiv-field"><span>Full name, exactly as on the ID</span><input name="name" autocomplete="name" value="' + esc(s.suggestedName || '') + '"></label>'
      + '<div class="aiv-two">'
      + '<label class="aiv-field"><span>Date of birth</span><input name="dob" type="date" max="' + new Date().toISOString().slice(0, 10) + '"></label>'
      + '<label class="aiv-field"><span data-aiv-numlabel>Last 4 digits of the ID number</span><input name="last4" maxlength="4" autocomplete="off" style="text-transform:uppercase; letter-spacing:0.2em;"></label>'
      + '</div>'
      + '<label class="aiv-field"><span>Photo of the ID (front; add the back too if your details are on it)</span><input name="files" type="file" accept="image/*,.pdf" multiple></label>'
      + '<button type="submit" class="aiv-btn">Verify now</button>'
      + (s.verification ? ' <button type="button" class="aiv-link" data-aiv-cancel style="margin-left:10px;">Cancel</button>' : '')
      + '<p class="aiv-msg" aria-live="polite"></p>'
      + '</form>'
      + (s.aadhaarZip ? '<form data-aiv-form="zip" novalidate hidden>'
          + '<ol class="aiv-steps"><li>Open <a href="https://myaadhaar.uidai.gov.in/" target="_blank" rel="noopener" style="color:#8a6c39;">myaadhaar.uidai.gov.in</a> and log in with your Aadhaar number and the OTP.</li>'
          + '<li>Choose <strong>Offline eKYC</strong>, set a 4-character share code, and download the ZIP file.</li>'
          + '<li>Add the ZIP here with the same share code. Use it within 3 days.</li></ol>'
          + '<label class="aiv-field"><span>Aadhaar ZIP file</span><input name="zip" type="file" accept=".zip,application/zip"></label>'
          + '<label class="aiv-field"><span>Share code</span><input name="zipPassword" autocomplete="off" maxlength="20"></label>'
          + '<button type="submit" class="aiv-btn">Verify now</button>'
          + '<p class="aiv-msg" aria-live="polite"></p></form>' : '')
      + '<p class="aiv-lock">Aerva never asks for your full ID number and never keeps a copy of your ID.</p>'
      + '</div>';

    var docForm = el.querySelector('[data-aiv-form="doc"]');
    var zipForm = el.querySelector('[data-aiv-form="zip"]');
    var sel = docForm.querySelector('[name=docType]');
    var numLabel = docForm.querySelector('[data-aiv-numlabel]');
    function syncType(){
      var t = types.filter(function(x){ return x.key === sel.value; })[0];
      numLabel.textContent = t ? 'Last 4 of ' + t.numberHint.replace(/^the last 4 (digits|characters) of /, '') : 'Last 4 of the ID number';
    }
    sel.addEventListener('change', syncType); syncType();
    var cancel = el.querySelector('[data-aiv-cancel]');
    if(cancel) cancel.addEventListener('click', function(){ render(el, s, opts, false); });
    el.querySelectorAll('[data-aiv-tab]').forEach(function(b){
      b.addEventListener('click', function(){
        var which = b.getAttribute('data-aiv-tab');
        el.querySelectorAll('[data-aiv-tab]').forEach(function(x){ x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
        docForm.hidden = which !== 'doc';
        if(zipForm) zipForm.hidden = which !== 'zip';
      });
    });

    function done(d){
      s.verification = d.verification;
      render(el, s, opts, false);
      if(typeof opts.onVerified === 'function') opts.onVerified(d);
    }

    docForm.addEventListener('submit', async function(e){
      e.preventDefault();
      var msg = docForm.querySelector('.aiv-msg'), btn = docForm.querySelector('.aiv-btn');
      var bad = function(t){ msg.className = 'aiv-msg is-error'; msg.textContent = t; };
      var fe = docForm.elements;
      var name = fe['name'].value.trim(), dob = fe['dob'].value, last4 = fe['last4'].value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      var files = Array.prototype.slice.call(fe['files'].files || []);
      if(name.split(/\s+/).length < 2) return bad('Enter your full name exactly as it is on the ID.');
      if(!dob) return bad('Enter your date of birth.');
      if(last4.length !== 4) return bad('Enter the last 4 characters of the ID number.');
      if(!files.length) return bad('Add a photo of your ID.');
      if(files.length > 2) return bad('Add at most two photos: the front and the back.');
      btn.disabled = true; msg.className = 'aiv-msg'; msg.textContent = 'Checking your ID… this takes a few seconds.';
      try{
        var payload = [];
        for(var i = 0; i < files.length; i++) payload.push(await shrink(files[i]));
        var d = await post({ mode: 'verifyId', docType: sel.value, name: name, dob: dob, last4: last4, files: payload });
        payload = null; fe['files'].value = '';
        done(d);
      }catch(err){ bad(err.message); btn.disabled = false; }
    });

    if(zipForm) zipForm.addEventListener('submit', async function(e){
      e.preventDefault();
      var msg = zipForm.querySelector('.aiv-msg'), btn = zipForm.querySelector('.aiv-btn');
      var bad = function(t){ msg.className = 'aiv-msg is-error'; msg.textContent = t; };
      var ze = zipForm.elements;
      var f = ze['zip'].files && ze['zip'].files[0];
      var code = ze['zipPassword'].value.trim();
      if(!f) return bad('Add the ZIP file you downloaded.');
      if(!code) return bad('Enter the share code you chose when downloading the file.');
      btn.disabled = true; msg.className = 'aiv-msg'; msg.textContent = 'Checking your Aadhaar file…';
      try{
        var d = await post({ mode: 'verifyAadhaarZip', zip: await readZip(f), zipPassword: code });
        ze['zip'].value = ''; ze['zipPassword'].value = '';
        done(d);
      }catch(err){ bad(err.message); btn.disabled = false; }
    });
  }

  window.AervaIdVerify = { mount: mount };
})();
