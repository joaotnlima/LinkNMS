// Pool construction rules (LINA-56). These are pure — no connection is opened —
// because what they guard is a decision made BEFORE any query runs: which role
// the service will execute as.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createPool, sslFor } from './db.mjs';

const DIRECT = 'postgresql://migrator:pw@ep-x-1.eu-west-2.aws.neon.tech/neondb?sslmode=require';
const POOLED = 'postgresql://migrator:pw@ep-x-1-pooler.c-2.eu-west-2.aws.neon.tech/neondb?sslmode=require';

describe('createPool role separation', () => {
  test('a role is only accepted as a plain identifier', () => {
    // There is no parameter binding for an identifier, so the allow-list IS the
    // guard — anything else would be interpolated straight into `SET ROLE`.
    for (const bad of ['identity_app; drop schema ledger cascade', 'Identity_App', '"x"', 'a b', 'pg_read_all_data ']) {
      assert.throws(
        () => createPool(DIRECT, { role: bad }),
        /unsafe Postgres role name/,
        `must refuse role ${JSON.stringify(bad)}`,
      );
    }
  });

  test('refuses to SET ROLE on a transaction-pooling endpoint', () => {
    // The whole grant matrix rests on each service executing as its own role. On
    // a `-pooler` (PgBouncer transaction mode) endpoint a SET ROLE issued at
    // connect time does not reliably hold, and the silent failure mode is a
    // service running as the login role — `migrator`, a neon_superuser member
    // that bypasses ledger.append_event's write guard.
    assert.throws(
      () => createPool(POOLED, { role: 'identity_app' }),
      /transaction-pooling endpoint/,
    );
  });

  test('the pooled endpoint is fine when no role is requested', async () => {
    // Migrations and single-role local/CI setups have nothing to lose.
    const pool = createPool(POOLED);
    assert.ok(pool);
    await pool.end();
  });

  test('TLS is required off-localhost and skipped on it', () => {
    assert.deepEqual(sslFor(DIRECT), { rejectUnauthorized: false });
    assert.equal(sslFor('postgres://u:p@localhost:5432/db'), false);
  });
});
