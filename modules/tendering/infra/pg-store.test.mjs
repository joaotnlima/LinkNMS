// Tendering store over the REAL v2 migrations (throwaway DB, like
// modules/quality). Skipped without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/pg-store.test.mjs
//
// Proves at the database level, per AGENT-INDEX §6 and the phase-6 done
// criterion:
//   #4  every tendering write commits WITH its ledger entry (and outbox
//       event where doc 10 lists one) in ONE transaction — the award proves
//       the hard case: RFP + lanes + the contracting-port contract draft all
//       land or NOTHING does;
//   #6  V8 — lanesForTask hands a bidder only its own lane, IN SQL;
//   D-36 — lanes never enter planning.task; the winner's plan is copied into
//       the plan only at SIGNATURE (planning.bindSignedContract), then
//       baselined with the branch;
// plus: package snapshot carries quantities and no prices (schema-enforced),
// the invite token is stored only as sha256, the doc-09 hand-off
// tendering.rfp.published → project draft → tendering.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createTenderingStore } from './pg-store.mjs';
import { createContractFromAward } from '../../contracting/application/award.mjs';
import { projectConsumers } from '../../project/application/consumers.mjs';
import { createProjectStore } from '../../project/infra/pg-store.mjs';
import { createPlanningStore } from '../../planning/infra/pg-store.mjs';
import { dispatchPending } from '../../../platform/outbox.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the tendering Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_tendering_test';

const OWNER_ORG = randomUUID();
const BIDDER_ORG = randomUUID();
const BIDDER2_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const ROOT_TASK = randomUUID();
const CHILD_TASK = randomUUID();
const ACTOR = { personId: PERSON, orgId: OWNER_ORG, orgRole: 'manager', channel: 'ui' };

describe('tendering store over Postgres (v2 migrations)', { skip }, () => {
  let pg, admin, pool, store;

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
         ($2, 'org_b1', 'contractor', 'Canalizações Norte'),
         ($3, 'org_b2', 'contractor', 'Hidro Maia')`,
      [OWNER_ORG, BIDDER_ORG, BIDDER2_ORG],
    );
    await pool.query(
      `INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES ($1, 'user_ana', 'ana@casa.pt', 'Ana')`,
      [PERSON],
    );
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code, status)
       VALUES ($1, $2, $2, 'Casa Silva', '1306', 'draft')`,
      [PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO project.participation (project_id, org_id, capacity, source)
       VALUES ($1, $2, 'owner', 'project')`,
      [PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO planning.task (id, project_id, parent_id, depth, position, kind, name, specialty) VALUES
         ($1, $3, NULL, 1, 'aa', 'summary', 'Canalização', 'plumbing'),
         ($2, $3, $1, 2, 'aa', 'task', 'Rede de água', 'plumbing')`,
      [ROOT_TASK, CHILD_TASK, PROJECT],
    );
    // Owner estimate line: quantities the package will carry — never prices.
    await pool.query(
      `INSERT INTO contracting.boq_item
         (id, project_id, contract_id, estimate_owner_org_id, task_id, code, description, unit, quantity, unit_price_cents)
       VALUES ($1, $2, NULL, $3, $4, 'C1', 'Tubagem PEX', 'm', 120, 0)`,
      [randomUUID(), PROJECT, OWNER_ORG, CHILD_TASK],
    );
    store = createTenderingStore(pool);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  const RFP = randomUUID();
  let lane1, lane2, token1;

  test('createRfp snapshots the subtree with quantities and NO prices', async () => {
    const snapshot = await store.snapshotPackage(PROJECT, [ROOT_TASK]);
    assert.equal(snapshot.rows.length, 2);
    assert.equal(snapshot.items.length, 1);
    assert.ok(!('unit_price_cents' in snapshot.items[0]));

    const rfp = await store.createRfp({
      id: RFP, projectId: PROJECT, issuerOrgId: OWNER_ORG, level: 'owner',
      parentContractId: null, title: 'Canalização — Casa Silva', scopeText: null,
      visibility: 'invite_only', questionsDeadline: null,
      submissionDeadline: '2027-01-15T17:00:00Z',
      rootTaskIds: [ROOT_TASK], packageRows: snapshot.rows, packageItems: snapshot.items,
      actor: ACTOR,
    });
    assert.equal(rfp.status, 'draft');
    assert.deepEqual(rfp.root_task_ids, [ROOT_TASK]);
    assert.deepEqual(rfp.specialties, ['plumbing']);

    const { rows: ledger } = await pool.query(
      `SELECT type FROM record.audit_event WHERE project_id = $1 AND type = 'tendering.rfp.created'`,
      [PROJECT],
    );
    assert.equal(ledger.length, 1);
  });

  test('addRecipients opens one lane each; only the token HASH is stored', async () => {
    const created = await store.addRecipients({
      rfpId: RFP, projectId: PROJECT,
      recipients: [
        { orgId: BIDDER_ORG, email: 'norte@canal.pt', name: 'Canalizações Norte' },
        { orgId: BIDDER2_ORG, email: 'maia@hidro.pt', name: 'Hidro Maia' },
      ],
      actor: ACTOR,
    });
    assert.equal(created.length, 2);
    token1 = created[0].token;
    assert.match(token1, /^[0-9a-f]{64}$/);
    const { rows } = await pool.query(
      'SELECT token_hash FROM tendering.rfp_recipient WHERE rfp_id = $1 ORDER BY email', [RFP],
    );
    assert.equal(rows.length, 2);
    assert.ok(!rows.some((r) => r.token_hash === token1)); // raw token never at rest

    const lanes = await store.lanesOfRfp(RFP);
    assert.equal(lanes.length, 2);
    [lane1, lane2] = [
      lanes.find((l) => l.bidder_org_id === BIDDER_ORG),
      lanes.find((l) => l.bidder_org_id === BIDDER2_ORG),
    ];
    assert.equal(lane1.status, 'invited');
  });

  test('publish emits the event; the project consumer moves draft → tendering', async () => {
    const published = await store.transitionRfp({
      rfpId: RFP, from: 'draft', to: 'published',
      eventType: 'tendering.rfp.published', projectId: PROJECT,
      data: { visibility: 'invite_only' }, actor: ACTOR,
    });
    assert.equal(published.status, 'published');

    await dispatchPending(pool, projectConsumers(createProjectStore(pool)));
    const { rows } = await pool.query('SELECT status FROM project.project WHERE id = $1', [PROJECT]);
    assert.equal(rows[0].status, 'tendering'); // doc 09 publish_first_rfp
  });

  test('the bidder builds and submits its plan; the revision is recorded', async () => {
    const { items } = await store.packageOf(RFP, 1);
    const row1 = randomUUID();
    const row2 = randomUUID();
    const updated = await store.replaceProposalDoc({
      proposalId: lane1.id, expectedVersion: 1, status: 'draft',
      rows: [
        { id: row1, packagedTaskId: CHILD_TASK, parentRowId: null, kind: 'task', name: 'Rede de água', durationWd: 9, start: '2027-02-01', finish: '2027-02-11', position: '000000' },
        { id: row2, packagedTaskId: null, parentRowId: row1, kind: 'task', name: 'Ensaios de pressão', durationWd: 1, start: '2027-02-12', finish: '2027-02-12', position: '000001' },
      ],
      links: [{ predecessorRow: row1, successorRow: row2, fromAnchor: 'end', toAnchor: 'start', lagWd: 0 }],
      lines: [{ rfpItemId: items[0].id, proposalRowId: row1, isVariant: false, description: 'Tubagem PEX', unit: 'm', quantity: 120, unitPriceCents: 500 }],
      conditions: null, validityUntil: null, documentIds: [],
      totalCents: 60000, durationWd: 9, start: '2027-02-01',
      projectId: PROJECT, rfpId: RFP, actor: { ...ACTOR, orgId: BIDDER_ORG },
    });
    assert.equal(updated.status, 'draft');

    const submitted = await store.submitProposal({
      proposalId: lane1.id, from: 'draft', revision: 1, totalCents: 60000,
      projectId: PROJECT, rfpId: RFP, bidderOrgId: BIDDER_ORG,
      actor: { ...ACTOR, orgId: BIDDER_ORG },
    });
    assert.equal(submitted.status, 'submitted');
    const { rows: revs } = await pool.query(
      'SELECT revision, total_cents FROM tendering.proposal_revision WHERE proposal_id = $1', [lane1.id],
    );
    assert.deepEqual(revs.map((r) => [r.revision, Number(r.total_cents)]), [[1, 60000]]);
    const { rows: rec } = await pool.query(
      'SELECT status FROM tendering.rfp_recipient WHERE id = $1', [lane1.recipient_id],
    );
    assert.equal(rec[0].status, 'proposal_submitted');
  });

  test('V8 in SQL: a bidder reads ONLY its own lane; a stranger none', async () => {
    const issuer = await store.lanesForTask(ROOT_TASK, { viewerOrgId: OWNER_ORG, cursor: null, limit: 50 });
    assert.equal(issuer.items.length, 2);
    const bidder = await store.lanesForTask(ROOT_TASK, { viewerOrgId: BIDDER_ORG, cursor: null, limit: 50 });
    assert.equal(bidder.items.length, 1);
    assert.equal(bidder.items[0].bidder_org_id, BIDDER_ORG);
    assert.equal(bidder.items[0].missing_lines, 0);
    assert.equal(bidder.items[0].has_plan, true);
    const stranger = await store.lanesForTask(ROOT_TASK, { viewerOrgId: BIDDER2_ORG, cursor: null, limit: 50 });
    assert.equal(stranger.items.length, 1); // its own invited lane only
    assert.equal(stranger.items[0].bidder_org_id, BIDDER2_ORG);
  });

  test('§6.4 hard case: a failing award transaction leaves NOTHING behind', async () => {
    await store.transitionRfp({
      rfpId: RFP, from: 'published', to: 'closed',
      eventType: 'tendering.rfp.closed', projectId: PROJECT, data: {}, actor: ACTOR,
    });
    const before = await pool.query('SELECT count(*)::int AS n FROM contracting.contract');
    await assert.rejects(() => store.awardRfp({
      rfpId: RFP, from: 'closed', winnerProposalId: lane1.id,
      declineProposalIds: [lane2.id], note: null, projectId: PROJECT, actor: ACTOR,
      createContract: () => { throw new Error('boom'); },
    }));
    const { rows: [rfp] } = await pool.query('SELECT status FROM tendering.rfp WHERE id = $1', [RFP]);
    assert.equal(rfp.status, 'closed'); // the RFP move rolled back too
    const after = await pool.query('SELECT count(*)::int AS n FROM contracting.contract');
    assert.equal(after.rows[0].n, before.rows[0].n);
  });

  let contractId;

  test('award: one txn — RFP awarded, loser declined, contract draft w/ BoQ', async () => {
    const rfp = await store.getRfp(RFP);
    const winner = (await store.lanesOfRfp(RFP)).find((l) => l.id === lane1.id);
    const award = await store.awardRfp({
      rfpId: RFP, from: 'closed', winnerProposalId: lane1.id,
      declineProposalIds: [lane2.id], note: 'melhor prazo', projectId: PROJECT, actor: ACTOR,
      createContract: (client) => createContractFromAward(client, { rfp, winner, actor: ACTOR }),
    });
    contractId = award.contract.id;
    assert.equal(award.contract.origin, 'award');
    assert.equal(award.contract.origin_proposal_id, lane1.id);
    assert.equal(award.contract.kind, 'direct'); // one specialty → direct (D-35)
    assert.equal(award.valueCents, 60000);

    const { rows: [r] } = await pool.query('SELECT status, awarded_proposal_id FROM tendering.rfp WHERE id = $1', [RFP]);
    assert.equal(r.status, 'awarded');
    assert.equal(r.awarded_proposal_id, lane1.id);
    const { rows: lanes } = await pool.query('SELECT id, status FROM tendering.proposal WHERE rfp_id = $1', [RFP]);
    assert.equal(lanes.find((l) => l.id === lane1.id).status, 'awarded');
    assert.equal(lanes.find((l) => l.id === lane2.id).status, 'declined');
    const { rows: boq } = await pool.query(
      'SELECT task_id, quantity, unit_price_cents FROM contracting.boq_item WHERE contract_id = $1', [contractId],
    );
    assert.equal(boq.length, 1);
    assert.equal(boq[0].task_id, CHILD_TASK);
    assert.equal(Number(boq[0].unit_price_cents), 500);
    const { rows: ledger } = await pool.query(
      `SELECT type FROM record.audit_event WHERE project_id = $1
        AND type IN ('tendering.rfp.awarded','contracting.contract.created') ORDER BY type`,
      [PROJECT],
    );
    assert.deepEqual(ledger.map((l) => l.type), ['contracting.contract.created', 'tendering.rfp.awarded']);
  });

  test('D-36: at SIGNATURE the winner’s plan is copied under the tendered row and baselined', async () => {
    // Lanes never touched planning.task before signature.
    const { rows: [{ n: preRows }] } = await pool.query(
      'SELECT count(*)::int AS n FROM planning.task WHERE project_id = $1', [PROJECT],
    );
    assert.equal(preRows, 2);

    await pool.query(`UPDATE contracting.contract SET status = 'signed' WHERE id = $1`, [contractId]);
    const planning = createPlanningStore(pool);
    const bound = await planning.bindSignedContract({ contractId, projectId: PROJECT, actor: ACTOR });
    assert.equal(bound.bound, true);

    // The bidder's extra row landed under its mapped parent (the child task).
    const { rows: copied } = await pool.query(
      `SELECT name, parent_id, start, finish FROM planning.task
        WHERE project_id = $1 AND last_change_cause = 'awarded_proposal' AND name = 'Ensaios de pressão'`,
      [PROJECT],
    );
    assert.equal(copied.length, 1);
    assert.equal(copied[0].parent_id, CHILD_TASK);
    // The packaged row took the proposal's dates.
    const { rows: [child] } = await pool.query(
      'SELECT start, finish, duration_wd, assignee_org_id, branch_contract_id FROM planning.task WHERE id = $1',
      [CHILD_TASK],
    );
    assert.equal(child.start.toISOString().slice(0, 10), '2027-02-01');
    assert.equal(child.duration_wd, 9);
    assert.equal(child.branch_contract_id, contractId);
    // The tendered root belongs to the supplier now.
    const { rows: [root] } = await pool.query(
      'SELECT assignee_org_id FROM planning.task WHERE id = $1', [ROOT_TASK],
    );
    assert.equal(root.assignee_org_id, BIDDER_ORG);
    // The copied link exists.
    const { rows: links } = await pool.query(
      'SELECT from_anchor, to_anchor FROM planning.link WHERE project_id = $1', [PROJECT],
    );
    assert.equal(links.length, 1);
    // Everything — including the copied row — is in baseline v1.
    const { rows: [bl] } = await pool.query(
      `SELECT count(bt.task_id)::int AS n FROM planning.baseline b
         JOIN planning.baseline_task bt ON bt.baseline_id = b.id
        WHERE b.contract_id = $1 AND b.version = 1`,
      [contractId],
    );
    assert.equal(bl.n, 3); // root + child + copied row
  });

  test('clarification: asked (rfp_private) and answered (event) — asker never on the wire', async () => {
    const id = randomUUID();
    await store.askClarification({
      id, rfpId: RFP, projectId: PROJECT, askedByOrgId: BIDDER_ORG,
      question: 'PEX ou multicamada?', actor: { ...ACTOR, orgId: BIDDER_ORG },
    });
    const answered = await store.answerClarification({
      clarificationId: id, rfpId: RFP, projectId: PROJECT, answer: 'PEX.', actor: ACTOR,
    });
    assert.equal(answered.status, 'answered');
    const { rows } = await pool.query(
      `SELECT scope_type FROM record.audit_event WHERE object_id = $1 ORDER BY seq`, [id],
    );
    assert.deepEqual(rows.map((r) => r.scope_type), ['rfp_private', 'project']);
  });
});
