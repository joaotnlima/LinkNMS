// PRD-05 task files over the REAL v2 migrations (throwaway DB). Skipped
// without DATABASE_URL. Proves the acceptance criteria at the store level:
//   AC1  uploading from task 2.5 creates ONE project document linked to 2.5;
//        linking it from 2.5.1 adds a link, not a copy; a v2 upload shows as
//        v2 on both tasks;
//   F-10 "also on sub-tasks" links every current sub-task (inherited) and is
//        removable per sub-task;
//   F-7  a DWG starts `pending`; F-11 the uploaded event names the linking
//        tasks; F-19 the project list filters by title and type, newest first;
//   V6   a stranger neither lists nor links; contract files are never linkable.
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
  listTaskDocuments, linkTaskDocuments, unlinkTaskDocument, listProjectDocuments,
} from '../application/task-files.mjs';
import { createDocumentsPort } from '../application/port.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the documents Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_documents_files_test';

const OWNER_ORG = randomUUID();
const GC_ORG = randomUUID();
const STRANGER_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const PRIME = randomUUID();
const ROOF = randomUUID(); // 2.5
const PREP = randomUUID(); // 2.5.1
const COVER = randomUUID(); // 2.5.2

function viewer(orgId) {
  return { clerkUserId: 'user_ana', personId: PERSON, orgId, orgRole: 'admin', channel: 'ui', has: () => true };
}

const planning = { descendantIds: async (id) => (id === ROOF ? [PREP, COVER] : []) };

describe('task files over Postgres (PRD-05)', { skip }, () => {
  let pg, admin, pool, store, storage;

  async function upload(orgId, body) {
    const ticket = await createDocument({ viewer: viewer(orgId), store, storage, body, planning });
    const [id, no] = ticket.body.document_version_id.split('.');
    const v = await store.getVersion(id, Number(no));
    storage._objects.set(v.storage_key, { sizeBytes: Number(v.size_bytes) });
    return completeUpload({ viewer: viewer(orgId), store, storage, versionId: ticket.body.document_version_id });
  }

  function projectFile(over = {}) {
    return {
      id: randomUUID(), scope_type: 'project', scope_id: PROJECT, kind: 'drawing', title: 'A-301 Roof plan',
      file: { name: 'A-301.pdf', mime: 'application/pdf', size_bytes: 2048, sha256: 'c'.repeat(64) },
      ...over,
    };
  }

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 2 });
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
         ($1, $2, 'owner', 'project', NULL), ($1, $3, 'prime_contractor', 'contract', $4)`,
      [PROJECT, OWNER_ORG, GC_ORG, PRIME],
    );
    await pool.query(
      `INSERT INTO contracting.contract (id, project_id, kind, client_org_id, supplier_org_id, reference, origin, status)
       VALUES ($1, $2, 'prime', $3, $4, 'P-1', 'direct_entry', 'active')`,
      [PRIME, PROJECT, OWNER_ORG, GC_ORG],
    );
    await pool.query(
      `INSERT INTO planning.task (id, project_id, parent_id, depth, position, name, branch_contract_id, assignee_org_id) VALUES
         ($1, $4, NULL, 1, 'a', 'Roofing', $5, $6),
         ($2, $4, $1, 2, 'a', 'Structure prep', $5, $6),
         ($3, $4, $1, 2, 'b', 'Covering', $5, $6)`,
      [ROOF, PREP, COVER, PROJECT, PRIME, GC_ORG],
    );
    store = createDocumentsStore(pool);
    storage = createInMemoryObjectStorage();
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  test('AC1: one project document linked to 2.5, linked (not copied) from 2.5.1, v2 shows on both', async () => {
    const body = projectFile({ link: { task_id: ROOF, role: 'reference' } });
    const done = await upload(GC_ORG, body);
    assert.equal(done.body.scope_type, 'project');
    assert.equal(done.body.file_type, 'pdf');

    const onRoof = await listTaskDocuments({ viewer: viewer(OWNER_ORG), store, taskId: ROOF });
    assert.deepEqual(onRoof.body.items.map((d) => [d.id, d.role, d.attached]), [[body.id, 'reference', false]]);

    const linked = await linkTaskDocuments({ viewer: viewer(GC_ORG), store, planning, taskId: PREP, body: { document_ids: [body.id] } });
    assert.equal(linked.body.items[0].id, body.id);
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM documents.document WHERE project_id = $1', [PROJECT]);
    assert.equal(n, 1, 'a link, never a copy');

    const t2 = await createDocumentVersion({
      viewer: viewer(GC_ORG), store, storage, documentId: body.id,
      body: { file: { name: 'A-301.pdf', mime: 'application/pdf', size_bytes: 4096, sha256: 'd'.repeat(64) }, note: 'Gutter moved' },
    });
    const v2 = await store.getVersion(body.id, 2);
    storage._objects.set(v2.storage_key, { sizeBytes: 4096 });
    await completeUpload({ viewer: viewer(GC_ORG), store, storage, versionId: t2.body.document_version_id });

    for (const taskId of [ROOF, PREP]) {
      const files = await listTaskDocuments({ viewer: viewer(OWNER_ORG), store, taskId });
      const doc = files.body.items.find((d) => d.id === body.id);
      assert.equal(doc.current_version, 2);
      assert.equal(doc.versions[1].note, 'Gutter moved');
      assert.deepEqual(doc.used_on.map((u) => u.task_id).sort(), [ROOF, PREP].sort());
    }
    const { rows: events } = await pool.query(
      `SELECT data FROM platform.outbox WHERE type = 'documents.version.uploaded' AND data->>'document_id' = $1 ORDER BY (data->>'version_no')::int`,
      [body.id],
    );
    assert.equal(events.length, 2);
    assert.deepEqual(events[1].data.linked_task_ids.sort(), [ROOF, PREP].sort());
    assert.equal(events[1].data.note, 'Gutter moved');
  });

  test('F-10: also on sub-tasks — inherited, removable per sub-task', async () => {
    const body = projectFile({ title: 'roof-details', file: { name: 'roof-details.dwg', mime: 'application/octet-stream', size_bytes: 10, sha256: 'e'.repeat(64) } });
    const done = await upload(GC_ORG, body);
    assert.equal(done.body.preview_status, 'pending', 'a DWG waits for its preview (F-7)');
    assert.equal(done.body.file_type, 'dwg');

    await linkTaskDocuments({ viewer: viewer(OWNER_ORG), store, planning, taskId: ROOF, body: { document_ids: [body.id], include_subtasks: true } });
    const onCover = await listTaskDocuments({ viewer: viewer(GC_ORG), store, taskId: COVER });
    const inherited = onCover.body.items.find((d) => d.id === body.id);
    assert.equal(inherited.inherited, true);
    assert.equal(inherited.inherited_from_task_id, ROOF);

    const res = await unlinkTaskDocument({ viewer: viewer(GC_ORG), store, taskId: COVER, documentId: body.id });
    assert.equal(res.status, 204);
    const after = await listTaskDocuments({ viewer: viewer(GC_ORG), store, taskId: COVER });
    assert.equal(after.body.items.some((d) => d.id === body.id), false);
    const onRoof = await listTaskDocuments({ viewer: viewer(GC_ORG), store, taskId: ROOF });
    assert.ok(onRoof.body.items.some((d) => d.id === body.id), 'the parent keeps its link');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM record.audit_event WHERE type = 'documents.link.removed'`);
    assert.equal(rows[0].n, 1);
  });

  test('F-19 / F-9: the project list searches by title and filters by type, newest first', async () => {
    const all = await listProjectDocuments({ viewer: viewer(OWNER_ORG), store, projectId: PROJECT, query: {} });
    assert.ok(all.body.items.length >= 2);
    const ids = all.body.items.map((d) => d.id);
    assert.deepEqual([...ids].sort().reverse(), ids, 'newest first');
    const dwg = await listProjectDocuments({ viewer: viewer(OWNER_ORG), store, projectId: PROJECT, query: { type: 'dwg' } });
    assert.deepEqual(dwg.body.items.map((d) => d.file_type), ['dwg']);
    const search = await listProjectDocuments({ viewer: viewer(OWNER_ORG), store, projectId: PROJECT, query: { q: 'a-301' } });
    assert.deepEqual(search.body.items.map((d) => d.title), ['A-301 Roof plan']);
    assert.ok(search.body.items[0].used_on.length >= 2);
    await assert.rejects(
      listProjectDocuments({ viewer: viewer(OWNER_ORG), store, projectId: PROJECT, query: { type: 'docx' } }),
      (err) => Boolean(err.problem?.errors?.type),
    );
  });

  test('V6: strangers neither list nor link; contract files are never linkable', async () => {
    await assert.rejects(listTaskDocuments({ viewer: viewer(STRANGER_ORG), store, taskId: ROOF }), /not_found|Not found/i);
    await assert.rejects(
      listProjectDocuments({ viewer: viewer(STRANGER_ORG), store, projectId: PROJECT, query: {} }), /not_found|Not found/i,
    );
    const contractDoc = projectFile({ scope_type: 'contract', scope_id: PRIME, title: 'Contract annex' });
    await upload(GC_ORG, contractDoc);
    await assert.rejects(
      linkTaskDocuments({ viewer: viewer(GC_ORG), store, planning, taskId: ROOF, body: { document_ids: [contractDoc.id] } }),
      (err) => Boolean(err.problem?.errors?.document_ids),
    );
  });

  test('the documents port answers proven project-file versions only', async () => {
    const body = projectFile({ title: 'Calc report' });
    await upload(GC_ORG, body);
    const port = createDocumentsPort(store);
    const facts = await port.versionFacts({ documentId: body.id, orgId: OWNER_ORG });
    assert.equal(facts.version_no, 1);
    assert.equal(facts.sha256, 'c'.repeat(64));
    assert.equal(facts.file_type, 'pdf');
    assert.equal(facts.kind, body.kind); // PRD-10 E-8: the daily log binds kind = photo only
    assert.equal(await port.versionFacts({ documentId: body.id, versionNo: 2, orgId: OWNER_ORG }), null);
    assert.equal(await port.versionFacts({ documentId: body.id, orgId: STRANGER_ORG }), null);
  });
});
