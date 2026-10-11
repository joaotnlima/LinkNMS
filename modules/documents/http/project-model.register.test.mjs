// PRD-07 project-model operations through the /api/v2 router, DB-free: the
// route strings of the contract resolve (the literal `model:save` /
// `model:restore` segments, `/model/versions`, `/model/record-diff`,
// `/tasks/{id}/model`) and problems map to their statuses — 404 for a
// stranger, 403 out_of_scope with the refused changes, 409 with conflicts.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { createInMemoryObjectStorage } from '../infra/storage.mjs';
import { registerDocuments } from './register.mjs';
import { createInMemoryIdempotency } from '../../../platform/idempotency.mjs';

const OWNER = '01920000-0000-7000-8000-0000000000a1';
const ROOF = '01920000-0000-7000-8000-0000000000a2';
const ARCH = '01920000-0000-7000-8000-0000000000a3';
const STRANGER = '01920000-0000-7000-8000-0000000000a5';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const DOC = '01920000-0000-7000-8000-0000000000e1';
const T_ROOF = '01920000-0000-7000-8000-0000000000c1';
const T_FRAME = '01920000-0000-7000-8000-0000000000c2';
const ME = '01920000-0000-7000-8000-0000000000e9';
const G1 = '2O2Fr$t4X7Zf8NOew3FLOH';
const G2 = '3P3Gs$u5Y8Ag9OPfx4GMPI';

function fakeStore() {
  const doc = { id: DOC, project_id: PROJECT, scope_type: 'project', scope_id: PROJECT, kind: 'bim', title: 'casa.ifc', current_version: 3, share_with_ancestors: false, is_project_model: true };
  const links = [
    { id: 'l1', global_id: G1, task_id: T_ROOF, added_in_version: 1, removed_in_version: null, created_by_org_id: OWNER },
    { id: 'l2', global_id: G2, task_id: T_FRAME, added_in_version: 3, removed_in_version: null, created_by_org_id: OWNER },
  ];
  return {
    idempotent: createInMemoryIdempotency(),
    saves: [],
    async getPersonByClerkId() { return { id: ME }; },
    async resolveScope(type, id) { return (type === 'project' && id === PROJECT) || (type === 'task' && [T_ROOF, T_FRAME].includes(id)) ? { projectId: PROJECT } : null; },
    async canReadScope({ orgId }) { return orgId !== STRANGER; },
    async getProjectModel(id) { return id === PROJECT ? doc : null; },
    async modelAuthorOrgId() { return ARCH; },
    async modelRecord() { return { links, pins: [] }; },
    async listVersions() { return []; },
    async taskElementCount(_d, taskId) { return taskId === T_ROOF ? 1 : 0; },
    async saveModelEdit(cmd) {
      this.saves.push(cmd);
      const outcome = cmd.decide({ links, pins: [] });
      if (outcome.refused) return { refused: outcome.refused };
      if (outcome.conflicts?.length) return { conflicts: outcome.conflicts };
      return { doc: { ...doc, current_version: 4 }, versionNo: 4, changes: 1, dropped: 0 };
    },
  };
}

const planning = {
  async modelScopes() {
    return {
      owner_org_id: OWNER,
      tasks: [{ id: T_ROOF, code: '2.5', name: 'Roofing' }, { id: T_FRAME, code: '2.3', name: 'Frame' }],
      editors: [{ org_id: ROOF, task_ids: [T_ROOF] }],
    };
  },
};

function viewer(orgId) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: `clerk_${orgId}`,
    orgKind: 'contractor', orgRole: 'manager', permissions: [], channel: 'ui',
  });
}

describe('PRD-07 project model over the /api/v2 router', () => {
  let router, store;

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerDocuments(router, { store, storage: createInMemoryObjectStorage(), planning });
  });

  const dispatch = (method, path, v, body = null, query = {}) =>
    router.dispatch({ method, path, viewer: v, body, query, headers: {} });

  test('getProjectModel: the record + the viewer\'s scope; 404 for strangers', async () => {
    const res = await dispatch('GET', `/projects/${PROJECT}/model`, viewer(ROOF));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.viewer.scope, { kind: 'tasks', task_ids: [T_ROOF], element_count: 1, edits_all: false, editable_global_ids: [G1] });
    assert.equal(res.body.tasks.find((t) => t.id === T_ROOF).element_count, 1);
    assert.deepEqual(res.body.access.editors.map((e) => e.role), ['author', 'owner', 'branch']);
    assert.equal((await dispatch('GET', `/projects/${PROJECT}/model`, viewer(STRANGER))).status, 404);
    assert.equal((await dispatch('GET', `/projects/${PROJECT}/model`, viewer(ROOF), null, { version: '9' })).status, 422);
  });

  test('model:save — 422 without a note, 403 out_of_scope naming the change, 409 with the conflicting elements', async () => {
    assert.equal((await dispatch('POST', `/projects/${PROJECT}/model:save`, viewer(ROOF), {
      base_version_no: 3, changes: [{ op: 'link', global_id: G1, task_id: T_ROOF }],
    })).status, 422);
    const out = await dispatch('POST', `/projects/${PROJECT}/model:save`, viewer(ROOF), {
      base_version_no: 3, note: 'n', changes: [{ op: 'link', global_id: G2, task_id: T_ROOF }],
    });
    assert.equal(out.status, 403);
    assert.equal(out.body.code, 'out_of_scope');
    assert.equal(out.body.refused[0].change_index, 0);
    const conflict = await dispatch('POST', `/projects/${PROJECT}/model:save`, viewer(OWNER), {
      base_version_no: 2, note: 'n', changes: [{ op: 'unlink', global_id: G2, task_id: T_FRAME }],
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body.conflicts, [{ global_id: G2, version: 3, by_org_id: OWNER }]);
    const ok = await dispatch('POST', `/projects/${PROJECT}/model:save`, viewer(OWNER), {
      base_version_no: 3, note: 'n', changes: [{ op: 'unlink', global_id: G2, task_id: T_FRAME }],
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.version_no, 4);
    assert.equal(ok.body.edited_by_author, false);
  });

  test('model:save honours Idempotency-Key: a replay answers the first save, a different body 409s (audit B1)', async () => {
    const send = (body) => router.dispatch({
      method: 'POST', path: `/projects/${PROJECT}/model:save`, viewer: viewer(OWNER), body, query: {}, headers: { 'idempotency-key': 'k-save-1' },
    });
    const body = { base_version_no: 3, note: 'n', changes: [{ op: 'unlink', global_id: G2, task_id: T_FRAME }] };
    const first = await send(body);
    const again = await send(body);
    assert.deepEqual([first.status, again.status], [201, 201]);
    assert.deepEqual(again.body, first.body);
    assert.equal(store.saves.length, 1);
    assert.equal((await send({ ...body, note: 'other' })).status, 409);
  });

  test('model:restore is for the author and the owner; record-diff and the task card resolve', async () => {
    assert.equal((await dispatch('POST', `/projects/${PROJECT}/model:restore`, viewer(ROOF), { version_no: 1 })).status, 403);
    assert.equal((await dispatch('POST', `/projects/${PROJECT}/model:restore`, viewer(OWNER), { version_no: 3 })).status, 422);
    const diff = await dispatch('GET', `/projects/${PROJECT}/model/record-diff`, viewer(ROOF), null, { from: '1', to: '3' });
    assert.equal(diff.status, 200);
    assert.deepEqual(diff.body.links_added, [{ global_id: G2, task_id: T_FRAME }]);
    const card = await dispatch('GET', `/tasks/${T_ROOF}/model`, viewer(ROOF));
    assert.deepEqual([card.body.model.element_count, card.body.model.can_edit, card.body.model.edit_reason], [1, true, 'scope']);
    const frame = await dispatch('GET', `/tasks/${T_FRAME}/model`, viewer(ROOF));
    assert.equal(frame.body.model.can_edit, false);
  });

  test('model/versions: the author only, IFC only', async () => {
    const file = { name: 'rev-c.ifc', mime: 'application/octet-stream', size_bytes: 10, sha256: 'a'.repeat(64) };
    assert.equal((await dispatch('POST', `/projects/${PROJECT}/model/versions`, viewer(OWNER), { file })).status, 403);
    assert.equal((await dispatch('POST', `/projects/${PROJECT}/model/versions`, viewer(ARCH), { file: { ...file, name: 'x.pdf' } })).status, 422);
  });
});
