// /api/_migrations.js — database updates, applied from Admin → Database
// updates instead of by hand in Neon. Not an endpoint.
//
// Every change to the database is a .sql file in the repo's migrations/
// folder, named so it sorts in the order it must run:
//     migrations/2026-10-07-01-admin-lookup.sql
// It goes to UAT with the code (uat branch), is applied there from UAT's
// Admin, tested, and reaches production with the code when uat is merged
// into main — then applied from production's Admin. Nobody runs SQL in Neon.
//
// The table schema_migrations records what has run where: name, checksum
// of the file as it was applied, when, and by whom. Each file runs in ONE
// transaction — all of it or none of it. Its record is written first, so if
// two admins press Apply at once, the second waits and then fails cleanly
// instead of running the file twice.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const userError = (msg, status = 400) => Object.assign(new Error(msg), { isUserFacing: true, status });

function migrationsDir() {
  const tries = [path.join(process.cwd(), 'migrations'), path.join(__dirname, '..', 'migrations')];
  return tries.find(d => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } }) || null;
}

function readFiles() {
  const dir = migrationsDir();
  if (!dir) return [];
  return fs.readdirSync(dir).filter(f => /^[0-9A-Za-z][\w.-]*\.sql$/.test(f)).sort()
    .map(name => {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      return { name, text, checksum: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) };
    });
}

// Splits a SQL file into statements. Understands '…' strings (with ''),
// "…" names, $tag$ … $tag$ bodies (DO blocks, functions), -- and /* */
// comments, so a ; inside any of them never splits.
function splitStatements(sqlText) {
  const out = []; let cur = ''; let i = 0; const s = String(sqlText);
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (c === '-' && n === '-') { const e = s.indexOf('\n', i); const end = e === -1 ? s.length : e; cur += s.slice(i, end); i = end; continue; }
    if (c === '/' && n === '*') { const e = s.indexOf('*/', i + 2); const end = e === -1 ? s.length : e + 2; cur += s.slice(i, end); i = end; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < s.length) { if (s[j] === c) { if (s[j + 1] === c) { j += 2; continue; } break; } j++; }
      cur += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(s.slice(i));
      if (m) { const tag = m[0]; const e = s.indexOf(tag, i + tag.length); const end = e === -1 ? s.length : e + tag.length; cur += s.slice(i, end); i = end; continue; }
    }
    if (c === ';') { out.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  out.push(cur);
  // Drop pieces that are only whitespace and comments.
  return out.map(x => x.trim()).filter(x => x.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().length);
}

// Database updates never delete data — not on UAT, not on production.
// A file that would (DELETE, TRUNCATE, or DROP of a table, column, schema,
// view, sequence or type) is refused before anything in it runs, on UAT
// too, so it is caught there first. Dropping a constraint, index, default,
// NOT NULL, trigger, policy or function loses no data and is allowed.
// Returns the offending words, or null. Comments are ignored; text inside
// strings is NOT, so a DELETE hidden in an EXECUTE '…' is caught as well.
function deletesData(sqlText) {
  const code = String(sqlText).replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const m = /\b(TRUNCATE|DELETE\s+FROM)/i.exec(code)
    || /\bDROP\s+(?!CONSTRAINT\b|INDEX\b|DEFAULT\b|NOT\s+NULL\b|TRIGGER\b|POLICY\b|EXPRESSION\b|IDENTITY\b|FUNCTION\b|PROCEDURE\b)[A-Za-z_]+(\s+[A-Za-z_]+)?/i.exec(code);
  return m ? m[0].replace(/\s+/g, ' ').toUpperCase() : null;
}

async function ensureTable(sql) {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    statements INTEGER NOT NULL DEFAULT 0,
    applied_by TEXT,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms INTEGER
  )`;
}

// One query from plain text: the 0.x driver takes sql(text, params); the
// 1.x driver wants sql.query(text, params).
function textQuery(sql, text, params = []) {
  try { return sql(text, params); }
  catch (err) { if (typeof sql.query === 'function') return sql.query(text, params); throw err; }
}

async function status(sql) {
  await ensureTable(sql);
  const files = readFiles();
  const applied = await sql`SELECT name, checksum, statements, applied_by, applied_at, duration_ms FROM schema_migrations ORDER BY name`;
  const byName = new Map(applied.map(a => [a.name, a]));
  const list = files.map(f => {
    const a = byName.get(f.name);
    return { name: f.name, checksum: f.checksum, statements: splitStatements(f.text).length, sql: f.text,
             applied: !!a, appliedAt: a ? a.applied_at : null, appliedBy: a ? a.applied_by : null, durationMs: a ? a.duration_ms : null,
             changedSinceApplied: !!(a && a.checksum !== f.checksum),
             deletesData: a ? null : deletesData(f.text) };
  });
  // Recorded here but no longer in the folder (renamed or deleted file).
  const missing = applied.filter(a => !files.some(f => f.name === a.name)).map(a => ({ name: a.name, appliedAt: a.applied_at }));
  return { folderFound: !!migrationsDir(), migrations: list, pending: list.filter(m => !m.applied).length, missing };
}

async function pendingCount(sql) {
  try { return (await status(sql)).pending; } catch (e) { return null; }
}

// Applies pending files in order, each in its own transaction. Stops at the
// first failure (later files may depend on it). onlyName: just that one,
// and only if it is the next pending file.
async function applyPending(sql, { adminLabel, onlyName = null } = {}) {
  const st = await status(sql);
  const pending = st.migrations.filter(m => !m.applied);
  if (!pending.length) return { applied: [], message: 'Nothing to apply — the database is up to date.' };
  if (onlyName && pending[0].name !== onlyName) throw userError(`Apply ${pending[0].name} first — files run in order.`, 409);
  const todo = onlyName ? [pending[0]] : pending;
  const bad = todo.find(m => m.deletesData);
  if (bad) throw userError(`${bad.name} would delete data (${bad.deletesData}), and database updates never delete anything — nothing was applied. Replace it with a file that keeps the data.`, 400);
  const done = [];
  for (const m of todo) {
    const statements = splitStatements(m.sql);
    const started = Date.now();
    try {
      await sql.transaction([
        textQuery(sql, 'INSERT INTO schema_migrations (name, checksum, statements, applied_by) VALUES ($1, $2, $3, $4)', [m.name, m.checksum, statements.length, adminLabel || 'admin']),
        ...statements.map(t => textQuery(sql, t))
      ]);
      const ms = Date.now() - started;
      await sql`UPDATE schema_migrations SET duration_ms = ${ms} WHERE name = ${m.name}`;
      done.push({ name: m.name, statements: statements.length, ms });
    } catch (err) {
      const why = String(err && err.message || err);
      const dup = /schema_migrations_pkey|duplicate key/i.test(why);
      throw Object.assign(userError(dup ? `${m.name} was just applied by someone else.` : `${m.name} failed and was rolled back — nothing in it was applied. ${why.slice(0, 400)}`, dup ? 409 : 400), { applied: done, failed: m.name });
    }
  }
  return { applied: done };
}

module.exports = { status, applyPending, pendingCount, splitStatements, readFiles, deletesData };
