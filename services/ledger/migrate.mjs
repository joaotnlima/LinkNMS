// Forward-only migration runner for the ledger schema (ADR-0006 §1).
//
// Applies every services/ledger/migrations/*.sql in filename order, tracking
// applied files in ledger.schema_migrations so re-runs are idempotent. In R0
// this runs as the migrator/owner role (the only role that runs DDL). CI runs it
// before deploy; tests run it against an ephemeral Neon branch.
//
// Usage: DATABASE_URL=... node services/ledger/migrate.mjs
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPool } from './db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

export async function migrate(pool) {
  // `create schema if not exists` is NOT free when the schema already exists:
  // Postgres checks CREATE on the database BEFORE the existence check, so on a
  // managed database where the migrator is not the database owner (Neon: the
  // owner is `neondb_owner`) it fails 42501 even though there is nothing to do.
  // Ask first, so a role that may use the schema but not create one still gets
  // through — the migrations themselves need no database-level privilege.
  const { rowCount } = await pool.query(
    "select 1 from pg_namespace where nspname = 'ledger'",
  );
  if (rowCount === 0) await pool.query('create schema ledger');

  await pool.query(`
    create table if not exists ledger.schema_migrations (
      filename    text primary key,
      applied_at  timestamptz not null default now()
    );
  `);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = [];
  for (const filename of files) {
    const done = await pool.query(
      'select 1 from ledger.schema_migrations where filename = $1',
      [filename],
    );
    if (done.rowCount > 0) continue;

    const sql = await readFile(join(migrationsDir, filename), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'insert into ledger.schema_migrations (filename) values ($1)',
        [filename],
      );
      await client.query('COMMIT');
      applied.push(filename);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${filename} failed: ${err.message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return applied;
}

// Run directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool();
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date (no pending migrations)');
  } finally {
    await pool.end();
  }
}
