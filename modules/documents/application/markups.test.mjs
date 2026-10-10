// The markup use cases (PRD-06) against an in-memory store: who may read,
// save, close and link; the version conflict; client-id replays; the ports a
// link is checked through.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  listDocumentMarkups, saveDocumentMarkups, closeMarkup, reopenMarkup, linkMarkup,
} from './markups.mjs';

const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const DOC = '01920000-0000-7000-8000-0000000000e1';
const CONTRACT_DOC = '01920000-0000-7000-8000-0000000000e2';
const GC = '01920000-0000-7000-8000-0000000000a2';
const OWNER = '01920000-0000-7000-8000-0000000000a1';
const STRANGER = '01920000-0000-7000-8000-0000000000a5';
const M1 = '01920000-0000-7000-8000-000000000101';
const M2 = '01920000-0000-7000-8000-000000000102';
const Q = '01920000-0000-7000-8000-000000000201';
const NC = '01920000-0000-7000-8000-000000000301';
const SHA = 'c'.repeat(64);

function memoryStore() {
  const docs = new Map([
    [DOC, { id: DOC, project_id: PROJECT, scope_type: 'project', scope_id: PROJECT, kind: 'drawing', title: 'A-301', current_version: 2, share_with_ancestors: false }],
    [CONTRACT_DOC, { id: CONTRACT_DOC, project_id: PROJECT, scope_type: 'contract', scope_id: PROJECT, kind: 'contract_doc', title: 'C', current_version: 1, share_with_ancestors: false }],
  ]);
  const versions = [
    { document_id: DOC, version_no: 1, storage_key: 'k1', mime: 'application/pdf', size_bytes: 10, sha256: 'b'.repeat(64), change_kind: 'upload' },
    { document_id: DOC, version_no: 2, storage_key: 'k2', mime: 'application/pdf', size_bytes: 20, sha256: SHA, change_kind: 'upload' },
  ];
  const markups = new Map();
  return {
    docs, versions, markups,
    async getPersonByClerkId() { return { id: 'person' }; },
    async getDocument(id) { return docs.get(id) ?? null; },
    async canReadScope({ orgId }) { return orgId === GC || orgId === OWNER; },
    async canEditScope({ orgId }) { return orgId === OWNER; },
    async listVersions(id, cur) { return versions.filter((v) => v.document_id === id && v.version_no <= cur); },
    async getMarkup(id) { return markups.get(id) ?? null; },
    async getMarkupsByIds(ids) { return ids.map((i) => markups.get(i)).filter(Boolean); },
    async listMarkups({ documentId }) { return { items: [...markups.values()].filter((m) => m.document_id === documentId), nextCursor: null }; },
    async saveMarkups({ documentId, baseVersionNo, drafts, actor }) {
      const doc = docs.get(documentId);
      if (doc.current_version !== baseVersionNo) return { conflict: doc.current_version };
      const base = versions.find((v) => v.document_id === documentId && v.version_no === baseVersionNo);
      const next = Math.max(...versions.filter((v) => v.document_id === documentId).map((v) => v.version_no)) + 1;
      versions.push({ ...base, version_no: next, change_kind: 'markup_only', base_version_no: baseVersionNo });
      doc.current_version = next;
      const rows = drafts.map((d) => ({
        id: d.id, document_id: documentId, project_id: PROJECT, version_no: next, page_or_layout: d.pageOrLayout,
        kind: d.kind, geometry: d.geometry, text: d.text, author_person_id: actor.personId, author_org_id: actor.orgId,
        created_at: '2026-10-10T10:00:00Z', state: 'open',
      }));
      for (const r of rows) markups.set(r.id, r);
      return { doc, markups: rows };
    },
    async setMarkupState({ markupId, to }) {
      const m = markups.get(markupId);
      Object.assign(m, { state: to, closed_at: to === 'closed' ? '2026-10-11T00:00:00Z' : null });
      return m;
    },
    async linkMarkup({ markupId, link }) {
      const m = markups.get(markupId);
      if (link.questionId) m.question_id = link.questionId; else m.nonconformity_id = link.nonconformityId;
      return m;
    },
  };
}

const viewer = (orgId) => ({ clerkUserId: 'user', orgId, orgRole: 'manager', channel: 'ui', has: () => true });
const cloud = (id, page = '1') => ({ id, page_or_layout: page, kind: 'cloud', geometry: { points: [[10, 10], [60, 40]] }, text: 'Skylight width' });

describe('markups over an in-memory store', () => {
  let store;
  beforeEach(() => { store = memoryStore(); });

  test('AC3: saving one markup on v2 makes v3 "markups only" with the same sha256', async () => {
    const res = await saveDocumentMarkups({ viewer: viewer(GC), store, documentId: DOC, body: { base_version_no: 2, markups: [cloud(M1)] } });
    assert.equal(res.status, 201);
    assert.equal(res.body.document.current_version, 3);
    const v3 = res.body.document.versions.at(-1);
    assert.equal(v3.change_kind, 'markup_only');
    assert.equal(v3.sha256, SHA);
    assert.equal(v3.base_version_no, 2);
    assert.equal(res.body.markups[0].version_no, 3);
    assert.equal(res.body.markups[0].state, 'open');
  });

  test('a stale base answers 409 version_conflict; a replay answers the saved markups; a reused id 409', async () => {
    await saveDocumentMarkups({ viewer: viewer(GC), store, documentId: DOC, body: { base_version_no: 2, markups: [cloud(M1)] } });
    const replay = await saveDocumentMarkups({ viewer: viewer(GC), store, documentId: DOC, body: { base_version_no: 2, markups: [cloud(M1)] } });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.document.current_version, 3, 'no second version');
    await assert.rejects(
      saveDocumentMarkups({ viewer: viewer(GC), store, documentId: DOC, body: { base_version_no: 2, markups: [cloud(M2)] } }),
      (e) => e.problem?.code === 'version_conflict',
    );
    await assert.rejects(
      saveDocumentMarkups({ viewer: viewer(OWNER), store, documentId: DOC, body: { base_version_no: 3, markups: [cloud(M1, '2')] } }),
      (e) => e.problem?.code === 'idempotency_mismatch',
    );
  });

  test('strangers 404; contract files are not marked up; bad bodies 422', async () => {
    await assert.rejects(listDocumentMarkups({ viewer: viewer(STRANGER), store, documentId: DOC, query: {} }), (e) => e.problem?.code === 'not_found');
    await assert.rejects(
      saveDocumentMarkups({ viewer: viewer(GC), store, documentId: CONTRACT_DOC, body: { base_version_no: 1, markups: [cloud(M1)] } }),
      (e) => e.problem?.code === 'forbidden',
    );
    await assert.rejects(
      saveDocumentMarkups({ viewer: viewer(GC), store, documentId: DOC, body: { base_version_no: 2, markups: [{ ...cloud(M1), kind: 'measure' }] } }),
      (e) => e.problem?.code === 'validation_failed',
    );
  });

  test('close: the author org or an editor of the file; idempotent; re-open', async () => {
    await saveDocumentMarkups({ viewer: viewer(GC), store, documentId: DOC, body: { base_version_no: 2, markups: [cloud(M1)] } });
    const closed = await closeMarkup({ viewer: viewer(OWNER), store, markupId: M1 });
    assert.equal(closed.body.state, 'closed');
    assert.equal((await closeMarkup({ viewer: viewer(GC), store, markupId: M1 })).body.state, 'closed');
    assert.equal((await reopenMarkup({ viewer: viewer(GC), store, markupId: M1 })).body.state, 'open');
    await assert.rejects(closeMarkup({ viewer: viewer(STRANGER), store, markupId: M1 }), (e) => e.problem?.code === 'not_found');
  });

  test('link: the author org, to its own question / issue on the same build (through the ports)', async () => {
    await saveDocumentMarkups({ viewer: viewer(GC), store, documentId: DOC, body: { base_version_no: 2, markups: [cloud(M1)] } });
    const questions = { questionFacts: async (id) => (id === Q ? { id: Q, project_id: PROJECT, author_org_id: GC } : null) };
    const nonconformities = { nonconformityFacts: async (id) => (id === NC ? { id: NC, project_id: PROJECT, raised_by_org_id: OWNER } : null) };
    const linked = await linkMarkup({ viewer: viewer(GC), store, questions, nonconformities, markupId: M1, body: { question_id: Q } });
    assert.equal(linked.body.question_id, Q);
    // Replaying the same link is a no-op.
    assert.equal((await linkMarkup({ viewer: viewer(GC), store, questions, nonconformities, markupId: M1, body: { question_id: Q } })).status, 200);
    // Someone else's issue is refused (422); another org may not link this markup (403).
    await assert.rejects(
      linkMarkup({ viewer: viewer(GC), store, questions, nonconformities, markupId: M1, body: { nonconformity_id: NC } }),
      (e) => e.problem?.code === 'validation_failed',
    );
    await assert.rejects(
      linkMarkup({ viewer: viewer(OWNER), store, questions, nonconformities, markupId: M1, body: { nonconformity_id: NC } }),
      (e) => e.problem?.code === 'forbidden',
    );
  });
});
