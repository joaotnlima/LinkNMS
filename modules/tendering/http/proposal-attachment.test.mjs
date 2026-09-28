// Token-scoped proposal attachments (LINA-370) end to end through the /api/v2
// router, DB-free. The token IS the authority on the two public steps (reserve
// a presigned PUT, then prove the bytes); the download is the authed read side
// (issuer or bidder). A fake store + the in-memory object storage double stand
// in for pg-store + R2. Proves:
//   - reserve mints a ticket only on a LIVE link, only for an allowed file;
//   - the file envelope is bounded (mime whitelist, size cap, per-proposal cap);
//   - complete refuses until the bytes are present, and is confined to the
//     token's own proposal;
//   - submit accepts only `stored` attachment ids of THIS proposal;
//   - download is issuer|bidder only, existence-hidden to everyone else.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { createInMemoryObjectStorage } from '../../documents/infra/storage.mjs';
import { registerTendering } from './register.mjs';
import { MAX_SIZE_BYTES, MAX_ATTACHMENTS_PER_PROPOSAL } from '../domain/attachment.mjs';

const RFP = '01930000-0000-7000-8000-000000000001';
const PROJECT = '01930000-0000-7000-8000-000000000002';
const REC = '01930000-0000-7000-8000-000000000003';
const PROPOSAL = '01930000-0000-7000-8000-000000000004';
const BIDDER_ORG = '01930000-0000-7000-8000-000000000005';
const ISSUER_ORG = '01930000-0000-7000-8000-0000000000ff';
const STRANGER_ORG = '01930000-0000-7000-8000-0000000000ee';
const OTHER_PROPOSAL = '01930000-0000-7000-8000-000000000009';

const LIVE = 'a'.repeat(64);
const SPENT = 'b'.repeat(64);

const SHA = 'a'.repeat(64);
const goodFile = { name: 'portfolio.jpg', mime: 'image/jpeg', size_bytes: 2048, sha256: SHA };

function fakeStore(over = {}) {
  const proposals = new Map([
    [PROPOSAL, {
      id: PROPOSAL, rfp_id: RFP, recipient_id: REC, bidder_org_id: BIDDER_ORG,
      status: over.proposalStatus ?? 'invited', current_revision: 0,
      document_ids: [], version: 1, issuer_org_id: ISSUER_ORG,
      rfp_status: over.rfp_status ?? 'published', project_id: PROJECT,
    }],
  ]);
  const recipientByToken = {
    [LIVE]: { id: REC, rfp_id: RFP, org_id: BIDDER_ORG, rfp_status: over.rfp_status ?? 'published', proposal_id: PROPOSAL },
  };
  const documents = new Map(over.documents ?? []);
  const submitted = [];
  return {
    documents, submitted,
    async findRecipientByToken(raw) { return recipientByToken[raw] ?? null; },
    async getProposal(id) {
      const p = proposals.get(id);
      return p ? { ...p, rfp_status: over.rfp_status ?? p.rfp_status } : null;
    },
    async proposalDoc() { return { rows: [], links: [], lines: [] }; },
    async createProposalDocument({ id, proposalId, storageKey, file }) {
      const row = {
        id, proposal_id: proposalId, storage_key: storageKey, file_name: file.name,
        mime: file.mime, size_bytes: file.size_bytes, sha256: file.sha256.toLowerCase(),
        status: 'pending',
      };
      documents.set(id, row);
      return row;
    },
    async getProposalDocument(id) { return documents.get(id) ?? null; },
    async completeProposalDocument(id) {
      const row = documents.get(id);
      if (!row) return null;
      row.status = 'stored';
      return row;
    },
    async proposalDocumentCount(proposalId) {
      return [...documents.values()].filter((d) => d.proposal_id === proposalId).length;
    },
    async storedProposalDocumentIds(proposalId) {
      return new Set([...documents.values()]
        .filter((d) => d.proposal_id === proposalId && d.status === 'stored').map((d) => d.id));
    },
    async proposalDocumentForDownload(id) {
      const d = documents.get(id);
      if (!d) return null;
      const p = proposals.get(d.proposal_id);
      return { ...d, bidder_org_id: p?.bidder_org_id ?? null, issuer_org_id: ISSUER_ORG, rfp_id: RFP };
    },
    async submitPublicProposal(args) {
      submitted.push(args);
      const p = proposals.get(args.proposalId);
      return { ...p, status: 'submitted', current_revision: args.revision, document_ids: args.documentIds };
    },
  };
}

function makeRouter(store, storage) {
  const router = createRouter();
  registerTendering(router, { store, storage, contractingAward: async () => {} });
  return router;
}

const anon = (router, method, path, body = null) =>
  router.dispatch({ method, path, viewer: null, query: {}, body, headers: {} });

const authed = (router, method, path, viewer) =>
  router.dispatch({ method, path, viewer, query: {}, body: null, headers: {} });

function viewer(orgId) {
  return createViewerContext({
    clerkUserId: 'user_x', personId: null, orgId, clerkOrgId: `clerk_${orgId}`,
    orgKind: 'contractor', orgRole: 'manager', permissions: [], channel: 'ui',
  });
}

const UUIDish = /^[0-9a-f-]{36}$/;

describe('reserve — POST /rfp-links/{token}/documents', () => {
  test('a live link mints a presigned ticket and reserves a pending row', async () => {
    const store = fakeStore();
    const storage = createInMemoryObjectStorage();
    const res = await anon(makeRouter(store, storage), 'POST', `/rfp-links/${LIVE}/documents`, { file: goodFile });
    assert.equal(res.status, 201);
    assert.match(res.body.document_id, UUIDish);
    assert.match(res.body.upload_url, /^memory:\/\/upload\//);
    assert.ok(res.body.expires_at);
    assert.equal(store.documents.get(res.body.document_id).status, 'pending');
  });

  test('an unknown token is a uniform not_found', async () => {
    const res = await anon(makeRouter(fakeStore(), createInMemoryObjectStorage()),
      'POST', `/rfp-links/${'c'.repeat(64)}/documents`, { file: goodFile });
    assert.equal(res.status, 404);
  });

  test('a spent proposal refuses new attachments', async () => {
    const store = fakeStore({ proposalStatus: 'submitted' });
    const res = await anon(makeRouter(store, createInMemoryObjectStorage()),
      'POST', `/rfp-links/${LIVE}/documents`, { file: goodFile });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'invalid_transition');
  });

  test('a closed RFP refuses new attachments', async () => {
    const store = fakeStore({ rfp_status: 'closed' });
    const res = await anon(makeRouter(store, createInMemoryObjectStorage()),
      'POST', `/rfp-links/${LIVE}/documents`, { file: goodFile });
    assert.equal(res.status, 409);
  });

  test('a disallowed mime is refused', async () => {
    const res = await anon(makeRouter(fakeStore(), createInMemoryObjectStorage()),
      'POST', `/rfp-links/${LIVE}/documents`, { file: { ...goodFile, mime: 'application/x-msdownload' } });
    assert.equal(res.status, 422);
    assert.ok(res.body.errors['file.mime']);
  });

  test('an oversize file is refused', async () => {
    const res = await anon(makeRouter(fakeStore(), createInMemoryObjectStorage()),
      'POST', `/rfp-links/${LIVE}/documents`, { file: { ...goodFile, size_bytes: MAX_SIZE_BYTES + 1 } });
    assert.equal(res.status, 422);
    assert.ok(res.body.errors['file.size_bytes']);
  });

  test('past the per-proposal cap the reserve is refused', async () => {
    const documents = Array.from({ length: MAX_ATTACHMENTS_PER_PROPOSAL }, (_, i) => [
      `0193000a-0000-7000-8000-00000000000${i.toString(16)}`,
      { id: `d${i}`, proposal_id: PROPOSAL, status: 'stored' },
    ]);
    const store = fakeStore({ documents });
    const res = await anon(makeRouter(store, createInMemoryObjectStorage()),
      'POST', `/rfp-links/${LIVE}/documents`, { file: goodFile });
    assert.equal(res.status, 422);
  });
});

describe('complete — POST /rfp-links/{token}/documents/{id}:complete', () => {
  async function reserveOne(store, storage) {
    const res = await anon(makeRouter(store, storage), 'POST', `/rfp-links/${LIVE}/documents`, { file: goodFile });
    return res.body.document_id;
  }

  test('with the bytes present the attachment goes stored', async () => {
    const store = fakeStore();
    const storage = createInMemoryObjectStorage();
    const id = await reserveOne(store, storage);
    // "upload" the file: the double's head() sees whatever key it signed.
    storage._objects.set(store.documents.get(id).storage_key, { sizeBytes: goodFile.size_bytes });
    const res = await anon(makeRouter(store, storage), 'POST', `/rfp-links/${LIVE}/documents/${id}:complete`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'stored');
    assert.equal(store.documents.get(id).status, 'stored');
  });

  test('before the bytes arrive complete is refused', async () => {
    const store = fakeStore();
    const storage = createInMemoryObjectStorage();
    const id = await reserveOne(store, storage);
    const res = await anon(makeRouter(store, storage), 'POST', `/rfp-links/${LIVE}/documents/${id}:complete`);
    assert.equal(res.status, 422);
  });

  test('a document id under another proposal is not_found', async () => {
    const store = fakeStore({ documents: [[OTHER_PROPOSAL, { id: OTHER_PROPOSAL, proposal_id: 'other', status: 'pending', storage_key: 'k' }]] });
    const res = await anon(makeRouter(store, createInMemoryObjectStorage()),
      'POST', `/rfp-links/${LIVE}/documents/${OTHER_PROPOSAL}:complete`);
    assert.equal(res.status, 404);
  });
});

describe('submit references only stored attachments', () => {
  const bid = (docIds) => ({
    total: { amount_cents: 500000, currency: 'EUR' }, duration_wd: 20, document_ids: docIds,
  });

  test('a stored attachment id is accepted', async () => {
    const store = fakeStore({ documents: [[PROPOSAL, { id: PROPOSAL, proposal_id: PROPOSAL, status: 'stored' }]] });
    const res = await anon(makeRouter(store, createInMemoryObjectStorage()),
      'POST', `/rfp-links/${LIVE}/proposal`, bid([PROPOSAL]));
    assert.equal(res.status, 200);
    assert.deepEqual(store.submitted[0].documentIds, [PROPOSAL]);
  });

  test('a well-formed but unknown/foreign id is refused', async () => {
    const store = fakeStore();
    const res = await anon(makeRouter(store, createInMemoryObjectStorage()),
      'POST', `/rfp-links/${LIVE}/proposal`, bid([OTHER_PROPOSAL]));
    assert.equal(res.status, 422);
    assert.ok(res.body.errors.document_ids);
  });
});

describe('download — GET /proposals/{id}/documents/{id}:download', () => {
  function storedDoc() {
    return fakeStore({ documents: [[PROPOSAL, { id: PROPOSAL, proposal_id: PROPOSAL, status: 'stored', storage_key: 'v2/proposal-documents/x', file_name: 'p.jpg' }]] });
  }

  test('the issuer gets a 302 to a presigned URL', async () => {
    const res = await authed(makeRouter(storedDoc(), createInMemoryObjectStorage()),
      'GET', `/proposals/${PROPOSAL}/documents/${PROPOSAL}:download`, viewer(ISSUER_ORG));
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^memory:\/\/download\//);
  });

  test('the bidder org gets a 302', async () => {
    const res = await authed(makeRouter(storedDoc(), createInMemoryObjectStorage()),
      'GET', `/proposals/${PROPOSAL}/documents/${PROPOSAL}:download`, viewer(BIDDER_ORG));
    assert.equal(res.status, 302);
  });

  test('a stranger org is existence-hidden (404)', async () => {
    const res = await authed(makeRouter(storedDoc(), createInMemoryObjectStorage()),
      'GET', `/proposals/${PROPOSAL}/documents/${PROPOSAL}:download`, viewer(STRANGER_ORG));
    assert.equal(res.status, 404);
  });

  test('a pending (never stored) attachment is 404', async () => {
    const store = fakeStore({ documents: [[PROPOSAL, { id: PROPOSAL, proposal_id: PROPOSAL, status: 'pending', storage_key: 'k' }]] });
    const res = await authed(makeRouter(store, createInMemoryObjectStorage()),
      'GET', `/proposals/${PROPOSAL}/documents/${PROPOSAL}:download`, viewer(ISSUER_ORG));
    assert.equal(res.status, 404);
  });
});
