// Identity store over the REAL v2 migrations (throwaway DB, like
// platform/pg-integration.test.mjs). Skipped without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/pg-store.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createIdentityStore } from './pg-store.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the identity Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_identity_test';

const PROJECT = '01920000-0000-7000-8000-0000000000b1';

describe('identity store over Postgres (v2 migrations)', { skip }, () => {
  let pg, admin, pool, store;

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 2 });
    for (const f of ['0001_schema.sql', '0002_platform_idempotency.sql']) {
      await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
    }
    store = createIdentityStore(pool);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  test('webhook mirror: person and org upserts converge on replay', async () => {
    const p1 = await store.upsertPerson({ clerkUserId: 'user_1', email: 'ines@douro.pt', name: 'Inês' });
    const p2 = await store.upsertPerson({ clerkUserId: 'user_1', email: 'ines@douro.pt', name: 'Inês Sousa', phone: '+351910000000' });
    assert.equal(p1.id, p2.id, 'replay must not mint a second person');
    assert.equal(p2.name, 'Inês Sousa');

    const o1 = await store.upsertOrganization({ clerkOrgId: 'org_1', orgKind: 'contractor', legalName: 'Douro Lda', approvalPolicy: 'any' });
    const o2 = await store.upsertOrganization({ clerkOrgId: 'org_1', orgKind: 'household', legalName: 'Douro, Lda.', approvalPolicy: 'any' });
    assert.equal(o1.id, o2.id);
    assert.equal(o2.kind, 'contractor', 'kind never changes through the mirror');
    assert.equal(o2.legal_name, 'Douro, Lda.');

    assert.equal(await store.mirrorReady('org_1', 'user_1'), true);
    assert.equal(await store.mirrorReady('org_1', 'user_ghost'), false);

    const m = await store.upsertMembership({ clerkOrgId: 'org_1', clerkUserId: 'user_1', orgRole: 'admin' });
    assert.equal(m.org_role, 'admin');
    assert.deepEqual((await store.listOrgsForPerson(p1.id))[0].org_role, 'admin');
  });

  test('staffing writes its ledger entry in the SAME transaction (invariant §6.4)', async () => {
    const person = await store.getPersonByClerkId('user_1');
    const org = await store.getOrgByClerkId('org_1');
    await pool.query(
      "INSERT INTO project.project (id, created_by_org_id, name, municipality_code) VALUES ($1, $2, 'Casa Teste', '1312')",
      [PROJECT, org.id],
    );
    await pool.query(
      "INSERT INTO project.participation (project_id, org_id, capacity, source) VALUES ($1, $2, 'prime_contractor', 'project')",
      [PROJECT, org.id],
    );
    assert.equal(await store.isProjectParticipant(PROJECT, org.id), true);

    const actor = { personId: person.id, orgId: org.id, orgRole: 'admin' };
    await store.staff({ projectId: PROJECT, orgId: org.id, personId: person.id, staffedBy: person.id, actor });
    // Idempotent replay: no duplicate row, no second ledger entry.
    await store.staff({ projectId: PROJECT, orgId: org.id, personId: person.id, staffedBy: person.id, actor });

    let ledger = await pool.query(
      "SELECT type FROM record.audit_event WHERE project_id = $1 AND category = 'identity' ORDER BY seq", [PROJECT]);
    assert.deepEqual(ledger.rows.map((r) => r.type), ['identity.staffing.added']);

    assert.equal(await store.unstaff({ projectId: PROJECT, orgId: org.id, personId: person.id, actor }), true);
    assert.equal(await store.unstaff({ projectId: PROJECT, orgId: org.id, personId: person.id, actor }), false);

    ledger = await pool.query(
      "SELECT type FROM record.audit_event WHERE project_id = $1 AND category = 'identity' ORDER BY seq", [PROJECT]);
    assert.deepEqual(ledger.rows.map((r) => r.type), ['identity.staffing.added', 'identity.staffing.removed']);
  });

  test('removing a membership clears staffing and ledgers it per project (doc 16 §8)', async () => {
    const person = await store.getPersonByClerkId('user_1');
    const org = await store.getOrgByClerkId('org_1');
    const actor = { personId: person.id, orgId: org.id, orgRole: 'admin' };
    await store.staff({ projectId: PROJECT, orgId: org.id, personId: person.id, staffedBy: person.id, actor });

    assert.equal(await store.removeMembership({ clerkOrgId: 'org_1', clerkUserId: 'user_1' }), true);
    const staffed = await pool.query('SELECT 1 FROM identity.project_staffing WHERE person_id = $1', [person.id]);
    assert.equal(staffed.rows.length, 0);
    const { rows } = await pool.query(
      "SELECT payload->>'cause' AS cause FROM record.audit_event WHERE project_id = $1 AND type = 'identity.staffing.removed' ORDER BY seq DESC LIMIT 1",
      [PROJECT],
    );
    assert.equal(rows[0].cause, 'membership_removed');
    assert.equal((await store.listOrgsForPerson(person.id)).length, 0, 'removed membership no longer lists');
  });

  test('signed-contract guard sees live paper only', async () => {
    const org = await store.getOrgByClerkId('org_1');
    const other = await store.upsertOrganization({ clerkOrgId: 'org_2', orgKind: 'household', legalName: 'Família Silva', approvalPolicy: 'any' });
    assert.equal(await store.orgHasSignedContracts(org.id), false);
    await pool.query(
      `INSERT INTO contracting.contract (id, project_id, kind, client_org_id, supplier_org_id, reference, origin, status)
       VALUES ('01920000-0000-7000-8000-0000000000d1', $1, 'prime', $2, $3, 'C-1', 'direct_entry', 'signed')`,
      [PROJECT, other.id, org.id],
    );
    assert.equal(await store.orgHasSignedContracts(org.id), true);
    assert.equal(await store.orgHasSignedContracts(other.id), true);
  });
});
