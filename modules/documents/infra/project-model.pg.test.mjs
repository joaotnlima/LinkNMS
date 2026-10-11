// PRD-07 shared project model over the REAL v2 migrations (throwaway DB).
// Skipped without DATABASE_URL. Proves at the store + use-case level:
//   AC1  every participant reads /projects/{id}/model; a stranger gets 404;
//   AC2  the awarded roofer links / pins only elements already on its rows —
//        the server refuses any other GlobalId (out_of_scope);
//   AC3  two drafts on the same base with disjoint elements both save (v_n+1,
//        v_n+2); an overlap answers version_conflict with the elements;
//   AC4  Restore v2 creates a new version equal to v2 (bytes + links); later
//        versions stay;
//   AC5  a re-upload keeps every link and issue (GlobalId-keyed);
//   M-9  only the author uploads a new .ifc; an edit version re-points the
//        current bytes; `documents.model.edited` is ledgered + on the outbox.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createDocumentsStore } from './pg-store.mjs';
import { createInMemoryObjectStorage } from './storage.mjs';
import { completeUpload, createDocumentVersion } from '../application/use-cases.mjs';
import {
  getProjectModel, reserveProjectModelVersion, saveModelEdits, restoreProjectModel, compareModelRecord, getTaskModel,
} from '../application/project-model.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the documents Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_documents_model_test';

const OWNER = randomUUID();
const ARCH = randomUUID();
const ROOF = randomUUID();
const STRANGER = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const T_ROOF = randomUUID();
const T_TILES = randomUUID();
const T_FRAME = randomUUID();
const g = (n) => `${String(n).padStart(3, '0')}Fr$t4X7Zf8NOew3FLO_`.slice(0, 22);

function viewer(orgId) {
  return { clerkUserId: 'user_ana', personId: PERSON, orgId, orgRole: 'admin', channel: 'ui', has: () => true };
}

// The planning task port, as planning answers it for this plan (its own
// domain + pg tests prove modelScopes over real rows).
const planning = {
  async modelScopes() {
    return {
      owner_org_id: OWNER,
      tasks: [
        { id: T_ROOF, code: '2.5', name: 'Roofing', parent_id: null, status: 'in_progress', assignee_org_id: ROOF, assignee_org_name: 'Telhados' },
        { id: T_TILES, code: '2.5.1', name: 'Tiles', parent_id: T_ROOF, status: 'not_started', assignee_org_id: ROOF, assignee_org_name: 'Telhados' },
        { id: T_FRAME, code: '2.3', name: 'Frame', parent_id: null, status: 'not_started', assignee_org_id: null, assignee_org_name: null },
      ],
      editors: [{ org_id: ROOF, org_name: 'Telhados', task_ids: [T_ROOF, T_TILES] }],
    };
  },
};

async function freshDb(pg) {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`CREATE DATABASE ${DB}`);
  const pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 3 });
  for (const f of readdirSync(join(ROOT, 'db', 'v2')).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
    await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
  }
  await pool.query(
    `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES
       ($1, 'org_o', 'household', 'Silva'), ($2, 'org_a', 'contractor', 'Atelier Sousa'),
       ($3, 'org_r', 'contractor', 'Telhados'), ($4, 'org_x', 'contractor', 'Alheia')`,
    [OWNER, ARCH, ROOF, STRANGER],
  );
  await pool.query(`INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES ($1, 'user_ana', 'ana@x.pt', 'Ana')`, [PERSON]);
  await pool.query(
    `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code) VALUES ($1, $2, $2, 'Casa', '1306')`,
    [PROJECT, OWNER],
  );
  await pool.query(
    `INSERT INTO project.participation (project_id, org_id, capacity, source, contract_id) VALUES
       ($1, $2, 'owner', 'project', NULL), ($1, $3, 'consultant', 'project', NULL), ($1, $4, 'subcontractor', 'project', NULL)`,
    [PROJECT, OWNER, ARCH, ROOF],
  );
  await pool.query(
    `INSERT INTO planning.task (id, project_id, parent_id, depth, position, name, assignee_org_id) VALUES
       ($1, $4, NULL, 1, 'b', 'Roofing', $5), ($2, $4, $1, 2, 'a', 'Tiles', NULL), ($3, $4, NULL, 1, 'a', 'Frame', NULL)`,
    [T_ROOF, T_TILES, T_FRAME, PROJECT, ROOF],
  );
  return { admin, pool };
}

async function upload({ store, storage, orgId, sha, note }) {
  const ticket = await reserveProjectModelVersion({
    viewer: viewer(orgId), store, storage, projectId: PROJECT,
    body: { file: { name: 'casa.ifc', mime: 'application/octet-stream', size_bytes: 1000, sha256: sha.repeat(64) }, note },
  });
  const [id, no] = ticket.body.document_version_id.split('.');
  const v = await store.getVersion(id, Number(no));
  storage._objects.set(v.storage_key, { sizeBytes: 1000, body: Buffer.from('ifc') });
  return completeUpload({ viewer: viewer(orgId), store, storage, versionId: ticket.body.document_version_id });
}

const save = (store, orgId, body) => saveModelEdits({ viewer: viewer(orgId), store, planning, projectId: PROJECT, body });

describe('the shared project model over Postgres (PRD-07)', { skip }, () => {
  let admin, pool, store, storage, docId;

  before(async () => {
    const { default: pg } = await import('pg');
    ({ admin, pool } = await freshDb(pg));
    store = createDocumentsStore(pool);
    storage = createInMemoryObjectStorage();
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  test('the first upload makes the build\'s model; its uploader is the author; only the author uploads again', async () => {
    const empty = await getProjectModel({ viewer: viewer(ROOF), store, planning, projectId: PROJECT });
    assert.equal(empty.body.document, null);
    const v1 = await upload({ store, storage, orgId: ARCH, sha: 'a', note: 'Rev A' });
    docId = v1.body.id;
    assert.equal(v1.body.scope_type, 'project');
    assert.equal(v1.body.kind, 'bim');
    await assert.rejects(upload({ store, storage, orgId: OWNER, sha: 'b' }), (e) => e.problem.code === 'forbidden');
    await assert.rejects(createDocumentVersion({
      viewer: viewer(ROOF), store, storage, documentId: docId,
      body: { file: { name: 'x.ifc', mime: 'application/x-step', size_bytes: 10, sha256: 'e'.repeat(64) } },
    }), (e) => e.problem.code === 'forbidden', 'the generic version route honours M-9 too');
    const v2 = await upload({ store, storage, orgId: ARCH, sha: 'b', note: 'Rev B' });
    assert.equal(v2.body.current_version, 2);
  });

  test('AC1: every participant reads it; a stranger does not learn it exists', async () => {
    const read = await getProjectModel({ viewer: viewer(ROOF), store, planning, projectId: PROJECT });
    assert.equal(read.body.document.id, docId);
    assert.equal(read.body.author_org_id, ARCH);
    assert.equal(read.body.viewer.can_upload, false);
    assert.equal(read.body.viewer.scope.kind, 'tasks');
    await assert.rejects(getProjectModel({ viewer: viewer(STRANGER), store, planning, projectId: PROJECT }),
      (e) => e.problem.code === 'not_found');
  });

  test('the owner links elements to tasks — a record edit is version 3 re-pointing v2\'s bytes, ledgered and published', async () => {
    const res = await save(store, OWNER, {
      base_version_no: 2, note: 'Link the roof',
      changes: [
        { op: 'link', global_id: g(1), task_id: T_ROOF }, { op: 'link', global_id: g(2), task_id: T_ROOF },
        { op: 'link', global_id: g(3), task_id: T_FRAME },
      ],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.version_no, 3);
    assert.equal(res.body.edited_by_author, false);
    const { rows: [v2, v3] } = await pool.query(
      'SELECT * FROM documents.document_version WHERE document_id = $1 AND version_no IN (2, 3) ORDER BY version_no', [docId],
    );
    assert.equal(v3.change_kind, 'edit');
    assert.equal(v3.base_version_no, 2);
    assert.equal(v3.storage_key, v2.storage_key, 'D-45: nothing is written into the IFC');
    const { rows: [evt] } = await pool.query("SELECT data FROM platform.outbox WHERE type = 'documents.model.edited'");
    assert.equal(evt.data.author_org_id, ARCH);
    assert.equal(evt.data.edited_by_author, false);
    assert.deepEqual(evt.data.task_ids, [T_FRAME, T_ROOF].sort());
    const { rows: ledger } = await pool.query("SELECT 1 FROM record.audit_event WHERE type = 'documents.model.edited'");
    assert.equal(ledger.length, 1);
  });

  test('AC2: the roofer links and pins only elements already on its rows', async () => {
    await assert.rejects(save(store, ROOF, {
      base_version_no: 3, note: 'n', changes: [{ op: 'link', global_id: g(3), task_id: T_TILES }],
    }), (e) => e.problem.code === 'out_of_scope' && e.problem.refused[0].change_index === 0);
    await assert.rejects(save(store, ROOF, {
      base_version_no: 3, note: 'n', changes: [{ op: 'link', global_id: g(1), task_id: T_FRAME }],
    }), (e) => e.problem.code === 'out_of_scope');
    await assert.rejects(save(store, STRANGER, { base_version_no: 3, note: 'n', changes: [{ op: 'link', global_id: g(1), task_id: T_TILES }] }),
      (e) => e.problem.code === 'not_found');
    const ok = await save(store, ROOF, {
      base_version_no: 3, note: 'Tiles',
      changes: [{ op: 'link', global_id: g(1), task_id: T_TILES },
        { op: 'pin', pin: { id: randomUUID(), global_ids: [g(2)], task_ids: [T_ROOF, T_FRAME], text: 'Ridge clash' } }],
    });
    assert.equal(ok.body.version_no, 4);
    const card = await getTaskModel({ viewer: viewer(ROOF), store, planning, taskId: T_TILES });
    assert.deepEqual([card.body.model.element_count, card.body.model.can_edit], [1, true]);
    const frameCard = await getTaskModel({ viewer: viewer(ROOF), store, planning, taskId: T_FRAME });
    assert.equal(frameCard.body.model.can_edit, false);
  });

  test('AC3: drafts on the same base merge per element; an overlap asks element by element', async () => {
    // Both drafts start on v4.
    const a = await save(store, OWNER, { base_version_no: 4, note: 'A', changes: [{ op: 'link', global_id: g(5), task_id: T_FRAME }] });
    const b = await save(store, ARCH, { base_version_no: 4, note: 'B', changes: [{ op: 'link', global_id: g(6), task_id: T_FRAME }] });
    assert.deepEqual([a.body.version_no, b.body.version_no], [5, 6], 'disjoint drafts both save, no loss');
    await assert.rejects(
      save(store, ARCH, { base_version_no: 4, note: 'C', changes: [{ op: 'unlink', global_id: g(5), task_id: T_FRAME }] }),
      (e) => e.problem.code === 'version_conflict' && e.problem.conflicts[0].global_id === g(5) && e.problem.conflicts[0].version === 5,
    );
    const mine = await save(store, ARCH, {
      base_version_no: 4, note: 'C', changes: [{ op: 'unlink', global_id: g(5), task_id: T_FRAME }], resolutions: { [g(5)]: 'mine' },
    });
    assert.equal(mine.body.version_no, 7);
    const now = await getProjectModel({ viewer: viewer(OWNER), store, planning, projectId: PROJECT });
    assert.deepEqual(now.body.links.map((l) => l.global_id).sort(), [g(1), g(1), g(2), g(3), g(6)].sort());
  });

  test('AC4: Restore v3 creates v8 equal to v3; v4..v7 stay', async () => {
    await assert.rejects(restoreProjectModel({ viewer: viewer(ROOF), store, planning, projectId: PROJECT, body: { version_no: 3 } }),
      (e) => e.problem.code === 'forbidden');
    const key = randomUUID();
    const r = await restoreProjectModel({ viewer: viewer(ARCH), store, planning, projectId: PROJECT, body: { version_no: 3 }, idempotencyKey: key });
    assert.equal(r.body.version_no, 8);
    // Idempotency-Key replay (audit B1): the original answer, no v9.
    const again = await restoreProjectModel({ viewer: viewer(ARCH), store, planning, projectId: PROJECT, body: { version_no: 3 }, idempotencyKey: key });
    assert.deepEqual([again.status, again.body.version_no, again.replayed], [201, 8, true]);
    const { rows: [{ n }] } = await pool.query('SELECT max(version_no)::int AS n FROM documents.document_version WHERE document_id = $1', [docId]);
    assert.equal(n, 8);
    const { rows: [v3, v8] } = await pool.query(
      'SELECT * FROM documents.document_version WHERE document_id = $1 AND version_no IN (3, 8) ORDER BY version_no', [docId],
    );
    assert.equal(v8.sha256, v3.sha256);
    assert.equal(v8.change_kind, 'restore');
    assert.equal(v8.base_version_no, 3);
    const at3 = await getProjectModel({ viewer: viewer(OWNER), store, planning, projectId: PROJECT, query: { version: '3' } });
    const at8 = await getProjectModel({ viewer: viewer(OWNER), store, planning, projectId: PROJECT });
    const pairs = (b) => b.links.map((l) => `${l.global_id}|${l.task_id}`).sort();
    assert.deepEqual(pairs(at8.body), pairs(at3.body));
    assert.equal(at8.body.pins.length, 1, 'issues stay on the record');
    const diff = await compareModelRecord({ viewer: viewer(ROOF), store, projectId: PROJECT, query: { from: '3', to: '7' } });
    assert.deepEqual(diff.body.links_added.map((l) => l.global_id).sort(), [g(1), g(6)].sort());
    assert.equal(diff.body.pins_added.length, 1);
  });

  test('AC5: a re-upload keeps every link and issue', async () => {
    const before = await getProjectModel({ viewer: viewer(OWNER), store, planning, projectId: PROJECT });
    const v9 = await upload({ store, storage, orgId: ARCH, sha: 'c', note: 'Rev C' });
    assert.equal(v9.body.current_version, 9);
    const after = await getProjectModel({ viewer: viewer(OWNER), store, planning, projectId: PROJECT });
    assert.equal(after.body.links.length, before.body.links.length);
    assert.equal(after.body.pins.length, 1);
    assert.equal(after.body.document.versions.at(-1).change_kind, 'upload');
  });
});
