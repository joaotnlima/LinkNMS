// PRD-09 Excel import over the /api/v2 router, DB-free: the doc-16
// conjunction (permission ∧ participant ∧ edit scope on the plan root),
// validation of the upload and the mapping, and the import belonging to the
// uploading organisation (404 for anyone else).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerPlanning } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000009a1';
const GC_ORG = '01920000-0000-7000-8000-0000000009a2';
const STRANGER = '01920000-0000-7000-8000-0000000009a9';
const PROJECT = '01920000-0000-7000-8000-0000000009b1';
const ME = '01920000-0000-7000-8000-0000000009c1';

const GRID = [
  ['Action', 'Sub-action', 'Start', 'End'],
  ['Foundations', '', '2026-03-02', '2026-03-20'],
  ['', 'Excavation', '2026-03-02', '2026-03-06'],
];

function fakeStore() {
  const imports = new Map();
  return {
    imports,
    async getPersonByClerkId(id) { return id === 'user_me' ? { id: ME } : null; },
    async getProject(id) { return id === PROJECT ? { id, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG } : null; },
    async isParticipant(projectId, orgId) { return projectId === PROJECT && [OWNER_ORG, GC_ORG].includes(orgId); },
    async isStaffed() { return true; },
    async loadPlan() { return { tasks: new Map(), links: [], contracts: new Map(), ownerOrgId: OWNER_ORG, calendarRaw: {} }; },
    async insertScheduleImport(cmd) {
      const imp = { ...cmd, status: 'uploaded', mapping: null, orgName: 'Família Almeida', confirmedAt: null };
      imports.set(cmd.id, imp);
      return imp;
    },
    async getScheduleImport(id) { return imports.get(id) ?? null; },
    async updateScheduleImport({ id, sheetName, mapping, status }) {
      const imp = imports.get(id);
      Object.assign(imp, { sheetName, mapping, status });
      return imp;
    },
  };
}

const workbooks = { async read(bytes) { if (String(bytes) !== 'xlsx') throw new Error('bad'); return { sheets: [{ name: 'Plan', rows: GRID }] }; } };

function viewer(orgId, permissions = ['org:plan:edit']) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: `clerk_${orgId}`,
    orgKind: 'contractor', orgRole: 'manager', permissions, channel: 'ui',
  });
}

describe('PRD-09 schedule imports over the /api/v2 router', () => {
  let router, store;
  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerPlanning(router, { store, workbooks });
  });
  const dispatch = (method, path, v, body = null) => router.dispatch({ method, path, viewer: v, body, query: {}, headers: {} });
  const file = (filename = 'plan.xlsx', bytes = Buffer.from('xlsx')) => ({ file: { filename, content_type: 'application/octet-stream', size: bytes.length, bytes } });

  test('upload: role, relationship, edit scope on the root; validation of the file', async () => {
    const path = `/projects/${PROJECT}/schedule-imports`;
    assert.equal((await dispatch('POST', path, viewer(OWNER_ORG, []), file())).status, 403);
    assert.equal((await dispatch('POST', path, viewer(STRANGER), file())).status, 404);
    const gc = await dispatch('POST', path, viewer(GC_ORG), file());
    assert.equal(gc.status, 403);
    assert.equal(gc.body.code, 'out_of_scope');
    assert.equal((await dispatch('POST', path, viewer(OWNER_ORG), {})).status, 422);
    assert.equal((await dispatch('POST', path, viewer(OWNER_ORG), file('plan.xls'))).status, 422);
    assert.equal((await dispatch('POST', path, viewer(OWNER_ORG), file('plan.xlsx', Buffer.from('zip?')))).status, 422);
    assert.equal((await dispatch('POST', path, viewer(OWNER_ORG), { ...file(), parent_task_id: PROJECT })).status, 422);
    const ok = await dispatch('POST', path, viewer(OWNER_ORG), file());
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body.missing_required, []);
    assert.deepEqual(ok.body.columns.map((c) => c.header), ['Action', 'Sub-action', 'Start', 'End']);
  });

  test('map: the importing org only; a column used twice is 422; a missing required mapping is reported, not refused', async () => {
    const { body: imp } = await dispatch('POST', `/projects/${PROJECT}/schedule-imports`, viewer(OWNER_ORG), file());
    assert.equal((await dispatch('POST', `/schedule-imports/${imp.id}:map`, viewer(GC_ORG), { sheet: 'Plan', mapping: {} })).status, 404);
    assert.equal((await dispatch('POST', `/schedule-imports/${imp.id}:map`, viewer(OWNER_ORG), { sheet: 'Nope', mapping: {} })).status, 422);
    assert.equal((await dispatch('POST', `/schedule-imports/${imp.id}:map`, viewer(OWNER_ORG), { sheet: 'Plan', mapping: { action: 0, start: 0 } })).status, 422);
    const partial = await dispatch('POST', `/schedule-imports/${imp.id}:map`, viewer(OWNER_ORG), { sheet: 'Plan', mapping: { action: 0 } });
    assert.equal(partial.status, 200);
    assert.deepEqual(partial.body.missing_required, ['start', 'end']);
    assert.equal(partial.body.sample.length, 1); // the sub-row has nothing in a mapped column yet
    assert.equal((await dispatch('POST', `/schedule-imports/${imp.id}:preview`, viewer(OWNER_ORG))).status, 422);
    assert.equal((await dispatch('POST', `/schedule-imports/${imp.id}:confirm`, viewer(OWNER_ORG))).status, 422);
    assert.equal((await dispatch('GET', `/schedule-imports/not-a-uuid`, viewer(OWNER_ORG))).status, 404);
  });
});
