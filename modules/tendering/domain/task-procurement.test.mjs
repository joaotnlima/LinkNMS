// The per-task procurement projection, pure: governing-RFP pick, landed-bid
// counts, the awarded winner, cancelled kept only when alone (PRD-01 G-2/G-3).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  taskProcurement, compareGoverning, laneCounts, isLandedBid,
} from './task-procurement.mjs';

const T1 = 'c0000000-0000-7000-8000-000000000001';
const T2 = 'c0000000-0000-7000-8000-000000000002';
const R1 = 'e0000000-0000-7000-8000-000000000001';
const R2 = 'e0000000-0000-7000-8000-000000000002';
const R3 = 'e0000000-0000-7000-8000-000000000003';
const ORG = 'a0000000-0000-7000-8000-000000000001';

function row(over = {}) {
  return {
    task_id: T1, id: R1, title: 'Canalização', status: 'published',
    created_at: '2026-12-01T09:00:00Z', submission_deadline: '2027-01-15T17:00:00Z',
    root_task_ids: [T1], lane_counts: {}, awarded_org_id: null, awarded_name: null,
    ...over,
  };
}

describe('landed bids', () => {
  test('submitted, shortlisted and awarded land; invited/draft/withdrawn/declined do not', () => {
    for (const s of ['submitted', 'shortlisted', 'awarded']) assert.equal(isLandedBid(s), true, s);
    for (const s of ['invited', 'draft', 'withdrawn', 'declined']) assert.equal(isLandedBid(s), false, s);
  });

  test('every lane is invited; only landed ones are submitted', () => {
    assert.deepEqual(
      laneCounts({ invited: 2, submitted: 1, shortlisted: 1, withdrawn: 1 }),
      { invited: 5, submitted: 2 },
    );
    assert.deepEqual(laneCounts(null), { invited: 0, submitted: 0 });
  });
});

describe('governing RFP', () => {
  test('awarded beats a newer live tender', () => {
    const awarded = row({ id: R1, status: 'awarded', created_at: '2026-01-01T00:00:00Z' });
    const live = row({ id: R2, status: 'published', created_at: '2026-06-01T00:00:00Z' });
    assert.ok(compareGoverning(awarded, live) < 0);
  });

  test('the newest live tender beats an older one and any cancelled one', () => {
    const older = row({ id: R1, created_at: '2026-01-01T00:00:00Z' });
    const newer = row({ id: R2, status: 'draft', created_at: '2026-06-01T00:00:00Z' });
    const cancelled = row({ id: R3, status: 'cancelled', created_at: '2026-09-01T00:00:00Z' });
    const [first] = taskProcurement([older, cancelled, newer]);
    assert.equal(first.rfp_id, R2);
  });

  test('a cancelled tender is kept when it is the row’s only one', () => {
    const [only] = taskProcurement([row({ status: 'cancelled' })]);
    assert.equal(only.status, 'cancelled');
  });
});

describe('taskProcurement', () => {
  test('one item per task, counts and dates folded, no money', () => {
    const items = taskProcurement([
      row({ task_id: T2, id: R2, root_task_ids: [T1, T2], lane_counts: { invited: 1, submitted: 2 } }),
      row({ task_id: T1, id: R2, root_task_ids: [T1, T2], lane_counts: { invited: 1, submitted: 2 } }),
    ]);
    assert.deepEqual(items.map((i) => i.task_id), [T1, T2]);
    assert.deepEqual(items[0], {
      task_id: T1, rfp_id: R2, title: 'Canalização', status: 'published',
      opened_at: '2026-12-01T09:00:00Z', submission_deadline: '2027-01-15T17:00:00Z',
      root_task_ids: [T1, T2], excluded_task_ids: [],
      published_at: null, closed_at: null, awarded_at: null, cancelled_at: null,
      cancel_reason: null,
      invited_count: 3, submitted_count: 2, awarded_to: null,
    });
  });

  test('PRD-02: lifecycle stamps, exclusions and a cancelled tender\'s reason ride along', () => {
    const [item] = taskProcurement([row({
      status: 'cancelled', excluded_task_ids: [T2], published_at: '2026-12-02T10:00:00Z',
      cancelled_at: '2026-12-05T10:00:00Z', cancel_reason: 'Owner changed the roof design',
    })]);
    assert.deepEqual(item.excluded_task_ids, [T2]);
    assert.equal(item.published_at, '2026-12-02T10:00:00Z');
    assert.equal(item.cancelled_at, '2026-12-05T10:00:00Z');
    assert.equal(item.cancel_reason, 'Owner changed the roof design');
    // A reason is only ever reported for the cancelled state.
    const [live] = taskProcurement([row({ cancel_reason: 'stale' })]);
    assert.equal(live.cancel_reason, null);
  });

  test('an awarded tender names its winner; an off-platform winner has a null org', () => {
    const [onPlatform] = taskProcurement([row({
      status: 'awarded', lane_counts: { awarded: 1, declined: 1 },
      awarded_org_id: ORG, awarded_name: 'Canalizações Norte',
    })]);
    assert.deepEqual(onPlatform.awarded_to, { org_id: ORG, name: 'Canalizações Norte' });
    assert.equal(onPlatform.submitted_count, 1);
    assert.equal(onPlatform.invited_count, 2);

    const [emailed] = taskProcurement([row({ status: 'awarded', awarded_name: 'obra@x.pt' })]);
    assert.deepEqual(emailed.awarded_to, { org_id: null, name: 'obra@x.pt' });
  });

  test('Date columns serialise to ISO', () => {
    const [item] = taskProcurement([row({
      created_at: new Date('2026-12-01T09:00:00Z'), submission_deadline: new Date('2027-01-15T17:00:00Z'),
    })]);
    assert.equal(item.opened_at, '2026-12-01T09:00:00.000Z');
    assert.equal(item.submission_deadline, '2027-01-15T17:00:00.000Z');
  });

  test('nothing tendered → empty', () => {
    assert.deepEqual(taskProcurement([]), []);
  });
});
