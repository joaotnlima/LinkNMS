// Shared migration-set enumeration (LINA-62).
//
// The forward-only runner (db/migrate.mjs) and the production drift detector
// (scripts/check-prod-schema.mjs) must agree, exactly, on "which files are
// migrations and in what order". Two copies of that rule would drift, and the
// whole point of the detector is that drift is caught rather than discovered in
// production — so the rule lives here once and both import it.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function sha256(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

// db/roles.sql is deliberately NOT part of this set: it is idempotent, always
// applied, and never recorded (it must run before platform.schema_migrations
// exists). See the note in db/migrate.mjs.
export const ROLES_FILE = 'db/roles.sql';

function serviceMigrations(root) {
  const svcRoot = join(root, 'services');
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

// The v2 (to-be) model: db/v2/NNNN_*.sql is the bootstrap DDL (all 13 module
// schemas in one verified unit — see db/v2/README.md), then per-module forward
// migrations under modules/<module>/migrations/NNNN_*.sql. Seed and checks in
// db/v2 are deliberately excluded: they are test artefacts, never migrations.
function v2Migrations(root) {
  const out = [];
  const bootDir = join(root, 'db', 'v2');
  if (existsSync(bootDir)) {
    for (const f of readdirSync(bootDir).sort()) {
      if (/^\d{4}_.*\.sql$/.test(f)) out.push(`db/v2/${f}`);
    }
  }
  const modRoot = join(root, 'modules');
  if (existsSync(modRoot)) {
    for (const mod of readdirSync(modRoot).sort()) {
      const dir = join(modRoot, mod, 'migrations');
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).sort()) {
        if (f.endsWith('.sql') && !f.endsWith('.test.sql')) {
          out.push(`modules/${mod}/migrations/${f}`);
        }
      }
    }
  }
  return out;
}

// db/0001_platform.sql (creates platform.schema_migrations) first, then every
// v1 service migration sorted by (service, NNNN), then the v2 set (bootstrap
// before module migrations). Repo-relative paths — these are the exact strings
// recorded in platform.schema_migrations.filename.
export function migrationFiles(root = ROOT) {
  return [
    'db/0001_platform.sql',
    ...serviceMigrations(root),
    ...v2Migrations(root),
  ].filter((rel) => existsSync(join(root, rel)));
}
