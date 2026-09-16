// Contract tests for the pre-sign-off plan-edit audit + change-order guard
// (LINA-280; ADR-0023 §8). They prove the two halves of Addendum A #4 wired into
// the plan-mutation handlers, against the in-memory ports that mirror the SQL:
//   - while the execution phase is ACTIVE, a stage field edit appends one
//     append-only plan_change_log row PER changed field (entity_type/entity_id/
//     field_name/old_value/new_value/actor_party_id), anchored on the phase;
//   - a stage creation logs its plan-bearing fields with no prior value;
//   - once the execution phase is SIGNED_OFF the guard (assertPlanEditable) turns
//     every direct plan mutation into a 409 plan_locked and NOTHING is logged —
//     the change-order ledger (ADR-0014) takes over after the lock;
//   - a project with no execution phase (legacy, pre-phase) logs nothing and the
//     edit still succeeds — the audit trail is best-effort over an absent phase.
//
// Run: node --test services/schedule/plan-change-log.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduleService } from './schedule.mjs';
import { createPlanVersionService } from './plan-version.mjs';
import { createPhaseService } from './phases.mjs';
import { createInMemoryLedger, createInMemoryStore, createInMemoryIdentity } from './ports.mjs';

const PROJECT = 'proj-1';
const OWNER = 'party-owner';
const GC = 'party-gc';

function build({ hasSignedContractor = true, seedPhases = true } = {}) {
  const store = createInMemoryStore();
  const ledger = createInMemoryLedger({ baselines: new Map([[PROJECT, 5_000_000]]) });
  const identity = createInMemoryIdentity({
    memberships: [
      { projectId: PROJECT, partyId: OWNER, role: 'owner' },
      { projectId: PROJECT, partyId: GC, role: 'counterparty' },
    ],
  });
  const phases = createPhaseService({ store, identity });
  const service = createScheduleService({ store, ledger, identity, phases });
  const planVersion = createPlanVersionService({ store, ledger, identity, phases });
  return { store, ledger, identity, phases, service, planVersion };
}

const stageInput = (over = {}) => ({ name: 'Foundation', position: 1, plannedCostCents: 1_000_000, ...over });

async function seedExecution(phases, { hasSignedContractor = true } = {}) {
  const rows = await phases.ensurePhases(PROJECT, { hasSignedContractor });
  return rows.find((p) => p.kind === 'execution');
}

async function logFor(store, phaseId, entityId) {
  const rows = await store.listPlanChangeLogByPhase(phaseId);
  return entityId ? rows.filter((r) => r.entity_id === entityId) : rows;
}

// ── plan_change_log writes while active ───────────────────────────────────────

test('a stage field edit appends one plan_change_log row per changed field while execution active', async () => {
  const { service, store, phases } = build();
  const exec = await seedExecution(phases); // execution active (signed contractor)
  const s = await service.addStage(PROJECT, GC, stageInput());

  await service.updateStage(s.id, GC, { name: 'Footings', plannedCostCents: 1_250_000 });

  const rows = await logFor(store, exec.id, s.id);
  const edits = rows.filter((r) => r.field_name === 'name' || r.field_name === 'plannedCostCents')
    .filter((r) => r.old_value !== null); // exclude the creation rows (no prior value)

  const byField = Object.fromEntries(edits.map((r) => [r.field_name, r]));
  assert.equal(byField.name.old_value, 'Foundation');
  assert.equal(byField.name.new_value, 'Footings');
  assert.equal(byField.name.entity_type, 'stage');
  assert.equal(byField.name.actor_party_id, GC);
  assert.equal(byField.plannedCostCents.old_value, 1_000_000);
  assert.equal(byField.plannedCostCents.new_value, 1_250_000);
});

test('a stage creation logs its plan-bearing fields with no prior value', async () => {
  const { service, store, phases } = build();
  const exec = await seedExecution(phases);
  const s = await service.addStage(PROJECT, GC, stageInput({ name: 'Slab', plannedCostCents: 900_000 }));

  const rows = await logFor(store, exec.id, s.id);
  const name = rows.find((r) => r.field_name === 'name');
  assert.ok(name, 'creation logs a name row');
  assert.equal(name.old_value, null, 'no prior value on a creation');
  assert.equal(name.new_value, 'Slab');
  // The plan-bearing fields are all captured on create.
  assert.deepEqual(
    rows.map((r) => r.field_name).sort(),
    ['name', 'plannedCostCents', 'plannedEndDate', 'plannedStartDate', 'position'],
  );
});

test('an unchanged field is not logged — only the fields actually patched', async () => {
  const { service, store, phases } = build();
  const exec = await seedExecution(phases);
  const s = await service.addStage(PROJECT, GC, stageInput());

  await service.updateStage(s.id, GC, { position: 3 });

  const edits = (await logFor(store, exec.id, s.id)).filter((r) => r.old_value !== null);
  assert.deepEqual(edits.map((r) => r.field_name), ['position']);
  assert.equal(edits[0].old_value, 1);
  assert.equal(edits[0].new_value, 3);
});

// ── the change-order guard: no direct edits once signed_off ────────────────────

test('updateStage on a signed_off execution plan is a 409 plan_locked and logs nothing', async () => {
  const { service, store, phases } = build();
  const exec = await seedExecution(phases);
  const s = await service.addStage(PROJECT, GC, stageInput());
  const before = (await store.listPlanChangeLogByPhase(exec.id)).length;

  await store.updatePhaseStatus(undefined, exec.id, 'signed_off'); // owner signed off

  await assert.rejects(
    () => service.updateStage(s.id, GC, { name: 'Too late' }),
    (e) => e.status === 409 && e.code === 'plan_locked');

  assert.equal((await store.listPlanChangeLogByPhase(exec.id)).length, before,
    'a blocked edit writes no audit row — the change-order ledger takes over');
});

test('addStage on a signed_off execution plan is a 409 plan_locked', async () => {
  const { service, store, phases } = build();
  const exec = await seedExecution(phases);
  await store.updatePhaseStatus(undefined, exec.id, 'signed_off');

  await assert.rejects(
    () => service.addStage(PROJECT, GC, stageInput({ name: 'New scope' })),
    (e) => e.status === 409 && e.code === 'plan_locked');
});

test('re-authoring a signed_off execution plan is a 409 plan_locked (:author guard)', async () => {
  const { planVersion, store, phases } = build();
  const exec = await seedExecution(phases);
  await store.updatePhaseStatus(undefined, exec.id, 'signed_off');

  await assert.rejects(
    () => planVersion.authorPlan(PROJECT, GC, { stages: [{ key: 'a', name: 'A' }] }),
    (e) => e.status === 409 && e.code === 'plan_locked');
});

// ── legacy / absent execution phase: best-effort, never blocks ────────────────

test('with no execution phase (legacy project) an edit succeeds and logs nothing', async () => {
  const { service, store } = build({ seedPhases: false });
  // deliberately NOT seeding phases — a pre-phase legacy project.
  const s = await service.addStage(PROJECT, GC, stageInput());
  await service.updateStage(s.id, GC, { name: 'Renamed' });

  const view = await service.getPlan(PROJECT, OWNER);
  assert.equal(view.stages.find((x) => x.id === s.id).name, 'Renamed');
  // No execution phase exists, so nothing was anchored anywhere.
  const exec = await store.getPhaseByKind(PROJECT, 'execution');
  assert.equal(exec, null);
});
