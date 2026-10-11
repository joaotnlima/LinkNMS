// PRD-10 E-1, E-5..E-11 — the pure rules: what a task waits on, the
// acceptance checklist, the site calendar with overlaps, the daily log shapes
// and the plan drawn against a chosen baseline.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  waitingOn, isStart, acceptanceChecklist, acceptanceRecord, waitingSnapshot,
} from './execution.mjs';
import { siteCalendar, calendarWindow, effectiveLocation } from './site-calendar.mjs';
import { validateEntries, validateLogDate, dayBody, daySummaries, sameEntry } from './daily-log.mjs';
import { baselineList, rebaseOn } from './baselines.mjs';
import { makeCalendar } from './calendar.mjs';
import { effectiveSpans } from './propagation.mjs';

const t = (id, over = {}) => ({ id, name: id, parentId: null, kind: 'task', ...over });
const link = (pred, succ, fromAnchor = 'end', toAnchor = 'start') => ({
  id: `${pred}>${succ}`, predecessorId: pred, successorId: succ, fromAnchor, toAnchor,
});

describe('E-5 what a task waits on', () => {
  const tasks = new Map([['A', t('A')], ['B', t('B')], ['C', t('C', { actualStart: '2026-02-02' })], ['S', t('S')]]);
  const links = [link('A', 'S'), link('B', 'S', 'start', 'start'), link('C', 'S', 'end', 'end')];

  test('end→start needs the predecessor finished, start→start started; links into the end never gate', () => {
    const w = waitingOn({ taskId: 'S', tasks, links, statuses: new Map([['B', 'in_progress']]) });
    assert.deepEqual(w.map((x) => [x.task_id, x.needs, x.met, x.status]), [
      ['A', 'finished', false, 'not_started'],
      ['B', 'started', true, 'in_progress'],
    ]);
    const done = waitingOn({ taskId: 'S', tasks, links, statuses: new Map([['A', 'done']]) });
    assert.equal(done.find((x) => x.task_id === 'A').met, true);
    assert.deepEqual(waitingSnapshot(w), [{ task_id: 'A', name: 'A', status: 'not_started', needs: 'finished' }]);
  });

  test('a start is the first report past not_started of a task with no actuals', () => {
    assert.equal(isStart(t('X'), 'not_started', 'in_progress'), true);
    assert.equal(isStart(t('X'), 'not_started', 'done'), true);
    assert.equal(isStart(t('X'), 'in_progress', 'done'), false);
    assert.equal(isStart(t('X', { actualStart: '2026-01-01' }), 'not_started', 'in_progress'), false);
    assert.equal(isStart(t('X'), 'not_started', 'not_started'), false);
  });
});

describe('E-6 acceptance checklist', () => {
  test('one criterion per line, markers stripped, duplicates and blanks dropped', () => {
    assert.deepEqual(acceptanceChecklist('- Slab level ±5 mm\n\n2) Cube tests ≥ C25/30\n[ ] Photos taken\n- Slab level ±5 mm'),
      ['Slab level ±5 mm', 'Cube tests ≥ C25/30', 'Photos taken']);
    assert.deepEqual(acceptanceChecklist(null), []);
  });

  test('closing records met per criterion; unknown criteria are refused', () => {
    const list = ['Level', 'Cubes'];
    assert.deepEqual(acceptanceRecord(list, ['Cubes']).value, [
      { criterion: 'Level', met: false }, { criterion: 'Cubes', met: true },
    ]);
    assert.ok(acceptanceRecord(list, ['Paint']).error.includes('Paint'));
    assert.equal(acceptanceRecord([], null).value, null);
  });
});

describe('E-10/E-11 site calendar', () => {
  // Mon 2 Feb 2026 .. Fri 6 Feb; the roof is a location.
  const cal = makeCalendar({ work_days: [1, 2, 3, 4, 5] });
  const tasks = new Map([
    ['P', t('P', { locationId: 'roof', assigneeOrgId: 'gc' })],
    ['R', t('R', { parentId: 'P', start: '2026-02-02', finish: '2026-02-06' })], // inherits gc + roof
    ['E', t('E', { start: '2026-02-03', finish: '2026-02-09', locationId: 'roof', assigneeOrgId: 'elec' })],
    ['G', t('G', { start: '2026-02-04', finish: '2026-02-04', locationId: 'roof', assigneeOrgId: 'gc' })],
    ['N', t('N', { start: '2026-02-03', finish: '2026-02-03', assigneeOrgId: 'paint' })], // no location
    ['U', t('U', { start: '2026-02-03', finish: '2026-02-03' })], // unassigned
    ['M', t('M', { kind: 'milestone', start: '2026-02-03', finish: '2026-02-03', assigneeOrgId: 'gc' })],
  ]);
  const counts = new Map([['P', 1]]);
  const result = siteCalendar({
    tasks, counts, spans: effectiveSpans(tasks), calendar: cal, from: '2026-02-01', to: '2026-02-28',
    orgNames: new Map([['gc', 'Obra Nova'], ['elec', 'Eletro Mota']]), locationNames: new Map([['roof', 'Roof']]),
  });

  test('presence by organisation and location, working days only, inherited assignee and location', () => {
    const r = result.presence.find((p) => p.task_id === 'R');
    assert.deepEqual([r.org_id, r.org_name, r.location_id, r.location_name, r.days.length], ['gc', 'Obra Nova', 'roof', 'Roof', 5]);
    assert.equal(result.presence.find((p) => p.task_id === 'E').days.at(-1), '2026-02-09'); // the weekend skipped
    assert.equal(result.presence.some((p) => p.task_id === 'M'), false);
    assert.equal(result.unassigned_count, 1);
    assert.equal(effectiveLocation(tasks, 'R'), 'roof');
  });

  test('two trades at one location on one day overlap, consecutive days are one range; same org never', () => {
    assert.deepEqual(result.overlaps.map((o) => [o.from, o.to, o.days, o.tasks.map((x) => x.task_id).sort()]), [
      ['2026-02-03', '2026-02-06', 4, ['E', 'R']],
      ['2026-02-04', '2026-02-04', 1, ['E', 'G']],
    ]);
    assert.equal(result.overlaps[0].location_name, 'Roof');
  });

  test('the window defaults and caps', () => {
    assert.deepEqual(calendarWindow({}, '2026-02-01'), { from: '2026-02-01', to: '2026-05-02' });
    assert.ok(calendarWindow({ from: '2026-01-01', to: '2027-06-01' }, '2026-02-01').errors.to);
    assert.ok(calendarWindow({ from: '2026-03-01', to: '2026-02-01' }, '2026-02-01').errors.to);
  });
});

describe('E-7..E-9 daily log', () => {
  const id = (n) => `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`;

  test('the site day is today or earlier', () => {
    assert.equal(validateLogDate('2026-02-03', '2026-02-03'), null);
    assert.ok(validateLogDate('2026-02-04', '2026-02-03'));
    assert.ok(validateLogDate('03/02/2026', '2026-02-03'));
  });

  test('each kind carries its fields; foreign fields and duplicates are refused', () => {
    const ok = validateEntries({ entries: [
      { id: id(1), kind: 'presence', org_id: id(9), headcount: 6 },
      { id: id(2), kind: 'weather', weather: 'rain', temperature_c: 9 },
      { id: id(3), kind: 'work', task_id: id(8), percent: 40, note: 'Slab poured' },
      { id: id(4), kind: 'photo', document_id: id(7), task_id: id(8) },
    ] });
    assert.deepEqual(ok.errors, {});
    assert.equal(ok.entries[0].headcount, 6);
    const bad = validateEntries({ entries: [
      { id: id(1), kind: 'presence', headcount: -1 },
      { id: id(1), kind: 'issue' },
      { id: id(5), kind: 'weather', weather: 'fog', task_id: id(8) },
    ] });
    assert.deepEqual(Object.keys(bad.errors).sort(), [
      'entries[0].headcount', 'entries[0].org_id', 'entries[1].id', 'entries[1].note',
      'entries[2].task_id', 'entries[2].weather',
    ]);
    assert.ok(validateEntries({ entries: [] }).errors.entries);
  });

  const row = (over) => ({
    id: id(Math.floor(Math.random() * 1e6)), project_id: 'p', log_date: '2026-02-03', org_id: null, headcount: null,
    weather: null, temperature_c: null, task_id: null, location_id: null, document_id: null, version_no: null,
    percent: null, note: null, recorded_by_person_id: 'me', recorded_by_org_id: 'gc', recorded_at: '2026-02-03T10:00:00Z',
    ...over,
  });

  test('the day reads the latest presence per organisation and the latest weather; 0 means not on site', () => {
    const rows = [
      row({ kind: 'presence', org_id: 'gc', headcount: 5 }),
      row({ kind: 'presence', org_id: 'elec', headcount: 2 }),
      row({ kind: 'weather', weather: 'sunny' }),
      row({ kind: 'presence', org_id: 'gc', headcount: 7 }),
      row({ kind: 'presence', org_id: 'elec', headcount: 0 }),
      row({ kind: 'weather', weather: 'rain' }),
      row({ kind: 'photo', document_id: 'd', version_no: 1, task_id: 't' }),
    ];
    const day = dayBody({ projectId: 'p', date: '2026-02-03', rows, names: { tasks: new Map([['t', '2.5 Slab']]) } });
    assert.deepEqual(day.on_site.map((e) => [e.org_id, e.headcount]), [['gc', 7]]);
    assert.equal(day.headcount_total, 7);
    assert.equal(day.weather.weather, 'rain');
    assert.equal(day.photos[0].task_name, '2.5 Slab');
    assert.equal(day.entries.length, 7);
    const [summary] = daySummaries(rows);
    assert.deepEqual([summary.org_count, summary.headcount_total, summary.weather, summary.photo_count], [1, 7, 'rain', 1]);
  });

  test('an identical replay is recognised', () => {
    const e = validateEntries({ entries: [{ id: id(1), kind: 'presence', org_id: id(9), headcount: 6 }] }).entries[0];
    assert.equal(sameEntry(row({ kind: 'presence', org_id: id(9), headcount: 6 }), e, '2026-02-03'), true);
    assert.equal(sameEntry(row({ kind: 'presence', org_id: id(9), headcount: 5 }), e, '2026-02-03'), false);
  });
});

describe('E-1 baselines', () => {
  test('newest first, the latest version of each branch is current, who and the branch name', () => {
    const list = baselineList([
      { id: 'b1', contract_id: 'c', version: 1, reason: 'award', root_task_ids: ['r'], root_names: ['Roof'], row_count: 3, taken_by_org_id: 'o', taken_at_iso: '2026-01-01T00:00:00Z' },
      { id: 'b2', contract_id: 'c', version: 2, reason: 'change_order', change_order_id: 'co', root_task_ids: ['r'], root_names: ['Roof'], row_count: 3, taken_at_iso: '2026-02-01T00:00:00Z' },
    ], new Map([['o', 'Família Almeida']]));
    assert.deepEqual(list.map((b) => [b.id, b.is_current]), [['b2', true], ['b1', false]]);
    assert.equal(list[1].taken_by_org_name, 'Família Almeida');
    assert.equal(list[0].taken_by, undefined);
    assert.equal(list[0].branch_name, 'Roof');
  });

  test('rebaseOn draws the snapshot rows against the chosen version, others untouched', () => {
    const tasks = new Map([['a', { id: 'a', baselineStart: '2026-02-10', baselineFinish: '2026-02-20' }], ['b', { id: 'b' }]]);
    const out = rebaseOn(tasks, { version: 1, reason: 'award', taken_at_iso: 'x', rows: [{ task_id: 'a', start: '2026-02-02', finish: '2026-02-12' }] });
    assert.deepEqual([out.get('a').baselineStart, out.get('a').comparedMeta.version], ['2026-02-02', 1]);
    assert.equal(out.get('b'), tasks.get('b'));
    assert.equal(tasks.get('a').baselineStart, '2026-02-10');
  });
});
