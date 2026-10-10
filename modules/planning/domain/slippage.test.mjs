// Slippage maths (PRD-13, D-44) — pure, explicit `today`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeCalendar } from './calendar.mjs';
import { effectiveSpans } from './propagation.mjs';
import {
  isClosed, overrunPicture, baselineFinishes, slipCause, segmentsOf, handoverOf,
} from './slippage.mjs';

const cal = makeCalendar({ work_days: [1, 2, 3, 4, 5] });

function row(id, over = {}) {
  return {
    id, parentId: null, kind: 'task', start: null, finish: null, durationWd: null,
    actualStart: null, actualFinish: null, baselineStart: null, baselineFinish: null,
    lastChangeCause: null, lastChangedByOrgId: null, ...over,
  };
}

// 2027-02-01 is a Monday.
const FRAME = row('frame', { start: '2027-01-18', finish: '2027-02-05', durationWd: 15,
  baselineStart: '2027-01-18', baselineFinish: '2027-02-05' });
const COVER = row('cover', { start: '2027-02-08', finish: '2027-02-12', durationWd: 5,
  baselineStart: '2027-02-08', baselineFinish: '2027-02-12' });
const LINK = { id: 'l', predecessorId: 'frame', successorId: 'cover', fromAnchor: 'end', toAnchor: 'start', lagWd: 0 };

const plan = (rows) => new Map(rows.map((r) => [r.id, r]));
const counts = (tasks) => {
  const m = new Map();
  for (const t of tasks.values()) if (t.parentId) m.set(t.parentId, (m.get(t.parentId) ?? 0) + 1);
  return m;
};

test('closed = an actual finish, or done / verified reported', () => {
  assert.equal(isClosed(row('a'), 'in_progress'), false);
  assert.equal(isClosed(row('a'), 'done'), true);
  assert.equal(isClosed(row('a'), 'verified'), true);
  assert.equal(isClosed(row('a', { actualFinish: '2027-01-01' }), undefined), true);
});

test('overrun: a leaf not closed past its finish runs to today and pushes its successor (projection only)', () => {
  const tasks = plan([FRAME, COVER]);
  const pic = overrunPicture({
    tasks, links: [LINK], calendar: cal, statuses: new Map(), counts: counts(tasks), today: '2027-02-12',
  });
  assert.deepEqual([...pic.overrunIds], ['frame']);
  // frame now "finishes" Fri 12 Feb → cover starts Mon 15 Feb, keeps 5 wd.
  assert.deepEqual(pic.projected.get('cover'), { start: '2027-02-15', finish: '2027-02-19', causeTaskId: 'frame' });
  assert.equal(pic.spans.get('frame').finish, '2027-02-12');
  // the plan in memory is untouched (D-44: nothing is written)
  assert.equal(tasks.get('cover').start, '2027-02-08');
});

test('overrun never applies to a closed row, a summary, or before the finish', () => {
  const parent = row('p');
  const child = row('c', { parentId: 'p', start: '2027-01-04', finish: '2027-01-08' });
  const done = row('d', { start: '2027-01-04', finish: '2027-01-08' });
  const tasks = plan([parent, child, done, COVER]);
  const pic = overrunPicture({
    tasks, links: [], calendar: cal, statuses: new Map([['d', 'done']]), counts: counts(tasks), today: '2027-02-10',
  });
  assert.deepEqual([...pic.overrunIds].sort(), ['c']);
  const early = overrunPicture({
    tasks: plan([COVER]), links: [], calendar: cal, statuses: new Map(), counts: new Map(), today: '2027-02-12',
  });
  assert.equal(early.overrunIds.size, 0);
});

test('baseline finish of a summary is the latest in its subtree', () => {
  const p = row('p', { baselineFinish: '2027-01-01' });
  const a = row('a', { parentId: 'p', baselineFinish: '2027-02-05' });
  const b = row('b', { parentId: 'p', baselineFinish: '2027-02-12' });
  const tasks = plan([p, a, b]);
  const m = baselineFinishes(tasks, counts(tasks));
  assert.equal(m.get('p'), '2027-02-12');
  assert.equal(m.get('a'), '2027-02-05');
});

test('slip cause: propagated → pushed by the cause task; direct → moved by the org', () => {
  assert.deepEqual(slipCause(row('x'), { cause: 'propagated', causeTaskId: 'frame' }), { cause: 'pushed', cause_task_id: 'frame' });
  assert.deepEqual(slipCause(row('x'), { cause: 'direct', lastChangedByOrgId: 'org-tn' }), { cause: 'moved', by_org_id: 'org-tn' });
  assert.deepEqual(slipCause(row('x', { lastChangeCause: 'propagated from frame' }), null), { cause: 'pushed', cause_task_id: 'frame' });
});

const segs = (task, extra = {}) => segmentsOf({
  task, span: effectiveSpans(plan([task])).get(task.id), status: undefined, isLeaf: true,
  overrunning: false, projected: null, timeVariation: null, today: '2027-03-10', calendar: cal, ...extra,
});

test('S-1/S-4: an extended finish is a labelled clay extension from the baseline finish', () => {
  // Roofing: baseline 1 Feb → 26 Feb, finish moved to 5 Mar = +5 wd.
  const roofing = row('roof', { start: '2027-02-01', finish: '2027-03-05',
    baselineStart: '2027-02-01', baselineFinish: '2027-02-26' });
  const out = segs(roofing, { timeVariation: { cause: 'direct', lastChangedByOrgId: 'org-tn' } });
  const ext = out.find((s) => s.kind === 'extension');
  assert.deepEqual(ext, { kind: 'extension', from: '2027-02-26', to: '2027-03-05', delta_wd: 5, cause: 'moved', by_org_id: 'org-tn' });
  assert.equal(out.find((s) => s.kind === 'baseline').moved, true);
});

test('S-2: overrun from the current finish to today, labelled not_closed', () => {
  const frame = row('frame', { start: '2027-01-18', finish: '2027-02-05' });
  const out = segs(frame, { overrunning: true, today: '2027-02-12' });
  assert.deepEqual(out.find((s) => s.kind === 'overrun'),
    { kind: 'overrun', from: '2027-02-05', to: '2027-02-12', delta_wd: 5, cause: 'not_closed' });
  // S-9: no baseline → no ghost, no extension, the overrun still draws
  assert.ok(!out.some((s) => ['baseline', 'extension'].includes(s.kind)));
});

test('S-3: closed late keeps a solid clay segment to the actual finish; closed early shows −n wd', () => {
  const late = row('late', { start: '2027-01-04', finish: '2027-01-08', actualStart: '2027-01-04',
    actualFinish: '2027-01-19', baselineStart: '2027-01-04', baselineFinish: '2027-01-08' });
  const ext = segs(late).find((s) => s.kind === 'extension');
  assert.equal(ext.cause, 'closed_late');
  assert.equal(ext.to, '2027-01-19');
  assert.equal(ext.delta_wd, 7);

  const early = row('early', { start: '2027-01-04', finish: '2027-01-15', actualStart: '2027-01-04',
    actualFinish: '2027-01-12', baselineStart: '2027-01-04', baselineFinish: '2027-01-15' });
  const out = segs(early);
  assert.ok(!out.some((s) => s.kind === 'extension'));
  const actual = out.find((s) => s.kind === 'actual');
  assert.equal(actual.cause, 'closed_early');
  assert.equal(actual.delta_wd, -3);
});

test('projected segment: the push an overrun would make, from the current finish', () => {
  const out = segs(COVER, { projected: { start: '2027-02-15', finish: '2027-02-19', causeTaskId: 'frame' } });
  assert.deepEqual(out.find((s) => s.kind === 'projected'),
    { kind: 'projected', from: '2027-02-12', to: '2027-02-19', delta_wd: 5, cause: 'pushed', cause_task_id: 'frame' });
});

test('a summary\'s extension is its net', () => {
  const sum = row('s', { start: '2027-02-01', finish: '2027-03-05', baselineStart: '2027-02-01', baselineFinish: '2027-02-26' });
  const out = segmentsOf({
    task: sum, span: { start: '2027-02-01', finish: '2027-03-05' }, status: undefined, isLeaf: false,
    overrunning: false, projected: null, timeVariation: null, today: '2027-03-10', calendar: cal,
  });
  assert.equal(out.find((s) => s.kind === 'extension').cause, 'net');
});

test('S-6: handover = latest finish; projected with overruns; delta vs the latest baseline finish', () => {
  const tasks = plan([FRAME, COVER]);
  const spans = effectiveSpans(tasks);
  const pic = overrunPicture({
    tasks, links: [LINK], calendar: cal, statuses: new Map(), counts: counts(tasks), today: '2027-02-12',
  });
  const h = handoverOf({
    tasks, spans, projectedSpans: pic.spans, baselineFinishById: baselineFinishes(tasks, counts(tasks)), calendar: cal,
  });
  assert.deepEqual(h, { finish: '2027-02-12', projected_finish: '2027-02-19', baseline_finish: '2027-02-12', delta_wd: 5 });
  const none = handoverOf({
    tasks: plan([row('x', { start: '2027-01-04', finish: '2027-01-08' })]),
    spans: new Map([['x', { start: '2027-01-04', finish: '2027-01-08' }]]),
    projectedSpans: new Map(), baselineFinishById: new Map(), calendar: cal,
  });
  assert.deepEqual(none, { finish: '2027-01-08', projected_finish: '2027-01-08' });
});
