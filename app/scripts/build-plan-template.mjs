#!/usr/bin/env node
// Generate app/public/plan-template.xlsx — the starter workbook D8 links (LINA-207).
//
//   cd app && npm run build:plan-template
//
// It lives under app/ rather than the repo's scripts/ for one dull reason: it
// imports `exceljs`, and Node resolves a bare specifier from the importing
// FILE's directory. The repo root has no node_modules, so a copy in scripts/
// would only ever run with the package hand-resolved.
//
// ── WHY THIS IS GENERATED AND NOT A CHECKED-IN BINARY ────────────────────────
// The template's only job is to be a file the frozen parser accepts on the first
// try. That makes it a DERIVATIVE of services/schedule/plan-import-parser.mjs,
// not an independent artefact: the date format the parser accepts (a real date
// cell or literal YYYY-MM-DD — nothing coerced), the two-level Action /
// Sub-action rule (§6), and the `R{row}` dependency token format are all rules
// stated there and merely obeyed here. Hand-authoring the workbook in Excel
// would put a fourth copy of those rules somewhere nobody re-reads, and the day
// the parser changes the template becomes a file that teaches the wrong shape.
// The .xlsx it emits IS committed — the app serves it as a static asset and a
// Vercel build does not run this — but it is reproducible from this file.
//
// ── WHAT IS STILL THE PRODUCT DESIGNER'S ─────────────────────────────────────
// Contract §8 leaves "template contents and where the asset lives" to the
// Product Designer + Docs. This is the PARSE-PATH answer only: correct columns,
// correct formats, three demonstrative rows. Sheet styling, the example project,
// localisation and any cover/instructions tab are theirs to take over — and when
// they do, this script is the place the column contract stays pinned.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ExcelJS from 'exceljs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'plan-template.xlsx');

// Header labels are DECORATION. The mapping step assigns by column index and the
// parser never matches on a header string (contract §0 — nothing inferred), so
// renaming or translating any of these breaks nothing.
const HEADERS = ['Action', 'Sub-action', 'Start', 'End', 'Trade', 'Dependency'];

// Row 2 is the first data row. The dependency tokens below are `R{rowNumber}` of
// THIS sheet, which is the only dependency format B1 resolves (contract §8).
const ROWS = [
  ['Foundations', '', '2026-03-02', '2026-03-20', 'Structure', ''],
  ['Foundations', 'Excavation', '2026-03-02', '2026-03-09', 'Structure', ''],
  ['Foundations', 'Reinforcement', '2026-03-09', '2026-03-16', 'Structure', 'R3'],
  ['Foundations', 'Pour', '2026-03-16', '2026-03-20', 'Structure', 'R4'],
  ['Structure', '', '2026-03-23', '2026-04-30', 'Structure', 'R2'],
  ['Structure', 'Ground floor columns', '2026-03-23', '2026-04-10', 'Structure', ''],
  ['Structure', 'First floor slab', '2026-04-13', '2026-04-30', 'Structure', 'R7'],
];

const NOTES = [
  'How this sheet is read',
  '• One row per stage. A row with an Action and no Sub-action IS that action; a row with both is a step under it.',
  '• Two levels only — an Action and its Sub-actions. Nothing deeper.',
  '• Action names must be unique: a Sub-action finds its parent by that name, and two rows with the same name is an error, not a guess.',
  '• Dates: a real date cell, or text in YYYY-MM-DD. Anything else is reported row by row instead of being guessed at.',
  '• Dependency: the row references this stage waits on, like R3 or "R3, R4". Only rows in this same sheet.',
  '• Trade and Sub-action and Dependency are optional. Action, Start and End are not.',
  '• You choose which sheet and which column means what when you upload — these headers are only labels.',
];

const workbook = new ExcelJS.Workbook();
workbook.creator = 'LinkNMS';
// A fixed timestamp: a workbook whose bytes change on every run would show up as
// a diff in every commit that happens to re-generate it.
workbook.created = new Date('2026-09-08T00:00:00Z');
workbook.modified = workbook.created;

const plan = workbook.addWorksheet('Plan');
plan.addRow(HEADERS);
plan.getRow(1).font = { bold: true };
for (const row of ROWS) plan.addRow(row);
plan.columns = [{ width: 26 }, { width: 26 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 16 }];

// A SECOND sheet on purpose. Multi-sheet is the norm the import is built for
// (contract §0), so the template that teaches the format also exercises the
// sheet picker instead of quietly implying one tab is all there is.
const notes = workbook.addWorksheet('How to fill this in');
for (const line of NOTES) notes.addRow([line]);
notes.getRow(1).font = { bold: true };
notes.columns = [{ width: 120 }];

await mkdir(dirname(out), { recursive: true });
await writeFile(out, Buffer.from(await workbook.xlsx.writeBuffer()));
console.log(`wrote ${out}`);
