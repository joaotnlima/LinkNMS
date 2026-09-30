// Unit tests for the v2 Money surface transforms (LINA-381, Phase 12b.2).
//
// The rules worth pinning: financials are SUMMED straight off the per-contract
// reads and never recomputed (money is ledger-authoritative); only APPROVED,
// full-body change orders count as budget moves (a draft/withdrawn CO or an
// existence-only linked row has not moved the visible budget); and only
// open/acknowledged variations are drift (a formalised one is already an approved
// move, a closed one is back to baseline).
//
// Run: node --experimental-strip-types --test src/lib/v2/money-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateFinancials,
  isApprovedMove,
  toMoveRow,
  toMoves,
  toDriftRow,
  toDrift,
  buildMoneyView,
  driftKindLabel,
  moveKindLabel,
} from './money-view.ts';

const money = (cents, currency = 'EUR') => ({ amount_cents: cents, currency });

const financials = (over = {}) => ({
  value: money(100_00),
  approved_changes: money(0),
  measured: money(0),
  retention_held: money(0),
  paid: money(0),
  outstanding: money(0),
  ...over,
});

const co = (over = {}) => ({
  id: 'co-1',
  contract_id: 'k-1',
  number: 'CO-1',
  kind: 'scope',
  reason: 'Extra footings',
  amount_delta: money(1_200_00),
  proposed_by: { org_id: 'org-sub' },
  decided_by: { org_id: 'org-owner' },
  decided_at: '2026-09-20T10:00:00.000Z',
  status: 'approved',
  version: 3,
  ...over,
});

const variation = (over = {}) => ({
  id: 'v-1',
  task_id: 't-1',
  task_name: 'Slab pour',
  kind: 'time',
  cause: 'Weather delay',
  status: 'open',
  last_changed_at: '2026-09-21T09:00:00.000Z',
  ...over,
});

const me = {
  active_org: { id: 'org-owner', legal_name: 'Owner LLC' },
  organizations: [{ org: { id: 'org-owner', legal_name: 'Owner LLC' } }],
};

// ── aggregateFinancials ──────────────────────────────────────────────────────

test('aggregateFinancials sums each register across contracts', () => {
  const s = aggregateFinancials([
    financials({ value: money(100_00), measured: money(40_00), outstanding: money(60_00) }),
    financials({ value: money(250_00), measured: money(10_00), outstanding: money(240_00) }),
  ]);
  assert.equal(s.valueCents, 350_00);
  assert.equal(s.measuredCents, 50_00);
  assert.equal(s.outstandingCents, 300_00);
  assert.equal(s.contractCount, 2);
  assert.equal(s.currency, 'EUR');
});

test('aggregateFinancials on an empty list is the honest zero-summary', () => {
  const s = aggregateFinancials([]);
  assert.equal(s.contractCount, 0);
  assert.equal(s.valueCents, 0);
  assert.equal(s.outstandingCents, 0);
});

// ── isApprovedMove / toMoves ─────────────────────────────────────────────────

test('isApprovedMove is true only for an approved full-body CO', () => {
  assert.equal(isApprovedMove(co({ status: 'approved' })), true);
  assert.equal(isApprovedMove(co({ status: 'submitted' })), false);
  assert.equal(isApprovedMove(co({ status: 'draft' })), false);
  assert.equal(isApprovedMove(co({ status: 'rejected' })), false);
  assert.equal(isApprovedMove(co({ status: 'withdrawn' })), false);
});

test('isApprovedMove is false for an existence-only linked row', () => {
  const thin = { id: 'co-x', contract_id: 'k-2', status: 'approved', _visibility: { commercial: false, reason: 'linked' } };
  assert.equal(isApprovedMove(thin), false);
});

test('toMoveRow resolves the deciding org from what the viewer holds', () => {
  const row = toMoveRow(co(), me);
  assert.equal(row.amountDeltaCents, 1_200_00);
  assert.equal(row.title, 'Extra footings');
  assert.equal(row.kind, 'scope');
  assert.equal(row.decidedByLabel, 'Owner LLC');
  assert.equal(row.decidedAt, '2026-09-20T10:00:00.000Z');
});

test('toMoveRow names an unknown deciding org neutrally, never a raw UUID', () => {
  const row = toMoveRow(co({ decided_by: { org_id: 'org-stranger' } }), me);
  assert.equal(row.decidedByLabel, 'The other party');
});

test('toMoves keeps only approved rows, newest decision first', () => {
  const rows = [
    co({ id: 'a', decided_at: '2026-09-01T00:00:00.000Z' }),
    co({ id: 'b', status: 'submitted' }),
    co({ id: 'c', decided_at: '2026-09-25T00:00:00.000Z' }),
    { id: 'd', contract_id: 'k', status: 'approved', _visibility: { commercial: false, reason: 'linked' } },
  ];
  const moves = toMoves(rows, me);
  assert.deepEqual(moves.map((m) => m.id), ['c', 'a']);
});

// ── toDrift ──────────────────────────────────────────────────────────────────

test('toDriftRow falls back to a label when the task is unnamed', () => {
  const row = toDriftRow(variation({ task_name: undefined }));
  assert.equal(row.taskName, 'Untitled line');
  assert.equal(row.kind, 'time');
  assert.equal(row.status, 'open');
});

test('toDrift keeps only open/acknowledged variations, newest first', () => {
  const rows = [
    variation({ id: 'v-open', status: 'open', last_changed_at: '2026-09-10T00:00:00.000Z' }),
    variation({ id: 'v-ack', status: 'acknowledged', last_changed_at: '2026-09-22T00:00:00.000Z' }),
    variation({ id: 'v-formal', status: 'formalised' }),
    variation({ id: 'v-closed', status: 'closed' }),
  ];
  const drift = toDrift(rows);
  assert.deepEqual(drift.map((d) => d.id), ['v-ack', 'v-open']);
});

// ── buildMoneyView ───────────────────────────────────────────────────────────

test('buildMoneyView assembles the three registers', () => {
  const view = buildMoneyView({
    noActiveOrg: false,
    indicativeBudgetCents: 500_000_00,
    financials: [financials({ value: money(300_000_00) })],
    changeOrders: [co(), co({ id: 'co-2', status: 'submitted' })],
    variations: [variation(), variation({ id: 'v-2', status: 'closed' })],
    me,
  });
  assert.equal(view.noActiveOrg, false);
  assert.equal(view.indicativeBudgetCents, 500_000_00);
  assert.equal(view.summary.valueCents, 300_000_00);
  assert.equal(view.summary.contractCount, 1);
  assert.equal(view.moves.length, 1); // only the approved CO
  assert.equal(view.drift.length, 1); // only the open variation
});

test('buildMoneyView with no contracts is the honest B2 pre-contract state', () => {
  const view = buildMoneyView({
    noActiveOrg: false,
    indicativeBudgetCents: 500_000_00,
    financials: [],
    changeOrders: [],
    variations: [],
    me,
  });
  assert.equal(view.summary.contractCount, 0);
  assert.equal(view.summary.valueCents, 0);
  assert.equal(view.moves.length, 0);
  assert.equal(view.drift.length, 0);
});

// ── labels ───────────────────────────────────────────────────────────────────

test('kind labels are words, not codes', () => {
  assert.equal(moveKindLabel('scope_and_time'), 'Scope & time');
  assert.equal(driftKindLabel('material'), 'Material');
  assert.equal(driftKindLabel('time'), 'Schedule');
});
