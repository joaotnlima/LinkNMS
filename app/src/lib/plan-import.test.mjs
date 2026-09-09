// Unit tests for the plan-import client contract (LINA-207).
//
// The wizard's screens are copy and layout; these four seams are not, and each
// one fails in a way that is expensive rather than obvious:
//
//   1. `assign` — the mapping is field→column on the wire (contract §2), so a
//      field must live in exactly ONE column. If assigning a field to a second
//      column leaves it in the first, the client sends a mapping that says two
//      different things and the GC's screen disagrees with what is stored.
//   2. `preflight` — mirrors the parser's LIMITS. It exists to refuse before a
//      5 MB upload, and a drifted copy would refuse files the server accepts.
//   3. `ganttScale` / `barGeometry` — the only place this app derives geometry
//      from dates. A bar in the wrong month is a plan the GC confirms believing
//      it says something it does not.
//   4. `preorder` — the same WBS order the server stamps in (contract §4), so
//      the preview rows and the stored rows are in the same sequence.
//
// Run: node --test src/lib/   (Node's native TS type-stripping imports the .ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_MAPPING, LIMITS, REQUIRED_FIELDS,
  assign, barGeometry, dateRange, dayNumber, fieldByColumn, formatBytes,
  ganttScale, missingRequired, preflight, preorder,
} from './plan-import.ts';

// A `File` stand-in: preflight reads only `name` and `size`, and Node's own File
// would need a Blob body just to be 5 MB "big".
const fileLike = (name, size) => ({ name, size });

const node = (ref, action, start, end, extra = {}) => ({
  ref, action, subActionOf: null, start, end, trade: null, dependsOn: [], children: [], ...extra,
});

// ── assign: a field lives in exactly one column ─────────────────────────────

test('assigning a field to a column places it', () => {
  const m = assign(EMPTY_MAPPING, 3, 'start');
  assert.equal(m.start, 3);
  assert.equal(m.action, null);
});

test('assigning an already-placed field MOVES it', () => {
  let m = assign(EMPTY_MAPPING, 3, 'start');
  m = assign(m, 7, 'start');
  assert.equal(m.start, 7, 'the field must not be in two columns at once');
});

test('assigning a second field to an occupied column evicts the first', () => {
  let m = assign(EMPTY_MAPPING, 2, 'action');
  m = assign(m, 2, 'trade');
  assert.equal(m.trade, 2);
  assert.equal(m.action, null, 'one column cannot be two fields');
});

test('assigning null clears whatever that column held', () => {
  let m = assign(EMPTY_MAPPING, 4, 'end');
  m = assign(m, 4, null);
  assert.deepEqual(m, EMPTY_MAPPING);
});

test('fieldByColumn inverts the mapping for the left pane', () => {
  let m = assign(EMPTY_MAPPING, 1, 'action');
  m = assign(m, 5, 'dependency');
  const byCol = fieldByColumn(m);
  assert.equal(byCol.get(1), 'action');
  assert.equal(byCol.get(5), 'dependency');
  assert.equal(byCol.get(2), undefined);
});

// ── required fields ─────────────────────────────────────────────────────────

test('the required set is exactly action/start/end (contract §2)', () => {
  assert.deepEqual([...REQUIRED_FIELDS].sort(), ['action', 'end', 'start']);
});

test('missingRequired names what is still unmapped, and nothing optional', () => {
  assert.deepEqual(missingRequired(EMPTY_MAPPING).sort(), ['action', 'end', 'start']);
  let m = assign(EMPTY_MAPPING, 1, 'action');
  m = assign(m, 2, 'start');
  m = assign(m, 3, 'end');
  assert.deepEqual(missingRequired(m), []);
  m = assign(m, 4, 'trade');
  assert.deepEqual(missingRequired(m), [], 'an optional field is never required');
});

// ── preflight: the echoed limits ────────────────────────────────────────────

test('an .xlsx within the limits passes', () => {
  assert.equal(preflight(fileLike('plan.xlsx', 2048)), null);
  assert.equal(preflight(fileLike('PLAN.XLSX', 2048)), null, 'extension check is case-insensitive');
});

test('a non-xlsx is refused with the parser’s own code', () => {
  const err = preflight(fileLike('plan.csv', 2048));
  assert.equal(err?.code, 'file_type_not_supported');
  assert.equal(preflight(fileLike('plan', 2048))?.code, 'file_type_not_supported');
});

test('an empty file and an oversized file are distinct refusals', () => {
  assert.equal(preflight(fileLike('plan.xlsx', 0))?.code, 'empty_file');
  assert.equal(preflight(fileLike('plan.xlsx', LIMITS.maxFileBytes + 1))?.code, 'file_too_large');
  assert.equal(preflight(fileLike('plan.xlsx', LIMITS.maxFileBytes)), null, 'the limit itself is allowed');
});

test('a server-reported limit overrides the echoed one', () => {
  const roomier = { ...LIMITS, maxFileBytes: LIMITS.maxFileBytes * 2 };
  assert.equal(preflight(fileLike('plan.xlsx', LIMITS.maxFileBytes + 1), roomier), null);
});

test('formatBytes is readable at each magnitude', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(248 * 1024), '248 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});

// ── WBS order ───────────────────────────────────────────────────────────────

test('preorder is roots-then-their-children, in source order', () => {
  const roots = [
    node('R2', 'Foundations', '2026-03-02', '2026-03-20', {
      children: [node('R3', 'Excavation', '2026-03-02', '2026-03-09', { subActionOf: 'R2' })],
    }),
    node('R5', 'Structure', '2026-03-23', '2026-04-30'),
  ];
  assert.deepEqual(preorder(roots).map((x) => `${x.node.ref}@${x.depth}`), ['R2@0', 'R3@1', 'R5@0']);
});

// ── the mini-gantt ──────────────────────────────────────────────────────────

test('dayNumber accepts only YYYY-MM-DD', () => {
  assert.equal(dayNumber('1970-01-01'), 0);
  assert.equal(dayNumber('1970-01-02'), 1);
  assert.equal(dayNumber('02/03/2026'), null);
  assert.equal(dayNumber(null), null);
});

test('the axis spans whole months of the plan’s own dates, not today’s', () => {
  const scale = ganttScale([node('R2', 'A', '2026-03-02', '2026-05-20')]);
  assert.deepEqual(scale.months.map((m) => m.label), ['MAR', 'APR', 'MAY']);
});

test('a plan with no readable dates draws no chart at all', () => {
  assert.equal(ganttScale([node('R2', 'A', null, null)]), null);
});

test('a bar sits inside its scale and a first-month bar starts at zero', () => {
  const roots = [
    node('R2', 'A', '2026-03-01', '2026-03-31'),
    node('R3', 'B', '2026-04-01', '2026-04-30'),
  ];
  const scale = ganttScale(roots);
  const a = barGeometry(roots[0], scale);
  const b = barGeometry(roots[1], scale);
  assert.equal(a.left, 0);
  assert.ok(b.left > a.left, 'April must start after March');
  assert.ok(a.left + a.width <= 100.0001 && b.left + b.width <= 100.0001, 'no bar overflows the track');
});

test('an end before its start still draws something findable', () => {
  const roots = [node('R2', 'A', '2026-03-20', '2026-03-02')];
  const bar = barGeometry(roots[0], ganttScale(roots));
  assert.ok(bar.width > 0, 'a backwards row must not vanish from the chart');
});

test('an undated row has no bar rather than a wrong one', () => {
  const roots = [node('R2', 'A', '2026-03-01', '2026-03-31'), node('R3', 'B', null, null)];
  assert.equal(barGeometry(roots[1], ganttScale(roots)), null);
});

test('dateRange renders a missing date as a dash, never as today', () => {
  assert.equal(dateRange(node('R2', 'A', '2026-03-02', '2026-03-20')), '2 Mar – 20 Mar');
  assert.equal(dateRange(node('R3', 'B', null, '2026-03-20')), '— – 20 Mar');
});
