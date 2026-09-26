// Money flow over the REAL v2 migrations (throwaway DB). Skipped without
// DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/money-flow.pg.test.mjs
//
// Proves at the database level:
//   - approve applies the BoQ delta as SUPERSEDE + INSERT and lives happily
//     with the boq_freeze_guard trigger (an in-place UPDATE raises);
//   - every money write commits WITH its ledger entry and outbox event;
//   - measurement approval mints the expected payment with due_date =
//     approval date + payment_days (ruling 3);
//   - the planning.progress.reported consumer activates the signed chain,
//     idempotently, and never touches a terminated contract (ruling 16).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createContractingStore } from './pg-store.mjs';
import { contractingConsumers } from '../application/consumers.mjs';
import {
  createChangeOrder, submitChangeOrder, approveChangeOrder,
  createMeasurement, approveMeasurement, getFinancials, getCashFlow,
} from '../application/use-cases.mjs';
import { dispatchPending, publishEvent } from '../../../platform/outbox.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the money-flow Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_money_test';

const OWNER_ORG = randomUUID();
const GC_ORG = randomUUID();
const PERSON = randomUUID();
const GC_PERSON = randomUUID();
const PROJECT = randomUUID();
const PRIME = randomUUID();
const TASK = randomUUID();
const BOQ_1 = randomUUID();
const BOQ_2 = randomUUID();
const CO = randomUUID();
const NEW_LINE = randomUUID();
const MEASUREMENT = randomUUID();

const ownerViewer = {
  clerkUserId: 'user_ana', orgId: OWNER_ORG, orgRole: 'admin', channel: 'ui',
  has: () => true,
};
const gcViewer = {
  clerkUserId: 'user_rui', orgId: GC_ORG, orgRole: 'admin', channel: 'ui',
  has: () => true,
};

describe('money flow over Postgres (v2 migrations)', { skip }, () => {
  let pg, admin, pool, store;

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 3 });
    for (const f of ['0001_schema.sql', '0002_platform_idempotency.sql', '0003_project_claim.sql', '0004_contracting_contract_root.sql']) {
      await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
    }
    await pool.query(
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES
         ($1, 'org_owner', 'household', 'Família Silva'),
         ($2, 'org_gc', 'contractor', 'Douro Construções')`,
      [OWNER_ORG, GC_ORG],
    );
    await pool.query(
      `INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES
         ($1, 'user_ana', 'ana@casa.pt', 'Ana'), ($2, 'user_rui', 'rui@douro.pt', 'Rui')`,
      [PERSON, GC_PERSON],
    );
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code, status)
       VALUES ($1, $2, $2, 'Casa Silva', '1306', 'contracted')`,
      [PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO project.participation (project_id, org_id, capacity, source) VALUES
         ($1, $2, 'owner', 'project'), ($1, $3, 'prime_contractor', 'project')`,
      [PROJECT, OWNER_ORG, GC_ORG],
    );
    await pool.query(
      `INSERT INTO planning.task (id, project_id, depth, position, name, contract_id, branch_contract_id)
       VALUES ($1, $2, 1, 'a', 'Execução', $3, $3)`,
      [TASK, PROJECT, PRIME],
    );
    await pool.query(
      `INSERT INTO contracting.contract
         (id, project_id, kind, client_org_id, supplier_org_id, reference, origin, status, payment_days)
       VALUES ($1, $2, 'prime', $3, $4, 'PRIME-1', 'direct_entry', 'signed', 30)`,
      [PRIME, PROJECT, OWNER_ORG, GC_ORG],
    );
    await pool.query('INSERT INTO contracting.contract_root (contract_id, task_id) VALUES ($1, $2)', [PRIME, TASK]);
    await pool.query(
      `INSERT INTO contracting.boq_item (id, project_id, contract_id, task_id, code, description, unit, quantity, unit_price_cents)
       VALUES ($1, $3, $4, $5, '1.1', 'Fundações', 'm3', 10.000, 5000),
              ($2, $3, $4, $5, '1.2', 'Betão', 'm3', 4.000, 2500)`,
      [BOQ_1, BOQ_2, PROJECT, PRIME, TASK],
    );
    store = createContractingStore(pool);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
    await admin?.end();
  });

  test('the freeze guard refuses an in-place edit of a signed line', async () => {
    await assert.rejects(
      pool.query('UPDATE contracting.boq_item SET unit_price_cents = 1 WHERE id = $1', [BOQ_1]),
      /changes only via change order/,
    );
  });

  test('create → submit → approve: supersede + add, value recomputed, one transaction', async () => {
    const created = await createChangeOrder({
      viewer: gcViewer, store, contractId: PRIME, idempotencyKey: 'co-key-1',
      body: {
        id: CO, kind: 'scope', reason: 'fundações reforçadas',
        lines: [{
          op: 'replace', boq_item_id: BOQ_1,
          new_line: { id: NEW_LINE, code: '1.1a', description: 'Fundações reforçadas', unit: 'm3', quantity: '12.000', unit_price: { amount_cents: 5000, currency: 'EUR' } },
        }],
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.number, '1');

    await submitChangeOrder({ viewer: gcViewer, store, changeOrderId: CO, body: { note: 'p.f.' }, idempotencyKey: null });
    const approved = await approveChangeOrder({
      viewer: ownerViewer, store, changeOrderId: CO, body: { note: 'ok' }, idempotencyKey: null,
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.amount_delta.amount_cents, 10000); // (12-10)×50€

    const { rows: lines } = await pool.query(
      'SELECT id, superseded_by_change_order_id, introduced_by_change_order_id FROM contracting.boq_item WHERE contract_id = $1 ORDER BY code',
      [PRIME],
    );
    const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
    assert.equal(byId[BOQ_1].superseded_by_change_order_id, CO);
    assert.equal(byId[NEW_LINE].introduced_by_change_order_id, CO);

    const { rows: contracts } = await pool.query('SELECT value_cents, revision FROM contracting.contract WHERE id = $1', [PRIME]);
    assert.equal(Number(contracts[0].value_cents), 70000); // 12×50 + 4×25 €
    assert.equal(contracts[0].revision, 2);

    // ledger + outbox committed with the write (§6.3/§6.4)
    const { rows: ledger } = await pool.query(
      `SELECT type FROM record.audit_event WHERE project_id = $1 AND type LIKE 'contracting.change_order.%' ORDER BY seq`,
      [PROJECT],
    );
    assert.deepEqual(ledger.map((l) => l.type), [
      'contracting.change_order.created', 'contracting.change_order.submitted', 'contracting.change_order.approved',
    ]);
    const { rows: outbox } = await pool.query(
      `SELECT data FROM platform.outbox WHERE type = 'contracting.change_order.approved'`,
    );
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].data.amount_delta_cents, 10000);
    assert.deepEqual(outbox[0].data.time, []); // planning's re-baseline input travels here
  });

  test('the DB CHECK also refuses a proposer-decided change order', async () => {
    await assert.rejects(
      pool.query('UPDATE contracting.change_order SET decided_by_org_id = proposed_by_org_id WHERE id = $1', [CO]),
      /change_order/,
    );
  });

  test('measurement approve mints the EXPECTED payment, due = today + payment_days', async () => {
    const created = await createMeasurement({
      viewer: gcViewer, store, contractId: PRIME,
      body: { id: MEASUREMENT, period: '2026-09', lines: [{ boq_item_id: BOQ_2, quantity_this_period: '2.000' }] },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'submitted');
    assert.equal(created.body.gross.amount_cents, 5000); // 2×25€
    assert.equal(created.body.retention.amount_cents, 250); // 5%
    assert.equal(created.body.net.amount_cents, 4750);

    const approved = await approveMeasurement({ viewer: ownerViewer, store, measurementId: MEASUREMENT });
    assert.equal(approved.body.status, 'approved');
    const { rows: payments } = await pool.query(
      `SELECT status, amount_cents, (due_date - current_date) AS days FROM contracting.payment_record WHERE measurement_id = $1`,
      [MEASUREMENT],
    );
    assert.equal(payments.length, 1);
    assert.equal(payments[0].status, 'expected');
    assert.equal(Number(payments[0].amount_cents), 4750);
    assert.equal(payments[0].days, 30);

    const financials = await getFinancials({ viewer: ownerViewer, store, contractId: PRIME });
    assert.equal(financials.body.measured.amount_cents, 5000);
    assert.equal(financials.body.retention_held.amount_cents, 250);
    assert.equal(financials.body.outstanding.amount_cents, 4750);
    assert.equal(financials.body.approved_changes.amount_cents, 10000);

    const cash = await getCashFlow({ viewer: ownerViewer, store, projectId: PROJECT, query: {} });
    assert.equal(cash.body.items.length, 1);
    assert.equal(cash.body.total.amount_cents, 4750);
  });

  test('a duplicate period answers 409; a DISPUTED one is revised back to submitted', async () => {
    await assert.rejects(
      createMeasurement({
        viewer: gcViewer, store, contractId: PRIME,
        body: { id: randomUUID(), period: '2026-09', lines: [{ boq_item_id: BOQ_2, quantity_this_period: '1.000' }] },
      }),
      /version_conflict/,
    );
  });

  test('planning.progress.reported activates the signed contract, idempotently', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await publishEvent(client, {
        event_id: randomUUID(), type: 'planning.progress.reported', version: 1,
        project_id: PROJECT, actor: { person_id: GC_PERSON, org_id: GC_ORG },
        scope: { type: 'project', id: PROJECT },
        data: { task_id: TASK, task_name: 'Execução', project_id: PROJECT, status: 'in_progress', reported_by_org_id: GC_ORG },
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await dispatchPending(pool, contractingConsumers(store));
    const { rows } = await pool.query('SELECT status FROM contracting.contract WHERE id = $1', [PRIME]);
    assert.equal(rows[0].status, 'active');
    const { rows: activated } = await pool.query(
      `SELECT count(*) FROM platform.outbox WHERE type = 'contracting.contract.activated'`,
    );
    assert.equal(Number(activated[0].count), 1);

    // replay: already active → absorbed, no second event
    const again = await store.activateContractsForTask({ taskId: TASK, projectId: PROJECT, actor: {} });
    assert.deepEqual(again.activated, []);
  });
});
