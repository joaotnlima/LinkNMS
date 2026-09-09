// Unit tests for the M14 record-home date math (LINA-223, ADR-0015 §4/§5).
//
// The week line and the stage span are the seams that fail expensively: a wrong
// fold shows the owner "Week 9 of 6" or invents a schedule out of a plan that
// carries no dates. The rendering is layout; these are the arithmetic.
//
// Run: node --test src/lib/   (Node's native TS type-stripping imports the .ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scheduleSpan, weekLine, timelineTone, timelineStateLabel } from './record-home.ts';

function line(over = {}) {
  return {
    stageId: 's', name: 'Stage', position: 0,
    plannedStartDate: null, plannedEndDate: null,
    status: 'not_started', percent: null, ...over,
  };
}

test('scheduleSpan folds min start / max end across dated stages', () => {
  const span = scheduleSpan([
    line({ plannedStartDate: '2026-02-01', plannedEndDate: '2026-02-14' }),
    line({ plannedStartDate: '2026-01-10', plannedEndDate: '2026-01-31' }),
    line({ plannedStartDate: '2026-03-01', plannedEndDate: '2026-04-15' }),
  ]);
  assert.ok(span);
  assert.equal(span.start.toISOString().slice(0, 10), '2026-01-10');
  assert.equal(span.end.toISOString().slice(0, 10), '2026-04-15');
});

test('scheduleSpan is null when no stage carries both dates — no invented schedule', () => {
  assert.equal(scheduleSpan([]), null);
  assert.equal(scheduleSpan([line(), line()]), null);
  // A start with no matching end anywhere is not a span.
  assert.equal(scheduleSpan([line({ plannedStartDate: '2026-01-01' })]), null);
});

test('weekLine: current week, 1-based, from the baseline span', () => {
  const lines = [line({ plannedStartDate: '2026-01-01', plannedEndDate: '2026-02-26' })]; // 8 weeks
  const wl = weekLine(lines, new Date('2026-01-15T00:00:00Z'));
  assert.deepEqual(wl, { week: 3, total: 8 });
});

test('weekLine clamps before the start (never week 0) and after the end', () => {
  const lines = [line({ plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-29' })]; // 4 weeks
  assert.deepEqual(weekLine(lines, new Date('2025-12-01T00:00:00Z')), { week: 1, total: 4 });
  assert.deepEqual(weekLine(lines, new Date('2026-06-01T00:00:00Z')), { week: 4, total: 4 });
});

test('weekLine is null without a dated span — the line is omitted', () => {
  assert.equal(weekLine([line()], new Date('2026-01-01T00:00:00Z')), null);
});

test('timelineTone maps progress status to the honest visual', () => {
  assert.equal(timelineTone('done'), 'closed');
  assert.equal(timelineTone('in_progress'), 'progress');
  assert.equal(timelineTone('blocked'), 'blocked');
  assert.equal(timelineTone('not_started'), 'plan');
});

test('timelineStateLabel carries the word, not just the colour (FR9)', () => {
  assert.equal(timelineStateLabel('done'), 'Closed');
  assert.equal(timelineStateLabel('in_progress'), 'In progress');
  assert.equal(timelineStateLabel('not_started'), 'Not started');
  assert.equal(timelineStateLabel('blocked'), 'Blocked');
});
