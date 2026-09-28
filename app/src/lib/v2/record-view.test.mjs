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

import { toRecordHeader, toScheduleLines, toHistoryEntries, humaniseEventType } from './record-view.ts';

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

// ── History tab ───────────────────────────────────────────────────────────────

const entry = (over = {}) => ({
  seq: 3, occurred_at: '2026-09-20T10:00:00.000Z', category: 'contracting',
  type: 'contracting.change_order.decided',
  actor: { person_id: 'p1', org_id: 'o1', org_role: 'site_lead' },
  object_type: 'change_order', object_id: 'co1',
  payload: { delta_cents: 1200 }, redacted: false, entry_hash: 'h3', prev_hash: 'h2', ...over,
});

test('humaniseEventType: drops the category, humanises the tail', () => {
  assert.equal(humaniseEventType('contracting.change_order.decided'), 'Change order decided');
  assert.equal(humaniseEventType('planning.progress.reported'), 'Progress reported');
});

test('humaniseEventType: falls back to the raw type when there is no tail', () => {
  assert.equal(humaniseEventType('created'), 'Created');
});

test('toHistoryEntries: maps an in-scope entry, actor role surfaced', () => {
  const [row] = toHistoryEntries([entry()]);
  assert.equal(row.seq, 3);
  assert.equal(row.action, 'Change order decided');
  assert.equal(row.eventType, 'contracting.change_order.decided');
  assert.equal(row.actorRole, 'site_lead');
  assert.equal(row.objectType, 'change_order');
  assert.equal(row.redacted, false);
  assert.equal(row.entryHash, 'h3');
});

test('toHistoryEntries: a redacted entry keeps who/when/shape but is flagged', () => {
  const [row] = toHistoryEntries([entry({ redacted: true, payload: undefined })]);
  assert.equal(row.redacted, true);
  assert.equal(row.action, 'Change order decided'); // the shape is still shown
  assert.equal(row.entryHash, 'h3'); // the chain fields survive redaction
});

test('toHistoryEntries: a null actor role does not crash', () => {
  const [row] = toHistoryEntries([entry({ actor: { person_id: null, org_id: null, org_role: null } })]);
  assert.equal(row.actorRole, null);
});

test('toHistoryEntries: preserves the server order (newest first)', () => {
  const rows = toHistoryEntries([entry({ seq: 5 }), entry({ seq: 4 }), entry({ seq: 3 })]);
  assert.deepEqual(rows.map((r) => r.seq), [5, 4, 3]);
});
