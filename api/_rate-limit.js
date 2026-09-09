// /api/_rate-limit.js
// DB-backed rate limiting, using the audit_log table that already
// exists and already records every login/signup attempt — no new
// infrastructure (Redis, Vercel Edge Config, etc.) needed. Deliberately
// NOT in-memory: a serverless function's memory doesn't reliably persist
// or get shared across invocations/instances, so an in-memory counter
// would silently fail to actually limit anything under real traffic.
// Not an API endpoint itself — the leading underscore is what tells
// Vercel that, same convention as _audit-log.js, _approval-token.js, etc.

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Counts matching audit_log rows in the trailing window. Pass byEmail
// and/or byIp — whichever is null is ignored, so a single call can check
// "this email" (catches one attacker repeatedly guessing one account's
// password) or "this IP" (catches one attacker spraying many different
// emails/accounts) or both together, without two separate query shapes.
// Fails OPEN (returns 0 / not-limited) on a DB error — a rate-limit
// check itself breaking should never be what blocks someone from
// logging in or booking.
async function countRecentAttempts(sql, { action, windowMinutes, byEmail = null, byIp = null, onlyFailures = false }) {
  try {
    const rows = await sql`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE action = ${action}
        AND created_at > NOW() - (${windowMinutes} || ' minutes')::interval
        AND (${onlyFailures} = false OR success = false)
        AND (${byEmail}::text IS NULL OR actor_identifier = ${byEmail})
        AND (${byIp}::text IS NULL OR metadata->>'ip' = ${byIp})
    `;
    return Number(rows[0]?.count || 0);
  } catch (err) {
    console.error('Rate limit check failed:', action, err);
    return 0;
  }
}

module.exports = { getClientIp, countRecentAttempts };
