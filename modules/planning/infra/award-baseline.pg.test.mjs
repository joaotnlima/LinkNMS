// D-43 over the REAL v2 migrations: tendering.rfp.awarded → planning consumer
// → the winning start/duration on the tendered row, links propagate, the
// winner takes the row, branch bound + baseline v1 (reason 'award'), in one
// commit with its ledger entry and event. Idempotent under redelivery, and a
// later signature finds the branch already baselined. Planning reads nothing
// from tendering.* — everything rides on the event.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/award-baseline.pg.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createPlanningStore } from './pg-store.mjs';
import { planningConsumers } from '../application/consumers.mjs';
import { getSchedule, updateTask, listVariations } from '../application/use-cases.mjs';
import { acknowledgeVariations } from '../application/baseline-changes.mjs';
import { dispatchPending, publishEvent } from '../../../platform/outbox.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the planning Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_planning_award_test';

const OWNER_ORG = randomUUID();
const SUB_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const CONTRACT = randomUUID();
const ROOFING = randomUUID();
const PLUMBING = randomUUID();
const PROPOSAL = randomUUID(); // tendering's id — planning never reads it

describe('D-43 baseline at award over Postgres', { skip }, () => {
  let pg, admin, pool, store;

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 3 });
    const migrations = readdirSync(join(ROOT, 'db', 'v2')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const f of migrations) await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
    await pool.query(
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES
         ($1, 'org_owner', 'household', 'Família Almeida'), ($2, 'org_sub', 'contractor', 'Telhados do Norte')`,
      [OWNER_ORG, SUB_ORG],
    );
    await pool.query(
      `INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES ($1, 'user_marta', 'm@x.pt', 'Marta')`,
      [PERSON],
    );
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code)
       VALUES ($1, $2, $2, 'Casa da Encosta', '1111')`,
      [PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO project.participation (project_id, org_id, capacity, source) VALUES ($1, $2, 'owner', 'project')`,
      [PROJECT, OWNER_ORG],
    );
    // Roofing (tendered) → Plumbing, end→start. 2027-02-01 is a Monday.
    await pool.query(
      `INSERT INTO planning.task (id, project_id, depth, position, name, dating_mode, start, finish, duration_wd) VALUES
         ($1, $3, 1, 'a', 'Roofing',  'dated', '2027-01-25', '2027-01-29', 5),
         ($2, $3, 1, 'b', 'Plumbing', 'dated', '2027-02-01', '2027-02-05', 5)`,
      [ROOFING, PLUMBING, PROJECT],
    );
    await pool.query(
      `INSERT INTO planning.link (id, project_id, predecessor_id, successor_id, from_anchor, to_anchor, lag_wd,
         created_by_org_id, created_by_person_id) VALUES ($1, $2, $3, $4, 'end', 'start', 0, $5, $6)`,
      [randomUUID(), PROJECT, ROOFING, PLUMBING, OWNER_ORG, PERSON],
    );
    // The award's contract draft (contracting writes it on the award txn).
    await pool.query(
      `INSERT INTO contracting.contract
         (id, project_id, kind, client_org_id, supplier_org_id, reference, origin, origin_proposal_id)
       VALUES ($1, $2, 'direct', $3, $4, 'CTR-1', 'award', $5)`,
      [CONTRACT, PROJECT, OWNER_ORG, SUB_ORG, PROPOSAL],
    );
    store = createPlanningStore(pool);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
    await admin?.end();
  });

  const publish = async (type, scope, data) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await publishEvent(client, {
        event_id: randomUUID(), type, version: 1, project_id: PROJECT,
        actor: { person_id: PERSON, org_id: OWNER_ORG }, scope, data,
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  };

  const awarded = {
    rfp_id: randomUUID(), proposal_id: PROPOSAL, contract_id: CONTRACT,
    root_task_ids: [ROOFING], supplier_org_id: SUB_ORG, start: '2027-02-01', duration_wd: 19,
  };

  test('award → winning dates, propagation, assignment and baseline v1 (award) in one commit', async () => {
    await publish('tendering.rfp.awarded', { type: 'project', id: PROJECT }, awarded);
    await dispatchPending(pool, planningConsumers(store));

    const { rows: [roof] } = await pool.query(
      `SELECT to_char(start,'YYYY-MM-DD') s, to_char(finish,'YYYY-MM-DD') f, duration_wd,
              to_char(baseline_start,'YYYY-MM-DD') bs, to_char(baseline_finish,'YYYY-MM-DD') bf,
              contract_id, branch_contract_id, assignee_org_id, last_change_cause
         FROM planning.task WHERE id = $1`, [ROOFING],
    );
    assert.deepEqual(
      [roof.s, roof.f, roof.duration_wd, roof.bs, roof.bf],
      ['2027-02-01', '2027-02-25', 19, '2027-02-01', '2027-02-25'],
    );
    assert.equal(roof.contract_id, CONTRACT);
    assert.equal(roof.assignee_org_id, SUB_ORG);
    assert.equal(roof.last_change_cause, 'award');
    // D-22: the linked successor moved with it.
    const { rows: [plumb] } = await pool.query(
      `SELECT to_char(start,'YYYY-MM-DD') s FROM planning.task WHERE id = $1`, [PLUMBING],
    );
    assert.equal(plumb.s, '2027-02-26');

    const { rows: baselines } = await pool.query(
      'SELECT version, reason FROM planning.baseline WHERE contract_id = $1', [CONTRACT],
    );
    assert.deepEqual(baselines, [{ version: 1, reason: 'award' }]);
    const { rows: history } = await pool.query(
      `SELECT DISTINCT field FROM planning.task_field_change WHERE task_id = $1 AND cause = 'award' ORDER BY field`,
      [ROOFING],
    );
    assert.deepEqual(history.map((h) => h.field), ['assignee_org_id', 'duration_wd', 'finish', 'start']);
    const { rows: ledger } = await pool.query(
      `SELECT payload FROM record.audit_event WHERE project_id = $1 AND type = 'planning.baseline.taken'`, [PROJECT],
    );
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].payload.reason, 'award');
    const { rows: outbox } = await pool.query(
      `SELECT data FROM platform.outbox WHERE project_id = $1 AND type = 'planning.baseline.taken'`, [PROJECT],
    );
    assert.equal(outbox[0].data.reason, 'award');
  });

  test('redelivery and a later signature are absorbed — still one baseline', async () => {
    const before = await pool.query('SELECT count(*)::int n FROM planning.task_field_change');
    await publish('tendering.rfp.awarded', { type: 'project', id: PROJECT }, awarded);
    await publish('contracting.contract.signed', { type: 'contract', id: CONTRACT }, { kind: 'direct' });
    await dispatchPending(pool, planningConsumers(store));
    const { rows } = await pool.query('SELECT count(*)::int n FROM planning.baseline WHERE contract_id = $1', [CONTRACT]);
    assert.equal(rows[0].n, 1);
    const afterCount = await pool.query('SELECT count(*)::int n FROM planning.task_field_change');
    assert.equal(afterCount.rows[0].n, before.rows[0].n);
  });

  test('the plan read says the baseline came from the award (S-13)', async () => {
    const viewer = {
      clerkUserId: 'user_marta', orgId: OWNER_ORG, orgRole: 'admin', channel: 'ui',
      has: (p) => p === 'org:variations:acknowledge',
    };
    const res = await getSchedule({ viewer, store, projectId: PROJECT, query: {} });
    const roof = res.body.tasks.find((t) => t.id === ROOFING);
    assert.equal(roof.baseline.reason, 'award');
    assert.ok(roof.baseline.taken_at);
    assert.equal(res.body.handover.baseline_finish, '2027-02-25');
  });

  test('a moved finish keeps its "why" and its author; the owner acknowledges all in one commit', async () => {
    const owner = {
      clerkUserId: 'user_marta', orgId: OWNER_ORG, orgRole: 'admin', channel: 'ui',
      has: (p) => ['org:plan:edit', 'org:variations:acknowledge'].includes(p),
    };
    const res = await updateTask({
      viewer: owner, store, taskId: ROOFING,
      body: {
        client_change_id: randomUUID(), confirm_not_assignee: true, reason: 'Tiles arrive 10 days late.',
        changes: { finish: { value: '2027-03-04', base: '2027-02-25' } },
      },
    });
    assert.equal(res.status, 200);
    const list = await listVariations({ viewer: owner, store, projectId: PROJECT, query: {} });
    const roof = list.body.items.find((v) => v.task_id === ROOFING && v.kind === 'time');
    assert.equal(roof.reason, 'Tiles arrive 10 days late.');
    assert.equal(roof.changed_by_org_name, 'Família Almeida');
    assert.equal(roof.seen_by_viewer, false);
    assert.equal(roof.can_acknowledge, true);

    const ids = list.body.items.map((v) => v.id);
    const acked = await acknowledgeVariations({ viewer: owner, store, projectId: PROJECT, body: { variation_ids: ids } });
    assert.equal(acked.status, 200);
    assert.ok(acked.body.items.every((v) => v.status === 'acknowledged' && v.seen_by_viewer));
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM record.audit_event WHERE project_id = $1 AND type = 'planning.variation.acknowledged'`,
      [PROJECT],
    );
    assert.equal(rows[0].n, ids.length);
  });
});
