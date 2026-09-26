// /api/_timezones.js
// Which clock a listing runs on. Not an API endpoint itself — the
// leading underscore tells Vercel that.
//
// Every date a guest or host cares about belongs to the PROPERTY's
// calendar, not the server's: check-in on the 3rd means the 3rd where the
// property stands. The database runs in UTC, which is 5h30m behind India,
// so without this a host opening the dashboard at 6am IST saw yesterday.
//
// Stored per listing (listings.timezone) rather than worked out on every
// read: a property does not move, and a stored value can be corrected by
// hand when a guess is wrong.

// Countries Aerva takes listings in, or plausibly will. Names are matched
// against the address the host picked, so the spellings here are the ones
// a geocoder returns.
const COUNTRY_TIMEZONES = [
  { match: ['india'],                                  zone: 'Asia/Kolkata' },
  { match: ['united arab emirates', 'uae'],            zone: 'Asia/Dubai' },
  { match: ['sri lanka'],                              zone: 'Asia/Colombo' },
  { match: ['nepal'],                                  zone: 'Asia/Kathmandu' },
  { match: ['bangladesh'],                             zone: 'Asia/Dhaka' },
  { match: ['bhutan'],                                 zone: 'Asia/Thimphu' },
  { match: ['maldives'],                               zone: 'Indian/Maldives' },
  { match: ['thailand'],                               zone: 'Asia/Bangkok' },
  { match: ['singapore'],                              zone: 'Asia/Singapore' },
  { match: ['indonesia', 'bali'],                      zone: 'Asia/Jakarta' },
  { match: ['united kingdom', 'england', 'scotland'],  zone: 'Europe/London' },
  { match: ['france'],                                 zone: 'Europe/Paris' },
  { match: ['germany'],                                zone: 'Europe/Berlin' },
  { match: ['italy'],                                  zone: 'Europe/Rome' },
  { match: ['spain'],                                  zone: 'Europe/Madrid' },
  { match: ['australia'],                              zone: 'Australia/Sydney' },
  { match: ['new zealand'],                            zone: 'Pacific/Auckland' },
  { match: ['japan'],                                  zone: 'Asia/Tokyo' },
  { match: ['united states', 'usa'],                   zone: 'America/New_York' },
  { match: ['canada'],                                 zone: 'America/Toronto' }
];

// Where essentially every Aerva property is. Used when an address gives
// nothing to go on, which is better than leaving a listing without a
// clock at all.
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

// Reads the country off the end of a formatted address. Geocoders put the
// country last ("…, Maharashtra 412101, India"), so the match is done on
// the whole string and the longest name wins — otherwise "India" inside
// "British Indian Ocean Territory" would decide it.
function timezoneForAddress(formattedAddress) {
  const text = String(formattedAddress || '').toLowerCase();
  if (!text) return DEFAULT_TIMEZONE;
  let longest = '';
  let zone = DEFAULT_TIMEZONE;
  COUNTRY_TIMEZONES.forEach(entry => {
    entry.match.forEach(name => {
      if (text.includes(name) && name.length > longest.length) {
        longest = name;
        zone = entry.zone;
      }
    });
  });
  return zone;
}

// A Postgres-safe zone name. Anything unrecognised falls back rather than
// reaching a query, where a bad zone raises an error mid-request.
const KNOWN_ZONES = new Set(COUNTRY_TIMEZONES.map(e => e.zone).concat([DEFAULT_TIMEZONE]));
function safeZone(zone) {
  const z = String(zone || '').trim();
  return KNOWN_ZONES.has(z) ? z : DEFAULT_TIMEZONE;
}

// Today's date (YYYY-MM-DD) on the property's own calendar. A host in
// India opening the calendar at 2am IST is already on the next day,
// while the server (UTC) is still on the previous one.
function localTodayIn(zone, now = new Date()) {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', { timeZone: safeZone(zone), year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch (e) {
    return now.toISOString().slice(0, 10);
  }
}

module.exports = { COUNTRY_TIMEZONES, DEFAULT_TIMEZONE, timezoneForAddress, safeZone, localTodayIn };
