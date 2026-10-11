// aerva-bank-fields.js — the bank account form, checked as you type, the
// way Indian banks' own forms do it. Used by host-payouts.html (a host's
// Payout details) and index.html (a co-host's payout details).
//
//   • Account number: digits only (spaces and anything else are dropped
//     as you type), 9 to 18 digits, hidden like a password with a Show
//     button.
//   • Re-enter: must be typed, not pasted; says at once, digit by digit,
//     whether it still matches, and "Matches" when it does.
//   • IFSC: capital letters, 11 characters, 4 letters + 0 + 6 letters or
//     digits (HDFC0001234).
//   • GSTIN (optional): 15 characters, 27ABCPE1234F1Z5.
//   • Save stays switched off until everything is right.
// The server checks all of this again (api/host-listings.js).
//
//   const form = AervaBankFields.wire({ holder, account, account2, ifsc, gstin, save });
//   form.valid()  → true when every field is right.
(function(){
  var ACCOUNT = /^[0-9]{9,18}$/;
  var IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
  var GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

  function addStyles(){
    if(document.getElementById('aervaBankFieldStyles')) return;
    var st = document.createElement('style');
    st.id = 'aervaBankFieldStyles';
    st.textContent = [
      '.abf-hint{display:block; font-size:12.5px; line-height:1.45; margin-top:5px; min-height:18px; letter-spacing:0; text-transform:none; color:#6e675d; opacity:1;}',
      '.abf-hint.is-bad{color:#a3402f;}',
      '.abf-hint.is-good{color:#2f6b37;}',
      'input.abf-bad{border-color:#a3402f !important; box-shadow:0 0 0 1px #a3402f;}',
      'input.abf-good{border-color:#2f6b37 !important;}',
      '.abf-wrap{position:relative; display:block;}',
      '.abf-wrap input{padding-right:64px !important;}',
      '.abf-show{position:absolute; right:6px; top:50%; transform:translateY(-50%); background:none; border:none; font:inherit; font-size:12px; letter-spacing:0.06em; text-transform:uppercase; color:#8a6c39; cursor:pointer; padding:8px; min-height:36px;}'
    ].join('\n');
    document.head.appendChild(st);
  }

  // A hint line right under the input (inside its label when it has one).
  function hintFor(input){
    var next = input.parentNode.classList && input.parentNode.classList.contains('abf-wrap') ? input.parentNode : input;
    var h = next.nextElementSibling;
    if(h && h.classList.contains('abf-hint')) return h;
    h = document.createElement('span');
    h.className = 'abf-hint';
    h.setAttribute('aria-live', 'polite');
    next.parentNode.insertBefore(h, next.nextSibling);
    return h;
  }
  function show(input, state, text){
    var h = hintFor(input);
    h.textContent = text || '';
    h.className = 'abf-hint' + (state === 'bad' ? ' is-bad' : state === 'good' ? ' is-good' : '');
    input.classList.toggle('abf-bad', state === 'bad');
    input.classList.toggle('abf-good', state === 'good');
    input.setAttribute('aria-invalid', state === 'bad' ? 'true' : 'false');
  }
  // Keep the caret where it was when the value is cleaned up as you type.
  function clean(input, fn){
    var before = input.value, pos = input.selectionStart;
    var after = fn(before);
    if(after === before) return;
    var removedBefore = pos == null ? 0 : before.slice(0, pos).length - fn(before.slice(0, pos)).length;
    input.value = after;
    try{ if(pos != null) input.setSelectionRange(pos - removedBefore, pos - removedBefore); }catch(e){}
  }

  // The bank and branch for an IFSC (api/host-listings.js ?ifsc=, which
  // asks Razorpay's public IFSC directory). Cached per code.
  var branchCache = {};
  function fetchBranch(code){
    if(branchCache[code]) return branchCache[code];
    var api = (window.AERVA_API || 'https://aerva-in.vercel.app') + '/api/host-listings?ifsc=' + encodeURIComponent(code);
    var token = null; try{ token = localStorage.getItem('aerva_guest_session'); }catch(e){}
    branchCache[code] = fetch(api, { headers: token ? { 'Authorization': 'Bearer ' + token } : {} })
      .then(function(r){ return r.ok ? r.json() : null; })
      .catch(function(){ return null; })
      .then(function(d){ if(!d) delete branchCache[code]; return d; });
    return branchCache[code];
  }
  function branchText(b){
    var where = [b.branch, b.city && b.city !== b.branch ? b.city : '', b.state].filter(Boolean).join(', ');
    return '\u2713 ' + b.bank + (where ? ' \u2014 ' + where : '');
  }

  function wire(f){
    addStyles();
    var touched = {};
    var branch = { code: null, state: null, info: null };   // state: 'checking' | 'found' | 'missing' | 'unknown'
    function lookUp(code){
      if(branch.code === code) return;
      branch.code = code; branch.state = 'checking'; branch.info = null;
      fetchBranch(code).then(function(d){
        if(branch.code !== code) return;
        if(!d){ branch.state = 'unknown'; }
        else if(d.found){ branch.state = 'found'; branch.info = d; }
        else { branch.state = 'missing'; }
        check();
      });
    }
    var digits = function(v){ return v.replace(/[^0-9]/g, ''); };
    var upper = function(v){ return v.toUpperCase().replace(/[^A-Z0-9]/g, ''); };

    // Account number: hidden, with Show.
    if(f.account){
      f.account.setAttribute('inputmode', 'numeric');
      f.account.setAttribute('maxlength', '18');
      f.account.setAttribute('autocomplete', 'off');
      f.account.type = 'password';
      if(!f.account.parentNode.classList.contains('abf-wrap')){
        var wrap = document.createElement('span');
        wrap.className = 'abf-wrap';
        f.account.parentNode.insertBefore(wrap, f.account);
        wrap.appendChild(f.account);
        var btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'abf-show'; btn.textContent = 'Show';
        btn.setAttribute('aria-label', 'Show account number');
        btn.addEventListener('click', function(){
          var hidden = f.account.type === 'password';
          f.account.type = hidden ? 'text' : 'password';
          btn.textContent = hidden ? 'Hide' : 'Show';
          btn.setAttribute('aria-label', (hidden ? 'Hide' : 'Show') + ' account number');
        });
        wrap.appendChild(btn);
      }
    }
    if(f.account2){
      f.account2.setAttribute('inputmode', 'numeric');
      f.account2.setAttribute('maxlength', '18');
      f.account2.setAttribute('autocomplete', 'off');
      // Banks ask for it to be typed again, so a wrong number copied from
      // somewhere cannot be pasted into both boxes.
      ['paste', 'drop'].forEach(function(ev){
        f.account2.addEventListener(ev, function(e){
          e.preventDefault();
          show(f.account2, 'bad', 'Please type the account number again — pasting is not allowed here.');
        });
      });
    }
    if(f.ifsc){ f.ifsc.setAttribute('maxlength', '11'); f.ifsc.setAttribute('autocomplete', 'off'); f.ifsc.style.textTransform = 'uppercase'; }
    if(f.gstin){ f.gstin.setAttribute('maxlength', '15'); f.gstin.setAttribute('autocomplete', 'off'); f.gstin.style.textTransform = 'uppercase'; }

    function check(){
      var ok = true;
      var holder = f.holder ? f.holder.value.trim() : 'x';
      var acc = f.account ? f.account.value : '';
      var acc2 = f.account2 ? f.account2.value : '';
      var ifsc = f.ifsc ? f.ifsc.value : '';
      var gstin = f.gstin ? f.gstin.value : '';

      if(f.holder){
        if(holder.length >= 2) show(f.holder, '', '');
        else { ok = false; show(f.holder, touched.holder ? 'bad' : '', touched.holder ? 'Enter the account holder’s name as the bank has it.' : ''); }
      }
      if(f.account){
        if(ACCOUNT.test(acc)) show(f.account, 'good', acc.length + ' digits');
        else {
          ok = false;
          if(!acc) show(f.account, touched.account ? 'bad' : '', touched.account ? 'Enter your account number.' : '9 to 18 digits, numbers only.');
          else if(acc.length < 9) show(f.account, touched.account ? 'bad' : '', (touched.account ? 'Too short: ' : '') + acc.length + ' of at least 9 digits.');
          else show(f.account, 'bad', 'Account numbers are 9 to 18 digits.');
        }
      }
      if(f.account2){
        if(!acc2){ ok = false; show(f.account2, touched.account2 ? 'bad' : '', touched.account2 ? 'Type the account number again.' : ''); }
        else if(acc.indexOf(acc2) !== 0){ ok = false; show(f.account2, 'bad', 'Does not match the account number above.'); }
        else if(acc2.length < acc.length){ ok = false; show(f.account2, '', 'Keep typing… ' + acc2.length + ' of ' + acc.length + ' digits.'); }
        else if(ACCOUNT.test(acc)) show(f.account2, 'good', '✓ Matches');
        else { ok = false; show(f.account2, '', ''); }
      }
      if(f.ifsc){
        if(IFSC.test(ifsc)){
          // The format is right: now the bank and branch it belongs to.
          lookUp(ifsc);
          if(branch.state === 'found') show(f.ifsc, 'good', branchText(branch.info));
          else if(branch.state === 'missing'){ ok = false; show(f.ifsc, 'bad', 'We could not find this IFSC. Check it on your cheque book or passbook, or ask your branch.'); }
          else if(branch.state === 'checking'){ ok = false; show(f.ifsc, '', 'Finding your branch\u2026'); }
          else show(f.ifsc, 'good', '\u2713 The format is right. We could not look up the branch just now.');
        }
        else {
          ok = false;
          var why = '';
          if(ifsc.length >= 4 && !/^[A-Z]{4}/.test(ifsc)) why = 'The first 4 characters are letters (the bank), like HDFC.';
          else if(ifsc.length >= 5 && ifsc.charAt(4) !== '0') why = 'The 5th character is always zero (0).';
          else if(ifsc.length === 11) why = 'That IFSC does not look right. It is like HDFC0001234.';
          else if(touched.ifsc) why = ifsc ? 'IFSC codes are 11 characters, like HDFC0001234.' : 'Enter the IFSC code of your branch.';
          show(f.ifsc, why ? 'bad' : '', why || '11 characters, like HDFC0001234. It is on your cheque book or passbook.');
        }
      }
      if(f.gstin){
        if(!gstin) show(f.gstin, '', '');
        else if(GSTIN.test(gstin)) show(f.gstin, 'good', '✓');
        else {
          ok = false;
          show(f.gstin, (gstin.length === 15 || touched.gstin) ? 'bad' : '', 'A GSTIN is 15 characters, like 27ABCPE1234F1Z5. Leave it empty if you do not have one.');
        }
      }
      if(f.save) f.save.disabled = !ok;
      return ok;
    }

    [['holder', null], ['account', digits], ['account2', digits], ['ifsc', upper], ['gstin', upper]].forEach(function(pair){
      var el = f[pair[0]];
      if(!el) return;
      el.addEventListener('input', function(){ if(pair[1]) clean(el, pair[1]); check(); });
      el.addEventListener('blur', function(){ touched[pair[0]] = true; check(); });
    });
    check();
    return {
      valid: function(){ Object.keys(f).forEach(function(k){ touched[k] = true; }); return check(); },
      refresh: check
    };
  }

  window.AervaBankFields = { wire: wire, ACCOUNT: ACCOUNT, IFSC: IFSC, GSTIN: GSTIN };
})();
