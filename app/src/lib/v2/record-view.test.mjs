// Unit tests for the v2 record-surface wire→view transforms (LINA-353, S2).
//
// The rules worth pinning: the v2 task status maps 1:1 onto the v1
// ProgressStatus (identical enums) and an unknown status fails safe to
// not_started; schedule lines keep the server's order via array index; the
// header asserts ONLY "as agreed" (never a deviation v2 has no movement model to
// support) and reports a baseline only when a dated task actually carries one.
//
// Run: node --experimental-strip-types --test src/lib/v2/record-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toRecordHeader, toScheduleLines } from './record-view.ts';

const task = (over = {}) => ({
  id: 't1', name: 'Groundworks', position: 'a', depth: 0,
  start: '2026-01-05', finish: '2026-01-20', status: 'not_started', baseline: null, ...over,
});
const project = { id: 'pr1', name: 'Maple St', status: 'in_execution' };

test('toScheduleLines: maps dates and status straight across, index preserves order', () => {
  const lines = toScheduleLines([
    task({ id: 'a', name: 'A', status: 'done' }),
    task({ id: 'b', name: 'B', status: 'in_progress', start: null, finish: null }),
  ]);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], {
    stageId: 'a', name: 'A', position: 0,
    plannedStartDate: '2026-01-05', plannedEndDate: '2026-01-20', status: 'done', percent: null,
  });
  assert.equal(lines[1].position, 1);
  assert.equal(lines[1].status, 'in_progress');
  assert.equal(lines[1].plannedStartDate, null);
});

test('toScheduleLines: percent is always null (v2 schedule carries no rollup percent)', () => {
  const [line] = toScheduleLines([task()]);
  assert.equal(line.percent, null);
});

test('toScheduleLines: an unknown status fails safe to not_started', () => {
  const [line] = toScheduleLines([task({ status: 'wibble' })]);
  assert.equal(line.status, 'not_started');
});

test('toRecordHeader: no dated baseline anywhere → null (the honest "No baseline yet")', () => {
  const h = toRecordHeader(project, [task(), task({ id: 't2', baseline: null })]);
  assert.equal(h.state, 'accepted');
  assert.equal(h.baseline, null);
});

test('toRecordHeader: reports the highest baseline version across dated tasks', () => {
  const h = toRecordHeader(project, [
    task({ baseline: { start: '2026-01-05', finish: '2026-01-20', version: 1 } }),
    task({ id: 't2', baseline: { start: '2026-02-01', finish: '2026-02-10', version: 3 } }),
  ]);
  assert.deepEqual(h.baseline, { versionNo: 3, frozenAt: null });
});

test('toRecordHeader: a baseline with no dates is not a baseline', () => {
  const h = toRecordHeader(project, [
    task({ baseline: { start: null, finish: null, version: 2 } }),
  ]);
  assert.equal(h.baseline, null);
});

test('toRecordHeader: always "accepted" — never a deviation from schedule status', () => {
  const h = toRecordHeader(project, [task({ status: 'blocked' }), task({ id: 't2', status: 'done' })]);
  assert.equal(h.state, 'accepted');
});
