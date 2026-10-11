// PRD-10 over the /api/v2 router, DB-free: the routes are registered under
// their operationIds, the doc-16 conjunction on each (permission ∧
// relationship), existence hiding, validation, and the E-5 409 on
// POST /tasks/{id}/progress.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerPlanning } from './register.mjs';
import { createInMemoryIdempotency } from '../../../platform/idempotency.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000010a1';
const STRANGER = '01920000-0000-7000-8000-0000000010a9';
const PROJECT = '01920000-0000-7000-8000-0000000010b1';
const PRED = '01920000-0000-7000-8000-0000000010d1';
const TASK = '01920000-0000-7000-8000-0000000010d2';
const ME = '01920000-0000-7000-8000-0000000010c1';
const BASELINE = '01920000-0000-7000-8000-0000000010e1';
const today = new Date().toISOString().slice(0, 10);

function fakeStore() {
  const state = { progress: [], inserted: [] };
  const tasks = new Map([
    [PRED, { id: PRED, projectId: PROJECT, parentId: null, name: 'Slab', branchContractId: null, kind: 'task', start: '2027-02-01', finish: '2027-02-05' }],
    [TASK, { id: TASK, projectId: PROJECT, parentId: null, name: 'Walls', branchContractId: null, kind: 'task', start: '2027-02-08', finish: '2027-02-12', assigneeOrgId: OWNER_ORG }],
  ]);
  return {
    idempotent: createInMemoryIdempotency(),
    state,
    async getPersonByClerkId(id) { return id === 'user_me' ? { id: ME } : null; },
    async getProject(id) { return id === PROJECT ? { id, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG } : null; },
    async isParticipant(projectId, orgId) { return projectId === PROJECT && orgId === OWNER_ORG; },
    async isStaffed() { return true; },
    async getTask(id) { return tasks.has(id) ? { ...tasks.get(id), deletedAt: null } : null; },
    async loadPlan() {
      return {
        tasks, contracts: new Map(), ownerOrgId: OWNER_ORG, statuses: new Map(), orgNames: new Map(),
        links: [{ id: 'l', predecessorId: PRED, successorId: TASK, fromAnchor: 'end', toAnchor: 'start', lagWd: 0 }],
        calendarRaw: { work_days: [1, 2, 3, 4, 5] },
      };
    },
    async listBaselines() {
      return [{ id: BASELINE, contract_id: 'c', version: 1, reason: 'award', root_task_ids: [TASK], root_names: ['Walls'], row_count: 1, taken_at_iso: '2026-01-01T00:00:00Z' }];
    },
    async locationNames() { return new Map(); },
    async listDailyLogWindow() { return []; },
    async listDailyLogDay() { return state.inserted; },
    async getDailyLogEntries() { return []; },
    async insertDailyLogEntries({ entries }) { state.inserted.push(...entries.map((e) => ({ ...e, log_date: today, kind: e.kind }))); return entries.map((e) => e.id); },
    async insertProgress(p) { state.progress.push(p); return { ...p, seq: 1, reportedAt: 'now' }; },
  };
}

function viewer(orgId, permissions = ['org:plan:edit', 'org:progress:report']) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: `clerk_${orgId}`,
    orgKind: 'household', orgRole: 'manager', permissions, channel: 'ui',
  });
}

describe('PRD-10 over the /api/v2 router', () => {
  let router, store;
  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerPlanning(router, { store });
  });
  const dispatch = (method, path, v, body = null, query = {}) => router.dispatch({ method, path, viewer: v, body, query, headers: {} });

  test('the operations are registered', () => {
    const ops = new Set(router.routes().map((r) => r.operationId));
    for (const op of ['listBaselines', 'getSiteCalendar', 'listDailyLogs', 'getDailyLog', 'addDailyLogEntries', 'listTaskDailyLogEntries']) {
      assert.ok(ops.has(op), op);
    }
  });

  test('listBaselines: participants read the selector; strangers 404', async () => {
    const res = await dispatch('GET', `/projects/${PROJECT}/baselines`, viewer(OWNER_ORG));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((b) => [b.version, b.is_current, b.branch_name]), [[1, true, 'Walls']]);
    assert.equal((await dispatch('GET', `/projects/${PROJECT}/baselines`, viewer(STRANGER))).status, 404);
  });

  test('getSiteCalendar: window validated; strangers 404', async () => {
    const ok = await dispatch('GET', `/projects/${PROJECT}/site-calendar`, viewer(OWNER_ORG), null, { from: '2027-02-01', to: '2027-02-28' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.presence.map((p) => p.task_id), [TASK]);
    assert.equal(ok.body.unassigned_count, 1);
    const bad = await dispatch('GET', `/projects/${PROJECT}/site-calendar`, viewer(OWNER_ORG), null, { from: 'soon' });
    assert.equal(bad.status, 422);
    assert.equal((await dispatch('GET', `/projects/${PROJECT}/site-calendar`, viewer(STRANGER))).status, 404);
  });

  test('addDailyLogEntries: needs org:progress:report; validates; records', async () => {
    const entries = [{ id: '01920000-0000-7000-8000-0000000010f1', kind: 'weather', weather: 'sunny' }];
    const path = `/projects/${PROJECT}/daily-logs/${today}/entries`;
    assert.equal((await dispatch('POST', path, viewer(OWNER_ORG, []), { entries })).status, 403);
    assert.equal((await dispatch('POST', `/projects/${PROJECT}/daily-logs/2999-01-01/entries`, viewer(OWNER_ORG), { entries })).status, 422);
    assert.equal((await dispatch('POST', path, viewer(OWNER_ORG), { entries: [{ kind: 'weather' }] })).status, 422);
    const ok = await dispatch('POST', path, viewer(OWNER_ORG), { entries });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.weather.weather, 'sunny');
    assert.equal((await dispatch('GET', `/projects/${PROJECT}/daily-logs/${today}`, viewer(STRANGER))).status, 404);
  });

  test('E-5: starting ahead of the predecessor is 409 predecessors_open until a reason is given', async () => {
    const res = await dispatch('POST', `/tasks/${TASK}/progress`, viewer(OWNER_ORG), { status: 'in_progress' });
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'predecessors_open');
    assert.deepEqual(res.body.waiting_on.map((w) => [w.task_id, w.needs, w.met]), [[PRED, 'finished', false]]);
    assert.equal(store.state.progress.length, 0);
    const tooLong = await dispatch('POST', `/tasks/${TASK}/progress`, viewer(OWNER_ORG), { status: 'in_progress', override_reason: 'x'.repeat(501) });
    assert.equal(tooLong.status, 422);
    const ok = await dispatch('POST', `/tasks/${TASK}/progress`, viewer(OWNER_ORG), { status: 'in_progress', override_reason: 'Formwork ready early' });
    assert.equal(ok.status, 201);
    assert.equal(store.state.progress[0].outOfSequence.reason, 'Formwork ready early');
  });
});
