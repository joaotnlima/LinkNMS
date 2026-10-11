// Migrations 0018_tendering_rfp_model + 0019_documents_project_model over real
// data (PRD-07 §5: "Migrate existing RFP models"; split per module, audit S3).
// Applies every migration before them, writes two LINA-409 RFP models on one
// build (and a soft-deleted one elsewhere), then applies the pair and proves: each
// RFP references its own model document; the models are now the BUILD's
// (project scope); exactly one per build is THE project model (the oldest
// referenced one); the byte ledger (document_version) is untouched.
// Skipped without DATABASE_URL.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the tendering Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_tendering_model_migration_test';

const ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const RFP_A = randomUUID();
const RFP_B = randomUUID();
const RFP_C = randomUUID();
const DOC_A = randomUUID();
const DOC_B = randomUUID();
const DOC_GONE = randomUUID();

describe('0018/0019 move RFP models to the build (PRD-07)', { skip }, () => {
  let admin, pool;

  before(async () => {
    const { default: pg } = await import('pg');
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 2 });
    const files = readdirSync(join(ROOT, 'db', 'v2')).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
    const pair = ['0018_tendering_rfp_model.sql', '0019_documents_project_model.sql'];
    for (const f of files.filter((n) => n < pair[0])) await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));

    await pool.query(`INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES ($1, 'org_o', 'household', 'Silva')`, [ORG]);
    await pool.query(`INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES ($1, 'u', 'a@x.pt', 'Ana')`, [PERSON]);
    await pool.query(`INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code) VALUES ($1, $2, $2, 'Casa', '1306')`, [PROJECT, ORG]);
    for (const id of [RFP_A, RFP_B, RFP_C]) {
      await pool.query(
        `INSERT INTO tendering.rfp (id, project_id, issuer_org_id, level, title, submission_deadline)
         VALUES ($1, $2, $3, 'owner', 'Design', now() + interval '10 days')`, [id, PROJECT, ORG],
      );
    }
    const model = async (docId, rfpId, uploadedAt, deleted = false) => {
      await pool.query(
        `INSERT INTO documents.document (id, project_id, scope_type, scope_id, kind, title, current_version, deleted_at)
         VALUES ($1, $2, 'rfp', $3, 'bim', 'casa.ifc', 1, $4)`, [docId, PROJECT, rfpId, deleted ? new Date() : null],
      );
      await pool.query(
        `INSERT INTO documents.document_version (document_id, version_no, storage_key, mime, size_bytes, sha256,
           uploaded_by_person_id, uploaded_by_org_id, uploaded_at)
         VALUES ($1, 1, $2, 'application/x-step', 10, $3, $4, $5, $6)`,
        [docId, `k/${docId}`, 'a'.repeat(64), PERSON, ORG, uploadedAt],
      );
    };
    await model(DOC_B, RFP_B, '2026-10-02T00:00:00Z');
    await model(DOC_A, RFP_A, '2026-10-01T00:00:00Z');
    await model(DOC_GONE, RFP_C, '2026-09-01T00:00:00Z', true);
    // Each writes only its own schema; the tendering one must run first.
    assert.deepEqual(files.slice(files.indexOf(pair[0]), files.indexOf(pair[0]) + 2), pair, 'the pair sorts adjacent, tendering first');
    for (const f of pair) await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  test('every RFP references its own model; a removed one references nothing', async () => {
    const { rows } = await pool.query('SELECT id, model_document_id, model_version_no FROM tendering.rfp');
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(by[RFP_A].model_document_id, DOC_A);
    assert.equal(by[RFP_B].model_document_id, DOC_B);
    assert.equal(by[RFP_C].model_document_id, null);
    assert.ok(rows.every((r) => r.model_version_no === null), 'follow the current version');
  });

  test('the models are the build\'s now; the oldest referenced one is THE project model', async () => {
    const { rows } = await pool.query('SELECT id, scope_type, scope_id, is_project_model FROM documents.document ORDER BY id');
    assert.ok(rows.every((r) => r.scope_type === 'project' && r.scope_id === PROJECT));
    assert.deepEqual(rows.filter((r) => r.is_project_model).map((r) => r.id), [DOC_A]);
    const { rows: versions } = await pool.query('SELECT count(*)::int AS n FROM documents.document_version');
    assert.equal(versions[0].n, 3, 'the byte ledger is untouched');
    await assert.rejects(pool.query('UPDATE documents.document SET is_project_model = true WHERE id = $1', [DOC_B]),
      /document_one_project_model/, 'one live model per build');
  });
});
