// PRD-05 task-file operations through the /api/v2 router, DB-free: a fake
// store answers what pg-store would. Proves the request flow — V6 read for the
// task, D-33 edit scope for linking, existence hiding, validation — and that
// createDocument's `link` and the 100 MB cap are enforced at the boundary.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { createInMemoryObjectStorage } from '../infra/storage.mjs';
import { registerDocuments } from './register.mjs';
import { createInMemoryIdempotency } from '../../../platform/idempotency.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1'; // reads the task
const GC_ORG = '01920000-0000-7000-8000-0000000000a2'; // edits the task
const STRANGER_ORG = '01920000-0000-7000-8000-0000000000a5';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const TASK = '01920000-0000-7000-8000-0000000000d1';
const SUB = '01920000-0000-7000-8000-0000000000d2';
const DOC = '01920000-0000-7000-8000-0000000000e1';
const NEW_ID = '01920000-0000-7000-8000-0000000000ff';
const ME = '01920000-0000-7000-8000-0000000000e9';
const SHA = 'a'.repeat(64);

function fakeStore() {
  const links = [];
  const created = [];
  const doc = {
    id: DOC, project_id: PROJECT, scope_type: 'project', scope_id: PROJECT, kind: 'drawing',
    title: 'A-301', share_with_ancestors: false, current_version: 1, preview_status: 'ready',
  };
  return {
    idempotent: createInMemoryIdempotency(),
    links, created,
    async getPersonByClerkId(id) { return id === 'user_me' ? { id: ME } : null; },
    async resolveScope(type, id) {
      if (type === 'task' && (id === TASK || id === SUB)) return { projectId: PROJECT };
      if (type === 'project' && id === PROJECT) return { projectId: PROJECT };
      return null;
    },
    async canReadScope({ orgId }) { return orgId === GC_ORG || orgId === OWNER_ORG; },
    async canEditScope({ orgId }) { return orgId === GC_ORG; },
    async getDocument() { return null; },
    async linkableDocuments(ids) { return ids.includes(DOC) ? [doc] : []; },
    async addLinks(cmd) { links.push(cmd); return []; },
    async removeLink({ documentId, taskId }) { return documentId === DOC && taskId === TASK ? { role: 'reference' } : null; },
    async listTaskFiles() { return [{ ...doc, linked: true, link_role: 'reference', link_inherited: false, link_inherited_from: null }]; },
    async versionsOfDocuments() {
      return [{ document_id: DOC, version_no: 1, mime: 'application/pdf', size_bytes: 10, sha256: SHA, storage_key: 'k/a-301.pdf', uploaded_by_person_id: ME, uploaded_by_org_id: GC_ORG, uploaded_at: 'x' }];
    },
    async linksOfDocuments() { return [{ document_id: DOC, task_id: TASK, role: 'reference', inherited: false }]; },
    async listProjectFiles(args) { created.push(args); return { items: [doc], nextCursor: null }; },
    async createDocument(cmd) {
      created.push(cmd);
      return { document_id: cmd.id, version_no: 1, storage_key: cmd.storageKey, mime: cmd.file.mime, sha256: SHA };
    },
  };
}

function viewer(orgId, permissions = ['org:plan:edit']) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: `clerk_${orgId}`,
    orgKind: 'contractor', orgRole: 'manager', permissions, channel: 'ui',
  });
}

describe('PRD-05 task files over the /api/v2 router', () => {
  let router, store;
  const planning = { descendantIds: async () => [SUB] };

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerDocuments(router, { store, storage: createInMemoryObjectStorage(), planning });
  });

  const dispatch = (method, path, v, body = null, query = {}) =>
    router.dispatch({ method, path, viewer: v, body, query, headers: {} });

  test('listTaskDocuments: a reader gets the task files with role and used_on; a stranger 404s', async () => {
    const res = await dispatch('GET', `/tasks/${TASK}/documents`, viewer(OWNER_ORG));
    assert.equal(res.status, 200);
    assert.equal(res.body.items[0].role, 'reference');
    assert.equal(res.body.items[0].file_type, 'pdf');
    assert.deepEqual(res.body.items[0].used_on, [{ task_id: TASK, role: 'reference', inherited: false }]);
    assert.equal((await dispatch('GET', `/tasks/${TASK}/documents`, viewer(STRANGER_ORG))).status, 404);
  });

  test('linkTaskDocuments: editors link (with sub-tasks), readers 403, strangers 404, bad ids 422', async () => {
    const ok = await dispatch('POST', `/tasks/${TASK}/document-links`, viewer(GC_ORG), { document_ids: [DOC], include_subtasks: true });
    assert.equal(ok.status, 200);
    assert.deepEqual(store.links[0].links.map((l) => [l.taskId, l.inherited]), [[TASK, false], [SUB, true]]);
    assert.equal((await dispatch('POST', `/tasks/${TASK}/document-links`, viewer(OWNER_ORG), { document_ids: [DOC] })).status, 403);
    assert.equal((await dispatch('POST', `/tasks/${TASK}/document-links`, viewer(STRANGER_ORG), { document_ids: [DOC] })).status, 404);
    const bad = await dispatch('POST', `/tasks/${TASK}/document-links`, viewer(GC_ORG), { document_ids: [NEW_ID], role: 'owner' });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.errors.role);
    const unknown = await dispatch('POST', `/tasks/${TASK}/document-links`, viewer(GC_ORG), { document_ids: [NEW_ID] });
    assert.equal(unknown.status, 422);
  });

  test('unlinkTaskDocument: 204 for a link, 404 when there is none', async () => {
    assert.equal((await dispatch('DELETE', `/tasks/${TASK}/document-links/${DOC}`, viewer(GC_ORG))).status, 204);
    assert.equal((await dispatch('DELETE', `/tasks/${SUB}/document-links/${DOC}`, viewer(GC_ORG))).status, 404);
    // D-34: the editor org's person without org:plan:edit is refused on the permission (audit).
    assert.equal((await dispatch('DELETE', `/tasks/${TASK}/document-links/${DOC}`, viewer(GC_ORG, []))).status, 403);
  });

  test('listProjectDocuments: participants only; type is validated; the search is escaped', async () => {
    const res = await dispatch('GET', `/projects/${PROJECT}/documents`, viewer(OWNER_ORG), null, { q: '50%_off', type: 'pdf' });
    assert.equal(res.status, 200);
    assert.equal(store.created[0].q, '50\\%\\_off');
    assert.equal((await dispatch('GET', `/projects/${PROJECT}/documents`, viewer(OWNER_ORG), null, { type: 'zip' })).status, 422);
    assert.equal((await dispatch('GET', `/projects/${PROJECT}/documents`, viewer(STRANGER_ORG))).status, 404);
  });

  test('createDocument with link: project scope only, needs task edit scope, writes the links', async () => {
    const base = {
      id: NEW_ID, scope_type: 'project', scope_id: PROJECT, kind: 'drawing', title: 'S-110',
      file: { name: 's-110.dwg', mime: 'application/octet-stream', size_bytes: 1024, sha256: SHA },
    };
    const ok = await dispatch('POST', '/documents', viewer(GC_ORG), { ...base, note: 'first issue', link: { task_id: TASK, role: 'deliverable' } });
    assert.equal(ok.status, 201);
    const cmd = store.created[0];
    assert.equal(cmd.previewStatus, 'pending');
    assert.equal(cmd.note, 'first issue');
    assert.deepEqual(cmd.links, [{ taskId: TASK, role: 'deliverable', inherited: false, inheritedFromTaskId: null }]);

    const wrongScope = await dispatch('POST', '/documents', viewer(GC_ORG), { ...base, scope_type: 'task', scope_id: TASK, link: { task_id: TASK } });
    assert.equal(wrongScope.status, 422);
    const tooBig = await dispatch('POST', '/documents', viewer(GC_ORG), { ...base, file: { ...base.file, size_bytes: 100 * 1024 * 1024 + 1 } });
    assert.equal(tooBig.status, 422);
    assert.ok(tooBig.body.errors['file.size_bytes']);
  });
});
