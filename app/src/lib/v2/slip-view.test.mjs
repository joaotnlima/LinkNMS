// PRD-13 view mapping: server segments/deltas → the plan's words. No maths here.
// Run: node --test src/lib/v2/slip-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toPlanSlipView, deltaWord, segmentLabel, barLabel, isLateOrExtended, handoverWords,
  toChangeItem, liveChanges, filterChanges, toMoveImpact, initials, dayMonth, baselineOrigin,
} from './slip-view.ts';

const ROOF = {
  id: 'roof', name: 'Roofing', start: '2027-02-01', finish: '2027-03-05', status: 'in_progress',
  can_edit: true, editor_is_assignee: true, assignee: { org_id: 'tn', org_name: 'Telhados do Norte' },
  baseline: { start: '2027-02-01', finish: '2027-02-26', version: 1, reason: 'award', taken_at: '2027-01-28T10:00:00Z' },
  segments: [
    { kind: 'baseline', from: '2027-02-01', to: '2027-02-26', moved: true },
    { kind: 'current', from: '2027-02-01', to: '2027-03-05' },
    { kind: 'extension', from: '2027-02-26', to: '2027-03-05', delta_wd: 5, cause: 'moved', by_org_id: 'tn' },
  ],
  baseline_delta_wd: 5,
};
const FRAME = {
  id: 'frame', name: 'Frame', start: '2027-01-15', finish: '2027-02-05', status: 'in_progress',
  baseline: null,
  segments: [
    { kind: 'current', from: '2027-01-15', to: '2027-02-05' },
    { kind: 'overrun', from: '2027-02-05', to: '2027-02-12', delta_wd: 5, cause: 'not_closed' },
  ],
  overrun_wd: 5,
};
const COVER = {
  id: 'cover', name: 'Covering', start: '2027-02-08', finish: '2027-02-12',
  baseline: null, segments: [
    { kind: 'projected', from: '2027-02-12', to: '2027-02-17', delta_wd: 3, cause: 'pushed', cause_task_id: 'frame' },
  ],
  projected: { start: '2027-02-11', finish: '2027-02-17', cause_task_id: 'frame' },
};

const ctx = {
  outlineOf: (id) => ({ frame: '2.3' })[id] ?? null,
  orgNameOf: (id) => ({ tn: 'Telhados do Norte' })[id] ?? null,
};

test('the schedule read becomes a slip view keyed by task id', () => {
  const v = toPlanSlipView({
    tasks: [ROOF, FRAME, COVER],
    handover: { finish: '2027-04-30', projected_finish: '2027-05-07', baseline_finish: '2027-04-30', delta_wd: 5 },
    changes: { total: 4, unseen: 1 },
  });
  assert.equal(v.baselined, true);
  assert.equal(v.byTask.roof.deltaWd, 5);
  assert.equal(v.byTask.roof.baseline.reason, 'award');
  assert.equal(v.byTask.frame.overrunWd, 5);
  assert.equal(v.byTask.cover.projected.causeTaskId, 'frame');
  assert.deepEqual(v.changes, { total: 4, unseen: 1 });
  assert.deepEqual(handoverWords(v.handover), { date: '7 May', delta: '+5 wd', tone: 'up' });
});

test('no baseline anywhere → no column, and an empty read is harmless', () => {
  const v = toPlanSlipView({ tasks: [FRAME] });
  assert.equal(v.baselined, false);
  assert.equal(v.handover, null);
  assert.deepEqual(toPlanSlipView({}).byTask, {});
});

test('S-5 words: +n wd / on plan / −n wd', () => {
  assert.deepEqual(deltaWord(5), { text: '+5 wd', tone: 'up' });
  assert.deepEqual(deltaWord(0), { text: 'on plan', tone: 'zero' });
  assert.deepEqual(deltaWord(-3), { text: '−3 wd', tone: 'down' });
  assert.equal(deltaWord(null), null);
});

test('S-4 labels: moved by initials, pushed by outline, not closed, closed late/early', () => {
  const v = toPlanSlipView({ tasks: [ROOF, FRAME, COVER] });
  assert.equal(barLabel(v.byTask.roof, ctx).text, '+5 wd · moved by TN');
  assert.equal(barLabel(v.byTask.frame, ctx).text, '+5 wd · not closed');
  assert.equal(barLabel(v.byTask.cover, ctx).text, '+3 wd · pushed by 2.3');
  const late = { kind: 'extension', from: 'a', to: 'b', moved: false, deltaWd: 7, cause: 'closed_late', causeTaskId: null, byOrgId: null };
  assert.equal(segmentLabel(late, ctx), '+7 wd · closed late');
  const early = { ...late, kind: 'actual', deltaWd: -3, cause: 'closed_early' };
  assert.equal(segmentLabel(early, ctx), '−3 wd · closed early');
});

test('S-7: late or extended', () => {
  const v = toPlanSlipView({ tasks: [ROOF, FRAME, COVER, { id: 'ok', name: 'Ok', start: null, finish: null, baseline_delta_wd: 0 }] });
  assert.equal(isLateOrExtended(v.byTask.roof), true);
  assert.equal(isLateOrExtended(v.byTask.frame), true);
  assert.equal(isLateOrExtended(v.byTask.cover), true);
  assert.equal(isLateOrExtended(v.byTask.ok), false);
  assert.equal(isLateOrExtended(undefined), false);
});

const VAR = {
  id: 'v1', task_id: 'roof', task_name: 'Roofing', kind: 'time',
  baseline_value: { start: '2027-02-01', finish: '2027-02-26' },
  current_value: { start: '2027-02-01', finish: '2027-03-05' },
  delta: { start_wd: 0, finish_wd: 5 }, cause: 'direct', reason: 'Tiles arrive 10 days late.',
  changed_by_org_name: 'Telhados do Norte', last_changed_at: '2027-02-03T14:10:00Z',
  status: 'open', acknowledged_by: [], seen_by_viewer: false, can_acknowledge: true,
};

test('S-13: a variation reads as who / when / from → to / why / seen', () => {
  const c = toChangeItem(VAR);
  assert.equal(c.what, 'Finish 26 Feb → 5 Mar');
  assert.equal(c.deltaWd, 5);
  assert.equal(c.who, 'Telhados do Norte');
  assert.equal(c.reason, 'Tiles arrive 10 days late.');
  assert.equal(c.seen, false);
  assert.equal(c.canAcknowledge, true);
  const pushed = toChangeItem({ ...VAR, id: 'v2', cause: 'propagated', cause_task_id: 'frame' });
  assert.equal(pushed.propagated, true);
  assert.equal(toChangeItem({ ...VAR, kind: 'scope', delta: { added: true } }).what, 'Added after the baseline');
});

test('S-15: live only; view filters all / not seen / time', () => {
  const items = liveChanges([
    VAR,
    { ...VAR, id: 'v2', seen_by_viewer: true },
    { ...VAR, id: 'v3', status: 'closed' },
    { ...VAR, id: 'v4', kind: 'scope', delta: { scope_text_changed: true } },
  ]);
  assert.deepEqual(items.map((c) => c.id), ['v1', 'v2', 'v4']);
  assert.deepEqual(filterChanges(items, 'unseen').map((c) => c.id), ['v1', 'v4']);
  assert.deepEqual(filterChanges(items, 'time').map((c) => c.id), ['v1', 'v2']);
});

test('S-10: the preview becomes the impact note', () => {
  const impact = toMoveImpact({
    would_move: [{ id: 'cover', name: 'Covering', start: 'x', finish: 'y' }],
    project_end_delta_wd: 5, project_finish: { before: '2027-05-07', after: '2027-05-14' },
    baseline_delta_wd: 10, notify: [{ org_id: 'o', org_name: 'Marta Almeida', role: 'owner' }],
  });
  assert.deepEqual(impact, {
    baselineDeltaWd: 10, pushes: [{ id: 'cover', name: 'Covering' }], handoverAfter: '2027-05-14',
    handoverMoves: true, notify: [{ name: 'Marta Almeida', role: 'owner' }],
  });
});

test('words: initials, dates, baseline origin', () => {
  assert.equal(initials('Telhados do Norte'), 'TN');
  assert.equal(initials('Obra Nova'), 'ON');
  assert.equal(initials(''), '?');
  assert.equal(dayMonth('2027-05-07'), '7 May');
  assert.equal(baselineOrigin({ version: 1, reason: 'award', takenAt: '2027-01-28T10:00:00Z' }), 'v1, taken at award · 28 Jan');
});
