'use client';

// The unified plan grid (LINA-248) — the ONE face of the "Build the plan"
// editor. The List/Timeline toggle is gone: every row is an editable table row
// on the left (id · name · specialty · owner · dates) AND a timeline track on
// the right, aligned row-for-row, so composing the plan and scheduling it are
// the same gesture on the same screen (pen: "Build the plan — schedule
// (Gantt)"). Follow-ups (2026-09-11): the toolbar picks the timeline's TIME
// BASE (fit / week / month / quarter / 6 months / year / custom start–end),
// the name / specialty / dates columns RESIZE by dragging the header edges,
// and start–finish read as one Dates column.
//
// LINA-259 layers seven UX behaviours onto the same grid — all presentational,
// none touching the wire or the draft's shape:
//   1. HOVER a bar → a dated label to its right (Mar 3 – Mar 10 · 8 days).
//   2. A draggable DIVIDER resizes the table/Gantt split (session-persisted).
//   3. A horizontal wheel / trackpad swipe over the grid PANS the timeline; the
//      table columns stay pinned.
//   4. DOUBLE-CLICK a column's resize handle → auto-fit it to its content (the
//      name column is excluded).
//   5. A segmented STATUS METER on each parent row (phase, task-with-children)
//      counts its children by derived status — all "not started" on a fresh
//      draft, by design (status is derived, never authored — ADR-0019).
//   6. Column HEADERS drag-reorder (specialty / owner / dates); the name column
//      stays pinned first (session-persisted order).
//   7. PROMOTE / DEMOTE a row in the WBS (a row menu), respecting the depth-3
//      cap — the pure ops in plan-authoring.ts do the reparenting.
//
// WHAT A ROW DOES (the founder's four asks, LINA-248):
//   1. OWNER is a column: an avatar — the unassigned ring when nobody owns the
//      stage — with the member <select> laid over it, so clicking the circle
//      opens the dropdown of everyone invited to this build. Same picker
//      discipline as before: project members only, assigning grants nothing.
//   2. SPECIALTY (trade) is a column on the same row; the name cell yields the
//      width.
//   3. The TIMELINE is always visible. A row with no dates is scheduled by
//      CLICKING its empty track: the bar lands on the clicked day, one week
//      long, and is then dragged wherever the author sees fit (move / resize —
//      LINA-236 math, untouched). An undated plan still gets a canvas: the
//      window falls back to today (scheduleWindow).
//   4. CLICKING THE ROW opens the detail drawer (the editor owns it). The name
//      is text, not a permanent input — the ✎ button, sitting RIGHT BESIDE the
//      name (founder follow-up, 2026-09-11), is the one way to rename in place,
//      so a click on the row is never a rename by accident. While the input is
//      open a ✓ button beside it commits the name (Enter and clicking away
//      commit too — the ✓ is the visible affordance).
//   5. ADDING a phase/task/sub-task drops the new row straight into rename mode
//      with the input focused (founder follow-up): the add callbacks return the
//      fresh node's key and the grid opens the editor on it.
//
// This component owns no draft state — every edit calls back into the editor's
// pure ops (@/lib/plan-authoring), exactly as the old list and Gantt did. The
// LINA-259 state it DOES own is view-only (the split, the column order, which
// row's move-menu is open) and never leaves the browser.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addDays, applyDrag, baseWindow, clickDates, clipBarGeom, diffDays, formatDay, parseDay,
  type DragMode, type GanttWindow, type TimeBase,
} from '@/lib/plan-gantt';
import { childStatusCounts, type PhaseDraft, type StatusCounts, type TaskDraft } from '@/lib/plan-authoring';
import { PartyAvatar, UnassignedAvatar } from '@/components/PartyAvatar';
import { partyIndex, partyOf, roleWord, type PartyRef } from '@/lib/party-display';

// Pixels per day column, per time base (LINA-248 follow-up): the base the
// author picks is a READING scale, so a week spreads its 7 days wide while a
// year compresses to a page-ish sweep. 'custom' is sized after the window is
// known (fit ~1120px, clamped so a day is never ungrabbable-thin).
const BASE_PX: Record<Exclude<TimeBase, 'custom'>, number> = {
  auto: 30, week: 64, month: 30, quarter: 12, half: 6, year: 3,
};
const BASE_LABELS: Array<[TimeBase, string]> = [
  ['auto', 'Fit plan'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'],
  ['half', '6 months'], ['year', 'Year'], ['custom', 'Custom range'],
];
/** Row heights, shared by the table cell and its track so the panes align. */
const H = { phase: 36, task: 42, sub: 36, add: 34 } as const;
const AXIS_H = 28;
/** Resizable columns' minimum widths — below these the cell content breaks. */
const COL_MIN = { name: 120, trade: 56, dates: 150 } as const;
/** Largest a column may grow to (drag or auto-fit). */
const COL_MAX = 560;

// ── The reorderable middle columns (LINA-259 ask 6) ──────────────────────────
// The name column is pinned first and never moves; grip and ID are fixed too.
// Only these three reorder, and their widths reorder with them so the grid
// template stays row-for-row consistent between the header and the body.
type ColKey = 'trade' | 'owner' | 'dates';
const DEFAULT_COL_ORDER: ColKey[] = ['trade', 'owner', 'dates'];
const COL_TEMPLATE: Record<ColKey, string> = {
  trade: 'var(--pgdw-trade, 96px)',
  owner: '30px',
  dates: 'var(--pgdw-dates, 176px)',
};

// Session-only view state (LINA-259): the split and the column order live for
// the tab, not the account — a reading preference, not part of the plan.
const SPLIT_KEY = 'pgd:split';
const COLORDER_KEY = 'pgd:colorder';
/** Panes never shrink past these — the table stays usable, the canvas visible. */
const SPLIT_MIN_TABLE = 420;
const SPLIT_MIN_CANVAS = 260;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' → "Mar 9" without touching Date (no timezone surprises). */
function dayLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/**
 * The hover-tooltip text for a bar (LINA-259 ask 1): "Mar 3 – Mar 10 · 8 days"
 * for a dated bar, the single day for a half-dated (open) one. All day math goes
 * through parseDay/diffDays/formatDay — never a raw Date — so the count is exact
 * regardless of timezone, the same discipline the drag math keeps.
 */
function barTip(start: string, end: string): string {
  if (!start && !end) return '';
  if (!start || !end) return dayLabel(start || end);
  const n = (diffDays(start, end) ?? 0) + 1; // inclusive span
  return `${dayLabel(start)} – ${dayLabel(end)} · ${n} ${n === 1 ? 'day' : 'days'}`;
}

/** 'YYYY-MM-DD' → weekday 0..6 (Mon=0) for the week-boundary axis ticks. */
function weekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Sun=0 → Mon=0
}

/** A phase's derived envelope: earliest start → latest finish of its stages. */
function phaseEnvelope(p: PhaseDraft): { start: string; end: string } | null {
  let lo: number | null = null;
  let hi: number | null = null;
  const eat = (iso: string) => {
    const ms = parseDay(iso);
    if (ms === null) return;
    lo = lo === null || ms < lo ? ms : lo;
    hi = hi === null || ms > hi ? ms : hi;
  };
  p.tasks.forEach((t) => {
    eat(t.start); eat(t.end);
    (t.children ?? []).forEach((s) => { eat(s.start); eat(s.end); });
  });
  if (lo === null || hi === null) return null;
  return { start: formatDay(lo), end: formatDay(hi) };
}

type Row =
  | { kind: 'phase'; pi: number; key: string; phase: PhaseDraft }
  | { kind: 'task'; pi: number; ti: number; si?: number; key: string; node: TaskDraft }
  | { kind: 'add'; pi: number };

export interface PlanGridProps {
  phases: PhaseDraft[];
  parties: PartyRef[];
  /** Stage keys the cycle check named — their rows are outlined. */
  litRows: Set<string>;
  disabled: boolean;
  /** Today as 'YYYY-MM-DD' — anchors the fallback window for undated plans. */
  todayIso: string;
  /** Open the detail drawer for a phase (ti undefined), task or sub-task. */
  onOpenRow: (pi: number, ti?: number, si?: number) => void;
  onRename: (value: string, pi: number, ti?: number, si?: number) => void;
  onSetDate: (field: 'start' | 'end', value: string, pi: number, ti: number, si?: number) => void;
  /** Both dates at once — a drag result or an empty-track click plant. */
  onDates: (pi: number, ti: number, start: string, end: string, si?: number) => void;
  onAssign: (nodeKey: string, partyId: string | null) => void;
  onTrade: (nodeKey: string, trade: string) => void;
  /** Add ops return the NEW node's key so the grid can open rename on it. */
  onAddPhase: () => string;
  onAddTask: (pi: number) => string;
  onAddSubtask: (pi: number, ti: number) => string;
  onRemovePhase: (pi: number) => void;
  onRemoveTask: (pi: number, ti: number) => void;
  onRemoveSubtask: (pi: number, ti: number, si: number) => void;
  onReorderPhase: (from: number, to: number) => void;
  onReorderTask: (pi: number, from: number, to: number) => void;
  onReorderSubtask: (pi: number, ti: number, from: number, to: number) => void;
  /** Promote / demote a row in the WBS (LINA-259 ask 7). No-op when disallowed. */
  onPromote: (pi: number, ti: number, si?: number) => void;
  onDemote: (pi: number, ti: number, si?: number) => void;
}

export function PlanGrid(props: PlanGridProps) {
  const { phases, parties, litRows, disabled, todayIso } = props;
  const dir = useMemo(() => partyIndex(parties), [parties]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    phases.forEach((p, pi) => {
      out.push({ kind: 'phase', pi, key: p.key, phase: p });
      p.tasks.forEach((t, ti) => {
        out.push({ kind: 'task', pi, ti, key: t.key, node: t });
        (t.children ?? []).forEach((s, si) =>
          out.push({ kind: 'task', pi, ti, si, key: s.key, node: s }));
      });
      out.push({ kind: 'add', pi });
    });
    return out;
  }, [phases]);

  // ── The time base (founder follow-up, 2026-09-11): the author picks the
  // reading scale — fit / week / month / quarter / 6 months / year — or types
  // the exact start–end window they want. Session-local view state only.
  const [base, setBase] = useState<TimeBase>('auto');
  const [customRange, setCustomRange] = useState<{ from: string; to: string }>({ from: '', to: '' });

  // The window spans the picked base; 'auto' fits every dated stage, and an
  // undated plan still gets a canvas anchored on today so a first bar can be
  // clicked into being (LINA-248).
  const win = useMemo(() => {
    const dated: Array<{ start: string; end: string }> = [];
    rows.forEach((r) => { if (r.kind === 'task') dated.push({ start: r.node.start, end: r.node.end }); });
    return baseWindow(base, dated, todayIso, customRange);
  }, [rows, todayIso, base, customRange]);

  // Day-column width follows the base; a custom window sizes itself to read at
  // roughly one screen, never thinner than a grabbable 3px day.
  const col = base === 'custom'
    ? (win ? Math.max(3, Math.min(30, Math.floor(1120 / win.days))) : 30)
    : BASE_PX[base];

  const onPickBase = useCallback((next: TimeBase) => {
    // Entering custom seeds the inputs with the window currently on screen, so
    // the author edits a sensible range instead of typing from blank.
    if (next === 'custom' && win && !(parseDay(customRange.from) !== null && parseDay(customRange.to) !== null)) {
      setCustomRange({ from: win.startDay, to: win.endDay });
    }
    setBase(next);
  }, [win, customRange]);

  // ── Column resize (founder follow-up): dragging a header edge widens the
  // name / specialty / dates column; widths land as CSS vars on the root. ──
  const [colW, setColW] = useState<{ name?: number; trade?: number; dates?: number }>({});
  const rs = useRef<null | { col: keyof typeof COL_MIN; startX: number; startW: number }>(null);
  // A reused canvas for auto-fit text measurement (LINA-259 ask 4).
  const measure = useRef<CanvasRenderingContext2D | null>(null);
  // The grid root — auto-fit reads its rendered cells to size a column to fit.
  const rootRef = useRef<HTMLDivElement | null>(null);

  const onResizeDown = useCallback((c: keyof typeof COL_MIN) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const cell = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    rs.current = { col: c, startX: e.clientX, startW: cell.getBoundingClientRect().width };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const onResizeMove = useCallback((e: React.PointerEvent) => {
    const r = rs.current;
    if (!r) return;
    const w = Math.min(COL_MAX, Math.max(COL_MIN[r.col], Math.round(r.startW + e.clientX - r.startX)));
    setColW((prev) => (prev[r.col] === w ? prev : { ...prev, [r.col]: w }));
  }, []);
  const onResizeUp = useCallback((e: React.PointerEvent) => {
    if (!rs.current) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    rs.current = null;
  }, []);

  // Double-click a resize handle → auto-fit the column to its content (ask 4).
  // Specialty measures the widest trade label; the dates column measures the two
  // native date controls (their width is constant, so it fits the chrome, not a
  // value); TASK measures the longest stage name that is currently ellipsised.
  //
  // Fitting Task is safe despite it being the flexible track: its template is
  // `minmax(120px, var(--pgdw-name, 1fr))`, so the fitted px lands as the MAX
  // and the 120px floor stays structurally enforced by CSS — the column can be
  // fitted to its content and still never render below its minimum (LINA-261).
  const autoFit = useCallback((c: keyof typeof COL_MIN) => {
    const root = rootRef.current;
    if (!root) return;
    const ctx = (measure.current ??= document.createElement('canvas').getContext('2d'));
    if (!ctx) return;
    const selector = c === 'trade' ? '.pgd-tradeinput' : c === 'name' ? '.pgd-nametxt' : '.pgd-date';
    const sample = root.querySelector(selector) as HTMLElement | null;
    ctx.font = (sample && getComputedStyle(sample).font) || '12px sans-serif';
    let px = COL_MIN[c];
    if (c === 'trade') {
      let widest = 0;
      root.querySelectorAll<HTMLInputElement>('.pgd-tradeinput').forEach((el) => {
        widest = Math.max(widest, ctx.measureText(el.value || el.placeholder || '').width);
      });
      px = Math.ceil(widest) + 20; // input padding + a little breathing room
    } else if (c === 'name') {
      // Every level's name, measured in ITS OWN font — a phase row is bold and a
      // sub-task row is 12px, so one ruler would mis-size two of the three.
      let widest = 0;
      root.querySelectorAll<HTMLElement>('.pgd-nametxt').forEach((el) => {
        ctx.font = getComputedStyle(el).font || '13px sans-serif';
        widest = Math.max(widest, ctx.measureText(el.textContent ?? '').width);
      });
      // The row's own indent, the ✎ button beside the name, and the cell gap.
      px = Math.ceil(widest) + 56;
    } else {
      // Two 'YYYY-MM-DD' controls + the dash + the native picker's chrome.
      px = Math.ceil(ctx.measureText('0000-00-00').width * 2) + 64;
    }
    const clamped = Math.min(COL_MAX, Math.max(COL_MIN[c], px));
    setColW((prev) => (prev[c] === clamped ? prev : { ...prev, [c]: clamped }));
  }, []);

  // ── Column reorder (LINA-259 ask 6): the three middle headers drag-reorder;
  // the chosen order is mirrored into the body and the grid template, and kept
  // for the session. Anything unparseable falls back to the default order.
  const [colOrder, setColOrder] = useState<ColKey[]>(DEFAULT_COL_ORDER);
  const [dragCol, setDragCol] = useState<ColKey | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.sessionStorage.getItem(COLORDER_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length === DEFAULT_COL_ORDER.length
        && DEFAULT_COL_ORDER.every((c) => parsed.includes(c))) {
        setColOrder(parsed as ColKey[]);
      }
    } catch { /* ignore malformed session state — the default order stands */ }
  }, []);

  const moveCol = useCallback((from: ColKey, to: ColKey) => {
    setColOrder((prev) => {
      const arr = prev.filter((c) => c !== from);
      arr.splice(arr.indexOf(to), 0, from); // drop `from` in front of `to`
      if (typeof window !== 'undefined') {
        try { window.sessionStorage.setItem(COLORDER_KEY, JSON.stringify(arr)); } catch { /* quota / private mode */ }
      }
      return arr;
    });
  }, []);

  // The grid template, name pinned, the three middle columns in the chosen
  // order — set as a CSS var the header and every row read.
  const colsTemplate = `20px 34px minmax(120px, var(--pgdw-name, 1fr)) ${colOrder.map((c) => COL_TEMPLATE[c]).join(' ')} 92px`;

  // ── The table / Gantt split divider (LINA-259 ask 2): a draggable seam that
  // resizes the two panes, persisted for the session. Seeded from the rendered
  // table width on mount so the seam always has a home. ─────────────────────
  const [split, setSplit] = useState<number | null>(null);
  const gridWrapRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dividerDrag = useRef<null | { startX: number; startW: number }>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.sessionStorage.getItem(SPLIT_KEY);
      const n = raw != null ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(n)) { setSplit(n); return; }
    } catch { /* ignore */ }
    // No stored split → seed from the current table width so the divider sits
    // on the real seam rather than jumping when first grabbed.
    const t = tableRef.current;
    if (t) setSplit(Math.round(t.getBoundingClientRect().width));
  }, []);

  const clampSplit = useCallback((px: number) => {
    const w = gridWrapRef.current?.getBoundingClientRect().width ?? px + SPLIT_MIN_CANVAS;
    return Math.max(SPLIT_MIN_TABLE, Math.min(w - SPLIT_MIN_CANVAS, px));
  }, []);

  const onDividerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startW = split ?? tableRef.current?.getBoundingClientRect().width ?? SPLIT_MIN_TABLE;
    dividerDrag.current = { startX: e.clientX, startW };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [split]);
  const onDividerMove = useCallback((e: React.PointerEvent) => {
    const d = dividerDrag.current;
    if (!d) return;
    setSplit(clampSplit(Math.round(d.startW + e.clientX - d.startX)));
  }, [clampSplit]);
  const onDividerUp = useCallback((e: React.PointerEvent) => {
    if (!dividerDrag.current) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* released */ }
    dividerDrag.current = null;
    if (typeof window !== 'undefined' && split != null) {
      try { window.sessionStorage.setItem(SPLIT_KEY, String(split)); } catch { /* quota / private mode */ }
    }
  }, [split]);

  // ── Horizontal wheel pans the timeline (LINA-259 ask 3). A horizontal swipe
  // anywhere over the grid — even over the pinned table — scrolls only the
  // canvas; vertical wheel is left alone so the page still scrolls and a focused
  // date input still steps. Bound non-passive so preventDefault sticks. ──────
  useEffect(() => {
    const el = gridWrapRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      const sc = scrollRef.current;
      if (!sc) return;
      if (e.deltaX !== 0 && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        sc.scrollLeft += e.deltaX;
        e.preventDefault();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ── The row move-menu (LINA-259 ask 7): a small popover anchored to a row's
  // ⋯ button offering Promote / Demote, each enabled only when the pure op
  // would actually move the row (the same guards demoteNode/promoteNode keep).
  const [menu, setMenu] = useState<
    null | { pi: number; ti: number; si?: number; x: number; y: number; canPromote: boolean; canDemote: boolean }
  >(null);

  const openMenu = useCallback((e: React.MouseEvent, r: Extract<Row, { kind: 'task' }>) => {
    e.stopPropagation();
    const sub = r.si != null;
    const hasChildren = (r.node.children ?? []).length > 0;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      pi: r.pi, ti: r.ti, si: r.si,
      x: rect.right, y: rect.bottom + 2,
      canPromote: sub, // an L3 sub promotes to L2; an L2 task has no room above
      canDemote: !sub && r.ti > 0 && !hasChildren, // nest under the row above, never past depth 3
    });
  }, []);

  // ── Rename-in-place (ask 4): the ✎ button, and only it, opens the input. ──
  const [editing, setEditing] = useState<string | null>(null);

  // ── Grip drag-to-reorder — same scoping as the old list view. ─────────────
  const [dragPhase, setDragPhase] = useState<number | null>(null);
  const [dragTask, setDragTask] = useState<{ pi: number; ti: number } | null>(null);
  const [dragSub, setDragSub] = useState<{ pi: number; ti: number; si: number } | null>(null);

  // ── Bar drag (LINA-236/244, unchanged): origin captured at pointer-down. ──
  const drag = useRef<
    null | { pi: number; ti: number; si?: number; mode: DragMode; startX: number; start: string; end: string }
  >(null);

  const onBarDown = useCallback((
    e: React.PointerEvent, r: Extract<Row, { kind: 'task' }>, mode: DragMode,
  ) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      pi: r.pi, ti: r.ti, si: r.si, mode,
      startX: e.clientX, start: r.node.start, end: r.node.end,
    };
  }, [disabled]);

  const onBarMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const next = applyDrag(d.mode, d.start, d.end, e.clientX - d.startX, col);
    props.onDates(d.pi, d.ti, next.start, next.end, d.si);
  }, [props, col]);

  const onBarUp = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    drag.current = null;
  }, []);

  // A click on an UNDATED row's empty track plants a one-week bar on the
  // clicked day (ask 3). A dated row's empty track does nothing — rescheduling
  // an existing bar is a deliberate drag, never a stray click.
  const onTrackClick = useCallback((
    e: React.MouseEvent, w: GanttWindow, r: Extract<Row, { kind: 'task' }>,
  ) => {
    if (disabled || r.node.start || r.node.end) return;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const d = clickDates(w, x / col);
    props.onDates(r.pi, r.ti, d.start, d.end, r.si);
  }, [disabled, props, col]);

  // Row click opens the drawer — unless the click landed on a control.
  const onRowClick = useCallback((e: React.MouseEvent, r: Row) => {
    if (r.kind === 'add') return;
    if ((e.target as HTMLElement).closest('input, select, button, label, a')) return;
    props.onOpenRow(r.pi, r.kind === 'task' ? r.ti : undefined, r.kind === 'task' ? r.si : undefined);
  }, [props]);

  // Wide day columns tick weekly ("Mar 9"); compressed bases (quarter and up)
  // tick on month boundaries ("Mar", with the year on January) so the labels
  // never pile onto each other.
  const axis = win ? Array.from({ length: win.days }, (_, i) => {
    const iso = addDays(win.startDay, i);
    let tick: boolean;
    let label = '';
    if (col >= 20) {
      tick = weekday(iso) === 0 || i === 0;
      if (tick) label = dayLabel(iso);
    } else {
      const [y, m, d] = iso.split('-').map(Number);
      tick = d === 1 || i === 0;
      if (tick) label = m === 1 || i === 0 ? `${MONTHS[m - 1]} '${String(y).slice(2)}` : MONTHS[m - 1];
    }
    return { i, iso, tick, label };
  }) : [];
  const canvasWidth = win ? win.days * col : 0;
  const todayOffset = win === null ? null
    : (parseDay(todayIso) !== null && parseDay(win.startDay) !== null
      ? Math.round(((parseDay(todayIso) as number) - (parseDay(win.startDay) as number)) / 86_400_000)
      : null);

  const rowH = (r: Row) => (r.kind === 'phase' ? H.phase : r.kind === 'add' ? H.add : r.si != null ? H.sub : H.task);

  const name = useCallback((r: Row, id: string) => {
    const isPhase = r.kind === 'phase';
    const value = isPhase ? (r as Extract<Row, { kind: 'phase' }>).phase.name : (r as Extract<Row, { kind: 'task' }>).node.name;
    const key = r.kind === 'add' ? '' : r.key;
    if (editing === key) {
      return (
        <>
          <input
            className="pgd-nameinput"
            value={value}
            placeholder={isPhase ? 'Phase name' : 'Task name'}
            aria-label={`${isPhase ? 'Phase' : 'Task'} ${id} name`}
            autoFocus
            disabled={disabled}
            onChange={(e) => props.onRename(
              e.target.value, r.pi,
              r.kind === 'task' ? r.ti : undefined, r.kind === 'task' ? r.si : undefined,
            )}
            onBlur={() => setEditing(null)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditing(null); }}
          />
          {/* The visible "commit" affordance the founder asked for. The input's
              blur already commits, so this button only needs to exist — clicking
              it blurs the input and both paths end the same way. */}
          <button
            type="button"
            className="pbx-icon pgd-nameok"
            title="Confirm name"
            aria-label={`Confirm ${isPhase ? 'phase' : 'task'} ${id} name`}
            onClick={() => setEditing(null)}
          >✓</button>
        </>
      );
    }
    return (
      <>
        <span className="pgd-nametxt" title={value}>
          {value.trim() || <em className="pgd-untitled">{isPhase ? 'Untitled phase' : 'Untitled task'}</em>}
        </span>
        <button
          type="button"
          className="pbx-icon pgd-namedit"
          title={isPhase ? 'Rename phase' : 'Rename task'}
          aria-label={`Rename ${isPhase ? 'phase' : 'task'} ${id}`}
          disabled={disabled}
          onClick={() => setEditing(key)}
        >✎</button>
      </>
    );
  }, [editing, disabled, props]);

  // A parent row's child-status meter (LINA-259 ask 5). Only the segments that
  // have children are drawn, sized to their share; a fresh draft is all
  // not-started, honestly grey. A leaf (no children) draws nothing.
  const meter = useCallback((counts: StatusCounts, what: string) => {
    if (counts.total === 0) return null;
    const segs: Array<[string, number, string]> = [
      ['is-done', counts.done, 'done'],
      ['is-doing', counts.inProgress, 'in progress'],
      ['is-todo', counts.notStarted, 'not started'],
    ];
    const title = segs.map(([, n, w]) => `${n} ${w}`).join(' · ');
    return (
      <span
        className="pgd-meter"
        role="img"
        title={`${what}: ${title}`}
        aria-label={`${what}: ${counts.total} — ${title}`}
      >
        {segs.map(([cls, n]) => (n > 0
          ? <span key={cls} className={`pgd-meter-seg ${cls}`} style={{ flexGrow: n }} />
          : null))}
      </span>
    );
  }, []);

  const owner = useCallback((nodeKey: string, assigneePartyId: string | null, label: string) => {
    const p = partyOf(dir, assigneePartyId);
    return (
      <span className="pgd-owner" title={p ? `${p.name} · ${roleWord(p.role)}` : 'Unassigned — click to assign'}>
        {p ? <PartyAvatar party={p} size="sm" /> : <UnassignedAvatar size="sm" />}
        <select
          className="pgd-ownersel"
          value={assigneePartyId ?? ''}
          aria-label={`Owner of ${label}`}
          disabled={disabled || parties.length === 0}
          onChange={(e) => props.onAssign(nodeKey, e.target.value || null)}
        >
          <option value="">Unassigned</option>
          {parties.map((m) => (
            <option key={m.partyId} value={m.partyId}>{m.name} · {roleWord(m.role)}</option>
          ))}
          {assigneePartyId && !dir.has(assigneePartyId) ? (
            <option value={assigneePartyId}>{p?.name}</option>
          ) : null}
        </select>
      </span>
    );
  }, [dir, parties, disabled, props]);

  const resizer = (c: keyof typeof COL_MIN, what: string) => (
    <span
      className="pgd-hrs" role="separator" aria-label={`Resize the ${what} column`}
      title="Drag to resize · double-click to fit"
      onPointerDown={onResizeDown(c)} onPointerMove={onResizeMove}
      onPointerUp={onResizeUp} onPointerCancel={onResizeUp}
      onDoubleClick={() => autoFit(c)}
    />
  );

  // A draggable, droppable middle header cell (LINA-259 ask 6). The label span
  // is the drag handle; the whole cell is the drop target, so releasing anywhere
  // over "Specialty" moves the dragged column in front of it. The resizer keeps
  // its own pointer gesture and never starts a column drag.
  const headerCell = (c: ColKey) => {
    const dropProps = {
      onDragOver: (e: React.DragEvent) => { if (dragCol && dragCol !== c) e.preventDefault(); },
      onDrop: (e: React.DragEvent) => {
        if (!dragCol) return;
        e.preventDefault();
        if (dragCol !== c) moveCol(dragCol, c);
        setDragCol(null);
      },
    };
    const handle = (label: string) => (
      <span
        className={`pgd-hdrag${dragCol === c ? ' is-dragging' : ''}`}
        draggable={!disabled}
        title="Drag to reorder column"
        onDragStart={(e) => { setDragCol(c); e.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={() => setDragCol(null)}
      >{label}</span>
    );
    if (c === 'owner') {
      return <span key="owner" className="pgd-hdr-owner" {...dropProps}>{handle('Owner')}</span>;
    }
    return (
      <span key={c} className="pgd-hcell" {...dropProps}>
        {handle(c === 'trade' ? 'Specialty' : 'Dates')}
        {resizer(c, c === 'trade' ? 'specialty' : 'dates')}
      </span>
    );
  };

  const activeMenuRow = menu; // stable reference for the popover render below

  return (
    <div
      ref={rootRef}
      className="pgd"
      style={{
        '--pgd-cols': colsTemplate,
        '--pgdw-name': colW.name ? `${colW.name}px` : undefined,
        '--pgdw-trade': colW.trade ? `${colW.trade}px` : undefined,
        '--pgdw-dates': colW.dates ? `${colW.dates}px` : undefined,
      } as React.CSSProperties}
    >
      {/* ── The time-base toolbar: pick the reading scale, or type the exact
          window. View state only — it never touches the plan. ── */}
      <div className="pgd-toolbar">
        <label className="pgd-tb-lbl">
          Timeline
          <select
            className="pgd-tb-sel" value={base} aria-label="Timeline scale"
            onChange={(e) => onPickBase(e.target.value as TimeBase)}
          >
            {BASE_LABELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {base === 'custom' ? (
          <span className="pgd-tb-range">
            <input
              type="date" className="pgd-tb-date" value={customRange.from}
              aria-label="Timeline start"
              onChange={(e) => setCustomRange((p) => ({ ...p, from: e.target.value }))}
            />
            <span aria-hidden>–</span>
            <input
              type="date" className="pgd-tb-date" value={customRange.to}
              aria-label="Timeline end"
              onChange={(e) => setCustomRange((p) => ({ ...p, to: e.target.value }))}
            />
          </span>
        ) : null}
      </div>

      <div
        ref={gridWrapRef}
        className="pgd-grid"
        style={split != null ? { gridTemplateColumns: `${split}px 1fr` } : undefined}
      >
        {/* ── Left: the editable table. ── */}
        <div className="pgd-table" ref={tableRef}>
          <div className="pgd-hdr" style={{ height: AXIS_H }}>
            <span /><span aria-hidden>ID</span>
            <span className="pgd-hcell"><span aria-hidden>Task</span>{resizer('name', 'task name')}</span>
            {colOrder.map(headerCell)}
            <span />
          </div>

          {rows.map((r) => {
            if (r.kind === 'add') {
              return (
                <div key={`add-${r.pi}`} className="pgd-addrow" style={{ height: H.add }}>
                  <button type="button" className="pgd-add" disabled={disabled}
                    onClick={() => setEditing(props.onAddTask(r.pi))}>+ Add task</button>
                </div>
              );
            }

            if (r.kind === 'phase') {
              const id = `P${r.pi + 1}`;
              const counts = childStatusCounts(r.phase);
              const cellFor = (c: ColKey) => {
                if (c === 'trade') {
                  return (
                    <span key="trade" className="pgd-trade">
                      <input
                        className="pgd-tradeinput" value={r.phase.trade} placeholder="Specialty"
                        maxLength={120} aria-label={`Specialty for phase ${r.pi + 1}`}
                        disabled={disabled}
                        onChange={(e) => props.onTrade(r.key, e.target.value)}
                      />
                    </span>
                  );
                }
                if (c === 'owner') {
                  return <Fragment key="owner">{owner(r.key, r.phase.assigneePartyId, `phase ${r.pi + 1}`)}</Fragment>;
                }
                return <span key="dates" className="pgd-datecell" />;
              };
              return (
                <div
                  key={r.key}
                  className={`pgd-row pgd-row-phase${dragPhase === r.pi ? ' is-dragging' : ''}${litRows.has(r.key) ? ' is-cycle' : ''}`}
                  style={{ height: H.phase }}
                  onClick={(e) => onRowClick(e, r)}
                  onDragOver={(e) => { if (dragPhase !== null) e.preventDefault(); }}
                  onDrop={(e) => {
                    if (dragPhase === null) return;
                    e.preventDefault();
                    if (dragPhase !== r.pi) props.onReorderPhase(dragPhase, r.pi);
                    setDragPhase(null);
                  }}
                >
                  <span
                    className="pbx-grip" role="button" tabIndex={-1}
                    aria-label={`Drag to reorder phase ${r.pi + 1}`} title="Drag to reorder"
                    draggable={!disabled}
                    onDragStart={(e) => { setDragPhase(r.pi); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragEnd={() => setDragPhase(null)}
                  >⠿</span>
                  <span className="pgd-id">{id}</span>
                  <span className="pgd-name">
                    {name(r, id)}
                    {meter(counts, `Phase ${r.pi + 1}`)}
                  </span>
                  {colOrder.map(cellFor)}
                  <span className="pgd-ctl">
                    <button type="button" className="pbx-icon pbx-del" title="Remove phase"
                      disabled={disabled} onClick={() => props.onRemovePhase(r.pi)}>✕</button>
                  </span>
                </div>
              );
            }

            const sub = r.si != null;
            const id = sub ? `${r.pi + 1}.${r.ti + 1}.${(r.si as number) + 1}` : `${r.pi + 1}.${r.ti + 1}`;
            const what = sub ? 'sub-task' : 'task';
            const isTaskDrag = !sub && dragTask?.pi === r.pi;
            const isSubDrag = sub && dragSub?.pi === r.pi && dragSub.ti === r.ti;
            const counts = sub ? null : childStatusCounts(r.node);
            const cellFor = (c: ColKey) => {
              if (c === 'trade') {
                return (
                  <span key="trade" className="pgd-trade">
                    <input
                      className="pgd-tradeinput" value={r.node.trade} placeholder="Specialty"
                      maxLength={120} aria-label={`Specialty for ${what} ${id}`}
                      disabled={disabled}
                      onChange={(e) => props.onTrade(r.key, e.target.value)}
                    />
                  </span>
                );
              }
              if (c === 'owner') {
                return <Fragment key="owner">{owner(r.key, r.node.assigneePartyId, `${what} ${id}`)}</Fragment>;
              }
              // Start and finish share ONE column (founder follow-up): two inputs
              // around a dash, reading as "start – finish".
              return (
                <span key="dates" className="pgd-datecell pgd-dates">
                  <input
                    type="date" className="pgd-date" value={r.node.start}
                    aria-label={`${what} ${id} start date`} disabled={disabled}
                    onChange={(e) => props.onSetDate('start', e.target.value, r.pi, r.ti, r.si)}
                  />
                  <span className="pgd-datesep" aria-hidden>–</span>
                  <input
                    type="date" className="pgd-date" value={r.node.end}
                    aria-label={`${what} ${id} finish date`} disabled={disabled}
                    onChange={(e) => props.onSetDate('end', e.target.value, r.pi, r.ti, r.si)}
                  />
                </span>
              );
            };
            return (
              <div
                key={r.key}
                className={`pgd-row${sub ? ' pgd-row-sub' : ''}${litRows.has(r.key) ? ' is-cycle' : ''}${(isTaskDrag && dragTask?.ti === r.ti) || (isSubDrag && dragSub?.si === r.si) ? ' is-dragging' : ''}`}
                style={{ height: rowH(r) }}
                onClick={(e) => onRowClick(e, r)}
                onDragOver={(e) => { if (isTaskDrag || isSubDrag) e.preventDefault(); }}
                onDrop={(e) => {
                  if (isTaskDrag) {
                    e.preventDefault();
                    if (dragTask && dragTask.ti !== r.ti) props.onReorderTask(r.pi, dragTask.ti, r.ti);
                    setDragTask(null);
                  } else if (isSubDrag) {
                    e.preventDefault();
                    if (dragSub && dragSub.si !== r.si) props.onReorderSubtask(r.pi, r.ti, dragSub.si, r.si as number);
                    setDragSub(null);
                  }
                }}
              >
                <span
                  className="pbx-grip" role="button" tabIndex={-1}
                  aria-label={`Drag to reorder ${what}`} title="Drag to reorder"
                  draggable={!disabled}
                  onDragStart={(e) => {
                    if (sub) setDragSub({ pi: r.pi, ti: r.ti, si: r.si as number });
                    else setDragTask({ pi: r.pi, ti: r.ti });
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => { setDragTask(null); setDragSub(null); }}
                >⠿</span>
                <span className="pgd-id">{id}</span>
                <span className="pgd-name">
                  {name(r, id)}
                  {counts ? meter(counts, `Task ${id}`) : null}
                  {r.node.description.trim() ? <span className="pgt-lbl-dot" aria-hidden /> : null}
                </span>
                {colOrder.map(cellFor)}
                <span className="pgd-ctl">
                  {!sub ? (
                    <button type="button" className="pbx-icon" title="Add sub-task"
                      aria-label={`Add a sub-task under ${what} ${id}`} disabled={disabled}
                      onClick={() => setEditing(props.onAddSubtask(r.pi, r.ti))}>＋</button>
                  ) : null}
                  <button type="button" className="pbx-icon" title="Move in outline (promote / demote)"
                    aria-label={`Move ${what} ${id} in the outline`} aria-haspopup="menu"
                    disabled={disabled}
                    onClick={(e) => openMenu(e, r)}>⋯</button>
                  <button type="button" className="pbx-icon pbx-del" title={`Remove ${what}`}
                    disabled={disabled}
                    onClick={() => (sub
                      ? props.onRemoveSubtask(r.pi, r.ti, r.si as number)
                      : props.onRemoveTask(r.pi, r.ti))}>✕</button>
                </span>
              </div>
            );
          })}

          <div className="pgd-addrow" style={{ height: H.add }}>
            <button type="button" className="pgd-add" disabled={disabled}
              onClick={() => setEditing(props.onAddPhase())}>
              + Add phase
            </button>
          </div>
        </div>

        {/* The draggable seam between the table and the timeline (ask 2). */}
        {split != null ? (
          <div
            className="pgd-divider" role="separator" aria-orientation="vertical"
            aria-label="Drag to resize the table and timeline"
            title="Drag to resize"
            style={{ left: split }}
            onPointerDown={onDividerDown} onPointerMove={onDividerMove}
            onPointerUp={onDividerUp} onPointerCancel={onDividerUp}
          />
        ) : null}

        {/* ── Right: the always-visible timeline canvas. ── */}
        <div className="pgt-scroll" ref={scrollRef}>
          {win ? (
            <div className="pgt-canvas" style={{ width: canvasWidth }}>
              <div className="pgt-axis" style={{ height: AXIS_H }}>
                {axis.map((c) => (
                  <div key={c.i} className={`pgt-axis-cell${c.tick ? ' is-tick' : ''}`}
                    style={{ left: c.i * col, width: col }}>
                    {c.label ? <span className="pgt-axis-lbl">{c.label}</span> : null}
                  </div>
                ))}
              </div>

              {rows.map((r) => {
                if (r.kind === 'add') {
                  return <div key={`ta-${r.pi}`} className="pgd-track-add" style={{ height: H.add }} />;
                }
                if (r.kind === 'phase') {
                  const env = phaseEnvelope(r.phase);
                  const bar = env ? clipBarGeom(win, env.start, env.end) : null;
                  return (
                    <div key={`tp-${r.pi}`} className="pgt-band" style={{ height: H.phase }}>
                      {bar ? (
                        <div className="pgd-envbar" aria-hidden
                          style={{ left: bar.offsetDays * col + 1, width: Math.max(2, bar.spanDays * col - 2) }} />
                      ) : null}
                    </div>
                  );
                }
                const bar = clipBarGeom(win, r.node.start, r.node.end);
                const undated = !r.node.start && !r.node.end;
                return (
                  <div
                    key={`tt-${r.key}`}
                    className={`pgt-track${r.si != null ? ' is-sub' : ''}${undated && !disabled ? ' is-clickable' : ''}`}
                    style={{ height: rowH(r) }}
                    title={undated ? 'Click a day to schedule this — the bar starts there and runs one week; drag it after' : undefined}
                    onClick={(e) => onTrackClick(e, win, r)}
                  >
                    {axis.map((c) =>
                      c.tick ? <div key={c.i} className="pgt-gridline" style={{ left: c.i * col }} /> : null)}
                    {todayOffset !== null && todayOffset >= 0 && todayOffset < win.days ? (
                      <div className="pgd-today" style={{ left: todayOffset * col }} aria-hidden />
                    ) : null}
                    {bar ? (
                      <div
                        className={`pgt-bar${r.si != null ? ' is-sub' : ''}${bar.open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}
                        style={{ left: bar.offsetDays * col + 1, width: Math.max(2, bar.spanDays * col - 2) }}
                        role="button" tabIndex={-1}
                        aria-label={
                          `${r.node.name.trim() || (r.si != null ? 'Sub-task' : 'Task')}: `
                          + `${r.node.start || 'no start'} → ${r.node.end || 'no finish'}. `
                          + 'Drag to move; drag an edge to change start or finish.'
                        }
                        title="Drag to move — drag an edge to change start or finish"
                        onPointerDown={(e) => onBarDown(e, r, 'move')}
                        onPointerMove={onBarMove}
                        onPointerUp={onBarUp}
                        onPointerCancel={onBarUp}
                      >
                        {/* A clipped edge is the WINDOW's edge, not the task's —
                            no resize handle there (the body still drags). */}
                        {!bar.open && !bar.clipStart && r.node.start ? (
                          <span className="pgt-handle pgt-handle-l" aria-hidden
                            onPointerDown={(e) => onBarDown(e, r, 'resize-start')}
                            onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp} />
                        ) : null}
                        <span className="pgt-bar-lbl">{r.node.name.trim() || 'Untitled'}</span>
                        {!bar.open && !bar.clipEnd && r.node.end ? (
                          <span className="pgt-handle pgt-handle-r" aria-hidden
                            onPointerDown={(e) => onBarDown(e, r, 'resize-end')}
                            onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp} />
                        ) : null}
                      </div>
                    ) : null}
                    {/* The hover tooltip, a sibling right after the bar so a pure
                        CSS `:hover +` reveal keeps it out of the drag path (ask 1). */}
                    {bar ? (
                      <span
                        className="pgt-tip" aria-hidden
                        style={{ left: bar.offsetDays * col + Math.max(2, bar.spanDays * col - 2) + 6 }}
                      >{barTip(r.node.start, r.node.end)}</span>
                    ) : null}
                  </div>
                );
              })}
              <div className="pgd-track-add" style={{ height: H.add }} />
            </div>
          ) : null}
        </div>
      </div>

      {/* The row move-menu popover (ask 7). Click-away closes; each item is a
          no-op path when the reparent is disallowed, so the guard is visible. */}
      {activeMenuRow ? (
        <>
          <div className="pgd-menu-away" role="presentation" onClick={() => setMenu(null)} />
          <div
            className="pgd-menu" role="menu" aria-label="Move in outline"
            style={{ left: activeMenuRow.x, top: activeMenuRow.y }}
            onKeyDown={(e) => { if (e.key === 'Escape') setMenu(null); }}
          >
            <button
              type="button" role="menuitem" className="pgd-menu-item"
              disabled={disabled || !activeMenuRow.canPromote}
              onClick={() => { props.onPromote(activeMenuRow.pi, activeMenuRow.ti, activeMenuRow.si); setMenu(null); }}
            >⇤ Promote (outdent)</button>
            <button
              type="button" role="menuitem" className="pgd-menu-item"
              disabled={disabled || !activeMenuRow.canDemote}
              onClick={() => { props.onDemote(activeMenuRow.pi, activeMenuRow.ti, activeMenuRow.si); setMenu(null); }}
            >⇥ Demote (indent)</button>
          </div>
        </>
      ) : null}
    </div>
  );
}
