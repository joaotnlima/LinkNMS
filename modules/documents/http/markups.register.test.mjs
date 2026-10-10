// PRD-06 markup operations through the /api/v2 router, DB-free: the route
// strings of the contract resolve (including the literal `markups:save`
// segment and the `:close` / `:link` commands) and map problems to statuses.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { createInMemoryObjectStorage } from '../infra/storage.mjs';
import { registerDocuments } from './register.mjs';

const GC_ORG = '01920000-0000-7000-8000-0000000000a2';
const STRANGER_ORG = '01920000-0000-7000-8000-0000000000a5';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const DOC = '01920000-0000-7000-8000-0000000000e1';
const M1 = '01920000-0000-7000-8000-000000000101';
const Q = '01920000-0000-7000-8000-000000000201';
const ME = '01920000-0000-7000-8000-0000000000e9';

function fakeStore() {
  const doc = { id: DOC, project_id: PROJECT, scope_type: 'project', scope_id: PROJECT, kind: 'drawing', title: 'A-301', current_version: 2, share_with_ancestors: false };
  const markup = {
    id: M1, document_id: DOC, project_id: PROJECT, version_no: 2, page_or_layout: '1', kind: 'text',
    geometry: { points: [[1, 1]] }, text: 'x', author_person_id: ME, author_org_id: GC_ORG, created_at: '2026-10-10T00:00:00Z', state: 'open',
  };
  return {
    saved: [],
    async getPersonByClerkId() { return { id: ME }; },
    async getDocument(id) { return id === DOC ? doc : null; },
    async canReadScope({ orgId }) { return orgId === GC_ORG; },
    async canEditScope() { return false; },
    async listVersions() { return []; },
    async listMarkups() { return { items: [markup], nextCursor: null }; },
    async getMarkup(id) { return id === M1 ? markup : null; },
    async getMarkupsByIds() { return []; },
    async saveMarkups(cmd) { this.saved.push(cmd); return { conflict: 3 }; },
    async setMarkupState({ to }) { return { ...markup, state: to, closed_at: '2026-10-11T00:00:00Z' }; },
    async linkMarkup({ link }) { return { ...markup, question_id: link.questionId }; },
  };
}

function viewer(orgId) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: `clerk_${orgId}`,
    orgKind: 'contractor', orgRole: 'manager', permissions: [], channel: 'ui',
  });
}

describe('PRD-06 markups over the /api/v2 router', () => {
  let router, store;
  const questions = { questionFacts: async (id) => (id === Q ? { id: Q, project_id: PROJECT, author_org_id: GC_ORG } : null) };

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerDocuments(router, { store, storage: createInMemoryObjectStorage(), questions });
  });

  const dispatch = (method, path, v, body = null, query = {}) =>
    router.dispatch({ method, path, viewer: v, body, query, headers: {} });

  test('listDocumentMarkups: 200 for readers, 404 for strangers', async () => {
    const res = await dispatch('GET', `/documents/${DOC}/markups`, viewer(GC_ORG));
    assert.equal(res.status, 200);
    assert.equal(res.body.items[0].id, M1);
    assert.equal(res.body.next_cursor, null);
    assert.equal((await dispatch('GET', `/documents/${DOC}/markups`, viewer(STRANGER_ORG))).status, 404);
  });

  test('saveDocumentMarkups: 422 on a bad body, 409 on a stale base', async () => {
    assert.equal((await dispatch('POST', `/documents/${DOC}/markups:save`, viewer(GC_ORG), { base_version_no: 2, markups: [] })).status, 422);
    const stale = await dispatch('POST', `/documents/${DOC}/markups:save`, viewer(GC_ORG), {
      base_version_no: 2, markups: [{ id: Q, page_or_layout: '1', kind: 'text', geometry: { points: [[1, 1]] }, text: 'note' }],
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'version_conflict');
    assert.equal(stale.body.current_version, 3);
  });

  test(':close and :link resolve and answer the markup', async () => {
    const closed = await dispatch('POST', `/markups/${M1}:close`, viewer(GC_ORG));
    assert.equal(closed.status, 200);
    assert.equal(closed.body.state, 'closed');
    const linked = await dispatch('POST', `/markups/${M1}:link`, viewer(GC_ORG), { question_id: Q });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.question_id, Q);
    assert.equal((await dispatch('POST', `/markups/${M1}:link`, viewer(GC_ORG), {})).status, 422);
  });
});
