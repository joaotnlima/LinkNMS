// Unit tests for the plan grid's column model (LINA-261 behaviours 2, 4 and 6).
//
// The grid's left pane is data-driven: an ordered array of column ids, a
// template string built from it, and the widths a drag / double-click / divider
// may land on. The seams worth testing are the RULES — what the pins refuse,
// what the clamps floor — not the rendering.
//
// Run: node --test src/lib/plan-columns.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COLUMN_SPECS, DEFAULT_COLUMN_ORDER, COL_MAX, SPLIT,
  moveColumn, columnTemplate, fitColumnWidth, clampColumnWidth, clampSplit,
} from './plan-columns.ts';

test('the default order is the layout that shipped, Task first', () => {
  assert.deepEqual(DEFAULT_COLUMN_ORDER, ['name', 'trade', 'owner', 'status', 'dates']);
  assert.equal(COLUMN_SPECS.name.pinned, true);
  // Exactly one pin: everything else has to be free to move.
  const pinned = DEFAULT_COLUMN_ORDER.filter((id) => COLUMN_SPECS[id].pinned);
  assert.deepEqual(pinned, ['name']);
});

test('moveColumn: a non-Task column reorders, immutably', () => {
  const order = [...DEFAULT_COLUMN_ORDER];
  const next = moveColumn(order, 4, 1); // dates → just after Task
  assert.deepEqual(next, ['name', 'dates', 'trade', 'owner', 'status']);
  assert.deepEqual(order, DEFAULT_COLUMN_ORDER, 'the input is not mutated');
});

test('moveColumn: Task is pinned — it never moves, and nothing lands on index 0', () => {
  const order = [...DEFAULT_COLUMN_ORDER];

  // Dragging Task itself anywhere is refused.
  assert.equal(moveColumn(order, 0, 3), order, 'same reference = refused');
  // Dropping another column ahead of Task is refused too.
  assert.equal(moveColumn(order, 2, 0), order);
  // Task therefore survives every legal move at index 0.
  for (let from = 1; from < order.length; from += 1) {
    for (let to = 1; to < order.length; to += 1) {
      assert.equal(moveColumn(order, from, to)[0], 'name');
    }
  }
});

test('moveColumn: a no-op or an out-of-range index returns the same array', () => {
  const order = [...DEFAULT_COLUMN_ORDER];
  assert.equal(moveColumn(order, 2, 2), order);
  assert.equal(moveColumn(order, 9, 1), order);
  assert.equal(moveColumn(order, 1, 9), order);
});

test('columnTemplate: untouched columns keep their spec basis', () => {
  const t = columnTemplate(DEFAULT_COLUMN_ORDER, {});
  assert.equal(t, '20px 34px minmax(120px, 1fr) 96px 30px 96px 176px 92px');
});

test('columnTemplate: a resized column becomes an exact px track, in order', () => {
  const t = columnTemplate(['name', 'dates', 'trade', 'owner', 'status'], { dates: 220, trade: 140 });
  assert.equal(t, '20px 34px minmax(120px, 1fr) 220px 140px 30px 96px 92px');
});

test('fitColumnWidth: the widest cell plus padding', () => {
  assert.equal(fitColumnWidth('name', [100, 240, 180], 24), 264);
});

test('fitColumnWidth: never below the column floor — Task stays >= 120px', () => {
  assert.equal(fitColumnWidth('name', [10, 20]), COLUMN_SPECS.name.min);
  assert.equal(fitColumnWidth('name', []), 120, 'an empty column collapses to its floor, not to 0');
  assert.ok(fitColumnWidth('name', [4]) >= 120);
});

test('fitColumnWidth: never above the shared ceiling', () => {
  assert.equal(fitColumnWidth('name', [5000]), COL_MAX);
});

test('clampColumnWidth: a drag is held between the same floor and ceiling', () => {
  assert.equal(clampColumnWidth('name', 40), 120);
  assert.equal(clampColumnWidth('trade', 40), 56);
  assert.equal(clampColumnWidth('dates', 9999), COL_MAX);
  assert.equal(clampColumnWidth('dates', 200.4), 200, 'lands on a whole pixel');
});

test('clampSplit: both panes keep their floor', () => {
  // Plenty of room: the ask is honoured verbatim.
  assert.equal(clampSplit(700, 1400), 700);
  // Dragged left past the table floor.
  assert.equal(clampSplit(100, 1400), SPLIT.tableMin);
  // Dragged right until the timeline would vanish.
  assert.equal(clampSplit(1390, 1400), 1400 - SPLIT.timelineMin);
});

test('clampSplit: on a too-narrow viewport the table floor wins', () => {
  // 500px total cannot give 360 + 240; the table keeps its floor and the
  // timeline scrolls, rather than the table becoming unreadable.
  assert.equal(clampSplit(450, 500), SPLIT.tableMin);
  assert.equal(clampSplit(100, 500), SPLIT.tableMin);
});
