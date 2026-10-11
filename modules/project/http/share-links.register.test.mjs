// Share links end to end through the /api/v2 router, DB-free (PRD-12 N-12,
// flow D21): the owner picks the build's files and an expiry, lists, revokes
// and reads the access log; the holder (no account, no viewer) sees only the
// shared files — each access logged — and a 410 once expired or revoked.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerProject } from './register.mjs';
import { createInMemoryIdempotency } from '../../../platform/idempotency.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const GC_ORG = '01920000-0000-7000-8000-0000000000a2';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const ME = '01920000-0000-7000-8000-0000000000c1';
const DOC_A = '01920000-0000-7000-8000-0000000000f1';
const DOC_B = '01920000-0000-7000-8000-0000000000f2';
const DOC_PRIVATE = '01920000-0000-7000-8000-0000000000f3';

function fakeStore() {
  const links = new Map();
  const accesses = [];
  const ledger = [];
  const project = { id: PROJECT, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG, name: 'Casa da Maia', municipality_code: '1306' };
  return {
    idempotent: createInMemoryIdempotency(),
    links, accesses, ledger,
    async getPersonByClerkId(id) { return id === 'user_me' ? { id: ME } : null; },
    async getProject(id) { return id === PROJECT ? project : null; },
    async isParticipant(projectId, orgId) { return projectId === PROJECT && (orgId === OWNER_ORG || orgId === GC_ORG); },
    async isStaffed() { return false; },
    async createShareLink(cmd) {
      const row = {
        id: cmd.id, project_id: cmd.projectId, audience: cmd.audience, document_ids: cmd.documentIds,
        task_ids: cmd.taskIds, token_hash: cmd.tokenHash, expires_at: cmd.expiresAt,
        created_at: new Date().toISOString(), revoked_at: null,
      };
      links.set(row.id, row);
      ledger.push('project.share_link.created');
      return row;
    },
    async getShareLink(id) {
      const l = links.get(id);
      return l ? { ...l, access_count: accesses.filter((a) => a.link.id === id).length } : null;
    },
    async getShareLinkByTokenHash(hash) { return [...links.values()].find((l) => l.token_hash === hash) ?? null; },
    async listShareLinks({ projectId }) {
      return { items: [...links.values()].filter((l) => l.project_id === projectId), nextCursor: null };
    },
    async revokeShareLink({ shareLinkId }) {
      const l = links.get(shareLinkId);
      if (l.revoked_at) return null;
      l.revoked_at = new Date().toISOString();
      ledger.push('project.share_link.revoked');
      return { ...l };
    },
    async recordShareLinkAccess(cmd) {
      accesses.push(cmd);
      ledger.push('project.share_link.accessed');
    },
    async listShareLinkAccesses({ shareLinkId }) {
      return {
        items: accesses.filter((a) => a.link.id === shareLinkId)
          .map((a) => ({ id: a.id, at: '2026-10-11T10:00:00.000Z', action: a.action, document_id: a.documentId, ip: a.ip, user_agent: a.userAgent })),
        nextCursor: null,
      };
    },
  };
}

/** The Documents share-files port: DOC_A and DOC_B are shared files, DOC_PRIVATE is not. */
const documents = {
  async shareableFiles(projectId, ids) {
    const shareable = { [DOC_A]: 'Licença — memória descritiva', [DOC_B]: 'Plantas' };
    return ids.filter((id) => projectId === PROJECT && shareable[id]).map((id) => ({
      document_id: id, title: shareable[id], kind: 'drawing', file_type: 'pdf', mime: 'application/pdf',
      version_no: 2, size_bytes: 1000, sha256: 'ab'.repeat(32),
    }));
  },
  async signSharedDownload(projectId, documentId, { disposition }) {
    return documentId === DOC_PRIVATE ? null : { url: `https://r2.example/${documentId}?d=${disposition}` };
  },
};

const owner = (over = {}) => createViewerContext({
  clerkUserId: 'user_me', orgId: OWNER_ORG, clerkOrgId: 'org_owner', orgKind: 'household', orgRole: 'admin',
  permissions: ['org:plan:edit'], ...over,
});
const gc = () => owner({ orgId: GC_ORG, clerkOrgId: 'org_gc', orgKind: 'contractor' });

describe('share links over the v2 router (PRD-12 N-12)', () => {
  let router, store;
  const call = (method, path, { viewer = owner(), body = null, query = {}, headers = {} } = {}) =>
    router.dispatch({ method, path, viewer, body, query, headers });
  const week = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  async function create(body = {}) {
    const res = await call('POST', `/projects/${PROJECT}/share-links`, {
      body: { audience: 'Câmara Municipal da Maia', expires_at: week(), document_ids: [DOC_A], ...body },
    });
    return { res, token: res.body.url?.split('/share/')[1] };
  }

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerProject(router, { store, documents, shareBaseUrl: () => 'https://portal.linknms.com' });
  });

  test('create: the url carries the token once, the store only its hash; owner-only', async () => {
    const { res, token } = await create();
    assert.equal(res.status, 201);
    assert.match(token, /^[0-9a-f]{48}$/);
    assert.equal(res.body.status, 'active');
    assert.deepEqual(res.body.document_ids, [DOC_A]);
    assert.notEqual([...store.links.values()][0].token_hash, token);
    const forbidden = await call('POST', `/projects/${PROJECT}/share-links`, {
      viewer: gc(), body: { audience: 'CM', expires_at: week(), document_ids: [DOC_A] },
    });
    assert.equal(forbidden.status, 403);
  });

  test('create refuses: no documents, a file the build does not share, past or > 90 days', async () => {
    assert.equal((await create({ document_ids: [] })).res.status, 422);
    const priv = await create({ document_ids: [DOC_A, DOC_PRIVATE] });
    assert.equal(priv.res.status, 422);
    assert.match(priv.res.body.errors.document_ids, new RegExp(DOC_PRIVATE));
    assert.equal((await create({ expires_at: '2020-01-01T00:00:00Z' })).res.status, 422);
    const far = new Date(Date.now() + 120 * 24 * 3600 * 1000).toISOString();
    assert.equal((await create({ expires_at: far })).res.status, 422);
  });

  test('the holder sees only the shared files; every view and download is logged', async () => {
    const { token } = await create({ document_ids: [DOC_A] });
    const headers = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'Mozilla/5.0' };
    const view = await call('GET', `/shared/${token}`, { viewer: null, headers });
    assert.equal(view.status, 200);
    assert.equal(view.body.project_name, 'Casa da Maia');
    assert.equal(view.body.audience, 'Câmara Municipal da Maia');
    assert.deepEqual(view.body.documents.map((d) => d.id), [DOC_A]);
    assert.equal(store.accesses[0].action, 'view');
    assert.equal(store.accesses[0].ip, '203.0.113.9');

    const dl = await call('GET', `/shared/${token}/documents/${DOC_A}:download`, { viewer: null, query: { disposition: 'inline' } });
    assert.equal(dl.status, 302);
    assert.equal(dl.headers.location, `https://r2.example/${DOC_A}?d=inline`);
    assert.equal(store.accesses[1].documentId, DOC_A);

    // A document the link does not name: 404, not logged.
    assert.equal((await call('GET', `/shared/${token}/documents/${DOC_B}:download`, { viewer: null })).status, 404);
    assert.equal(store.accesses.length, 2);
    assert.equal(store.ledger.filter((t) => t === 'project.share_link.accessed').length, 2);
  });

  test('unknown token 404; expired and revoked 410 with the reason, never logged', async () => {
    assert.equal((await call('GET', `/shared/${'0'.repeat(48)}`, { viewer: null })).status, 404);
    assert.equal((await call('GET', '/shared/not-a-token', { viewer: null })).status, 404);

    const { res, token } = await create();
    [...store.links.values()][0].expires_at = '2020-01-01T00:00:00.000Z';
    const expired = await call('GET', `/shared/${token}`, { viewer: null });
    assert.equal(expired.status, 410);
    assert.equal(expired.body.reason, 'expired');
    assert.equal(expired.body.expires_at, '2020-01-01T00:00:00.000Z');

    [...store.links.values()][0].expires_at = week();
    const revoked = await call('POST', `/share-links/${res.body.id}:revoke`);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.status, 'revoked');
    const gone = await call('GET', `/shared/${token}/documents/${DOC_A}:download`, { viewer: null });
    assert.equal(gone.status, 410);
    assert.equal(gone.body.reason, 'revoked');
    assert.equal(store.accesses.length, 0);
    // Revoking again answers the link unchanged; one ledger entry.
    assert.equal((await call('POST', `/share-links/${res.body.id}:revoke`)).status, 200);
    assert.equal(store.ledger.filter((t) => t === 'project.share_link.revoked').length, 1);
  });

  test('list and access log: owner only (a participant is 403, not the token holder)', async () => {
    const { res, token } = await create();
    await call('GET', `/shared/${token}`, { viewer: null, headers: { 'user-agent': 'curl' } });
    const list = await call('GET', `/projects/${PROJECT}/share-links`);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].url, undefined);
    const log = await call('GET', `/share-links/${res.body.id}/accesses`);
    assert.equal(log.status, 200);
    assert.deepEqual(log.body.items.map((a) => [a.action, a.user_agent]), [['view', 'curl']]);
    assert.equal((await call('GET', `/projects/${PROJECT}/share-links`, { viewer: gc() })).status, 403);
    assert.equal((await call('GET', `/share-links/${res.body.id}/accesses`, { viewer: gc() })).status, 403);
    assert.equal((await call('POST', `/share-links/${res.body.id}:revoke`, { viewer: gc() })).status, 403);
  });
});
