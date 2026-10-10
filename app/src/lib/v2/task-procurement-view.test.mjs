// Unit tests for the plan's per-task procurement mapping (PRD-01 G-2/G-3):
// the server's TaskProcurement items → the grid/Gantt `ProcurementRfp` map.
//
// Run: node --experimental-strip-types --test src/lib/v2/task-procurement-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toProcurementWindows } from './task-procurement-view.ts';
import { procurementChip, procurementTabLabel } from '../plan-gantt.ts';

const T1 = 't1';
const T2 = 't2';

function item(over = {}) {
  return {
    task_id: T1, rfp_id: 'r1', title: 'Canalização', status: 'published',
    opened_at: '2026-11-01T09:00:00Z', submission_deadline: '2027-01-15T17:00:00Z',
    root_task_ids: [T1, T2], invited_count: 3, submitted_count: 1, awarded_to: null,
    ...over,
  };
}

test('keys by task id, slices timestamps to calendar days, carries counts + title', () => {
  const out = toProcurementWindows([item(), item({ task_id: T2 })]);
  assert.deepEqual(Object.keys(out), [T1, T2]);
  assert.deepEqual(out[T1], {
    status: 'published', openedDay: '2026-11-01', bidsDueDay: '2027-01-15',
    submittedCount: 1, invitedCount: 3, title: 'Canalização', rfpId: 'r1',
  });
});

test('an awarded item carries the winner name — the chip reads "Awarded · {company}"', () => {
  const out = toProcurementWindows([item({
    status: 'awarded', submitted_count: 1, awarded_to: { org_id: 'o1', name: 'Canalizações Norte' },
  })]);
  assert.equal(out[T1].awardedTo, 'Canalizações Norte');
  assert.equal(procurementChip(out[T1]).label, 'Awarded · Canalizações Norte');
});

test('chip and tab words are unchanged: n/m in, bids in, cancelled', () => {
  const open = toProcurementWindows([item({ submitted_count: 0 })])[T1];
  assert.equal(procurementChip(open).label, 'Out for bids · 0/3 in');
  assert.equal(procurementTabLabel(open), '0/3');
  const landed = toProcurementWindows([item()])[T1];
  assert.equal(procurementChip(landed).label, 'Bids in · 1/3 — your move');
  const cancelled = toProcurementWindows([item({ status: 'cancelled' })])[T1];
  assert.equal(procurementChip(cancelled).label, 'Cancelled');
});

test('an item with nothing to paint is dropped; empty in → empty out', () => {
  assert.deepEqual(toProcurementWindows([item({ opened_at: '' })]), {});
  assert.deepEqual(toProcurementWindows([]), {});
});

test('PRD-02: the governing RFP id, the left-out rows and a cancel reason ride along', () => {
  const out = toProcurementWindows([item({
    status: 'cancelled', excluded_task_ids: ['t9'], cancel_reason: 'Owner changed the roof design',
  })])[T1];
  assert.equal(out.rfpId, item().rfp_id);
  assert.deepEqual(out.excludedTaskIds, ['t9']);
  assert.equal(out.cancelReason, 'Owner changed the roof design');
  assert.equal(procurementChip(out).title, 'Tender cancelled — Owner changed the roof design');
});
