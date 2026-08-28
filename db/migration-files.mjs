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

// db/0001_platform.sql (creates platform.schema_migrations) first, then every
// service migration sorted by (service, NNNN). Repo-relative paths — these are
// the exact strings recorded in platform.schema_migrations.filename.
export function migrationFiles(root = ROOT) {
  return ['db/0001_platform.sql', ...serviceMigrations(root)].filter((rel) =>
    existsSync(join(root, rel)),
  );
}
