// /api/_tier-history.js
// Records a change of standing for a host, guest or listing. Not an API
// endpoint itself — the leading underscore is what tells Vercel that,
// same convention as _tiers.js and _review-policy.js.
//
// Writes only on CHANGE. The daily sweep recomputes every subject, but a
// row per subject per day would bury the handful of real transitions in
// tens of thousands of identical rows, and "when did this listing become
// Outstanding" would become a query nobody wants to write.
//
// Never throws. A history write failing must not take down the sweep that
// produced it, any more than an audit_log failure should break a login.

async function recordTierChange(sql, { subjectType, subjectId, tier, score = null, reviewCount = null, metric = null, cutoffs = null }) {
  try {
    const key = tier && tier.key ? tier.key : null;
    const label = tier && tier.label ? tier.label : null;

    const existing = await sql`
      SELECT tier_key FROM tier_current
      WHERE subject_type = ${subjectType} AND subject_id = ${subjectId}
    `;
    const previous = existing.length ? existing[0].tier_key : undefined;

    // undefined means no row yet — first sight of this subject. A first
    // sighting with no badge is not a transition worth logging; it is just
    // the starting state, and logging it would fill the table with
    // "nothing happened" on the first run after deploy.
    const isFirstSight = previous === undefined;
    const changed = isFirstSight ? key !== null : previous !== key;

    await sql`
      INSERT INTO tier_current (subject_type, subject_id, tier_key, score, review_count, metric, updated_at)
      VALUES (${subjectType}, ${subjectId}, ${key}, ${score}, ${reviewCount}, ${metric}, now())
      ON CONFLICT (subject_type, subject_id) DO UPDATE
        SET tier_key = EXCLUDED.tier_key, score = EXCLUDED.score,
            review_count = EXCLUDED.review_count, metric = EXCLUDED.metric,
            updated_at = now()
    `;

    if (!changed) return { changed: false };

    await sql`
      INSERT INTO tier_history
        (subject_type, subject_id, tier_key, tier_label, previous_key, score, review_count, metric, cutoffs)
      VALUES
        (${subjectType}, ${subjectId}, ${key}, ${label}, ${isFirstSight ? null : previous},
         ${score}, ${reviewCount}, ${metric}, ${cutoffs ? JSON.stringify(cutoffs) : null})
    `;
    return { changed: true, from: isFirstSight ? null : previous, to: key };
  } catch (err) {
    console.error('recordTierChange failed (non-fatal):', subjectType, subjectId, err);
    return { changed: false, error: true };
  }
}

async function tierHistoryFor(sql, subjectType, subjectId, limit = 50) {
  try {
    return await sql`
      SELECT tier_key, tier_label, previous_key, score, review_count, metric, cutoffs, changed_at
      FROM tier_history
      WHERE subject_type = ${subjectType} AND subject_id = ${subjectId}
      ORDER BY changed_at DESC
      LIMIT ${limit}
    `;
  } catch (err) {
    console.error('tierHistoryFor failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------
// Admin corrections
//
// Badges otherwise move only on a quarterly review day. An admin revert is
// the exception: the badge it affected is corrected within 48 hours (in
// practice at the next daily sweep, 02:00 UTC) by re-running the LAST
// quarterly review for just the affected subjects, with the reverted
// review left out. Nobody else's badge moves.
//
// Requests are queued in site_settings rather than a new table, so this
// needs no migration. Each entry: { type: 'host'|'guest'|'listing', id,
// reason, at }. type 'listing' re-ranks every listing, because property
// bands are relative: removing one review can move the cutoffs.
const QUEUE_KEY = 'tier_recompute_queue';
const LAST_RUN_KEY = 'tier_snapshot_last_run';

// Appends atomically (jsonb concatenation in one statement), so two admins
// reverting at the same moment cannot overwrite each other's request.
// Returns false on failure rather than throwing: the revert itself has
// already succeeded and must not be reported as failed.
async function requestTierRecompute(sql, entries) {
  const list = (entries || []).filter(e => e && e.type).map(e => ({
    type: e.type, id: e.id == null ? null : Number(e.id),
    reason: e.reason || null, at: new Date().toISOString()
  }));
  if (!list.length) return true;
  try {
    await sql`
      INSERT INTO site_settings (key, value, updated_at)
      VALUES (${QUEUE_KEY}, ${JSON.stringify(list)}::jsonb, now())
      ON CONFLICT (key) DO UPDATE
        SET value = COALESCE(site_settings.value, '[]'::jsonb) || EXCLUDED.value, updated_at = now()
    `;
    return true;
  } catch (err) {
    console.error('requestTierRecompute failed:', err);
    return false;
  }
}

async function pendingTierRecomputes(sql) {
  try {
    const rows = await sql`SELECT value FROM site_settings WHERE key = ${QUEUE_KEY}`;
    const v = rows[0] && rows[0].value;
    return Array.isArray(v) ? v : [];
  } catch (err) {
    console.error('pendingTierRecomputes failed:', err);
    return [];
  }
}

// Removes only entries requested at or before `upTo` (an ISO string), so
// a request made while a sweep was running is kept for the next one
// instead of being silently dropped.
async function clearTierRecomputes(sql, upTo) {
  try {
    await sql`
      UPDATE site_settings
      SET value = (
            SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
            FROM jsonb_array_elements(value) e
            WHERE (e->>'at') > ${upTo}
          ),
          updated_at = now()
      WHERE key = ${QUEUE_KEY}
    `;
  } catch (err) {
    console.error('clearTierRecomputes failed:', err);
  }
}

// When the last full snapshot (quarterly, or forced) started. Corrections
// re-run the review "as of" this moment.
async function lastSnapshotRun(sql) {
  try {
    const rows = await sql`SELECT value FROM site_settings WHERE key = ${LAST_RUN_KEY}`;
    const v = rows[0] && rows[0].value;
    return typeof v === 'string' ? v : null;
  } catch (err) {
    console.error('lastSnapshotRun failed:', err);
    return null;
  }
}

async function markSnapshotRun(sql, startedAt) {
  await sql`
    INSERT INTO site_settings (key, value, updated_at)
    VALUES (${LAST_RUN_KEY}, ${JSON.stringify(startedAt)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

// The standing each subject held just BEFORE a given moment, read from the
// change log. Used by corrections so the one-rung decay cap is measured
// against what the subject held going into that review, not against what
// the review (with the bad data) gave them.
async function standingBefore(sql, subjectType, at) {
  const rows = await sql`
    SELECT DISTINCT ON (subject_id) subject_id, tier_key
    FROM tier_history
    WHERE subject_type = ${subjectType} AND changed_at < ${at}
    ORDER BY subject_id, changed_at DESC
  `;
  const out = {};
  rows.forEach(r => { out[r.subject_id] = r.tier_key; });
  return out;
}

module.exports = {
  recordTierChange, tierHistoryFor,
  requestTierRecompute, pendingTierRecomputes, clearTierRecomputes,
  lastSnapshotRun, markSnapshotRun, standingBefore
};
