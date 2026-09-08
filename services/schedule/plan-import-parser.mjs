// Slice B1 plan import — the server-side .xlsx parser (LINA-206; frozen contract
// docs/architecture/slice-b1-plan-import-contract.md §1, §6, §8; ADR-0005).
//
// "Never trust the client" (contract §0): the browser uploads bytes only; every
// interpretation — sheet list, column headers, row parsing, WBS hierarchy,
// dependency resolution — happens here in the schedule service. Nothing is
// inferred: every stored field maps to a column the user explicitly assigned;
// required fields unmapped are a 400; there is no fuzzy header matching and no
// "looks like a date" coercion of an unmapped column.
//
// Hardening (contract §1, numbers set here so the FE can echo them):
//   - accept only `.xlsx` by name AND a workbook that actually parses as a
//     zip/OOXML archive (both checks — extension alone is not trust);
//   - enforce max file size and max row/column/sheet counts;
//   - a parsed-but-empty workbook/sheet is a specific 400, never a 500.
//
// WBS shape (contract §6): exactly two levels, Action / Sub-action. An Action
// row has `action` filled and `subAction` empty; a Sub-action row has
// `subAction` filled and points at an Action row by name (the `action` cell on
// the same row). No inference: if no Action row defines that name (or several
// do), it is a validation error surfaced in preview. Deeper nesting is
// structurally impossible and the row-level validator refuses anything else.
//
// Dependencies (contract §8): the mapped Dependency cell holds comma/semicolon
// separated `source_row_ref` tokens (R{rowNumber}); every token must resolve to
// a row in THIS import. Cross-plan/external refs are out of scope for B1.
import ExcelJS from 'exceljs';
import { DomainError } from './ports.mjs';

// ── Limits the BE sets and the FE echoes (contract §1 open item) ─────────────
export const LIMITS = Object.freeze({
  maxFileBytes: 5 * 1024 * 1024,      // 5 MB per re-sent file
  maxSheets: 100,
  maxRows: 10_000,                    // data rows (after the header row)
  maxCols: 100,
  maxDependencies: 50,                // predecessor refs per stage
  acceptedExtension: '.xlsx',
});

// The exact target fields a mapping may assign (contract §2) and the required
// set. Indices are 1-based source-column numbers; a required field without an
// index is a 400.
export const FIELDS = Object.freeze([
  'action', 'subAction', 'start', 'end', 'trade', 'dependency',
]);
export const REQUIRED_FIELDS = Object.freeze(['action', 'start', 'end']);

export function normalizeFilename(filename) {
  const name = String(filename ?? '');
  const ext = name.includes('.') ? `.${name.split('.').pop().toLowerCase()}` : '';
  return { ext, base: name.slice(0, name.length - ext.length) };
}

// Validate + load an .xlsx buffer once. Throws DomainError on every structural
// rejection (extension, size, zip parse, no sheets). The heavy lifting for the
// three non-writing routes; confirm re-parses through this same path.
export async function openWorkbook(buffer, { filename } = {}) {
  const { ext } = normalizeFilename(filename);
  if (ext !== LIMITS.acceptedExtension) {
    throw new DomainError(400, 'file_type_not_supported',
      `only .xlsx workbooks are supported (got "${ext || '<none>'}")`);
  }
  const bytes = buffer?.byteLength ?? buffer?.length ?? 0;
  if (bytes === 0) {
    throw new DomainError(400, 'empty_file', 'the uploaded file is empty');
  }
  if (bytes > LIMITS.maxFileBytes) {
    throw new DomainError(400, 'file_too_large',
      `file size ${bytes} exceeds the ${LIMITS.maxFileBytes}-byte limit`);
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    // Not a zip/OOXML workbook (or corrupt): extension alone is not trust.
    throw new DomainError(400, 'file_unparseable',
      'the file is not a valid .xlsx (OOXML) workbook');
  }

  if (workbook.worksheets.length === 0) {
    throw new DomainError(400, 'empty_workbook', 'the workbook contains no sheets');
  }
  if (workbook.worksheets.length > LIMITS.maxSheets) {
    throw new DomainError(400, 'too_many_sheets',
      `workbook has ${workbook.worksheets.length} sheets; limit is ${LIMITS.maxSheets}`);
  }
  return workbook;
}

// Cell → display text. Drops formula/rich-text/hyperlink and error shapes into a
// plain string for mapping and dependency tokens; dates are handled by cellDate.
function cellText(cell) {
  const v = cell?.value;
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v?.richText)) return v.richText.map((t) => t.text).join('').trim();
  if (typeof v === 'object') {
    if (v.text != null) return String(v.text).trim();
    if (v.result != null) { // formula cell — use its computed result, never re-evaluate
      const r = v.result;
      if (r instanceof Date) return r.toISOString().slice(0, 10);
      return String(r ?? '').trim();
    }
    if (v.error != null) return '';
  }
  return '';
}

// A start/end cell → a YYYY-MM-DD date, or null when the mapped cell is blank.
// Only a real Excel date value or an explicit YYYY-MM-DD string is accepted —
// nothing is coerced from an arbitrary string (contract §0 "Nothing inferred").
function cellDate(cell) {
  const v = cell?.value;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && v?.result instanceof Date) return v.result.toISOString().slice(0, 10);
  const t = cellText(cell);
  if (t === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return { invalid: t };
}

// True when a row has no values at all across its cells (skipped, not counted).
function rowIsBlank(row) {
  const vals = row.values ?? [];
  for (let i = 1; i < vals.length; i += 1) {
    const v = vals[i];
    if (v == null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return false;
  }
  return true;
}

export function sheetRowCount(worksheet) {
  let count = 0;
  const from = 2; // row 1 is the header row (column labels) by convention
  for (let r = from; r <= worksheet.rowCount; r += 1) {
    if (r - 1 > LIMITS.maxRows) break;
    if (!rowIsBlank(worksheet.getRow(r))) count += 1;
  }
  return count;
}

function requireSheet(workbook, sheetName) {
  const ws = workbook.worksheets.find((w) => w.name === sheetName)
    ?? workbook.getWorksheet(sheetName);
  if (!ws) {
    throw new DomainError(400, 'sheet_not_found',
      `sheet "${sheetName}" does not exist in this workbook`);
  }
  const rowCount = sheetRowCount(ws);
  if (rowCount === 0) {
    throw new DomainError(400, 'empty_sheet',
      `sheet "${sheetName}" has no data rows below the header`);
  }
  if (rowCount > LIMITS.maxRows) {
    throw new DomainError(400, 'too_many_rows',
      `sheet "${sheetName}" has ${rowCount} data rows; limit is ${LIMITS.maxRows}`);
  }
  return { ws, rowCount };
}

// Route 1 — POST …/plan-imports:inspect. Sheet list, no writes.
export async function inspectSheets(buffer, { filename } = {}) {
  const workbook = await openWorkbook(buffer, { filename });
  const sheets = workbook.worksheets.map((ws) => ({ name: ws.name, rowCount: sheetRowCount(ws) }));
  return { sheets, limits: LIMITS };
}

// Route 2 — POST …/plan-imports:columns. Header + samples per source column.
export async function inspectColumns(workbook, sheetName) {
  const { ws, rowCount } = requireSheet(workbook, sheetName);
  const columns = [];
  const max = Math.min(ws.columnCount, LIMITS.maxCols);
  if (ws.columnCount > LIMITS.maxCols) {
    throw new DomainError(400, 'too_many_columns',
      `sheet "${sheetName}" is ${ws.columnCount} columns wide; limit is ${LIMITS.maxCols}`);
  }
  for (let c = 1; c <= max; c += 1) {
    const header = cellText(ws.getRow(1)?.getCell(c) ?? null);
    const sampleValues = [];
    for (let r = 2; r <= ws.rowCount && sampleValues.length < 3; r += 1) {
      if (rowIsBlank(ws.getRow(r))) continue;
      const t = cellText(ws.getRow(r).getCell(c));
      if (t !== '') sampleValues.push(t);
    }
    columns.push({ index: c, header, sampleValues });
  }
  return { columns, rowCount, limits: LIMITS };
}

// Parse a mapping object → field→column map. Throws 400 on invalid structure,
// an unmapped required field, or an index outside 1..maxCols.
export function normalizeMapping(mapping, maxCols = LIMITS.maxCols) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new DomainError(400, 'invalid_mapping', 'mapping must be an object');
  }
  const out = {};
  for (const field of FIELDS) {
    const raw = mapping[field];
    if (raw == null) { out[field] = null; continue; }
    if (!Number.isInteger(raw) || raw < 1 || raw > maxCols) {
      throw new DomainError(400, 'invalid_mapping',
        `mapping.${field} must be a column index 1..${maxCols}`);
    }
    out[field] = raw;
  }
  for (const field of REQUIRED_FIELDS) {
    if (out[field] == null) {
      throw new DomainError(400, 'missing_required_mapping',
        `required field "${field}" has no mapped column`);
    }
  }
  return out;
}

// Build the two-level WBS tree from a parsed sheet + normalized mapping.
// Returns { roots, stats, warnings, errors } where errors[] are data-quality
// problems surfaced in preview (200) and REJECTED at confirm (400). Throws
// DomainError only for structural problems.
export function buildTree(workbook, sheetName, mapping) {
  const { ws, rowCount } = requireSheet(workbook, sheetName);
  const index = normalizeMapping(mapping, LIMITS.maxCols);
  const errors = [];
  const warnings = [];

  const dupes = FIELDS.filter((f, i, all) => index[f] != null && all.slice(0, i).some((g) => index[g] === index[f]));
  if (dupes.length > 0) {
    warnings.push(`fields map to the same column: ${dupes.join(', ')}`);
  }
  if (index.subAction == null) {
    warnings.push('subAction is unmapped — every non-blank row with an action becomes a top-level Action');
  }
  if (index.trade == null) warnings.push('trade is unmapped — trades will be empty');
  if (index.dependency == null) warnings.push('dependency is unmapped — no predecessor links will be read');

  // ── 1. rows → node shells (ref, action-name-or-null, sub-action-name-or-null) ──
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r += 1) {
    if (r - 1 > LIMITS.maxRows) break;
    const row = ws.getRow(r);
    if (rowIsBlank(row)) continue;
    const cell = (c) => (c == null ? '' : cellText(row.getCell(c)));
    const dateCell = (c) => (c == null ? null : cellDate(row.getCell(c)));

    const actionText = cell(index.action);
    const subText = cell(index.subAction);
    const trade = cell(index.trade) || null;

    const start = dateCell(index.start);
    const end = dateCell(index.end);
    if (start && start.invalid) { errors.push(`row ${r}: start "${start.invalid}" is not a date (expected YYYY-MM-DD)`); }
    if (end && end.invalid) { errors.push(`row ${r}: end "${end.invalid}" is not a date (expected YYYY-MM-DD)`); }

    const depText = cell(index.dependency);
    const deps = depText
      .split(/[,;]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, LIMITS.maxDependencies + 1);

    const ref = `R${r}`;
    rows.push({
      ref, rowNumber: r, actionText, subText, trade,
      start: start && !start.invalid ? start : null,
      end: end && !end.invalid ? end : null,
      dependencyTokens: deps,
      supply: { name: subText || actionText, isSub: subText !== '' },
    });

    if (actionText === '' && subText === '') {
      errors.push(`row ${r}: has no action or sub-action — each row must name a stage`);
    }
    if (index.dependency != null && depText !== '' && deps.length > LIMITS.maxDependencies) {
      errors.push(`row ${r}: more than ${LIMITS.maxDependencies} dependency tokens`);
    }
  }

  // ── 2. partition into Action rows (roots) and Sub-action rows ────────────────
  // An Action row defines a top-level Action: `action` filled, `subAction`
  // empty. A Sub-action row names its parent Action via its `action` cell.
  // WBS depth is capped at exactly two levels by construction — a sub-action can
  // only ever point at an Action row, never at another sub-action.
  const actionByRef = new Map();
  const subRows = [];
  for (const node of rows) {
    if (node.actionText === '' && node.subText !== '') {
      errors.push(`row ${node.rowNumber}: sub-action "${node.subText}" has no action name — its parent cannot be resolved`);
      continue;
    }
    if (node.subText === '') {
      // action-only row → a root Action. An action row must carry a name.
      if (node.actionText === '') continue; // already flagged above
      actionByRef.set(node.ref, node);
    } else {
      subRows.push(node);
    }
  }

  // Action name → refs, for deterministic parent resolution (same-name actions
  // are ambiguous and therefore an error — nothing inferred).
  const actionByName = new Map();
  for (const a of actionByRef.values()) {
    if (!actionByName.has(a.actionText)) actionByName.set(a.actionText, []);
    actionByName.get(a.actionText).push(a.ref);
  }

  // ── 3. build tree, resolve parents + intra-import dependencies ──────────────
  const nodeByRef = new Map();
  const roots = [];

  for (const a of rows.filter((n) => n.subText === '')) {
    const node = { ...a, action: a.actionText, subActionOf: null, dependsOn: [], children: [] };
    nodeByRef.set(a.ref, node);
    roots.push(node);
  }
  for (const s of subRows) {
    const parents = actionByName.get(s.actionText) ?? [];
    if (parents.length === 0) {
      errors.push(`row ${s.rowNumber}: sub-action "${s.subText}" references action "${s.actionText}" but no Action row defines it`);
      continue;
    }
    if (parents.length > 1) {
      errors.push(`row ${s.rowNumber}: action "${s.actionText}" is defined by multiple Action rows — make action names unique`);
      continue;
    }
    const parent = nodeByRef.get(parents[0]);
    const node = { ...s, action: s.subText, subActionOf: parent.ref, dependsOn: [], children: [] };
    nodeByRef.set(s.ref, node);
    parent.children.push(node);
  }

  // WBS pre-order: roots in source order, each followed by its children in
  // source order. Exactly two levels by construction. This is the deterministic
  // order stage ids are emitted in so the ledger payload_hash reproduces (contract §4).
  const order = [];
  for (const r of roots) {
    order.push(r);
    for (const c of r.children) order.push(c);
  }

  for (const n of order) {
    const seen = new Set();
    for (const token of n.dependencyTokens) {
      const target = nodeByRef.get(token);
      if (!target) {
        errors.push(`row ${n.rowNumber}: dependency "${token}" does not match any row in this import`);
        continue;
      }
      if (token === n.ref) {
        errors.push(`row ${n.rowNumber}: a stage cannot depend on itself`);
        continue;
      }
      if (seen.has(token)) continue; // duplicate token — dedupe silently
      seen.add(token);
      n.dependsOn.push(token);
    }
  }

  const stageCount = order.length;
  return {
    roots,
    order,                      // internal pre-order for import
    stats: {
      stageCount,
      rootCount: roots.length,
      subActionCount: order.length - roots.length,
    },
    warnings,
    errors,
  };
}

export const PARSER = {
  LIMITS, FIELDS, REQUIRED_FIELDS, openWorkbook,
  inspectSheets, inspectColumns, normalizeMapping, buildTree,
};