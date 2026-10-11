// PRD-09 O-7, O-8: the mapper's selects ↔ mapping, the "what still blocks"
// sentence, and the mini Gantt geometry. Run: node --test src/lib/v2/plan-import-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mappingFromSelects, fieldOfColumn, missingSentence, ganttBars } from './plan-import-view.ts';

test('selects → mapping; two columns on one field is said, not resolved', () => {
  assert.deepEqual(mappingFromSelects([[0, 'action'], [1, ''], [2, 'start'], [3, 'end']]).mapping, { action: 0, start: 2, end: 3 });
  assert.match(mappingFromSelects([[0, 'start'], [1, 'start']]).error, /Two columns are mapped to Start date/);
  assert.deepEqual([...fieldOfColumn({ action: 0, trade: 4 })], [[0, 'action'], [4, 'trade']]);
});

test('only missing required mappings are named', () => {
  assert.equal(missingSentence([]), null);
  assert.equal(missingSentence(['start', 'end']), 'Map Start date, End date (or Duration) to continue — the other fields are optional.');
});

test('mini Gantt: bars as a share of the span; undated rows stay visible without a bar', () => {
  const { bars, from, to } = ganttBars([
    { key: 'a1', row: 2, name: 'Fundações', start: '2026-09-01', finish: '2026-09-10', trade: null, specialty_code: null, depends_on: [],
      children: [{ key: 'a1.1', row: 3, name: 'Escavação', start: '2026-09-01', finish: '2026-09-05', trade: null, specialty_code: null, depends_on: [] }] },
    { key: 'a2', row: 4, name: 'Cobertura', start: null, finish: null, trade: null, specialty_code: null, depends_on: [], children: [] },
  ]);
  assert.deepEqual([from, to], ['2026-09-01', '2026-09-10']);
  assert.deepEqual(bars.map((b) => [b.key, b.depth, Math.round(b.left), Math.round(b.width), b.dated]), [
    ['a1', 0, 0, 100, true], ['a1.1', 1, 0, 50, true], ['a2', 0, 0, 0, false],
  ]);
});
