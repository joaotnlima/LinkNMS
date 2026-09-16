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
  moveBar, resizeStart, resizeEnd, applyDrag, scheduleWindow, clickDates,
  baseWindow, clipBarGeom, barRect, connectorPath, connectorMidpoint,
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

// ── Always-visible timeline (LINA-248) ───────────────────────────────────────

test('scheduleWindow: undated plan gets a today-anchored canvas', () => {
  const win = scheduleWindow([{ start: '', end: '' }], '2026-09-11');
  assert.ok(win);
  assert.equal(win.startDay, '2026-09-08'); // today − 3 pad
  assert.equal(win.days, 42);
  assert.equal(win.endDay, '2026-10-19');
});

test('scheduleWindow: dated plan keeps its envelope, extended to minDays', () => {
  // One short task → envelope is 1 + 2·3 pad = 7 days, extended right to 42.
  const win = scheduleWindow([{ start: '2026-03-10', end: '2026-03-10' }], '2026-09-11');
  assert.equal(win.startDay, '2026-03-07');
  assert.equal(win.days, 42);
  // A wide plan is left alone.
  const wide = scheduleWindow([{ start: '2026-01-01', end: '2026-06-30' }], '2026-09-11');
  assert.equal(wide.days, diffDays('2026-01-01', '2026-06-30') + 1 + 6);
});

test('scheduleWindow: garbage today with no dates → null (no canvas to draw)', () => {
  assert.equal(scheduleWindow([], 'not-a-day'), null);
});

test('clickDates: plants a one-week bar on the clicked day, clamped to the window', () => {
  const win = { startDay: '2026-09-08', endDay: '2026-10-19', days: 42 };
  assert.deepEqual(clickDates(win, 3), { start: '2026-09-11', end: '2026-09-18' });
  assert.deepEqual(clickDates(win, -5), { start: '2026-09-08', end: '2026-09-15' }); // clamp low
  assert.deepEqual(clickDates(win, 99).start, '2026-10-19'); // clamp high
});

// ── Time base + clipping (LINA-248 follow-up) ────────────────────────────────

test('baseWindow: auto delegates to the fitted scheduleWindow', () => {
  const tasks = [{ start: '2026-03-10', end: '2026-05-20' }];
  assert.deepEqual(baseWindow('auto', tasks, '2026-03-01'), scheduleWindow(tasks, '2026-03-01'));
});

test('baseWindow: fixed bases span exactly, anchored 2 days before the earliest dated day', () => {
  const tasks = [{ start: '2026-03-10', end: '2026-06-20' }];
  const week = baseWindow('week', tasks, '2026-01-01');
  assert.deepEqual(week, { startDay: '2026-03-08', endDay: '2026-03-14', days: 7 });
  assert.equal(baseWindow('quarter', tasks, '2026-01-01').days, 92);
  assert.equal(baseWindow('year', tasks, '2026-01-01').days, 365);
  // Nothing dated → anchored on today instead.
  assert.equal(baseWindow('month', [], '2026-03-10').startDay, '2026-03-08');
});

test('baseWindow: custom uses the typed range; a bad or inverted range falls back to auto', () => {
  const tasks = [{ start: '2026-03-10', end: '2026-03-20' }];
  const c = baseWindow('custom', tasks, '2026-03-01', { from: '2026-04-01', to: '2026-04-30' });
  assert.deepEqual(c, { startDay: '2026-04-01', endDay: '2026-04-30', days: 30 });
  assert.deepEqual(
    baseWindow('custom', tasks, '2026-03-01', { from: '2026-04-30', to: '2026-04-01' }),
    scheduleWindow(tasks, '2026-03-01'),
  );
  assert.deepEqual(
    baseWindow('custom', tasks, '2026-03-01', { from: '', to: '' }),
    scheduleWindow(tasks, '2026-03-01'),
  );
});

test('clipBarGeom: inside the window matches barGeom, no clip flags', () => {
  const win = { startDay: '2026-03-01', endDay: '2026-03-31', days: 31 };
  const clipped = clipBarGeom(win, '2026-03-05', '2026-03-10');
  assert.deepEqual(clipped, { ...barGeom(win, '2026-03-05', '2026-03-10'), clipStart: false, clipEnd: false });
});

test('clipBarGeom: an overhanging bar is clamped to the window edge and flagged, not dropped', () => {
  const win = { startDay: '2026-03-01', endDay: '2026-03-07', days: 7 };
  // barGeom drops it — the whole reason clipBarGeom exists for narrow windows.
  assert.equal(barGeom(win, '2026-02-25', '2026-03-03'), null);
  assert.deepEqual(clipBarGeom(win, '2026-02-25', '2026-03-03'),
    { offsetDays: 0, spanDays: 3, open: false, clipStart: true, clipEnd: false });
  assert.deepEqual(clipBarGeom(win, '2026-03-05', '2026-03-20'),
    { offsetDays: 4, spanDays: 3, open: false, clipStart: false, clipEnd: true });
  // Spanning the whole window clips both ends down to the full 7 columns.
  assert.deepEqual(clipBarGeom(win, '2026-02-01', '2026-04-01'),
    { offsetDays: 0, spanDays: 7, open: false, clipStart: true, clipEnd: true });
});

test('clipBarGeom: entirely outside the window, or undated, is still null', () => {
  const win = { startDay: '2026-03-01', endDay: '2026-03-07', days: 7 };
  assert.equal(clipBarGeom(win, '2026-04-01', '2026-04-05'), null);
  assert.equal(clipBarGeom(win, '2026-01-01', '2026-02-27'), null);
  assert.equal(clipBarGeom(win, '', ''), null);
});

// ── Dependency connectors (ADR-0020 §6, LINA-253) ────────────────────────────
// The anchor rule per type, and the two routes `starts_after` can take, are the
// whole visual claim the arrows make — so they are asserted here rather than
// eyeballed on a plan. Coordinates: a bar box is { x, width } with `y` the
// vertical middle of its row.

test('barRect: the bar box the connectors anchor to is the one the bar renders at', () => {
  assert.deepEqual(barRect(0, 1, 30), { x: 1, width: 28 });
  assert.deepEqual(barRect(3, 5, 30), { x: 91, width: 148 });
  // A hair-thin day column still leaves a grabbable 2px bar, never a negative one.
  assert.deepEqual(barRect(2, 1, 3), { x: 7, width: 2 });
});

test('connectorPath: starts_after routes pred RIGHT edge → dep LEFT edge, arrow right', () => {
  const pred = { x: 100, width: 60, y: 20 };   // right edge 160
  const dep = { x: 300, width: 60, y: 60 };
  const c = connectorPath(pred, dep, 'starts_after');
  assert.deepEqual(c.points[0], { x: 160, y: 20 });                    // leaves the finish
  assert.deepEqual(c.points[c.points.length - 1], { x: 300, y: 60 });  // arrives at the start
  assert.equal(c.head, 'right');
  // Forward route: out, down one stub short of the dependent, in.
  assert.deepEqual(c.points, [
    { x: 160, y: 20 }, { x: 288, y: 20 }, { x: 288, y: 60 }, { x: 300, y: 60 },
  ]);
  assert.equal(c.d, 'M160 20 L288 20 L288 60 L300 60');
});

test('connectorPath: starts_after routes AROUND when the dependent starts before the pred finishes', () => {
  const pred = { x: 100, width: 200, y: 20 };  // right edge 300
  const dep = { x: 140, width: 60, y: 60 };    // starts inside the predecessor
  const c = connectorPath(pred, dep, 'starts_after');
  // Out right of the predecessor, along the lane between the two rows, back in.
  assert.deepEqual(c.points, [
    { x: 300, y: 20 }, { x: 312, y: 20 }, { x: 312, y: 40 },
    { x: 128, y: 40 }, { x: 128, y: 60 }, { x: 140, y: 60 },
  ]);
  // Still anchored on the two edges the type constrains, still pointing in.
  assert.deepEqual(c.points[0], { x: 300, y: 20 });
  assert.deepEqual(c.points[c.points.length - 1], { x: 140, y: 60 });
  assert.equal(c.head, 'right');
});

test('connectorPath: starts_with is LEFT → LEFT, routed outside both bars', () => {
  const pred = { x: 200, width: 60, y: 20 };
  const dep = { x: 120, width: 60, y: 60 };
  const c = connectorPath(pred, dep, 'starts_with');
  assert.deepEqual(c.points, [
    { x: 200, y: 20 }, { x: 108, y: 20 }, { x: 108, y: 60 }, { x: 120, y: 60 },
  ]);
  // 108 is left of BOTH left edges — the elbow never crosses a bar it connects.
  assert.ok(c.points[1].x < Math.min(pred.x, dep.x));
  assert.equal(c.head, 'right');
});

test('connectorPath: ends_with is RIGHT → RIGHT, routed outside both bars, arrow left', () => {
  const pred = { x: 100, width: 60, y: 20 };   // right edge 160
  const dep = { x: 180, width: 100, y: 60 };   // right edge 280
  const c = connectorPath(pred, dep, 'ends_with');
  assert.deepEqual(c.points, [
    { x: 160, y: 20 }, { x: 292, y: 20 }, { x: 292, y: 60 }, { x: 280, y: 60 },
  ]);
  assert.ok(c.points[1].x > Math.max(160, 280));
  assert.equal(c.head, 'left'); // it arrives at the finish from the right
});

test('connectorPath: never routes off the left of the canvas', () => {
  const c = connectorPath({ x: 1, width: 20, y: 20 }, { x: 1, width: 20, y: 60 }, 'starts_with');
  assert.ok(c.points.every((p) => p.x >= 1));
  // A dependent hard against the left edge can still be reached backward.
  const back = connectorPath({ x: 1, width: 200, y: 20 }, { x: 2, width: 20, y: 60 }, 'starts_after');
  assert.ok(back.points.every((p) => p.x >= 1));
  assert.deepEqual(back.points[back.points.length - 1], { x: 2, y: 60 });
});

test('connectorPath: every segment is orthogonal, and none repeats', () => {
  const cases = [
    [{ x: 100, width: 60, y: 20 }, { x: 300, width: 60, y: 60 }, 'starts_after'],
    [{ x: 100, width: 200, y: 20 }, { x: 140, width: 60, y: 60 }, 'starts_after'],
    [{ x: 200, width: 60, y: 20 }, { x: 120, width: 60, y: 60 }, 'starts_with'],
    [{ x: 100, width: 60, y: 20 }, { x: 180, width: 100, y: 60 }, 'ends_with'],
  ];
  for (const [pred, dep, type] of cases) {
    const { points } = connectorPath(pred, dep, type);
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      assert.ok(a.x === b.x || a.y === b.y, `${type} segment ${i} is diagonal`);
      assert.ok(a.x !== b.x || a.y !== b.y, `${type} segment ${i} is zero-length`);
    }
  }
});

test('connectorPath: the path tracks the bars — a dragged bar moves its anchors with it', () => {
  const pred = { x: 100, width: 60, y: 20 };
  const dep = { x: 300, width: 60, y: 60 };
  const before = connectorPath(pred, dep, 'starts_after');
  // The same link after the dependent is dragged 30px (one day at the default
  // column width) later: the head follows, nothing else is remembered.
  const after = connectorPath(pred, { ...dep, x: 330 }, 'starts_after');
  assert.deepEqual(after.points[after.points.length - 1], { x: 330, y: 60 });
  assert.deepEqual(after.points[0], before.points[0]);
  assert.notDeepEqual(after.d, before.d);
});

test('connectorMidpoint: the arc-length midpoint lands in the middle of the arrow', () => {
  // A 3-segment elbow, each leg 10px long → total 30, half at 15px in: 10px down
  // the first leg leaves 5px into the middle (vertical) leg — its own midpoint.
  const elbow = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 10 }];
  assert.deepEqual(connectorMidpoint(elbow), { x: 10, y: 5 });

  // A straight run: the geometric middle.
  assert.deepEqual(connectorMidpoint([{ x: 0, y: 0 }, { x: 10, y: 0 }]), { x: 5, y: 0 });

  // Degenerate inputs never throw — an empty path is the origin, a single point
  // is itself, a zero-length path is its start.
  assert.deepEqual(connectorMidpoint([]), { x: 0, y: 0 });
  assert.deepEqual(connectorMidpoint([{ x: 4, y: 7 }]), { x: 4, y: 7 });
  assert.deepEqual(connectorMidpoint([{ x: 3, y: 3 }, { x: 3, y: 3 }]), { x: 3, y: 3 });
});
