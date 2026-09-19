// /api/_audit-log.js
// Shared helper for writing to audit_log — used by every endpoint that
// takes a meaningful action (guest/host auth, listing approval,
// submissions, pricing changes, etc.). Not an API endpoint itself.
//
// Never throws: a failure to write an audit row should never break the
// actual action it's describing (e.g. a guest should still be able to log
// in even if the audit_log insert itself hits a problem). Logs to console
// instead, so it's still visible in Vercel's logs if the audit table has
// an issue of its own.

async function logAudit(sql, { action, success, actorType, actorIdentifier = null, targetType = null, targetId = null, metadata = {} }) {
  try {
    await sql`
      INSERT INTO audit_log (action, success, actor_type, actor_identifier, target_type, target_id, metadata)
      VALUES (${action}, ${success}, ${actorType}, ${actorIdentifier}, ${targetType}, ${targetId}, ${JSON.stringify(metadata)})
    `;
  } catch (err) {
    console.error('audit_log write failed:', action, err);
  }
}


// Who an admin request came from, for the audit log: the signed-in
// admin's email, or the shared ADMIN_SECRET fallback. Every admin action
// is recorded against a named person, never just "admin". Never throws.
async function adminActor(sql, sessionPayload, hasValidSecret) {
  try {
    if (sessionPayload && sessionPayload.action === 'admin-session') {
      const rows = await sql`SELECT email FROM admins WHERE id = ${Number(sessionPayload.listingId) || 0}`;
      return rows[0] && rows[0].email ? String(rows[0].email) : `admin #${sessionPayload.listingId}`;
    }
    return hasValidSecret ? 'admin (shared secret)' : 'unknown';
  } catch (err) {
    return sessionPayload ? `admin #${sessionPayload.listingId}` : 'unknown';
  }
}

module.exports = { logAudit, adminActor };
