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

async function logAudit(sql, { action, success, actorType, actorIdentifier = null, targetType = null, targetId = null, metadata = {},
                                adminId = null, ip = null, userAgent = null }) {
  try {
    await sql`
      INSERT INTO audit_log (action, success, actor_type, actor_identifier, target_type, target_id, metadata)
      VALUES (${action}, ${success}, ${actorType}, ${actorIdentifier}, ${targetType}, ${targetId}, ${JSON.stringify(metadata)})
    `;
  } catch (err) {
    console.error('audit_log write failed:', action, err);
  }
  // Every admin action is ALSO written to admin_audit_log: append-only at
  // the database level (see migration_admin_audit_log.sql — updates and
  // deletes are refused by a trigger), with the admin's id, IP and device.
  // Separate try: a problem here never blocks the action or the main log.
  if (actorType === 'admin') {
    try {
      const m = metadata || {};
      await sql`
        INSERT INTO admin_audit_log (admin_id, admin_email, action, success, target_type, target_id, details, ip, user_agent)
        VALUES (${adminId == null ? null : Number(adminId) || null}, ${actorIdentifier}, ${action}, ${success !== false},
                ${targetType}, ${targetId == null ? null : Number(targetId) || null}, ${JSON.stringify(m)},
                ${ip || m.ip || m.clientIp || null}, ${userAgent ? String(userAgent).slice(0, 300) : null})
      `;
    } catch (err) {
      console.error('admin_audit_log write failed:', action, err.message);
    }
  }
}

// Where a request came from: IP (first address Vercel forwards) and device.
function requestContext(req) {
  const h = (req && req.headers) || {};
  const fwd = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || String(h['x-real-ip'] || '') || (req && req.socket && req.socket.remoteAddress) || null;
  const ua = h['user-agent'] ? String(h['user-agent']).slice(0, 300) : null;
  return { ip: ip || null, userAgent: ua };
}

// Everything an admin log entry needs, worked out once per request:
// { actorIdentifier (email), adminId, ip, userAgent }.
async function adminContext(sql, req, sessionPayload, hasValidSecret) {
  const actorIdentifier = await adminActor(sql, sessionPayload, hasValidSecret);
  const adminId = sessionPayload && sessionPayload.action === 'admin-session' ? Number(sessionPayload.listingId) || null : null;
  return { actorIdentifier, adminId, ...requestContext(req) };
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

module.exports = { logAudit, adminActor, adminContext, requestContext };
