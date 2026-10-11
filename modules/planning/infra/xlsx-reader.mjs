// The workbook reader behind the Excel import (PRD-09 O-6) — the only place
// planning touches exceljs. It turns an .xlsx into each sheet's cell TEXT,
// once, at upload; the pure parser (domain/schedule-import.mjs) does the rest
// on that grid. The bytes are never stored.
//
// A real date cell becomes `YYYY-MM-DD` (exceljs reads dates as UTC); a formula
// becomes its cached result; rich text and hyperlinks become their text. A
// merged range reads the master's value on every cell of the range, which the
// parser's "blank Action inherits" rule treats the same way.
import ExcelJS from 'exceljs';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // flows/01 dropzone: "max 10 MB"
export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 40;

/** The bytes are not a readable .xlsx (wrong type, corrupt, encrypted). */
export class UnreadableWorkbook extends Error {}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/** @param {Buffer|Uint8Array} bytes @returns {Promise<{sheets: Array<{name: string, rows: string[][]}>}>} */
export async function readWorkbook(bytes) {
  const buf = Buffer.from(bytes ?? []);
  if (buf.length < 4 || !ZIP_MAGIC.every((b, i) => buf[i] === b)) {
    throw new UnreadableWorkbook('not an .xlsx workbook');
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch {
    throw new UnreadableWorkbook('the workbook could not be read');
  }
  const sheets = [];
  wb.eachSheet((ws) => {
    const rows = [];
    const last = Math.min(ws.rowCount, MAX_ROWS + 1);
    for (let r = 1; r <= last; r += 1) {
      const row = ws.getRow(r);
      const cells = [];
      const width = Math.min(row.cellCount, MAX_COLUMNS);
      for (let c = 1; c <= width; c += 1) cells.push(cellText(row.getCell(c).value));
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      rows.push(cells);
    }
    while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
    sheets.push({ name: ws.name, rows });
  });
  return { sheets };
}

/** One cell value → its text. */
export function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text ?? '').join('').trim();
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    if ('error' in v) return '';
  }
  return String(v).trim();
}

/** The port the composition root injects into registerPlanning. */
export const xlsxWorkbooks = Object.freeze({ read: readWorkbook });
