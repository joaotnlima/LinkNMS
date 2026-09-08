// The browser half of the Slice B1 plan import (LINA-207).
//
// Frozen contract: docs/architecture/slice-b1-plan-import-contract.md §2 + §7.
// Pen: D8–D10, "Desktop — Bootstrap flow (lg)" › Band C · Get the plan in.
//
// ── WHY THIS TALKS HTTP AND NOT A SERVER ACTION ──────────────────────────────
// Every other write in this app goes through a server action into `@/lib/api`'s
// in-process transport. This one cannot, and the reason is the contract's own
// design: the flow is STATELESS server-side (§2 — "no server-side staging of
// the uploaded bytes"), so the SAME file is re-sent on each of the four steps.
// The only place that file exists between steps is the browser's `File` handle,
// which does not survive a navigation and cannot be round-tripped through a
// server action without staging it somewhere — the exact thing §2 refuses to
// own. So the wizard is one client component holding one `File`, POSTing
// multipart to the mounted /api/v1 routes (LINA-206). Same-origin fetch carries
// the Clerk session cookie, and authorization is decided in the service
// (`IMPORT_PLAN`, contract §5) exactly as it is for every other caller — this is
// a different transport, not a different trust boundary.
//
// ── NOTHING HERE INTERPRETS THE SPREADSHEET ──────────────────────────────────
// Contract §0: the browser uploads bytes only. There is no xlsx parser in this
// bundle, no header sniffing, no date coercion. Sheet names, column headers,
// samples, the WBS tree, warnings and errors are all things the server said.

/** The six target fields a mapping may assign (contract §2). */
export type PlanField = 'action' | 'subAction' | 'start' | 'end' | 'trade' | 'dependency';

/** field → 1-based source column index, or null for "not assigned". */
export type PlanMapping = Record<PlanField, number | null>;

export const EMPTY_MAPPING: PlanMapping = {
  action: null, subAction: null, start: null, end: null, trade: null, dependency: null,
};

/**
 * The field table, in the order the mapping UI offers them.
 *
 * `required` mirrors the parser's REQUIRED_FIELDS (services/schedule/
 * plan-import-parser.mjs). It is duplicated here to keep the Continue button
 * honest BEFORE a round trip — not to decide anything: a mapping missing a
 * required field is a 400 from the server whatever this file believes.
 *
 * NOTE — the pen's D9 also offers Quantity / Unit / Unit price, and its preview
 * pane carries a "CONTRACT VALUE" total. Those are NOT in the B1 mapping: the
 * frozen contract's field set is exactly the six below, and materials/money ride
 * on B3 (LINA-201) on top of B2. Offering a "Unit price" select that the server
 * would reject as `invalid_mapping` would be a worse screen than one that shows
 * six fields and means it, so the money columns are deliberately absent rather
 * than drawn and dead.
 */
export const PLAN_FIELDS: { key: PlanField; label: string; required: boolean; hint: string }[] = [
  { key: 'action', label: 'Action', required: true, hint: 'The top-level stage name.' },
  { key: 'subAction', label: 'Sub-action', required: false, hint: 'Names a step under its Action.' },
  { key: 'start', label: 'Start', required: true, hint: 'A real date cell, or YYYY-MM-DD text.' },
  { key: 'end', label: 'End', required: true, hint: 'A real date cell, or YYYY-MM-DD text.' },
  { key: 'trade', label: 'Trade', required: false, hint: 'Free-form trade label.' },
  { key: 'dependency', label: 'Dependency', required: false, hint: 'Row refs (R12, R13) this stage waits on.' },
];

export const REQUIRED_FIELDS: PlanField[] = PLAN_FIELDS.filter((f) => f.required).map((f) => f.key);

/**
 * The limits the FE echoes (contract §1: "BE child sets the exact numbers, FE
 * echoes them"). These are a COPY of services/schedule/plan-import-parser.mjs's
 * LIMITS and the server remains the authority — every one of them is re-checked
 * server-side on a file the client can neither vouch for nor withhold. They live
 * here only so a 40 MB drop is refused in the picker instead of after a 40 MB
 * upload, and so the dropzone can state the rule before the mistake.
 *
 * `:inspect` and `:columns` also return the server's own `limits` on the wire;
 * the wizard prefers those once it has them, which is what keeps a future BE
 * change from needing a front-end deploy to stay truthful.
 */
export const LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxRows: 10_000,
  maxCols: 100,
  acceptedExtension: '.xlsx',
} as const;

export type WireLimits = Partial<typeof LIMITS> & Record<string, unknown>;

export interface SheetInfo { name: string; rowCount: number }
export interface ColumnInfo { index: number; header: string; sampleValues: string[] }

/** contract §2 — the preview/stored shape. Two levels by construction (§6). */
export interface WBSNode {
  ref: string;
  action: string;
  subActionOf: string | null;
  start: string | null;
  end: string | null;
  trade: string | null;
  dependsOn: string[];
  children: WBSNode[];
}

export interface InspectResult { sheets: SheetInfo[]; limits?: WireLimits }
export interface ColumnsResult { columns: ColumnInfo[]; rowCount: number; limits?: WireLimits }
export interface PreviewResult {
  roots: WBSNode[];
  warnings: string[];
  errors: string[];
  stats: { stageCount: number; rootCount: number; subActionCount: number };
}
export interface ConfirmResult {
  importId: string;
  auditEventId: string;
  stageCount: number;
  rootCount: number;
}

/**
 * A refusal the server stated, carried with its code so a screen can react to
 * the KIND of failure and not to a substring of English. `code` is one of the
 * parser's typed 400s (file_type_not_supported, empty_file, file_too_large,
 * file_unparseable, empty_workbook, empty_sheet, too_many_rows, …) or the
 * gateway's own (forbidden, unauthenticated, internal).
 */
export class PlanImportError extends Error {
  // Assigned in the body rather than as constructor parameter properties: this
  // module is unit-tested through `node --test`, whose strip-only TypeScript
  // loader refuses that syntax (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). Nothing
  // here may need a build step to run.
  status: number;
  code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = 'PlanImportError';
    this.status = status;
    this.code = code;
  }
}

/** Client-side pre-flight — the same two rules, stated before the upload. */
export function preflight(file: File, limits: WireLimits = LIMITS): PlanImportError | null {
  const ext = file.name.includes('.') ? `.${file.name.split('.').pop()!.toLowerCase()}` : '';
  const accepted = limits.acceptedExtension ?? LIMITS.acceptedExtension;
  if (ext !== accepted) {
    return new PlanImportError(400,
      `Only ${accepted} workbooks are supported${ext ? ` — this file is ${ext}` : ''}.`,
      'file_type_not_supported');
  }
  if (file.size === 0) {
    return new PlanImportError(400, 'That file is empty.', 'empty_file');
  }
  const max = limits.maxFileBytes ?? LIMITS.maxFileBytes;
  if (file.size > max) {
    return new PlanImportError(400,
      `That file is ${formatBytes(file.size)} — the limit is ${formatBytes(max)}.`,
      'file_too_large');
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── the four calls (contract §2) ─────────────────────────────────────────────

type Step = 'inspect' | 'columns' | 'preview' | 'confirm';

// The route segment contains a literal colon (`plan-imports:inspect`). It is a
// legal path character and Next matches the folder name verbatim, so it must NOT
// be encoded — encodeURIComponent here would produce a 404 against a route that
// exists. Only the project id is user-controlled and it is encoded.
const url = (projectId: string, step: Step) =>
  `/api/v1/projects/${encodeURIComponent(projectId)}/plan-imports:${step}`;

async function post<T>(projectId: string, step: Step, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url(projectId, step), { method: 'POST', body: form });
  } catch {
    // A dropped connection mid-upload is the one failure with no server sentence
    // to quote. Give it a code so the screen can offer "try again" rather than
    // treating it as a rejection of the file.
    throw new PlanImportError(0, 'Could not reach the server. Check your connection and try again.', 'network');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new PlanImportError(res.status, e?.message ?? `Request failed (${res.status}).`, e?.code ?? 'error');
  }
  return body as T;
}

const withFile = (file: File) => {
  const form = new FormData();
  form.set('file', file, file.name);
  return form;
};

export function inspectSheets(projectId: string, file: File): Promise<InspectResult> {
  return post<InspectResult>(projectId, 'inspect', withFile(file));
}

export function inspectColumns(projectId: string, file: File, sheet: string): Promise<ColumnsResult> {
  const form = withFile(file);
  form.set('sheet', sheet);
  return post<ColumnsResult>(projectId, 'columns', form);
}

export function previewImport(
  projectId: string, file: File, sheet: string, mapping: PlanMapping,
): Promise<PreviewResult> {
  const form = withFile(file);
  form.set('sheet', sheet);
  form.set('mapping', JSON.stringify(mapping));
  return post<PreviewResult>(projectId, 'preview', form);
}

export function confirmImport(
  projectId: string, file: File, sheet: string, mapping: PlanMapping, idempotencyKey: string,
): Promise<ConfirmResult> {
  const form = withFile(file);
  form.set('sheet', sheet);
  form.set('mapping', JSON.stringify(mapping));
  form.set('idempotencyKey', idempotencyKey);
  return post<ConfirmResult>(projectId, 'confirm', form);
}

// ── derived, for the screens ─────────────────────────────────────────────────

export const missingRequired = (m: PlanMapping): PlanField[] =>
  REQUIRED_FIELDS.filter((f) => m[f] == null);

/** column index → the field assigned to it, for the D9 left pane. */
export function fieldByColumn(m: PlanMapping): Map<number, PlanField> {
  const byCol = new Map<number, PlanField>();
  for (const { key } of PLAN_FIELDS) {
    const idx = m[key];
    if (idx != null) byCol.set(idx, key);
  }
  return byCol;
}

/**
 * Assign `field` to `column` (or clear the column when field is null).
 *
 * A field lives in exactly ONE column — that is the mapping's shape on the wire
 * (§2: field → column index), so assigning a field that is already placed MOVES
 * it rather than creating a second home for it. Doing this in the reducer is
 * what makes the impossible state unrepresentable instead of merely warned
 * about after a round trip.
 */
export function assign(m: PlanMapping, column: number, field: PlanField | null): PlanMapping {
  const next: PlanMapping = { ...m };
  for (const { key } of PLAN_FIELDS) if (next[key] === column) next[key] = null;
  if (field) next[field] = column;
  return next;
}

/**
 * The minimum a node must carry to be laid out on the mini-gantt: a tree and two
 * plain calendar dates. Stated structurally rather than as `WBSNode` because B2
 * (LINA-212) draws the SAME chart from `GET /plan`'s stage tree, whose rows
 * carry an id and a cost the import preview has no idea about. Widening the
 * parameter is what makes that reuse real — the alternative was a second copy of
 * `barGeometry`, i.e. a second place a bar can land in the wrong month.
 */
export interface DatedNode {
  start: string | null;
  end: string | null;
}

/** WBS pre-order, the same order the server writes and stamps in (contract §4). */
export function preorder<T extends { children: T[] }>(roots: T[]): { node: T; depth: number }[] {
  const out: { node: T; depth: number }[] = [];
  const visit = (n: T, depth: number) => {
    out.push({ node: n, depth });
    for (const c of n.children) visit(c, depth + 1);
  };
  for (const r of roots) visit(r, 0);
  return out;
}

/**
 * The mini-gantt's month axis (pen D10).
 *
 * Derived from the dates the PREVIEW returned, never from today's clock: a plan
 * that runs Mar–Dec 2027 must draw Mar–Dec 2027. Returns null when no row
 * carries both dates — the gantt then does not render at all rather than
 * inventing a span.
 */
export interface GanttScale { months: { key: string; label: string }[]; from: number; to: number }

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** YYYY-MM-DD → days since epoch, parsed as a plain calendar date (no timezone). */
export function dayNumber(iso: string | null): number | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000);
}

export function ganttScale<T extends DatedNode & { children: T[] }>(roots: T[]): GanttScale | null {
  let min: number | null = null;
  let max: number | null = null;
  for (const { node } of preorder(roots)) {
    const s = dayNumber(node.start);
    const e = dayNumber(node.end);
    if (s != null) { min = min == null || s < min ? s : min; max = max == null || s > max ? s : max; }
    if (e != null) { min = min == null || e < min ? e : min; max = max == null || e > max ? e : max; }
  }
  if (min == null || max == null) return null;

  // Widen to whole months so the axis labels line up with the bars.
  const start = new Date(min * 86_400_000);
  const end = new Date(max * 86_400_000);
  const from = Math.floor(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1) / 86_400_000);
  const to = Math.floor(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 1) / 86_400_000);

  const months: { key: string; label: string }[] = [];
  const cursor = new Date(from * 86_400_000);
  // Cap the axis: a plan spanning decades would otherwise draw a column per
  // month until the row is unreadable. 36 is three years of build, which is
  // longer than any house; past that the bars still position correctly against
  // `from`/`to`, only the labels stop.
  while (Math.floor(cursor.getTime() / 86_400_000) < to && months.length < 36) {
    months.push({
      key: `${cursor.getUTCFullYear()}-${cursor.getUTCMonth()}`,
      label: MONTHS[cursor.getUTCMonth()],
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return { months, from, to };
}

/** A node's bar as left/width percentages of the scale, or null when undated. */
export function barGeometry(node: DatedNode, scale: GanttScale): { left: number; width: number } | null {
  const s = dayNumber(node.start);
  const e = dayNumber(node.end);
  if (s == null && e == null) return null;
  const span = scale.to - scale.from;
  if (span <= 0) return null;
  const from = s ?? e!;
  // An end before its start is the sheet's problem, not the chart's: clamp to a
  // visible sliver so the row is still findable, and let the server's own
  // warnings say what is wrong with it.
  const till = Math.max(e ?? from, from) + 1;
  const left = ((from - scale.from) / span) * 100;
  const width = ((till - from) / span) * 100;
  return { left: Math.max(0, Math.min(100, left)), width: Math.max(0.8, Math.min(100 - left, width)) };
}

/** "2 Mar – 20 Mar" for the D10 dates column; a dash when a date is missing. */
export function dateRange(node: DatedNode): string {
  const fmt = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(`${iso}T00:00:00Z`);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()][0]}${MONTHS[d.getUTCMonth()].slice(1).toLowerCase()}`;
  };
  return `${fmt(node.start)} – ${fmt(node.end)}`;
}
