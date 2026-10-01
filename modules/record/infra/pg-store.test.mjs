// Record store over the REAL v2 migrations (throwaway DB, like the other
// module pg suites). Proves the two things only the database can prove:
//   1. V7 scope visibility — the join that decides `visible` per row, for each
//      of project / contract / org_private / rfp_private, against real parties.
//   2. Chain verification — recomputed IN SQL from the same append_event()
//      that wrote it, and that it CATCHES a tamper (append-only trigger
//      disabled for the mutation, exactly what an attacker with DB access would
//      have to do — and what verifyChain exists to detect).
// Skipped without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/pg-store.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createRecordStore } from './pg-store.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the record Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_record_test';
const MIGRATIONS = [
  '0001_schema.sql', '0002_platform_idempotency.sql', '0003_project_claim.sql',
  '0004_contracting_contract_root.sql', '0005_collaboration_phase7.sql',
  '0006_billing_phase8.sql', '0007_tendering_public_link.sql',
];

const OWNER = randomUUID();   // household — owner of the project + issuer of the RFP
const GC = randomUUID();      // contractor — contract supplier + an org_private entry
const SUB = randomUUID();     // supplier — the RFP bidder
const STRANGER = randomUUID();
const PROJECT = randomUUID();
const CONTRACT = randomUUID();
const RFP = randomUUID();
const RECIPIENT = randomUUID();
const PROPOSAL = randomUUID();
const CO = randomUUID();

async function append(pool, { occurred, category, type, scopeType, scopeId, objectType, objectId, payload }) {
  const { rows } = await pool.query(
    `SELECT record.append_event($1,coalesce($2::timestamptz, now()),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS seq`,
    [PROJECT, occurred ?? null, null, null, null, category, type,
      scopeType, scopeId, objectType, objectId, JSON.stringify(payload), 'ui'],
  );
  return Number(rows[0].seq);
}

describe('record store over Postgres (v2 migrations)', { skip }, () => {
  let pg, admin, pool, store;

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 2 });
    for (const f of MIGRATIONS) await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));

    await pool.query(
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES
         ($1,'org_owner','household','Família Silva'),
         ($2,'org_gc','contractor','Douro Construções'),
         ($3,'org_sub','supplier','Eletro Sub'),
         ($4,'org_x','contractor','Estranha Lda')`,
      [OWNER, GC, SUB, STRANGER]);
    // Project owned by OWNER, with OWNER, GC and SUB all active participants
    // (so all three pass the participant gate; visibility then narrows content).
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code, status)
       VALUES ($1,$2,$2,'Casa Silva','1306','in_execution')`, [PROJECT, OWNER]);
    await pool.query(
      `INSERT INTO project.participation (project_id, org_id, capacity, source) VALUES
         ($1,$2,'owner','project'),
         ($1,$3,'prime_contractor','project'),
         ($1,$4,'subcontractor','project')`, [PROJECT, OWNER, GC, SUB]);
    // A contract OWNER↔GC (SUB is not a party → contract entries redact for SUB).
    await pool.query(
      `INSERT INTO contracting.contract (id, project_id, kind, client_org_id, supplier_org_id, reference, origin)
       VALUES ($1,$2,'direct',$3,$4,'C-1','direct_entry')`, [CONTRACT, PROJECT, OWNER, GC]);
    // An RFP issued by OWNER, bid by SUB → rfp_private entries visible to both.
    await pool.query(
      `INSERT INTO tendering.rfp (id, project_id, issuer_org_id, level, title, submission_deadline)
       VALUES ($1,$2,$3,'owner','RFP-1', now() + interval '7 days')`, [RFP, PROJECT, OWNER]);
    await pool.query(
      `INSERT INTO tendering.rfp_recipient (id, rfp_id, org_id, email, token_hash)
       VALUES ($1,$2,$3,'sub@x.pt',$4)`, [RECIPIENT, RFP, SUB, 'a'.repeat(64)]);
    await pool.query(
      `INSERT INTO tendering.proposal (id, rfp_id, recipient_id, bidder_org_id, status)
       VALUES ($1,$2,$3,$4,'submitted')`, [PROPOSAL, RFP, RECIPIENT, SUB]);

    // The ledger: one entry per scope kind, chronological.
    await append(pool, { category: 'project', type: 'project.created', scopeType: 'project', scopeId: PROJECT, objectType: 'project', objectId: PROJECT, payload: { name: 'Casa Silva' } });
    await append(pool, { category: 'contracting', type: 'contracting.change_order.approved', scopeType: 'contract', scopeId: CONTRACT, objectType: 'change_order', objectId: CO, payload: { delta_cents: 125000 } });
    await append(pool, { category: 'planning', type: 'planning.cost_line.recorded', scopeType: 'org_private', scopeId: GC, objectType: 'cost_line', objectId: randomUUID(), payload: { estimate_cents: 999 } });
    await append(pool, { category: 'tendering', type: 'tendering.proposal.submitted', scopeType: 'rfp_private', scopeId: PROPOSAL, objectType: 'proposal', objectId: PROPOSAL, payload: { total_cents: 500000 } });

    store = createRecordStore(pool);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  const visibilityFor = async (orgId) => {
    const { rows } = await store.listEvents({ projectId: PROJECT, orgId, limit: 100 });
    return Object.fromEntries(rows.map((r) => [r.category, r.visible]));
  };

  test('OWNER sees project + contract (party) + rfp (issuer); org_private(GC) redacts', async () => {
    const v = await visibilityFor(OWNER);
    assert.equal(v.project, true);
    assert.equal(v.contracting, true);   // contract party
    assert.equal(v.tendering, true);     // rfp issuer
    assert.equal(v.planning, false);     // org_private of GC
  });

  test('GC sees project + contract (party) + org_private(self); rfp redacts', async () => {
    const v = await visibilityFor(GC);
    assert.equal(v.project, true);
    assert.equal(v.contracting, true);   // contract supplier
    assert.equal(v.planning, true);      // its own org_private
    assert.equal(v.tendering, false);    // not the bidder, not the issuer
  });

  test('SUB sees project + rfp (bidder); contract + org_private(GC) redact', async () => {
    const v = await visibilityFor(SUB);
    assert.equal(v.project, true);
    assert.equal(v.tendering, true);     // the bidder
    assert.equal(v.contracting, false);  // not a contract party
    assert.equal(v.planning, false);     // GC's org_private
  });

  test('newest-first order + cursor paging', async () => {
    const page1 = await store.listEvents({ projectId: PROJECT, orgId: OWNER, limit: 2 });
    assert.equal(page1.rows.length, 2);
    assert.equal(Number(page1.rows[0].seq), 4);
    assert.equal(Number(page1.rows[1].seq), 3);
    assert.equal(page1.nextCursor, '3');
    const page2 = await store.listEvents({ projectId: PROJECT, orgId: OWNER, limit: 2, cursorSeq: page1.nextCursor });
    assert.deepEqual(page2.rows.map((r) => Number(r.seq)), [2, 1]);
    assert.equal(page2.nextCursor, null);
  });

  test('object_type / object_id drill-down', async () => {
    const { rows } = await store.listEvents({ projectId: PROJECT, orgId: OWNER, objectType: 'change_order', objectId: CO, limit: 100 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'contracting.change_order.approved');
  });

  test('listAllEvents: whole ledger in chain order (seq ASC) with the same visibility', async () => {
    const rows = await store.listAllEvents({ projectId: PROJECT, orgId: OWNER });
    assert.deepEqual(rows.map((r) => Number(r.seq)), [1, 2, 3, 4]); // ASC, nothing dropped
    const v = Object.fromEntries(rows.map((r) => [r.category, r.visible]));
    // Identical projection to listEvents for the same org (OWNER).
    assert.deepEqual(v, { project: true, contracting: true, planning: false, tendering: true });
  });

  test('listAllEvents: an empty project yields no rows', async () => {
    const rows = await store.listAllEvents({ projectId: randomUUID(), orgId: OWNER });
    assert.deepEqual(rows, []);
  });

  test('verifyChain: valid over the untouched chain', async () => {
    const v = await store.verifyChain(PROJECT);
    assert.equal(v.valid, true);
    assert.equal(v.length, 4);
    assert.equal(v.first_invalid_seq, null);
    assert.equal(v.head.length, 64);
  });

  test('verifyChain: an empty project chain is trivially valid', async () => {
    const empty = randomUUID();
    const v = await store.verifyChain(empty);
    assert.deepEqual(v, { valid: true, length: 0, head: null, first_invalid_seq: null });
  });

  test('verifyChain: a tampered payload is caught at the tampered seq (and every entry after)', async () => {
    // Only a DB owner disabling the append-only trigger can mutate a row — which
    // is precisely the attack verifyChain defends against.
    await pool.query('ALTER TABLE record.audit_event DISABLE TRIGGER audit_event_append_only');
    try {
      await pool.query(
        `UPDATE record.audit_event SET payload = '{"delta_cents": 999999}'::jsonb WHERE project_id = $1 AND seq = 2`,
        [PROJECT]);
    } finally {
      await pool.query('ALTER TABLE record.audit_event ENABLE TRIGGER audit_event_append_only');
    }
    const v = await store.verifyChain(PROJECT);
    assert.equal(v.valid, false);
    assert.equal(v.first_invalid_seq, 2); // payload_hash changed → this entry no longer matches
  });
});
