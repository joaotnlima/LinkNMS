// Contracting store over the REAL v2 migrations (throwaway DB, like
// modules/project). Skipped without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/pg-store.test.mjs
//
// Proves at the database level, per AGENT-INDEX §6:
//   #2  a signed contract's BoQ line never changes in place (boq_freeze);
//   #4  contract writes commit WITH their ledger entry and outbox event;
//   #10 one live prime per project (C3) mapped to a clean 409 problem;
// and the doc-10 hand-off: contracting.contract.signed → project consumer
// → participation row, idempotent under at-least-once delivery.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createContractingStore } from './pg-store.mjs';
import { createProjectStore } from '../../project/infra/pg-store.mjs';
import { projectConsumers } from '../../project/application/consumers.mjs';
import { dispatchPending } from '../../../platform/outbox.mjs';
import { ProblemError } from '../../../platform/errors.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the contracting Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_contracting_test';

const OWNER_ORG = randomUUID();
const GC_ORG = randomUUID();
const SUB_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const TASK_EXEC = randomUUID();
const TASK_PLUMB = randomUUID();
const ACTOR = { personId: PERSON, orgId: OWNER_ORG, orgRole: 'admin', channel: 'ui' };

describe('contracting store over Postgres (v2 migrations)', { skip }, () => {
  let pg, admin, pool, store;

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 2 });
    for (const f of ['0001_schema.sql', '0002_platform_idempotency.sql', '0003_project_claim.sql', '0004_contracting_contract_root.sql']) {
      await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
    }
    await pool.query(
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES
         ($1, 'org_owner', 'household', 'Família Silva'),
         ($2, 'org_gc', 'contractor', 'Douro Construções'),
         ($3, 'org_sub', 'contractor', 'Canalizações Norte')`,
      [OWNER_ORG, GC_ORG, SUB_ORG],
    );
    await pool.query(
      `INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES ($1, 'user_ana', 'ana@casa.pt', 'Ana')`,
      [PERSON],
    );
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code)
       VALUES ($1, $2, $2, 'Casa Silva', '1306')`,
      [PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO project.participation (project_id, org_id, capacity, source)
       VALUES ($1, $2, 'owner', 'project')`,
      [PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO planning.task (id, project_id, depth, position, name) VALUES
         ($1, $3, 1, 'a', 'Execução'),
         ($2, $3, 2, 'aa', 'Canalização')`,
      [TASK_EXEC, TASK_PLUMB, PROJECT],
    );
    store = createContractingStore(pool);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  test('root validation only accepts live rows of the project', async () => {
    const known = await store.tasksOfProject(PROJECT, [TASK_EXEC, randomUUID()]);
    assert.deepEqual([...known], [TASK_EXEC]);
  });

  test('create → contract + roots + ledger entry + outbox event in ONE transaction', async () => {
    const id = randomUUID();
    const created = await store.createContract({
      id, projectId: PROJECT, kind: 'prime', parentContractId: null,
      clientOrgId: OWNER_ORG, supplierOrgId: GC_ORG, reference: 'PRIME-1',
      paymentTerms: 'measurement_monthly', retentionBp: 500,
      scopeInclusions: 'toda a execução', scopeExclusions: null,
      rootTaskIds: [TASK_EXEC], actor: ACTOR,
    });
    assert.equal(created.contract.status, 'draft');
    assert.deepEqual(created.roots, [TASK_EXEC]);

    const { rows: ledger } = await pool.query(
      `SELECT type, scope_type, scope_id FROM record.audit_event WHERE project_id = $1 ORDER BY seq DESC LIMIT 1`,
      [PROJECT],
    );
    assert.equal(ledger[0].type, 'contracting.contract.created');
    assert.equal(ledger[0].scope_type, 'contract');
    assert.equal(ledger[0].scope_id, id);

    const { rows: outbox } = await pool.query(
      `SELECT type FROM platform.outbox WHERE (scope->>'id') = $1`, [id],
    );
    assert.deepEqual(outbox.map((r) => r.type), ['contracting.contract.created']);
  });

  test('a failed write leaves NO ledger entry and NO event (§6.4)', async () => {
    const { rows: [{ n: before }] } = await pool.query('SELECT count(*) AS n FROM record.audit_event');
    await assert.rejects(store.createContract({
      id: randomUUID(), projectId: PROJECT, kind: 'prime', parentContractId: null,
      clientOrgId: OWNER_ORG, supplierOrgId: OWNER_ORG, // violates C1 client <> supplier
      reference: 'BAD', paymentTerms: 'measurement_monthly', retentionBp: 500,
      scopeInclusions: null, scopeExclusions: null, rootTaskIds: [TASK_EXEC], actor: ACTOR,
    }));
    const { rows: [{ n: after_ }] } = await pool.query('SELECT count(*) AS n FROM record.audit_event');
    assert.equal(before, after_);
  });

  test('both signatures → signed; the consumer materialises participation; replay is idempotent', async () => {
    const id = randomUUID();
    await store.createContract({
      id, projectId: PROJECT, kind: 'direct', parentContractId: null,
      clientOrgId: OWNER_ORG, supplierOrgId: SUB_ORG, reference: 'DIR-1',
      paymentTerms: 'measurement_monthly', retentionBp: 500,
      scopeInclusions: null, scopeExclusions: null, rootTaskIds: [TASK_PLUMB], actor: ACTOR,
    });
    const first = await store.addSignature({
      contractId: id, orgId: OWNER_ORG, personId: PERSON, becomesSigned: false, actor: ACTOR,
    });
    assert.equal(first.contract.status, 'draft');
    const second = await store.addSignature({
      contractId: id, orgId: SUB_ORG, personId: PERSON, becomesSigned: true,
      actor: { ...ACTOR, orgId: SUB_ORG },
    });
    assert.equal(second.contract.status, 'signed');
    assert.equal(second.signatures.length, 2);

    // doc 10: contracting.contract.signed → project consumer → participation.
    const projectStore = createProjectStore(pool);
    const consumers = projectConsumers(projectStore);
    await dispatchPending(pool, consumers);
    const { rows: pa } = await pool.query(
      `SELECT capacity, source, contract_id FROM project.participation WHERE project_id = $1 AND org_id = $2`,
      [PROJECT, SUB_ORG],
    );
    assert.equal(pa.length, 1);
    assert.equal(pa[0].capacity, 'direct_contractor');
    assert.equal(pa[0].source, 'contract');
    assert.equal(pa[0].contract_id, id);

    // At-least-once: replaying the handler must not duplicate or throw.
    await consumers['contracting.contract.signed']({
      project_id: PROJECT, scope: { id }, data: { kind: 'direct', supplier_org_id: SUB_ORG },
    });
    const { rows: again } = await pool.query(
      `SELECT count(*) AS n FROM project.participation WHERE project_id = $1 AND org_id = $2`,
      [PROJECT, SUB_ORG],
    );
    assert.equal(Number(again[0].n), 1);
  });

  test('C3: a second live prime on the project answers a 409 problem, not a raw pg error', async () => {
    // Make PRIME-1 live first.
    const { rows: primes } = await pool.query(
      `SELECT id FROM contracting.contract WHERE project_id = $1 AND kind = 'prime'`, [PROJECT],
    );
    await store.addSignature({ contractId: primes[0].id, orgId: OWNER_ORG, personId: PERSON, becomesSigned: false, actor: ACTOR });
    await store.addSignature({ contractId: primes[0].id, orgId: GC_ORG, personId: PERSON, becomesSigned: true, actor: { ...ACTOR, orgId: GC_ORG } });

    const rival = randomUUID();
    await store.createContract({
      id: rival, projectId: PROJECT, kind: 'prime', parentContractId: null,
      clientOrgId: OWNER_ORG, supplierOrgId: SUB_ORG, reference: 'PRIME-2',
      paymentTerms: 'measurement_monthly', retentionBp: 500,
      scopeInclusions: null, scopeExclusions: null, rootTaskIds: [TASK_EXEC], actor: ACTOR,
    });
    await store.addSignature({ contractId: rival, orgId: OWNER_ORG, personId: PERSON, becomesSigned: false, actor: ACTOR });
    await assert.rejects(
      store.addSignature({ contractId: rival, orgId: SUB_ORG, personId: PERSON, becomesSigned: true, actor: { ...ACTOR, orgId: SUB_ORG } }),
      (err) => err instanceof ProblemError && err.problem.status === 409,
    );
  });

  test('invariant §6.2: a signed contract BoQ line only moves by supersede (boq_freeze)', async () => {
    const { rows: signed } = await pool.query(
      `SELECT id FROM contracting.contract WHERE project_id = $1 AND status = 'signed' LIMIT 1`, [PROJECT],
    );
    const line = randomUUID();
    await pool.query(
      `INSERT INTO contracting.boq_item (id, project_id, contract_id, code, description, unit, quantity, unit_price_cents)
       VALUES ($1, $2, $3, '1.1', 'Tubagem', 'm', 120, 2500)`,
      [line, PROJECT, signed[0].id],
    );
    await assert.rejects(
      pool.query(`UPDATE contracting.boq_item SET unit_price_cents = 1 WHERE id = $1`, [line]),
      /change order/,
    );
    // …and the live value roll-up reads the non-superseded lines.
    const found = await store.getContract(signed[0].id);
    assert.equal(Number(found.valueCents), 120 * 2500);
  });

  test('updateDraft: stale version answers null; fresh version bumps and re-roots', async () => {
    const id = randomUUID();
    await store.createContract({
      id, projectId: PROJECT, kind: 'service', parentContractId: null,
      clientOrgId: OWNER_ORG, supplierOrgId: GC_ORG, reference: 'SRV-1',
      paymentTerms: 'milestones', retentionBp: 0,
      scopeInclusions: null, scopeExclusions: null, rootTaskIds: [TASK_EXEC], actor: ACTOR,
    });
    assert.equal(await store.updateDraft({ contractId: id, expectedVersion: 9, patch: {}, actor: ACTOR }), null);
    const updated = await store.updateDraft({
      contractId: id, expectedVersion: 1,
      patch: { reference: 'SRV-1-REV', rootTaskIds: [TASK_PLUMB] }, actor: ACTOR,
    });
    assert.equal(updated.contract.version, 2);
    assert.equal(updated.contract.reference, 'SRV-1-REV');
    assert.deepEqual(updated.roots, [TASK_PLUMB]);
  });
});
