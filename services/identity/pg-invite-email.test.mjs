// Postgres integration test for invite-by-email (LINA-84; ADR-0008 §4).
//
// Runs against a real Postgres (a throwaway Neon branch forked from production,
// or the CI container) — set DATABASE_URL to the migrator/owner connection.
// Without it the suite skips, so CI on a machine with no DB stays green while
// the DB job runs the real thing (same convention as pg-sign-in.test.mjs).
//
// What it proves beyond the in-memory tests:
//   * 0004_identity.sql APPLIES on top of the platform + ledger + identity
//     migrations, and is REPLAYABLE (running it twice is not an error);
//   * the new column is reachable through identity_app's EXISTING grants — a
//     table-level privilege covers a column added later, so this migration needs
//     no new grant and MUST NOT have widened the matrix;
//   * the normalisation invariant is enforced by the DB, not only the service: a
//     mixed-case address is rejected by the CHECK;
//   * the out-of-band path still writes a NULL email;
//   * ── THE GRANT REGRESSION ──────────────────────────────────────────────────
//     identity_app's privileges on identity.invitation are EXACTLY
//     SELECT/INSERT/UPDATE — no DELETE, no TRUNCATE — and it holds nothing at
//     all on identity.seat beyond what ADR-0008 grants. `identity.seat` does not
//     exist on any branch yet (that is the open half of LINA-84), so the seat
//     assertion below is written to be true today AND to start failing loudly
//     the moment a seat table appears with an INSERT grant nobody reviewed.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool, sslFor } from '../ledger/db.mjs';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const DB = process.env.DATABASE_URL;
const ssl = sslFor(DB);

const MIGRATIONS = [
  'db/0001_platform.sql',
  'services/ledger/migrations/0001_ledger.sql',
  'services/ledger/migrations/0002_ledger_roles.sql',
  'services/identity/migrations/0001_identity.sql',
  'services/identity/migrations/0002_identity.sql',
  'services/identity/migrations/0003_identity.sql',
  'services/identity/migrations/0004_identity.sql',
];

describe('Postgres invite-by-email', { skip: DB ? false : 'set DATABASE_URL to run' }, () => {
  let ownerPool; // migrator/owner: applies DDL
  let appPool; // identity_app: the real runtime grants
  let projectId;
  const ownerParty = randomUUID();

  before(async () => {
    ownerPool = new Pool({ connectionString: DB, ssl, max: 4 });
    for (const rel of MIGRATIONS) {
      const sql = await readFile(join(ROOT, rel), 'utf8');
      await ownerPool.query(sql);
    }
    // Replayability: 0004 must be safe to run twice. The runner never does this,
    // but a migration that is not idempotent is a migration that cannot be
    // recovered by hand when a forward pass dies halfway.
    const again = await readFile(join(ROOT, 'services/identity/migrations/0004_identity.sql'), 'utf8');
    await ownerPool.query(again);

    appPool = createPool(DB, { role: 'identity_app', max: 4 });

    const { rows } = await appPool.query(
      `insert into identity.project (name, owner_party_id, baseline_budget_cents)
       values ('LINA-84 invite test', $1, 100) returning id`,
      [ownerParty],
    );
    projectId = rows[0].id;
  });

  after(async () => {
    // Leave the branch clean enough to re-run: the project row is the only thing
    // that would collide, and invitations cascade off it by project_id.
    try {
      await ownerPool?.query('delete from identity.invitation where project_id = $1', [projectId]);
      await ownerPool?.query('delete from identity.project where id = $1', [projectId]);
    } catch { /* a throwaway branch is discarded anyway */ }
    await appPool?.end();
    await ownerPool?.end();
  });

  const insertInvite = (email) =>
    appPool.query(
      `insert into identity.invitation (project_id, token_hash, email, role, status, invited_by_party_id)
       values ($1, $2, $3, 'counterparty', 'pending', $4) returning id, email`,
      [projectId, randomUUID().replace(/-/g, '').padEnd(64, 'a').slice(0, 64), email, ownerParty],
    );

  const clearPending = () =>
    ownerPool.query('delete from identity.invitation where project_id = $1', [projectId]);

  test('identity_app can write the new email column through its EXISTING grants', async () => {
    await clearPending();
    const { rows } = await insertInvite('gc@example.com');
    assert.equal(rows[0].email, 'gc@example.com');
  });

  test('the out-of-band path writes a NULL email and is still accepted', async () => {
    await clearPending();
    const { rows } = await insertInvite(null);
    assert.equal(rows[0].email, null, 'no address is a first-class state, not a sentinel');
  });

  test('the DB rejects a non-normalised address (the CHECK backs up the service)', async () => {
    await clearPending();
    await assert.rejects(
      insertInvite('GC@Example.com'),
      /invitation_email_normalised|violates check constraint/i,
      'a bypassing writer cannot store a mixed-case address',
    );
  });

  // ── THE grant regression (LINA-84 done-criteria) ────────────────────────────
  test('GRANTS: identity_app holds exactly SELECT/INSERT/UPDATE on identity.invitation', async () => {
    const { rows } = await ownerPool.query(
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'identity_app' and table_schema = 'identity' and table_name = 'invitation'
        order by privilege_type`,
    );
    const held = rows.map((r) => r.privilege_type);
    assert.deepEqual(
      held, ['INSERT', 'SELECT', 'UPDATE'],
      'adding a column must not have widened the matrix — no DELETE, no TRUNCATE, no REFERENCES',
    );
  });

  test('GRANTS: identity_app cannot DELETE an invitation', async () => {
    await assert.rejects(
      appPool.query('delete from identity.invitation'),
      /permission denied/i,
      'invitations are closed by status, never removed on the request path',
    );
  });

  // The seat boundary, asserted ahead of the table existing. ADR-0008 says
  // identity_app holds SELECT ONLY on identity.seat. This migration does not
  // create that table; if a later one does, this test is the thing that catches
  // an INSERT grant slipping in without the Architect's sign-off.
  test('GRANTS: identity_app never gains a write grant on identity.seat', async () => {
    const { rows } = await ownerPool.query(
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'identity_app' and table_schema = 'identity' and table_name = 'seat'`,
    );
    const writes = rows.map((r) => r.privilege_type).filter((p) => p !== 'SELECT');
    assert.deepEqual(
      writes, [],
      'ADR-0008: identity_app is SELECT-only on identity.seat. A write grant here is a ' +
        'trust-boundary change and must be reviewed, not merged as plumbing.',
    );
  });
});
