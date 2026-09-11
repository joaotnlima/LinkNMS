// Route-level tests for the Slice B2 plan-baseline HTTP surface (LINA-200-BE;
// frozen contract §5). Mirrors http.test.mjs but additionally wires the
// plan-version service so `getPlan` serves the B2 { baseline, current, history }
// shape and the four lifecycle routes are mounted. See plan-version.test.mjs for
// the service-level contract coverage.
//
// Run: node --test services/schedule/plan-version.http.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createScheduleHttp } from './http.mjs';
import { createScheduleService } from './schedule.mjs';
import { createPlanVersionService } from './plan-version.mjs';
import { createInMemoryStore, createInMemoryLedger, createInMemoryIdentity } from './ports.mjs';

const PROJECT = 'proj-1';
const GC = 'gc-1';
const OWNER = 'owner-1';

function build() {
  const store = createInMemoryStore();
  const ledger = createInMemoryLedger();
  const identity = createInMemoryIdentity({
    memberships: [
      { projectId: PROJECT, partyId: OWNER, role: 'owner' },
      { projectId: PROJECT, partyId: GC, role: 'counterparty' },
    ],
  });
  const service = createScheduleService({ store, ledger, identity });
  const planVersion = createPlanVersionService({ store, ledger, identity });
  return { http: createScheduleHttp({ service, planVersion }), store };
}

// Seed a proposed v1 (like the import backfill) authored by the GC.
function seedV1(store) {
  const versionId = randomUUID();
  const createdAt = new Date().toISOString();
  store.insertPlanVersion({}, {
    id: versionId, project_id: PROJECT, version_no: 1, status: 'proposed',
    source_import_id: null, supersedes_version_id: null,
    proposed_by_party_id: GC, created_at: createdAt, frozen_at: null,
  });
  const stageId = randomUUID();
  store.insertStage({}, {
    id: stageId, project_id: PROJECT, name: 'Foundation', position: 1,
    parent_id: null, trade: 'Civil', import_id: null, source_row_ref: null,
    scope_note: null, planned_start_date: '2026-01-05', planned_end_date: '2026-02-02',
    planned_cost_cents: 1_000_000, plan_version_id: versionId,
    created_at: createdAt, updated_at: createdAt,
  });
  store.insertPlanAcceptance({}, {
    id: randomUUID(), plan_version_id: versionId, project_id: PROJECT,
    party_id: GC, kind: 'proposed', stamped_at: createdAt, audit_event_id: randomUUID(),
  });
  return { versionId, stageId };
}

const gc = { partyId: GC };
const owner = { partyId: OWNER };

test('GET /projects/:id/plan returns the B2 { baseline, current, history } shape (contract §5 route 1)', async () => {
  const { http, store } = build();
  seedV1(store);

  const res = await http.getPlan({ session: owner, params: { projectId: PROJECT } });
  assert.equal(res.status, 200);
  assert.equal(res.body.baseline, null);
  assert.equal(res.body.current.status, 'proposed');
  assert.equal(res.body.current.stages[0].name, 'Foundation');
  assert.equal(res.body.history.length, 0);
});

test('POST :withdraw — proposer withdraws → 200 withdrawn; reviewer → 403', async () => {
  const { http, store } = build();
  const { versionId } = seedV1(store);

  const forbidden = await http.withdrawPlan({ session: owner, params: { versionId } });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, 'forbidden');

  const res = await http.withdrawPlan({ session: gc, params: { versionId } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'withdrawn' });
});

test('POST :accept — second stamp freezes → baseline in body; replay is idempotent', async () => {
  const { http, store } = build();
  const { versionId } = seedV1(store);

  const first = await http.acceptPlan({ session: owner, params: { versionId } });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'accepted');
  assert.equal(first.body.baseline.planVersionId, versionId);

  const replay = await http.acceptPlan({ session: owner, params: { versionId } });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);

  // D13 frozen-plan surface: no open proposal → the accepted version renders
  // READ-ONLY as current with its stages + both stamps (LINA-215 #2).
  const view = await http.getPlan({ session: owner, params: { projectId: PROJECT } });
  assert.equal(view.status, 200);
  assert.equal(view.body.baseline.planVersionId, versionId);
  assert.equal(view.body.current.status, 'accepted');
  assert.equal(view.body.current.stages.length, 1);
  assert.equal(view.body.current.stages[0].name, 'Foundation');
  assert.equal(view.body.current.acceptances.length, 2);
  assert.deepEqual(view.body.current.acceptances.map((a) => a.kind).sort(), ['accepted', 'proposed']);
});

test('POST :reject — reviewer rejects with reason → 200; reason too long → 400', async () => {
  const { http, store } = build();
  const { versionId } = seedV1(store);

  const res = await http.rejectPlan({
    session: owner, params: { versionId }, body: { reason: 'needs dates shifted' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'rejected' });

  const { versionId: v2 } = seedV1(store);
  const bad = await http.rejectPlan({ session: owner, params: { versionId: v2 }, body: { reason: 'x'.repeat(2001) } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_reason');
});

test('POST :request-changes — reviewer forks a new proposed version; original superseded', async () => {
  const { http, store } = build();
  const { versionId, stageId } = seedV1(store);

  const res = await http.requestChangesPlan({
    session: owner, params: { versionId },
    body: { stages: [{ stageId, plannedCostCents: 1_200_000 }] },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'proposed');
  assert.equal(res.body.versionNo, 2);
  assert.notEqual(res.body.newVersionId, versionId);

  const view = await http.getPlan({ session: gc, params: { projectId: PROJECT } });
  assert.equal(view.body.current.versionNo, 2);
  assert.equal(view.body.history[0].status, 'superseded');
});

test('unauthenticated B2 action → 401 envelope', async () => {
  const { http, store } = build();
  const { versionId } = seedV1(store);
  const res = await http.acceptPlan({ session: undefined, params: { versionId } });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'unauthenticated');
});

// ── authorPlan (LINA-228) — the handler wires session→actor and maps errors ──

test('authorPlan: 201 with the DRAFT summary; actor from the session, not the body', async () => {
  const { http, store } = build();
  const res = await http.authorPlan({
    session: gc,
    params: { projectId: PROJECT },
    // A forged proposedByPartyId in the body must be inert — the actor is the session.
    body: { proposedByPartyId: OWNER, stages: [
      { name: '1 · Pre-Construction', children: [{ name: '1.1 Planning & Feasibility' }] },
    ] },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'draft');   // saving is private drafting (LINA-230)
  assert.equal(res.body.versionNo, null);
  assert.equal(res.body.stageCount, 2);
  assert.equal(res.body.rootCount, 1);
  const v = store.getPlanVersion(res.body.planVersionId);
  assert.equal(v.proposed_by_party_id, GC); // session actor, never the body
});

test('authorPlan: unauthenticated → 401; empty plan → 400; re-save by the drafter → 201 (same draft)', async () => {
  const { http, store } = build();
  const anon = await http.authorPlan({ session: undefined, params: { projectId: PROJECT }, body: { stages: [{ name: 'A' }] } });
  assert.equal(anon.status, 401);

  const empty = await http.authorPlan({ session: gc, params: { projectId: PROJECT }, body: { stages: [] } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'empty_plan');

  const first = await http.authorPlan({ session: gc, params: { projectId: PROJECT }, body: { stages: [{ name: 'A' }] } });
  assert.equal(first.status, 201);
  // Re-saving the draft is not a conflict — it replaces the single draft in place.
  const again = await http.authorPlan({ session: gc, params: { projectId: PROJECT }, body: { stages: [{ name: 'B' }] } });
  assert.equal(again.status, 201);
  assert.equal(again.body.planVersionId, first.body.planVersionId);
  assert.equal(store.listStagesByPlanVersion(first.body.planVersionId)[0].name, 'B');
});

test('authorPlan: dependency validation errors reach the client with FE-facing details (LINA-233)', async () => {
  const { http } = build();

  const cycle = await http.authorPlan({
    session: gc, params: { projectId: PROJECT },
    body: { stages: [
      { name: 'Framing', key: 'f', dependsOn: ['roof'] },
      { name: 'Roof', key: 'roof', dependsOn: ['f'] },
    ] },
  });
  assert.equal(cycle.status, 409);
  assert.equal(cycle.body.error.code, 'dependency_cycle');
  assert.ok(Array.isArray(cycle.body.error.details.stages));
  assert.deepEqual(cycle.body.error.details.stages.map((s) => s.key).sort(), ['f', 'roof']);

  const unknown = await http.authorPlan({
    session: gc, params: { projectId: PROJECT },
    body: { stages: [{ name: 'A', key: 'a', dependsOn: ['nope'] }] },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'unknown_dependency');
  assert.equal(unknown.body.error.details.key, 'nope');
});

test('proposePlan: 200 flips the draft to proposed; the version id from the path, actor from the session', async () => {
  const { http, store } = build();
  const draft = await http.authorPlan({
    session: gc, params: { projectId: PROJECT },
    body: { stages: [{ name: 'A' }] },
  });

  // The reviewer cannot propose someone else's draft.
  const denied = await http.proposePlan({ session: owner, params: { versionId: draft.body.planVersionId } });
  assert.equal(denied.status, 403);

  const res = await http.proposePlan({ session: gc, params: { versionId: draft.body.planVersionId } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'proposed');
  assert.equal(res.body.versionNo, 1);
  const v = store.getPlanVersion(draft.body.planVersionId);
  assert.equal(v.status, 'proposed');
  assert.equal(v.version_no, 1);
});

// ── assignee (LINA-235, ADR-0017 annex 3) ──────────────────────────────────

test('authorPlan: 201 with assigneePartyId stored; getPlan returns assigneePartyId per stage (LINA-235)', async () => {
  const { http, store } = build();
  const res = await http.authorPlan({
    session: gc,
    params: { projectId: PROJECT },
    body: {
      stages: [
        { name: 'Phase A', assigneePartyId: GC, children: [
          { name: 'Task 1', assigneePartyId: OWNER },
        ] },
      ],
    },
  });
  assert.equal(res.status, 201);

  const view = await http.getPlan({ session: gc, params: { projectId: PROJECT } });
  assert.equal(view.status, 200);
  const phase = view.body.current.stages[0];
  assert.equal(phase.assigneePartyId, GC);
  assert.equal(phase.children[0].assigneePartyId, OWNER);
  assert.equal(phase.children.length, 1); // only Task 1 in the save
});

test('authorPlan: unknown assigneePartyId → 400 unknown_assignee (LINA-235)', async () => {
  const { http } = build();
  const res = await http.authorPlan({
    session: gc, params: { projectId: PROJECT },
    body: { stages: [{ name: 'A', assigneePartyId: 'not-a-party' }] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'unknown_assignee');
});

test('authorPlan: empty/blank assigneePartyId → 400 invalid_assignee (LINA-235)', async () => {
  const { http } = build();
  const res = await http.authorPlan({
    session: gc, params: { projectId: PROJECT },
    body: { stages: [{ name: 'A', assigneePartyId: '  ' }] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_assignee');
});
