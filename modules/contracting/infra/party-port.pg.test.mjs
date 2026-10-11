// Contracting's party port over the REAL v2 migrations (throwaway DB): the
// live prime contractor of a build, for Planning's settings gate (PRD-02;
// audit S2 — planning no longer reads contracting.*). Skipped without
// DATABASE_URL.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createContractingStore } from './pg-store.mjs';
import { createContractPartyPort } from '../application/party-port.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the contracting Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_contracting_party_port_test';

describe('contracting party port', { skip }, () => {
  let admin, pool, port;
  const OWNER = randomUUID();
  const GC = randomUUID();
  const SUB = randomUUID();
  const PROJECT = randomUUID();

  before(async () => {
    const { default: pg } = await import('pg');
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 2 });
    for (const f of readdirSync(join(ROOT, 'db', 'v2')).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
      await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
    }
    const contract = (id, supplier, kind, status) => pool.query(
      `INSERT INTO contracting.contract (id, project_id, client_org_id, supplier_org_id, kind, status, reference, origin)
       VALUES ($1, $2, $3, $4, $5, $6, 'C-1', 'direct_entry')`, [id, PROJECT, OWNER, supplier, kind, status],
    );
    await contract(randomUUID(), GC, 'prime', 'signed');
    await contract(randomUUID(), SUB, 'prime', 'draft');
    port = createContractPartyPort(createContractingStore(pool));
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  test('a signed prime counts; a draft prime and strangers do not', async () => {
    assert.equal(await port.isPrimeSupplier(PROJECT, GC), true);
    assert.equal(await port.isPrimeSupplier(PROJECT, SUB), false);
    assert.equal(await port.isPrimeSupplier(PROJECT, OWNER), false);
    assert.equal(await port.isPrimeSupplier(null, GC), false);
  });
});
