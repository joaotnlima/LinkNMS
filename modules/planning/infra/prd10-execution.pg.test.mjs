// PRD-10 over the REAL v2 migrations (throwaway DB). Skipped without
// DATABASE_URL. Proves end to end, at the use-case level:
//   E-1   the award takes v1 (who: the awarding org), a change order v2; the
//         selector lists both newest first; the plan drawn ?baseline=v1;
//   E-10/E-11 who is on site when, and the two trades on the Roof overlap;
//   E-5   starting before the predecessor is done → 409 predecessors_open, a
//         reason makes it go through and the override is on the record
//         (progress row, ledger payload, outbox event); the task panel shows
//         what it waits on;
//   E-6   done records which acceptance criteria were met;
//   E-7..E-9 a capture of presence, weather, work, an issue and a tagged photo
//         lands in one transaction with its ledger entry and event; replays
//         are absorbed, edits refused; work out of scope 403; the day, the
//         days and the task read back.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createPlanningStore } from './pg-store.mjs';
import { planningConsumers } from '../application/consumers.mjs';
import { getSchedule, getTask, reportProgress } from '../application/use-cases.mjs';
import { listBaselines } from '../application/baselines.mjs';
import { getSiteCalendar } from '../application/site-calendar.mjs';
import {
  addDailyLogEntries, getDailyLog, listDailyLogs, listTaskDailyLogEntries,
} from '../application/daily-log.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the planning Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_planning_prd10_test';

const OWNER_ORG = randomUUID();
const GC_ORG = randomUUID();
const ELEC_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const PRIME = randomUUID();
const DIRECT = randomUUID();
const ROOF = randomUUID();
const STRUCT = randomUUID(); // GC's branch — the predecessor
const ELECW = randomUUID(); // tendered, awarded to ELEC
const PHOTO = randomUUID();
const DRAWING = randomUUID();
const TODAY = new Date().toISOString().slice(0, 10);

function viewer(orgId) {
  return { clerkUserId: 'user_rui', personId: PERSON, orgId, orgRole: 'admin', channel: 'ui', has: () => true };
}

const documents = {
  async versionFacts({ documentId }) {
    if (documentId === PHOTO) return { document_id: PHOTO, project_id: PROJECT, version_no: 2, kind: 'photo', sha256: 'a'.repeat(64) };
    if (documentId === DRAWING) return { document_id: DRAWING, project_id: PROJECT, version_no: 1, kind: 'drawing', sha256: 'b'.repeat(64) };
    return null;
  },
};

describe('PRD-10 running the plan over Postgres', { skip }, () => {
  let pg, admin, pool, store, builds;
  const ids = {};

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 3 });
    for (const f of readdirSync(join(ROOT, 'db', 'v2')).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
      await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
    }
    await pool.query(
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES
         ($1, 'o1', 'household', 'Família Almeida'), ($2, 'o2', 'contractor', 'Obra Nova'), ($3, 'o3', 'contractor', 'Eletro Mota')`,
      [OWNER_ORG, GC_ORG, ELEC_ORG],
    );
    await pool.query(`INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES ($1, 'user_rui', 'r@x.pt', 'Rui')`, [PERSON]);
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code) VALUES ($1, $2, $2, 'Casa', '1111')`,
      [PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO project.participation (project_id, org_id, capacity, source, contract_id) VALUES
         ($1, $2, 'owner', 'project', NULL), ($1, $3, 'prime_contractor', 'contract', $5), ($1, $4, 'direct_contractor', 'contract', $6)`,
      [PROJECT, OWNER_ORG, GC_ORG, ELEC_ORG, PRIME, DIRECT],
    );
    await pool.query(
      `INSERT INTO contracting.contract (id, project_id, kind, client_org_id, supplier_org_id, reference, origin, origin_proposal_id, status) VALUES
         ($1, $3, 'prime', $4, $5, 'P-1', 'direct_entry', NULL, 'active'),
         ($2, $3, 'direct', $4, $6, 'D-1', 'award', $7, 'draft')`,
      [PRIME, DIRECT, PROJECT, OWNER_ORG, GC_ORG, ELEC_ORG, randomUUID()],
    );
    await pool.query(
      `INSERT INTO project.location (id, project_id, kind, name, position) VALUES ($1, $2, 'zone', 'Roof', 'a')`, [ROOF, PROJECT],
    );
    // 2027-02-01 is a Monday. Structure (GC) → Electrics (tendered), end→start.
    await pool.query(
      `INSERT INTO planning.task (id, project_id, depth, position, name, dating_mode, start, finish, duration_wd,
                                  location_id, contract_id, branch_contract_id, assignee_org_id) VALUES
         ($1, $3, 1, 'a', 'Roof structure', 'dated', '2027-02-01', '2027-02-05', 5, $4, $5, $5, $6),
         ($2, $3, 1, 'b', 'Roof electrics', 'dated', '2027-02-08', '2027-02-12', 5, $4, NULL, NULL, NULL)`,
      [STRUCT, ELECW, PROJECT, ROOF, PRIME, GC_ORG],
    );
    await pool.query(
      `INSERT INTO planning.link (id, project_id, predecessor_id, successor_id, from_anchor, to_anchor, lag_wd,
         created_by_org_id, created_by_person_id) VALUES ($1, $2, $3, $4, 'end', 'start', -3, $5, $6)`,
      [randomUUID(), PROJECT, STRUCT, ELECW, OWNER_ORG, PERSON],
    );
    store = createPlanningStore(pool);
    // The project's build port as the composition root injects it (location names).
    builds = {
      async locationNamesOf(projectId) {
        const { rows } = await pool.query('SELECT id, name FROM project.location WHERE project_id = $1', [projectId]);
        return new Map(rows.map((r) => [r.id, r.name]));
      },
    };
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
    await admin?.end();
  });

  test('E-1: award v1 and change-order v2 listed newest first, with who; the plan drawn against v1', async () => {
    await planningConsumers(store)['tendering.rfp.awarded']({
      event_id: randomUUID(), type: 'tendering.rfp.awarded', project_id: PROJECT,
      actor: { person_id: PERSON, org_id: OWNER_ORG }, scope: { type: 'project', id: PROJECT },
      data: { rfp_id: randomUUID(), proposal_id: randomUUID(), contract_id: DIRECT, root_task_ids: [ELECW],
        supplier_org_id: ELEC_ORG, start: '2027-02-03', duration_wd: 5 },
    });
    await store.baselineFromChangeOrder({
      contractId: DIRECT, changeOrderId: randomUUID(), projectId: PROJECT,
      time: [{ task_id: ELECW, new_baseline_start: '2027-02-08', new_baseline_finish: '2027-02-12' }],
      fromVariationIds: [], actor: { personId: PERSON, orgId: ELEC_ORG },
    });

    const list = (await listBaselines({ viewer: viewer(GC_ORG), store, builds, projectId: PROJECT, query: {} })).body.items;
    assert.deepEqual(list.map((b) => [b.version, b.reason, b.is_current, b.branch_name, b.row_count]), [
      [2, 'change_order', true, 'Roof electrics', 1],
      [1, 'award', false, 'Roof electrics', 1],
    ]);
    assert.deepEqual([list[1].taken_by.org_id, list[1].taken_by_org_name], [OWNER_ORG, 'Família Almeida']);
    [ids.v2, ids.v1] = list.map((b) => b.id);
    const scoped = await listBaselines({ viewer: viewer(GC_ORG), store, builds, projectId: PROJECT, query: { root: STRUCT } });
    assert.deepEqual(scoped.body.items, []);

    const now = (await getSchedule({ viewer: viewer(OWNER_ORG), store, builds, projectId: PROJECT, query: {} })).body;
    assert.deepEqual(now.tasks.find((t) => t.id === ELECW).baseline.start, '2027-02-08');
    assert.equal(now.compared_to, undefined);
    const v1 = (await getSchedule({ viewer: viewer(OWNER_ORG), store, builds, projectId: PROJECT, query: { baseline: ids.v1 } })).body;
    const row = v1.tasks.find((t) => t.id === ELECW);
    assert.deepEqual([row.baseline.start, row.baseline.version, row.baseline.reason], ['2027-02-03', 1, 'award']);
    assert.deepEqual([v1.compared_to.baseline_id, v1.compared_to.version], [ids.v1, 1]);
    await assert.rejects(
      getSchedule({ viewer: viewer(OWNER_ORG), store, builds, projectId: PROJECT, query: { baseline: randomUUID() } }),
      (err) => err.problem?.status === 404,
    );
  });

  test('E-10/E-11: on site by organisation and location; two trades on the Roof overlap', async () => {
    const res = await getSiteCalendar({ viewer: viewer(ELEC_ORG), store, builds, projectId: PROJECT, query: { from: '2027-02-01', to: '2027-02-28' } });
    assert.deepEqual(res.body.presence.map((p) => [p.task_id, p.org_name, p.location_name, p.days.length]), [
      [STRUCT, 'Obra Nova', 'Roof', 5],
      [ELECW, 'Eletro Mota', 'Roof', 5],
    ]);
    const [overlap] = res.body.overlaps;
    assert.deepEqual([overlap.location_name, overlap.from, overlap.to, overlap.days], ['Roof', '2027-02-03', '2027-02-05', 3]);
    assert.deepEqual(overlap.tasks.map((t) => t.task_id).sort(), [STRUCT, ELECW].sort());
    await assert.rejects(
      getSiteCalendar({ viewer: viewer(ELEC_ORG), store, builds, projectId: PROJECT, query: { from: '2027-01-01', to: '2028-06-01' } }),
      (err) => err.problem?.status === 422,
    );
  });

  test('E-5: a start ahead of the predecessor asks for a reason; with one it is recorded', async () => {
    const panel = (await getTask({ viewer: viewer(ELEC_ORG), store, builds, taskId: ELECW })).body;
    assert.deepEqual(panel.waiting_on.map((w) => [w.task_id, w.status, w.needs, w.met]), [[STRUCT, 'not_started', 'finished', false]]);

    await assert.rejects(
      reportProgress({ viewer: viewer(ELEC_ORG), store, builds, taskId: ELECW, body: { status: 'in_progress' } }),
      (err) => err.problem?.status === 409 && err.problem.reason === 'predecessors_open'
        && err.problem.waiting_on[0].task_id === STRUCT,
    );
    const res = await reportProgress({
      viewer: viewer(ELEC_ORG), store, builds, taskId: ELECW,
      body: { status: 'in_progress', override_reason: 'Conduits go in before the roof closes' },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.out_of_sequence, {
      reason: 'Conduits go in before the roof closes',
      waiting_on: [{ task_id: STRUCT, name: 'Roof structure', status: 'not_started', needs: 'finished' }],
    });
    const { rows: [entry] } = await pool.query(
      `SELECT payload FROM record.audit_event WHERE type = 'planning.progress.reported' AND object_id = $1`, [ELECW],
    );
    assert.equal(entry.payload.out_of_sequence.reason, 'Conduits go in before the roof closes');
    const { rows: [evt] } = await pool.query(
      `SELECT data FROM platform.outbox WHERE type = 'planning.progress.reported' AND data->>'task_id' = $1`, [ELECW],
    );
    assert.equal(evt.data.out_of_sequence.waiting_on[0].task_id, STRUCT);
    // Already started: the next report needs no reason.
    const blocked = await reportProgress({ viewer: viewer(ELEC_ORG), store, builds, taskId: ELECW, body: { status: 'blocked' } });
    assert.equal(blocked.body.out_of_sequence, undefined);
  });

  test('E-6: done records which acceptance criteria were met', async () => {
    await pool.query(`UPDATE planning.task SET acceptance_criteria = $2 WHERE id = $1`, [ELECW, '- Circuits tested\n- Labels fitted']);
    const panel = (await getTask({ viewer: viewer(ELEC_ORG), store, builds, taskId: ELECW })).body;
    assert.deepEqual(panel.acceptance_checklist, ['Circuits tested', 'Labels fitted']);
    await assert.rejects(
      reportProgress({ viewer: viewer(ELEC_ORG), store, builds, taskId: ELECW, body: { status: 'done', criteria_met: ['Painted'] } }),
      (err) => err.problem?.status === 422 && Boolean(err.problem.errors.criteria_met),
    );
    const res = await reportProgress({ viewer: viewer(ELEC_ORG), store, builds, taskId: ELECW, body: { status: 'done', criteria_met: ['Circuits tested'] } });
    assert.deepEqual(res.body.acceptance, [{ criterion: 'Circuits tested', met: true }, { criterion: 'Labels fitted', met: false }]);
    const after = (await getTask({ viewer: viewer(OWNER_ORG), store, builds, taskId: ELECW })).body;
    assert.deepEqual(after.progress.at(-1).acceptance.map((a) => a.met), [true, false]);
  });

  test('E-7..E-9: one capture, ledgered once; replays absorbed; scope and photo kind enforced; read back', async () => {
    const e = (kind, extra) => ({ id: randomUUID(), kind, ...extra });
    const capture = [
      e('presence', { org_id: GC_ORG, headcount: 6 }),
      e('presence', { org_id: ELEC_ORG, headcount: 2 }),
      e('weather', { weather: 'rain', temperature_c: 11 }),
      e('work', { task_id: STRUCT, percent: 40, note: 'Rafters up on the north side' }),
      e('issue', { note: 'Scaffold tie loose', location_id: ROOF }),
      e('photo', { document_id: PHOTO, task_id: ELECW, location_id: ROOF, note: 'Conduit run' }),
    ];
    const res = await addDailyLogEntries({ viewer: viewer(GC_ORG), store, builds, documents, projectId: PROJECT, date: TODAY, body: { entries: capture } });
    assert.equal(res.status, 201);
    assert.deepEqual([res.body.headcount_total, res.body.weather.weather, res.body.work.length, res.body.photos[0].version_no],
      [8, 'rain', 1, 2]);
    assert.equal(res.body.photos[0].task_name, 'Roof electrics');
    assert.equal(res.body.issues[0].location_name, 'Roof');

    const replay = await addDailyLogEntries({ viewer: viewer(GC_ORG), store, builds, documents, projectId: PROJECT, date: TODAY, body: { entries: capture.slice(0, 2) } });
    assert.equal(replay.status, 200);
    await assert.rejects(
      addDailyLogEntries({ viewer: viewer(GC_ORG), store, builds, documents, projectId: PROJECT, date: TODAY,
        body: { entries: [{ ...capture[0], headcount: 9 }] } }),
      (err) => err.problem?.code === 'idempotency_mismatch',
    );
    const { rows: ledger } = await pool.query(`SELECT payload FROM record.audit_event WHERE type = 'planning.daily_log.recorded'`);
    assert.equal(ledger.length, 1);
    assert.deepEqual(ledger[0].payload.photos, [{ document_id: PHOTO, version_no: 2 }]);
    const { rows: events } = await pool.query(`SELECT data FROM platform.outbox WHERE type = 'planning.daily_log.recorded'`);
    assert.deepEqual(events.map((r) => r.data.entry_ids.length), [6]);

    // The GC is not responsible for the direct contractor's row (D-33).
    await assert.rejects(
      addDailyLogEntries({ viewer: viewer(GC_ORG), store, builds, documents, projectId: PROJECT, date: TODAY,
        body: { entries: [e('work', { task_id: ELECW })] } }),
      (err) => err.problem?.code === 'out_of_scope',
    );
    await assert.rejects(
      addDailyLogEntries({ viewer: viewer(GC_ORG), store, builds, documents, projectId: PROJECT, date: TODAY,
        body: { entries: [e('photo', { document_id: DRAWING }), e('presence', { org_id: randomUUID(), headcount: 1 })] } }),
      (err) => err.problem?.status === 422 && Boolean(err.problem.errors['entries[0].document_id'] && err.problem.errors['entries[1].org_id']),
    );
    await assert.rejects(
      addDailyLogEntries({ viewer: viewer(GC_ORG), store, builds, documents, projectId: PROJECT, date: '2999-01-01', body: { entries: capture } }),
      (err) => err.problem?.status === 422 && Boolean(err.problem.errors.date),
    );
    // Append-only.
    await assert.rejects(pool.query('UPDATE planning.daily_log_entry SET headcount = 1'));

    const day = await getDailyLog({ viewer: viewer(OWNER_ORG), store, builds, projectId: PROJECT, date: TODAY });
    assert.equal(day.body.entries.length, 6);
    const days = await listDailyLogs({ viewer: viewer(OWNER_ORG), store, builds, projectId: PROJECT, query: {} });
    assert.deepEqual(days.body.items.map((d) => [d.date, d.org_count, d.headcount_total, d.photo_count]), [[TODAY, 2, 8, 1]]);
    const onTask = await listTaskDailyLogEntries({ viewer: viewer(OWNER_ORG), store, builds, taskId: ELECW });
    assert.deepEqual(onTask.body.items.map((x) => [x.kind, x.document_id]), [['photo', PHOTO]]);
    const empty = await getDailyLog({ viewer: viewer(OWNER_ORG), store, builds, projectId: PROJECT, date: '2020-01-01' });
    assert.deepEqual([empty.status, empty.body.entries.length], [200, 0]);
  });
});
