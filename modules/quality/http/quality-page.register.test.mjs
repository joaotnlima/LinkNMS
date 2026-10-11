// The build's quality page through the /api/v2 router, DB-free (PRD-12 N-3,
// N-4): lists with the viewer's next steps, a non-conformity tagged to a
// location with photos (checked through the project build port and the
// documents port), inspections against locations — and acceptance criterion 2:
// the party that fixed it can never close it; only the raiser can.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerQuality } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const GC_ORG = '01920000-0000-7000-8000-0000000000a2';
const SUB_ORG = '01920000-0000-7000-8000-0000000000a3';
const INSPECTOR_ORG = '01920000-0000-7000-8000-0000000000a4';
const STRANGER_ORG = '01920000-0000-7000-8000-0000000000a5';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const LOC = '01920000-0000-7000-8000-0000000000c7';
const OTHER_LOC = '01920000-0000-7000-8000-0000000000c8';
const PHOTO = '01920000-0000-7000-8000-0000000000d7';
const FOREIGN_PHOTO = '01920000-0000-7000-8000-0000000000d8';
const ME = '01920000-0000-7000-8000-0000000000e9';
const id = (n) => `01920000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;

function fakeStore() {
  const ncs = new Map();
  const inspections = new Map();
  return {
    ncs, inspections,
    async getPersonByClerkId(clerk) { return clerk === 'user_me' ? { id: ME } : null; },
    async getProject(pid) { return pid === PROJECT ? { id: PROJECT, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG } : null; },
    async isParticipant(pid, orgId) { return pid === PROJECT && [OWNER_ORG, GC_ORG, SUB_ORG, INSPECTOR_ORG].includes(orgId); },
    async isStaffed() { return false; },
    async isInvitedInspector(pid, orgId) { return orgId === INSPECTOR_ORG; },
    async isProjectClient(pid, orgId) { return orgId === OWNER_ORG || orgId === GC_ORG; },
    async isClientChain(orgId) { return orgId === OWNER_ORG; },
    async getTask() { return null; },
    async tasksOfProject() { return new Set(); },
    async getNonConformity(ncId) { return ncs.get(ncId) ?? null; },
    async createNonConformity(cmd) {
      const row = {
        id: cmd.id, project_id: cmd.projectId, task_id: null, contract_id: null, location_id: cmd.locationId,
        kind: cmd.kind, severity: cmd.severity, description: cmd.description, photo_document_ids: cmd.photoDocumentIds,
        raised_by_org_id: cmd.raisedByOrgId, raised_by_person_id: cmd.raisedByPersonId,
        assigned_to_org_id: cmd.assignedToOrgId, status: 'open', raised_at: new Date(Date.now() + ncs.size),
      };
      ncs.set(cmd.id, row);
      return row;
    },
    async transitionNonConformity({ nonconformityId, from, to, set, note }) {
      const nc = ncs.get(nonconformityId);
      if (nc.status !== from) return null;
      Object.assign(nc, { status: to, assigned_to_org_id: set.assignedToOrgId ?? nc.assigned_to_org_id, last_note: note });
      return { ...nc };
    },
    async listNonConformities({ status }) {
      const items = [...ncs.values()]
        .filter((n) => (status === 'active' ? n.status !== 'closed' : status === 'all' || n.status === status))
        .sort((a, b) => b.raised_at - a.raised_at);
      return { items, nextCursor: null };
    },
    async getInspection(iid) { return inspections.get(iid) ?? null; },
    async createInspection(cmd) {
      const row = { id: cmd.id, project_id: cmd.projectId, inspector_org_id: cmd.inspectorOrgId, kind: cmd.kind, date: cmd.date,
        checklist: cmd.checklist, findings: cmd.findings, task_ids: cmd.taskIds, location_ids: cmd.locationIds };
      inspections.set(cmd.id, row);
      return row;
    },
    async listInspections({ locationId }) {
      return { items: [...inspections.values()].filter((i) => !locationId || i.location_ids.includes(locationId)), nextCursor: null };
    },
  };
}

const builds = { async locationsOf(pid, ids) { return new Set(ids.filter((l) => pid === PROJECT && l === LOC)); } };
const documents = {
  async versionFacts({ documentId }) { return documentId === PHOTO ? { document_id: PHOTO, project_id: PROJECT, version_no: 1 } : null; },
};

const as = (orgId) => createViewerContext({
  clerkUserId: 'user_me', orgId, clerkOrgId: `org_${orgId.slice(-2)}`, orgKind: 'contractor', orgRole: 'admin',
  permissions: ['org:quality:verify', 'org:quality:inspect', 'org:progress:report'],
});

describe('the quality page over the v2 router (PRD-12 N-3, N-4)', () => {
  let router, store;
  const call = (method, path, { viewer = as(INSPECTOR_ORG), body = null, query = {} } = {}) =>
    router.dispatch({ method, path, viewer, body, query, headers: {} });
  const raise = (body = {}, viewer = as(INSPECTOR_ORG)) => call('POST', `/projects/${PROJECT}/nonconformities`, {
    viewer, body: { id: id(1), severity: 'major', kind: 'safety', description: 'Guarda-corpo em falta', ...body },
  });

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerQuality(router, { store, builds, documents });
  });

  test('raise with a location and photos of the build; foreign ones are refused', async () => {
    const ok = await raise({ location_id: LOC, photo_document_ids: [PHOTO], assigned_to_org_id: SUB_ORG });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.location_id, LOC);
    assert.deepEqual(ok.body.photo_document_ids, [PHOTO]);
    assert.deepEqual(ok.body.actions, ['assign']); // the raiser may still re-assign an open NC

    assert.equal((await raise({ id: id(2), location_id: OTHER_LOC })).status, 422);
    const photo = await raise({ id: id(3), photo_document_ids: [FOREIGN_PHOTO] });
    assert.equal(photo.status, 422);
    assert.ok(photo.body.errors.photo_document_ids);
    const stranger = await raise({ id: id(4), assigned_to_org_id: STRANGER_ORG });
    assert.equal(stranger.status, 422);
    assert.ok(stranger.body.errors.assigned_to_org_id);
  });

  test('criterion 2: the fixer cannot close; the raiser can — each list item says who may do what', async () => {
    await raise({ assigned_to_org_id: SUB_ORG });
    const assigned = await call('POST', `/nonconformities/${id(1)}:assign`, { body: { assigned_to_org_id: SUB_ORG, note: 'Até sexta' } });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.last_note, 'Até sexta');

    const subList = await call('GET', `/projects/${PROJECT}/nonconformities`, { viewer: as(SUB_ORG) });
    assert.deepEqual(subList.body.items[0].actions, ['fix']);
    assert.equal((await call('POST', `/nonconformities/${id(1)}:fix`, { viewer: as(SUB_ORG), body: { note: 'Colocado' } })).status, 200);

    const fixerClose = await call('POST', `/nonconformities/${id(1)}:close`, { viewer: as(SUB_ORG), body: {} });
    assert.equal(fixerClose.status, 403);
    assert.equal(fixerClose.body.reason, 'relationship');
    const ownerClose = await call('POST', `/nonconformities/${id(1)}:close`, { viewer: as(OWNER_ORG), body: {} });
    assert.equal(ownerClose.status, 403); // not even the top of the client chain

    const raiserView = await call('GET', `/projects/${PROJECT}/nonconformities`);
    assert.deepEqual(raiserView.body.items[0].actions, ['close', 'reject_fix']);
    assert.deepEqual((await call('GET', `/projects/${PROJECT}/nonconformities`, { viewer: as(SUB_ORG) })).body.items[0].actions, []);

    const closed = await call('POST', `/nonconformities/${id(1)}:close`, { body: {} });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, 'closed');
    assert.equal((await call('GET', `/projects/${PROJECT}/nonconformities`)).body.items.length, 0); // active = not closed
    assert.equal((await call('GET', `/projects/${PROJECT}/nonconformities`, { query: { status: 'closed' } })).body.items.length, 1);
  });

  test('list: participants only (a stranger gets 404); bad filters 422', async () => {
    assert.equal((await call('GET', `/projects/${PROJECT}/nonconformities`, { viewer: as(STRANGER_ORG) })).status, 404);
    assert.equal((await call('GET', `/projects/${PROJECT}/nonconformities`, { query: { status: 'gone' } })).status, 422);
    assert.equal((await call('GET', `/projects/${PROJECT}/inspections`, { query: { location_id: 'x' } })).status, 422);
  });

  test('inspections recorded against locations, listed by location', async () => {
    const rec = await call('POST', `/projects/${PROJECT}/inspections`, {
      body: { id: id(9), date: '2026-10-10', kind: 'safety', checklist: [{ item: 'Andaimes', ok: true }], location_ids: [LOC] },
    });
    assert.equal(rec.status, 201);
    assert.deepEqual(rec.body.location_ids, [LOC]);
    const bad = await call('POST', `/projects/${PROJECT}/inspections`, { body: { id: id(10), date: '2026-10-10', location_ids: [OTHER_LOC] } });
    assert.equal(bad.status, 422);
    const list = await call('GET', `/projects/${PROJECT}/inspections`, { viewer: as(SUB_ORG), query: { location_id: LOC } });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((i) => i.id), [id(9)]);
  });
});
