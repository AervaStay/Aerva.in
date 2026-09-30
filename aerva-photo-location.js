/* aerva-photo-location.js — where new stay photos were taken.
 *
 * Used by the listing form (aerva.js) and Manage listing
 * (manage-listing.html). Hosts may upload photos from anywhere; nothing is
 * refused and nothing is asked. This only reads the location the camera
 * wrote into each photo — from the ORIGINAL file, before the page shrinks
 * it (shrinking erases it) — and sends it with the save, so the admin can
 * review photos taken far from the property (api/_photo-location.js).
 *
 *   AervaPhotoLocation.screen(files)        → Promise<File[]> (all of them)
 *   AervaPhotoLocation.remember(url, file) after an upload
 *   AervaPhotoLocation.payload()            → { url: { lat, lng, takenAt } }
 */
(function(){
  if(window.AervaPhotoLocation) return;
  var EXIFR_URL = 'https://esm.sh/exifr@7.1.3';
  var fileLoc = new WeakMap();        // File → location (or null)
  var urlLoc = {};                    // uploaded URL → location
  var exifrPromise = null;

  function loadExifr(){
    if(!exifrPromise){
      exifrPromise = import(EXIFR_URL).then(function(m){ return m.default || m; }).catch(function(){ exifrPromise = null; return null; });
    }
    return exifrPromise;
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
    var reading = Promise.all(files.map(function(f){
      return readPhoto(f).then(function(loc){ if(loc) fileLoc.set(f, loc); });
    }));
    return Promise.race([reading, new Promise(function(r){ setTimeout(r, 4000); })]).then(function(){ return files; });
  }

  function remember(url, file){
    if(!url || !file) return;
    var loc = fileLoc.get(file);
    if(loc) urlLoc[url] = loc;
  }
  function payload(){ return Object.assign({}, urlLoc); }

  window.AervaPhotoLocation = { screen: screen, remember: remember, payload: payload, _fileLoc: fileLoc };
})();
