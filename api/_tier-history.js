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

module.exports = { recordTierChange, tierHistoryFor };
