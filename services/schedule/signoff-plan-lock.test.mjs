// Contract tests for the execution sign-off plan-lock + pre-sign-off audit
// (LINA-297; ADR-0023 §8, follow-up to LINA-278). LINA-278 shipped the guard
// PRIMITIVE assertPlanEditable and the plan_change_log table but did NOT wire
// them into the plan mutation handlers. These tests prove the wiring:
//   - while the execution phase is ACTIVE, addStage/updateStage append one
//     schedule.plan_change_log row per field change (creation = old null → value;
//     edit = old → new), stamped with the actor party;
//   - no audit rows are written while the execution phase is still PENDING
//     (procurement running) — the audit is scoped to the active execution phase;
//   - once the execution phase is SIGNED_OFF the plan is immutable: addStage,
//     updateStage, authorPlan and proposePlan all 409 `plan_locked` (raise a
//     change order, ADR-0014) BEFORE any write, so audit writes stop at sign-off.
//
// Run: node --test services/schedule/signoff-plan-lock.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleService } from './schedule.mjs';
import { createPlanVersionService } from './plan-version.mjs';
import { createPhaseService } from './phases.mjs';
import { createInMemoryLedger, createInMemoryStore, createInMemoryIdentity } from './ports.mjs';

const PROJECT = 'proj-lock';
const OWNER = 'party-owner';
const GC = 'party-gc';
const BASELINE = 5_000_000;

// Build the two plan-mutation services (schedule live-record + plan-version
// authoring) and the phase service over ONE shared store/identity — the exact
// wiring services/composition.mjs performs, so the guard the deployed target
// runs is the guard under test.
function build({ hasSignedContractor = true } = {}) {
  const store = createInMemoryStore();
  const ledger = createInMemoryLedger({ baselines: new Map([[PROJECT, BASELINE]]) });
  const identity = createInMemoryIdentity({
    memberships: [
      { projectId: PROJECT, partyId: OWNER, role: 'owner' },
      { projectId: PROJECT, partyId: GC, role: 'counterparty' },
    ],
  });
  const phases = createPhaseService({ store, identity });
  const schedule = createScheduleService({ store, ledger, identity, phases });
  const planVersion = createPlanVersionService({ store, ledger, identity, phases });
  return { store, ledger, identity, phases, schedule, planVersion, hasSignedContractor };
}

const stageInput = (over = {}) => ({ name: 'Foundation', position: 1, plannedCostCents: 1_000_000, ...over });

const SKELETON = [
  { name: '1 · Pre-Construction', children: [{ name: '1.1 Planning' }] },
  { name: '2 · Construction' },
];

async function execPhase(phases) {
  const { phases: list } = await phases.listPhases(PROJECT, OWNER);
  return list.find((p) => p.kind === 'execution');
}

// Drive the real sign-off flow: seed phases (execution active), request sign-off
// as the GC, approve as the OTHER party (never self-approved). Returns the now
// signed_off execution phase.
async function signOffExecution(ctx) {
  await ctx.phases.ensurePhases(PROJECT, { hasSignedContractor: true });
  // sign-off requires ≥1 plan task
  await ctx.schedule.addStage(PROJECT, GC, stageInput({ name: 'Setup', position: 1 }));
  const exec = await execPhase(ctx.phases);
  const { signOffRequest } = await ctx.phases.requestSignOff(PROJECT, exec.id, GC);
  await ctx.phases.approveSignOff(PROJECT, exec.id, signOffRequest.id, OWNER);
  return execPhase(ctx.phases);
}

// ── Pre-sign-off audit while the execution phase is ACTIVE ────────────────────

test('addStage while execution active logs one plan_change_log row per non-null field', async () => {
  const ctx = build();
  await ctx.phases.ensurePhases(PROJECT, { hasSignedContractor: true }); // execution active
  const exec = await execPhase(ctx.phases);

  const s = await ctx.schedule.addStage(PROJECT, GC, stageInput({ name: 'Framing', position: 2 }));

  const rows = ctx.store.listPlanChangeLogByPhase(exec.id);
  const byField = new Map(rows.map((r) => [r.field_name, r]));
  assert.deepEqual([...byField.keys()].sort(), ['name', 'planned_cost_cents', 'position']);
  for (const r of rows) {
    assert.equal(r.entity_type, 'stage');
    assert.equal(r.entity_id, s.id);
    assert.equal(r.actor_party_id, GC);
    assert.equal(r.old_value, null); // a creation is a diff from nothing
  }
  assert.equal(byField.get('name').new_value, 'Framing');
  assert.equal(byField.get('position').new_value, 2);
  assert.equal(byField.get('planned_cost_cents').new_value, 1_000_000);
});

test('updateStage logs one row per changed field, old → new (updated_at never audited)', async () => {
  const ctx = build();
  await ctx.phases.ensurePhases(PROJECT, { hasSignedContractor: true });
  const exec = await execPhase(ctx.phases);
  const s = await ctx.schedule.addStage(PROJECT, GC, stageInput({ name: 'Framing', position: 2, plannedCostCents: 1_000_000 }));
  const before = ctx.store.listPlanChangeLogByPhase(exec.id).length;

  await ctx.schedule.updateStage(s.id, GC, { name: 'Framing & Sheathing', plannedCostCents: 1_250_000 });

  const rows = ctx.store.listPlanChangeLogByPhase(exec.id).slice(before);
  const byField = new Map(rows.map((r) => [r.field_name, r]));
  assert.deepEqual([...byField.keys()].sort(), ['name', 'planned_cost_cents']);
  assert.ok(!byField.has('updated_at'));
  assert.equal(byField.get('name').old_value, 'Framing');
  assert.equal(byField.get('name').new_value, 'Framing & Sheathing');
  assert.equal(byField.get('planned_cost_cents').old_value, 1_000_000);
  assert.equal(byField.get('planned_cost_cents').new_value, 1_250_000);
});

test('no audit rows while the execution phase is still pending (procurement running)', async () => {
  const ctx = build();
  await ctx.phases.ensurePhases(PROJECT, { hasSignedContractor: false }); // execution PENDING
  const exec = await execPhase(ctx.phases);
  assert.equal(exec.status, 'pending');

  const s = await ctx.schedule.addStage(PROJECT, GC, stageInput());
  assert.ok(s.id); // the edit still succeeds — the plan is freely editable

  assert.equal(ctx.store.listPlanChangeLogByPhase(exec.id).length, 0);
});

// ── The sign-off lock: signed_off execution plan is immutable (409 plan_locked)

test('after execution sign-off, addStage → 409 plan_locked and writes nothing', async () => {
  const ctx = build();
  const exec = await signOffExecution(ctx);
  const before = ctx.store.listPlanChangeLogByPhase(exec.id).length;

  await assert.rejects(
    ctx.schedule.addStage(PROJECT, GC, stageInput({ name: 'Sneaky', position: 9 })),
    (e) => e.status === 409 && e.code === 'plan_locked');

  // audit writes STOP at sign-off — the blocked edit left no row
  assert.equal(ctx.store.listPlanChangeLogByPhase(exec.id).length, before);
});

test('after execution sign-off, updateStage → 409 plan_locked', async () => {
  const ctx = build();
  await signOffExecution(ctx);
  // the Setup stage created during sign-off is the target
  const [stage] = ctx.store.listStages(PROJECT);

  await assert.rejects(
    ctx.schedule.updateStage(stage.id, GC, { name: 'Renamed after lock' }),
    (e) => e.status === 409 && e.code === 'plan_locked');
});

test('after execution sign-off, authorPlan → 409 plan_locked', async () => {
  const ctx = build();
  await signOffExecution(ctx);

  await assert.rejects(
    ctx.planVersion.authorPlan(PROJECT, GC, { stages: SKELETON }),
    (e) => e.status === 409 && e.code === 'plan_locked');
});

test('after execution sign-off, proposePlan on a pre-lock draft → 409 plan_locked', async () => {
  const ctx = build();
  // author a draft BEFORE sign-off (allowed), then lock, then try to propose it
  await ctx.phases.ensurePhases(PROJECT, { hasSignedContractor: true });
  const draft = await ctx.planVersion.authorPlan(PROJECT, GC, { stages: SKELETON });
  const exec = await execPhase(ctx.phases);
  const { signOffRequest } = await ctx.phases.requestSignOff(PROJECT, exec.id, GC);
  await ctx.phases.approveSignOff(PROJECT, exec.id, signOffRequest.id, OWNER);

  await assert.rejects(
    ctx.planVersion.proposePlan(draft.planVersionId, GC),
    (e) => e.status === 409 && e.code === 'plan_locked');
});

// ── The guard is a no-op when no phase service is injected (fixture contract) ──

test('without a phases port the mutation surfaces stay open (default-to-noop)', async () => {
  const store = createInMemoryStore();
  const ledger = createInMemoryLedger({ baselines: new Map([[PROJECT, BASELINE]]) });
  const identity = createInMemoryIdentity({
    memberships: [{ projectId: PROJECT, partyId: GC, role: 'counterparty' }],
  });
  const schedule = createScheduleService({ store, ledger, identity }); // no phases
  const s = await schedule.addStage(PROJECT, GC, stageInput());
  assert.ok(s.id); // no guard, no crash, no audit port needed
});
