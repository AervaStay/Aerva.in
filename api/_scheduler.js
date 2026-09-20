// /api/_scheduler.js — runs scheduled jobs at their own pace. Not an endpoint.
//
// Triggered by ONE external pinger every 5 minutes (cron-job.org →
// get-listings ?runSchedules=1), backed up by site traffic and the daily
// Vercel cron. Each call runs the jobs that are due, in priority order,
// within a time budget; anything not reached runs on the next call.
//   job: { name, label, everyMinutes | dailyAtHour (India time), lockMinutes, heavy, run(ctx) }
// A job is claimed with a lock in job_runs before it runs, so two triggers
// never run the same job at once. Its outcome is recorded for Admin →
// Scheduled jobs. Jobs are written to be safe to repeat.

async function ensureRow(sql, name) {
  await sql`INSERT INTO job_runs (name) VALUES (${name}) ON CONFLICT (name) DO NOTHING`;
}

// Claim a job if it is due (or forced) and not already running.
async function claim(sql, job, force) {
  await ensureRow(sql, job.name);
  const lock = job.lockMinutes || 5;
  if (force) {
    return (await sql`UPDATE job_runs SET locked_until = now() + make_interval(mins => ${lock}), last_started_at = now()
                      WHERE name = ${job.name} AND (locked_until IS NULL OR locked_until < now()) RETURNING name`).length > 0;
  }
  if (job.dailyAtHour != null) {
    return (await sql`UPDATE job_runs SET locked_until = now() + make_interval(mins => ${lock}), last_started_at = now()
                      WHERE name = ${job.name} AND (locked_until IS NULL OR locked_until < now())
                        AND extract(hour from now() AT TIME ZONE 'Asia/Kolkata') >= ${job.dailyAtHour}
                        AND (last_started_at IS NULL OR (last_started_at AT TIME ZONE 'Asia/Kolkata')::date < (now() AT TIME ZONE 'Asia/Kolkata')::date)
                      RETURNING name`).length > 0;
  }
  // 30 seconds' grace, so a 5-minute pinger does not slip to every 10.
  return (await sql`UPDATE job_runs SET locked_until = now() + make_interval(mins => ${lock}), last_started_at = now()
                    WHERE name = ${job.name} AND (locked_until IS NULL OR locked_until < now())
                      AND (last_started_at IS NULL OR last_started_at <= now() - make_interval(secs => ${job.everyMinutes * 60 - 30}))
                    RETURNING name`).length > 0;
}

async function finish(sql, name, ok, result, error) {
  await sql`UPDATE job_runs SET last_finished_at = now(), last_ok = ${ok}, last_result = ${result == null ? null : JSON.stringify(result)}::jsonb,
                               last_error = ${error ? String(error).slice(0, 500) : null}, runs = runs + 1,
                               failures = failures + ${ok ? 0 : 1}, locked_until = NULL
            WHERE name = ${name}`;
}

// Run what is due. opts: { budgetMs, only (job name), force (bool),
// forceDaily (bool), lightOnly (skip heavy jobs), ctx }.
async function runScheduled(sql, jobs, opts = {}) {
  const started = Date.now();
  const budget = opts.budgetMs || 8000;
  const out = { ran: [], skipped: [], failed: [] };
  let jobsTableMissing = false;
  for (const job of jobs) {
    if (opts.only && job.name !== opts.only) continue;
    if (opts.lightOnly && job.heavy) continue;
    if (Date.now() - started > budget) { out.skipped.push(job.name); continue; }
    const force = !!opts.force || (!!opts.forceDaily && job.dailyAtHour != null);
    let claimed;
    try { claimed = await claim(sql, job, force); }
    catch (err) {
      // Before migration_job_runs.sql: run on the old fixed schedule, unlocked.
      jobsTableMissing = true; claimed = true;
    }
    if (!claimed) continue;
    try {
      const result = await job.run(Object.assign({ remainingMs: Math.max(1000, budget - (Date.now() - started)) }, opts.ctx || {}));
      out.ran.push({ job: job.name, result });
      if (!jobsTableMissing) await finish(sql, job.name, true, result, null);
    } catch (err) {
      console.error(`scheduled job ${job.name} failed:`, err);
      out.failed.push({ job: job.name, error: String((err && err.message) || err) });
      if (!jobsTableMissing) { try { await finish(sql, job.name, false, null, (err && err.message) || err); } catch (e) { /* recorded next time */ } }
    }
  }
  out.ms = Date.now() - started;
  return out;
}

async function jobStatus(sql, jobs) {
  let rows = [];
  try { rows = await sql`SELECT * FROM job_runs`; } catch (err) { /* table not there yet */ }
  const byName = {}; rows.forEach(r => { byName[r.name] = r; });
  return jobs.map(j => {
    const r = byName[j.name] || {};
    return { name: j.name, label: j.label, schedule: j.dailyAtHour != null ? `Daily from ${j.dailyAtHour}:00 (India time)` : `Every ${j.everyMinutes} minutes`,
      lastStartedAt: r.last_started_at || null, lastFinishedAt: r.last_finished_at || null, lastOk: r.last_ok == null ? null : r.last_ok,
      lastResult: r.last_result || null, lastError: r.last_error || null, runs: r.runs || 0, failures: r.failures || 0,
      running: !!(r.locked_until && new Date(r.locked_until) > new Date()) };
  });
}

module.exports = { runScheduled, jobStatus };
