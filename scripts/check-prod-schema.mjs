#!/usr/bin/env node
// LinkNMS production schema guard (LINA-62) — READ-ONLY.
//
//   node scripts/check-prod-schema.mjs
//
// Answers two questions about a live database, and exits non-zero — naming the
// exact file or grant — if either answer is wrong:
//
//   1. DRIFT.  Does platform.schema_migrations contain every migration file
//      present in this checkout, with matching checksums, and nothing extra?
//      The app deploys from `main` automatically; the schema does not. Without
//      this check code and schema drift apart silently and asymmetrically —
//      deploys always win, migrations always lag — and there is no signal until
//      a request hits the missing object in production. That is exactly how
//      0004_ledger_change_order_budget_grant.sql sat unapplied in prod after
//      PR #12 merged (LINA-51 close-out).
//
//   2. GRANT MATRIX.  Is the ledger's trust anchor still shaped the way the
//      migrations say it is? services/change_order/pg-store.test.mjs asserts
//      this against a throwaway container; a hand-applied widening in prod
//      would never be seen by that test. These are the same properties,
//      generalised over every *_app role, asserted where it counts.
//
// Read-only by construction: every statement is a SELECT against a catalog.
// It needs no write credential, so it is safe to run on a schedule or from a
// job that holds nothing more than a read-only connection string.
//
// Connection string, in precedence order (first one set wins):
//   READONLY_DATABASE_URL   — preferred: least privilege for a read-only check
//   MIGRATOR_DATABASE_URL   — the deploy job already has this one
//   DATABASE_URL
//
// Requires `psql` on PATH. Zero npm dependencies, matching db/migrate.mjs.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, migrationFiles, sha256 } from '../db/migration-files.mjs';

const DB_URL =
  process.env.READONLY_DATABASE_URL ||
  process.env.MIGRATOR_DATABASE_URL ||
  process.env.DATABASE_URL ||
  '';

if (!DB_URL) {
  console.error(
    'FATAL: no connection string. Set READONLY_DATABASE_URL (preferred),\n' +
      'MIGRATOR_DATABASE_URL, or DATABASE_URL.\n\n' +
      'In GitHub Actions these come from repository secrets. If this fired on a\n' +
      'push to main, the deploy gate is unprovisioned — see LINA-62.',
  );
  process.exit(2);
}

// ── psql plumbing ────────────────────────────────────────────────────────────
// -tA strips headers/alignment; -F $'\t' makes columns splittable. Every query
// below is a SELECT: this script never writes.
function query(sql) {
  const out = execFileSync(
    'psql',
    [DB_URL, '-v', 'ON_ERROR_STOP=1', '-tA', '-F', '\t', '-c', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('\t'));
}

const failures = [];
const fail = (headline, detail) => failures.push({ headline, detail });
const ok = (msg) => console.log(`  ok    ${msg}`);

// ── 1. Migration drift ───────────────────────────────────────────────────────
console.log('Migration ledger');

const hasLedger =
  query("select to_regclass('platform.schema_migrations') is not null")[0][0] === 't';

if (!hasLedger) {
  fail(
    'platform.schema_migrations does not exist',
    'The target database has never been migrated. Run `node db/migrate.mjs` as the migrator.',
  );
} else {
  const applied = new Map(
    query('select filename, checksum from platform.schema_migrations').map(
      ([f, c]) => [f, c],
    ),
  );
  const files = migrationFiles();

  const missing = files.filter((rel) => !applied.has(rel));
  if (missing.length) {
    fail(
      `${missing.length} migration(s) in the tree are NOT applied to this database`,
      missing.map((f) => `  - ${f}`).join('\n') +
        '\n\nThe deployed code expects these. Apply them as the migrator:\n' +
        '  MIGRATOR_DATABASE_URL=... node db/migrate.mjs',
    );
  } else {
    ok(`all ${files.length} migration file(s) applied`);
  }

  // A checksum mismatch means an already-applied file was edited in the tree.
  // Migrations are immutable once applied (ADR-0002 §4 / ADR-0006 §1) — the fix
  // is a new forward migration, never an edit. db/migrate.mjs fails on this too,
  // but only when it runs; this surfaces it on every push to main.
  const tampered = files
    .filter((rel) => applied.has(rel) && applied.get(rel) !== sha256(join(ROOT, rel)))
    .map((rel) => `  - ${rel}`);
  if (tampered.length) {
    fail(
      `${tampered.length} applied migration(s) were edited after being applied`,
      tampered.join('\n') +
        '\n\nMigrations are forward-only and immutable. Revert the edit and add a\n' +
        'new NNNN_*.sql instead.',
    );
  } else if (!missing.length) {
    ok('every applied checksum matches the file in this checkout');
  }

  // The reverse drift: a row with no file behind it. Means someone applied SQL
  // by hand, or a migration was deleted from the tree. Either way the tree no
  // longer describes the database.
  const inTree = new Set(files);
  const orphans = [...applied.keys()].filter((f) => !inTree.has(f)).map((f) => `  - ${f}`);
  if (orphans.length) {
    fail(
      `${orphans.length} migration(s) recorded in the database have no file in this checkout`,
      orphans.join('\n') +
        '\n\nThe database was changed outside the tree, or a migration file was deleted.',
    );
  }
}

// ── 2. Grant matrix ──────────────────────────────────────────────────────────
// Skipped entirely if the ledger schema isn't there yet — a fresh database
// failing check 1 shouldn't also emit a wall of confusing grant noise.
console.log('Ledger grant matrix');

const hasLedgerSchema =
  query("select to_regclass('ledger.budget_event') is not null")[0][0] === 't';

if (!hasLedgerSchema) {
  console.log('  skip  ledger.budget_event does not exist yet (see the drift failure above)');
} else {
  // (a) change_order_app's UPDATE on budget_event is column-scoped to the
  // audit_event_id back-link. A table-wide GRANT UPDATE would let it rewrite
  // delta_cents or project_id on any existing row — moving a project's budget
  // with no audit_event behind it. That is the one property the ledger exists
  // to make impossible, so it is checked first and phrased loudly.
  const updCols = query(
    `select column_name from information_schema.column_privileges
      where grantee = 'change_order_app' and table_schema = 'ledger'
        and table_name = 'budget_event' and privilege_type = 'UPDATE'
      order by column_name`,
  ).map(([c]) => c);
  if (updCols.length !== 1 || updCols[0] !== 'audit_event_id') {
    fail(
      'change_order_app UPDATE on ledger.budget_event is not column-scoped to audit_event_id',
      `got: [${updCols.join(', ') || '(none)'}], expected: [audit_event_id]\n\n` +
        'If this is wider, the budget can be moved with no audit event behind it.\n' +
        'Never fix a privilege error here by widening the grant — fix the query.',
    );
  } else {
    ok('change_order_app UPDATE on budget_event is column-scoped to audit_event_id');
  }

  // (b) No table-wide UPDATE and no DELETE. A column-scoped grant does NOT
  // appear in table_privileges, so seeing UPDATE here means someone widened it.
  const coTable = query(
    `select privilege_type from information_schema.table_privileges
      where grantee = 'change_order_app' and table_schema = 'ledger'
        and table_name = 'budget_event'
      order by privilege_type`,
  ).map(([p]) => p);
  const expected = ['INSERT', 'SELECT'];
  if (coTable.join(',') !== expected.join(',')) {
    fail(
      'change_order_app table-level privileges on ledger.budget_event have changed',
      `got: [${coTable.join(', ') || '(none)'}], expected: [${expected.join(', ')}]\n\n` +
        'A table-wide UPDATE here voids the column scope checked above.',
    );
  } else {
    ok('change_order_app holds only INSERT, SELECT at table level on budget_event');
  }

  // (c) ledger.audit_event stays write-locked to EVERY app role. The only
  // writer is ledger.append_event (SECURITY DEFINER). Generalised across all
  // *_app roles, not just change_order_app: a future service getting an
  // over-broad grant is the same breach.
  const auditWrites = query(
    `select grantee, privilege_type from information_schema.table_privileges
      where table_schema = 'ledger' and table_name = 'audit_event'
        and grantee like '%\\_app' and privilege_type <> 'SELECT'
      order by grantee, privilege_type`,
  ).map(([g, p]) => `  - ${g}: ${p}`);
  if (auditWrites.length) {
    fail(
      'an *_app role holds a write privilege on ledger.audit_event',
      auditWrites.join('\n') +
        '\n\naudit_event is append-only via ledger.append_event (ADR-0002 §4).\n' +
        'Direct writes bypass the hash chain — this voids the trust anchor.',
    );
  } else {
    ok('no *_app role holds any write privilege on ledger.audit_event');
  }

  // (d) The grant matrix only means anything if a role cannot inherit past it.
  // neon_superuser members bypass append_event entirely (LINA-35 finding).
  // `migrator` IS a member and is expected to be — it is not an app role.
  //
  // Covers the split-DB service roles (`%_app`) AND the marketing waitlist role
  // (`landing_app%`). The latter is watched by name because that is exactly the
  // role this check missed the first time: `landing_app` was created in the Neon
  // console (auto-granted neon_superuser) and, being outside the `%_app` net,
  // could have slipped a superuser regression past this guard. Its SQL-created
  // replacement `landing_app_v2` does not end in `_app`, so match the prefix
  // (LINA-96). `neondb_owner` is deliberately NOT matched — it is a superuser
  // member by design and is not an app credential.
  const superMembers = query(
    `select r2.rolname, r.rolname from pg_auth_members m
       join pg_roles r2 on r2.oid = m.member
       join pg_roles r  on r.oid = m.roleid
      where (r2.rolname like '%\\_app' or r2.rolname like 'landing\\_app%')
        and r.rolname in ('neon_superuser', 'postgres', 'cloud_admin', 'rds_superuser')
      order by r2.rolname`,
  ).map(([member, role]) => `  - ${member} inherits ${role}`);
  if (superMembers.length) {
    fail(
      'an app role inherits a superuser role',
      superMembers.join('\n') +
        '\n\nA superuser-inheriting app role bypasses every grant above, including\n' +
        'append_event. It cannot be fixed by a REVOKE (neon_superuser is not\n' +
        'revocable) — replace it with a SQL-created role (LINA-96 / LINA-35).',
    );
  } else {
    ok('no app role inherits a superuser role');
  }
}

// ── Verdict ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n${'='.repeat(72)}`);
  console.error(`PRODUCTION SCHEMA CHECK FAILED — ${failures.length} problem(s)\n`);
  for (const [i, f] of failures.entries()) {
    console.error(`${i + 1}. ${f.headline}\n${f.detail}\n`);
  }
  console.error('='.repeat(72));
  process.exit(1);
}

console.log('\nProduction schema check passed.');
