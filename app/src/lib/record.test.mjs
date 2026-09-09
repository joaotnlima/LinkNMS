// Unit tests for the Slice B3 client contract (LINA-218).
//
// D14–D16 are mostly copy and layout. These seams are not, and each one fails in
// a way that is expensive rather than obvious:
//
//   1. `toSwapInput` — the scope_change vs price_movement shape. This is THE
//      load-bearing distinction of ADR-0014 §3: emit the wrong shape and an
//      index rise is filed as a scope change, a change order is opened, and the
//      contract total moves for a reason nobody chose. The database refuses the
//      illegal combinations; this function must refuse them a round trip earlier
//      and say which field is wrong.
//   2. `swapPreview` / `extendedCents` — the money shown before it is recorded.
//      It must round exactly as the server rounds (materials.mjs), or the figure
//      on the screen differs by a cent from the one on the record. The BE's own
//      pre-merge fix was this bug on the other side of the wire.
//   3. `moneyTotals` — the two D16 subtotals. They must stay apart; there must be
//      no combined figure to reach for.
//   4. `canAuthorMaterials` / `canRecordMovement` — which affordances exist. Not
//      the permission (§4 decides, server-side), but showing a reviewer an
//      authoring form whose every submit 403s is a promise the record cannot keep.
//   5. `reconcile` — the ADVISORY line reconciliation (§7). A line with no
//      breakdown must not read as a mismatch of its whole planned cost.
//
// Run: node --test src/lib/   (Node's native TS type-stripping imports the .ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SwapDraftError, canAuthorMaterials, canRecordMovement, compareDelta, emptySwapDraft,
  eventSentence, extendedCents, formatQuantity, materialsTotalCents, moneyTotals,
  movementsForLine, parseQuantity, reconcile, stateLabel, stateTone, swapPreview, toSwapInput,
} from './record.ts';
import { parseAmountToCents } from './format.ts';

const parseCents = (raw) => parseAmountToCents(raw, { label: 'unit price' });

function material(over = {}) {
  return {
    id: 'mat-1',
    stageId: 'stage-1',
    projectId: 'proj-1',
    planVersionId: 'ver-1',
    kind: 'material',
    name: 'Roof membrane',
    unit: 'm2',
    quantity: 180,
    unitPriceCents: 1840,
    position: 0,
    createdAt: '2026-03-01T09:00:00.000Z',
    updatedAt: '2026-03-01T09:00:00.000Z',
    ...over,
  };
}

// ── 2. extended values round exactly as the server rounds them ───────────────

test('extendedCents rounds a fractional quantity to whole cents', () => {
  // The BE computes Math.round(quantity * unitPriceCents). 12.5 × 4201 = 52512.5,
  // and a screen that floored or truncated would show a cent the record does not
  // hold.
  assert.equal(extendedCents({ quantity: 12.5, unitPriceCents: 4201 }), 52513);
  assert.equal(extendedCents({ quantity: 180, unitPriceCents: 1840 }), 331200);
  assert.equal(extendedCents({ quantity: 0, unitPriceCents: 999 }), 0);
});

test('materialsTotalCents is null for no breakdown, never zero', () => {
  // "$0.00 of materials" is a claim; "not broken down" is the truth.
  assert.equal(materialsTotalCents([]), null);
  assert.equal(materialsTotalCents([material(), material({ id: 'm2', quantity: 2, unitPriceCents: 500 })]),
    331200 + 1000);
});

// ── 1. the swap shape — the distinction that must never blur ─────────────────

test('a scope change emits a change order and never a price cause', () => {
  const m = material();
  const draft = { ...emptySwapDraft(m, 'scope_change'), quantity: '200', changeOrderTitle: 'Revised roof pitch' };
  const input = toSwapInput(m, draft, parseCents);

  assert.equal(input.movementKind, 'scope_change');
  assert.equal(input.newQuantity, 200);
  assert.deepEqual(input.changeOrder, { title: 'Revised roof pitch' });
  // The DB CHECK rejects a scope_change carrying a price cause. Never emit one.
  assert.equal(input.priceCause, undefined);
});

test('a scope change without a change-order title is refused, naming the field', () => {
  const m = material();
  const draft = { ...emptySwapDraft(m, 'scope_change'), quantity: '200', changeOrderTitle: '   ' };
  assert.throws(() => toSwapInput(m, draft, parseCents), (err) => {
    assert.ok(err instanceof SwapDraftError);
    assert.equal(err.field, 'changeOrderTitle');
    return true;
  });
});

test('a price movement emits a price cause and never a change order', () => {
  const m = material();
  const draft = { ...emptySwapDraft(m, 'price_movement'), unitPrice: '19.60', priceCause: 'index' };
  const input = toSwapInput(m, draft, parseCents);

  assert.equal(input.movementKind, 'price_movement');
  assert.equal(input.priceCause, 'index');
  assert.equal(input.newUnitPriceCents, 1960);
  // The whole point of ADR-0014 §3: an index rise opens NOTHING.
  assert.equal(input.changeOrder, undefined);
  // The quantity rides along unchanged so the server's delta is price-only.
  assert.equal(input.newQuantity, m.quantity);
});

test('a price movement without a cause is refused — that is what makes it a price movement', () => {
  const m = material();
  const draft = { ...emptySwapDraft(m, 'price_movement'), unitPrice: '19.60', priceCause: '' };
  assert.throws(() => toSwapInput(m, draft, parseCents), (err) => {
    assert.ok(err instanceof SwapDraftError);
    assert.equal(err.field, 'priceCause');
    return true;
  });
});

test('a swap that moves nothing is refused rather than recorded as a no-op movement', () => {
  const m = material();
  // An append-only movement ledger cannot un-record a $0 entry, so a movement
  // that moved nothing is noise on the one surface that must stay readable.
  assert.throws(
    () => toSwapInput(m, { ...emptySwapDraft(m, 'price_movement'), priceCause: 'index' }, parseCents),
    (err) => err instanceof SwapDraftError && err.field === 'unitPrice',
  );
  assert.throws(
    () => toSwapInput(m, { ...emptySwapDraft(m, 'scope_change'), changeOrderTitle: 'No-op' }, parseCents),
    (err) => err instanceof SwapDraftError && err.field === 'quantity',
  );
});

test('a malformed quantity is refused, not rounded', () => {
  const m = material();
  const draft = { ...emptySwapDraft(m, 'scope_change'), quantity: '12.5001', changeOrderTitle: 'x' };
  assert.throws(() => toSwapInput(m, draft, parseCents), (err) => {
    assert.ok(err instanceof SwapDraftError);
    assert.equal(err.field, 'quantity');
    return true;
  });
  assert.throws(() => parseQuantity('-4'), /positive number/);
  assert.equal(parseQuantity('12.5'), 12.5);
  assert.equal(parseQuantity(' 1,250 '), 1250);
});

// ── 2 (cont). the preview mirrors the server's arithmetic ────────────────────

test('swapPreview computes the delta the server will compute', () => {
  const m = material({ quantity: 12.5, unitPriceCents: 4201 });   // prior extended 52513
  const draft = { ...emptySwapDraft(m, 'price_movement'), unitPrice: '43.00', priceCause: 'index' };
  const input = toSwapInput(m, draft, parseCents);
  const preview = swapPreview(m, input);

  assert.equal(preview.priorExtendedCents, 52513);
  assert.equal(preview.newExtendedCents, Math.round(12.5 * 4300));  // 53750
  assert.equal(preview.valueDeltaCents, 53750 - 52513);
  // Whole cents, always — a fractional delta is what the bigint column rejects.
  assert.equal(Number.isInteger(preview.valueDeltaCents), true);
});

test('swapPreview reports a credit as a negative delta', () => {
  const m = material();
  const draft = { ...emptySwapDraft(m, 'scope_change'), quantity: '100', changeOrderTitle: 'Reduced roof area' };
  const preview = swapPreview(m, toSwapInput(m, draft, parseCents));
  assert.equal(preview.valueDeltaCents, Math.round(100 * 1840) - 331200);
  assert.ok(preview.valueDeltaCents < 0);
});

// ── 3. the two D16 sums stay apart ───────────────────────────────────────────

test('moneyTotals returns the two subtotals separately and offers no combined figure', () => {
  const view = {
    baselineBudgetCents: 25_000_00,
    currentBudgetCents: 25_750_00,
    scopeChanges: [
      { movementId: 's1', stageId: 'st1', lineMaterialId: 'm1', valueDeltaCents: 75000, changeOrder: { id: 'co1' }, movedByPartyId: 'p1', occurredAt: '2026-04-01T09:00:00.000Z' },
    ],
    priceMovements: [
      { movementId: 'p1', stageId: 'st1', lineMaterialId: 'm1', priceCause: 'index', source: 'ACME', baselineUnitPriceCents: 1840, newUnitPriceCents: 1960, valueDeltaCents: 21600, movedByPartyId: 'p2', occurredAt: '2026-04-02T09:00:00.000Z' },
    ],
  };
  const totals = moneyTotals(view);
  assert.equal(totals.scopeChangeCents, 75000);
  assert.equal(totals.priceMovementCents, 21600);
  // No `total` — a caller wanting to add a price movement into the contract total
  // must write that addition itself, in the open, rather than find it here.
  assert.equal(Object.keys(totals).sort().join(','), 'priceMovementCents,scopeChangeCents');
});

// ── 4. affordances ───────────────────────────────────────────────────────────

const planWith = (over = {}) => ({
  baseline: null,
  current: {
    id: 'ver-1', versionNo: 1, status: 'proposed', sourceImportId: null, supersedesVersionId: null,
    proposedByPartyId: 'gc', createdAt: '2026-03-01T09:00:00.000Z', frozenAt: null, acceptances: [],
    stages: [{ id: 'stage-1', name: 'Roof', position: 0, trade: null, plannedStartDate: null, plannedEndDate: null, plannedCostCents: 331200, children: [{ id: 'stage-1a', name: 'Membrane', position: 0, trade: null, plannedStartDate: null, plannedEndDate: null, plannedCostCents: null, children: [] }] }],
  },
  history: [],
  ...over,
});

test('only the proposer may author, and only while the version is proposed', () => {
  const plan = planWith();
  assert.equal(canAuthorMaterials(plan, 'stage-1', 'gc'), true);
  // A nested stage is still this version's stage.
  assert.equal(canAuthorMaterials(plan, 'stage-1a', 'gc'), true);
  // The reviewer would 403 on every submit — do not draw the form.
  assert.equal(canAuthorMaterials(plan, 'stage-1', 'owner'), false);
  assert.equal(canAuthorMaterials(plan, 'stage-1', null), false);
  // A stage that is not on this version.
  assert.equal(canAuthorMaterials(plan, 'stage-9', 'gc'), false);

  const accepted = planWith({ current: { ...planWith().current, status: 'accepted' } });
  // Frozen: materials are moved from here, never authored.
  assert.equal(canAuthorMaterials(accepted, 'stage-1', 'gc'), false);
});

test('a movement needs a baseline to move against, and RECORD_MOVEMENT is the GC-side action', () => {
  const noBaseline = planWith();
  assert.equal(canRecordMovement(noBaseline, 'counterparty'), false);

  const baselined = planWith({ baseline: { planVersionId: 'ver-1', versionNo: 1, frozenAt: '2026-03-05T09:00:00.000Z' } });
  assert.equal(canRecordMovement(baselined, 'counterparty'), true);
  assert.equal(canRecordMovement(baselined, 'owner'), false);
  assert.equal(canRecordMovement(baselined, 'subcontractor'), false);
});

// ── 5. the advisory reconciliation, and the rest of the read helpers ─────────

test('a line with no breakdown reads as no_breakdown, never as a full mismatch', () => {
  const line = {
    stageId: 'stage-1', name: 'Roof', trade: null, position: 0, state: 'accepted',
    plannedCostCents: 331200, currentValueCents: 331200, materials: [],
    compare: { plannedCostCents: 331200, currentValueCents: 331200 },
  };
  const r = reconcile(line);
  assert.equal(r.kind, 'no_breakdown');
  assert.equal(r.deltaCents, 0);   // NOT -331200
});

test('reconcile flags a real mismatch and a clean match', () => {
  const base = {
    stageId: 'stage-1', name: 'Roof', trade: null, position: 0, state: 'accepted',
    plannedCostCents: 331200, currentValueCents: 331200,
    compare: { plannedCostCents: 331200, currentValueCents: 331200 },
  };
  assert.equal(reconcile({ ...base, materials: [material()] }).kind, 'match');
  const off = reconcile({ ...base, materials: [material({ quantity: 179 })] });
  assert.equal(off.kind, 'mismatch');
  assert.equal(off.deltaCents, Math.round(179 * 1840) - 331200);
});

test('compareDelta answers planned vs now on any line, settled or not', () => {
  const settled = {
    stageId: 's', name: 'Roof', trade: null, position: 0, state: 'deviation',
    plannedCostCents: 331200, currentValueCents: 350000, materials: [],
    compare: { plannedCostCents: 331200, currentValueCents: 350000 },
  };
  assert.equal(compareDelta(settled), 18800);
});

test('the badge legend states the third state rather than hiding it', () => {
  assert.equal(stateLabel('accepted'), 'As agreed');
  assert.equal(stateLabel('deviation'), 'Deviation');
  assert.equal(stateLabel('closed_and_verified'), 'Closed and verified');
  assert.equal(stateTone('deviation'), 'warn');
  assert.equal(stateTone('accepted'), 'neutral');
});

test('an unknown ledger type still renders as a row rather than vanishing', () => {
  assert.equal(eventSentence('material_movement_recorded'), 'A material movement was recorded');
  // The History tab promises the whole chain in order. A type the copy table has
  // never heard of is still something that happened.
  assert.equal(eventSentence('some_future_event'), 'some future event');
});

test('movementsForLine keeps only that material, in the order given', () => {
  const mv = (id, lineMaterialId) => ({ id, lineMaterialId });
  const all = [mv('a', 'm1'), mv('b', 'm2'), mv('c', 'm1')];
  assert.deepEqual(movementsForLine(all, 'm1').map((m) => m.id), ['a', 'c']);
});

test('formatQuantity trims to the three decimals the column holds', () => {
  assert.equal(formatQuantity(12.5), '12.5');
  assert.equal(formatQuantity(180), '180');
  assert.equal(formatQuantity(1250.125), '1,250.125');
});
