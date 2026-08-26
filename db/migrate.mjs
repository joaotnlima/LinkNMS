#!/usr/bin/env node
// LinkNMS forward-only migration runner (Slice 0, ADR-0006 §1).
//
//   node db/migrate.mjs [--dry-run]
//
// Connects as the migrator (DATABASE_URL / MIGRATOR_DATABASE_URL — a role that
// owns DDL) and applies every not-yet-applied migration in a deterministic order:
//
//   1. db/roles.sql            — roles (idempotent; may need the platform owner)
//   2. db/0001_platform.sql    — platform schema + the five service schemas + grants
//   3. services/<svc>/migrations/NNNN_*.sql   — per-service DDL, sorted by (svc, NNNN)
//
// Each file is applied inside a single transaction; on success its filename +
// sha256 are recorded in platform.schema_migrations so it never runs again.
// Forward-only: applied files are immutable — editing one is a checksum error,
// not a silent re-apply. No secrets are read from disk; the connection string
// comes from the environment (secret manager in CI/preview).
//
// Requires `psql` on PATH (present in every Postgres CI image and locally via
// libpq). Zero npm dependencies by design.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.argv.includes('--dry-run');

const DB_URL =
  process.env.MIGRATOR_DATABASE_URL || process.env.DATABASE_URL || '';
if (!DB_URL) {
  console.error('FATAL: set MIGRATOR_DATABASE_URL or DATABASE_URL (migrator role).');
  process.exit(2);
}

// psql helpers ---------------------------------------------------------------
function psql(args, input) {
  return execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', ...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}
// Run a whole file wrapped in one transaction, then record it — atomically.
function applyFile(rel, checksum) {
  const abs = join(ROOT, rel);
  const record =
    `INSERT INTO platform.schema_migrations (filename, checksum) ` +
    `VALUES ('${rel.replace(/'/g, "''")}', '${checksum}');`;
  // \i runs the file; BEGIN/COMMIT make file + ledger-row one unit.
  const sql = `BEGIN;\n\\i ${abs}\n${record}\nCOMMIT;\n`;
  psql(['-q'], sql);
}
function queryScalarRows(sql) {
  const out = psql(['-tA', '-c', sql]);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

// Migration set (deterministic order) ----------------------------------------
function sha256(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}
function serviceMigrations() {
  const svcRoot = join(ROOT, 'services');
  if (!existsSync(svcRoot)) return [];
  const out = [];
  for (const svc of readdirSync(svcRoot).sort()) {
    const dir = join(svcRoot, svc, 'migrations');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith('.sql') && !f.endsWith('.test.sql')) {
        out.push(`services/${svc}/migrations/${f}`);
      }
    }
  }
  return out;
}
// db/0001_platform.sql (creates platform.schema_migrations) first, then every
// service migration. db/roles.sql is handled separately below: it must run
// BEFORE the platform grants that reference the roles, yet it runs before the
// ledger table exists — so it is idempotent and always applied, never recorded.
const ROLES_FILE = 'db/roles.sql';
const FILES = ['db/0001_platform.sql', ...serviceMigrations()];

// Run ------------------------------------------------------------------------
// Bootstrap: the ledger table lives in db/0001_platform.sql, so before it exists
// there is nothing to read. Treat a missing table as "nothing applied yet".
let applied = new Map();
// to_regclass returns NULL (not an error) when the ledger table doesn't exist
// yet, so a fresh database bootstraps quietly instead of logging a scary ERROR.
const hasLedger =
  queryScalarRows("SELECT to_regclass('platform.schema_migrations') IS NOT NULL")
    .join('') === 't';
if (hasLedger) {
  const rows = queryScalarRows(
    'SELECT filename || $$\t$$ || checksum FROM platform.schema_migrations',
  );
  applied = new Map(rows.map((r) => r.split('\t')));
}

// Roles bootstrap: always applied (idempotent DO-blocks), never recorded — the
// ledger table it would record into does not exist yet on a fresh database, and
// re-running it is a safe no-op. It cannot ride the atomic apply+record path.
if (existsSync(join(ROOT, ROLES_FILE))) {
  console.log(`${DRY_RUN ? 'would apply' : 'applying'}  ${ROLES_FILE} (idempotent)`);
  if (!DRY_RUN) psql(['-q', '-f', join(ROOT, ROLES_FILE)]);
}

let ran = 0;
for (const rel of FILES) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue;
  const sum = sha256(abs);
  if (applied.has(rel)) {
    if (applied.get(rel) !== sum) {
      console.error(
        `FATAL: ${rel} changed after it was applied (forward-only violation). ` +
          `Add a new migration instead of editing this one.`,
      );
      process.exit(1);
    }
    continue; // already applied, unchanged
  }
  console.log(`${DRY_RUN ? 'would apply' : 'applying'}  ${rel}`);
  if (!DRY_RUN) applyFile(rel, sum);
  ran++;
}

console.log(
  DRY_RUN
    ? `dry-run: ${ran} migration(s) pending.`
    : `done: ${ran} migration(s) applied, ${FILES.length - ran} already current.`,
);
