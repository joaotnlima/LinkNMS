// RFP BIM model (LINA-409 / doc 24) end to end through the /api/v2 router,
// DB-free. The model is a Documents-module document (scope_type='rfp',
// kind='bim'); tendering owns the RFP authorization and delegates persistence
// to an injected documents store. A stateful in-memory documents-store double +
// the in-memory object-storage double stand in for pg-store + R2. Proves:
//   - attach is issuer-only, draft-only, IFC-only, size-capped;
//   - the reserve→complete handshake proves the bytes before the model exists;
//   - getRfp / getRfpByToken project the model into package.models[];
//   - the two view-url routes mint presigned INLINE GETs — authed (any RFP
//     reader) and public (token is the authority);
//   - a second attach REPLACES as a new version (one model per RFP);
//   - remove soft-deletes (the model leaves every read; bytes/ledger untouched).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { createInMemoryObjectStorage } from '../../documents/infra/storage.mjs';
import { registerTendering } from './register.mjs';
import { MAX_MODEL_BYTES } from '../domain/rfp-model.mjs';

const RFP = '01930000-0000-7000-8000-000000000001';
const PROJECT = '01930000-0000-7000-8000-000000000002';
const REC = '01930000-0000-7000-8000-000000000003';
const ISSUER_ORG = '01930000-0000-7000-8000-0000000000ff';
const RECIPIENT_ORG = '01930000-0000-7000-8000-000000000005';
const STRANGER_ORG = '01930000-0000-7000-8000-0000000000ee';
const TOKEN = 'a'.repeat(64);

const SHA = 'a'.repeat(64);
const ifc = { name: 'casa-silva.ifc', mime: 'application/octet-stream', size_bytes: 2048, sha256: SHA };

/** A stateful documents-store double — models create/version/complete/list/
 *  soft-delete the way the pg-store does, so the handshake is exercised fully. */
function fakeDocumentsStore() {
  const docs = new Map();      // id → document row
  const versions = new Map();  // `${id}.${no}` → version row
  return {
    docs, versions,
    async getPersonByClerkId() { return { id: 'person_1' }; },
    async listScopeDocuments({ scopeType, scopeId, kind }) {
      return [...docs.values()].filter((d) =>
        d.scope_type === scopeType && d.scope_id === scopeId && d.kind === kind
        && d.current_version > 0 && !d.deleted_at && d.private_to_org_id == null);
    },
    async getDocument(id) {
      const d = docs.get(id);
      return d && !d.deleted_at ? d : null;
    },
    async getVersion(id, no) { return versions.get(`${id}.${no}`) ?? null; },
    async createDocument({ id, projectId, scopeType, scopeId, kind, title, file, storageKey }) {
      docs.set(id, { id, project_id: projectId, scope_type: scopeType, scope_id: scopeId, kind, title, current_version: 0, deleted_at: null, private_to_org_id: null });
      const v = { document_id: id, version_no: 1, storage_key: storageKey, mime: file.mime, size_bytes: file.size_bytes, sha256: file.sha256.toLowerCase() };
      versions.set(`${id}.1`, v);
      return v;
    },
    async addVersion({ documentId, file, storageKeyOf }) {
      const next = (docs.get(documentId).current_version) + 1;
      const v = { document_id: documentId, version_no: next, storage_key: storageKeyOf(next), mime: file.mime, size_bytes: file.size_bytes, sha256: file.sha256.toLowerCase() };
      versions.set(`${documentId}.${next}`, v);
      return v;
    },
    async completeUpload({ documentId, versionNo }) {
      const doc = docs.get(documentId);
      if (!doc) return null;
      doc.current_version = versionNo;
      return { doc };
    },
    async softDeleteDocument(id) {
      const d = docs.get(id);
      if (!d || d.deleted_at) return null;
      d.deleted_at = new Date().toISOString();
      return { id };
    },
  };
}

function fakeStore(over = {}) {
  const rfp = {
    id: RFP, project_id: PROJECT, issuer_org_id: ISSUER_ORG,
    status: over.status ?? 'draft', package_version: 1, version: 1,
    visibility: over.visibility ?? 'invite_only',
  };
  return {
    async getRfp(id) { return id === RFP ? rfp : null; },
    async isRecipient(rfpId, orgId) { return orgId === RECIPIENT_ORG; },
    async isStaffed() { return true; },
    async getPersonByClerkId() { return { id: 'person_1' }; },
    async packageOf() { return { rows: [], items: [] }; },
    async clarificationsOf() { return []; },
    async markRecipientOpened() {},
    async findRecipientByToken(raw) {
      return raw === TOKEN ? { id: REC, rfp_id: RFP, org_id: RECIPIENT_ORG, rfp_status: rfp.status, proposal_id: null,
        title: 'Design', scope_text: null, specialties: [], purpose: 'design', mode: 'light',
        submission_deadline: null, project_name: 'Casa', project_location: null, email: 'b@x.pt' } : null;
    },
    async getProposal() { return null; },
  };
}

function makeRouter(store, documentsStore, storage) {
  const router = createRouter();
  registerTendering(router, { store, storage, documentsStore, contractingAward: async () => {} });
  return router;
}

function viewer(orgId, perms = ['org:tendering:issue']) {
  return createViewerContext({
    clerkUserId: 'user_x', personId: null, orgId, clerkOrgId: `clerk_${orgId}`,
    orgKind: 'contractor', orgRole: 'manager', permissions: perms, channel: 'ui',
  });
}

const call = (router, method, path, { v = null, body = null } = {}) =>
  router.dispatch({ method, path, viewer: v, query: {}, body, headers: {} });

/** Reserve + PUT + complete a model as the issuer; returns the documentId. */
async function attachModel(router, store, documentsStore, storage, file = ifc) {
  const reserve = await call(router, 'POST', `/rfps/${RFP}/model`, { v: viewer(ISSUER_ORG), body: { file } });
  assert.equal(reserve.status, 201, JSON.stringify(reserve.body));
  const { documentId, version } = reserve.body;
  // "upload": the storage double's head() sees whatever key the reserve signed.
  const vrow = documentsStore.versions.get(`${documentId}.${version}`);
  storage._objects.set(vrow.storage_key, { sizeBytes: file.size_bytes });
  const complete = await call(router, 'POST', `/rfps/${RFP}/model/${documentId}:complete`, { v: viewer(ISSUER_ORG) });
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  return documentId;
}

describe('attach — POST /rfps/{id}/model', () => {
  test('the issuer attaches an IFC on a draft and proves the bytes', async () => {
    const store = fakeStore(); const ds = fakeDocumentsStore(); const storage = createInMemoryObjectStorage();
    const router = makeRouter(store, ds, storage);
    const documentId = await attachModel(router, store, ds, storage);
    assert.equal(ds.docs.get(documentId).current_version, 1);
    assert.equal(ds.docs.get(documentId).kind, 'bim');
    assert.equal(ds.docs.get(documentId).title, 'casa-silva.ifc');
  });

  test('a non-issuer org is existence-hidden (404)', async () => {
    const router = makeRouter(fakeStore(), fakeDocumentsStore(), createInMemoryObjectStorage());
    const res = await call(router, 'POST', `/rfps/${RFP}/model`, { v: viewer(STRANGER_ORG), body: { file: ifc } });
    assert.equal(res.status, 404);
  });

  test('without org:tendering:issue it is forbidden', async () => {
    const router = makeRouter(fakeStore(), fakeDocumentsStore(), createInMemoryObjectStorage());
    const res = await call(router, 'POST', `/rfps/${RFP}/model`, { v: viewer(ISSUER_ORG, []), body: { file: ifc } });
    assert.equal(res.status, 403);
  });

  test('a published RFP refuses a model change', async () => {
    const router = makeRouter(fakeStore({ status: 'published' }), fakeDocumentsStore(), createInMemoryObjectStorage());
    const res = await call(router, 'POST', `/rfps/${RFP}/model`, { v: viewer(ISSUER_ORG), body: { file: ifc } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'invalid_transition');
  });

  test('a non-IFC file is refused', async () => {
    const router = makeRouter(fakeStore(), fakeDocumentsStore(), createInMemoryObjectStorage());
    const res = await call(router, 'POST', `/rfps/${RFP}/model`, { v: viewer(ISSUER_ORG), body: { file: { ...ifc, name: 'plan.pdf' } } });
    assert.equal(res.status, 422);
    assert.ok(res.body.errors['file.name']);
  });

  test('an oversize model is refused', async () => {
    const router = makeRouter(fakeStore(), fakeDocumentsStore(), createInMemoryObjectStorage());
    const res = await call(router, 'POST', `/rfps/${RFP}/model`, { v: viewer(ISSUER_ORG), body: { file: { ...ifc, size_bytes: MAX_MODEL_BYTES + 1 } } });
    assert.equal(res.status, 422);
    assert.ok(res.body.errors['file.size_bytes']);
  });

  test('complete before the bytes arrive is refused', async () => {
    const store = fakeStore(); const ds = fakeDocumentsStore(); const storage = createInMemoryObjectStorage();
    const router = makeRouter(store, ds, storage);
    const reserve = await call(router, 'POST', `/rfps/${RFP}/model`, { v: viewer(ISSUER_ORG), body: { file: ifc } });
    const res = await call(router, 'POST', `/rfps/${RFP}/model/${reserve.body.documentId}:complete`, { v: viewer(ISSUER_ORG) });
    assert.equal(res.status, 422);
  });
});

describe('projection — package.models[]', () => {
  test('getRfp shows the attached model to the issuer', async () => {
    const store = fakeStore(); const ds = fakeDocumentsStore(); const storage = createInMemoryObjectStorage();
    const router = makeRouter(store, ds, storage);
    const documentId = await attachModel(router, store, ds, storage);
    const res = await call(router, 'GET', `/rfps/${RFP}`, { v: viewer(ISSUER_ORG) });
    assert.equal(res.status, 200);
    assert.equal(res.body.package.models.length, 1);
    assert.deepEqual(res.body.package.models[0], {
      documentId, version: 1, fileName: 'casa-silva.ifc',
      mime: 'application/x-step', sizeBytes: 2048, sha256: SHA,
    });
  });

  test('getRfpByToken projects the model to the tokened bidder', async () => {
    const store = fakeStore(); const ds = fakeDocumentsStore(); const storage = createInMemoryObjectStorage();
    const router = makeRouter(store, ds, storage);
    await attachModel(router, store, ds, storage);
    const res = await call(router, 'GET', `/rfp-links/${TOKEN}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.rfp.package.models.length, 1);
  });
});

describe('view-url — presigned INLINE GET', () => {
  test('the issuer gets an inline view-url', async () => {
    const store = fakeStore(); const ds = fakeDocumentsStore(); const storage = createInMemoryObjectStorage();
    const router = makeRouter(store, ds, storage);
    const documentId = await attachModel(router, store, ds, storage);
    const res = await call(router, 'GET', `/rfps/${RFP}/model/${documentId}:view-url`, { v: viewer(ISSUER_ORG) });
    assert.equal(res.status, 200);
    assert.match(res.body.url, /^memory:\/\/download\//);
    assert.ok(res.body.expiresAt);
  });

  test('an invited recipient org gets a view-url even if not the issuer', async () => {
    const store = fakeStore(); const ds = fakeDocumentsStore(); const storage = createInMemoryObjectStorage();
    const router = makeRouter(store, ds, storage);
    const documentId = await attachModel(router, store, ds, storage);
    const res = await call(router, 'GET', `/rfps/${RFP}/model/${documentId}:view-url`, { v: viewer(RECIPIENT_ORG, []) });
    assert.equal(res.status, 200);
  });

  test('a stranger org is existence-hidden (404)', async () => {
    const store = fakeStore(); const ds = fakeDocumentsStore(); const storage = createInMemoryObjectStorage();
    const router = makeRouter(store, ds, storage);
    const documentId = await attachModel(router, store, ds, storage);
    const res = await call(router, 'GET', `/rfps/${RFP}/model/${documentId}:view-url`, { v: viewer(STRANGER_ORG, []) });
    assert.equal(res.status, 404);
  });

  test('the public token mints a view-url; a bad token is 404', async () => {
    const store = fakeStore(); const ds = fakeDocumentsStore(); const storage = createInMemoryObjectStorage();
    const router = makeRouter(store, ds, storage);
    const documentId = await attachModel(router, store, ds, storage);
    const ok = await call(router, 'GET', `/rfp-links/${TOKEN}/model/${documentId}:view-url`);
    assert.equal(ok.status, 200);
    assert.match(ok.body.url, /^memory:\/\/download\//);
    const bad = await call(router, 'GET', `/rfp-links/${'c'.repeat(64)}/model/${documentId}:view-url`);
    assert.equal(bad.status, 404);
  });
});

describe('replace & remove', () => {
  test('a second attach replaces as a new version of the same document', async () => {
    const store = fakeStore(); const ds = fakeDocumentsStore(); const storage = createInMemoryObjectStorage();
    const router = makeRouter(store, ds, storage);
    const first = await attachModel(router, store, ds, storage);
    const second = await attachModel(router, store, ds, storage, { ...ifc, name: 'casa-silva-v2.ifc', sha256: 'b'.repeat(64) });
    assert.equal(first, second); // same document, bumped version
    assert.equal(ds.docs.get(first).current_version, 2);
    const res = await call(router, 'GET', `/rfps/${RFP}`, { v: viewer(ISSUER_ORG) });
    assert.equal(res.body.package.models.length, 1);
    assert.equal(res.body.package.models[0].version, 2);
  });

  test('remove soft-deletes: the model leaves every read', async () => {
    const store = fakeStore(); const ds = fakeDocumentsStore(); const storage = createInMemoryObjectStorage();
    const router = makeRouter(store, ds, storage);
    const documentId = await attachModel(router, store, ds, storage);
    const del = await call(router, 'DELETE', `/rfps/${RFP}/model/${documentId}`, { v: viewer(ISSUER_ORG) });
    assert.equal(del.status, 204);
    assert.ok(ds.docs.get(documentId).deleted_at); // tombstoned, not destroyed
    const rfp = await call(router, 'GET', `/rfps/${RFP}`, { v: viewer(ISSUER_ORG) });
    assert.equal(rfp.body.package.models.length, 0);
    const view = await call(router, 'GET', `/rfps/${RFP}/model/${documentId}:view-url`, { v: viewer(ISSUER_ORG) });
    assert.equal(view.status, 404);
  });

  test('remove on a non-existent model is 404', async () => {
    const router = makeRouter(fakeStore(), fakeDocumentsStore(), createInMemoryObjectStorage());
    const res = await call(router, 'DELETE', `/rfps/${RFP}/model/${'0'.repeat(8)}-0000-7000-8000-000000000000`, { v: viewer(ISSUER_ORG) });
    assert.equal(res.status, 404);
  });
});
