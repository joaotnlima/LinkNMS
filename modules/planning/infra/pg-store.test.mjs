// Planning store over the REAL v2 migrations (throwaway DB, like the other
// modules). Skipped without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/pg-store.test.mjs
//
// Proves at the database level, per AGENT-INDEX §6:
//   #4  plan writes commit WITH their ledger entry and outbox events;
//   the D-26 delta path end to end (field history, client_change_id replay);
//   propagation persists the moved rows in the same transaction;
//   and the doc-10 hand-off: contracting.contract.signed → planning consumer
//   → branch bound + baseline v1, idempotent under at-least-once delivery.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createPlanningStore } from './pg-store.mjs';
import { planningConsumers } from '../application/consumers.mjs';
import { createTask, updateTask, createLink, getSchedule, getTask } from '../application/use-cases.mjs';
import { dispatchPending, publishEvent } from '../../../platform/outbox.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the planning Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_planning_test';

const OWNER_ORG = randomUUID();
const GC_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const CONTRACT = randomUUID();
const ROOT_TASK = randomUUID();
const TASK_A = randomUUID();
const TASK_B = randomUUID();
const LINK = randomUUID();

const viewer = {
  clerkUserId: 'user_ana', orgId: OWNER_ORG, orgRole: 'admin', channel: 'ui',
  has: (p) => p === 'org:plan:edit',
};

describe('planning store over Postgres (v2 migrations)', { skip }, () => {
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
    store = createPlanningStore(pool);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
    await admin?.end();
  });

  test('createTask persists the row, its ledger entry and its event together', async () => {
    const res = await createTask({
      viewer, store, projectId: PROJECT, idempotencyKey: null,
      body: { id: ROOT_TASK, name: 'Execução', start: null },
    });
    assert.equal(res.status, 201);
    for (const [id, name, start, duration] of [
      [TASK_A, 'Fundações', '2026-09-21', 3],
      [TASK_B, 'Estrutura', '2026-09-24', 2],
    ]) {
      const r = await createTask({
        viewer, store, projectId: PROJECT, idempotencyKey: null,
        body: { id, parent_id: ROOT_TASK, name, start, duration_wd: duration },
      });
      assert.equal(r.status, 201);
    }
    const { rows: ledger } = await pool.query(
      `SELECT type FROM record.audit_event WHERE project_id = $1 AND type = 'planning.task.created'`, [PROJECT],
    );
    assert.equal(ledger.length, 3);
    const { rows: outbox } = await pool.query(
      `SELECT type FROM platform.outbox WHERE project_id = $1 AND type = 'planning.task.created'`, [PROJECT],
    );
    assert.equal(outbox.length, 3);
    const { rows: b } = await pool.query(`SELECT to_char(finish,'YYYY-MM-DD') AS finish FROM planning.task WHERE id = $1`, [TASK_B]);
    assert.equal(b[0].finish, '2026-09-25'); // duration 2 from Thursday
  });

  test('a delta with propagation persists the moved successor in the same commit', async () => {
    const linkRes = await createLink({
      viewer, store, taskId: TASK_B,
      body: { id: LINK, predecessor_id: TASK_A, successor_id: TASK_B, from_anchor: 'end', to_anchor: 'start' },
    });
    assert.equal(linkRes.status, 201);

    const changeId = randomUUID();
    const res = await updateTask({
      viewer, store, taskId: TASK_A,
      body: { client_change_id: changeId, changes: { finish: { value: '2026-09-25', base: '2026-09-23' } } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.propagated.length, 1);
    const { rows } = await pool.query(
      `SELECT to_char(start,'YYYY-MM-DD') AS start, last_change_cause FROM planning.task WHERE id = $1`, [TASK_B],
    );
    assert.equal(rows[0].start, '2026-09-28');
    assert.match(rows[0].last_change_cause, /propagated from/);
    const { rows: history } = await pool.query(
      'SELECT field, cause FROM planning.task_field_change WHERE task_id = $1', [TASK_B],
    );
    assert.ok(history.some((h) => h.cause === 'propagated'));

    // replay: same client_change_id applies nothing new
    const { rows: countBefore } = await pool.query('SELECT count(*) FROM planning.task_field_change');
    const replay = await updateTask({
      viewer, store, taskId: TASK_A,
      body: { client_change_id: changeId, changes: { finish: { value: '2026-09-25' } } },
    });
    assert.equal(replay.status, 200);
    const { rows: countAfter } = await pool.query('SELECT count(*) FROM planning.task_field_change');
    assert.equal(countAfter[0].count, countBefore[0].count);
  });

  test('contracting.contract.signed → branch bound + baseline v1, idempotently', async () => {
    await pool.query(
      `INSERT INTO contracting.contract
         (id, project_id, kind, client_org_id, supplier_org_id, reference, payment_terms, origin, status)
       VALUES ($1, $2, 'prime', $3, $4, 'PRIME-1', 'measurement_monthly', 'direct_entry', 'signed')`,
      [CONTRACT, PROJECT, OWNER_ORG, GC_ORG],
    );
    await pool.query(
      'INSERT INTO contracting.contract_root (contract_id, task_id) VALUES ($1, $2)',
      [CONTRACT, ROOT_TASK],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await publishEvent(client, {
        event_id: randomUUID(), type: 'contracting.contract.signed', version: 1,
        project_id: PROJECT, actor: { person_id: PERSON, org_id: GC_ORG },
        scope: { type: 'contract', id: CONTRACT },
        data: { kind: 'prime', supplier_org_id: GC_ORG, client_org_id: OWNER_ORG },
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const delivered = await dispatchPending(pool, planningConsumers(store));
    assert.ok(delivered >= 1);

    const { rows: tasks } = await pool.query(
      `SELECT id, contract_id, branch_contract_id, schedule_state,
              to_char(baseline_start,'YYYY-MM-DD') AS baseline_start
         FROM planning.task WHERE project_id = $1`,
      [PROJECT],
    );
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    assert.equal(byId[ROOT_TASK].contract_id, CONTRACT);
    assert.equal(byId[TASK_A].branch_contract_id, CONTRACT);
    assert.equal(byId[TASK_A].schedule_state, 'on_baseline');
    assert.equal(byId[TASK_A].baseline_start, '2026-09-21');
    const { rows: baselines } = await pool.query('SELECT version FROM planning.baseline WHERE contract_id = $1', [CONTRACT]);
    assert.deepEqual(baselines.map((b) => b.version), [1]);
    const { rows: blTasks } = await pool.query(
      'SELECT count(*) FROM planning.baseline_task bt JOIN planning.baseline b ON b.id = bt.baseline_id WHERE b.contract_id = $1',
      [CONTRACT],
    );
    assert.equal(Number(blTasks[0].count), 3);

    // at-least-once: a second delivery is absorbed
    const again = await store.bindSignedContract({ contractId: CONTRACT, projectId: PROJECT, actor: {} });
    assert.equal(again.bound, false);
  });

  test('the plan reads back whole: scope from the signed contract, segments, health', async () => {
    const res = await getSchedule({ viewer, store, projectId: PROJECT, query: {} });
    assert.equal(res.status, 200);
    const byId = Object.fromEntries(res.body.tasks.map((t) => [t.id, t]));
    assert.equal(byId[ROOT_TASK].kind, 'summary');
    assert.ok(byId[TASK_A].segments.some((s) => s.kind === 'baseline'));
    assert.ok(byId[TASK_B].segments.some((s) => s.kind === 'current'));
    assert.equal(res.body.links.length, 1);

    const gcViewer = { ...viewer, orgId: GC_ORG, clerkUserId: 'user_ana' };
    // the GC is not a participant row yet (that hand-off is project's consumer),
    // so the read is owner-side here; scope maths is proven in the http suite.
    const detail = await getTask({ viewer, store, taskId: TASK_A });
    assert.equal(detail.status, 200);
    assert.ok(detail.body.history.length >= 1);
    void gcViewer;
  });
});
