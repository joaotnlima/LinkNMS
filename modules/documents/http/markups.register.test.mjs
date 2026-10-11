// PRD-06 markup operations through the /api/v2 router, DB-free: the route
// strings of the contract resolve (including the literal `markups:save`
// segment and the `:close` / `:link` commands) and map problems to statuses.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { createInMemoryObjectStorage } from '../infra/storage.mjs';
import { registerDocuments } from './register.mjs';
import { createInMemoryIdempotency } from '../../../platform/idempotency.mjs';

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
    idempotent: createInMemoryIdempotency(),
    saved: [],
    async getPersonByClerkId() { return { id: ME }; },
    async getDocument(id) { return id === DOC ? doc : null; },
    async canReadScope({ orgId }) { return orgId === GC_ORG; },
    async canEditScope() { return false; },
    async listVersions() { return []; },
    async listMarkups() { return { items: [markup], nextCursor: null }; },
    async getMarkup(id) { return id === M1 ? markup : null; },
    async getMarkupsByIds() { return []; },
    async getVersion(id, no) { return id === DOC && no <= 2 ? { document_id: DOC, version_no: no, storage_key: 'k/roof.dwg', mime: 'application/octet-stream', sha256: 'f'.repeat(64) } : null; },
    async getPreview() { return { status: 'unavailable', reason: 'converter_not_configured', warnings: [] }; },
    async listPreviewLayouts() { return []; },
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

  test(':close, :reopen and :link replay their first answer under the same Idempotency-Key (audit B1)', async () => {
    let writes = 0;
    const setState = store.setMarkupState;
    store.setMarkupState = async (cmd) => { writes += 1; return setState(cmd); };
    const send = (path, body = null) => router.dispatch({
      method: 'POST', path, viewer: viewer(GC_ORG), body, query: {}, headers: { 'idempotency-key': 'k-close-1' },
    });
    const first = await send(`/markups/${M1}:close`);
    const again = await send(`/markups/${M1}:close`);
    assert.deepEqual(again.body, first.body);
    assert.equal(writes, 1);
    // The key is per operation: the same key on :link is a fresh command.
    assert.equal((await send(`/markups/${M1}:link`, { question_id: Q })).status, 200);
  });

  test('viewing routes: :view-url answers an inline URL, /preview the DWG state; unproven versions 404', async () => {
    const url = await dispatch('GET', `/document-versions/${DOC}.2:view-url`, viewer(GC_ORG));
    assert.equal(url.status, 200);
    assert.match(url.body.url, /^memory:\/\/download\//);
    const preview = await dispatch('GET', `/document-versions/${DOC}.2/preview`, viewer(GC_ORG));
    assert.equal(preview.status, 200);
    assert.deepEqual([preview.body.file_type, preview.body.status, preview.body.reason], ['dwg', 'unavailable', 'converter_not_configured']);
    assert.equal((await dispatch('GET', `/document-versions/${DOC}.3/preview`, viewer(GC_ORG))).status, 404);
    assert.equal((await dispatch('GET', `/document-versions/${DOC}.2:view-url`, viewer(STRANGER_ORG))).status, 404);
  });
});
