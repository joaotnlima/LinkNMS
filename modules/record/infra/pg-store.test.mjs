// Record store over the REAL v2 migrations (throwaway DB, like the other
// module stores). Skipped without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/pg-store.test.mjs
//
// This is where the V7 redaction PREDICATE is proven: the projection is run as
// three different orgs over one ledger and must show exactly the entries each
// is in scope for, redacting the rest while keeping the hash chain intact.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createRecordStore } from './pg-store.mjs';
import { appendAuditEvent } from '../../../platform/ledger.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the record Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_record_test';

const OWNER = randomUUID();
const GC = randomUUID();
const SUB = randomUUID();
const PROJECT = randomUUID();
const PRIME = randomUUID();
const SUBCONTRACT = randomUUID();
const RFP = randomUUID();
const PROPOSAL = randomUUID();
const RECIPIENT = randomUUID();
const TASK = randomUUID();

describe('record store over Postgres (v2 migrations)', { skip }, () => {
  let pg, admin, pool, store;

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 2 });
    await pool.query(readFileSync(join(ROOT, 'db', 'v2', '0001_schema.sql'), 'utf8'));

    await pool.query(
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES
         ($1, 'org_owner', 'household', 'Família Silva'),
         ($2, 'org_gc', 'contractor', 'Douro Construções'),
         ($3, 'org_sub', 'supplier', 'Alufer')`,
      [OWNER, GC, SUB],
    );
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code)
       VALUES ($1, $2, $2, 'Casa Silva', '1306')`,
      [PROJECT, OWNER],
    );
    await pool.query(
      `INSERT INTO project.participation (project_id, org_id, capacity, source) VALUES
         ($1, $2, 'owner', 'project'),
         ($1, $3, 'prime_contractor', 'project'),
         ($1, $4, 'subcontractor', 'project')`,
      [PROJECT, OWNER, GC, SUB],
    );
    // prime: owner is the client, GC the supplier → owner is a party.
    await pool.query(
      `INSERT INTO contracting.contract (id, project_id, kind, client_org_id, supplier_org_id, reference, origin, status)
       VALUES ($1, $2, 'prime', $3, $4, 'PRIME', 'direct_entry', 'signed')`,
      [PRIME, PROJECT, OWNER, GC],
    );
    // sub: GC ↔ SUB → owner is NOT a party (its changes are redacted from owner).
    await pool.query(
      `INSERT INTO contracting.contract (id, project_id, kind, parent_contract_id, client_org_id, supplier_org_id, reference, origin, status)
       VALUES ($1, $2, 'sub', $3, $4, $5, 'SUB', 'direct_entry', 'signed')`,
      [SUBCONTRACT, PROJECT, PRIME, GC, SUB],
    );
    // an RFP GC issued, and a proposal SUB bid on it → rfp_private visible to
    // GC (issuer) and SUB (bidder), redacted from owner.
    await pool.query(
      `INSERT INTO tendering.rfp (id, project_id, issuer_org_id, level, title, submission_deadline, status)
       VALUES ($1, $2, $3, 'owner', 'Alvenaria', now() + interval '7 days', 'published')`,
      [RFP, PROJECT, GC],
    );
    await pool.query(
      `INSERT INTO tendering.rfp_recipient (id, rfp_id, email, token_hash) VALUES ($1, $2, 'sub@alufer.pt', $3)`,
      [RECIPIENT, RFP, 'a'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO tendering.proposal (id, rfp_id, recipient_id, bidder_org_id, status)
       VALUES ($1, $2, $3, $4, 'submitted')`,
      [PROPOSAL, RFP, RECIPIENT, SUB],
    );

    // Append five entries, in order, spanning every scope_type.
    await append({ actorOrg: GC, category: 'project', type: 'project.created',
      scope: { type: 'project', id: PROJECT }, object: { type: 'project', id: PROJECT }, payload: { name: 'Casa Silva' } });
    await append({ actorOrg: GC, category: 'contracting', type: 'contracting.contract.signed',
      scope: { type: 'contract', id: PRIME }, object: { type: 'contract', id: PRIME }, payload: { reference: 'PRIME' } });
    await append({ actorOrg: SUB, category: 'contracting', type: 'contracting.change_order.decided',
      scope: { type: 'contract', id: SUBCONTRACT }, object: { type: 'change_order', id: TASK }, payload: { delta_cents: 120000 } });
    await append({ actorOrg: GC, category: 'identity', type: 'identity.org_private.noted',
      scope: { type: 'org_private', id: GC }, object: { type: 'organization', id: GC }, payload: { note: 'private' } });
    await append({ actorOrg: SUB, category: 'tendering', type: 'tendering.proposal.submitted',
      scope: { type: 'rfp_private', id: PROPOSAL }, object: { type: 'proposal', id: PROPOSAL }, payload: { total_cents: 500000 } });

    store = createRecordStore(pool);
  });

  after(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
      await admin.end();
    }
  });

  async function append({ actorOrg, category, type, scope, object, payload }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await appendAuditEvent(client, {
        projectId: PROJECT, actor: { orgId: actorOrg, orgRole: 'admin' },
        category, type, scope, object, payload,
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  const list = (org, opts = {}) => store.listAuditEntries(PROJECT, org, {
    objectType: null, objectId: null, cursor: null, limit: 50, ...opts,
  });

  test('every entry is returned to any party, newest first, with hashes', async () => {
    const { items } = await list(OWNER);
    assert.equal(items.length, 5);
    assert.deepEqual(items.map((r) => Number(r.seq)), [5, 4, 3, 2, 1]);
    for (const r of items) assert.equal(typeof r.entry_hash, 'string');
    assert.equal(items.find((r) => Number(r.seq) === 1).prev_hash, null); // genesis
  });

  test('owner sees project + own-contract payloads, everything else redacted', async () => {
    const by = Object.fromEntries((await list(OWNER)).items.map((r) => [Number(r.seq), r]));
    assert.equal(by[1].redacted, false); // project-scoped
    assert.equal(by[2].redacted, false); // prime — owner is client
    assert.equal(by[3].redacted, true);  // subcontract — owner not a party
    assert.equal(by[4].redacted, true);  // GC org_private
    assert.equal(by[5].redacted, true);  // rfp_private proposal
    assert.equal(by[3].payload, null);
    assert.equal(by[2].payload.reference, 'PRIME');
  });

  test('GC sees all five (party to both contracts, its org scope, its RFP)', async () => {
    const items = (await list(GC)).items;
    assert.equal(items.every((r) => r.redacted === false), true);
  });

  test('subcontractor sees project + its sub-contract + its proposal, not the prime or GC-private', async () => {
    const by = Object.fromEntries((await list(SUB)).items.map((r) => [Number(r.seq), r]));
    assert.equal(by[1].redacted, false); // project
    assert.equal(by[2].redacted, true);  // prime — SUB not a party
    assert.equal(by[3].redacted, false); // subcontract — SUB is supplier
    assert.equal(by[4].redacted, true);  // GC org_private
    assert.equal(by[5].redacted, false); // its own proposal
  });

  test('the hash chain links across a redacted entry (prev_hash === prior entry_hash)', async () => {
    const asc = (await list(OWNER)).items.slice().sort((a, b) => Number(a.seq) - Number(b.seq));
    for (let i = 1; i < asc.length; i++) {
      assert.equal(asc[i].prev_hash, asc[i - 1].entry_hash,
        `entry ${asc[i].seq} must chain to ${asc[i - 1].seq} regardless of redaction`);
    }
  });

  test('filters by object_type and object_id', async () => {
    const byType = await list(OWNER, { objectType: 'contract' });
    assert.deepEqual(byType.items.map((r) => Number(r.seq)).sort(), [2]);
    const byId = await list(GC, { objectId: PROPOSAL });
    assert.deepEqual(byId.items.map((r) => Number(r.seq)), [5]);
  });

  test('paginates by seq descending via the cursor', async () => {
    const first = await list(OWNER, { limit: 2 });
    assert.deepEqual(first.items.map((r) => Number(r.seq)), [5, 4]);
    assert.equal(first.nextCursor, '4');
    const second = await list(OWNER, { limit: 2, cursor: Number(first.nextCursor) });
    assert.deepEqual(second.items.map((r) => Number(r.seq)), [3, 2]);
  });
});
