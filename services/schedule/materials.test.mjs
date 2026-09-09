// Contract tests for the Slice B3 materials & movement service (LINA-217; frozen
// contract docs/architecture/slice-b3-live-record-materials-contract.md §3–§4;
// anchors ADR-0014, ADR-0002, ADR-0004, ADR-0005). These exercise the service
// against the in-memory ports, which faithfully enforce the same invariants the
// SQL migration and the Ledger/Identity services enforce in production:
//   - line_material is frozen (immutable) once the plan version is terminal;
//   - material_movement is append-only and enforces the ADR-0014 §3 CHECK
//     (scope_change ⟷ CO + no price_cause; price_movement ⟷ price_cause + no CO);
//   - the budget moves ONLY through the change-order path (B3 adds no writer).
//
// Run: node --test services/schedule/materials.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaterialsService, DomainError } from './materials.mjs';
import { createInMemoryLedger, createInMemoryStore, createInMemoryIdentity } from './ports.mjs';
import { createChangeOrderService } from '../change_order/change-order.mjs';
import { createInMemoryStore as createInMemoryCoStore } from '../change_order/ports.mjs';
import { randomUUID } from 'node:crypto';

const PROJECT = 'proj-1';
const HOMEOWNER = 'party-homeowner';
const GC = 'party-gc';
const OUTSIDER = 'party-outsider';
const BASELINE = 5_000_000;

// A fully-wired materials service: the schedule store + ledger + identity + the
// REAL change-order service (so a scope_change actually opens a CO). Sets up a
// proposed plan version authored by the GC with one stage bound to it.
function build({ withBaseline = false, seed = [] } = {}) {
  const store = createInMemoryStore();
  const coStore = createInMemoryCoStore();
  const ledger = createInMemoryLedger({ baselines: new Map([[PROJECT, BASELINE]]) });
  const identity = createInMemoryIdentity({
    memberships: [
      { projectId: PROJECT, partyId: HOMEOWNER, role: 'owner' },
      { projectId: PROJECT, partyId: GC, role: 'counterparty' },
    ],
  });
  const changeOrder = createChangeOrderService({ store: coStore, ledger, identity });

  // A proposed plan version authored by the GC, with a stage bound to it.
  const versionId = randomUUID();
  store.insertPlanVersion({}, {
    id: versionId, project_id: PROJECT, version_no: 1, status: 'proposed',
    source_import_id: null, supersedes_version_id: null,
    proposed_by_party_id: GC, created_at: new Date().toISOString(), frozen_at: null,
  });
  const stageId = randomUUID();
  store.insertStage({}, {
    id: stageId, project_id: PROJECT, name: 'Structural steel', position: 1,
    parent_id: null, trade: 'steel', import_id: null, source_row_ref: null,
    scope_note: null, planned_start_date: null, planned_end_date: null,
    planned_cost_cents: 2_000_000, plan_version_id: versionId,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  // A baseline scenario's materials are authored WHILE proposed, then the
  // version freezes. Seed them before freezing so the freeze guard is honest.
  const seeded = seed.map((over) => seedMaterial(store, stageId, versionId, over));
  if (withBaseline) {
    store.updatePlanVersionStatus({}, versionId, {
      status: 'accepted', frozenAt: new Date().toISOString(),
    });
    store.upsertProjectBaseline({}, {
      project_id: PROJECT, plan_version_id: versionId, version_no: 1,
      frozen_at: new Date().toISOString(), baseline_audit_event_id: randomUUID(),
    });
  }
  const materials = createMaterialsService({ store, ledger, identity, changeOrder });
  return { materials, store, ledger, identity, changeOrder, stageId, versionId, seeded };
}

const materialInput = (over = {}) => ({
  kind: 'material', name: 'Steel beams', unit: 'tonne', quantity: 10,
  unitPriceCents: 100_000, position: 0, ...over,
});

// A helper to insert a material directly onto the proposed version (baseline case).
function seedMaterial(store, stageId, versionId, over = {}) {
  const id = randomUUID();
  const t = new Date().toISOString();
  store.insertLineMaterial({}, {
    id, stage_id: stageId, project_id: PROJECT, plan_version_id: versionId,
    kind: 'material', name: 'Steel beams', unit: 'tonne', quantity: 10,
    unit_price_cents: 100_000, position: 0, created_at: t, updated_at: t,
    ...over,
  });
  return id;
}

// ── Route 3: authoring — proposed only, proposer only ─────────────────────────

test('authorMaterials: the proposer can author materials while the version is proposed', async () => {
  const { materials, stageId } = build();
  const out = await materials.authorMaterials(stageId, GC, {
    materials: [materialInput()],
  });
  assert.equal(out.lineMaterials.length, 1);
  assert.equal(out.lineMaterials[0].name, 'Steel beams');
  assert.equal(out.lineMaterials[0].quantity, 10);
  assert.equal(out.lineMaterials[0].unitPriceCents, 100_000);
});

test('authorMaterials: only the proposer may author (non-proposer is 403)', async () => {
  const { materials, stageId } = build();
  // The homeowner is a member and has PROPOSE_PLAN, but is not the proposer → 403.
  await assert.rejects(() => materials.authorMaterials(stageId, HOMEOWNER, {
    materials: [materialInput()],
  }), (e) => e instanceof DomainError && e.status === 403 && e.code === 'forbidden');
});

test('authorMaterials: a frozen (accepted) version rejects authoring (409)', async () => {
  const { materials, stageId } = build({ withBaseline: true, seed: [{}] });
  await assert.rejects(() => materials.authorMaterials(stageId, GC, {
    materials: [materialInput()],
  }), (e) => e instanceof DomainError && e.status === 409 && e.code === 'not_proposed');
});

test('authorMaterials: validation rejects bad input (400)', async () => {
  const { materials, stageId } = build();
  await assert.rejects(() => materials.authorMaterials(stageId, GC, {
    materials: [{ ...materialInput(), unitPriceCents: -1 }],
  }), (e) => e.status === 400 && e.code === 'invalid_price');
  await assert.rejects(() => materials.authorMaterials(stageId, GC, {
    materials: [{ ...materialInput(), kind: 'bogus' }],
  }), (e) => e.status === 400 && e.code === 'invalid_material_kind');
});

test('authorMaterials: non-member and unauthenticated are denied', async () => {
  const { materials, stageId } = build();
  await assert.rejects(() => materials.authorMaterials(stageId, OUTSIDER, {
    materials: [materialInput()],
  }), (e) => e.status === 403);
  await assert.rejects(() => materials.authorMaterials(stageId, null, {
    materials: [materialInput()],
  }), (e) => e.status === 401);
});

// ── Route 2: read materials + movements ───────────────────────────────────────

test('getLineMaterials: returns materials and their movements for a stage', async () => {
  const { materials, stageId, seeded } = build({ withBaseline: true, seed: [{}] });
  assert.equal(seeded.length, 1);
  const out = await materials.getLineMaterials(stageId, HOMEOWNER);
  assert.equal(out.lineMaterials.length, 1);
  assert.deepEqual(out.movements, []);
});

test('getLineMaterials: non-member denied (403)', async () => {
  const { materials, stageId } = build();
  await assert.rejects(() => materials.getLineMaterials(stageId, OUTSIDER),
    (e) => e.status === 403);
});

// ── Route 4: swap — price_movement ────────────────────────────────────────────

test('swap price_movement: records a movement + ledger event, NO change order, NO budget move', async () => {
  const { materials, store, ledger, stageId, seeded } = build({ withBaseline: true, seed: [{}] });
  const [matId] = seeded;

  const out = await materials.swapMaterial(stageId, GC, {
    lineMaterialId: matId,
    movementKind: 'price_movement',
    priceCause: 'supplier_quote',
    newUnitPriceCents: 120_000,
    source: 'quote #4471',
  });

  assert.equal(out.movement.movementKind, 'price_movement');
  assert.equal(out.movement.priceCause, 'supplier_quote');
  assert.equal(out.movement.valueDeltaCents, 200_000); // (120,000−100,000)×10 qty
  assert.equal(out.movement.changeOrderId, null);
  assert.equal(out.changeOrder, undefined, 'a price movement carries no change order');
  assert.equal(out.movement.newUnitPriceCents, 120_000);
  assert.equal(out.movement.source, 'quote #4471');

  // The material row is FROZEN — the movement carries the new state, the row does
  // NOT move (a baseline material is moved, never edited).
  const frozen = store.getLineMaterial(matId);
  assert.equal(frozen.unit_price_cents, 100_000, 'the frozen baseline row is not edited by a swap');
  assert.equal(frozen.quantity, 10);

  // Exactly one material_movement_recorded event; no budget event, no CO.
  const types = ledger._events.map((e) => e.type);
  assert.ok(types.includes('material_movement_recorded'));
  assert.ok(!types.includes('budget_moved'), 'a price movement never moves the budget');
  assert.ok(!types.includes('change_order_proposed'), 'a price movement opens no CO');
});

test('swap price_movement: validation rejects a change order and a missing price cause', async () => {
  const { materials, stageId, seeded } = build({ withBaseline: true, seed: [{}] });
  const [matId] = seeded;
  await assert.rejects(() => materials.swapMaterial(stageId, GC, {
    lineMaterialId: matId, movementKind: 'price_movement',
    newUnitPriceCents: 120_000, changeOrder: { title: 'x' },
  }), (e) => e.status === 400 && e.code === 'invalid_change_order');
  await assert.rejects(() => materials.swapMaterial(stageId, GC, {
    lineMaterialId: matId, movementKind: 'price_movement', newUnitPriceCents: 120_000,
  }), (e) => e.status === 400 && e.code === 'invalid_price_cause');
});

test('swap: non-counterparty (homeowner) is denied RECORD_MOVEMENT (403)', async () => {
  const { materials, stageId, seeded } = build({ withBaseline: true, seed: [{}] });
  const [matId] = seeded;
  await assert.rejects(() => materials.swapMaterial(stageId, HOMEOWNER, {
    lineMaterialId: matId, movementKind: 'price_movement', priceCause: 'correction',
    newUnitPriceCents: 100_000,
  }), (e) => e.status === 403 && e.code === 'forbidden');
});

// ── Route 4: swap — scope_change ──────────────────────────────────────────────

test('swap scope_change: opens a change order (costDelta = valueDelta), writes movement + ledger event', async () => {
  const { materials, store, ledger, stageId, seeded } = build({ withBaseline: true, seed: [{}] });
  const [matId] = seeded;

  const out = await materials.swapMaterial(stageId, GC, {
    lineMaterialId: matId,
    movementKind: 'scope_change',
    newQuantity: 15,               // 10 → 15
    source: 're-scope framing',
    changeOrder: { title: 'Increase steel tonnage' },
  });

  assert.equal(out.movement.movementKind, 'scope_change');
  assert.equal(out.movement.valueDeltaCents, 500_000); // (15−10)×100,000
  assert.ok(out.changeOrder, 'a scope_change carries a change order');
  assert.equal(out.changeOrder.title, 'Increase steel tonnage');
  assert.equal(out.changeOrder.status, 'proposed');
  // The CO cost delta is the value delta (server-derived, never client-supplied).
  const co = ledger._events.find((e) => e.type === 'change_order_proposed');
  assert.ok(co, 'the change order service opens a CO (its own event)');
  assert.equal(co.payload.costDeltaCents, 500_000);

  // The movement references the CO; the material row stays frozen at its baseline.
  assert.equal(out.movement.changeOrderId, out.changeOrder.id);
  assert.equal(out.movement.newQuantity, 15);
  const frozen = store.getLineMaterial(matId);
  assert.equal(frozen.quantity, 10, 'the frozen baseline row is not edited by a swap');
  assert.equal(frozen.unit_price_cents, 100_000);
});

test('swap: a fractional quantity yields an INTEGER-cent valueDelta (rounded, not fractional)', async () => {
  // numeric(14,3) quantities are real (m², hours). 12.333 × 100,000 = 1,233,300.0
  // here, but an odd unit price would produce fractional cents — the delta must be
  // rounded to integer cents so the bigint column and the CO cost delta stay whole.
  const { materials, stageId, seeded } = build({ withBaseline: true, seed: [
    { quantity: 10, unit_price_cents: 100_003 },   // baseline extended = 1,000,030
  ] });
  const [matId] = seeded;
  const out = await materials.swapMaterial(stageId, GC, {
    lineMaterialId: matId,
    movementKind: 'scope_change',
    newQuantity: 12.333,                            // 12.333 × 100,003 = 1,233,336.999
    changeOrder: { title: 'Re-scope' },
  });
  // round(1,233,336.999) − 1,000,030 = 1,233,337 − 1,000,030 = 233,307.
  assert.equal(out.movement.valueDeltaCents, 233_307);
  assert.ok(Number.isInteger(out.movement.valueDeltaCents), 'valueDelta must be integer cents');
});

test('swap scope_change: rejects when it omits a change order or carries a price cause', async () => {
  const { materials, stageId, seeded } = build({ withBaseline: true, seed: [{}] });
  const [matId] = seeded;
  await assert.rejects(() => materials.swapMaterial(stageId, GC, {
    lineMaterialId: matId, movementKind: 'scope_change', newQuantity: 12,
  }), (e) => e.status === 400 && e.code === 'invalid_change_order');
  await assert.rejects(() => materials.swapMaterial(stageId, GC, {
    lineMaterialId: matId, movementKind: 'scope_change', newQuantity: 12,
    priceCause: 'index', changeOrder: { title: 'x' },
  }), (e) => e.status === 400 && e.code === 'invalid_price_cause');
});

// ── Route 5: budget movement (D16 MoneyView) ──────────────────────────────────

test('getBudgetMovement: splits scopeChanges vs priceMovements; currentBudgetCents from ledger (never recomputed)', async () => {
  const { materials, stageId, seeded } = build({ withBaseline: true, seed: [
    { quantity: 10, unit_price_cents: 100_000 },
    { name: 'Concrete', quantity: 5, unit_price_cents: 50_000 },
  ] });
  const [a, b] = seeded;

  // A scope change on A and a price movement on B.
  await materials.swapMaterial(stageId, GC, {
    lineMaterialId: a, movementKind: 'scope_change', newQuantity: 15,
    changeOrder: { title: 'Add steel' },
  });
  await materials.swapMaterial(stageId, GC, {
    lineMaterialId: b, movementKind: 'price_movement', priceCause: 'index',
    newUnitPriceCents: 60_000, source: 'cement index 2026-09',
  });

  const view = await materials.getBudgetMovement(PROJECT, HOMEOWNER);
  assert.equal(view.currentBudgetCents, BASELINE,
    'currentBudgetCents reads the ledger unchanged (price movement does not move it)');
  assert.equal(view.scopeChanges.length, 1);
  assert.equal(view.priceMovements.length, 1);
  assert.equal(view.scopeChanges[0].valueDeltaCents, 500_000);
  assert.ok(view.scopeChanges[0].changeOrder, 'scope change references its CO');
  assert.equal(view.priceMovements[0].priceCause, 'index');
  assert.equal(view.priceMovements[0].source, 'cement index 2026-09');
  // Structurally separate: the price movement never appears in scopeChanges.
  assert.equal(view.priceMovements[0].changeOrder, undefined);
});

// ── Route 1: the live record (D14) ────────────────────────────────────────────

test('getRecord: a line with a movement derives deviation; compare fields present', async () => {
  const { materials, store, stageId, seeded } = build({ withBaseline: true, seed: [{}] });
  const [matId] = seeded;

  const before = await materials.getRecord(PROJECT, HOMEOWNER);
  assert.equal(before.state, 'accepted');
  const lineBefore = before.tabs.plan.lines[0];
  assert.equal(lineBefore.state, 'accepted');
  assert.equal(lineBefore.plannedCostCents, 2_000_000);
  assert.equal(lineBefore.currentValueCents, 1_000_000, 'currentValue is the material sum');
  assert.deepEqual(lineBefore.compare, { plannedCostCents: 2_000_000, currentValueCents: 1_000_000 });

  // A price movement writes a movement → the line + record now deviate.
  await materials.swapMaterial(stageId, GC, {
    lineMaterialId: matId, movementKind: 'price_movement', priceCause: 'index',
    newUnitPriceCents: 150_000,
  });
  const after = await materials.getRecord(PROJECT, HOMEOWNER);
  assert.equal(after.state, 'deviation');
  assert.equal(after.tabs.plan.lines[0].state, 'deviation');
  assert.equal(after.tabs.plan.lines[0].currentValueCents, 1_500_000);
  assert.ok(after.tabs.history.events.some((e) => e.type === 'material_movement_recorded'),
    'the record history surfaces the movement ledger event');
});

test('getRecord: non-member denied; baseline shape present', async () => {
  const { materials } = build({ withBaseline: true });
  const view = await materials.getRecord(PROJECT, HOMEOWNER);
  assert.ok(view.baseline, 'a baselined project reports its baseline');
  assert.equal(view.baseline.versionNo, 1);
  await assert.rejects(() => materials.getRecord(PROJECT, OUTSIDER), (e) => e.status === 403);
});
