/* aerva-photo-location.js — where new stay photos were taken.
 *
 * Used by the listing form (aerva.js) and Manage listing
 * (manage-listing.html). Hosts may upload photos from anywhere; nothing is
 * refused and nothing is asked. This only reads the location the camera
 * wrote into each photo — from the ORIGINAL file, before the page shrinks
 * it (shrinking erases it) — and sends it with the save, so the admin can
 * review photos taken far from the property (api/_photo-location.js).
 *
 *   AervaPhotoLocation.screen(files)        → Promise<File[]> (all of them;
 *                                             iPhone HEIC/HEIF photos come
 *                                             back as JPEG — most browsers
 *                                             cannot show HEIC, so neither
 *                                             the preview, the photo sorting
 *                                             nor guests could see them)
 *   AervaPhotoLocation.remember(url, file) after an upload
 *   AervaPhotoLocation.payload()            → { url: { lat, lng, takenAt } }
 */
(function(){
  if(window.AervaPhotoLocation) return;
  var EXIFR_URL = 'https://esm.sh/exifr@7.1.3';
  var fileLoc = new WeakMap();        // File → location (or null)
  var urlLoc = {};                    // uploaded URL → location
  var exifrPromise = null;
  // HEIC decoding runs in a hidden helper page (heic-convert.html): the
  // decoder needs to evaluate code, which this page's security policy does
  // not allow. Made only when a HEIC photo is picked.
  var helper = null, helperReady = null, nextId = 1, waiting = {};
  function getHelper(){
    if(helperReady) return helperReady;
    helperReady = new Promise(function(resolve){
      var done = false;
      window.addEventListener('message', function(e){
        if(e.origin !== location.origin || !e.data) return;
        if(e.data.type === 'aerva-heic-ready' && !done){ done = true; resolve(helper); }
        if(e.data.type === 'aerva-heic-done' && waiting[e.data.id]){ waiting[e.data.id](e.data); delete waiting[e.data.id]; }
      });
      helper = document.createElement('iframe');
      helper.src = '/heic-convert.html?v=2026-11-07a';
      helper.title = 'Photo helper'; helper.setAttribute('aria-hidden', 'true'); helper.tabIndex = -1;
      helper.style.cssText = 'position:absolute; width:1px; height:1px; border:0; left:-9999px; top:0;';
      document.body.appendChild(helper);
      setTimeout(function(){ if(!done){ done = true; resolve(null); } }, 20000);
    });
    return helperReady;
  }
  function loadExifr(){
    if(!exifrPromise){
      exifrPromise = import(EXIFR_URL).then(function(m){ return m.default || m; }).catch(function(){ exifrPromise = null; return null; });
    }
    return exifrPromise;
  }
  function isHeic(f){
    return /^image\/hei[cf]/i.test(f.type || '') || /\.hei[cf]$/i.test(f.name || '');
  }
  // HEIC → JPEG. Any failure, or taking far too long, keeps the original.
  function toJpeg(f){
    if(!isHeic(f)) return Promise.resolve(f);
    return getHelper().then(function(h){
      if(!h || !h.contentWindow) return f;
      return new Promise(function(resolve){
        var id = nextId++;
        var timer = setTimeout(function(){ delete waiting[id]; resolve(f); }, 30000 + 10000 * Object.keys(waiting).length);   // photos are done one at a time
        waiting[id] = function(msg){
          clearTimeout(timer);
          if(!msg.blob || msg.error) return resolve(f);
          resolve(new File([msg.blob], String(f.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: f.lastModified }));
        };
        h.contentWindow.postMessage({ type: 'aerva-heic', id: id, blob: f }, location.origin);
      });
    }).catch(function(){ return f; });
  }

  // The camera's own location, from the original file. null when none.
  function readPhoto(file){
    return loadExifr().then(function(exifr){
      if(!exifr) return null;
      return Promise.all([
        exifr.gps(file).catch(function(){ return null; }),
        exifr.parse(file, ['DateTimeOriginal']).catch(function(){ return null; })
      ]).then(function(res){
        var g = res[0], meta = res[1];
        if(!g || !isFinite(g.latitude) || !isFinite(g.longitude) || (g.latitude === 0 && g.longitude === 0)) return null;
        var taken = meta && meta.DateTimeOriginal instanceof Date && !isNaN(meta.DateTimeOriginal) ? meta.DateTimeOriginal.toISOString() : null;
        return { lat: g.latitude, lng: g.longitude, takenAt: taken };
      });
    }).catch(function(){ return null; });
  }

  // Reads each photo's location and keeps every photo. Never waits more
  // than a few seconds: a slow network must not hold up a host.
  function screen(files){
    files = Array.prototype.slice.call(files || []);
    if(!files.length) return Promise.resolve([]);
    var converted = files.map(toJpeg);            // started at once, alongside reading the location
    var reading = Promise.all(files.map(function(f, i){
      return readPhoto(f).then(function(loc){
        if(!loc) return;
        fileLoc.set(f, loc);
        // The JPEG made from a HEIC photo carries the same location.
        converted[i].then(function(j){ if(j !== f) fileLoc.set(j, loc); });
      });
    }));
    return Promise.race([reading, new Promise(function(r){ setTimeout(r, 4000); })]).then(function(){ return Promise.all(converted); });
  }

  function remember(url, file){
    if(!url || !file) return;
    var loc = fileLoc.get(file);
    if(loc) urlLoc[url] = loc;
  }
  function payload(){ return Object.assign({}, urlLoc); }

  window.AervaPhotoLocation = { screen: screen, remember: remember, payload: payload, _fileLoc: fileLoc };
})();
