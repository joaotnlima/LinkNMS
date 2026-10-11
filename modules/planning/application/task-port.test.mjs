// The planning task port's plan-shape answers for other modules (PRD-04 X-6,
// PRD-09 O-1): rows in outline order with their trade, and live row ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPlanningTaskPort } from './task-port.mjs';

test('tasksOf: outline order (siblings by position, children under parents) with specialty codes; taskIdsOf', async () => {
  const t = (id, parentId, position, over = {}) => [id, { id, parentId, position, name: id, kind: 'task', specialtyCode: null, ...over }];
  const plan = {
    tasks: new Map([
      t('roof', null, 'b', { kind: 'summary' }),
      t('tiles', 'roof', 'a', { specialtyCode: 'roofing-tiled' }),
      t('found', null, 'a'),
      t('gutters', 'roof', 'b'),
    ]),
    contracts: new Map(), ownerOrgId: 'o',
  };
  const port = createPlanningTaskPort({ async loadPlan() { return plan; }, async liveTaskIds() { return ['found']; } });
  const rows = await port.tasksOf('p');
  assert.deepEqual(rows.map((r) => [r.code, r.id]), [['1', 'found'], ['2', 'roof'], ['2.1', 'tiles'], ['2.2', 'gutters']]);
  assert.equal(rows[2].specialty_code, 'roofing-tiled');
  assert.deepEqual(await port.taskIdsOf('p'), ['found']);
  assert.deepEqual(await port.tasksOf(null), []);
});
