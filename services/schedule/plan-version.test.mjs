// Contract tests for the Slice B2 plan-version service (LINA-200-BE; frozen
// contract docs/architecture/slice-b2-plan-baseline-contract.md §4–§6; anchors
// ADR-0002, ADR-0004, ADR-0006 §1). These exercise the service against the
// in-memory ports, which faithfully enforce the same invariants the SQL
// migration enforces in production:
//   - proposer-only withdraw; reviewer-only accept/reject/request-changes; a party
//     may not review its own proposal (403) — resolved from the version row;
//   - withdraw/reject/supersede are terminal for a version; only 'proposed' moves;
//   - accept is idempotent-by-state and the SECOND stamp (proposer 'proposed' +
//     reviewer 'accepted') freezes the version → baseline upsert in one txn;
//   - the freeze is DB-enforced (mirrored in the store): a frozen/terminal
//     version's stages cannot be edited;
//   - request-changes forks a new version with dates-and-money-only StageEdits;
//     the original stays visible (superseded);
//   - every transition appends exactly its plan_* ledger event(s), hash-chained.
//
// Run: node --test services/schedule/plan-version.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPlanVersionService } from './plan-version.mjs';
import { createInMemoryStore, createInMemoryLedger, createInMemoryIdentity } from './ports.mjs';
import { computeAppend, verifyChain, GENESIS_HASH } from '../ledger/hash-chain.mjs';

const PROJECT = 'proj-1';
const GC = 'gc-1';
const OWNER = 'owner-1';
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
  const service = createPlanVersionService({ store, ledger, identity });
  return { service, store, ledger, identity };
}

// Seed a proposed v1 authored by `author` (like the import backfill, contract §3)
// with a root + child stage tree and the proposer's 'proposed' authorship stamp.
function seedV1({ store }, { author = GC } = {}) {
  const versionId = randomUUID();
  const createdAt = new Date().toISOString();
  store.insertPlanVersion({}, {
    id: versionId, project_id: PROJECT, version_no: 1, status: 'proposed',
    source_import_id: null, supersedes_version_id: null,
    proposed_by_party_id: author, created_at: createdAt, frozen_at: null,
  });
  const rootId = randomUUID();
  store.insertStage({}, {
    id: rootId, project_id: PROJECT, name: 'Foundation', position: 1,
    parent_id: null, trade: 'Civil', import_id: null, source_row_ref: null,
    scope_note: null, planned_start_date: '2026-01-05', planned_end_date: '2026-02-02',
    planned_cost_cents: 1_000_000, plan_version_id: versionId,
    created_at: createdAt, updated_at: createdAt,
  });
  const childId = randomUUID();
  store.insertStage({}, {
    id: childId, project_id: PROJECT, name: 'Excavate', position: 2,
    parent_id: rootId, trade: 'Civil', import_id: null, source_row_ref: null,
    scope_note: null, planned_start_date: '2026-01-05', planned_end_date: '2026-01-15',
    planned_cost_cents: 400_000, plan_version_id: versionId,
    created_at: createdAt, updated_at: createdAt,
  });
  store.insertPlanAcceptance({}, {
    id: randomUUID(), plan_version_id: versionId, project_id: PROJECT,
    party_id: author, kind: 'proposed', stamped_at: createdAt, audit_event_id: randomUUID(),
  });
  return { versionId, rootId, childId };
}

// ── permissions (contract §6, ADR-0004) ─────────────────────────────────────

test('§6: only the OTHER party (reviewer) may accept/reject/request-changes; own proposal → 403', async () => {
  const { service, store } = build();
  const { versionId } = seedV1({ store });

  // The proposer cannot review its own proposal.
  await assert.rejects(service.accept(versionId, GC), (e) => e.status === 403 && e.code === 'forbidden',
    'proposer may not accept its own proposal');
  await assert.rejects(service.reject(versionId, GC), (e) => e.status === 403 && e.code === 'forbidden');
  await assert.rejects(
    service.requestChanges(versionId, GC, { stages: [] }),
    (e) => e.status === 403 && e.code === 'forbidden');

  // A non-member sees and does nothing (403, not 500).
  await assert.rejects(service.accept(versionId, OUTSIDER), (e) => e.status === 403);

  // The reviewer (owner, the other party) can accept.
  await assert.doesNotReject(service.accept(versionId, OWNER));
});

test('§6: only the proposer may withdraw; a reviewer/non-proposer withdraw → 403, unauthenticated → 401', async () => {
  const { service, store } = build();
  const { versionId } = seedV1({ store });

  await assert.rejects(service.withdraw(versionId, OWNER), (e) => e.status === 403 && e.code === 'forbidden',
    'only the proposer may withdraw');
  await assert.rejects(service.withdraw(versionId, OUTSIDER), (e) => e.status === 403);
  await assert.rejects(service.withdraw(versionId, undefined), (e) => e.status === 401 && e.code === 'unauthenticated');

  await assert.doesNotReject(service.withdraw(versionId, GC));
});

// ── lifecycle transitions + terminality ─────────────────────────────────────

test('withdraw: proposer withdraws an open proposal → terminal withdrawn + one plan_withdrawn event', async () => {
  const { service, store, ledger } = build();
  const { versionId } = seedV1({ store });
  const before = ledger._events.length;

  const res = await service.withdraw(versionId, GC);
  assert.deepEqual(res, { status: 'withdrawn' });

  const events = ledger._events.slice(before);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'plan_withdrawn');
  assert.equal(events[0].actorPartyId, GC);
  assert.deepEqual(events[0].payload, { planVersionId: versionId, versionNo: 1 });

  const v = store.getPlanVersion(versionId);
  assert.equal(v.status, 'withdrawn');

  // Terminal: cannot withdraw/accept/reject/supersede an already-withdrawn version.
  await assert.rejects(service.withdraw(versionId, GC), (e) => e.status === 409 && e.code === 'not_proposed');
  await assert.rejects(service.accept(versionId, OWNER), (e) => e.status === 409);
  await assert.rejects(service.reject(versionId, OWNER), (e) => e.status === 409);
  await assert.rejects(service.requestChanges(versionId, OWNER, { stages: [] }), (e) => e.status === 409);
});

test('reject: reviewer rejects → terminal rejected + one plan_rejected event carrying reason', async () => {
  const { service, store, ledger } = build();
  const { versionId } = seedV1({ store });
  const before = ledger._events.length;

  const res = await service.reject(versionId, OWNER, { reason: 'dates do not fit' });
  assert.deepEqual(res, { status: 'rejected' });
  assert.equal(store.getPlanVersion(versionId).status, 'rejected');

  const events = ledger._events.slice(before);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'plan_rejected');
  assert.deepEqual(events[0].payload, { planVersionId: versionId, versionNo: 1, reason: 'dates do not fit' });

  // Terminal.
  await assert.rejects(service.accept(versionId, OWNER), (e) => e.status === 409);
  await assert.rejects(service.reject(versionId, OWNER), (e) => e.status === 409);
});

test('reject: an oversized reason is a 400 invalid_reason', async () => {
  const { service, store } = build();
  const { versionId } = seedV1({ store });
  await assert.rejects(service.reject(versionId, OWNER, { reason: 'x'.repeat(2001) }),
    (e) => e.status === 400 && e.code === 'invalid_reason');
});

// ── dual acceptance → freeze → baseline (contract §2, D13) ─────────────────

test('accept: reviewer accept is idempotent-by-state and the SECOND stamp freezes → baseline upsert', async () => {
  const { service, store, ledger } = build();
  const { versionId } = seedV1({ store });
  const before = ledger._events.length;

  // The reviewer (owner) accepts. The version already has the proposer's 'proposed'
  // stamp, so this is the second → freeze.
  const res = await service.accept(versionId, OWNER);
  assert.equal(res.status, 'accepted');
  assert.ok(res.baseline, 'the second stamp returns the new baseline');
  assert.equal(res.baseline.planVersionId, versionId);
  assert.equal(res.baseline.versionNo, 1);
  assert.ok(res.baseline.frozenAt);

  const v = store.getPlanVersion(versionId);
  assert.equal(v.status, 'accepted');
  assert.ok(v.frozen_at, 'version frozen at accept time');

  // Both stamps now exist (proposer + reviewer).
  const stamps = store.listPlanAcceptances(versionId);
  assert.equal(stamps.length, 2);
  assert.deepEqual(stamps.map((s) => s.kind).sort(), ['accepted', 'proposed']);

  // Baseline pointer + the events appended in the ONE accept txn: plan_accepted
  // then baseline_frozen.
  const baseline = store.getProjectBaseline(PROJECT);
  assert.equal(baseline.plan_version_id, versionId);
  assert.equal(baseline.version_no, 1);

  const events = ledger._events.slice(before);
  assert.deepEqual(events.map((e) => e.type), ['plan_accepted', 'baseline_frozen']);
  assert.deepEqual(events[0].payload, { planVersionId: versionId, versionNo: 1, kind: 'accepted' });
  assert.equal(events[0].actorPartyId, OWNER);
  assert.deepEqual(events[1].payload, {
    planVersionId: versionId, versionNo: 1,
    proposedByPartyId: GC, acceptedByPartyId: OWNER,
  });
});

test('accept: idempotent-by-state — accepting a version a party already froze returns current state, writes nothing', async () => {
  const { service, store, ledger } = build();
  const { versionId } = seedV1({ store });

  const first = await service.accept(versionId, OWNER);
  const eventsAfterFirst = ledger._events.length;

  const second = await service.accept(versionId, OWNER);
  assert.deepEqual(second, first, 'the retry returns the same frozen result');
  assert.equal(ledger._events.length, eventsAfterFirst, 'no new events on the replay');
});

test('accept: freezing makes the version stages immutable — a stage edit is rejected by the guard', async () => {
  const { service, store } = build();
  const { versionId, rootId } = seedV1({ store });
  await service.accept(versionId, OWNER);

  // Direct store edit (and any service path) is rejected by the freeze guard,
  // mirroring the DB stage_freeze_guard trigger (ADR-0002 §4).
  await assert.rejects(async () => store.updateStage({}, rootId, { planned_cost_cents: 5_000_000 }),
    (e) => e.code === 'P0001',
    'the DB-enforced freeze is mirrored in the store');
});

test('getPlan: accepted version stays as current so the frozen plan renders (LINA-215 #2)', async () => {
  const { service, store } = build();
  const { versionId } = seedV1({ store });
  await service.accept(versionId, OWNER);

  const view = await service.getPlan(PROJECT, OWNER);
  assert.equal(view.baseline.planVersionId, versionId);
  // No open proposal → the accepted baseline renders READ-ONLY as current: the
  // D13 frozen plan surface (stages + both stamps) must never disappear.
  assert.equal(view.current.versionNo, 1);
  assert.equal(view.current.status, 'accepted');
  assert.ok(view.current.frozenAt, 'the dismissed banner carries the freeze time');
  assert.equal(view.current.stages.length, 1);
  assert.equal(view.current.stages[0].name, 'Foundation');
  assert.equal(view.current.stages[0].children[0].name, 'Excavate', 'the frozen WBS tree renders on current');
  assert.equal(view.current.acceptances.length, 2, 'D13 shows both stamps on current');
  assert.deepEqual(view.current.acceptances.map((a) => a.kind).sort(), ['accepted', 'proposed']);
  assert.equal(view.history.length, 0, 'the accepted baseline is the plan, not a history entry');
});

// ── request-changes fork (contract §1, §5 → D12a) ──────────────────────────

test("store: one 'proposed' version per project (mirror of plan_version_one_open_per_project)", async () => {
  const { store } = build();
  seedV1({ store });

  await assert.throws(
    () => store.insertPlanVersion({}, {
      id: randomUUID(), project_id: PROJECT, version_no: 2, status: 'proposed',
      source_import_id: null, supersedes_version_id: null,
      proposed_by_party_id: OWNER, created_at: new Date().toISOString(), frozen_at: null,
    }),
    (e) => e.code === '23505' && e.constraint === 'plan_version_one_open_per_project',
  );

  // A terminal version frees the slot: the same insert now lands.
  store.updatePlanVersionStatus({}, store._versions[0].id, { status: 'withdrawn' });
  assert.doesNotThrow(
    () => store.insertPlanVersion({}, {
      id: randomUUID(), project_id: PROJECT, version_no: 2, status: 'proposed',
      source_import_id: null, supersedes_version_id: null,
      proposed_by_party_id: OWNER, created_at: new Date().toISOString(), frozen_at: null,
    }),
  );
});

test('request-changes: forks a new version the reviewer authors; original stays visible superseded', async () => {
  const { service, store, ledger } = build();
  const { versionId, rootId, childId } = seedV1({ store });
  const before = ledger._events.length;

  const res = await service.requestChanges(versionId, OWNER, {
    stages: [
      { stageId: rootId, plannedStartDate: '2026-02-01', plannedCostCents: 1_200_000 },
      { stageId: childId, plannedEndDate: '2026-01-20' },
    ],
  });
  assert.equal(res.status, 'proposed');
  assert.equal(res.versionNo, 2);
  assert.notEqual(res.newVersionId, versionId);

  // Original is superseded but still visible, untouched.
  const original = store.getPlanVersion(versionId);
  assert.equal(original.status, 'superseded');
  const originalRoot = store.getStage(rootId);
  assert.equal(originalRoot.planned_start_date, '2026-01-05', 'original stages untouched');
  assert.equal(originalRoot.planned_cost_cents, 1_000_000);

  // New version authored by the reviewer (roles swap), with its stamps and a fork
  // of the stages carrying the dates-and-money-only patch.
  const fork = store.getPlanVersion(res.newVersionId);
  assert.equal(fork.proposed_by_party_id, OWNER);
  assert.equal(fork.supersedes_version_id, versionId);

  const forkStages = store.listStagesByPlanVersion(res.newVersionId);
  assert.equal(forkStages.length, 2);
  const forkRoot = forkStages.find((s) => s.name === 'Foundation');
  const forkChild = forkStages.find((s) => s.name === 'Excavate');
  assert.equal(forkRoot.planned_start_date, '2026-02-01', 'root edit applied');
  assert.equal(forkRoot.planned_cost_cents, 1_200_000);
  assert.equal(forkRoot.planned_end_date, '2026-02-02', 'unedited fields copied through');
  assert.equal(forkChild.planned_end_date, '2026-01-20', 'child edit applied');
  assert.equal(forkChild.parent_id, forkRoot.id, 'WBS parent remapped to the fork stage');
  assert.equal(forkChild.planned_cost_cents, 400_000);

  // The two ledger events for the fork txn: plan_change_requested + plan_proposed.
  const events = ledger._events.slice(before);
  assert.deepEqual(events.map((e) => e.type), ['plan_change_requested', 'plan_proposed']);
  assert.deepEqual(events[0].payload, {
    fromVersionId: versionId, fromVersionNo: 1, newVersionId: res.newVersionId, newVersionNo: 2,
  });
  assert.deepEqual(events[1].payload, {
    planVersionId: res.newVersionId, versionNo: 2,
    sourceImportId: null, supersedesVersionId: versionId, stageCount: 2,
  });
  assert.equal(events[1].actorPartyId, OWNER);

  // The fork's proposer stamp is the reviewer's 'proposed' authorship stamp.
  const forkStamps = store.listPlanAcceptances(res.newVersionId);
  assert.equal(forkStamps.length, 1);
  assert.equal(forkStamps[0].kind, 'proposed');
  assert.equal(forkStamps[0].party_id, OWNER);
});

test('request-changes: the reviewer of the ORIGINAL becomes the proposer; the original author may then accept', async () => {
  const { service, store } = build();
  const { versionId } = seedV1({ store });
  const { newVersionId } = await service.requestChanges(versionId, OWNER, {
    stages: [{ stageId: store.listStagesByPlanVersion(versionId)[0].id, plannedCostCents: 1_999_999 }],
  });

  // The old proposer (GC) is now the reviewer of the fork and may accept.
  const res = await service.accept(newVersionId, GC);
  assert.equal(res.status, 'accepted');
  assert.ok(res.baseline);
});

test('request-changes: a structural edit (name) or unknown stage is a 400', async () => {
  const { service, store } = build();
  const { versionId, rootId } = seedV1({ store });

  await assert.rejects(
    service.requestChanges(versionId, OWNER, { stages: [{ stageId: rootId, name: 'Renamed' }] }),
    (e) => e.status === 400 && e.code === 'invalid_stages',
  );
  await assert.rejects(
    service.requestChanges(versionId, OWNER, { stages: [{ stageId: 'nope', plannedCostCents: 5 }] }),
    (e) => e.status === 400 && e.code === 'unknown_stage',
  );
  await assert.rejects(
    service.requestChanges(versionId, OWNER, {}),
    (e) => e.status === 400 && e.code === 'invalid_stages',
  );
  await assert.rejects(
    service.requestChanges(versionId, OWNER, { stages: [] }),
    (e) => e.status === 400 && e.code === 'invalid_stages',
  );
});

// ── hash-chain: the new event types verify (contract §4, ADR-0002) ──────────

test('ADR-0002: the committed plan lifecycle events form a verifiable hash chain', async () => {
  const { service, store, ledger } = build();
  const { versionId, rootId } = seedV1({ store });

  // Exercise the full lifecycle: request-changes fork → review fork → accept.
  const fork = await service.requestChanges(versionId, OWNER, {
    stages: [{ stageId: rootId, plannedCostCents: 1_200_000 }],
  });
  await service.accept(fork.newVersionId, GC);

  // The in-memory ledger keeps raw event meanings; chain them the way pg.append
  // does, then prove the whole chain verifies across the new plan_* types (and
  // plan_proposed stageIds/payloads reproduce — the hash-bound content).
  const chain = [];
  let prev = null;
  for (const e of ledger._events) {
    const appended = computeAppend(prev, e);
    chain.push(appended);
    prev = appended;
  }
  assert.equal(chain[0].prevHash, GENESIS_HASH);
  assert.deepEqual(verifyChain(chain), { verified: true },
    'chain-verify stays green across plan_change_requested/plan_proposed/plan_accepted/baseline_frozen');

  const types = chain.map((e) => e.type);
  assert.ok(types.includes('plan_change_requested'));
  assert.ok(types.includes('plan_proposed'));
  assert.ok(types.includes('plan_accepted'));
  assert.ok(types.includes('baseline_frozen'));
});

// ── getPlan shape (contract §5 route 1: { baseline, current, history }) ─────

test('getPlan: proposed version renders current with its WBS tree + acceptances; outsider denied', async () => {
  const { service, store } = build();
  const { versionId } = seedV1({ store });

  const view = await service.getPlan(PROJECT, OWNER);
  assert.equal(view.baseline, null);
  assert.equal(view.current.versionNo, 1);
  assert.equal(view.current.status, 'proposed');
  assert.equal(view.current.acceptances.length, 1);
  assert.equal(view.current.acceptances[0].kind, 'proposed');
  assert.equal(view.current.acceptances[0].partyId, GC);
  assert.equal(view.current.stages[0].name, 'Foundation');
  assert.equal(view.current.stages[0].children[0].name, 'Excavate');
  assert.equal(view.history.length, 0);

  await assert.rejects(service.getPlan(PROJECT, OUTSIDER), (e) => e.status === 403);
});

// ── authorPlan — direct "build it here" authoring (LINA-228, ADR-0017) ──────

// A two-phase skeleton like the FE seeds: actions with sub-actions, names only.
const SKELETON = [
  { name: '1 · Pre-Construction', children: [
    { name: '1.1 Planning & Feasibility' },
    { name: '1.2 Design & Engineering' },
  ] },
  { name: '2 · Construction', children: [
    { name: '2.1 Preliminary Works' },
  ] },
];

test('authorPlan: saves a DRAFT (not a proposal) — one plan_drafted event, NO stamp, unnumbered, bound stages', async () => {
  const { service, store, ledger } = build();

  const out = await service.authorPlan(PROJECT, GC, { stages: SKELETON });
  assert.equal(out.status, 'draft');
  assert.equal(out.versionNo, null);       // unnumbered until proposed (LINA-230)
  assert.equal(out.stageCount, 5);
  assert.equal(out.rootCount, 2);
  assert.ok(out.planVersionId && out.auditEventId);

  // Exactly one ledger event, typed plan_drafted — NOT plan_proposed.
  const events = ledger._events.filter((e) => e.projectId === PROJECT);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'plan_drafted');
  assert.equal(events[0].payload.sourceImportId, null);
  assert.equal(events[0].payload.stageCount, 5);
  assert.equal(events[0].payload.versionNo, undefined); // a draft has no number

  // No authorship stamp is written while drafting (the 'proposed' stamp comes at
  // :propose, pairing with the reviewer's accept to freeze).
  assert.equal(store.listPlanAcceptances(out.planVersionId).length, 0);

  // The author sees their own editable draft; the stored version is 'draft'.
  const v = store.getPlanVersion(out.planVersionId);
  assert.equal(v.status, 'draft');
  assert.equal(v.version_no, null);
  assert.equal(v.proposed_by_party_id, GC);

  const mine = await service.getPlan(PROJECT, GC);
  assert.equal(mine.current.id, out.planVersionId);
  assert.equal(mine.current.status, 'draft');
  assert.equal(mine.current.stages.length, 2);
  assert.equal(mine.current.stages[0].children[0].name, '1.1 Planning & Feasibility');
});

test('authorPlan: a task description is stored, validated (≤4000), and read back through getPlan (LINA-234)', async () => {
  const { service } = build();

  const out = await service.authorPlan(PROJECT, GC, {
    stages: [
      { name: 'Phase A', children: [
        { name: 'Task 1', description: '  Pour the slab; 28-day cure.  ' }, // trimmed on the way in
        { name: 'Task 2' },                                                 // no description → null
      ] },
    ],
  });
  assert.equal(out.status, 'draft');

  const view = await service.getPlan(PROJECT, GC);
  const tasks = view.current.stages[0].children;
  assert.equal(tasks[0].description, 'Pour the slab; 28-day cure.');
  assert.equal(tasks[1].description, null);

  // Re-save (draft replace) with an edited description sticks.
  await service.authorPlan(PROJECT, GC, {
    stages: [{ name: 'Phase A', children: [{ name: 'Task 1', description: 'Edited body' }] }],
  });
  const view2 = await service.getPlan(PROJECT, GC);
  assert.equal(view2.current.stages[0].children[0].description, 'Edited body');

  // A description over the cap is refused, not truncated.
  await assert.rejects(
    service.authorPlan(PROJECT, GC, {
      stages: [{ name: 'Phase A', children: [{ name: 'T', description: 'x'.repeat(4001) }] }],
    }),
    (e) => e.status === 400 && e.code === 'invalid_stages',
  );
});

test('authorPlan: the draft is INVISIBLE to the other party — no current, no history', async () => {
  const { service } = build();
  await service.authorPlan(PROJECT, GC, { stages: SKELETON });
  const theirs = await service.getPlan(PROJECT, OWNER);
  assert.equal(theirs.current, null);
  assert.equal(theirs.baseline, null);
  assert.equal(theirs.history.length, 0);
});

test('authorPlan: re-saving REPLACES the draft in place — same version, new stages, a second plan_drafted event', async () => {
  const { service, store, ledger } = build();
  const first = await service.authorPlan(PROJECT, GC, { stages: SKELETON });

  const out = await service.authorPlan(PROJECT, GC, { stages: [
    { name: 'Only phase', children: [{ name: 'Only task' }] },
  ] });
  assert.equal(out.planVersionId, first.planVersionId); // same draft row
  assert.equal(out.status, 'draft');
  assert.equal(out.stageCount, 2);

  // The old 5 stages are gone; only the 2 re-saved remain bound to the draft.
  assert.equal(store.listStagesByPlanVersion(first.planVersionId).length, 2);

  // Two plan_drafted events (one per save) — an honest "saved at T" trail.
  const drafted = ledger._events.filter((e) => e.type === 'plan_drafted');
  assert.equal(drafted.length, 2);
  // Still no stamp, still exactly one draft version for the project.
  assert.equal(store.listPlanAcceptances(first.planVersionId).length, 0);
  assert.equal(store._versions.filter((x) => x.status === 'draft').length, 1);
});

test('authorPlan: only the drafting party may replace the draft (other party → 409, invisible)', async () => {
  const { service } = build();
  await service.authorPlan(PROJECT, GC, { stages: SKELETON });
  await assert.rejects(service.authorPlan(PROJECT, OWNER, { stages: SKELETON }),
    (e) => e.status === 409 && e.code === 'draft_exists');
});

test('proposePlan: draft → proposed — assigns v1, one plan_proposed event, the authorship stamp, now visible', async () => {
  const { service, store, ledger } = build();
  const draft = await service.authorPlan(PROJECT, GC, { stages: SKELETON });

  const out = await service.proposePlan(draft.planVersionId, GC);
  assert.equal(out.status, 'proposed');
  assert.equal(out.versionNo, 1);
  assert.equal(out.planVersionId, draft.planVersionId);

  // The draft event THEN the proposal event — distinct, in order (acceptance §4).
  const types = ledger._events.filter((e) => e.projectId === PROJECT).map((e) => e.type);
  assert.deepEqual(types, ['plan_drafted', 'plan_proposed']);

  // The authorship 'proposed' stamp is written now, keyed to the proposal event.
  const stamps = store.listPlanAcceptances(draft.planVersionId);
  assert.equal(stamps.length, 1);
  assert.equal(stamps[0].kind, 'proposed');
  assert.equal(stamps[0].party_id, GC);
  assert.equal(stamps[0].audit_event_id, out.auditEventId);

  // Now the other party sees it and can review; v1 is numbered.
  const theirs = await service.getPlan(PROJECT, OWNER);
  assert.equal(theirs.current.id, draft.planVersionId);
  assert.equal(theirs.current.status, 'proposed');
  assert.equal(theirs.current.versionNo, 1);

  // The reviewer accepts → 2nd stamp freezes the baseline.
  const accepted = await service.accept(draft.planVersionId, OWNER);
  assert.equal(accepted.status, 'accepted');
});

test('proposePlan: only the drafter may propose; non-draft → 409; unknown → 404', async () => {
  const { service } = build();
  const draft = await service.authorPlan(PROJECT, GC, { stages: SKELETON });

  await assert.rejects(service.proposePlan(draft.planVersionId, OWNER),
    (e) => e.status === 403 && e.code === 'forbidden');
  await assert.rejects(service.proposePlan(randomUUID(), GC), (e) => e.status === 404);

  await service.proposePlan(draft.planVersionId, GC);
  // Already proposed — proposing again is a 409, not a second proposal.
  await assert.rejects(service.proposePlan(draft.planVersionId, GC),
    (e) => e.status === 409 && e.code === 'not_draft');
});

test('authorPlan: either party may author (owner too) — then proposes and the OTHER party reviews', async () => {
  const { service, store } = build();
  const draft = await service.authorPlan(PROJECT, OWNER, { stages: SKELETON });
  assert.equal(draft.status, 'draft');
  const v = store.getPlanVersion(draft.planVersionId);
  assert.equal(v.proposed_by_party_id, OWNER);

  const out = await service.proposePlan(draft.planVersionId, OWNER);
  assert.equal(out.status, 'proposed');
  // The GC (the other party) can then review; the owner-proposer cannot.
  await assert.rejects(service.accept(out.planVersionId, OWNER), (e) => e.status === 403);
  const afterFirst = await service.accept(out.planVersionId, GC);
  assert.equal(afterFirst.status, 'accepted');
});

test('authorPlan: optional dates/cost/trade are carried through to the draft', async () => {
  const { service } = build();
  await service.authorPlan(PROJECT, GC, { stages: [
    { name: 'Roof', trade: 'Roofing', plannedStartDate: '2026-03-01', plannedEndDate: '2026-03-20', plannedCostCents: 250000,
      children: [{ name: 'Trusses', plannedStartDate: '2026-03-01', plannedEndDate: '2026-03-05' }] },
  ] });
  const view = await service.getPlan(PROJECT, GC);
  const roof = view.current.stages[0];
  assert.equal(roof.trade, 'Roofing');
  assert.equal(roof.plannedStartDate, '2026-03-01');
  assert.equal(roof.plannedCostCents, 250000);
  assert.equal(roof.children[0].plannedEndDate, '2026-03-05');
});

test('authorPlan: outsider is denied (403), never a 500', async () => {
  const { service } = build();
  await assert.rejects(service.authorPlan(PROJECT, OUTSIDER, { stages: SKELETON }),
    (e) => e.status === 403 && e.code === 'forbidden');
});

test('authorPlan: validation — empty, nameless, too-deep, bad date', async () => {
  const { service } = build();
  await assert.rejects(service.authorPlan(PROJECT, GC, { stages: [] }),
    (e) => e.status === 400 && e.code === 'empty_plan');
  await assert.rejects(service.authorPlan(PROJECT, GC, { stages: [{ name: '   ' }] }),
    (e) => e.status === 400 && e.code === 'invalid_name');
  // Three levels are allowed (LINA-238); a FOURTH level is the too_deep line.
  await assert.rejects(service.authorPlan(PROJECT, GC, { stages: [
    { name: 'A', children: [{ name: 'B', children: [{ name: 'C', children: [{ name: 'D' }] }] }] },
  ] }), (e) => e.status === 400 && e.code === 'too_deep');
  await assert.rejects(service.authorPlan(PROJECT, GC, { stages: [
    { name: 'A', plannedStartDate: '03/01/2026' },
  ] }), (e) => e.status === 400 && e.code === 'invalid_plannedStartDate');
});

test('authorPlan: a 3rd WBS level (sub-sub-action) is accepted and round-trips through getPlan (LINA-238)', async () => {
  const { service } = build();
  const draft = await service.authorPlan(PROJECT, GC, { stages: [
    { name: '2 · Construction', children: [
      { name: '2.6 Plumbing', children: [
        { name: '2.6.1 Rough-in', plannedStartDate: '2026-04-01', plannedEndDate: '2026-04-10' },
        { name: '2.6.2 Fixtures' },
      ] },
    ] },
  ] });
  // stageCount counts every node at every level — four here (1 phase, 1 sub, 2 sub-sub).
  assert.equal(draft.stageCount, 4);

  const view = await service.getPlan(PROJECT, GC);
  const phase = view.current.stages[0];
  assert.equal(phase.name, '2 · Construction');
  const sub = phase.children[0];
  assert.equal(sub.name, '2.6 Plumbing');
  assert.equal(sub.children.length, 2, 'the sub-action carries its two sub-sub-actions');
  assert.equal(sub.children[0].name, '2.6.1 Rough-in');
  assert.equal(sub.children[0].plannedStartDate, '2026-04-01');
  assert.equal(sub.children[1].name, '2.6.2 Fixtures');
});

test('authorPlan: drafting while a proposal is already open is a clean 409', async () => {
  const { service } = build();
  const draft = await service.authorPlan(PROJECT, GC, { stages: SKELETON });
  await service.proposePlan(draft.planVersionId, GC);
  await assert.rejects(service.authorPlan(PROJECT, GC, { stages: SKELETON }),
    (e) => e.status === 409 && e.code === 'open_plan_exists');
});

// ── authorPlan dependencies (LINA-233, ADR-0017 annex 2) ────────────────────

test('authorPlan: key + dependsOn persist as stage_dependency rows, resolved in-tx; getPlan returns predecessor ids (LINA-233)', async () => {
  const { service, store, ledger } = build();

  const out = await service.authorPlan(PROJECT, GC, {
    stages: [
      { name: 'Foundation', key: 'foundation' },
      { name: 'Framing', key: 'framing', dependsOn: ['foundation'] },
      { name: 'Roof', key: 'roof', dependsOn: ['framing'] },
    ],
  });
  assert.equal(out.status, 'draft');

  // Exactly the one plan_drafted event — a dependency edit is part of "the draft
  // saved at T", NO new ledger event type (annex 2 §1).
  const events = ledger._events.filter((e) => e.projectId === PROJECT && e.type === 'plan_drafted');
  assert.equal(events.length, 1);

  // Two dependency rows for the draft (the keys resolved to the fresh stage ids).
  const deps = store.listStageDependenciesByPlanVersion(out.planVersionId);
  assert.equal(deps.length, 2);

  // getPlan resolves each stage's predecessors to stage ids the FE can join back
  // onto the rendered tree for predecessor chips.
  const view = await service.getPlan(PROJECT, GC);
  const [foundation, framing, roof] = view.current.stages;
  assert.deepEqual(foundation.dependsOn, []);
  assert.deepEqual(framing.dependsOn, [foundation.id]);
  assert.deepEqual(roof.dependsOn, [framing.id]);
});

test('authorPlan: dependencies may be cross-level — any distinct stage is a valid target (annex 2 §2)', async () => {
  const { service } = build();

  // A sub-action "2.1 Preliminary Works" deps on the ROOT "1 · Pre-Construction";
  // a later root "2 · Construction" deps on the EARLIER root's child task. No
  // level/parent constraint — only self, unknown and cycles are rejected.
  await assert.doesNotReject(service.authorPlan(PROJECT, GC, {
    stages: [
      { name: '1 · Pre-Construction', key: 'pre', children: [
        { name: '1.2 Design & Engineering', key: 'design' },
      ] },
      { name: '2 · Construction', key: 'construction', dependsOn: ['design'] },
      { name: '3 · Inspections', key: 'inspections', children: [
        { name: '3.1 Inspect', key: 'inspect', dependsOn: ['construction'] },
      ] },
    ],
  }));

const view = await service.getPlan(PROJECT, GC);
const [, construction, inspections] = view.current.stages;
const inspectTask = inspections.children[0];
assert.deepEqual(construction.dependsOn, [view.current.stages[0].children[0].id],
  'a root may depend on any stage, including a sibling phase\u2019s sub-action');
assert.deepEqual(inspectTask.dependsOn, [construction.id], 'a sub-action may depend on a root');
});

test('authorPlan: self_dependency is a 400, named before resolution', async () => {
  const { service, store, ledger } = build();
  await assert.rejects(service.authorPlan(PROJECT, GC, {
    stages: [
      { name: 'Foundation', key: 'f', dependsOn: ['f'] },
    ],
  }), (e) => e.status === 400 && e.code === 'self_dependency');

  // Total validation — nothing was written (no stage, no draft version).
  assert.equal(store._versions.length, 0);
  assert.equal(store._stages.size, 0);
  assert.equal(ledger._events.length, 0);
});

test('authorPlan: unknown_dependency is a 400 naming the missing key', async () => {
  const { service } = build();
  await assert.rejects(service.authorPlan(PROJECT, GC, {
    stages: [
      { name: 'Foundation', key: 'f' },
      { name: 'Framing', key: 'fr', dependsOn: ['geology'] },
    ],
  }), (e) => e.status === 400 && e.code === 'unknown_dependency'
    && e.details.key === 'geology' && e.details.stage.name === 'Framing');
});

test('authorPlan: duplicate_key is a 400 (keys are author-local ids, unique per payload)', async () => {
  const { service } = build();
  await assert.rejects(service.authorPlan(PROJECT, GC, {
    stages: [
      { name: 'A', key: 'shared' },
      { name: 'B', key: 'shared' },
    ],
  }), (e) => e.status === 400 && e.code === 'duplicate_key');
});

test('authorPlan: dependency_cycle is a 409 (DFS back-edge) naming the stages on the cycle, before any write', async () => {
  const { service, store, ledger } = build();
  await assert.rejects(service.authorPlan(PROJECT, GC, {
    stages: [
      { name: 'A', key: 'a', dependsOn: ['c'] },
      { name: 'B', key: 'b', dependsOn: ['a'] },
      { name: 'C', key: 'c', dependsOn: ['b'] },
    ],
  }), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'dependency_cycle');
    const cycle = e.details.stages.map((s) => s.key);
    assert.deepEqual([...cycle].sort(), ['a', 'b', 'c'],
      'the error names every stage on the offending cycle for the FE to highlight');
    assert.ok(e.details.stages.every((s) => typeof s.name === 'string'));
    return true;
  });

  // Total, server-side, BEFORE any write: no stage, no version, no ledger event.
  assert.equal(store._versions.length, 0);
  assert.equal(store._stages.size, 0);
  assert.equal(ledger._events.length, 0);
});

test('authorPlan: an A→B→A two-node cycle is also caught', async () => {
  const { service } = build();
  await assert.rejects(service.authorPlan(PROJECT, GC, {
    stages: [
      { name: 'Framing', key: 'f', dependsOn: ['roof'] },
      { name: 'Roof', key: 'roof', dependsOn: ['f'] },
    ],
  }), (e) => e.status === 409 && e.code === 'dependency_cycle');
});

test('authorPlan: re-save REPLACES the dependency graph atomically (no orphan rows, no FK clash)', async () => {
  const { service, store, ledger } = build();

  const first = await service.authorPlan(PROJECT, GC, {
    stages: [
      { name: 'Foundation', key: 'f' },
      { name: 'Framing', key: 'fr', dependsOn: ['f'] },
    ],
  });

  // Re-save with a different stage set AND a different graph — the draft's
  // dependency rows must be deleted with its stages (the FK would otherwise fail).
  const out = await service.authorPlan(PROJECT, GC, {
    stages: [
      { name: 'Excavate', key: 'ex' },
      { name: 'Haul', key: 'haul', dependsOn: ['ex'] },
      { name: 'Backfill', key: 'back', dependsOn: ['ex'] },
    ],
  });
  assert.equal(out.planVersionId, first.planVersionId, 'same draft row re-saved in place');

  // The graph is EXACTLY the latest one — atomic replace, nothing cumulative.
  const deps = store.listStageDependenciesByPlanVersion(first.planVersionId);
  assert.equal(deps.length, 2, 'the two latest edges; the old edge is gone');

  const view = await service.getPlan(PROJECT, GC);
  const [excavate, haul, backfill] = view.current.stages;
  assert.deepEqual(excavate.dependsOn, []);
  assert.deepEqual(haul.dependsOn, [excavate.id]);
  assert.deepEqual(backfill.dependsOn, [excavate.id]);

  // Two plan_drafted events (one per save) — the ledger stays honest, no new type.
  assert.equal(ledger._events.filter((e) => e.type === 'plan_drafted').length, 2);
});

test('authorPlan: dependencies survive :propose and render on the frozen-proposal read (still stage ids)', async () => {
  const { service } = build();
  const draft = await service.authorPlan(PROJECT, GC, {
    stages: [
      { name: 'Foundation', key: 'f' },
      { name: 'Framing', key: 'fr', dependsOn: ['f'] },
    ],
  });
  await service.proposePlan(draft.planVersionId, GC);

  const theirs = await service.getPlan(PROJECT, OWNER);
  assert.equal(theirs.current.status, 'proposed');
  const [foundation, framing] = theirs.current.stages;
  assert.deepEqual(framing.dependsOn, [foundation.id]);
});

test('dependency freeze guard (in-memory): a frozen version\u2019s dependency rows can never be deleted (LINA-233)', async () => {
  const { service, store } = build();
  const draft = await service.authorPlan(PROJECT, GC, {
    stages: [
      { name: 'Foundation', key: 'f' },
      { name: 'Framing', key: 'fr', dependsOn: ['f'] },
    ],
  });
  await service.proposePlan(draft.planVersionId, GC);
  await service.accept(draft.planVersionId, OWNER); // freeze → terminal 'accepted'

  // Direct store delete (any code path) is refused by the mirrored trigger.
  await assert.rejects(
    async () => { store.deleteStageDependenciesByPlanVersion({}, draft.planVersionId); },
    (e) => e.code === 'P0001' && e.trigger === 'stage_dependency_freeze_delete_guard',
    'the DB trigger is mirrored in the store: a frozen baseline dependency never dies',
  );
  assert.equal(store.listStageDependenciesByPlanVersion(draft.planVersionId).length, 1,
    'the dependency rows survive the refused delete');
});

test('authorPlan: no key/dependsOn is unchanged behaviour — existing callers keep working (backward compatible)', async () => {
  const { service } = build();
  const out = await service.authorPlan(PROJECT, GC, { stages: SKELETON });
  const view = await service.getPlan(PROJECT, GC);
  assert.equal(view.current.stages.length, 2);
  for (const s of view.current.stages) assert.deepEqual(s.dependsOn, []);
  assert.ok(out.auditEventId);
});

test('authorPlan + proposePlan: the appended events extend a verifiable hash chain', async () => {
  // Re-run through the real hash-chain helpers to prove plan_drafted and
  // plan_proposed are chainable exactly like import's (ADR-0002).
  const { service, ledger } = build();
  const draft = await service.authorPlan(PROJECT, GC, { stages: SKELETON });
  await service.proposePlan(draft.planVersionId, GC);
  const chain = [];
  let prev = null;
  for (const e of ledger._events) {
    const appended = computeAppend(prev, e);
    chain.push(appended);
    prev = appended;
  }
  assert.equal(chain[0].prevHash, GENESIS_HASH);
  assert.deepEqual(verifyChain(chain), { verified: true });
});
