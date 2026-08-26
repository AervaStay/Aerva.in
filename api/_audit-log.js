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

module.exports = { logAudit };
