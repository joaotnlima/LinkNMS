// PRD-06 drawings over the REAL v2 migrations (throwaway DB). Skipped without
// DATABASE_URL. Proves at the store level:
//   AC3  saving 1 markup on v2 creates v3 labelled markup_only — same storage
//        key and sha256 (the append-only trigger of 0001 lets the INSERT
//        through), current_version advances, the save is ledgered;
//   V-8  close / re-open / link are record-side and ledgered;
//        a stale base answers version_conflict.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createDocumentsStore } from './pg-store.mjs';
import { createInMemoryObjectStorage } from './storage.mjs';
import { createDocument, createDocumentVersion, completeUpload } from '../application/use-cases.mjs';
import {
  listDocumentMarkups, saveDocumentMarkups, closeMarkup, reopenMarkup, linkMarkup,
} from '../application/markups.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the documents Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_documents_drawings_test';

const OWNER_ORG = randomUUID();
const GC_ORG = randomUUID();
const STRANGER_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();

function viewer(orgId) {
  return { clerkUserId: 'user_ana', personId: PERSON, orgId, orgRole: 'admin', channel: 'ui', has: () => true };
}

async function freshDrawingsDb(pg, name) {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${name}`), max: 2 });
  for (const f of readdirSync(join(ROOT, 'db', 'v2')).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
    await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
  }
  await pool.query(
    `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES
       ($1, 'org_owner', 'household', 'Família Silva'), ($2, 'org_gc', 'contractor', 'Douro'),
       ($3, 'org_x', 'contractor', 'Alheia')`,
    [OWNER_ORG, GC_ORG, STRANGER_ORG],
  );
  await pool.query(`INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES ($1, 'user_ana', 'ana@x.pt', 'Ana')`, [PERSON]);
  await pool.query(
    `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code) VALUES ($1, $2, $2, 'Casa', '1306')`,
    [PROJECT, OWNER_ORG],
  );
  await pool.query(
    `INSERT INTO project.participation (project_id, org_id, capacity, source, contract_id) VALUES
       ($1, $2, 'owner', 'project', NULL), ($1, $3, 'prime_contractor', 'project', NULL)`,
    [PROJECT, OWNER_ORG, GC_ORG],
  );
  return { admin, pool };
}



/** Upload a project file through the real use cases (reserve → "PUT" → complete). */
async function uploadFile({ store, storage, orgId, body, documentId = null }) {
  const ticket = documentId
    ? await createDocumentVersion({ viewer: viewer(orgId), store, storage, documentId, body })
    : await createDocument({ viewer: viewer(orgId), store, storage, body });
  const [id, no] = ticket.body.document_version_id.split('.');
  const v = await store.getVersion(id, Number(no));
  storage._objects.set(v.storage_key, { sizeBytes: Number(v.size_bytes), body: Buffer.from('bytes') });
  return completeUpload({ viewer: viewer(orgId), store, storage, versionId: ticket.body.document_version_id });
}

const cloud = (id, page = '1') => ({ id, page_or_layout: page, kind: 'cloud', geometry: { points: [[396, 124], [470, 180]] }, text: 'Skylight width' });

describe('the markup layer over Postgres (PRD-06)', { skip }, () => {
  let admin, pool, store, storage, docId;

  before(async () => {
    const { default: pg } = await import('pg');
    ({ admin, pool } = await freshDrawingsDb(pg, DB));
    store = createDocumentsStore(pool);
    storage = createInMemoryObjectStorage();
    const body = {
      id: randomUUID(), scope_type: 'project', scope_id: PROJECT, kind: 'drawing', title: 'A-301 Roof plan',
      file: { name: 'A-301.pdf', mime: 'application/pdf', size_bytes: 2048, sha256: 'c'.repeat(64) },
    };
    await uploadFile({ store, storage, orgId: GC_ORG, body });
    await uploadFile({
      store, storage, orgId: GC_ORG, documentId: body.id,
      body: { file: { name: 'A-301.pdf', mime: 'application/pdf', size_bytes: 4096, sha256: 'd'.repeat(64) } },
    });
    docId = body.id;
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  test('AC3: one markup on v2 → v3 markup_only, same bytes (storage key + sha256), ledgered', async () => {
    const m = randomUUID();
    const res = await saveDocumentMarkups({
      viewer: viewer(OWNER_ORG), store, documentId: docId, body: { base_version_no: 2, markups: [cloud(m)] },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.document.current_version, 3);
    const { rows: [v2, v3] } = await pool.query(
      'SELECT * FROM documents.document_version WHERE document_id = $1 AND version_no IN (2, 3) ORDER BY version_no', [docId],
    );
    assert.equal(v3.change_kind, 'markup_only');
    assert.equal(v3.base_version_no, 2);
    assert.equal(v3.sha256, v2.sha256, 'the file bytes are unchanged (same sha256)');
    assert.equal(v3.storage_key, v2.storage_key, 'no byte copy');
    const { rows: ledger } = await pool.query(
      "SELECT payload FROM record.audit_event WHERE project_id = $1 AND type = 'documents.markups.saved'", [PROJECT],
    );
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].payload.sha256, v2.sha256);
    assert.deepEqual(ledger[0].payload.markup_ids, [m]);
    const { rows: outbox } = await pool.query("SELECT 1 FROM platform.outbox WHERE data->>'version_no' = '3'");
    assert.equal(outbox.length, 0, 'a markups-only version publishes no "new version" event');

    const listed = await listDocumentMarkups({ viewer: viewer(GC_ORG), store, documentId: docId, query: {} });
    assert.deepEqual(listed.body.items.map((x) => [x.id, x.version_no, x.page_or_layout, x.state]), [[m, 3, '1', 'open']]);
    await assert.rejects(
      listDocumentMarkups({ viewer: viewer(STRANGER_ORG), store, documentId: docId, query: {} }),
      (e) => e.problem?.code === 'not_found',
    );
  });

  test('a stale base answers version_conflict and writes nothing', async () => {
    const before = await store.getDocument(docId);
    await assert.rejects(
      saveDocumentMarkups({ viewer: viewer(GC_ORG), store, documentId: docId, body: { base_version_no: 2, markups: [cloud(randomUUID())] } }),
      (e) => e.problem?.code === 'version_conflict',
    );
    assert.equal((await store.getDocument(docId)).current_version, before.current_version);
  });

  test('V-8: close, re-open and link are record-side (no new version) and ledgered', async () => {
    const m = randomUUID();
    const cur = (await store.getDocument(docId)).current_version;
    await saveDocumentMarkups({ viewer: viewer(GC_ORG), store, documentId: docId, body: { base_version_no: cur, markups: [cloud(m, '2')] } });
    const after = (await store.getDocument(docId)).current_version;

    const closed = await closeMarkup({ viewer: viewer(GC_ORG), store, markupId: m });
    assert.equal(closed.body.state, 'closed');
    assert.ok(closed.body.closed_at);
    assert.equal((await reopenMarkup({ viewer: viewer(OWNER_ORG), store, markupId: m })).body.state, 'open');

    const q = randomUUID();
    const questions = { questionFacts: async (id) => (id === q ? { id: q, project_id: PROJECT, author_org_id: GC_ORG } : null) };
    const linked = await linkMarkup({ viewer: viewer(GC_ORG), store, questions, markupId: m, body: { question_id: q } });
    assert.equal(linked.body.question_id, q);
    assert.equal((await store.getDocument(docId)).current_version, after, 'state and links write no version');

    const { rows } = await pool.query(
      `SELECT type FROM record.audit_event WHERE project_id = $1 AND object_id = $2 ORDER BY seq`, [PROJECT, m],
    );
    assert.deepEqual(rows.map((r) => r.type), ['documents.markup.closed', 'documents.markup.reopened', 'documents.markup.linked']);
  });

  test('the DB pins the markups-only shape: no markup_only version without its base', async () => {
    await assert.rejects(pool.query(
      `INSERT INTO documents.document_version (document_id, version_no, storage_key, mime, size_bytes, sha256,
         uploaded_by_person_id, uploaded_by_org_id, change_kind)
       VALUES ($1, 99, 'k', 'application/pdf', 1, $2, $3, $4, 'markup_only')`,
      [docId, 'e'.repeat(64), PERSON, GC_ORG],
    ), /document_version_markup_only_base/);
  });
});
