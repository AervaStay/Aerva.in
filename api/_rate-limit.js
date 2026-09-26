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

// Counts matching audit_log rows in the trailing window. Pass byActor
// (or its older alias byEmail — the column is actor_identifier, which
// holds an email on the email-login paths and an E.164 phone number on
// the OTP path) and/or byIp — whichever is null is ignored, so a single
// call can check "this account" (catches one attacker repeatedly
// guessing one account's password, or burning SMS on one number) or
// "this IP" (catches one attacker spraying many different
// emails/numbers) or both together, without two separate query shapes.
// Fails OPEN (returns 0 / not-limited) on a DB error — a rate-limit
// check itself breaking should never be what blocks someone from
// logging in or booking.
// sinceSuccessOf (an action, or a list of them): only count rows newer than
// this actor's latest successful row of any of those actions.
// reasons: only count rows whose metadata.reason is one of these. (e.g. a completed password reset wipes the slate for
// failed logins, as the lockout message promises).
async function countRecentAttempts(sql, { action, windowMinutes, byActor = null, byEmail = null, byIp = null, onlyFailures = false, sinceSuccessOf = null, reasons = null }) {
  const actor = byActor !== null ? byActor : byEmail;
  try {
    const rows = await sql`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE action = ${action}
        AND created_at > NOW() - (${windowMinutes} || ' minutes')::interval
        AND (${onlyFailures} = false OR success = false)
        AND (${actor}::text IS NULL OR actor_identifier = ${actor})
        AND (${byIp}::text IS NULL OR metadata->>'ip' = ${byIp})
        AND (${reasons ? [].concat(reasons) : null}::text[] IS NULL OR metadata->>'reason' = ANY(${reasons ? [].concat(reasons) : null}::text[]))
        AND (${sinceSuccessOf ? [].concat(sinceSuccessOf) : null}::text[] IS NULL OR created_at > COALESCE((
          SELECT max(r.created_at) FROM audit_log r
          WHERE r.action = ANY(${sinceSuccessOf ? [].concat(sinceSuccessOf) : null}::text[]) AND r.success = true AND r.actor_identifier = ${actor}
        ), '-infinity'::timestamptz))
    `;
    return Number(rows[0]?.count || 0);
  } catch (err) {
    console.error('Rate limit check failed:', action, err);
    return 0;
  }
}

module.exports = { getClientIp, countRecentAttempts };
