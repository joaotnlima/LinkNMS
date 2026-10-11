// PRD-09 O-1: the plan facts the build home reads through planning's port.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPlanningOverviewPort } from './overview-port.mjs';

const task = (id, over = {}) => ({
  id, parentId: null, kind: 'task', name: id, start: null, finish: null, actualStart: null, actualFinish: null,
  datingMode: 'dated', baselineFinish: null, branchContractId: null, scheduleState: 'planned', ...over,
});

test('rows, top level, start, end vs baseline in working days, open variations', async () => {
  const tasks = new Map([
    ['a', task('a', { datingMode: 'undated' })],
    ['a1', task('a1', { parentId: 'a', start: '2026-09-01', finish: '2026-09-04', baselineFinish: '2026-09-04' })],
    ['a2', task('a2', { parentId: 'a', start: '2026-09-07', finish: '2026-09-11', baselineFinish: '2026-09-09' })],
    ['b', task('b', { datingMode: 'undated' })],
  ]);
  const store = {
    async loadPlan() {
      return {
        tasks, links: [], contracts: new Map(), statuses: new Map(), calendarRaw: {},
        variations: new Map([['x', { status: 'open' }], ['y', { status: 'acknowledged' }]]),
      };
    },
  };
  const f = await createPlanningOverviewPort(store).planFacts('p');
  assert.deepEqual([f.rows, f.top_level, f.start], [4, 2, '2026-09-01']);
  assert.deepEqual(f.end_date, { baseline: '2026-09-09', current: '2026-09-11', delta_wd: 2 });
  assert.equal(f.open_variations, 1);
  assert.deepEqual(f.health.undated_rows.map((r) => r.id), ['b']);
});

test('an empty plan answers zeros and no end date', async () => {
  const store = { async loadPlan() { return { tasks: new Map(), links: [], contracts: new Map(), statuses: new Map(), calendarRaw: {}, variations: new Map() }; } };
  const f = await createPlanningOverviewPort(store).planFacts('p');
  assert.deepEqual([f.rows, f.start, f.end_date], [0, null, { baseline: null, current: null }]);
});
