// Pure v2-wire → view transforms for the drawing viewer (PRD-06). Split from
// `viewer.ts` (the I/O, `server-only`) so the mapping is unit-testable. Nothing
// here decides who may do what — the documents module answers 403/404/409 and
// the viewer shows the sentence. What lives here is presentation arithmetic:
// which markups a sheet shows, the scale a calibration gives, a length's label,
// the footer sentence, the version picker, the rail groups.

import type { FileType, FileView, V2FileVersion } from './task-files-view.ts';

// ── wire (subset, restated — a drift lands as a type error) ────────────────────

export type MarkupKind = 'cloud' | 'arrow' | 'text' | 'measure' | 'calibration';
export type Point = [number, number];

export interface V2MarkupGeometry { points: Point[]; length_mm?: number }

export interface V2Markup {
  id: string;
  document_id: string;
  version_no: number;
  page_or_layout: string;
  kind: MarkupKind;
  geometry: V2MarkupGeometry;
  text?: string;
  author: { person_id: string; org_id: string };
  created_at: string;
  state: 'open' | 'closed';
  closed_at?: string;
  question_id?: string;
  nonconformity_id?: string;
}

export interface V2PreviewLayout { index: number; name: string; width?: number; height?: number; view_url: string; expires_at: string }

export interface V2Preview {
  document_id: string;
  version_no: number;
  file_type?: FileType;
  status: 'ready' | 'pending' | 'unavailable';
  reason?: string;
  layouts: V2PreviewLayout[];
  layers: Array<{ name: string; on: boolean; color?: string; count?: number }>;
  warnings: Array<{ code: string; detail?: string }>;
}

// ── markups ────────────────────────────────────────────────────────────────────

export const MARKUP_KIND_LABEL: Record<MarkupKind, string> = {
  cloud: 'Cloud', arrow: 'Arrow + note', text: 'Text', measure: 'Measure', calibration: 'Calibration',
};

/** A markup on screen: saved (from the wire) or a draft not saved yet. */
export interface MarkupView {
  id: string;
  kind: MarkupKind;
  page: string;
  versionNo: number | null;
  points: Point[];
  lengthMm: number | null;
  text: string | null;
  authorOrgId: string | null;
  createdAt: string | null;
  state: 'open' | 'closed';
  questionId: string | null;
  nonconformityId: string | null;
  draft: boolean;
}

export function toMarkupView(m: V2Markup): MarkupView {
  return {
    id: m.id,
    kind: m.kind,
    page: m.page_or_layout,
    versionNo: m.version_no,
    points: m.geometry.points,
    lengthMm: m.geometry.length_mm ?? null,
    text: m.text ?? null,
    authorOrgId: m.author.org_id,
    createdAt: m.created_at,
    state: m.state,
    questionId: m.question_id ?? null,
    nonconformityId: m.nonconformity_id ?? null,
    draft: false,
  };
}

export function draftMarkup(args: { id: string; kind: MarkupKind; page: string; points: Point[]; text?: string | null; lengthMm?: number | null }): MarkupView {
  return {
    id: args.id, kind: args.kind, page: args.page, versionNo: null, points: args.points,
    lengthMm: args.lengthMm ?? null, text: args.text?.trim() || null, authorOrgId: null, createdAt: null,
    state: 'open', questionId: null, nonconformityId: null, draft: true,
  };
}

/** The wire body of a draft (schema MarkupDraft). */
export function draftBody(m: MarkupView) {
  return {
    id: m.id,
    page_or_layout: m.page,
    kind: m.kind,
    geometry: m.kind === 'calibration' ? { points: m.points, length_mm: m.lengthMm ?? 0 } : { points: m.points },
    ...(m.text ? { text: m.text } : {}),
  };
}

/**
 * What one sheet shows when version `versionNo` is open: saved markups pinned to
 * the page with `version_no ≤ versionNo`, then the drafts. Calibrations are not
 * listed (they set the scale). Numbered in that order (the badge on the sheet
 * and in the panel). `fromVersion` names markups drawn on an earlier version
 * whose bytes differ — they may not fit a revised drawing (V-10).
 */
export function markupsOnSheet(all: MarkupView[], opts: { page: string; versionNo: number; shaOf: (versionNo: number) => string | null }) {
  const here = opts.shaOf(opts.versionNo);
  return all
    .filter((m) => m.kind !== 'calibration' && m.page === opts.page && (m.draft || (m.versionNo ?? 0) <= opts.versionNo))
    .map((m, i) => ({
      ...m,
      n: i + 1,
      fromVersion: !m.draft && m.versionNo !== null && here !== null && opts.shaOf(m.versionNo) !== here ? m.versionNo : null,
    }));
}

export function distance(points: Point[]): number {
  if (points.length < 2) return 0;
  const [[x0, y0], [x1, y1]] = points;
  return Math.hypot(x1 - x0, y1 - y0);
}

/**
 * The scale of a sheet: the latest calibration on this page (a draft wins over
 * saved ones) drawn on bytes identical to the open version's — a revised
 * drawing must be calibrated again. Millimetres per sheet unit, or null.
 */
export function sheetScale(all: MarkupView[], opts: { page: string; versionNo: number; shaOf: (versionNo: number) => string | null }): number | null {
  const here = opts.shaOf(opts.versionNo);
  const cals = all.filter((m) => m.kind === 'calibration' && m.page === opts.page && m.lengthMm
    && (m.draft || ((m.versionNo ?? 0) <= opts.versionNo && opts.shaOf(m.versionNo ?? 0) === here)));
  const cal = cals.find((m) => m.draft) ?? cals.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
  if (!cal) return null;
  const d = distance(cal.points);
  return d > 0 ? (cal.lengthMm as number) / d : null;
}

/** V-6: a length shows units only once the sheet is calibrated. */
export function measureLabel(points: Point[], mmPerUnit: number | null): string {
  if (!mmPerUnit) return 'not calibrated';
  const mm = distance(points) * mmPerUnit;
  if (mm >= 1000) return `${(mm / 1000).toFixed(2)} m`;
  return `${Math.round(mm)} mm`;
}

/** "1:50" when the sheet is drawn in PDF points (1 pt = 25.4/72 mm on paper). */
export function ratioLabel(mmPerUnit: number | null, fileType: FileType): string | null {
  if (!mmPerUnit || fileType !== 'pdf') return null;
  const ratio = mmPerUnit / (25.4 / 72);
  return ratio >= 1 ? `1:${Math.round(ratio)}` : null;
}

// ── versions, footer, rail ─────────────────────────────────────────────────────

export interface VersionOption { versionNo: number; label: string; sha256: string; markupOnly: boolean }

export function versionOptions(versions: V2FileVersion[], current: number): VersionOption[] {
  return versions.map((v) => ({
    versionNo: v.version_no,
    sha256: v.sha256,
    markupOnly: v.change_kind === 'markup_only',
    label: [`v${v.version_no}`, v.change_kind === 'markup_only' ? 'markups only' : null, v.version_no === current ? 'current' : null]
      .filter(Boolean).join(' · '),
  })).reverse();
}

/** V-7: the latest earlier version whose BYTES differ (a markups-only version is the same drawing). */
export function overlayBase(versions: Array<{ version_no: number; sha256: string }>, versionNo: number): number | null {
  const here = versions.find((v) => v.version_no === versionNo)?.sha256;
  const earlier = versions.filter((v) => v.version_no < versionNo && v.sha256 !== here);
  return earlier.length ? earlier[earlier.length - 1].version_no : null;
}

/** V-3: what saving does, in one sentence. */
export function saveFooter(current: number, unsaved: number, fileType: FileType): string {
  const what = fileType === 'pdf' ? 'PDF' : fileType === 'dxf' ? '.dxf' : '.dwg';
  const lead = unsaved === 0 ? 'No unsaved markups' : `${unsaved} unsaved markup${unsaved === 1 ? '' : 's'}`;
  return `${lead} · saving makes v${current + 1} = same ${what} + markups (the history labels it “markups only”)`;
}

export const VIEWABLE: ReadonlySet<FileType> = new Set<FileType>(['pdf', 'dwg', 'dxf']);

export function isViewable(file: Pick<FileView, 'fileType'>): boolean {
  return VIEWABLE.has(file.fileType);
}

const GROUP_ORDER: Array<{ key: string; label: string; types: FileType[] }> = [
  { key: 'pdf', label: 'PDF sheets', types: ['pdf'] },
  { key: 'dwg', label: 'DWG / DXF drawings', types: ['dwg', 'dxf'] },
  { key: 'ifc', label: 'Models', types: ['ifc'] },
  { key: 'other', label: 'Other files', types: ['image', 'other'] },
];

/** V-1: the rail — the files grouped by type, in a stable order. */
export function railGroups(files: FileView[]): Array<{ key: string; label: string; files: FileView[] }> {
  return GROUP_ORDER
    .map((g) => ({ key: g.key, label: g.label, files: files.filter((f) => g.types.includes(f.fileType)) }))
    .filter((g) => g.files.length > 0);
}

const REASONS: Record<string, string> = {
  converter_not_configured: 'previews of DWG files are not switched on for this workspace yet',
  unsupported_version: 'this DWG version is not supported by the converter',
  conversion_failed: 'the drawing could not be converted (for example proxy objects)',
  conversion_timeout: 'the conversion took too long',
  empty_drawing: 'the converter found nothing to draw',
  preview_too_large: 'the preview would be too large to show',
};

/** V-14: "No preview, download only" with the reason when known. */
export function previewReason(reason: string | null | undefined): string | null {
  return reason ? REASONS[reason] ?? reason.replace(/_/g, ' ') : null;
}

/** CSS hiding the layers the viewer switched off (V-12, the viewer's own view). */
export function hiddenLayersCss(hidden: Iterable<string>, escape: (s: string) => string): string {
  return [...hidden].map((name) => `[data-layer="${escape(name)}"]{display:none}`).join('\n');
}

/**
 * A revision-cloud outline around the rectangle (x0,y0)–(x1,y1): scallops of
 * roughly `bump` sheet units along each side. Pure geometry for the SVG overlay.
 */
export function cloudPath([[ax, ay], [bx, by]]: Point[], bump: number): string {
  const x0 = Math.min(ax, bx); const x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by); const y1 = Math.max(ay, by);
  const corners: Point[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const r = Math.max(bump, 1e-6);
  let d = `M ${x0} ${y0}`;
  for (let i = 0; i < 4; i += 1) {
    const [sx, sy] = corners[i]; const [ex, ey] = corners[i + 1];
    const len = Math.hypot(ex - sx, ey - sy);
    const n = Math.max(1, Math.round(len / (2 * r)));
    for (let k = 1; k <= n; k += 1) {
      const px = sx + ((ex - sx) * k) / n; const py = sy + ((ey - sy) * k) / n;
      d += ` A ${len / n / 2} ${len / n / 2} 0 0 1 ${px} ${py}`;
    }
  }
  return `${d} Z`;
}
