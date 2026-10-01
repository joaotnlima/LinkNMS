// Record operations end to end through the /api/v2 router, DB-free: the fake
// store answers what pg-store would. Proves the doc-16 gate (project.participant
// ∧ staffing), the V7 redaction passthrough, and the verify wiring — per op.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerRecord } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const GC_ORG = '01920000-0000-7000-8000-0000000000a2';
const STRANGER_ORG = '01920000-0000-7000-8000-0000000000a3';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const ME = '01920000-0000-7000-8000-0000000000c1';
const OBJ = '01920000-0000-7000-8000-0000000000d1';

// The store's listEvents returns rows already tagged `visible`; the http layer
// only shapes them (redaction lives in domain/redaction.mjs, unit-tested there).
function fakeStore() {
  const participants = new Set([`${PROJECT}:${OWNER_ORG}`, `${PROJECT}:${GC_ORG}`]);
  const staffed = new Set();
  const rows = [
    {
      seq: '2', occurred_at: new Date('2026-09-28T11:00:00Z'), category: 'contracting',
      type: 'contracting.change_order.approved', actor_person_id: ME, actor_org_id: OWNER_ORG,
      actor_org_role: 'manager', object_type: 'change_order', object_id: OBJ,
      payload: { delta_cents: 5000 }, entry_hash: 'aa'.repeat(32), prev_hash: 'bb'.repeat(32),
      visible: false, // GC-only contract scope, redacted for the owner in this fixture
    },
    {
      seq: '1', occurred_at: new Date('2026-09-28T10:00:00Z'), category: 'project',
      type: 'project.created', actor_person_id: ME, actor_org_id: OWNER_ORG,
      actor_org_role: 'manager', object_type: 'project', object_id: PROJECT,
      payload: { name: 'Casa' }, entry_hash: 'cc'.repeat(32), prev_hash: null,
      visible: true,
    },
  ];

  return {
    participants, staffed,
    async getPersonByClerkId(id) { return id === 'user_me' ? { id: ME } : null; },
    async getProject(id) {
      return id === PROJECT
        ? { id: PROJECT, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG, name: 'Casa Silva' }
        : null;
    },
    async isParticipant(projectId, orgId) { return participants.has(`${projectId}:${orgId}`); },
    async isStaffed(projectId, orgId, personId) { return staffed.has(`${projectId}:${orgId}:${personId}`); },
    async listEvents({ objectId, cursorSeq, limit }) {
      let out = rows.slice();
      if (objectId) out = out.filter((r) => r.object_id === objectId);
      if (cursorSeq != null) out = out.filter((r) => Number(r.seq) < Number(cursorSeq));
      const nextCursor = out.length > limit ? String(out[limit - 1].seq) : null;
      return { rows: out.slice(0, limit), nextCursor };
    },
    // Whole ledger in chain order (seq ASC), each row still tagged `visible`.
    async listAllEvents() { return rows.slice().sort((a, b) => Number(a.seq) - Number(b.seq)); },
    async verifyChain() { return { valid: true, length: 2, head: 'cc'.repeat(32), first_invalid_seq: null }; },
  };
}

// A documents module double: records what the export persisted so the test can
// assert the bytes went to storage and the Document descriptor came back.
function fakeDocuments() {
  const storage = {
    puts: [],
    async put({ key, body, mime, sha256Hex }) {
      this.puts.push({ key, body, mime, sha256Hex });
      return { sizeBytes: Buffer.byteLength(body) };
    },
  };
  const docs = new Map();
  const versions = new Map();
  const store = {
    creates: [],
    async createDocument(cmd) {
      this.creates.push(cmd);
      docs.set(cmd.id, {
        id: cmd.id, scope_type: cmd.scopeType, scope_id: cmd.scopeId, kind: cmd.kind,
        title: cmd.title, share_with_ancestors: cmd.shareWithAncestors, current_version: 0,
        private_to_org_id: cmd.privateToOrgId ?? null,
      });
      versions.set(`${cmd.id}.1`, {
        document_id: cmd.id, version_no: 1, mime: cmd.file.mime, size_bytes: cmd.file.size_bytes,
        sha256: cmd.file.sha256, storage_key: cmd.storageKey,
        uploaded_by_person_id: cmd.actor.personId, uploaded_by_org_id: cmd.actor.orgId,
        uploaded_at: '2026-10-01T09:00:00Z',
      });
    },
    async completeUpload({ documentId, versionNo }) {
      const doc = { ...docs.get(documentId), current_version: versionNo };
      docs.set(documentId, doc);
      return { doc };
    },
    async listVersions(documentId, upTo) {
      return [...versions.values()].filter((v) => v.document_id === documentId && v.version_no <= upTo);
    },
  };
  return { store, storage };
}

const owner = (over = {}) => createViewerContext({
  clerkUserId: 'user_me', orgId: OWNER_ORG, clerkOrgId: 'org_owner',
  orgKind: 'household', orgRole: 'admin', permissions: [], ...over,
});
const stranger = () => owner({ orgId: STRANGER_ORG, clerkOrgId: 'org_x' });

describe('record over the v2 router', () => {
  let router, store, documents;
  const call = (method, path, { viewer = owner(), query = {} } = {}) =>
    router.dispatch({ method, path, viewer, query });

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    documents = fakeDocuments();
    registerRecord(router, { store, documents });
  });

  describe('listRecord', () => {
    test('200 for a participant: full entry keeps payload, redacted entry is skeletal', async () => {
      const res = await call('GET', `/projects/${PROJECT}/record`);
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 2);
      const full = res.body.items.find((e) => e.seq === 1);
      assert.equal(full.redacted, false);
      assert.deepEqual(full.payload, { name: 'Casa' });
      const redacted = res.body.items.find((e) => e.seq === 2);
      assert.equal(redacted.redacted, true);
      assert.equal(redacted.payload, undefined);
      assert.equal(redacted.type, undefined);
      assert.equal(redacted.entry_hash, 'aa'.repeat(32)); // hash survives for verification
    });

    test('404 for a non-participant: the project is not theirs to learn', async () => {
      assert.equal((await call('GET', `/projects/${PROJECT}/record`, { viewer: stranger() })).status, 404);
    });

    test('403 (no active org) when the viewer has not picked an org', async () => {
      const res = await call('GET', `/projects/${PROJECT}/record`, { viewer: owner({ orgId: null }) });
      assert.equal(res.status, 403);
    });

    test('unstaffed non-manager is 403; managers see the whole org', async () => {
      const member = owner({ orgRole: 'member' });
      assert.equal((await call('GET', `/projects/${PROJECT}/record`, { viewer: member })).status, 403);
      store.staffed.add(`${PROJECT}:${OWNER_ORG}:${ME}`);
      assert.equal((await call('GET', `/projects/${PROJECT}/record`, { viewer: member })).status, 200);
    });

    test('422 on a non-uuid object_id filter', async () => {
      const res = await call('GET', `/projects/${PROJECT}/record`, { query: { object_id: 'not-a-uuid' } });
      assert.equal(res.status, 422);
      assert.ok(res.body.errors.object_id);
    });

    test('object_id filter narrows to that object', async () => {
      const res = await call('GET', `/projects/${PROJECT}/record`, { query: { object_id: OBJ } });
      assert.equal(res.body.items.length, 1);
      assert.equal(res.body.items[0].seq, 2);
    });
  });

  describe('verifyRecord', () => {
    test('200 with the ChainVerification report for a participant', async () => {
      const res = await call('POST', `/projects/${PROJECT}/record:verify`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { valid: true, length: 2, head: 'cc'.repeat(32), first_invalid_seq: null });
    });

    test('404 for a non-participant', async () => {
      assert.equal((await call('POST', `/projects/${PROJECT}/record:verify`, { viewer: stranger() })).status, 404);
    });
  });

  describe('exportRecord', () => {
    test('202 → Document; bytes land in storage, document is private to the viewer org', async () => {
      const res = await call('POST', `/projects/${PROJECT}/record:export`);
      assert.equal(res.status, 202);
      // The 202 body is the Document descriptor (completed version 1).
      assert.equal(res.body.scope_type, 'project');
      assert.equal(res.body.scope_id, PROJECT);
      assert.equal(res.body.kind, 'other');
      assert.equal(res.body.current_version, 1);
      assert.equal(res.body.versions.length, 1);
      assert.equal(res.body.versions[0].mime, 'application/json');

      // Persisted through the documents module, private to the exporting org.
      assert.equal(documents.store.creates.length, 1);
      const create = documents.store.creates[0];
      assert.equal(create.privateToOrgId, OWNER_ORG);
      assert.equal(create.scopeType, 'project');

      // The bytes went to R2 with a pinned sha256 that matches what was declared.
      assert.equal(documents.storage.puts.length, 1);
      const put = documents.storage.puts[0];
      assert.equal(put.sha256Hex, create.file.sha256);
      assert.equal(put.key, create.storageKey);

      // The artefact is the self-proving projection: header + the whole ledger.
      const artefact = JSON.parse(put.body.toString('utf8'));
      assert.equal(artefact.export.project_id, PROJECT);
      assert.deepEqual(artefact.export.verification, { valid: true, length: 2, head: 'cc'.repeat(32), first_invalid_seq: null });
      assert.equal(artefact.entries.length, 2);
      assert.equal(artefact.entries[0].seq, 1); // chain order
    });

    test('404 for a non-participant: the project is not theirs to export', async () => {
      const res = await call('POST', `/projects/${PROJECT}/record:export`, { viewer: stranger() });
      assert.equal(res.status, 404);
      assert.equal(documents.store.creates.length, 0);
      assert.equal(documents.storage.puts.length, 0);
    });

    test('403 (no active org) when the viewer has not picked an org', async () => {
      const res = await call('POST', `/projects/${PROJECT}/record:export`, { viewer: owner({ orgId: null }) });
      assert.equal(res.status, 403);
    });

    test('unstaffed non-manager cannot export (403); a staffed one can (202)', async () => {
      const member = owner({ orgRole: 'member' });
      assert.equal((await call('POST', `/projects/${PROJECT}/record:export`, { viewer: member })).status, 403);
      store.staffed.add(`${PROJECT}:${OWNER_ORG}:${ME}`);
      assert.equal((await call('POST', `/projects/${PROJECT}/record:export`, { viewer: member })).status, 202);
    });
  });
});
