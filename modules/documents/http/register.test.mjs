// Documents operations end to end through the /api/v2 router, DB-free: the
// fake store answers what pg-store would, the in-memory storage double stands
// in for R2. Proves the doc-16 request flow — session → V6 relationship
// (WRITE = edit scope, READ = readers of the scope) — the upload protocol
// (ticket → PUT → complete; nothing visible before the bytes are proven),
// existence hiding (404 for strangers, 403 only for readers who cannot
// write) and the 302 presigned download.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { createInMemoryObjectStorage } from '../infra/storage.mjs';
import { registerDocuments } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1'; // reads the task
const GC_ORG = '01920000-0000-7000-8000-0000000000a2'; // edits the task
const STRANGER_ORG = '01920000-0000-7000-8000-0000000000a5';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const TASK = '01920000-0000-7000-8000-0000000000d1';
const DOC = '01920000-0000-7000-8000-0000000000e1';
const NEW_ID = '01920000-0000-7000-8000-0000000000ff';
const ME = '01920000-0000-7000-8000-0000000000e9';
const SHA = 'a'.repeat(64);

const FILE = { name: 'planta piso 0.pdf', mime: 'application/pdf', size_bytes: 1024, sha256: SHA };

function baseDoc(over = {}) {
  return {
    id: DOC, project_id: PROJECT, scope_type: 'task', scope_id: TASK,
    kind: 'drawing', title: 'Planta piso 0', share_with_ancestors: false,
    current_version: 1,
    ...over,
  };
}

function v1(over = {}) {
  return {
    document_id: DOC, version_no: 1, mime: 'application/pdf', size_bytes: 1024,
    sha256: SHA, storage_key: `v2/documents/${DOC}/v1-r/planta_piso_0.pdf`,
    uploaded_by_org_id: GC_ORG, uploaded_by_person_id: ME,
    uploaded_at: '2026-09-26T10:00:00Z',
    ...over,
  };
}

function fakeStore() {
  const docs = new Map([[DOC, baseDoc()]]);
  const versions = new Map([[`${DOC}.1`, v1()]]);
  const ledger = [];

  return {
    docs, versions, ledger,
    async getPersonByClerkId(id) {
      return id === 'user_me' ? { id: ME, clerk_user_id: 'user_me', email: 'me@x.pt' } : null;
    },
    async resolveScope(scopeType, scopeId) {
      return scopeType === 'task' && scopeId === TASK ? { projectId: PROJECT } : null;
    },
    // V6 EXACTLY as pg-store answers it: GC edits the task, owner only reads.
    async canEditScope({ orgId }) { return orgId === GC_ORG; },
    async canReadScope({ orgId }) { return orgId === GC_ORG || orgId === OWNER_ORG; },
    async getDocument(id) { return docs.get(id) ?? null; },
    async getVersion(documentId, versionNo) { return versions.get(`${documentId}.${versionNo}`) ?? null; },
    async createDocument(cmd) {
      docs.set(cmd.id, baseDoc({ id: cmd.id, kind: cmd.kind, title: cmd.title, current_version: 0 }));
      const row = v1({ document_id: cmd.id, storage_key: cmd.storageKey, size_bytes: cmd.file.size_bytes, sha256: cmd.file.sha256.toLowerCase(), uploaded_by_org_id: cmd.actor.orgId });
      versions.set(`${cmd.id}.1`, row);
      return row;
    },
    async addVersion({ documentId, file, storageKeyOf, actor }) {
      const doc = docs.get(documentId);
      const no = doc.current_version + 1;
      const row = v1({ document_id: documentId, version_no: no, storage_key: storageKeyOf(no), size_bytes: file.size_bytes, sha256: file.sha256.toLowerCase(), uploaded_by_org_id: actor.orgId });
      versions.set(`${documentId}.${no}`, row);
      return row;
    },
    async completeUpload({ documentId, versionNo }) {
      const doc = docs.get(documentId);
      if (!doc || versionNo <= doc.current_version) return { doc }; // replay absorbed
      const next = { ...doc, current_version: versionNo };
      docs.set(documentId, next);
      ledger.push('documents.version.uploaded');
      return { doc: next };
    },
    async listVersions(documentId, upTo) {
      return [...versions.values()].filter((v) => v.document_id === documentId && v.version_no <= upTo);
    },
    async listDocuments() {
      return { items: [...docs.values()].filter((d) => d.current_version >= 1), nextCursor: null };
    },
  };
}

function viewer(orgId) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: orgId && `clerk_${orgId}`,
    orgKind: orgId === OWNER_ORG ? 'household' : 'contractor', orgRole: orgId ? 'manager' : null,
    permissions: [], channel: 'ui',
  });
}

describe('documents over the /api/v2 router', () => {
  let router, store, storage;

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    storage = createInMemoryObjectStorage();
    registerDocuments(router, { store, storage });
  });

  const dispatch = (method, path, viewerCtx, body = null, query = {}) =>
    router.dispatch({ method, path, viewer: viewerCtx, body, query, headers: {} });

  describe('createDocument (WRITE = edit scope)', () => {
    const create = { id: NEW_ID, scope_type: 'task', scope_id: TASK, kind: 'photo', title: 'Fissura na laje', file: FILE };

    test('an editor gets a ticket → 201 with <id>.1 and a presigned PUT', async () => {
      const res = await dispatch('POST', '/documents', viewer(GC_ORG), create);
      assert.equal(res.status, 201);
      assert.equal(res.body.document_version_id, `${NEW_ID}.1`);
      assert.ok(res.body.upload_url.length > 0);
      assert.ok(res.body.expires_at);
    });

    test('a reader that cannot edit → 403 (it may know the object exists)', async () => {
      const res = await dispatch('POST', '/documents', viewer(OWNER_ORG), create);
      assert.equal(res.status, 403);
    });

    test('a stranger → 404 (never learns the object exists)', async () => {
      const res = await dispatch('POST', '/documents', viewer(STRANGER_ORG), create);
      assert.equal(res.status, 404);
    });

    test('a malformed sha256 → 422', async () => {
      const res = await dispatch('POST', '/documents', viewer(GC_ORG),
        { ...create, file: { ...FILE, sha256: 'nope' } });
      assert.equal(res.status, 422);
    });

    test('replaying the same create re-issues the ticket; a stolen id → 409', async () => {
      const first = await dispatch('POST', '/documents', viewer(GC_ORG), create);
      assert.equal(first.status, 201);
      const replay = await dispatch('POST', '/documents', viewer(GC_ORG), create);
      assert.equal(replay.status, 201);
      assert.equal(replay.body.document_version_id, `${NEW_ID}.1`);
      const stolen = await dispatch('POST', '/documents', viewer(GC_ORG),
        { ...create, id: DOC, file: { ...FILE, sha256: 'b'.repeat(64) } });
      assert.equal(stolen.status, 409);
    });
  });

  describe('completeUpload (the bytes must be proven)', () => {
    test('before the PUT → 422; after → 200 and the version goes live', async () => {
      const ticket = await dispatch('POST', `/documents/${DOC}/versions`, viewer(GC_ORG), { file: FILE });
      assert.equal(ticket.status, 201);
      const ref = ticket.body.document_version_id;

      const early = await dispatch('POST', `/document-versions/${ref}:complete`, viewer(GC_ORG));
      assert.equal(early.status, 422);

      storage._objects.set(store.versions.get(ref).storage_key, { sizeBytes: 1024 });
      const done = await dispatch('POST', `/document-versions/${ref}:complete`, viewer(GC_ORG));
      assert.equal(done.status, 200);
      assert.equal(done.body.current_version, 2);
      assert.ok(store.ledger.includes('documents.version.uploaded'));
    });

    test('a size mismatch → 422', async () => {
      const ticket = await dispatch('POST', `/documents/${DOC}/versions`, viewer(GC_ORG), { file: FILE });
      const ref = ticket.body.document_version_id;
      storage._objects.set(store.versions.get(ref).storage_key, { sizeBytes: 999 });
      const res = await dispatch('POST', `/document-versions/${ref}:complete`, viewer(GC_ORG));
      assert.equal(res.status, 422);
    });

    test('only the org that opened the upload completes it → 403', async () => {
      const ticket = await dispatch('POST', `/documents/${DOC}/versions`, viewer(GC_ORG), { file: FILE });
      const ref = ticket.body.document_version_id;
      storage._objects.set(store.versions.get(ref).storage_key, { sizeBytes: 1024 });
      const res = await dispatch('POST', `/document-versions/${ref}:complete`, viewer(OWNER_ORG));
      assert.equal(res.status, 403);
    });
  });

  describe('createDocumentVersion', () => {
    test('the scope of an existing document is immutable → 422', async () => {
      const res = await dispatch('POST', `/documents/${DOC}/versions`, viewer(GC_ORG),
        { file: FILE, scope_type: 'project', scope_id: PROJECT });
      assert.equal(res.status, 422);
    });
  });

  describe('listDocuments + download (READ = readers of the scope)', () => {
    test('a reader lists completed documents', async () => {
      const res = await dispatch('GET', '/documents', viewer(OWNER_ORG), null,
        { scope_type: 'task', scope_id: TASK });
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 1);
      assert.equal(res.body.items[0].versions[0].sha256, SHA);
    });

    test('a stranger → 404', async () => {
      const res = await dispatch('GET', '/documents', viewer(STRANGER_ORG), null,
        { scope_type: 'task', scope_id: TASK });
      assert.equal(res.status, 404);
    });

    test('download answers 302 with a short-lived signed URL, no-store', async () => {
      const res = await dispatch('GET', `/document-versions/${DOC}.1:download`, viewer(OWNER_ORG));
      assert.equal(res.status, 302);
      assert.ok(res.headers.location.startsWith('memory://download/'));
      assert.equal(res.headers['cache-control'], 'no-store');
    });

    test('a reserved-but-never-completed version does not exist → 404', async () => {
      await dispatch('POST', `/documents/${DOC}/versions`, viewer(GC_ORG), { file: FILE });
      const res = await dispatch('GET', `/document-versions/${DOC}.2:download`, viewer(OWNER_ORG));
      assert.equal(res.status, 404);
    });
  });

  describe('private documents (record exports) narrow READ to their owning org', () => {
    // A document private to GC_ORG — a record export GC produced. OWNER can read
    // the task scope, but must not download GC's private export.
    beforeEach(() => {
      store.docs.set(DOC, baseDoc({ private_to_org_id: GC_ORG }));
    });

    test('the owning org still downloads it (302)', async () => {
      const res = await dispatch('GET', `/document-versions/${DOC}.1:download`, viewer(GC_ORG));
      assert.equal(res.status, 302);
    });

    test('a co-participant who can read the scope is refused (404)', async () => {
      const res = await dispatch('GET', `/document-versions/${DOC}.1:download`, viewer(OWNER_ORG));
      assert.equal(res.status, 404);
    });

    test('the viewer org is passed to listDocuments for the private-row filter', async () => {
      let seenOrg;
      store.listDocuments = async ({ orgId }) => { seenOrg = orgId; return { items: [], nextCursor: null }; };
      await dispatch('GET', '/documents', viewer(GC_ORG), null, { scope_type: 'task', scope_id: TASK });
      assert.equal(seenOrg, GC_ORG);
    });
  });
});
