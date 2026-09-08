// Browser-parse contract tests for the Slice B1 plan-import xlsx parser
// (LINA-206; frozen contract docs/architecture/slice-b1-plan-import-contract.md
// §1, §2, §6, §8). These prove the server-side interpretation of an uploaded
// workbook is authoritative and safe:
//   - extension + zip/OOXML parse (extension alone is not trust), max size,
//     multi-sheet reporting (never auto-pick), empty-sheet = 400;
//   - column headers + samples, data rows after the header row;
//   - the mapping contract (field→column index; required action/start/end;
//     unmapped required → 400; nothing inferred);
//   - exactly-two-level WBS (Action / Sub-action) enforced, parents by name;
//   - intra-import dependencies resolved by source_row_ref token(s).
// Run: node --test services/schedule/plan-import-parser.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { PARSER, LIMITS } from './plan-import-parser.mjs';
import { DomainError } from './ports.mjs';

// Build an .xlsx buffer in memory — no binary fixtures in the repo.
export async function makeWorkbook(rowsBySheet, { header = ['Action', 'Sub-action', 'Start', 'End'] } = {}) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(rowsBySheet)) {
    const ws = wb.addWorksheet(name);
    ws.addRow(header);
    for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const PLAN = {
  Plan: [
    ['Foundation', '', '2026-01-05', '2026-02-02'],
    ['Foundation', 'Excavate', '2026-01-05', '2026-01-15'],
    ['Foundation', 'Pour footings', '2026-01-16', '2026-02-02'],
    ['Framing', '', '2026-02-10', '2026-03-20'],
    ['Framing', 'Walls', '2026-02-10', '2026-03-01'],
  ],
};

const MAPPING = { action: 1, subAction: 2, start: 3, end: 4 };

const errCode = async (fn) => {
  try { await fn(); } catch (e) { return e; }
  return null;
};

test('inspect: lists every sheet with its data-row count; never auto-picks', async () => {
  const buf = await makeWorkbook({ Plan: PLAN.Plan, Notes: [] });
  const out = await PARSER.inspectSheets(buf, { filename: 'plan.xlsx' });
  assert.deepEqual(out.sheets.map((s) => s.name), ['Plan', 'Notes']);
  assert.equal(out.sheets[0].rowCount, 5);
  assert.equal(out.sheets[1].rowCount, 0, 'empty sheets are reported, not rejected, so the user may still pick');
  assert.equal(out.limits.maxFileBytes, LIMITS.maxFileBytes, 'limits shipped so the FE can echo them');
});

test('rejects a non-.xlsx filename even when bytes are valid', async () => {
  const buf = await makeWorkbook(PLAN);
  const e = await errCode(() => PARSER.inspectSheets(buf, { filename: 'plan.csv' }));
  assert.ok(e instanceof DomainError && e.status === 400 && e.code === 'file_type_not_supported');
});

test('rejects a file that is not a zip/OOXML archive (extension alone is not trust)', async () => {
  const notZip = Buffer.from('this is definitely not an xlsx zip archive', 'utf8');
  const e = await errCode(() => PARSER.inspectSheets(notZip, { filename: 'plan.xlsx' }));
  assert.ok(e instanceof DomainError && e.status === 400 && e.code === 'file_unparseable');
});

test('rejects an over-size file with a 400, not a crash', async () => {
  const buf = Buffer.alloc(LIMITS.maxFileBytes + 1, 0);
  const e = await errCode(() => PARSER.inspectSheets(buf, { filename: 'big.xlsx' }));
  assert.ok(e instanceof DomainError && e.status === 400 && e.code === 'file_too_large');
});

test('rejects an empty file', async () => {
  const e = await errCode(() => PARSER.inspectSheets(Buffer.alloc(0), { filename: 'x.xlsx' }));
  assert.ok(e instanceof DomainError && e.status === 400 && e.code === 'empty_file');
});

test('columns: headers + up to 3 samples per source column and a rowCount', async () => {
  const buf = await makeWorkbook(PLAN);
  const wb = await PARSER.openWorkbook(buf, { filename: 'plan.xlsx' });
  const out = await PARSER.inspectColumns(wb, 'Plan');
  assert.equal(out.rowCount, 5);
  assert.deepEqual(out.columns[0], { index: 1, header: 'Action', sampleValues: ['Foundation', 'Foundation', 'Foundation'] });
  assert.deepEqual(out.columns[3], { index: 4, header: 'End', sampleValues: ['2026-02-02', '2026-01-15', '2026-02-02'] });
});

test('columns/preview on a missing sheet is a 400', async () => {
  const buf = await makeWorkbook(PLAN);
  const wb = await PARSER.openWorkbook(buf, { filename: 'plan.xlsx' });
  const e = await errCode(() => PARSER.inspectColumns(wb, 'Nope'));
  assert.ok(e instanceof DomainError && e.status === 400 && e.code === 'sheet_not_found');
});

test('a chosen sheet with zero data rows is a specific 400 empty_sheet', async () => {
  const buf = await makeWorkbook({ Plan: [], Notes: [['a', 'b', 'c', 'd']] });
  const wb = await PARSER.openWorkbook(buf, { filename: 'plan.xlsx' });
  const e = await errCode(() => PARSER.inspectColumns(wb, 'Plan'));
  assert.ok(e instanceof DomainError && e.status === 400 && e.code === 'empty_sheet');
});

test('mapping: an unmapped required field is a 400 missing_required_mapping', async () => {
  const buf = await makeWorkbook(PLAN);
  const wb = await PARSER.openWorkbook(buf, { filename: 'plan.xlsx' });
  const e = await errCode(() => PARSER.buildTree(wb, 'Plan', { action: 1 }));
  assert.ok(e instanceof DomainError && e.status === 400 && e.code === 'missing_required_mapping');
});

test('mapping: a non-integer / out-of-range column index is a 400', async () => {
  const buf = await makeWorkbook(PLAN);
  const wb = await PARSER.openWorkbook(buf, { filename: 'plan.xlsx' });
  const e = await errCode(() => PARSER.buildTree(wb, 'Plan', { ...MAPPING, start: 'col-start' }));
  assert.ok(e instanceof DomainError && e.status === 400 && e.code === 'invalid_mapping');
  const e2 = await errCode(() => PARSER.buildTree(wb, 'Plan', { ...MAPPING, start: 1000 }));
  assert.ok(e2 instanceof DomainError && e2.status === 400 && e2.code === 'invalid_mapping');
});

test('preview: exactly two WBS levels, parents-first pre-order, deps resolved by ref', async () => {
  const buf = await makeWorkbook({
    Plan: [
      ['Foundation', '', '2026-01-05', '2026-02-02', 'Civil', ''],
      ['Foundation', 'Excavate', '2026-01-05', '2026-01-15', 'Civil', ''],
      ['Foundation', 'Pour footings', '2026-01-16', '2026-02-02', 'Civil', 'R3'],
      ['Framing', '', '2026-02-10', '2026-03-20', 'Carpentry', 'R2'],
      ['Framing', 'Walls', '2026-02-10', '2026-03-01', 'Carpentry', 'R3,R4'],
    ],
  }, { header: ['Action', 'Sub-action', 'Start', 'End', 'Trade', 'Dependency'] });
  const wb = await PARSER.openWorkbook(buf, { filename: 'plan.xlsx' });
  const tree = PARSER.buildTree(wb, 'Plan', { action: 1, subAction: 2, start: 3, end: 4, trade: 5, dependency: 6 });

  assert.deepEqual(tree.errors, []);
  assert.equal(tree.stats.stageCount, 5);
  assert.equal(tree.stats.rootCount, 2);
  assert.equal(tree.stats.subActionCount, 3);

  // WBS pre-order: the flat insert order and the tree's DFS order must agree.
  assert.deepEqual(tree.order.map((n) => n.ref), ['R2', 'R3', 'R4', 'R5', 'R6']);
  // Two and only two levels: roots carry children; children carry none.
  assert.deepEqual(tree.roots.map((r) => r.action), ['Foundation', 'Framing']);
  assert.deepEqual(tree.roots[0].children.map((c) => c.ref), ['R3', 'R4']);
  assert.equal(tree.roots[0].children.every((c) => c.children.length === 0), true, 'no third level');

  // A top-level Action row can list predecessors too (R2 is a root).
  const framing = tree.roots[1];
  assert.deepEqual(framing.dependsOn, ['R2']);
  assert.deepEqual(framing.children[0].dependsOn, ['R3', 'R4']);
  assert.equal(framing.children[0].subActionOf, 'R5');
  assert.equal(framing.children[0].start, '2026-02-10');
  assert.equal(framing.children[0].trade, 'Carpentry');
});

test('preview: a sub-action referencing an undefined Action name is an error, not a guess', async () => {
  const buf = await makeWorkbook({
    Plan: [['Framing', '', '2026-02-10', '2026-03-20'], ['Struct', 'Walls', '2026-02-10', '2026-03-01']],
  });
  const wb = await PARSER.openWorkbook(buf, { filename: 'plan.xlsx' });
  const tree = PARSER.buildTree(wb, 'Plan', MAPPING);
  assert.ok(tree.errors.some((e) => e.includes('no Action row defines it')), JSON.stringify(tree.errors));
  assert.equal(tree.stats.rootCount, 1, 'the orphan sub-action is not silently promoted to a root');
});

test('preview: duplicate Action names are ambiguous and refused', async () => {
  const buf = await makeWorkbook({
    Plan: [
      ['Foundation', '', '2026-01-05', '2026-02-02'],
      ['Foundation', '', '2026-02-10', '2026-03-20'],
      ['Foundation', 'Footings', '2026-01-05', '2026-02-02'],
    ],
  });
  const wb = await PARSER.openWorkbook(buf, { filename: 'plan.xlsx' });
  const tree = PARSER.buildTree(wb, 'Plan', MAPPING);
  assert.ok(tree.errors.some((e) => e.includes('defined by multiple Action rows')), JSON.stringify(tree.errors));
});

test('preview: an unknown or self dependency token is an error; duplicates collapse', async () => {
  const buf = await makeWorkbook({
    Plan: [
      ['Foundation', '', '2026-01-05', '2026-02-02', ''],
      ['Foundation', 'Excavate', '2026-01-05', '2026-01-15', 'R2; R2; R99'],
      ['Foundation', 'Pour', '2026-01-15', '2026-01-20', 'R4'],
    ],
  }, { header: ['Action', 'Sub-action', 'Start', 'End', 'Dependency'] });
  const wb = await PARSER.openWorkbook(buf, { filename: 'plan.xlsx' });
  const tree = PARSER.buildTree(wb, 'Plan', { action: 1, subAction: 2, start: 3, end: 4, dependency: 5 });
  assert.ok(tree.errors.some((e) => e.includes('"R99" does not match')), JSON.stringify(tree.errors));
  assert.ok(tree.errors.some((e) => e.includes('cannot depend on itself')), JSON.stringify(tree.errors));
  // R3's valid token resolves exactly once.
  const node = tree.order.find((n) => n.ref === 'R3');
  assert.deepEqual(node.dependsOn, ['R2']);
});

test('preview: an unparseable date in a MAPPED column is an error; blanks are fine', async () => {
  const buf = await makeWorkbook({
    Plan: [
      ['Foundation', '', 'Jan 5, coffee', '2026-02-02'],
      ['Framing', '', '2026-02-10', ''],
    ],
  });
  const wb = await PARSER.openWorkbook(buf, { filename: 'plan.xlsx' });
  const tree = PARSER.buildTree(wb, 'Plan', MAPPING);
  assert.ok(tree.errors.some((e) => e.includes('row 2: start')), JSON.stringify(tree.errors));
  assert.equal(tree.order[1].end, null, 'an empty mapped end is null, valid');
});

test('preview: Excel native date cells parse to YYYY-MM-DD', async () => {
  const buf = await makeWorkbook({
    Plan: [['Foundation', '', new Date('2026-01-05T00:00:00Z'), new Date('2026-02-02T00:00:00Z')]],
  });
  const wb = await PARSER.openWorkbook(buf, { filename: 'plan.xlsx' });
  const tree = PARSER.buildTree(wb, 'Plan', MAPPING);
  assert.deepEqual(tree.errors, []);
  assert.equal(tree.order[0].start, '2026-01-05');
  assert.equal(tree.order[0].end, '2026-02-02');
});

test('a fully-blank data row is ignored, not an error; a half-filled one is flagged', async () => {
  const buf = await makeWorkbook({
    Plan: [
      ['Foundation', '', '2026-01-05', '2026-02-02'],
      [], // blank row — skipped entirely
      ['', '', '', ''],
      ['Framing', '', '2026-02-10', '2026-03-20'],
      ['Framing', 'Walls', '2026-02-10', '2026-03-01'],
    ],
  });
  const wb = await PARSER.openWorkbook(buf, { filename: 'plan.xlsx' });
  const tree = PARSER.buildTree(wb, 'Plan', MAPPING);
  assert.equal(tree.errors.length, 0, JSON.stringify(tree.errors));
  assert.deepEqual(tree.order.map((n) => n.ref), ['R2', 'R5', 'R6']);
  assert.equal(tree.order[2].subActionOf, 'R5', 'Walls is a child of the Framing row that precedes it');
  assert.equal(tree.stats.stageCount, 3);
});