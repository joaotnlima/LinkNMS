// PRD-10 view mapping: baselines, waiting-on, the capture → entries, the day
// and the site calendar in the screen's words. No rule is decided here.
// Run: node --test src/lib/v2/execution-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toBaselineOptions, toWaitingLines, startNeedsReason, captureEntries, entryLine, daySummaryWords,
  calendarPlaces, calendarDays, overlapWords, clashCells, dayWords, OFFLINE_MESSAGE,
} from './execution-view.ts';

test('E-1: baseline options name the branch, version, why, when and who', () => {
  const [opt] = toBaselineOptions([{
    id: 'b2', contract_id: 'c', version: 2, reason: 'change_order', root_task_ids: ['r'], branch_name: 'Roof',
    is_current: true, taken_by_org_name: 'Família Almeida', taken_at: '2027-02-01T10:00:00Z',
  }]);
  assert.deepEqual(opt, { id: 'b2', label: 'Roof · v2 (current)', detail: 'change order accepted · 1 Feb 2027 · by Família Almeida', isCurrent: true });
});

test('E-5: waiting lines and when a start needs a reason', () => {
  const list = [{ task_id: 'a', name: 'Slab', status: 'in_progress', needs: 'finished', met: false }];
  assert.deepEqual(toWaitingLines(list), [{ taskId: 'a', name: 'Slab', state: 'in progress', needs: 'must be finished', met: false }]);
  assert.equal(startNeedsReason(list, 'not_started'), true);
  assert.equal(startNeedsReason(list, 'in_progress'), false);
  assert.equal(startNeedsReason([{ ...list[0], met: true }], 'not_started'), false);
});

test('E-7: the capture becomes entries; empty rows dropped; ids minted per entry', () => {
  let n = 0;
  const entries = captureEntries({
    presence: [{ orgId: 'gc', headcount: 6 }, { orgId: 'el', headcount: null }],
    weather: 'rain', temperatureC: 9,
    work: [{ taskId: 't', note: ' Slab ', percent: 40 }, { taskId: '', note: 'x', percent: null }],
    issues: [{ note: '  ', taskId: null, locationId: null }],
    photos: [{ documentId: 'd', taskId: 't', locationId: null, caption: '' }],
  }, () => `id${++n}`);
  assert.deepEqual(entries, [
    { id: 'id1', kind: 'presence', org_id: 'gc', headcount: 6 },
    { id: 'id2', kind: 'weather', weather: 'rain', temperature_c: 9 },
    { id: 'id3', kind: 'work', task_id: 't', note: 'Slab', percent: 40 },
    { id: 'id4', kind: 'photo', document_id: 'd', task_id: 't' },
  ]);
  assert.match(OFFLINE_MESSAGE, /offline/);
});

test('E-9: entry lines and day summaries', () => {
  const base = { id: 'e', date: '2027-02-03', recorded_by: { person_id: 'p', org_id: 'o' }, recorded_at: 'x' };
  assert.equal(entryLine({ ...base, kind: 'presence', org_name: 'Obra Nova', headcount: 1 }), 'Obra Nova on site · 1 person');
  assert.equal(entryLine({ ...base, kind: 'photo', note: 'Conduit', task_name: '2.5 Slab' }), 'Photo: Conduit · 2.5 Slab');
  assert.equal(daySummaryWords({ date: '2027-02-03', org_count: 2, headcount_total: 8, weather: 'rain', photo_count: 3 }),
    '2 orgs · 8 on site · Rain · 3 photos');
  assert.equal(daySummaryWords({ date: '2027-02-03' }), 'Nothing recorded');
});

test('E-10/E-11: lanes per location and organisation; the overlap in words and cells', () => {
  const cal = {
    project_id: 'p', from: '2027-02-01', to: '2027-02-28',
    presence: [
      { task_id: 'R', task_name: 'Roof structure', org_id: 'gc', org_name: 'Obra Nova', location_id: 'roof', location_name: 'Roof', from: '2027-02-01', to: '2027-02-05', days: ['2027-02-01', '2027-02-02', '2027-02-03'] },
      { task_id: 'E', task_name: 'Roof electrics', org_id: 'el', org_name: 'Eletro Mota', location_id: 'roof', location_name: 'Roof', from: '2027-02-03', to: '2027-02-03', days: ['2027-02-03'] },
      { task_id: 'N', task_name: 'Paint', org_id: 'pt', location_id: null, from: '2027-02-02', to: '2027-02-02', days: ['2027-02-02'] },
    ],
    overlaps: [{ location_id: 'roof', location_name: 'Roof', from: '2027-02-03', to: '2027-02-03', days: 1,
      tasks: [{ task_id: 'E', task_name: 'Roof electrics', org_id: 'el', org_name: 'Eletro Mota' }, { task_id: 'R', task_name: 'Roof structure', org_id: 'gc', org_name: 'Obra Nova' }] }],
  };
  const places = calendarPlaces(cal);
  assert.deepEqual(places.map((p) => [p.label, p.lanes.map((l) => l.label)]), [['Roof', ['Obra Nova', 'Eletro Mota']], ['No location', ['Organisation']]]);
  assert.deepEqual(calendarDays(cal), ['2027-02-01', '2027-02-02', '2027-02-03']);
  assert.equal(overlapWords(cal.overlaps[0]), 'Roof · 3 Feb 2027 · Eletro Mota (Roof electrics) and Obra Nova (Roof structure)');
  assert.deepEqual([...clashCells(cal)].sort(), ['roof|el|2027-02-03', 'roof|gc|2027-02-03']);
  assert.equal(dayWords('2027-12-25'), '25 Dec 2027');
});
