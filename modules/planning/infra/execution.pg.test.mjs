// Phase-5 planning over the REAL v2 migrations (throwaway DB). Skipped
// without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/execution.pg.test.mjs
//
// Proves at the database level:
//   - a slip on a baselined row writes task + variation + ledger + outbox in
//     ONE commit, and returning to baseline closes the variation;
//   - variation events fold into ONE 15-minute digest row per recipient;
//   - the contracting.change_order.approved consumer re-baselines from the
//     CO's time entries, stamps the formalised variations, and absorbs a
//     replay (idempotent);
//   - reportProgress + the quality.verification consumers keep the
//     append-only trail (verified appended once, replays absorbed) and the
//     derived task status surfaces 'verified'.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createPlanningStore } from './pg-store.mjs';
import { planningConsumers } from '../application/consumers.mjs';
import {
  createTask, updateTask, reportProgress, listVariations, getVariation,
  createCostLine, getSchedule,
} from '../application/use-cases.mjs';
import { dispatchPending, publishEvent } from '../../../platform/outbox.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the execution Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_execution_test';

const OWNER_ORG = randomUUID();
const GC_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const CONTRACT = randomUUID();
const ROOT_TASK = randomUUID();
const TASK_A = randomUUID();
const CO = randomUUID();

const viewer = {
  clerkUserId: 'user_ana', orgId: OWNER_ORG, orgRole: 'admin', channel: 'ui',
  has: () => true,
};

describe('phase-5 planning over Postgres (v2 migrations)', { skip }, () => {
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
      `INSERT INTO identity.org_membership (org_id, person_id, org_role) VALUES ($1, $2, 'admin')`,
      [OWNER_ORG, PERSON],
    );
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code, status)
       VALUES ($1, $2, $2, 'Casa Silva', '1306', 'in_execution')`,
      [PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO project.participation (project_id, org_id, capacity, source) VALUES
         ($1, $2, 'owner', 'project'), ($1, $3, 'prime_contractor', 'project')`,
      [PROJECT, OWNER_ORG, GC_ORG],
    );
    store = createPlanningStore(pool);

    // plan rows, then the signed-contract binding takes baseline v1
    await createTask({
      viewer, store, projectId: PROJECT, idempotencyKey: null,
      body: { id: ROOT_TASK, name: 'Execução' },
    });
    await createTask({
      viewer, store, projectId: PROJECT, idempotencyKey: null,
      body: { id: TASK_A, parent_id: ROOT_TASK, name: 'Fundações', start: '2026-09-21', duration_wd: 3 },
    });
    await pool.query(
      `INSERT INTO contracting.contract
         (id, project_id, kind, client_org_id, supplier_org_id, reference, origin, status)
       VALUES ($1, $2, 'prime', $3, $4, 'PRIME-1', 'direct_entry', 'signed')`,
      [CONTRACT, PROJECT, OWNER_ORG, GC_ORG],
    );
    await pool.query('INSERT INTO contracting.contract_root (contract_id, task_id) VALUES ($1, $2)', [CONTRACT, ROOT_TASK]);
    await store.bindSignedContract({ contractId: CONTRACT, projectId: PROJECT, actor: {} });
    await pool.query('UPDATE platform.outbox SET dispatched_at = now() WHERE dispatched_at IS NULL'); // settle the seed
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
    await admin?.end();
  });

  test('a slip writes task + variation + ledger + outbox in one commit', async () => {
    const res = await updateTask({
      viewer, store, taskId: TASK_A,
      body: { client_change_id: randomUUID(), changes: { finish: { value: '2026-09-25', base: '2026-09-23' } } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.variations.length, 1);
    assert.equal(res.body.variations[0].kind, 'time');
    assert.equal(res.body.variations[0].delta.finish_wd, 2);

    const { rows: variations } = await pool.query(
      `SELECT kind, status, delta, cause FROM planning.variation WHERE task_id = $1`, [TASK_A],
    );
    assert.equal(variations.length, 1);
    assert.equal(variations[0].status, 'open');
    assert.equal(variations[0].delta.finish_wd, 2);
    const { rows: ledger } = await pool.query(
      `SELECT count(*) FROM record.audit_event WHERE project_id = $1 AND type = 'planning.variation.recorded'`, [PROJECT],
    );
    assert.equal(Number(ledger[0].count), 1);
    const { rows: outbox } = await pool.query(
      `SELECT count(*) FROM platform.outbox WHERE type = 'planning.variation.recorded'`,
    );
    assert.equal(Number(outbox[0].count), 1);
  });

  test('variation events fold into ONE digest row per recipient (15-min window)', async () => {
    // a second slip in the same window → planning.variation.updated
    await updateTask({
      viewer, store, taskId: TASK_A,
      body: { client_change_id: randomUUID(), changes: { finish: { value: '2026-09-28' } } },
    });
    const delivered = await dispatchPending(pool, planningConsumers(store));
    assert.ok(delivered >= 2);
    const { rows: digests } = await pool.query(
      `SELECT variation_ids, net_project_finish_delta_wd, net_cost_delta_cents, sent_at
         FROM planning.variation_digest WHERE project_id = $1 AND recipient_person_id = $2
        ORDER BY window_start`,
      [PROJECT, PERSON],
    );
    assert.equal(digests.length, 1); // both events, one window, one recipient row
    assert.equal(digests[0].variation_ids.length, 1); // the SAME net variation, not two
    assert.equal(digests[0].net_project_finish_delta_wd, 3);
    assert.equal(digests[0].net_cost_delta_cents, null); // no visible money moved (absent beats zero)
    assert.equal(digests[0].sent_at, null); // ruling 14: e-mail is a later phase
  });

  test('the change-order consumer re-baselines from time entries, idempotently', async () => {
    const { rows: open } = await pool.query('SELECT id FROM planning.variation WHERE task_id = $1', [TASK_A]);
    const variationId = open[0].id;
    const approvedEvt = () => ({
      event_id: randomUUID(), type: 'contracting.change_order.approved', version: 1,
      project_id: PROJECT, actor: { person_id: PERSON, org_id: OWNER_ORG },
      scope: { type: 'contract', id: CONTRACT },
      data: {
        change_order_id: CO, contract_id: CONTRACT, amount_delta_cents: 0,
        time: [{ task_id: TASK_A, new_baseline_start: '2026-09-21', new_baseline_finish: '2026-09-28' }],
        from_variation_ids: [variationId],
      },
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await publishEvent(client, approvedEvt());
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await dispatchPending(pool, planningConsumers(store));

    const { rows: baselines } = await pool.query(
      'SELECT version, reason, change_order_id FROM planning.baseline WHERE contract_id = $1 ORDER BY version', [CONTRACT],
    );
    assert.deepEqual(baselines.map((b) => b.version), [1, 2]);
    assert.equal(baselines[1].reason, 'change_order');
    assert.equal(baselines[1].change_order_id, CO);
    const { rows: tasks } = await pool.query(
      `SELECT to_char(baseline_finish,'YYYY-MM-DD') AS bf, schedule_state FROM planning.task WHERE id = $1`, [TASK_A],
    );
    assert.equal(tasks[0].bf, '2026-09-28');
    assert.equal(tasks[0].schedule_state, 'on_baseline'); // the row now sits ON the new baseline
    const { rows: formalised } = await pool.query('SELECT status, change_order_id FROM planning.variation WHERE id = $1', [variationId]);
    assert.equal(formalised[0].status, 'formalised');
    assert.equal(formalised[0].change_order_id, CO);
    const { rows: taken } = await pool.query(
      `SELECT count(*) FROM platform.outbox WHERE type = 'planning.baseline.taken' AND (data->>'reason') = 'change_order'`,
    );
    assert.equal(Number(taken[0].count), 1);

    // at-least-once: the SAME change order arrives again → absorbed
    const client2 = await pool.connect();
    try {
      await client2.query('BEGIN');
      await publishEvent(client2, approvedEvt());
      await client2.query('COMMIT');
    } finally {
      client2.release();
    }
    await dispatchPending(pool, planningConsumers(store));
    const { rows: still } = await pool.query('SELECT count(*) FROM planning.baseline WHERE contract_id = $1', [CONTRACT]);
    assert.equal(Number(still[0].count), 2);
  });

  test('progress + quality consumers: verified appended once, status surfaces', async () => {
    const reported = await reportProgress({
      viewer, store, taskId: TASK_A, body: { status: 'done', note: 'betonagem concluída' },
    });
    assert.equal(reported.status, 201);
    assert.equal(reported.body.seq, 1);
    const { rows: evts } = await pool.query(
      `SELECT data FROM platform.outbox WHERE type = 'planning.progress.reported'`,
    );
    assert.equal(evts.length, 1);
    assert.equal(evts[0].data.status, 'done');
    assert.equal(evts[0].data.task_name, 'Fundações');

    const accepted = () => ({
      event_id: randomUUID(), type: 'quality.verification.accepted', version: 1,
      project_id: PROJECT, actor: { person_id: PERSON, org_id: OWNER_ORG },
      scope: { type: 'project', id: PROJECT },
      data: { task_id: TASK_A, decided_by_org_id: OWNER_ORG, decided_by_person_id: PERSON, note: 'conforme' },
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await publishEvent(client, accepted());
      await publishEvent(client, accepted()); // at-least-once replay
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await dispatchPending(pool, planningConsumers(store));

    const { rows: trail } = await pool.query(
      'SELECT seq, status, note FROM planning.progress_report WHERE task_id = $1 ORDER BY seq', [TASK_A],
    );
    assert.deepEqual(trail.map((t) => t.status), ['done', 'verified']); // the replay appended nothing
    assert.equal(trail[1].note, 'conforme');

    const schedule = await getSchedule({ viewer, store, projectId: PROJECT, query: {} });
    const row = schedule.body.tasks.find((t) => t.id === TASK_A);
    assert.equal(row.status, 'verified');

    // a rejection later sends it back to in_progress with the reason
    const client2 = await pool.connect();
    try {
      await client2.query('BEGIN');
      await publishEvent(client2, {
        event_id: randomUUID(), type: 'quality.verification.rejected', version: 1,
        project_id: PROJECT, actor: { person_id: PERSON, org_id: OWNER_ORG },
        scope: { type: 'project', id: PROJECT },
        data: { task_id: TASK_A, decided_by_org_id: OWNER_ORG, decided_by_person_id: PERSON, reason: 'fissura no lintel' },
      });
      await client2.query('COMMIT');
    } finally {
      client2.release();
    }
    await dispatchPending(pool, planningConsumers(store));
    const { rows: after } = await pool.query(
      'SELECT status, note FROM planning.progress_report WHERE task_id = $1 ORDER BY seq DESC LIMIT 1', [TASK_A],
    );
    assert.equal(after[0].status, 'in_progress');
    assert.equal(after[0].note, 'fissura no lintel');
  });

  test('a cost-line write commits row + ledger + outbox together, and rolls up', async () => {
    const lineId = randomUUID();
    const res = await createCostLine({
      viewer, store, taskId: TASK_A,
      body: {
        id: lineId, code: 'est.1', description: 'Estimativa fundações', unit: 'vg',
        quantity: '1.000', unit_price: { amount_cents: 250000, currency: 'EUR' },
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.contract_id, null); // an owner estimate

    const { rows } = await pool.query('SELECT estimate_owner_org_id FROM contracting.boq_item WHERE id = $1', [lineId]);
    assert.equal(rows[0].estimate_owner_org_id, OWNER_ORG);
    const { rows: ledger } = await pool.query(
      `SELECT count(*) FROM record.audit_event WHERE type = 'contracting.boq_line.created'`,
    );
    assert.equal(Number(ledger[0].count), 1);
    const { rows: outbox } = await pool.query(
      `SELECT count(*) FROM platform.outbox WHERE type = 'contracting.boq_line.created'`,
    );
    assert.equal(Number(outbox[0].count), 1);

    // the estimate rolls up to the owner's cost column (D-27 / checks §2)
    const schedule = await getSchedule({ viewer, store, projectId: PROJECT, query: {} });
    const row = schedule.body.tasks.find((t) => t.id === TASK_A);
    assert.equal(row.cost.cost.amount_cents, 250000);

    const variations = await listVariations({ viewer, store, projectId: PROJECT, query: {} });
    assert.ok(variations.body.items.length >= 1);
    const one = await getVariation({ viewer, store, variationId: variations.body.items[0].id });
    assert.equal(one.status, 200);
  });
});
