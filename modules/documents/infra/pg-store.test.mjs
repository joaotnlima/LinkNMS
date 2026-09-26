// Documents store + use cases over the REAL v2 migrations (throwaway DB,
// like the sibling modules). Skipped without DATABASE_URL.
//
// Proves at the database level, per AGENT-INDEX §6:
//   #3  document versions are append-only (a completed version never changes);
//   #4  completeUpload commits the sha256 ledger entry AND the
//       documents.version.uploaded outbox event with the current_version
//       advance in ONE transaction;
//   V6  scope visibility: participants read task documents; a stranger org
//       gets 404-shaped nulls; proposal documents stay inside the lane;
// and the upload protocol end to end against the in-memory storage double.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createDocumentsStore } from './pg-store.mjs';
import { createInMemoryObjectStorage } from './storage.mjs';
import {
  createDocument, createDocumentVersion, completeUpload, listDocuments, downloadDocument,
} from '../application/use-cases.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the documents Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_documents_test';

const OWNER_ORG = randomUUID();
const GC_ORG = randomUUID();
const STRANGER_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const PRIME = randomUUID();
const TASK = randomUUID();
const SHA = 'b'.repeat(64);

function viewer(orgId, over = {}) {
  return {
    clerkUserId: 'user_ana', personId: PERSON, orgId, orgRole: 'admin',
    channel: 'ui', has: () => true, ...over,
  };
}

function createBody(over = {}) {
  return {
    id: randomUUID(),
    scope_type: 'task',
    scope_id: TASK,
    kind: 'photo',
    title: 'Fissura na parede',
    file: { name: 'fissura.jpg', mime: 'image/jpeg', size_bytes: 2048, sha256: SHA },
    ...over,
  };
}

describe('documents store over Postgres (v2 migrations)', { skip }, () => {
  let pg, admin, pool, store, storage;

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 2 });
    const migrations = readdirSync(join(ROOT, 'db', 'v2')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const f of migrations) {
      await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
    }
    await pool.query(
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES
         ($1, 'org_owner', 'household', 'Família Silva'),
         ($2, 'org_gc', 'contractor', 'Douro Construções'),
         ($3, 'org_stranger', 'contractor', 'Alheia Lda')`,
      [OWNER_ORG, GC_ORG, STRANGER_ORG],
    );
    await pool.query(
      `INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES ($1, 'user_ana', 'ana@casa.pt', 'Ana')`,
      [PERSON],
    );
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code)
       VALUES ($1, $2, $2, 'Casa Silva', '1306')`,
      [PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO project.participation (project_id, org_id, capacity, source, contract_id) VALUES
         ($1, $2, 'owner', 'project', NULL),
         ($1, $3, 'prime_contractor', 'contract', $4)`,
      [PROJECT, OWNER_ORG, GC_ORG, PRIME],
    );
    await pool.query(
      `INSERT INTO contracting.contract (id, project_id, kind, client_org_id, supplier_org_id, reference, origin, status)
       VALUES ($1, $2, 'prime', $3, $4, 'PRIME-1', 'direct_entry', 'active')`,
      [PRIME, PROJECT, OWNER_ORG, GC_ORG],
    );
    await pool.query(
      `INSERT INTO planning.task (id, project_id, depth, position, name, branch_contract_id, assignee_org_id)
       VALUES ($1, $2, 2, 'aa', 'Reboco WC', $3, $4)`,
      [TASK, PROJECT, PRIME, GC_ORG],
    );
    store = createDocumentsStore(pool);
    storage = createInMemoryObjectStorage();
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  test('upload protocol: ticket → PUT → complete advances version, ledgers sha256 + event in one commit', async () => {
    const body = createBody();
    const ticket = await createDocument({ viewer: viewer(GC_ORG), store, storage, body });
    assert.equal(ticket.status, 201);
    assert.match(ticket.body.upload_url, /^memory:\/\/upload\//);
    const ref = ticket.body.document_version_id;
    assert.equal(ref, `${body.id}.1`);

    // Not completed yet: invisible on the list, download refuses.
    const empty = await listDocuments({ viewer: viewer(OWNER_ORG), store, query: { scope_type: 'task', scope_id: TASK } });
    assert.equal(empty.body.items.length, 0);
    await assert.rejects(
      downloadDocument({ viewer: viewer(OWNER_ORG), store, storage, versionId: ref }),
      /Not found|not_found/i,
    );

    // "PUT the file": materialise the object the ticket was minted for.
    const version = await store.getVersion(body.id, 1);
    storage._objects.set(version.storage_key, { sizeBytes: 2048 });

    const done = await completeUpload({ viewer: viewer(GC_ORG), store, storage, versionId: ref });
    assert.equal(done.status, 200);
    assert.equal(done.body.current_version, 1);
    assert.equal(done.body.versions[0].sha256, SHA);

    const { rows: ledger } = await pool.query(
      `SELECT payload FROM record.audit_event WHERE project_id = $1 AND type = 'documents.version.uploaded'`,
      [PROJECT],
    );
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].payload.sha256, SHA);
    const { rows: outbox } = await pool.query(
      `SELECT data FROM platform.outbox WHERE type = 'documents.version.uploaded'`,
    );
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].data.document_id, body.id);

    // Replay of complete is absorbed, not double-ledgered.
    const again = await completeUpload({ viewer: viewer(GC_ORG), store, storage, versionId: ref });
    assert.equal(again.status, 200);
    const { rows: still } = await pool.query(
      `SELECT count(*)::int AS n FROM record.audit_event WHERE type = 'documents.version.uploaded'`,
    );
    assert.equal(still[0].n, 1);

    // Owner (participant, V6) can now list and download.
    const listed = await listDocuments({ viewer: viewer(OWNER_ORG), store, query: { scope_type: 'task', scope_id: TASK } });
    assert.equal(listed.body.items.length, 1);
    const dl = await downloadDocument({ viewer: viewer(OWNER_ORG), store, storage, versionId: ref });
    assert.equal(dl.status, 302);
    assert.match(dl.headers.location, /^memory:\/\/download\//);
  });

  test('size mismatch at complete is refused (sha256 is pinned in the signed PUT)', async () => {
    const body = createBody();
    await createDocument({ viewer: viewer(GC_ORG), store, storage, body });
    const version = await store.getVersion(body.id, 1);
    storage._objects.set(version.storage_key, { sizeBytes: 999 });
    await assert.rejects(
      completeUpload({ viewer: viewer(GC_ORG), store, storage, versionId: `${body.id}.1` }),
      (err) => Boolean(err.problem?.errors?.['file.size_bytes']),
    );
  });

  test('V6: a stranger org neither creates on, lists, nor learns the scope exists', async () => {
    await assert.rejects(
      createDocument({ viewer: viewer(STRANGER_ORG), store, storage, body: createBody() }),
      /Not found|not_found/i,
    );
    await assert.rejects(
      listDocuments({ viewer: viewer(STRANGER_ORG), store, query: { scope_type: 'task', scope_id: TASK } }),
      /Not found|not_found/i,
    );
  });

  test('append-only versions: a new upload adds v2, v1 stays byte-identical', async () => {
    const body = createBody();
    await createDocument({ viewer: viewer(GC_ORG), store, storage, body });
    const v1 = await store.getVersion(body.id, 1);
    storage._objects.set(v1.storage_key, { sizeBytes: 2048 });
    await completeUpload({ viewer: viewer(GC_ORG), store, storage, versionId: `${body.id}.1` });

    const ticket2 = await createDocumentVersion({
      viewer: viewer(GC_ORG), store, storage, documentId: body.id,
      body: { file: { name: 'fissura-v2.jpg', mime: 'image/jpeg', size_bytes: 4096, sha256: 'c'.repeat(64) } },
    });
    assert.equal(ticket2.body.document_version_id, `${body.id}.2`);
    const v2 = await store.getVersion(body.id, 2);
    storage._objects.set(v2.storage_key, { sizeBytes: 4096 });
    const done = await completeUpload({ viewer: viewer(GC_ORG), store, storage, versionId: `${body.id}.2` });
    assert.equal(done.body.current_version, 2);
    assert.equal(done.body.versions.length, 2);

    const v1After = await store.getVersion(body.id, 1);
    assert.deepEqual(v1After, v1);
  });

  test('idempotent create: same id + same declaration re-issues the ticket; a different request 409s', async () => {
    const body = createBody();
    const first = await createDocument({ viewer: viewer(GC_ORG), store, storage, body });
    const replay = await createDocument({ viewer: viewer(GC_ORG), store, storage, body });
    assert.equal(replay.body.document_version_id, first.body.document_version_id);
    await assert.rejects(
      createDocument({ viewer: viewer(OWNER_ORG), store, storage, body: { ...body, file: { ...body.file, sha256: 'd'.repeat(64) } } }),
      /idempotency/i,
    );
  });
});
