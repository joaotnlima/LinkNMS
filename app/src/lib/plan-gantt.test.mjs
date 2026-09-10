// Unit tests for the Gantt drag-to-schedule / resize math (LINA-236).
//
// The component is layout + pointer plumbing; these seams are the logic:
//   1. calendar-day parsing is UTC, rejects impossible days, and round-trips;
//   2. a drag of N columns moves a task EXACTLY N calendar days (no TZ drift);
//   3. move preserves duration; resize clamps so a task never ends before it
//      starts; half-dated tasks stay grabbable.
//
// Run: node --test src/lib/plan-gantt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDay, formatDay, addDays, diffDays,
  ganttWindow, barGeom, daysFromPixels,
  moveBar, resizeStart, resizeEnd, applyDrag,
} from './plan-gantt.ts';

test('parseDay: UTC round-trip, rejects blanks and impossible days', () => {
  assert.equal(parseDay('2026-03-01'), Date.UTC(2026, 2, 1));
  assert.equal(formatDay(parseDay('2026-03-01')), '2026-03-01');
  assert.equal(parseDay(''), null);
  assert.equal(parseDay('2026-13-01'), null); // no month 13
  assert.equal(parseDay('2026-02-30'), null); // February has no 30th
  assert.equal(parseDay('2026-3-1'), null); // not zero-padded → not a valid day string
});

test('addDays: whole-day arithmetic across month and year boundaries', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-10', -1), '2026-03-09');
  assert.equal(addDays('', 5), ''); // blank passes through
});

test('addDays: no drift across a spring-forward DST boundary', () => {
  // US DST 2026 begins 2026-03-08. A pure-UTC day math must still land on the 9th.
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(diffDays('2026-03-07', '2026-03-09'), 2);
});

test('diffDays: signed whole days, null when either end unset', () => {
  assert.equal(diffDays('2026-03-01', '2026-03-05'), 4);
  assert.equal(diffDays('2026-03-05', '2026-03-01'), -4);
  assert.equal(diffDays('2026-03-05', ''), null);
});

test('ganttWindow: earliest start to latest finish, padded both sides', () => {
  const win = ganttWindow(
    [{ start: '2026-03-10', end: '2026-03-12' }, { start: '2026-03-20', end: '' }],
    3,
  );
  assert.equal(win.startDay, '2026-03-07'); // 03-10 − 3
  assert.equal(win.endDay, '2026-03-23'); // 03-20 + 3
  assert.equal(win.days, diffDays('2026-03-07', '2026-03-23') + 1);
});

test('ganttWindow: null when nothing is dated', () => {
  assert.equal(ganttWindow([{ start: '', end: '' }]), null);
  assert.equal(ganttWindow([]), null);
});

test('barGeom: inclusive span, same-day is one column', () => {
  const win = ganttWindow([{ start: '2026-03-10', end: '2026-03-12' }], 3);
  const bar = barGeom(win, '2026-03-10', '2026-03-12');
  assert.equal(bar.offsetDays, 3); // window starts 03-07
  assert.equal(bar.spanDays, 3); // 10,11,12 inclusive
  assert.equal(bar.open, false);

  const same = barGeom(win, '2026-03-11', '2026-03-11');
  assert.equal(same.spanDays, 1);
});

test('barGeom: a half-dated task renders as a 1-day open bar', () => {
  const win = ganttWindow([{ start: '2026-03-10', end: '2026-03-20' }], 3);
  const startOnly = barGeom(win, '2026-03-15', '');
  assert.equal(startOnly.spanDays, 1);
  assert.equal(startOnly.open, true);
  const endOnly = barGeom(win, '', '2026-03-15');
  assert.equal(endOnly.spanDays, 1);
  assert.equal(endOnly.open, true);
});

test('barGeom: null when undated or outside the window', () => {
  const win = ganttWindow([{ start: '2026-03-10', end: '2026-03-12' }], 0);
  assert.equal(barGeom(win, '', ''), null);
  assert.equal(barGeom(win, '2026-04-01', '2026-04-02'), null); // past the padded window
});

test('daysFromPixels: snaps to nearest whole column', () => {
  assert.equal(daysFromPixels(0, 28), 0);
  assert.equal(daysFromPixels(28, 28), 1);
  assert.equal(daysFromPixels(41, 28), 1); // < 1.5 cols → 1
  assert.equal(daysFromPixels(42, 28), 2); // ≥ 1.5 cols → 2
  assert.equal(daysFromPixels(-28, 28), -1);
  assert.equal(daysFromPixels(100, 0), 0); // guard against a zero column width
});

test('moveBar: shifts both ends, preserves duration; blank end stays blank', () => {
  const both = moveBar('2026-03-10', '2026-03-12', 5);
  assert.deepEqual(both, { start: '2026-03-15', end: '2026-03-17' });
  const open = moveBar('2026-03-10', '', 5);
  assert.deepEqual(open, { start: '2026-03-15', end: '' });
});

test('resizeStart: moves start only, clamps at the end', () => {
  assert.deepEqual(
    resizeStart('2026-03-10', '2026-03-14', 2),
    { start: '2026-03-12', end: '2026-03-14' },
  );
  // dragging the start past the end pins it to the end (never ends before it starts)
  assert.deepEqual(
    resizeStart('2026-03-10', '2026-03-14', 10),
    { start: '2026-03-14', end: '2026-03-14' },
  );
  // with no end set, the start moves freely
  assert.deepEqual(resizeStart('2026-03-10', '', 10), { start: '2026-03-20', end: '' });
  // with no start set, nothing to resize
  assert.deepEqual(resizeStart('', '2026-03-14', 2), { start: '', end: '2026-03-14' });
});

test('resizeEnd: moves end only, clamps at the start', () => {
  assert.deepEqual(
    resizeEnd('2026-03-10', '2026-03-14', 2),
    { start: '2026-03-10', end: '2026-03-16' },
  );
  // dragging the end before the start pins it to the start
  assert.deepEqual(
    resizeEnd('2026-03-10', '2026-03-14', -10),
    { start: '2026-03-10', end: '2026-03-10' },
  );
  assert.deepEqual(resizeEnd('', '2026-03-14', 2), { start: '', end: '2026-03-16' });
});

test('applyDrag: a zero-day drag is a no-op; dispatches by mode', () => {
  assert.deepEqual(
    applyDrag('move', '2026-03-10', '2026-03-12', 10, 28), // 10px < half a 28px col
    { start: '2026-03-10', end: '2026-03-12' },
  );
  assert.deepEqual(
    applyDrag('move', '2026-03-10', '2026-03-12', 28, 28),
    { start: '2026-03-11', end: '2026-03-13' },
  );
  assert.deepEqual(
    applyDrag('resize-end', '2026-03-10', '2026-03-12', 56, 28),
    { start: '2026-03-10', end: '2026-03-14' },
  );
});
