// PRD-02 planning reads/writes over the /api/v2 router, DB-free:
//   getTenderWindow     — coverage + left-out rows, work window, critical path,
//                         award-by from the project's mobilisation lead; input
//                         validation; existence hiding for non-participants;
//   get/putPlanningSettings — default 5 wd; owner or live prime edits; 422/403.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerPlanning } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000002a1';
const GC_ORG = '01920000-0000-7000-8000-0000000002a2';
const NUNO_ORG = '01920000-0000-7000-8000-0000000002a3';
const STRANGER = '01920000-0000-7000-8000-0000000002a9';
const PROJECT = '01920000-0000-7000-8000-0000000002b1';
const ME = '01920000-0000-7000-8000-0000000002e1';
const FRAME = '01920000-0000-7000-8000-0000000002d1';
const ROOF = '01920000-0000-7000-8000-0000000002d2';
const COVER = '01920000-0000-7000-8000-0000000002d3';
const GUTTER = '01920000-0000-7000-8000-0000000002d4';
const GARDEN = '01920000-0000-7000-8000-0000000002d5';

function task(id, over) {
  return {
    id, projectId: PROJECT, parentId: null, depth: 1, position: id, kind: 'task', name: id,
    assigneeOrgId: null, assigneePersonId: null, start: null, finish: null,
    actualStart: null, actualFinish: null, deletedAt: null, ...over,
  };
}

/** Contracting's party port (the prime contractor), as the composition root injects it. */
const partyPort = ({ prime = false } = {}) => ({ async isPrimeSupplier(projectId, orgId) { return prime && orgId === GC_ORG; } });

function fakeStore() {
  const state = { settings: null, ledger: [] };
  return {
    state,
    async getPersonByClerkId(id) { return id === 'user_me' ? { id: ME } : null; },
    async getProject(id) { return id === PROJECT ? { id, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG } : null; },
    async isParticipant(projectId, orgId) { return projectId === PROJECT && [OWNER_ORG, GC_ORG].includes(orgId); },
    async isStaffed() { return true; },
    async loadPlan() {
      return {
        tasks: new Map([
          [FRAME, task(FRAME, { name: 'Frame', start: '2027-01-25', finish: '2027-01-29' })],
          [ROOF, task(ROOF, { name: 'Roofing', kind: 'summary' })],
          [COVER, task(COVER, { name: 'Covering', parentId: ROOF, depth: 2, start: '2027-02-01', finish: '2027-02-26' })],
          [GUTTER, task(GUTTER, { name: 'Gutters & skylight', parentId: ROOF, depth: 2, start: '2027-02-22', finish: '2027-02-26', assigneeOrgId: NUNO_ORG })],
          [GARDEN, task(GARDEN, { name: 'Garden', start: '2027-01-04', finish: '2027-01-08' })],
        ]),
        links: [{ id: 'l1', predecessorId: FRAME, successorId: ROOF, fromAnchor: 'end', toAnchor: 'start', lagWd: 0 }],
        calendarRaw: { work_days: [1, 2, 3, 4, 5], holidays: [], closures: [] },
        contracts: new Map(), ownerOrgId: OWNER_ORG, statuses: new Map(),
        orgNames: new Map([[NUNO_ORG, 'Nuno Ferreira']]),
      };
    },
    async getPlanningSettings() { return state.settings; },
    async putPlanningSettings({ mobilisationLeadWd }) {
      state.settings = { mobilisation_lead_wd: mobilisationLeadWd };
      state.ledger.push('planning.settings.updated');
      return state.settings;
    },
  };
}

function viewer(orgId = OWNER_ORG, permissions = ['org:plan:edit']) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: `clerk_${orgId}`,
    orgKind: 'household', orgRole: 'manager', permissions, channel: 'ui',
  });
}

describe('PRD-02 planning over the /api/v2 router', () => {
  let router, store;
  const wire = (opts) => {
    router = createRouter();
    store = fakeStore();
    registerPlanning(router, { store, contracts: partyPort(opts) });
  };
  beforeEach(() => wire());
  const dispatch = (method, path, v, { body = null, query = {} } = {}) =>
    router.dispatch({ method, path, viewer: v, body, query, headers: {} });

  describe('getTenderWindow', () => {
    test('coverage, left-out row with its owner, window, critical path and award-by', async () => {
      const res = await dispatch('GET', `/projects/${PROJECT}/schedule/tender-window`, viewer(), {
        query: { task_ids: ROOF, bids_due: '2027-01-20' },
      });
      assert.equal(res.status, 200);
      const w = res.body;
      assert.equal(w.project_id, PROJECT);
      assert.deepEqual(w.covered_task_ids, [ROOF, COVER]);
      assert.deepEqual(w.left_out, [{
        task_id: GUTTER, name: 'Gutters & skylight', reason: 'assigned',
        assignee: { org_id: NUNO_ORG, name: 'Nuno Ferreira' },
      }]);
      assert.deepEqual(w.work_window, { start: '2027-02-01', finish: '2027-02-26', duration_wd: 20 });
      assert.equal(w.on_critical_path, true);
      assert.deepEqual(w.critical_task_ids, [COVER]);
      assert.equal(w.mobilisation_lead_wd, 5);
      assert.equal(w.award_by, '2027-01-25');
      assert.equal(w.wd_bids_due_to_start, 8);
      assert.equal(w.wd_bids_due_to_award_by, 3);
    });

    test('include= puts a left-out row back; the lead follows the project setting', async () => {
      store.state.settings = { mobilisation_lead_wd: 10 };
      const res = await dispatch('GET', `/projects/${PROJECT}/schedule/tender-window`, viewer(GC_ORG, []), {
        query: { task_ids: ROOF, include: GUTTER },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.covered_task_ids, [ROOF, COVER, GUTTER]);
      assert.deepEqual(res.body.left_out, []);
      assert.equal(res.body.mobilisation_lead_wd, 10);
      assert.equal(res.body.award_by, '2027-01-18');
      assert.equal(res.body.wd_bids_due_to_start, null);
    });

    test('bad input → 422; a row of another plan → 422; a non-participant → 404', async () => {
      const path = `/projects/${PROJECT}/schedule/tender-window`;
      assert.equal((await dispatch('GET', path, viewer(), { query: {} })).status, 422);
      assert.equal((await dispatch('GET', path, viewer(), { query: { task_ids: 'nope' } })).status, 422);
      assert.equal((await dispatch('GET', path, viewer(), { query: { task_ids: ROOF, bids_due: '20/01/2027' } })).status, 422);
      assert.equal((await dispatch('GET', path, viewer(), { query: { task_ids: STRANGER } })).status, 422);
      assert.equal((await dispatch('GET', path, viewer(STRANGER), { query: { task_ids: ROOF } })).status, 404);
    });
  });

  describe('planning settings', () => {
    const path = `/projects/${PROJECT}/planning-settings`;

    test('defaults to 5 working days', async () => {
      const res = await dispatch('GET', path, viewer(GC_ORG, []));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { mobilisation_lead_wd: 5 });
    });

    test('the owner sets it (ledgered); out-of-range → 422', async () => {
      const res = await dispatch('PUT', path, viewer(), { body: { mobilisation_lead_wd: 8 } });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { mobilisation_lead_wd: 8 });
      assert.deepEqual(store.state.ledger, ['planning.settings.updated']);
      assert.equal((await dispatch('PUT', path, viewer(), { body: { mobilisation_lead_wd: 61 } })).status, 422);
      assert.equal((await dispatch('PUT', path, viewer(), { body: { mobilisation_lead_wd: 2.5 } })).status, 422);
    });

    test('a participant that is not owner or live prime → 403; without org:plan:edit → 403', async () => {
      assert.equal((await dispatch('PUT', path, viewer(GC_ORG), { body: { mobilisation_lead_wd: 3 } })).status, 403);
      assert.equal((await dispatch('PUT', path, viewer(OWNER_ORG, []), { body: { mobilisation_lead_wd: 3 } })).status, 403);
      wire({ prime: true });
      assert.equal((await dispatch('PUT', path, viewer(GC_ORG), { body: { mobilisation_lead_wd: 3 } })).status, 200);
    });
  });
});
