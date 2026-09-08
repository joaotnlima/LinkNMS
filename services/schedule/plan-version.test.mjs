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

test('getPlan: accepted version becomes the baseline and drops into history; current = no open', async () => {
  const { service, store } = build();
  const { versionId } = seedV1({ store });
  await service.accept(versionId, OWNER);

  const view = await service.getPlan(PROJECT, OWNER);
  assert.equal(view.baseline.planVersionId, versionId);
  assert.equal(view.current, null, 'nothing open once accepted');
  assert.equal(view.history.length, 1);
  assert.equal(view.history[0].status, 'accepted');
  assert.equal(view.history[0].acceptances.length, 2, 'D13 shows both stamps');
});

// ── request-changes fork (contract §1, §5 → D12a) ──────────────────────────

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
