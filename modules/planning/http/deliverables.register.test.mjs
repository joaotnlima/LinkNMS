// PRD-05 deliverables over the /api/v2 router, DB-free: the doc-16
// conjunction on each operation (permission ∧ relationship), existence
// hiding, validation, the two-sided rule, and the D-48 gate on
// POST /tasks/{id}/progress answering 409 deliverables_pending.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerPlanning } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000005a1';
const SUB_ORG = '01920000-0000-7000-8000-0000000005a2';
const STRANGER = '01920000-0000-7000-8000-0000000005a9';
const PROJECT = '01920000-0000-7000-8000-0000000005b1';
const TASK = '01920000-0000-7000-8000-0000000005d1';
const DEL = '01920000-0000-7000-8000-0000000005e1';
const DOC = '01920000-0000-7000-8000-0000000005f1';
const ME = '01920000-0000-7000-8000-0000000005c1';
const SHA = 'a'.repeat(64);

function fakeStore() {
  const state = { deliverables: [], progress: [], submissions: [] };
  const deliverable = (over = {}) => ({
    id: DEL, project_id: PROJECT, task_id: TASK, title: 'S-110', required: true, due: null,
    created_at: 'now', submissions: state.submissions, ...over,
  });
  state.deliverables.push(deliverable());
  return {
    state,
    async getPersonByClerkId(id) { return id === 'user_me' ? { id: ME } : null; },
    async getProject(id) { return id === PROJECT ? { id, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG } : null; },
    async isParticipant(projectId, orgId) { return projectId === PROJECT && [OWNER_ORG, SUB_ORG].includes(orgId); },
    async isStaffed() { return true; },
    async getTask(id) { return id === TASK ? { id, projectId: PROJECT, name: 'Design', deletedAt: null, assigneeOrgId: SUB_ORG } : null; },
    async loadPlan() {
      return {
        tasks: new Map([[TASK, { id: TASK, projectId: PROJECT, parentId: null, branchContractId: null, assigneeOrgId: SUB_ORG }]]),
        links: [], contracts: new Map(), ownerOrgId: OWNER_ORG, statuses: new Map(),
      };
    },
    async listDeliverables() { return state.deliverables; },
    async getDeliverable(id) { return state.deliverables.find((d) => d.id === id) ?? null; },
    async insertDeliverable(cmd) {
      const d = deliverable({ id: cmd.id, title: cmd.title, required: cmd.required, submissions: [] });
      state.deliverables.push(d);
      return { deliverable: d, created: true };
    },
    async submitDeliverable({ id, facts, actor }) {
      state.submissions.push({
        id: 's1', seq: 1, status: 'submitted', document_id: facts.document_id, version_no: facts.version_no,
        sha256: facts.sha256, file_title: facts.title, mime: facts.mime, submitted_by_org_id: actor.orgId,
        submitted_by_person_id: actor.personId, submitted_at: 'now',
      });
      return state.deliverables.find((d) => d.id === id);
    },
    async insertProgress(p) { state.progress.push(p); return { ...p, seq: 1, reportedAt: 'now' }; },
  };
}

function viewer(orgId, permissions = ['org:plan:edit', 'org:progress:report', 'org:quality:verify']) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: `clerk_${orgId}`,
    orgKind: 'contractor', orgRole: 'manager', permissions, channel: 'ui',
  });
}

const documents = {
  async versionFacts({ documentId }) {
    return documentId === DOC
      ? { document_id: DOC, project_id: PROJECT, version_no: 1, sha256: SHA, title: 'S-110', mime: 'application/pdf', current_version: 1 }
      : null;
  },
};

describe('PRD-05 deliverables over the /api/v2 router', () => {
  let router, store;
  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerPlanning(router, { store, documents });
  });
  const dispatch = (method, path, v, body = null) => router.dispatch({ method, path, viewer: v, body, query: {}, headers: {} });

  test('listTaskDeliverables: participants read; strangers 404', async () => {
    const res = await dispatch('GET', `/tasks/${TASK}/deliverables`, viewer(OWNER_ORG));
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.required_count, res.body.done_blocked, res.body.can_edit], [1, true, true]);
    assert.equal((await dispatch('GET', `/tasks/${TASK}/deliverables`, viewer(STRANGER))).status, 404);
  });

  test('createDeliverable: needs org:plan:edit and the client side; validates', async () => {
    const id = '01920000-0000-7000-8000-0000000005e2';
    assert.equal((await dispatch('POST', `/tasks/${TASK}/deliverables`, viewer(OWNER_ORG, []), { id, title: 'x' })).status, 403);
    assert.equal((await dispatch('POST', `/tasks/${TASK}/deliverables`, viewer(SUB_ORG), { id, title: 'x' })).status, 403);
    const bad = await dispatch('POST', `/tasks/${TASK}/deliverables`, viewer(OWNER_ORG), { id: 'nope', title: '' });
    assert.equal(bad.status, 422);
    assert.deepEqual(Object.keys(bad.body.errors).sort(), ['id', 'title']);
    assert.equal((await dispatch('POST', `/tasks/${TASK}/deliverables`, viewer(OWNER_ORG), { id, title: 'Calc' })).status, 201);
  });

  test('submit: the assignee only, a readable proven version; review: never the submitter', async () => {
    assert.equal((await dispatch('POST', `/deliverables/${DEL}:submit`, viewer(OWNER_ORG), { document_id: DOC })).status, 403);
    const unknown = await dispatch('POST', `/deliverables/${DEL}:submit`, viewer(SUB_ORG), { document_id: PROJECT });
    assert.equal(unknown.status, 422);
    const ok = await dispatch('POST', `/deliverables/${DEL}:submit`, viewer(SUB_ORG), { document_id: DOC, note: 'first issue' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'submitted');
    assert.equal((await dispatch('POST', `/deliverables/${DEL}:approve`, viewer(SUB_ORG))).status, 403);
    assert.equal((await dispatch('POST', `/deliverables/${DEL}:approve`, viewer(OWNER_ORG, ['org:plan:edit']))).status, 403);
    const noComment = await dispatch('POST', `/deliverables/${DEL}:request-changes`, viewer(OWNER_ORG), {});
    assert.equal(noComment.status, 422);
  });

  test('D-48: done is refused with 409 deliverables_pending; other statuses pass', async () => {
    const res = await dispatch('POST', `/tasks/${TASK}/progress`, viewer(OWNER_ORG), { status: 'done', actual_finish: '2026-01-05' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'invalid_transition');
    assert.equal(res.body.reason, 'deliverables_pending');
    assert.deepEqual(res.body.pending_deliverable_ids, [DEL]);
    assert.equal(store.state.progress.length, 0);
    const ok = await dispatch('POST', `/tasks/${TASK}/progress`, viewer(OWNER_ORG), { status: 'in_progress', percent: 50 });
    assert.equal(ok.status, 201);
  });
});
