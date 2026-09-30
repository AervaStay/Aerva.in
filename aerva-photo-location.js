/* aerva-photo-location.js — stay photos must be taken at the property.
 *
 * Used by the listing form (aerva.js) and Manage listing
 * (manage-listing.html). The server enforces the same rule
 * (api/_photo-location.js); this file lets a host know at once, and sends
 * the server each photo's location.
 *
 * A photo is accepted when:
 *   1. the location the camera wrote into it is within 2 km of the
 *      property's pin — read here from the ORIGINAL file, because
 *      shrinking a photo before upload erases it; or
 *   2. it has none (phones strip it on upload), and the host's phone is
 *      within 2 km of the pin right now — the browser asks for location
 *      once and remembers it for two minutes.
 * When the pin is not chosen yet, a photo only needs a location; its
 * distance is checked when the listing is saved with a pin.
 *
 *   AervaPhotoLocation.screen(files, pin)  → Promise<File[]> the accepted ones
 *   AervaPhotoLocation.remember(url, file) after an upload
 *   AervaPhotoLocation.payload()            → { url: {lat, lng, source, accuracy, takenAt} }
 *   AervaPhotoLocation.farFiles(files, pin) → rejections for a pin chosen later
 *   AervaPhotoLocation.showServerRejection(body) for a save the server refused
 */
(function(){
  if(window.AervaPhotoLocation) return;
  var MAX_KM = 2;
  var EXIFR_URL = 'https://esm.sh/exifr@7.1.3';
  var fileLoc = new WeakMap();        // File → location (or null)
  var urlLoc = {};                    // uploaded URL → location
  var urlName = {};                   // uploaded URL → file name, for messages
  var exifrPromise = null;
  var devicePromise = null, deviceAt = 0;

  function loadExifr(){
    if(!exifrPromise){
      exifrPromise = import(EXIFR_URL).then(function(m){ return m.default || m; }).catch(function(){ exifrPromise = null; return null; });
    }
    return exifrPromise;
  }
  function validPin(pin){
    return !!pin && isFinite(Number(pin.lat)) && isFinite(Number(pin.lng)) && pin.lat !== '' && pin.lng !== ''
      && Math.abs(Number(pin.lat)) <= 90 && Math.abs(Number(pin.lng)) <= 180 && !(Number(pin.lat) === 0 && Number(pin.lng) === 0);
  }
  function distanceKm(a, b){
    var R = 6371, rad = function(d){ return d * Math.PI / 180; };
    var dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.pow(Math.sin(dLng / 2), 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function allowedKm(loc){
    return MAX_KM + (loc.source === 'device' && loc.accuracy ? Math.min(loc.accuracy, 500) / 1000 : 0);
  }
  function kmText(km){ return km < 10 ? km.toFixed(1) : String(Math.round(km)); }

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
        return { lat: g.latitude, lng: g.longitude, source: 'photo', accuracy: null, takenAt: taken };
      });
    }).catch(function(){ return null; });
  }

  // Where the host's phone is now. null when refused or unavailable.
  function readDevice(){
    if(devicePromise && Date.now() - deviceAt < 2 * 60 * 1000) return devicePromise;
    deviceAt = Date.now();
    devicePromise = new Promise(function(resolve){
      if(!navigator.geolocation){ resolve(null); return; }
      navigator.geolocation.getCurrentPosition(function(p){
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude, source: 'device', accuracy: Math.round(p.coords.accuracy || 0) || null, takenAt: null });
      }, function(){ resolve(null); }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 120000 });
    }).then(function(loc){ if(!loc) devicePromise = null; return loc; });
    return devicePromise;
  }

  function reasonText(name, why, km){
    var q = '“' + name + '”';
    if(why === 'far_photo') return q + ' was taken about ' + kmText(km) + ' km from the property.';
    if(why === 'far_device') return q + ' has no location of its own, and you are about ' + kmText(km) + ' km from the property right now.';
    if(why === 'no_device') return q + ' has no location, and your location wasn’t shared.';
    return q + ' has no location.';
  }

  // One notice at the bottom of the screen, replaced by the next one.
  function notice(lines){
    var old = document.getElementById('aervaPhotoLocNotice');
    if(old) old.remove();
    if(!lines.length) return;
    var box = document.createElement('div');
    box.id = 'aervaPhotoLocNotice';
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed; left:50%; bottom:20px; transform:translateX(-50%); z-index:100000; width:min(560px, calc(100vw - 32px)); '
      + 'max-height:60vh; overflow:auto; background:#1c1a17; color:#f4eadc; padding:16px 44px 16px 18px; border-radius:10px; '
      + 'box-shadow:0 10px 30px rgba(0,0,0,0.3); font:14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-sizing:border-box;';
    var title = document.createElement('div');
    title.style.cssText = 'font-weight:600; margin-bottom:6px;';
    title.textContent = lines.length === 1 ? 'This photo doesn’t comply with Aerva policies' : 'These photos don’t comply with Aerva policies';
    box.appendChild(title);
    var ul = document.createElement('ul');
    ul.style.cssText = 'margin:0 0 8px 18px; padding:0;';
    lines.slice(0, 8).forEach(function(t){ var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
    if(lines.length > 8){ var more = document.createElement('li'); more.textContent = 'and ' + (lines.length - 8) + ' more.'; ul.appendChild(more); }
    box.appendChild(ul);
    var how = document.createElement('div');
    how.style.cssText = 'opacity:0.8; font-size:13px;';
    how.textContent = 'Every photo must be taken at the property. Use photos taken there with your camera’s location turned on, or add them while you are at the property and allow location when asked.';
    box.appendChild(how);
    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.style.cssText = 'position:absolute; top:8px; right:10px; background:none; border:0; color:#f4eadc; font-size:22px; line-height:1; cursor:pointer; padding:4px;';
    close.onclick = function(){ box.remove(); };
    box.appendChild(close);
    document.body.appendChild(box);
  }

  // Checks newly picked files. Resolves with the accepted ones; the rest
  // are listed in a notice.
  function screen(files, pin){
    files = Array.prototype.slice.call(files || []);
    if(!files.length) return Promise.resolve([]);
    var at = validPin(pin) ? { lat: Number(pin.lat), lng: Number(pin.lng) } : null;
    return Promise.all(files.map(readPhoto)).then(function(own){
      var needDevice = own.some(function(l){ return !l; });
      return (needDevice ? readDevice() : Promise.resolve(null)).then(function(device){
        var accepted = [], lines = [];
        files.forEach(function(file, i){
          var loc = own[i], why = null, km = 0;
          if(loc){
            if(at){ km = distanceKm(at, loc); if(km > allowedKm(loc)) why = 'far_photo'; }
          } else if(!device){
            why = 'no_device';
          } else {
            loc = device;
            if(at){ km = distanceKm(at, loc); if(km > allowedKm(loc)) why = 'far_device'; }
          }
          if(why){ lines.push(reasonText(file.name || 'Photo', why, km)); return; }
          fileLoc.set(file, loc);
          accepted.push(file);
        });
        notice(lines);
        return accepted;
      });
    });
  }

  // For a pin chosen after the photos: which accepted files are too far.
  function farFiles(files, pin){
    if(!validPin(pin)) return [];
    var at = { lat: Number(pin.lat), lng: Number(pin.lng) };
    var out = [];
    Array.prototype.slice.call(files || []).forEach(function(file){
      var loc = fileLoc.get(file);
      if(!loc) return;
      var km = distanceKm(at, loc);
      if(km > allowedKm(loc)) out.push({ file: file, km: km, text: reasonText(file.name || 'Photo', loc.source === 'device' ? 'far_device' : 'far_photo', km) });
    });
    return out;
  }

  function remember(url, file){
    if(!url || !file) return;
    var loc = fileLoc.get(file);
    if(loc) urlLoc[url] = loc;
    urlName[url] = file.name || 'Photo';
  }
  function payload(){ return Object.assign({}, urlLoc); }

  // The server refused a save: say which photos, in the same words.
  function showServerRejection(body){
    var list = body && Array.isArray(body.rejectedPhotos) ? body.rejectedPhotos : [];
    if(!list.length) return false;
    notice(list.map(function(p){
      var name = urlName[p.url] || 'A photo';
      var loc = urlLoc[p.url];
      if(p.reason === 'too_far') return reasonText(name, loc && loc.source === 'device' ? 'far_device' : 'far_photo', Number(p.km) || 0);
      return reasonText(name, 'none', 0);
    }));
    return true;
  }

  window.AervaPhotoLocation = {
    MAX_KM: MAX_KM, screen: screen, farFiles: farFiles, remember: remember, payload: payload,
    showServerRejection: showServerRejection, notice: notice, distanceKm: distanceKm, _fileLoc: fileLoc
  };
})();
