// /api/_admin-auth.js
// Admin sign-in checks shared by the admin endpoints. Not an API endpoint
// itself (leading underscore). approve-listing.js has its own copy of the
// same logic; the two must stay the same.

const { secretMatches } = require('./_approval-token');
const { logAudit, requestContext } = require('./_audit-log');
const { countRecentAttempts, getClientIp } = require('./_rate-limit');

// Wrong x-admin-secret guesses allowed per 15 minutes: per address, and
// in total (so spreading guesses over many addresses does not help).
const SECRET_WINDOW_MINUTES = 15;
const SECRET_MAX_PER_IP = 5;
const SECRET_MAX_TOTAL = 30;

// The admin's current session_version (migration_admin_session_version.sql),
// or null when the admin row no longer exists. Before that migration the
// column is absent and every admin is version 0. Throws on a DB error.
async function adminSessionVersion(sql, adminId) {
  const rows = await sql`SELECT to_jsonb(a)->>'session_version' AS sv FROM admins a WHERE a.id = ${Number(adminId) || 0}`;
  if (!rows[0]) return null;
  return Number(rows[0].sv) || 0;
}

// An admin session is a signed token, so on its own it cannot be taken
// back. It stops working when the admin account is deleted, or when its
// session_version is raised — tokens carry the version they were issued
// under as { sv }; tokens without one are version 0. Fails closed.
async function adminSessionActive(sql, payload) {
  if (!payload || payload.action !== 'admin-session') return false;
  try {
    const current = await adminSessionVersion(sql, payload.listingId);
    if (current === null) return false;
    return (Number(payload.sv) || 0) === current;
  } catch (err) {
    console.error('admin session check failed (refusing):', err.message);
    return false;
  }
}

// The { sv } to sign into a new admin session token. 0 if it cannot be
// read — a token issued at 0 then simply fails the check above if the
// real version is higher, which is the safe direction.
async function sessionExtra(sql, adminId) {
  try {
    const v = await adminSessionVersion(sql, adminId);
    return { sv: v || 0 };
  } catch (err) {
    return { sv: 0 };
  }
}

// "Sign out everywhere": every token issued before this stops working.
// Returns the new version, or throws with isUserFacing when the column is
// not there yet (the migration has not been run).
async function bumpSessionVersion(sql, adminId) {
  try {
    const rows = await sql`UPDATE admins SET session_version = session_version + 1 WHERE id = ${Number(adminId) || 0} RETURNING session_version`;
    return rows[0] ? Number(rows[0].session_version) : null;
  } catch (err) {
    if (/session_version/.test(String(err.message))) {
      const e = new Error('Run sql/migration_admin_session_version.sql first.');
      e.isUserFacing = true;
      throw e;
    }
    throw err;
  }
}

// Checks an x-admin-secret header. Wrong guesses are counted (audit_log)
// and a caller that keeps guessing is turned away before the secret is
// even compared. Returns { ok, limited }. No header → { ok: false }.
async function checkAdminSecret(sql, req, source) {
  const given = req.headers['x-admin-secret'];
  if (!given) return { ok: false, limited: false };
  const ip = getClientIp(req);
  const [fromIp, fromAll] = await Promise.all([
    countRecentAttempts(sql, { action: 'admin_secret_failed', windowMinutes: SECRET_WINDOW_MINUTES, byIp: ip, onlyFailures: true }),
    countRecentAttempts(sql, { action: 'admin_secret_failed', windowMinutes: SECRET_WINDOW_MINUTES, onlyFailures: true })
  ]);
  if (fromIp >= SECRET_MAX_PER_IP || fromAll >= SECRET_MAX_TOTAL) return { ok: false, limited: true };
  const ok = secretMatches(given, process.env.ADMIN_SECRET);
  if (!ok) {
    await logAudit(sql, { action: 'admin_secret_failed', success: false, actorType: 'system', actorIdentifier: source,
      metadata: { ip, userAgent: requestContext(req).userAgent } });
  }
  return { ok, limited: false };
}

module.exports = { adminSessionActive, adminSessionVersion, sessionExtra, bumpSessionVersion, checkAdminSecret,
  SECRET_WINDOW_MINUTES, SECRET_MAX_PER_IP, SECRET_MAX_TOTAL };
