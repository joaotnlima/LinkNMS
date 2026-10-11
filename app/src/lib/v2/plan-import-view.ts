// Pure helpers for the Excel import screens (PRD-09 O-6..O-10; flows/01
// screens 8–10). The parsing, the mapping check and the tree are the server's
// (planning, `schedule-imports`); this words fields, turns the mapper's
// per-column selects into a mapping, and lays out the mini Gantt from the
// dates the server answered.

export type ImportField = 'action' | 'sub_action' | 'start' | 'end' | 'duration' | 'trade' | 'dependency';

export interface V2ImportWarning { row: number; field?: ImportField; code: string; message: string }
export interface V2ImportRow {
  row: number; action: string | null; sub_action: string | null; start: string | null; finish: string | null;
  duration_wd: number | null; trade: string | null; specialty_code: string | null; dependency: string | null;
  warnings: V2ImportWarning[];
}
export interface V2ImportNode {
  key: string; row: number; name: string; start: string | null; finish: string | null;
  trade: string | null; specialty_code: string | null; depends_on: string[]; children?: V2ImportNode[];
}
export interface V2ScheduleImport {
  id: string;
  project_id: string;
  status: 'uploaded' | 'mapped' | 'previewed' | 'confirmed' | 'failed';
  filename: string;
  sheets: Array<{ name: string; rows: number; columns: number }>;
  sheet: string | null;
  columns: Array<{ index: number; header: string; samples: string[] }>;
  mapping: Partial<Record<ImportField, number>>;
  mapping_suggested: boolean;
  missing_required: ImportField[];
  sample?: V2ImportRow[];
  tree?: V2ImportNode[];
  counts?: { rows: number; actions: number; sub_actions: number; links: number; trades: number; warnings: number };
  warnings: V2ImportWarning[];
  plan_exists: boolean;
  imported_by?: { org_id: string; org_name?: string };
  confirmed_at: string | null;
}

export const FIELD_OPTIONS: ReadonlyArray<{ value: ImportField; label: string; required?: boolean }> = Object.freeze([
  { value: 'action', label: 'Action', required: true },
  { value: 'sub_action', label: 'Sub-action' },
  { value: 'start', label: 'Start date', required: true },
  { value: 'end', label: 'End date', required: true },
  { value: 'duration', label: 'Duration (working days)' },
  { value: 'trade', label: 'Trade' },
  { value: 'dependency', label: 'Dependency' },
]);

export function fieldLabel(f: string): string {
  return FIELD_OPTIONS.find((o) => o.value === f)?.label ?? f;
}

/** field → column index, inverted for the per-column selects. */
export function fieldOfColumn(mapping: Partial<Record<ImportField, number>>): Map<number, ImportField> {
  const out = new Map<number, ImportField>();
  for (const [f, i] of Object.entries(mapping)) if (Number.isInteger(i)) out.set(i as number, f as ImportField);
  return out;
}

/**
 * The selects (column index → field or '') → a mapping. Two columns on one
 * field is the person's mistake to fix, said plainly — never silently resolved.
 */
export function mappingFromSelects(selects: Array<[number, string]>): { mapping: Partial<Record<ImportField, number>>; error?: string } {
  const mapping: Partial<Record<ImportField, number>> = {};
  for (const [col, field] of selects) {
    if (!field) continue;
    if (!FIELD_OPTIONS.some((o) => o.value === field)) continue;
    const f = field as ImportField;
    if (mapping[f] !== undefined) return { mapping, error: `Two columns are mapped to ${fieldLabel(f)} — keep one.` };
    mapping[f] = col;
  }
  return { mapping };
}

/** The sentence under the mapper: what still blocks Confirm. */
export function missingSentence(missing: string[]): string | null {
  if (!missing.length) return null;
  const names = missing.map((m) => (m === 'end' ? 'End date (or Duration)' : fieldLabel(m)));
  return `Map ${names.join(', ')} to continue — the other fields are optional.`;
}

export interface GanttBar { key: string; name: string; depth: 0 | 1; left: number; width: number; dated: boolean; start: string | null; finish: string | null }

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86400000;

/** Mini Gantt geometry (percent of the tree's span) for the preview. */
export function ganttBars(tree: V2ImportNode[]): { bars: GanttBar[]; from: string | null; to: string | null } {
  const nodes = tree.flatMap((a) => [{ n: a, depth: 0 as const }, ...(a.children ?? []).map((c) => ({ n: c, depth: 1 as const }))]);
  const starts = nodes.map((x) => x.n.start).filter(Boolean) as string[];
  const ends = nodes.map((x) => x.n.finish ?? x.n.start).filter(Boolean) as string[];
  if (!starts.length) {
    return { bars: nodes.map(({ n, depth }) => ({ key: n.key, name: n.name, depth, left: 0, width: 0, dated: false, start: null, finish: null })), from: null, to: null };
  }
  const from = starts.sort()[0];
  const to = ends.sort().at(-1) ?? from;
  const span = Math.max(1, day(to) - day(from) + 1);
  return {
    from, to,
    bars: nodes.map(({ n, depth }) => {
      if (!n.start) return { key: n.key, name: n.name, depth, left: 0, width: 0, dated: false, start: null, finish: null };
      const end = n.finish ?? n.start;
      const left = ((day(n.start) - day(from)) / span) * 100;
      const width = Math.max(1.5, ((day(end) - day(n.start) + 1) / span) * 100);
      return { key: n.key, name: n.name, depth, left, width: Math.min(width, 100 - left), dated: true, start: n.start, finish: n.finish };
    }),
  };
}
