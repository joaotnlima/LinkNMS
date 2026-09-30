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

import { toRecordHeader, toScheduleLines, toHistoryLines, eventSentenceV2 } from './record-view.ts';

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

// ── History / audit-ledger transform (LINA-359 shape, LINA-382 audit surface) ──

const entry = (over = {}) => ({
  seq: 1, occurred_at: '2026-03-01T10:00:00.000Z', category: 'project',
  type: 'project.created', redacted: false, entry_hash: 'abc123', prev_hash: null,
  actor: { person_id: 'p1', org_id: 'o1', org_role: 'general_contractor' }, ...over,
});

test('toHistoryLines: an in-scope entry carries its sentence, actor org + hash', () => {
  const [row] = toHistoryLines([entry()]);
  assert.equal(row.seq, 1);
  assert.equal(row.sentence, 'The build was created');
  assert.equal(row.redacted, false);
  assert.equal(row.actorOrgId, 'o1');
  assert.equal(row.actorOrgRole, 'general_contractor');
  assert.equal(row.entryHash, 'abc123');
  assert.equal(row.occurredAt, '2026-03-01T10:00:00.000Z');
});

test('toHistoryLines: a redacted entry keeps seq/category/hash but no actor or type', () => {
  const [row] = toHistoryLines([entry({ redacted: true, entry_hash: 'def456' })]);
  assert.equal(row.redacted, true);
  assert.equal(row.sentence, 'A change you do not have access to was recorded');
  assert.equal(row.actorOrgId, null);
  assert.equal(row.actorOrgRole, null);
  // V7: the hash is kept on a redacted row so the chain still verifies.
  assert.equal(row.entryHash, 'def456');
});

test('toHistoryLines: preserves the server order (newest first) it is given', () => {
  const rows = toHistoryLines([entry({ seq: 9 }), entry({ seq: 4 }), entry({ seq: 2 })]);
  assert.deepEqual(rows.map((r) => r.seq), [9, 4, 2]);
});

test('eventSentenceV2: a known type maps to its sentence', () => {
  assert.equal(eventSentenceV2('contracting.change_order.approved'), 'A change order was approved');
});

test('eventSentenceV2: an unknown type humanises the tail rather than hiding it', () => {
  assert.equal(eventSentenceV2('billing.invoice.settled'), 'Invoice settled');
  assert.equal(eventSentenceV2(''), '');
});
