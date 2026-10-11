// Regression: a build WITH a project.calendar row (fix/autosave-internal).
//
// project.calendar.closures is daterange[]; node-postgres has no parser for it
// and returns the column as one array-literal string. loadPlanOn called `.map`
// on that string, so every plan read AND write of such a build (GET /schedule,
// the editor's autosave: schedule:apply + PATCH /tasks/{id}) answered
// 500 internal — "Something went wrong on our side". No planning suite ever
// inserted a calendar row, so every suite stayed green.
//
// The closuresN cases run without a database; the router cases run over every
// db/v2 migration in a throwaway DB (skipped without DATABASE_URL):
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/calendar.pg.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createPlanningStore, closuresN } from './pg-store.mjs';
import { registerPlanning } from '../http/register.mjs';
import { createRouter } from '../../../platform/router.mjs';

test('closuresN: JSON rows, a raw daterange[] literal, empty and junk — inclusive bounds, never a throw', () => {
  assert.deepEqual(closuresN([{ from: '2026-08-10', to: '2026-08-21' }]), [{ from: '2026-08-10', to: '2026-08-21' }]);
  // what pg hands back for the bare column: canonical [lower, upper)
  assert.deepEqual(
    closuresN('{"[2026-08-10,2026-08-22)","[2026-12-24,2026-12-27)"}'),
    [{ from: '2026-08-10', to: '2026-08-21' }, { from: '2026-12-24', to: '2026-12-26' }],
  );
  assert.deepEqual(closuresN('{}'), []);
  assert.deepEqual(closuresN(null), []);
  assert.deepEqual(closuresN(undefined), []);
  assert.deepEqual(closuresN([{ from: null }]), []);
});

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the calendar Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_planning_calendar_test';

const OWNER_ORG = randomUUID();
const PERSON = randomUUID();
const CLOSED = randomUUID(); // a calendar row with a closure (Aug 10–21, the summer shutdown)
const EMPTY = randomUUID(); // a calendar row with '{}' closures
const viewer = {
  clerkUserId: 'user_cal', orgId: OWNER_ORG, orgRole: 'admin', channel: 'ui',
  has: () => true,
};

describe('a build with a project.calendar row (every db/v2 migration)', { skip }, () => {
  let pg, admin, pool, router;
  const call = async (method, path, body, headers = {}) => {
    const res = await router.dispatch({
      method, path, viewer, body: body ?? null, rawBody: body ? JSON.stringify(body) : null, headers,
    });
    assert.ok(res.status < 500, `${method} ${path} answered ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  };

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 3 });
    // The whole v2 set, in the runner's order — the schema an upgraded
    // production database has, not a hand-picked subset.
    const dir = join(ROOT, 'db', 'v2');
    for (const f of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
      await pool.query(readFileSync(join(dir, f), 'utf8'));
    }
    await pool.query(
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES ($1, 'org_cal', 'household', 'Casa Calendário')`,
      [OWNER_ORG],
    );
    await pool.query(`INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES ($1, 'user_cal', 'cal@casa.pt', 'Cal')`, [PERSON]);
    await pool.query(`INSERT INTO identity.org_membership (org_id, person_id, org_role) VALUES ($1, $2, 'admin')`, [OWNER_ORG, PERSON]);
    for (const [id, closures] of [[CLOSED, `ARRAY[daterange('2026-08-10', '2026-08-22')]`], [EMPTY, `'{}'::daterange[]`]]) {
      await pool.query(
        `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code, status)
         VALUES ($1, $2, $2, 'Casa', '1306', 'in_execution')`,
        [id, OWNER_ORG],
      );
      await pool.query(`INSERT INTO project.participation (project_id, org_id, capacity, source) VALUES ($1, $2, 'owner', 'project')`, [id, OWNER_ORG]);
      await pool.query(`INSERT INTO project.calendar (project_id, work_days, closures) VALUES ($1, '{1,2,3,4,5}', ${closures})`, [id]);
    }
    router = createRouter();
    registerPlanning(router, { store: createPlanningStore(pool) });
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
    await admin?.end();
  });

  test('GET /schedule answers 200 and the closure as inclusive dates', async () => {
    const res = await call('GET', `/projects/${CLOSED}/schedule`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.calendar.closures, [{ from: '2026-08-10', to: '2026-08-21' }]);
    const empty = await call('GET', `/projects/${EMPTY}/schedule`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.calendar.closures, []);
  });

  test('the autosave requests (schedule:apply create, PATCH rename + dates) succeed and honour the closure', async () => {
    const phase = randomUUID();
    const task = randomUUID();
    const changeId = randomUUID();
    const apply = await call('POST', `/projects/${CLOSED}/schedule:apply`, {
      client_change_id: changeId,
      operations: [{
        op: 'create_rows',
        rows: [
          { id: phase, parent_id: null, name: 'Estrutura', dating_mode: 'undated' },
          // Fri 7 Aug + 3 working days: the shutdown (10–21) and the weekends are skipped
          { id: task, parent_id: phase, name: 'Lajes', dating_mode: 'dated', start: '2026-08-07', duration_wd: 3 },
        ],
      }],
    }, { 'idempotency-key': changeId });
    assert.equal(apply.status, 200, JSON.stringify(apply.body));

    const rename = await call('PATCH', `/tasks/${task}`, {
      changes: { name: { value: 'Lajes e vigas', base: 'Lajes' } }, client_change_id: randomUUID(),
    });
    assert.equal(rename.status, 200, JSON.stringify(rename.body));

    const view = await call('GET', `/projects/${CLOSED}/schedule`);
    const row = view.body.tasks.find((t) => t.id === task);
    assert.equal(row.name, 'Lajes e vigas');
    assert.equal(row.start, '2026-08-07');
    assert.equal(row.finish, '2026-08-25');

    // a bar drag (both dates, the editor's PATCH shape) on the same build
    const moved = await call('PATCH', `/tasks/${task}`, {
      changes: { start: { value: '2026-08-24', base: '2026-08-07' }, finish: { value: '2026-08-28', base: '2026-08-25' } },
      client_change_id: randomUUID(),
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const dragged = (await call('GET', `/projects/${CLOSED}/schedule`)).body.tasks.find((t) => t.id === task);
    assert.equal(dragged.start, '2026-08-24');
    assert.equal(dragged.finish, '2026-08-28');
  });
});
