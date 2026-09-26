// Quality store over the REAL v2 migrations (throwaway DB, like
// modules/contracting). Skipped without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/pg-store.test.mjs
//
// Proves at the database level, per AGENT-INDEX §6:
//   #4  quality writes commit WITH their ledger entry (and outbox event where
//       doc 10 lists one) in ONE transaction;
//   8g  a verification is never decided by the org that asked for it;
//   8h  a non-conformity is never closed by anyone but its raiser;
// and the doc-10 hand-off: planning.progress.reported (done) → quality
// consumer → pending verification_request, idempotent under at-least-once
// delivery; plus the full NC lifecycle against the real CHECKs.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createQualityStore } from './pg-store.mjs';
import { qualityConsumers } from '../application/consumers.mjs';
import { dispatchPending, publishEvent } from '../../../platform/outbox.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the quality Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_quality_test';

const OWNER_ORG = randomUUID();
const GC_ORG = randomUUID();
const SUB_ORG = randomUUID();
const INSPECTOR_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const PRIME = randomUUID(); // owner → GC
const SUBC = randomUUID(); // GC → SUB, parent PRIME
const TASK = randomUUID(); // bound to SUBC (branch)
const ACTOR = { personId: PERSON, orgId: GC_ORG, orgRole: 'admin', channel: 'ui' };

function doneReport(overData = {}) {
  return {
    event_id: randomUUID(),
    type: 'planning.progress.reported',
    project_id: PROJECT,
    actor: { person_id: PERSON, org_id: SUB_ORG },
    scope: { type: 'project', id: PROJECT },
    data: { task_id: TASK, status: 'done', criteria: 'sem fissuras', ...overData },
  };
}

describe('quality store over Postgres (v2 migrations)', { skip }, () => {
  let pg, admin, pool, store, consumers;

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
         ($3, 'org_sub', 'contractor', 'Canalizações Norte'),
         ($4, 'org_insp', 'consultant', 'Marta Fiscalização')`,
      [OWNER_ORG, GC_ORG, SUB_ORG, INSPECTOR_ORG],
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
      `INSERT INTO project.participation (project_id, org_id, capacity, source, contract_id, invite_capacity) VALUES
         ($1, $2, 'owner', 'project', NULL, NULL),
         ($1, $3, 'prime_contractor', 'contract', $6, NULL),
         ($1, $4, 'subcontractor', 'contract', $7, NULL),
         ($1, $5, 'consultant', 'invitation', NULL, 'inspection')`,
      [PROJECT, OWNER_ORG, GC_ORG, SUB_ORG, INSPECTOR_ORG, PRIME, SUBC],
    );
    await pool.query(
      `INSERT INTO contracting.contract (id, project_id, kind, parent_contract_id, client_org_id, supplier_org_id, reference, origin, status) VALUES
         ($1, $3, 'prime', NULL, $4, $5, 'PRIME-1', 'direct_entry', 'active'),
         ($2, $3, 'sub', $1, $5, $6, 'SUB-1', 'direct_entry', 'active')`,
      [PRIME, SUBC, PROJECT, OWNER_ORG, GC_ORG, SUB_ORG],
    );
    await pool.query(
      `INSERT INTO planning.task (id, project_id, depth, position, name, branch_contract_id)
       VALUES ($1, $2, 2, 'aa', 'Reboco WC', $3)`,
      [TASK, PROJECT, SUBC],
    );
    store = createQualityStore(pool);
    consumers = qualityConsumers(store);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  test('consumer: progress done → ONE pending request, idempotent under replay', async () => {
    await publishEvent(pool, doneReport());
    await publishEvent(pool, doneReport()); // at-least-once: same fact again
    await dispatchPending(pool, consumers);

    const { rows } = await pool.query(
      `SELECT * FROM quality.verification_request WHERE task_id = $1`, [TASK],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].requested_by_org_id, SUB_ORG);
    assert.equal(rows[0].criteria_snapshot, 'sem fissuras');

    const { rows: ledger } = await pool.query(
      `SELECT type, channel FROM record.audit_event WHERE project_id = $1 AND type = 'quality.verification.requested'`,
      [PROJECT],
    );
    assert.equal(ledger.length, 1); // the replay ledgered nothing
    assert.equal(ledger[0].channel, 'system');
  });

  test('consumer ignores non-done reports', async () => {
    await publishEvent(pool, doneReport({ status: 'in_progress' }));
    await dispatchPending(pool, consumers);
    const { rows } = await pool.query(
      `SELECT count(*) AS n FROM quality.verification_request WHERE task_id = $1`, [TASK],
    );
    assert.equal(Number(rows[0].n), 1);
  });

  test('the queue: chain client, owner and invited inspector see it; the reporter does not', async () => {
    for (const org of [GC_ORG, OWNER_ORG, INSPECTOR_ORG]) {
      const { items } = await store.listMyVerifications({
        orgId: org, status: 'pending', projectId: null, cursor: null, limit: 50,
      });
      assert.equal(items.length, 1, `org ${org} should see the request`);
      assert.equal(items[0].task_name, 'Reboco WC');
      assert.equal(items[0].project_id, PROJECT);
    }
    const { items: own } = await store.listMyVerifications({
      orgId: SUB_ORG, status: 'pending', projectId: null, cursor: null, limit: 50,
    });
    assert.equal(own.length, 0); // D-31: never your own org's work
  });

  test('relationship ports: client chain walks sub → prime → owner', async () => {
    assert.equal(await store.isClientChain(GC_ORG, { taskId: TASK, projectId: PROJECT }), true);
    assert.equal(await store.isClientChain(OWNER_ORG, { taskId: TASK, projectId: PROJECT }), true);
    assert.equal(await store.isClientChain(SUB_ORG, { taskId: TASK, projectId: PROJECT }), false);
    assert.equal(await store.isInvitedInspector(PROJECT, INSPECTOR_ORG), true);
    assert.equal(await store.isInvitedInspector(PROJECT, SUB_ORG), false);
    assert.equal(await store.isProjectClient(PROJECT, GC_ORG), true);
    assert.equal(await store.isProjectClient(PROJECT, SUB_ORG), false);
  });

  test('decide: accepted + ledger + outbox in ONE transaction; a second decide answers null', async () => {
    const { rows: [vr] } = await pool.query(
      `SELECT id FROM quality.verification_request WHERE task_id = $1 AND status = 'pending'`, [TASK],
    );
    const decided = await store.decideVerification({
      verificationId: vr.id, status: 'accepted', reason: null,
      deciderOrgId: GC_ORG, deciderPersonId: PERSON,
      projectId: PROJECT, taskId: TASK, actor: ACTOR,
    });
    assert.equal(decided.status, 'accepted');
    assert.equal(decided.decided_by_org_id, GC_ORG);
    assert.ok(decided.decided_at);

    const { rows: ledger } = await pool.query(
      `SELECT type FROM record.audit_event WHERE project_id = $1 ORDER BY seq DESC LIMIT 1`, [PROJECT],
    );
    assert.equal(ledger[0].type, 'quality.verification.accepted');
    const { rows: outbox } = await pool.query(
      `SELECT data FROM platform.outbox WHERE type = 'quality.verification.accepted'`,
    );
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].data.task_id, TASK);
    assert.equal(outbox[0].data.decided_by.org_id, GC_ORG);

    const raced = await store.decideVerification({
      verificationId: vr.id, status: 'rejected', reason: 'x',
      deciderOrgId: OWNER_ORG, deciderPersonId: PERSON,
      projectId: PROJECT, taskId: TASK, actor: { ...ACTOR, orgId: OWNER_ORG },
    });
    assert.equal(raced, null);
  });

  test('once decided, a NEW done report opens a NEW pending request', async () => {
    await publishEvent(pool, doneReport());
    await dispatchPending(pool, consumers);
    const { rows } = await pool.query(
      `SELECT status FROM quality.verification_request WHERE task_id = $1 ORDER BY status`, [TASK],
    );
    assert.deepEqual(rows.map((r) => r.status), ['accepted', 'pending']);
  });

  test('check 8g: the DB refuses a decision by the requesting org', async () => {
    await assert.rejects(
      pool.query(
        `UPDATE quality.verification_request SET decided_by_org_id = requested_by_org_id
          WHERE task_id = $1 AND status = 'pending'`,
        [TASK],
      ),
      /check constraint/,
    );
  });

  test('reject requires a reason at the DB too', async () => {
    const { rows: [vr] } = await pool.query(
      `SELECT id FROM quality.verification_request WHERE task_id = $1 AND status = 'pending'`, [TASK],
    );
    await assert.rejects(
      store.decideVerification({
        verificationId: vr.id, status: 'rejected', reason: null,
        deciderOrgId: GC_ORG, deciderPersonId: PERSON,
        projectId: PROJECT, taskId: TASK, actor: ACTOR,
      }),
      /check constraint/,
    );
    // …and the failed transaction ledgered nothing (§6.4).
    const { rows: [row] } = await pool.query(
      `SELECT status FROM quality.verification_request WHERE id = $1`, [vr.id],
    );
    assert.equal(row.status, 'pending');
  });

  test('NC lifecycle open → assigned → fixed → closed against the real CHECKs', async () => {
    const id = randomUUID();
    const created = await store.createNonConformity({
      id, projectId: PROJECT, taskId: TASK, contractId: SUBC,
      kind: 'quality', severity: 'major', description: 'Fissura no lintel',
      photoDocumentIds: [], assignedToOrgId: null,
      raisedByOrgId: GC_ORG, raisedByPersonId: PERSON, actor: ACTOR,
    });
    assert.equal(created.status, 'open');
    const { rows: raisedEvt } = await pool.query(
      `SELECT data FROM platform.outbox WHERE type = 'quality.nonconformity.raised'`,
    );
    assert.equal(raisedEvt.length, 1);
    assert.equal(raisedEvt[0].data.status, 'open');

    const assigned = await store.transitionNonConformity({
      nonconformityId: id, from: 'open', to: 'assigned',
      set: { assignedToOrgId: SUB_ORG },
      eventType: 'quality.nonconformity.assigned', note: 'corrigir', projectId: PROJECT, actor: ACTOR,
    });
    assert.equal(assigned.status, 'assigned');
    assert.equal(assigned.assigned_to_org_id, SUB_ORG);

    // stale `from` answers null (the caller maps it to 409)
    const raced = await store.transitionNonConformity({
      nonconformityId: id, from: 'open', to: 'assigned', set: {},
      eventType: 'quality.nonconformity.assigned', note: null, projectId: PROJECT, actor: ACTOR,
    });
    assert.equal(raced, null);

    const fixed = await store.transitionNonConformity({
      nonconformityId: id, from: 'assigned', to: 'fixed', set: {},
      eventType: 'quality.nonconformity.fixed', note: 'refeito', projectId: PROJECT,
      actor: { ...ACTOR, orgId: SUB_ORG },
    });
    assert.equal(fixed.status, 'fixed');

    // check 8h: closing by anyone but the raiser is refused BY THE DB…
    const { rows: [{ n: before }] } = await pool.query('SELECT count(*) AS n FROM record.audit_event');
    await assert.rejects(
      store.transitionNonConformity({
        nonconformityId: id, from: 'fixed', to: 'closed',
        set: { closedByOrgId: OWNER_ORG },
        eventType: 'quality.nonconformity.closed', note: null, projectId: PROJECT,
        actor: { ...ACTOR, orgId: OWNER_ORG },
      }),
      /check constraint/,
    );
    // …and the refused transaction left NO ledger entry (§6.4).
    const { rows: [{ n: after_ }] } = await pool.query('SELECT count(*) AS n FROM record.audit_event');
    assert.equal(before, after_);

    const closed = await store.transitionNonConformity({
      nonconformityId: id, from: 'fixed', to: 'closed',
      set: { closedByOrgId: GC_ORG },
      eventType: 'quality.nonconformity.closed', note: 'conforme', projectId: PROJECT, actor: ACTOR,
    });
    assert.equal(closed.status, 'closed');
    assert.equal(closed.closed_by_org_id, GC_ORG);
    const { rows: closedEvt } = await pool.query(
      `SELECT data FROM platform.outbox WHERE type = 'quality.nonconformity.closed'`,
    );
    assert.equal(closedEvt.length, 1);
    assert.equal(closedEvt[0].data.status, 'closed'); // contracting's reception guard reads this
  });

  test('inspection: row + ledger entry, NO outbox event (doc 10)', async () => {
    const id = randomUUID();
    const { rows: [{ n: eventsBefore }] } = await pool.query('SELECT count(*) AS n FROM platform.outbox');
    const created = await store.createInspection({
      id, projectId: PROJECT, inspectorOrgId: INSPECTOR_ORG, kind: 'safety',
      date: '2026-09-25', checklist: [{ item: 'EPIs', ok: true }],
      findings: null, taskIds: [TASK], actor: { ...ACTOR, orgId: INSPECTOR_ORG },
    });
    assert.equal(created.kind, 'safety');
    assert.deepEqual(created.task_ids, [TASK]);
    const { rows: ledger } = await pool.query(
      `SELECT type FROM record.audit_event WHERE project_id = $1 ORDER BY seq DESC LIMIT 1`, [PROJECT],
    );
    assert.equal(ledger[0].type, 'quality.inspection.recorded');
    const { rows: [{ n: eventsAfter }] } = await pool.query('SELECT count(*) AS n FROM platform.outbox');
    assert.equal(eventsBefore, eventsAfter);
  });
});
