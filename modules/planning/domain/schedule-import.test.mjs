// PRD-09 O-6..O-11 — the pure import parser: header suggestion, required
// mappings, date/duration cells, Action inheritance, warnings (never blockers),
// the WBS tree, dependency resolution and the batch it writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  columnsOf, suggestMapping, missingRequired, validateMapping, parseDate, parseDuration,
  parseRows, sheetSummary, matchSpecialty,
} from './schedule-import.mjs';
import { buildTree, toCreateBatch } from './schedule-import-tree.mjs';

const TAXONOMY = [
  { code: 'structure', name_en: 'Structure', name_pt: 'Estrutura' },
  { code: 'electrical', name_en: 'Electrical', name_pt: 'Instalações elétricas' },
];

// A GC's own sheet: a title row gap, merged Action cells (blank on sub-rows),
// PT headers, two bad dates and a dependency on a name that isn't there.
const GRID = [
  ['Tarefa', 'Subtarefa', 'Início', 'Fim', 'Especialidade', 'Depende de', 'Notas'],
  ['Fundações', '', '01/09/2026', '22/09/2026', 'Estrutura', '', ''],
  ['', 'Escavação', '2026-09-01', '2026-09-05', '', '', 'x'],
  ['', 'Armaduras', '2026-09-08', '2026-09-15', '', 'Escavação', ''],
  ['', 'Betonagem', '16/09/2026', 'amanhã', '', 'Armaduras', ''],
  ['Estrutura', '', '23/09/2026', '20/10/2026', 'Structure', 'Fundações', ''],
  ['Elétrica', 'Primeira fase', '31/02/2026', '04/11/2026', 'Electrical', 'Caixilharia', ''],
  ['', '', '', '', '', '', ''],
];

test('columns, samples and a header suggestion (shown, never applied unseen)', () => {
  const cols = columnsOf(GRID);
  assert.equal(cols.length, 7);
  assert.deepEqual(cols[2], { index: 2, header: 'Início', samples: ['01/09/2026', '2026-09-01', '2026-09-08'] });
  assert.deepEqual(suggestMapping(cols), { sub_action: 1, action: 0, start: 2, end: 3, trade: 4, dependency: 5 });
  assert.deepEqual(sheetSummary({ name: 'Plano', rows: GRID }), { name: 'Plano', rows: 6, columns: 7 });
  assert.deepEqual(sheetSummary({ name: 'Vazia', rows: [['Action', 'Start']] }).rows, 0);
});

test('only a missing required mapping is reported; duration stands in for end', () => {
  assert.deepEqual(missingRequired({}), ['action', 'start', 'end']);
  assert.deepEqual(missingRequired({ action: 0, start: 1, duration: 2 }), []);
  const { errors } = validateMapping({ action: 0, start: 0, end: 9, bogus: 1 }, 4);
  assert.deepEqual(Object.keys(errors).sort(), ['mapping.bogus', 'mapping.end', 'mapping.start']);
});

test('dates: ISO, day-first, Excel serial; never month-first or impossible days', () => {
  assert.equal(parseDate('2026-09-01'), '2026-09-01');
  assert.equal(parseDate('1/9/2026'), '2026-09-01');
  assert.equal(parseDate('01.09.26'), '2026-09-01');
  assert.equal(parseDate('46266'), '2026-09-01');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('amanhã'), null);
  assert.equal(parseDuration('5 dias'), 5);
  assert.equal(parseDuration('0'), null);
  assert.equal(matchSpecialty('estrutura', TAXONOMY), 'structure');
  assert.equal(matchSpecialty('Struct', TAXONOMY), null);
});

test('blank Action inherits; bad dates are row warnings, the rows still import', () => {
  const mapping = { action: 0, sub_action: 1, start: 2, end: 3, trade: 4, dependency: 5 };
  const { rows, warnings } = parseRows(GRID, mapping, { taxonomy: TAXONOMY });
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.slice(1, 4).map((r) => r.action), ['Fundações', 'Fundações', 'Fundações']);
  assert.equal(rows[0].specialty_code, 'structure');
  const bad = warnings.filter((w) => w.code === 'bad_date');
  assert.deepEqual(bad.map((w) => w.row), [5, 7]);
  assert.equal(rows[3].finish, null); // "amanhã" dropped, the row stays
  assert.equal(rows[5].start, null); // 31/02 → undated row, still imported
});

test('tree: actions group sub-actions, summaries span children, names and R{n} resolve', () => {
  const mapping = { action: 0, sub_action: 1, start: 2, end: 3, trade: 4, dependency: 5 };
  const { rows } = parseRows(GRID, mapping, { taxonomy: TAXONOMY });
  const { tree, links, warnings, counts } = buildTree(rows);
  assert.deepEqual(counts, { rows: 6, actions: 3, sub_actions: 4, links: 3, trades: 2 });
  assert.equal(tree[0].name, 'Fundações');
  assert.deepEqual([tree[0].start, tree[0].finish], ['2026-09-01', '2026-09-16']);
  assert.deepEqual(tree[0].children[1].depends_on, ['a1.1']);
  assert.deepEqual(tree[1].depends_on, ['a1']);
  // Escavação ends Sat 05 → the next working day is Mon 07; Armaduras starts Tue 08: lag 1,
  // so the link keeps the file's dates as written.
  assert.equal(links.find((l) => l.to === 'a1.2').lag_wd, 1);
  assert.deepEqual(warnings.map((w) => w.code), ['unknown_dependency']);

  let n = 0;
  const batch = toCreateBatch(tree, links, () => `id-${++n}`);
  assert.equal(batch.rows.length, 7);
  assert.equal(batch.rows[0].dating_mode, 'undated'); // summary derives its dates
  assert.equal(batch.rows[1].parent_id, batch.rows[0].id);
  assert.equal(batch.rows[1].specialty_code, 'structure'); // inherits the action's trade
  assert.equal(batch.links.length, 3);
});

test('R{n} tokens (the published template), self and cycle references are dropped with a warning', () => {
  const grid = [
    ['Action', 'Sub-action', 'Start', 'End', 'Trade', 'Dependency'],
    ['A', '', '2026-03-02', '2026-03-06', '', ''],
    ['B', '', '2026-03-09', '2026-03-13', '', 'R2'],
    ['C', '', '2026-03-16', '2026-03-20', '', 'C'],
    ['A', 'A1', '2026-03-02', '2026-03-03', '', 'B'],
  ];
  const { rows } = parseRows(grid, { action: 0, sub_action: 1, start: 2, end: 3, dependency: 5 });
  const { links, warnings } = buildTree(rows);
  assert.deepEqual(links.map((l) => `${l.from}>${l.to}`), ['a1>a2']);
  assert.deepEqual(warnings.map((w) => w.code).sort(), ['dependency_cycle', 'self_dependency']);
});

test('no Action anywhere above → the row is skipped with a warning', () => {
  const { rows, warnings } = parseRows([['Action', 'Sub', 'Start', 'End'], ['', 'orphan', '2026-01-05', '2026-01-06']],
    { action: 0, sub_action: 1, start: 2, end: 3 });
  assert.equal(rows.length, 0);
  assert.equal(warnings[0].code, 'no_action');
});
