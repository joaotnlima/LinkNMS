// Contract tests for the Schedule & Progress service (LINA-69; spec
// r0-plan-progress-functional-spec §8; ADR-0004/0005; FR-P1, FR-P3–P6). These
// exercise the service against the in-memory ports, which faithfully enforce the
// same invariants the SQL migration enforces in production:
//   - stage_progress is append-only; current status is DERIVED (§8.1);
//   - "latest" is a total order over (reported_at, seq) (§8.1, AC-P9);
//   - GC-only writes; homeowner denied, not 500'd (§8.2, AC-P10);
//   - rollup derived on read, equal-weighted, blocked outranks all (§8.3);
//   - stage planned cost can NEVER move the budget (§2 Q2, AC-P5/P12).
//
// Run: node --test services/schedule/schedule.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduleService, rollup, HEADLINE } from './schedule.mjs';
import { createInMemoryLedger, createInMemoryStore, createInMemoryIdentity } from './ports.mjs';

const PROJECT = 'proj-1';
const HOMEOWNER = 'party-homeowner';
const GC = 'party-gc';
const OUTSIDER = 'party-outsider';
const BASELINE = 5_000_000; // $50,000.00

function build({ baseline = BASELINE } = {}) {
  const store = createInMemoryStore();
  const ledger = createInMemoryLedger({ baselines: new Map([[PROJECT, baseline]]) });
  const identity = createInMemoryIdentity({
    memberships: [
      { projectId: PROJECT, partyId: HOMEOWNER, role: 'owner' },
      { projectId: PROJECT, partyId: GC, role: 'counterparty' },
    ],
  });
  const service = createScheduleService({ store, ledger, identity });
  return { service, store, ledger, identity };
}

const stageInput = (over = {}) => ({ name: 'Foundation', position: 1, plannedCostCents: 1_000_000, ...over });

// Advance a tiny amount of wall clock between reports so reported_at differs; the
// service stamps ISO strings, so a plain await of a macrotask is enough to move ms.
const tick = () => new Promise((r) => setTimeout(r, 2));

// ── FR-P1: enter + reorder stages, homeowner sees them in order (AC-P1) ───────

test('GC adds ordered stages; plan lists them in plan order; reorder persists', async () => {
  const { service } = build();
  const a = await service.addStage(PROJECT, GC, stageInput({ name: 'Foundation', position: 1 }));
  const b = await service.addStage(PROJECT, GC, stageInput({ name: 'Framing', position: 2 }));
  const c = await service.addStage(PROJECT, GC, stageInput({ name: 'Roofing', position: 3 }));

  let plan = await service.getPlan(PROJECT, HOMEOWNER);
  assert.deepEqual(plan.stages.map((s) => s.name), ['Foundation', 'Framing', 'Roofing']);
  assert.equal(plan.totalStages, 3);

  // Reorder: move Roofing to the front.
  await service.updateStage(c.id, GC, { position: 0 });
  plan = await service.getPlan(PROJECT, HOMEOWNER);
  assert.deepEqual(plan.stages.map((s) => s.name), ['Roofing', 'Foundation', 'Framing']);
  void a; void b;
});

test('a brand-new stage with no progress derives not_started', async () => {
  const { service } = build();
  const s = await service.addStage(PROJECT, GC, stageInput());
  assert.equal(s.currentStatus, 'not_started');
  assert.equal(s.currentPercent, null);
  assert.deepEqual(s.history, []);
});

// ── FR-P3 + §8.1: append-only progress, derived status, full history (AC-P3) ──

test('AC-P3: in_progress→blocked→done; current is done; history intact, nothing overwritten', async () => {
  const { service } = build();
  const s = await service.addStage(PROJECT, GC, stageInput());

  await service.reportProgress(s.id, GC, { status: 'in_progress', percent: 60 }); await tick();
  await service.reportProgress(s.id, GC, { status: 'blocked', note: 'waiting on inspector' }); await tick();
  const done = await service.reportProgress(s.id, GC, { status: 'done' });

  assert.equal(done.currentStatus, 'done');
  assert.equal(done.currentPercent, null, 'done clears the advisory percent from the headline');
  assert.deepEqual(done.history.map((h) => h.status), ['in_progress', 'blocked', 'done']);
  // Every entry retains its author + a timestamp; none overwritten.
  assert.ok(done.history.every((h) => h.reportedBy === GC && typeof h.reportedAt === 'string'));
  assert.equal(done.history[0].percent, 60, 'the earlier in_progress percent is preserved in history');
});

test('§2 Q1/§5: percent is ignored unless in_progress and never persisted for done/blocked', async () => {
  const { service } = build();
  const s = await service.addStage(PROJECT, GC, stageInput());
  const r = await service.reportProgress(s.id, GC, { status: 'done', percent: 90 });
  assert.equal(r.history[0].percent, null, 'percent supplied with done is dropped');
  assert.equal(r.currentPercent, null);
});

test('invalid percent while in_progress is a 400', async () => {
  const { service } = build();
  const s = await service.addStage(PROJECT, GC, stageInput());
  await assert.rejects(
    () => service.reportProgress(s.id, GC, { status: 'in_progress', percent: 140 }),
    (e) => e.status === 400 && e.code === 'invalid_percent',
  );
});

// ── §8.1 the state machine: every transition allowed, one conditional ─────────

test('AC-P8: every ✅ transition appends; not_started correction needs a note; full cycle retrievable', async () => {
  const { service } = build();
  const s = await service.addStage(PROJECT, GC, stageInput());

  // not_started → in_progress → done → in_progress (reopen/rework) → done
  await service.reportProgress(s.id, GC, { status: 'in_progress' }); await tick();
  await service.reportProgress(s.id, GC, { status: 'done' }); await tick();
  await service.reportProgress(s.id, GC, { status: 'in_progress', percent: 20 }); await tick();
  const last = await service.reportProgress(s.id, GC, { status: 'done' });

  assert.equal(last.currentStatus, 'done', 'done is NOT terminal; reopen then done works');
  assert.deepEqual(last.history.map((h) => h.status),
    ['in_progress', 'done', 'in_progress', 'done']);

  // A correction back to not_started WITHOUT a note is rejected…
  await assert.rejects(
    () => service.reportProgress(s.id, GC, { status: 'not_started' }),
    (e) => e.status === 400 && e.code === 'note_required',
  );
  // …and WITH a note succeeds, giving the fifth entry.
  await tick();
  const corrected = await service.reportProgress(s.id, GC, { status: 'not_started', note: 'logged in error' });
  assert.equal(corrected.currentStatus, 'not_started');
  assert.equal(corrected.history.length, 5, 'all five entries retrievable in order');
  assert.deepEqual(corrected.history.map((h) => h.status),
    ['in_progress', 'done', 'in_progress', 'done', 'not_started']);
});

test('§8.1: a self-transition (re-report) is a new append, not a no-op', async () => {
  const { service } = build();
  const s = await service.addStage(PROJECT, GC, stageInput());
  await service.reportProgress(s.id, GC, { status: 'in_progress', percent: 10 }); await tick();
  const again = await service.reportProgress(s.id, GC, { status: 'in_progress', percent: 40, note: 'still going' });
  assert.equal(again.history.length, 2);
  assert.equal(again.currentPercent, 40, 'the re-report updates the advisory percent');
});

test('§8.1: re-reporting not_started on a fresh stage needs no note (● not ⚠️)', async () => {
  const { service } = build();
  const s = await service.addStage(PROJECT, GC, stageInput());
  // Current derived status is already not_started, so this is a re-report, allowed
  // note-less. (It is unusual but the spec marks the cell ●, not ⚠️.)
  const r = await service.reportProgress(s.id, GC, { status: 'not_started' });
  assert.equal(r.currentStatus, 'not_started');
  assert.equal(r.history.length, 1);
});

test('invalid status is a 400', async () => {
  const { service } = build();
  const s = await service.addStage(PROJECT, GC, stageInput());
  await assert.rejects(
    () => service.reportProgress(s.id, GC, { status: 'paused' }),
    (e) => e.status === 400 && e.code === 'invalid_status',
  );
});

// ── AC-P9: two entries at the identical timestamp resolve stably via seq ───────

test('AC-P9: identical reported_at resolves to one stable current status via seq', async () => {
  const store = createInMemoryStore();
  const ledger = createInMemoryLedger();
  const identity = createInMemoryIdentity({ memberships: [{ projectId: PROJECT, partyId: GC, role: 'counterparty' }] });
  const service = createScheduleService({ store, ledger, identity });
  const s = await service.addStage(PROJECT, GC, stageInput());

  // Two reports written with the SAME reported_at (freeze the clock). The later
  // insert has the higher seq, so it is the deterministic winner.
  const fixed = '2026-08-28T12:00:00.000Z';
  const origNow = Date.now;
  // The service uses new Date().toISOString(); stub it deterministically.
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(fixed); }
    static now() { return new RealDate(fixed).getTime(); }
  };
  try {
    await service.reportProgress(s.id, GC, { status: 'in_progress', percent: 10 });
    await service.reportProgress(s.id, GC, { status: 'blocked', note: 'x' });
  } finally {
    globalThis.Date = RealDate;
    void origNow;
  }

  // Repeated reads never flip: blocked (higher seq) is always current.
  for (let i = 0; i < 5; i += 1) {
    const plan = await service.getPlan(PROJECT, GC);
    assert.equal(plan.stages[0].currentStatus, 'blocked');
  }
});

// ── §8.2 / AC-P6 / AC-P10: GC-only writes, homeowner denied (not 500) ─────────

test('AC-P10: homeowner is DENIED (403) on every write, and reads succeed for both', async () => {
  const { service } = build();
  const s = await service.addStage(PROJECT, GC, stageInput());

  const denies = [
    () => service.addStage(PROJECT, HOMEOWNER, stageInput({ name: 'Sneaky' })),
    () => service.updateStage(s.id, HOMEOWNER, { name: 'Renamed' }),
    () => service.reportProgress(s.id, HOMEOWNER, { status: 'in_progress' }),
  ];
  for (const d of denies) {
    await assert.rejects(d, (e) => e.status === 403 && e.code === 'forbidden',
      'a homeowner write is an authorization denial, never a 500');
  }

  // Both parties can read the plan and the stage.
  assert.ok(await service.getPlan(PROJECT, HOMEOWNER));
  assert.ok(await service.getPlan(PROJECT, GC));
  assert.ok(await service.viewStage(s.id, HOMEOWNER));
});

test('a non-member (outsider) is denied every write and every read', async () => {
  const { service } = build();
  const s = await service.addStage(PROJECT, GC, stageInput());
  await assert.rejects(() => service.addStage(PROJECT, OUTSIDER, stageInput()),
    (e) => e.status === 403);
  await assert.rejects(() => service.getPlan(PROJECT, OUTSIDER), (e) => e.status === 403);
  await assert.rejects(() => service.viewStage(s.id, OUTSIDER), (e) => e.status === 403);
});

test('an unauthenticated actor is a 401', async () => {
  const { service } = build();
  await assert.rejects(() => service.addStage(PROJECT, null, stageInput()),
    (e) => e.status === 401 && e.code === 'unauthenticated');
});

// ── §8.2: every write is ledgered ─────────────────────────────────────────────

test('§8.2: add/update/report each append exactly one ledger event', async () => {
  const { service, ledger } = build();
  const s = await service.addStage(PROJECT, GC, stageInput());
  await service.updateStage(s.id, GC, { name: 'Foundation & footings' });
  await service.reportProgress(s.id, GC, { status: 'in_progress', percent: 25 });
  const types = ledger._events.map((e) => e.type);
  assert.deepEqual(types, ['stage_added', 'stage_updated', 'progress_reported']);
  const report = ledger._events[2];
  assert.equal(report.payload.fromStatus, 'not_started');
  assert.equal(report.payload.toStatus, 'in_progress');
});

// ── §8.3 rollup: pure function + through the service (AC-P11) ──────────────────

test('rollup(): headline precedence, equal-weighted percent, current pointer', () => {
  const stages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const status = (a, b, c) => new Map([['a', a], ['b', b], ['c', c]]);

  // [done, blocked, not_started] → Attention needed · 33%, current = the blocked one
  let r = rollup(stages, status('done', 'blocked', 'not_started'));
  assert.equal(r.headline, HEADLINE.ATTENTION);
  assert.equal(r.percentComplete, 33);
  assert.equal(r.currentStageId, 'b');

  // blocked → in_progress ⇒ In progress · 33%, current still b (first in_progress)
  r = rollup(stages, status('done', 'in_progress', 'not_started'));
  assert.equal(r.headline, HEADLINE.IN_PROGRESS);
  assert.equal(r.percentComplete, 33);
  assert.equal(r.currentStageId, 'b');

  // all done ⇒ Complete · 100%, no current stage
  r = rollup(stages, status('done', 'done', 'done'));
  assert.equal(r.headline, HEADLINE.COMPLETE);
  assert.equal(r.percentComplete, 100);
  assert.equal(r.currentStageId, null);

  // all not_started ⇒ Not started · 0%, current = first stage
  r = rollup(stages, status('not_started', 'not_started', 'not_started'));
  assert.equal(r.headline, HEADLINE.NOT_STARTED);
  assert.equal(r.percentComplete, 0);
  assert.equal(r.currentStageId, 'a');
});

test('rollup(): 100% only when literally all done — 2/3 floors to 66, never rounds up', () => {
  const stages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const r = rollup(stages, new Map([['a', 'done'], ['b', 'done'], ['c', 'in_progress']]));
  assert.equal(r.percentComplete, 66);
  assert.notEqual(r.headline, HEADLINE.COMPLETE);
});

test('rollup(): blocked outranks an otherwise-complete plan', () => {
  const stages = [{ id: 'a' }, { id: 'b' }];
  const r = rollup(stages, new Map([['a', 'done'], ['b', 'blocked']]));
  assert.equal(r.headline, HEADLINE.ATTENTION);
  assert.equal(r.percentComplete, 50);
});

test('rollup(): zero stages → empty headline, NOT "0%"', () => {
  const r = rollup([], new Map());
  assert.equal(r.headline, HEADLINE.EMPTY);
  assert.equal(r.percentComplete, null);
  assert.equal(r.currentStageId, null);
});

test('AC-P11: full rollup lifecycle through the service', async () => {
  const { service } = build();
  const a = await service.addStage(PROJECT, GC, stageInput({ name: 'A', position: 1 }));
  const b = await service.addStage(PROJECT, GC, stageInput({ name: 'B', position: 2 }));
  const c = await service.addStage(PROJECT, GC, stageInput({ name: 'C', position: 3 }));

  // [done, blocked, not_started] → Attention needed · 33%, current = B
  await service.reportProgress(a.id, GC, { status: 'done' });
  await service.reportProgress(b.id, GC, { status: 'blocked', note: 'permit' });
  let plan = await service.getPlan(PROJECT, HOMEOWNER);
  assert.equal(plan.headline, HEADLINE.ATTENTION);
  assert.equal(plan.percentComplete, 33);
  assert.equal(plan.currentStageId, b.id);

  // unblock B → in_progress ⇒ In progress · 33%
  await service.reportProgress(b.id, GC, { status: 'in_progress' });
  plan = await service.getPlan(PROJECT, HOMEOWNER);
  assert.equal(plan.headline, HEADLINE.IN_PROGRESS);
  assert.equal(plan.percentComplete, 33);

  // B done, C done ⇒ Complete · 100%
  await service.reportProgress(b.id, GC, { status: 'done' });
  await service.reportProgress(c.id, GC, { status: 'done' });
  plan = await service.getPlan(PROJECT, HOMEOWNER);
  assert.equal(plan.headline, HEADLINE.COMPLETE);
  assert.equal(plan.percentComplete, 100);

  // Add a new not_started stage to the complete plan ⇒ In progress · 75% (R4)
  await service.addStage(PROJECT, GC, stageInput({ name: 'D', position: 4 }));
  plan = await service.getPlan(PROJECT, HOMEOWNER);
  assert.equal(plan.headline, HEADLINE.IN_PROGRESS);
  assert.equal(plan.percentComplete, 75);
});

// ── AC-P5 / AC-P12: stage planned cost NEVER moves the budget, unweighted ─────

test('AC-P5/P12: tripling a stage cost moves neither the budget nor the rollup', async () => {
  const { service, ledger } = build();
  const a = await service.addStage(PROJECT, GC, stageInput({ name: 'A', position: 1, plannedCostCents: 1_000_000 }));
  const b = await service.addStage(PROJECT, GC, stageInput({ name: 'B', position: 2, plannedCostCents: 1_000_000 }));
  await service.reportProgress(a.id, GC, { status: 'done' });

  let plan = await service.getPlan(PROJECT, HOMEOWNER);
  const headlineBefore = plan.headline;
  const pctBefore = plan.percentComplete;
  assert.equal(plan.allocation.baselineCents, BASELINE);

  // Triple B's planned cost — and set the whole plan to OVER-allocate the baseline.
  await service.updateStage(b.id, GC, { plannedCostCents: 30_000_000 });
  plan = await service.getPlan(PROJECT, HOMEOWNER);

  // Budget total is unmoved: it is the ledger baseline, no budget_event exists.
  assert.equal(plan.allocation.baselineCents, BASELINE);
  assert.ok(plan.allocation.allocatedCents > BASELINE, 'allocation now over baseline (hint only)');
  assert.equal(plan.allocation.deltaCents, plan.allocation.allocatedCents - BASELINE);
  // Rollup unchanged: percent is equal-weighted (count of done / total), not cost.
  assert.equal(plan.headline, headlineBefore);
  assert.equal(plan.percentComplete, pctBefore);
  // Structural proof: the schedule service never recorded a budget_event — there
  // is no such method on its ledger port, and no budget_moved event was appended.
  assert.ok(!ledger._events.some((e) => e.type === 'budget_moved'),
    'Schedule & Progress records no budget event, ever');
});

// ── AC-P13: a passed planned end date does not auto-advance anything ───────────

test('AC-P13: a stage past its planned end date while not_started stays not_started', async () => {
  const { service } = build();
  const s = await service.addStage(PROJECT, GC, stageInput({
    plannedStartDate: '2020-01-01', plannedEndDate: '2020-02-01',
  }));
  // No background process runs; a read long after the dates still derives not_started.
  const plan = await service.getPlan(PROJECT, HOMEOWNER);
  assert.equal(plan.stages[0].currentStatus, 'not_started');
  assert.equal(plan.headline, HEADLINE.NOT_STARTED);
});

// ── validation guards ─────────────────────────────────────────────────────────

test('addStage requires a name and an integer position', async () => {
  const { service } = build();
  await assert.rejects(() => service.addStage(PROJECT, GC, { position: 1 }),
    (e) => e.status === 400 && e.code === 'invalid_name');
  await assert.rejects(() => service.addStage(PROJECT, GC, { name: 'X' }),
    (e) => e.status === 400 && e.code === 'invalid_position');
});

test('updateStage on a missing stage is a 404', async () => {
  const { service } = build();
  await assert.rejects(() => service.updateStage('nope', GC, { name: 'X' }),
    (e) => e.status === 404);
});

test('reportProgress on a missing stage is a 404', async () => {
  const { service } = build();
  await assert.rejects(() => service.reportProgress('nope', GC, { status: 'done' }),
    (e) => e.status === 404);
});
