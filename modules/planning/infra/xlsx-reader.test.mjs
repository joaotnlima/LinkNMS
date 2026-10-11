// PRD-09 O-10: the published template (app/public/plan-template.xlsx, linked
// from the empty plan and the dropzone) is read by the real reader and parses
// under the suggested mapping with no missing field and no warning — the
// template and the column contract cannot drift apart unnoticed. Plus the
// reader's cell rules (dates, formulas, rich text).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readWorkbook, cellText, UnreadableWorkbook } from './xlsx-reader.mjs';
import { columnsOf, suggestMapping, missingRequired, parseRows, sheetSummary } from '../domain/schedule-import.mjs';
import { buildTree } from '../domain/schedule-import-tree.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('the published template parses cleanly under the suggested mapping', async () => {
  const { sheets } = await readWorkbook(readFileSync(join(ROOT, 'app', 'public', 'plan-template.xlsx')));
  assert.deepEqual(sheets.map((s) => s.name), ['Plan', 'How to fill this in']);
  const plan = sheets[0];
  assert.equal(sheetSummary(plan).rows, 7);
  const mapping = suggestMapping(columnsOf(plan.rows));
  assert.deepEqual(mapping, { sub_action: 1, action: 0, start: 2, end: 3, trade: 4, dependency: 5 });
  assert.deepEqual(missingRequired(mapping), []);
  const { rows, warnings } = parseRows(plan.rows, mapping);
  assert.deepEqual(warnings, []);
  const { tree, links, warnings: treeWarnings, counts } = buildTree(rows);
  assert.deepEqual(treeWarnings, []);
  assert.deepEqual([counts.actions, counts.sub_actions], [2, 5]);
  assert.equal(links.length, 4);
  assert.deepEqual(tree.map((a) => a.name), ['Foundations', 'Structure']);
});

test('cell text: dates, formulas, rich text, hyperlinks; non-xlsx bytes are refused', async () => {
  assert.equal(cellText(new Date(Date.UTC(2026, 2, 2))), '2026-03-02');
  assert.equal(cellText({ formula: 'A1+1', result: 5 }), '5');
  assert.equal(cellText({ richText: [{ text: 'Fun' }, { text: 'dações' }] }), 'Fundações');
  assert.equal(cellText({ text: 'link', hyperlink: 'http://x' }), 'link');
  assert.equal(cellText({ error: '#REF!' }), '');
  await assert.rejects(readWorkbook(Buffer.from('a,b,c')), UnreadableWorkbook);
});
