// Contract tests for constructor selection and procurement skip (LINA-280;
// ADR-0023 §3; slice-procurement-contract §1 routes 7-8). These exercise the
// phase service against the in-memory ports, which mirror the SQL invariants
// (one-way signed_off, dynamic token validity) in code:
//   - ownership: SELECT_CONSTRUCTOR is owner + counterparty; a subcontractor
//     member is 403 forbidden, an outsider 403 not_member, an anonymous call 401;
//   - selectConstructor({ actorPartyId, projectId, proposalId }) — no body, no
//     phaseId in the path (the wire contract): the proposal must belong to THIS
//     project, its rfp must be `sent` and procurement `active`, the awarded
//     bidder must already be a party (Q3: no zombie parties), then ONE schedule
//     transaction flips procurement → signed_off + execution → active and closes
//     the rfp with the winner marker; the membership is onboarded first;
//   - the RFP token validity join is dynamic: once procurement is signed_off the
//     same recipient query now reports phase_status 'signed_off' (Option A);
//   - skipProcurement({ actorPartyId, projectId }) — same flips, no proposal, a
//     stale `draft` rfp closes WITHOUT a winner; `sent` and closed rfp refuse;
//   - both return the FULL ProcurementView (phase + rfp + recipients + proposals
//     + selectedProposalId), the permanent record of the choice;
//   - the change-order guard (assertExecutionEditable 409 PLAN_LOCKED) and the
//     plan_change_log audit trail still hold after a sign-off.
//
// Run: node --test services/schedule/phases.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInMemoryStore, createInMemoryLedger, createInMemoryIdentity } from './ports.mjs';
import { createPhaseService } from './phases.mjs';
import { createScheduleService } from './schedule.mjs';
import { createPlanVersionService } from './plan-version.mjs';

const now = () => new Date().toISOString();
const PROJECT = 'proj-1';
const GC = 'gc-1';
const OWNER = 'owner-1';
const CONTRACTOR = 'contractor-1';
const OUTSIDER = 'stranger-1';

function build() {
  const store = createInMemoryStore();
  const ledger = createInMemoryLedger();
  const identity = createInMemoryIdentity({
    memberships: [
      { projectId: PROJECT, partyId: OWNER, role: 'owner' },
      { projectId: PROJECT, partyId: GC, role: 'counterparty' },
    ],
  });
  identity._seedParties([{ id: CONTRACTOR, email: 'contractor@example.com' }]);
  const phases = createPhaseService({ store, identity });
  const schedule = createScheduleService({ store, ledger, identity });
  const planVersion = createPlanVersionService({ store, ledger, identity });
  return { store, ledger, identity, phases, schedule, planVersion };
}

function seedPhases(store, { procurement = 'active', execution = 'pending' } = {}) {
  const procurementId = randomUUID();
  const executionId = randomUUID();
  const createdAt = now();
  store.insertPhase({}, {
    id: procurementId, project_id: PROJECT, kind: 'procurement', name: 'Procurement',
    status: procurement, sequence: 1, responsible_party_ids: [], created_at: createdAt, updated_at: createdAt,
  });
  store.insertPhase({}, {
    id: executionId, project_id: PROJECT, kind: 'execution', name: 'Execution',
    status: execution, sequence: 2, responsible_party_ids: [], created_at: createdAt, updated_at: createdAt,
  });
  return { procurementId, executionId };
}

function seedRfp(store, {
  phaseId, rfpId = randomUUID(), status = 'sent', email = 'contractor@example.com',
  recipientId = randomUUID(), proposalId = randomUUID(),
} = {}) {
  store._rfpDefinitions.push({
    id: rfpId, phase_id: phaseId, description: 'RFP', status, specialties: [],
    created_at: now(), updated_at: now(), selected_proposal_id: null,
  });
  store._rfpRecipients.push({
    id: recipientId, rfp_id: rfpId, email, token_hash: 'token-hash-1', status: 'submitted',
  });
  store._rfpProposals.push({
    id: proposalId, rfp_recipient_id: recipientId, company_name: 'BuildCo',
    website_url: 'https://buildco.example.com', portfolio_images: [], comment: 'we build',
    budget_min_cents: 5_000_000, budget_max_cents: 8_000_000, timeline_days: 90,
    submitted_at: now(),
  });
  return { recipientId, proposalId, rfpId };
}

// ── Authorization (§0.1: the actor is the session; §3: owner + counterparty) ─
test('owner and counterparty may select a constructor; an outsider is 403 not_member', async () => {
  const a = build();
  const { procurementId } = seedPhases(a.store);
  seedRfp(a.store, { phaseId: procurementId });
  const view = await a.phases.selectConstructor({
    actorPartyId: OWNER, projectId: PROJECT, proposalId: a.store._rfpProposals[0].id,
  });
  assert.equal(view.phase.status, 'signed_off');

  const b = build();
  const { procurementId: pid2 } = seedPhases(b.store);
  seedRfp(b.store, { phaseId: pid2 });
  await b.phases.selectConstructor({
    actorPartyId: GC, projectId: PROJECT, proposalId: b.store._rfpProposals[0].id,
  });

  await assert.rejects(
    a.phases.selectConstructor({
      actorPartyId: OUTSIDER, projectId: PROJECT, proposalId: a.store._rfpProposals[0].id,
    }),
    (e) => e.status === 403 && e.code === 'not_member',
  );
});

test('a subcontractor member (viewer) is denied selection — SELECT_CONSTRUCTOR is owner/counterparty only', async () => {
  const b = build();
  const subIdentity = createInMemoryIdentity({
    memberships: [
      { projectId: PROJECT, partyId: OWNER, role: 'owner' },
      { projectId: PROJECT, partyId: CONTRACTOR, role: 'subcontractor' },
    ],
  });
  subIdentity._seedParties([{ id: CONTRACTOR, email: 'contractor@example.com' }]);
  const { procurementId } = seedPhases(b.store);
  seedRfp(b.store, { phaseId: procurementId });
  const phases = createPhaseService({ store: b.store, identity: subIdentity });
  await assert.rejects(
    phases.selectConstructor({
      actorPartyId: CONTRACTOR, projectId: PROJECT, proposalId: b.store._rfpProposals[0].id,
    }),
    (e) => e.status === 403,
  );
});

test('an anonymous call is 401 unauthenticated before any lookups', async () => {
  const b = build();
  seedPhases(b.store);
  await assert.rejects(
    b.phases.selectConstructor({ actorPartyId: undefined, projectId: PROJECT, proposalId: randomUUID() }),
    (e) => e.status === 401 && e.code === 'unauthenticated',
  );
});

// ── selectConstructor ────────────────────────────────────────────────────────
test('select opens no rfp window unless the rfp is sent and procurement active', async () => {
  // unknown proposal id → 404 proposal_not_found
  const b = build();
  seedPhases(b.store);
  await assert.rejects(
    b.phases.selectConstructor({ actorPartyId: GC, projectId: PROJECT, proposalId: randomUUID() }),
    (e) => e.status === 404 && e.code === 'proposal_not_found',
  );

  // a `draft` rfp is not an open window → 409 phase_not_active (procurement stays put)
  const c = build();
  const { procurementId: pid } = seedPhases(c.store);
  seedRfp(c.store, { phaseId: pid, status: 'draft' });
  await assert.rejects(
    c.phases.selectConstructor({ actorPartyId: GC, projectId: PROJECT, proposalId: c.store._rfpProposals[0].id }),
    (e) => e.status === 409 && e.code === 'phase_not_active',
  );
  assert.equal(c.store.getPhaseById(pid).status, 'active');
});

test('selectConstructor flips both phases, closes the rfp with a winner, and onboards the bidder — full view', async () => {
  const { store, phases, identity } = build();
  const { procurementId } = seedPhases(store);
  seedRfp(store, { phaseId: procurementId });
  const proposalId = store._rfpProposals[0].id;

  const view = await phases.selectConstructor({ actorPartyId: GC, projectId: PROJECT, proposalId });
  // phase rail
  assert.equal(view.phase.status, 'signed_off');
  // rfp closed with the winner marker persisted
  assert.equal(view.rfp.status, 'closed');
  assert.equal(view.selectedProposalId, proposalId);
  assert.equal(store._rfpDefinitions[0].status, 'closed');
  assert.equal(store._rfpDefinitions[0].selected_proposal_id, proposalId);
  // the accordion payload: recipients + proposals are the permanent record
  assert.equal(view.recipients[0].email, 'contractor@example.com');
  assert.equal(view.proposals[0].companyName, 'BuildCo');
  assert.equal(view.proposals[0].budgetMinCents, 5_000_000);
  assert.equal(view.proposals[0].websiteUrl, 'https://buildco.example.com');
  assert.equal(view.proposals[0].comment, 'we build');
  // execution activated + the bidder seated as a Band-B viewer
  assert.ok(store._phases.find((p) => p.kind === 'execution').status === 'active');
  assert.equal(identity.roleOf(PROJECT, CONTRACTOR), 'subcontractor');
});

test('the RFP token validity join is dynamic — signed_off procurement stops resolving for RFP use', async () => {
  const { store, phases } = build();
  const { procurementId } = seedPhases(store);
  seedRfp(store, { phaseId: procurementId });
  await phases.selectConstructor({
    actorPartyId: GC, projectId: PROJECT, proposalId: store._rfpProposals[0].id,
  });
  const recipient = store.getRecipientByTokenHash('token-hash-1');
  assert.equal(recipient.phase_status, 'signed_off');
});

test('selectConstructor refuses a proposal that does not belong to this project (409 phase_mismatch)', async () => {
  const b = build();
  seedPhases(b.store);
  seedRfp(b.store, { phaseId: randomUUID() }); // phase belongs to another project
  await assert.rejects(
    b.phases.selectConstructor({ actorPartyId: GC, projectId: PROJECT, proposalId: b.store._rfpProposals[0].id }),
    (e) => e.status === 409 && e.code === 'phase_mismatch',
  );
});

test('selectConstructor refuses when the procurement phase is not active (409 phase_not_active)', async () => {
  const b = build();
  const { procurementId } = seedPhases(b.store, { procurement: 'pending' });
  seedRfp(b.store, { phaseId: procurementId });
  await assert.rejects(
    b.phases.selectConstructor({ actorPartyId: GC, projectId: PROJECT, proposalId: b.store._rfpProposals[0].id }),
    (e) => e.status === 409 && e.code === 'phase_not_active',
  );
});

test('selection is one-way: a second award is a 409 already_selected, not a silent overwrite', async () => {
  const b = build();
  const { procurementId } = seedPhases(b.store);
  seedRfp(b.store, { phaseId: procurementId });
  await b.phases.selectConstructor({
    actorPartyId: GC, projectId: PROJECT, proposalId: b.store._rfpProposals[0].id,
  });
  await assert.rejects(
    b.phases.selectConstructor({
      actorPartyId: GC, projectId: PROJECT, proposalId: b.store._rfpProposals[0].id,
    }),
    (e) => e.status === 409 && e.code === 'already_selected',
  );
});

test('selection fails 422 when the awarded bidder has no party identity yet (no zombie parties)', async () => {
  const b = build();
  const { procurementId } = seedPhases(b.store);
  seedRfp(b.store, { phaseId: procurementId, email: 'never-signed-in@example.com' });
  await assert.rejects(
    b.phases.selectConstructor({ actorPartyId: GC, projectId: PROJECT, proposalId: b.store._rfpProposals[0].id }),
    (e) => e.status === 422 && e.code === 'contractor_not_seated',
  );
  // nothing moved: procurement stays active, no membership written
  assert.equal(b.store.getPhaseById(procurementId).status, 'active');
  assert.equal(b.identity.roleOf(PROJECT, CONTRACTOR), null);
});

// ── skipProcurement ──────────────────────────────────────────────────────────
test('skipProcurement flips both phases and closes a stale draft rfp WITHOUT a winner', async () => {
  const b = build();
  const { procurementId } = seedPhases(b.store, { procurement: 'active' });
  seedRfp(b.store, { phaseId: procurementId, status: 'draft' });

  const view = await b.phases.skipProcurement({ actorPartyId: OWNER, projectId: PROJECT });
  assert.equal(view.phase.status, 'signed_off');
  assert.equal(view.rfp.status, 'closed');
  assert.equal(view.selectedProposalId, null); // no award
  assert.equal(b.store._rfpDefinitions[0].selected_proposal_id, null);
  assert.ok(b.store._phases.find((p) => p.kind === 'execution').status === 'active');
  // nothing was onboarded: the contractor is already a member
  assert.equal(b.identity.roleOf(PROJECT, CONTRACTOR), null);
});

test('skipProcurement with no rfp at all (Persona B) still activates execution', async () => {
  const b = build();
  seedPhases(b.store);
  const view = await b.phases.skipProcurement({ actorPartyId: GC, projectId: PROJECT });
  assert.equal(view.phase.status, 'signed_off');
  assert.equal(view.rfp, null);
  assert.equal(view.selectedProposalId, null);
});

test('skipProcurement refuses a sent rfp — the way forward is selecting a proposal (409 rfp_already_sent)', async () => {
  const b = build();
  const { procurementId } = seedPhases(b.store);
  seedRfp(b.store, { phaseId: procurementId, status: 'sent' });
  await assert.rejects(
    b.phases.skipProcurement({ actorPartyId: GC, projectId: PROJECT }),
    (e) => e.status === 409 && e.code === 'rfp_already_sent',
  );
});

test('skipProcurement refuses once selection already happened (409 already_selected)', async () => {
  const b = build();
  const { procurementId } = seedPhases(b.store);
  seedRfp(b.store, { phaseId: procurementId });
  await b.phases.selectConstructor({
    actorPartyId: GC, projectId: PROJECT, proposalId: b.store._rfpProposals[0].id,
  });
  await assert.rejects(
    b.phases.skipProcurement({ actorPartyId: GC, projectId: PROJECT }),
    (e) => e.status === 409 && e.code === 'already_selected',
  );
});

// ── Change-order guard (ADR-0023 §8) ─────────────────────────────────────────
test('after execution signs off, addStage / updateStage / authorPlan refuse with 409 PLAN_LOCKED', async () => {
  const b = build();
  const { executionId } = seedPhases(b.store); // execution active, plan editable
  const { id: stageId } = await b.schedule.addStage(PROJECT, GC, { name: 'Foundations', position: 1, plannedCostCents: 0 });
  // Sign the execution phase off via the store (the phase service does this
  // through selection), then every plan mutation must refuse.
  b.store.updatePhaseStatus({}, executionId, 'signed_off');

  await assert.rejects(
    b.schedule.addStage(PROJECT, GC, { name: 'Roof', position: 2, plannedCostCents: 0 }),
    (e) => e.status === 409 && e.code === 'PLAN_LOCKED',
  );
  await assert.rejects(
    b.schedule.updateStage(stageId, GC, { name: 'Renamed' }),
    (e) => e.status === 409 && e.code === 'PLAN_LOCKED',
  );
  await assert.rejects(
    b.planVersion.authorPlan(PROJECT, GC, { stages: [{ key: 'k1', name: 'A', plannedCostCents: 0 }] }),
    (e) => e.status === 409 && e.code === 'PLAN_LOCKED',
  );
  // nothing else was written to the audit trail while locked
  assert.equal(b.store._planChangeLog.length, 1); // only the pre-lock addStage row
  assert.ok(b.store.getExecutionPhase(PROJECT, null).id === executionId);
});

test('a legacy project with no phase rows mutates exactly as before and writes no audit rows', async () => {
  const b = build();
  await b.schedule.addStage(PROJECT, GC, { name: 'Foundations', position: 1, plannedCostCents: 0 });
  const { id } = await b.schedule.addStage(PROJECT, GC, { name: 'Roof', position: 2, plannedCostCents: 0 });
  await b.schedule.updateStage(id, GC, { name: 'Roofing' });
  await b.planVersion.authorPlan(PROJECT, GC, { stages: [{ key: 'k1', name: 'A', plannedCostCents: 0 }] });
  assert.equal(b.store._planChangeLog.length, 0);
});

// ── plan_change_log audit trail ──────────────────────────────────────────────
test('addStage writes one audit row; updateStage one row per changed field', async () => {
  const b = build();
  const { executionId } = seedPhases(b.store);
  const { id } = await b.schedule.addStage(PROJECT, GC, { name: 'Foundations', position: 1, plannedCostCents: 1_000_000 });
  assert.deepEqual(
    b.store._planChangeLog.map((l) => l.field_name),
    ['created'],
  );
  assert.equal(b.store._planChangeLog[0].phase_id, executionId);

  await b.schedule.updateStage(id, GC, { name: 'Foundations v2', plannedCostCents: 1_100_000 });
  assert.deepEqual(
    b.store._planChangeLog.slice(1).map((l) => [l.entity_id, l.field_name, l.old_value, l.new_value]),
    [
      [id, 'name', 'Foundations', 'Foundations v2'],
      [id, 'planned_cost_cents', 1_000_000, 1_100_000],
    ],
  );
});

test('authorPlan re-save diffs only the changed fields, plus added/removed', async () => {
  const b = build();
  seedPhases(b.store);
  await b.planVersion.authorPlan(PROJECT, GC, {
    stages: [
      { key: 'k1', name: 'Foundation', plannedCostCents: 1_000_000 },
      { key: 'k2', name: 'Frame', plannedCostCents: 2_000_000 },
    ],
  });
  const before = b.store._planChangeLog.length;
  assert.equal(before, 2); // two `added` rows

  await b.planVersion.authorPlan(PROJECT, GC, {
    stages: [
      { key: 'k1', name: 'Foundation deep', plannedCostCents: 1_000_000 },
      { key: 'k3', name: 'Roof', plannedCostCents: 900_000 },
    ],
  });
  const after = b.store._planChangeLog.slice(before);
  assert.deepEqual(
    after.map((l) => [l.field_name, l.old_value?.name ?? l.old_value, l.new_value?.name ?? l.new_value]),
    [
      ['name', 'Foundation', 'Foundation deep'],
      // additions ride the in-order author walk (k3 after k1) …
      ['added', null, 'Roof'],
      // … and removals walk the pre-delete snapshot afterwards (k2).
      ['removed', 'Frame', null],
    ],
  );
});