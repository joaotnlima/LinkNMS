// PRD-05 deliverables over the REAL v2 migrations (throwaway DB). Skipped
// without DATABASE_URL. Proves end to end, at the use-case level:
//   F-12  a design award seeds the RFP's deliverables on the tendered row,
//         once (a replayed award adds nothing);
//   D-48  `done` is refused while a required deliverable is unapproved, and
//         accepted once all are (acceptance criterion 2);
//   F-13  the assignee submits a proven version with a note; the sha256 is
//         snapshotted; F-14 the GC approves on the owner's behalf (client
//         side), the submitter's org never decides (two-sided); the approval
//         row is write-once (trigger); events ledgered + on the outbox;
//   F-15  a new version of the submitted document puts it back to review
//         (acceptance criterion 3), with planning.deliverable.submitted out;
//   the audience port names the reviewers (client side minus the submitter).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createPlanningStore } from './pg-store.mjs';
import { planningConsumers } from '../application/consumers.mjs';
import { reportProgress } from '../application/use-cases.mjs';
import {
  listTaskDeliverables, createDeliverable, submitDeliverable, approveDeliverable,
  requestDeliverableChanges, listProjectDeliverables,
} from '../application/deliverables.mjs';
import { createPlanningAudience } from '../application/audience.mjs';
import { createPlanningTaskPort } from '../application/task-port.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the planning Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_planning_deliverables_test';

const OWNER_ORG = randomUUID();
const GC_ORG = randomUUID();
const SUB_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const PRIME = randomUUID();
const SUBC = randomUUID();
const DESIGN = randomUUID(); // 1.4 Structural design — SUB's branch
const CHILD = randomUUID();
const RFP = randomUUID();
const DOC = randomUUID();
const SHA1 = '1'.repeat(64);
const SHA2 = '2'.repeat(64);

function viewer(orgId) {
  return { clerkUserId: 'user_ana', personId: PERSON, orgId, orgRole: 'admin', channel: 'ui', has: () => true };
}

// The documents query port, as documents answers it for a proven version.
const versions = new Map([[1, SHA1]]);
const documents = {
  async versionFacts({ documentId, versionNo }) {
    const no = versionNo ?? Math.max(...versions.keys());
    if (documentId !== DOC || !versions.has(no)) return null;
    return { document_id: DOC, project_id: PROJECT, version_no: no, sha256: versions.get(no), title: 'S-110 Truss details', mime: 'application/pdf', file_type: 'pdf', current_version: no };
  },
};

describe('deliverables over Postgres (PRD-05, D-48)', { skip }, () => {
  let pg, admin, pool, store, consumers;

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 3 });
    for (const f of readdirSync(join(ROOT, 'db', 'v2')).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
      await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
    }
    await pool.query(
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES
         ($1, 'o1', 'household', 'Família Almeida'), ($2, 'o2', 'contractor', 'Obra Nova'), ($3, 'o3', 'contractor', 'Engenharia Lopes')`,
      [OWNER_ORG, GC_ORG, SUB_ORG],
    );
    await pool.query(`INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES ($1, 'user_ana', 'a@x.pt', 'Ana')`, [PERSON]);
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code) VALUES ($1, $2, $2, 'Casa', '1111')`,
      [PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO project.participation (project_id, org_id, capacity, source, contract_id) VALUES
         ($1, $2, 'owner', 'project', NULL), ($1, $3, 'prime_contractor', 'contract', $5), ($1, $4, 'subcontractor', 'contract', $6)`,
      [PROJECT, OWNER_ORG, GC_ORG, SUB_ORG, PRIME, SUBC],
    );
    await pool.query(
      `INSERT INTO contracting.contract (id, project_id, kind, client_org_id, supplier_org_id, parent_contract_id, reference, origin, status) VALUES
         ($1, $3, 'prime', $4, $5, NULL, 'P-1', 'direct_entry', 'active'),
         ($2, $3, 'sub', $5, $6, $1, 'S-1', 'direct_entry', 'active')`,
      [PRIME, SUBC, PROJECT, OWNER_ORG, GC_ORG, SUB_ORG],
    );
    await pool.query(
      `INSERT INTO planning.task (id, project_id, parent_id, depth, position, name, contract_id, branch_contract_id, assignee_org_id) VALUES
         ($1, $3, NULL, 1, 'a', 'Structural design', $4, $4, $5),
         ($2, $3, $1, 2, 'a', 'Truss study', NULL, $4, NULL)`,
      [DESIGN, CHILD, PROJECT, SUBC, SUB_ORG],
    );
    store = createPlanningStore(pool);
    consumers = planningConsumers(store);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  const awardEvt = () => ({
    event_id: randomUUID(), type: 'tendering.rfp.awarded', project_id: PROJECT,
    actor: { person_id: PERSON, org_id: GC_ORG }, scope: { type: 'project', id: PROJECT },
    data: {
      rfp_id: RFP, proposal_id: randomUUID(), contract_id: SUBC, root_task_ids: [DESIGN], supplier_org_id: SUB_ORG,
      start: null, duration_wd: null, purpose: 'design', deliverables: ['S-110 Truss details', 'Calculation report'],
    },
  });

  test('F-12: a design award seeds required deliverables on the tendered row, once', async () => {
    await consumers['tendering.rfp.awarded'](awardEvt());
    await consumers['tendering.rfp.awarded'](awardEvt()); // redelivery / replay
    const res = await listTaskDeliverables({ viewer: viewer(OWNER_ORG), store, taskId: DESIGN });
    assert.deepEqual(res.body.items.map((d) => [d.title, d.required, d.source_rfp_id, d.status]), [
      ['S-110 Truss details', true, RFP, 'not_yet'],
      ['Calculation report', true, RFP, 'not_yet'],
    ]);
    assert.equal(res.body.done_blocked, true);
    assert.equal(res.body.can_edit, true);
    const sub = await listTaskDeliverables({ viewer: viewer(SUB_ORG), store, taskId: DESIGN });
    assert.deepEqual([sub.body.can_submit, sub.body.can_edit], [true, false]);
  });

  test('client side adds one; the assignee may not', async () => {
    const id = randomUUID();
    const made = await createDeliverable({ viewer: viewer(GC_ORG), store, taskId: DESIGN, body: { id, title: 'Term of responsibility', required: false } });
    assert.equal(made.status, 201);
    const replay = await createDeliverable({ viewer: viewer(GC_ORG), store, taskId: DESIGN, body: { id, title: 'Term of responsibility', required: false } });
    assert.equal(replay.status, 200);
    await assert.rejects(
      createDeliverable({ viewer: viewer(SUB_ORG), store, taskId: DESIGN, body: { id: randomUUID(), title: 'x' } }),
      (err) => err.problem?.status === 403,
    );
  });

  test('D-48 + F-13/F-14/F-15: done refused until every required deliverable is approved; new version back to review', async () => {
    await assert.rejects(
      reportProgress({ viewer: viewer(SUB_ORG), store, taskId: DESIGN, body: { status: 'done' } }),
      (err) => err.problem?.code === 'invalid_transition' && err.problem.reason === 'deliverables_pending'
        && err.problem.pending_deliverable_ids.length === 2,
    );

    const list = (await listTaskDeliverables({ viewer: viewer(SUB_ORG), store, taskId: DESIGN })).body.items;
    const [truss, calc] = list;

    // The owner cannot submit (not the assignee).
    await assert.rejects(
      submitDeliverable({ viewer: viewer(OWNER_ORG), store, documents, deliverableId: truss.id, body: { document_id: DOC } }),
      (err) => err.problem?.status === 403,
    );
    const submitted = await submitDeliverable({
      viewer: viewer(SUB_ORG), store, documents, deliverableId: truss.id, body: { document_id: DOC, note: 'Spacing 600' },
    });
    assert.equal(submitted.body.status, 'submitted');
    assert.equal(submitted.body.current.sha256, SHA1);

    // The submitter's org never decides; the GC sends it back, then approves v2.
    await assert.rejects(
      approveDeliverable({ viewer: viewer(SUB_ORG), store, deliverableId: truss.id }),
      (err) => err.problem?.status === 403,
    );
    await assert.rejects(
      requestDeliverableChanges({ viewer: viewer(GC_ORG), store, deliverableId: truss.id, body: {} }),
      (err) => Boolean(err.problem?.errors?.comment),
    );
    const back = await requestDeliverableChanges({ viewer: viewer(GC_ORG), store, deliverableId: truss.id, body: { comment: 'Pitch went to 30°' } });
    assert.equal(back.body.status, 'changes_requested');

    // A new version of the document re-submits automatically (F-15).
    versions.set(2, SHA2);
    const uploaded = {
      event_id: randomUUID(), type: 'documents.version.uploaded', project_id: PROJECT,
      actor: { person_id: PERSON, org_id: SUB_ORG }, scope: { type: 'project', id: PROJECT },
      data: { document_id: DOC, version_no: 2, sha256: SHA2, title: 'S-110 Truss details', mime: 'application/pdf', note: 'v2 spacing' },
    };
    await consumers['documents.version.uploaded'](uploaded);
    await consumers['documents.version.uploaded'](uploaded); // replay absorbed
    let truss2 = (await listTaskDeliverables({ viewer: viewer(GC_ORG), store, taskId: DESIGN })).body.items.find((d) => d.id === truss.id);
    assert.equal(truss2.status, 'submitted');
    assert.equal(truss2.current.version_no, 2);
    assert.equal(truss2.history.length, 2);

    const approved = await approveDeliverable({ viewer: viewer(GC_ORG), store, deliverableId: truss.id, body: { comment: 'OK' } });
    assert.equal(approved.body.current.decision.by.org_id, GC_ORG);
    assert.equal(approved.body.current.sha256, SHA2);

    // The approval is write-once on the record.
    await assert.rejects(
      pool.query(`UPDATE planning.deliverable_submission SET decision_comment = 'edited' WHERE id = $1`, [approved.body.current.id]),
      /never changes/,
    );

    // Still blocked by the calc report; a new version after approval goes back to review.
    versions.set(3, '3'.repeat(64));
    await consumers['documents.version.uploaded']({ ...uploaded, event_id: randomUUID(), data: { ...uploaded.data, version_no: 3, sha256: '3'.repeat(64) } });
    truss2 = (await listTaskDeliverables({ viewer: viewer(OWNER_ORG), store, taskId: DESIGN })).body.items.find((d) => d.id === truss.id);
    assert.equal(truss2.status, 'submitted', 'approved → back to review on a new version');
    await approveDeliverable({ viewer: viewer(OWNER_ORG), store, deliverableId: truss.id });

    await submitDeliverable({ viewer: viewer(SUB_ORG), store, documents, deliverableId: calc.id, body: { document_id: DOC, version_no: 3 } });
    // The audience port: reviewers are the client side minus the submitter.
    const audience = await createPlanningAudience(store).deliverableAudience(calc.id, { submitterOrgId: SUB_ORG });
    assert.deepEqual(audience.reviewer_org_ids.sort(), [OWNER_ORG, GC_ORG].sort());
    assert.equal(audience.assignee_org_id, SUB_ORG);
    await approveDeliverable({ viewer: viewer(OWNER_ORG), store, deliverableId: calc.id });

    const summary = (await listTaskDeliverables({ viewer: viewer(SUB_ORG), store, taskId: DESIGN })).body;
    assert.deepEqual([summary.required_count, summary.approved_count, summary.done_blocked], [2, 2, false]);
    const done = await reportProgress({ viewer: viewer(SUB_ORG), store, taskId: DESIGN, body: { status: 'done' } });
    assert.equal(done.status, 201);

    const { rows: events } = await pool.query(
      `SELECT type, count(*)::int AS n FROM platform.outbox WHERE type LIKE 'planning.deliverable.%' GROUP BY type ORDER BY type`,
    );
    assert.deepEqual(events.map((e) => [e.type, e.n]), [
      ['planning.deliverable.approved', 3],
      ['planning.deliverable.changes_requested', 1],
      ['planning.deliverable.submitted', 4],
    ]);
    const { rows: [ledgered] } = await pool.query(
      `SELECT payload FROM record.audit_event WHERE type = 'planning.deliverable.approved' ORDER BY seq LIMIT 1`,
    );
    assert.equal(ledgered.payload.sha256, SHA2);
  });

  test('project read and the task port', async () => {
    const all = await listProjectDeliverables({ viewer: viewer(OWNER_ORG), store, projectId: PROJECT });
    assert.equal(all.body.items.length, 3);
    assert.deepEqual(await createPlanningTaskPort(store).descendantIds(DESIGN), [CHILD]);
    const owners = await createPlanningAudience(store).taskOwners([DESIGN, CHILD]);
    assert.deepEqual(owners.map((o) => o.org_id), [SUB_ORG, SUB_ORG], 'the inherited assignee owns the child row');
  });
});
