// Excel plan import — the pure half (PRD-09 O-6..O-8, O-11; flows/01 "The Excel
// contract"). No I/O: infra/xlsx-reader.mjs turns the workbook into each sheet's
// cell TEXT once, and everything after that — columns, the suggested mapping,
// per-row parsing with field-level warnings — happens here on that grid, so
// `:map` and `:preview` re-run without the bytes.
//
// Nothing is inferred silently: the header suggestion is only a suggestion the
// mapper shows; a cell that is not a date is a warning on that row, never a
// guess; a trade becomes a taxonomy code only on an exact label match.
//
// The tree, the dependencies and the rows to write are in
// ./schedule-import-tree.mjs.

/** Target fields, in mapper order. */
export const IMPORT_FIELDS = Object.freeze(['action', 'sub_action', 'start', 'end', 'duration', 'trade', 'dependency']);
export const SAMPLE_ROWS = 10;

/** Header words (normalised) that suggest a field. Sub-action is tested before action. */
const HEADER_HINTS = [
  ['sub_action', ['sub action', 'subaction', 'sub acao', 'subacao', 'subtarefa', 'sub tarefa', 'sub atividade', 'subatividade', 'step', 'passo']],
  ['action', ['action', 'acao', 'tarefa', 'atividade', 'actividade', 'fase', 'phase', 'task', 'capitulo', 'trabalho']],
  ['start', ['start', 'inicio', 'begin', 'comeco']],
  ['end', ['end', 'finish', 'fim', 'termo', 'conclusao', 'final']],
  ['duration', ['duration', 'duracao', 'dias', 'days']],
  ['trade', ['trade', 'especialidade', 'specialty', 'speciality', 'oficio', 'disciplina']],
  ['dependency', ['depend', 'predecess', 'precedencia', 'after']],
];

/** Lower-case, diacritics stripped, non-alphanumerics → one space. */
export function normalise(text) {
  return String(text ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const blank = (v) => v == null || String(v).trim() === '';

/** The first row with any content is the header (0-based index), else -1. */
export function headerRowIndex(grid) {
  return (grid ?? []).findIndex((row) => (row ?? []).some((c) => !blank(c)));
}

/** A sheet's shape for the sheet picker: data rows below the header, columns. */
export function sheetSummary(sheet) {
  const h = headerRowIndex(sheet.rows);
  const columns = Math.max(0, ...(sheet.rows ?? []).map((r) => (r ?? []).length));
  const rows = h < 0 ? 0 : sheet.rows.slice(h + 1).filter((r) => (r ?? []).some((c) => !blank(c))).length;
  return { name: sheet.name, rows, columns };
}

/** Columns of a sheet: index, header text (or "Column N") and up to 3 sample values. */
export function columnsOf(grid) {
  const h = headerRowIndex(grid);
  if (h < 0) return [];
  const width = Math.max(0, ...grid.map((r) => (r ?? []).length));
  const out = [];
  for (let i = 0; i < width; i += 1) {
    const header = String(grid[h][i] ?? '').trim();
    const samples = [];
    for (const row of grid.slice(h + 1)) {
      const v = String(row?.[i] ?? '').trim();
      if (v && !samples.includes(v)) samples.push(v);
      if (samples.length === 3) break;
    }
    if (!header && !samples.length) continue;
    out.push({ index: i, header: header || `Column ${i + 1}`, samples });
  }
  return out;
}

/** A suggested mapping from the headers (each column used once). Shown, never applied unseen. */
export function suggestMapping(columns) {
  const mapping = {};
  const used = new Set();
  for (const [field, hints] of HEADER_HINTS) {
    const col = columns.find((c) => !used.has(c.index) && hints.some((h) => normalise(c.header).includes(h)));
    if (col) { mapping[field] = col.index; used.add(col.index); }
  }
  return mapping;
}

/** Required mappings still missing: Action, Start, and End or Duration. */
export function missingRequired(mapping = {}) {
  const has = (f) => Number.isInteger(mapping[f]);
  const missing = [];
  if (!has('action')) missing.push('action');
  if (!has('start')) missing.push('start');
  if (!has('end') && !has('duration')) missing.push('end');
  return missing;
}

/**
 * Validate a mapping body against the sheet's width. Returns {mapping, errors}:
 * unknown fields, non-integer or out-of-range columns, one column for two fields.
 */
export function validateMapping(raw, width) {
  const errors = {};
  const mapping = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { mapping, errors: { mapping: 'an object of field → column index' } };
  const seen = new Map();
  for (const [field, col] of Object.entries(raw)) {
    if (col == null) continue;
    if (!IMPORT_FIELDS.includes(field)) { errors[`mapping.${field}`] = 'not an import field'; continue; }
    if (!Number.isInteger(col) || col < 0 || col >= width) { errors[`mapping.${field}`] = `a column index 0..${Math.max(0, width - 1)}`; continue; }
    if (seen.has(col)) { errors[`mapping.${field}`] = `column ${col + 1} is already mapped to ${seen.get(col)}`; continue; }
    seen.set(col, field);
    mapping[field] = col;
  }
  return { mapping, errors };
}

// ── cells ────────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

function validYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1990 && y <= 2100;
}

/**
 * A date cell's text → 'YYYY-MM-DD', or null. Accepts the reader's ISO dates,
 * day-first Portuguese forms (31/12/2026, 31-12-2026, 31.12.26) and an Excel
 * serial day number. Month-first is never guessed.
 */
export function parseDate(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]) ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return validYmd(y, +m[2], +m[1]) ? `${y}-${pad(m[2])}-${pad(m[1])}` : null;
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    if (serial < 32874 || serial > 73051) return null; // 1990..2100
    const dt = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    return dt.toISOString().slice(0, 10);
  }
  return null;
}

/** "5", "5d", "5 dias", "5 wd" → 5 working days; else null. */
export function parseDuration(text) {
  const m = /^(\d{1,4})(?:[.,]0+)?\s*(d|wd|du|dia|dias|day|days)?$/i.exec(String(text ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/** The taxonomy code a trade names exactly (code, EN or PT label), else null. */
export function matchSpecialty(trade, taxonomy = []) {
  const t = normalise(trade);
  if (!t) return null;
  const hit = taxonomy.find((s) => [s.code?.replace(/-/g, ' '), s.name_en, s.name_pt].some((v) => v && normalise(v) === t));
  return hit?.code ?? null;
}

// ── rows ─────────────────────────────────────────────────────────────────────

function warn(row, field, code, message) {
  return { row, ...(field ? { field } : {}), code, message };
}

/**
 * Parse every data row under the mapping. Rows with a blank Action inherit the
 * previous Action (flows/01); merged cells arrive blank on the slaves and so
 * read the same way. Returns {rows, warnings}; a row that cannot be placed
 * (no action at all) is dropped with a `no_action` warning.
 *
 * @param {string[][]} grid
 * @param {Record<string, number>} mapping
 * @param {{ taxonomy?: Array<{code, name_en, name_pt}> }} [opts]
 */
export function parseRows(grid, mapping, { taxonomy = [] } = {}) {
  const h = headerRowIndex(grid);
  if (h < 0) return { rows: [], warnings: [] };
  const cell = (r, field) => (Number.isInteger(mapping[field]) ? String(r?.[mapping[field]] ?? '').trim() : '');
  const rows = [];
  const warnings = [];
  let currentAction = null;

  for (let i = h + 1; i < grid.length; i += 1) {
    const r = grid[i];
    const rowNo = i + 1;
    const values = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, cell(r, f)]));
    if (IMPORT_FIELDS.every((f) => !values[f])) continue;
    const w = [];
    let action = values.action || null;
    const sub = values.sub_action || null;
    if (action) currentAction = action;
    else if (sub && currentAction) action = currentAction;
    if (!action) {
      warnings.push(warn(rowNo, 'action', 'no_action', `Row ${rowNo} has no Action and no earlier Action to sit under — skipped.`));
      continue;
    }

    const start = parseDate(values.start);
    if (values.start && !start) w.push(warn(rowNo, 'start', 'bad_date', `Row ${rowNo}: “${values.start}” is not a date — imported without dates.`));
    if (!values.start) w.push(warn(rowNo, 'start', 'no_start', `Row ${rowNo} has no start date — imported without dates.`));
    let finish = parseDate(values.end);
    let duration = null;
    if (values.end && !finish) w.push(warn(rowNo, 'end', 'bad_date', `Row ${rowNo}: “${values.end}” is not a date.`));
    if (!finish && values.duration) {
      duration = parseDuration(values.duration);
      if (!duration) w.push(warn(rowNo, 'duration', 'bad_duration', `Row ${rowNo}: “${values.duration}” is not a number of working days.`));
    }
    if (start && finish && finish < start) {
      w.push(warn(rowNo, 'end', 'end_before_start', `Row ${rowNo} ends (${finish}) before it starts (${start}) — the end was left out.`));
      finish = null;
    }
    if (start && !finish && !duration && !w.some((x) => x.field === 'end' || x.field === 'duration')) {
      w.push(warn(rowNo, 'end', 'no_end', `Row ${rowNo} has no end date or duration.`));
    }

    const trade = values.trade || null;
    rows.push({
      row: rowNo,
      action,
      sub_action: sub,
      start: start ?? null,
      finish: start ? (finish ?? null) : null,
      duration_wd: start && !finish ? duration : null,
      trade,
      specialty_code: trade ? matchSpecialty(trade, taxonomy) : null,
      dependency: values.dependency || null,
      warnings: w,
    });
    warnings.push(...w);
  }
  return { rows, warnings };
}
