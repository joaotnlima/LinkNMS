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
// LINA-253 adds the DEPENDENCY ARROWS (ADR-0020 §6): the typed links the drawer
// authors are drawn as elbow connectors in an SVG overlay above the bars,
// anchored on the ends each type actually constrains. The geometry is pure
// (@/lib/plan-gantt connectorPath) and recomputed from the same bar boxes the
// bars render at, so the arrows track live through a drag with no state of
// their own. Still no wire or draft-shape change here — this component owns
// none of the plan.
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
  addDays, applyDrag, barRect, baseWindow, clickDates, clipBarGeom, connectorMidpoint, connectorPath,
  formatDay, parseDay,
  type ConnectorEnd, type DragMode, type GanttWindow, type TimeBase,
} from '@/lib/plan-gantt';
import {
  DEP_LABELS, childStatusCounts, nodeIndex, nodeStatus, planLinks,
  type DepType, type PhaseDraft, type StageStatus, type StatusCounts, type TaskDraft,
} from '@/lib/plan-authoring';
import { PartyAvatar, UnassignedAvatar } from '@/components/PartyAvatar';
import { PendingChangeChip } from '@/components/SignOffPanel';
import { partyIndex, partyOf, roleWord, type PartyRef } from '@/lib/party-display';

// Pixels per day column, per time base (LINA-248 follow-up): the base the
// author picks is a READING scale, so a week spreads its 7 days wide while a
// year compresses to a page-ish sweep. 'custom' is sized after the window is
// known (fit ~1120px, clamped so a day is never ungrabbable-thin).
const BASE_PX: Record<Exclude<TimeBase, 'custom'>, number> = {
  auto: 30, week: 64, month: 30, quarter: 12, half: 6, year: 3,
};
/**
 * The floating timeline nav (LINA-306, pen "Timeline nav"): a compact segmented
 * pill pinned bottom-right of the canvas. It exposes the reading scales the pen
 * shows — Fit / Weeks / Months / Quarters — with a "Today" jump beside them. The
 * old full timeline <select> (6 months / year / custom range) is retired from
 * the chrome; those bases stay in the type but the nav keeps to the pen's four.
 */
const NAV_BASES: Array<[Exclude<TimeBase, 'custom' | 'half' | 'year'>, string]> = [
  ['auto', 'Fit'], ['week', 'Weeks'], ['month', 'Months'], ['quarter', 'Quarters'],
];

/**
 * The status palette (LINA-306, pen "Status legend"): every derived StageStatus
 * → its swatch class and its word. ONE source of truth shared by the STATUS
 * column's leaf pills, the parent meter's segments, the filter's status select
 * and the legend, so a colour can never drift between them. The classes resolve
 * to tokens in plan-build.css (done → --success, in progress → --plan-baseline,
 * blocked → --state-danger, not started → the muted grey).
 */
const STATUS_META: Record<StageStatus, { cls: string; label: string }> = {
  done: { cls: 'is-done', label: 'Done' },
  in_progress: { cls: 'is-doing', label: 'In progress' },
  blocked: { cls: 'is-blocked', label: 'Blocked' },
  not_started: { cls: 'is-todo', label: 'Not started' },
};
/** Legend / status-select order: closed → active → stuck → not begun. */
const STATUS_ORDER: StageStatus[] = ['not_started', 'in_progress', 'blocked', 'done'];
/** Row heights, shared by the table cell and its track so the panes align.
 *  Compact rows with thin bars (founder, LINA-306): a task row is 34px, a
 *  sub-task row 28px — tighter than before so more of the plan reads at once. */
const H = { phase: 34, task: 34, sub: 28, add: 32 } as const;
const AXIS_H = 28;
/**
 * Each bar's vertical middle WITHIN its track, in px — where a dependency
 * connector attaches (LINA-253). These mirror plan-build.css EXACTLY (change one
 * and the other, or the arrows detach): a task bar is `top: 9px; height: 16px`,
 * a sub-task bar `top: 8px; height: 12px`, a phase envelope `top: 14px;
 * height: 6px`. Kept here rather than measured because the whole point of the
 * pure geometry is that it needs no layout pass to be right.
 */
const BAR_MID = { phase: 17, task: 17, sub: 14 } as const;
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
 * 'YYYY-MM-DD' → "25 Sep 2026" — the founder's bar-edge date format (LINA-306),
 * spelled out with the year so a bar reads its own window without the axis. Pure
 * string split, no Date, so no timezone drift.
 */
function dayLabelFull(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
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
  /**
   * Stage keys with a change order in flight against them (LINA-282, ADR-0023
   * §6). Their rows and bars take the clay/amber `--status-pending-change`
   * treatment PLUS a "Change pending" chip — the locked grid is already
   * `aria-disabled`, so colour on its own would be the only signal.
   * Optional and empty by default: an unlocked plan has no such rows.
   */
  pendingChangeKeys?: Set<string>;
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
  /**
   * Author a dependency by dragging one bar's edge onto another's (LINA-306).
   * `fromKey` is the DEPENDENT (it carries the link); `toKey` the predecessor.
   * The caller resolves type AND direction from the edges joined (depFromEdges),
   * so a finish-to-start link can be drawn either way — end→start (drag a task's
   * finish onto the next task's start) as well as start→end.
   */
  onLinkDep: (fromKey: string, toKey: string, type: DepType) => void;
  /**
   * Clear ONE dependency (LINA-306) — the unlink control sitting in the middle
   * of the Gantt arrow. `fromKey` is the DEPENDENT (the stage that carries the
   * link), `toKey` its predecessor, mirroring onLinkDep's direction.
   */
  onUnlinkDep: (fromKey: string, toKey: string) => void;
}

/** Module-level so the default never changes identity between renders. */
const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

/** How near (px) a link drag must come to a bar edge to snap onto it. */
const LINK_SNAP = 14;

/**
 * The dependency a link drag declares, from the two edges it joined (LINA-306).
 * The gesture is SYMMETRIC — the author may draw a finish-to-start link either
 * way round, and the direction (which side carries the link) is resolved from
 * the edges, not from which bar the drag happened to start on:
 *   • start → end   — this starts once that one finishes   (starts_after; dep = source)
 *   • end   → start — that finishes, then this one starts   (starts_after; dep = target)
 *   • start → start — both start together                  (starts_with)
 *   • end   → end   — both finish together                 (ends_with)
 * The `end → start` case is the founder's ask: drag a task's END onto the next
 * task's START to say "this one, then that one". `from` is the edge the drag left
 * (on `fromKey`); `to` the edge it landed on (on `toKey`). Every edge pairing now
 * names a link, so a drop on any bar edge lands. Returns the DEPENDENT (carries
 * the `dependsOn`) and its PREDECESSOR, in onLinkDep's argument order.
 */
function depFromEdges(
  fromKey: string, from: 'start' | 'end', toKey: string, to: 'start' | 'end',
): { dependent: string; predecessor: string; type: DepType } | null {
  if (from === 'start' && to === 'end') return { dependent: fromKey, predecessor: toKey, type: 'starts_after' };
  if (from === 'end' && to === 'start') return { dependent: toKey, predecessor: fromKey, type: 'starts_after' };
  if (from === 'start' && to === 'start') return { dependent: fromKey, predecessor: toKey, type: 'starts_with' };
  if (from === 'end' && to === 'end') return { dependent: fromKey, predecessor: toKey, type: 'ends_with' };
  return null;
}

/** A live link-drag: the source edge it left, and the target edge it is over. */
type LinkDrag = {
  fromKey: string;
  fromEdge: 'start' | 'end';
  x0: number; y0: number;   // the source edge anchor, in canvas px
  x: number; y: number;     // the pointer, in canvas px
  target: { key: string; edge: 'start' | 'end' } | null;
};

/** The chain-link glyph on the dependency handles (LINA-306). Replaces the old
 *  ＋, which read as "add a task" rather than "link to another task". Feather's
 *  two-arc link mark; inherits the button's colour via currentColor. */
function LinkGlyph() {
  return (
    <svg
      viewBox="0 0 24 24" width="12" height="12" fill="none"
      stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden focusable="false"
    >
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}

export function PlanGrid(props: PlanGridProps) {
  const { phases, parties, litRows, disabled, todayIso } = props;
  const pendingChange = props.pendingChangeKeys ?? EMPTY_KEYS;
  const dir = useMemo(() => partyIndex(parties), [parties]);

  // ── Specialty catalog (LINA-306 item 6) ────────────────────────────────────
  // The "Specialty" chip stays a free-form label, but it is now backed by a
  // picker: a datalist of the caller's known trades — the seeded system set ∪ any
  // they have typed before, across every project (GET /api/v1/specialties).
  // Typing a brand-new label and committing it (blur) remembers it (POST) so it
  // is offered next time and on their other builds. Progressive enhancement: the
  // input behaves exactly as before while the list loads or if the fetch fails —
  // the picker only ADDS suggestions, it never gates what can be typed, and the
  // chosen string is still what lands on the stage (no plan-contract change).
  const [specialties, setSpecialties] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    fetch('/api/v1/specialties', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { specialties?: Array<{ label: string }> } | null) => {
        if (live && d?.specialties) setSpecialties(d.specialties.map((s) => s.label));
      })
      .catch(() => { /* picker is enhancement-only; the free-form input stands */ });
    return () => { live = false; };
  }, []);

  // Commit of a typed specialty: if it is non-empty and not already known
  // (case-insensitively), remember it. Fire-and-forget — the create is idempotent
  // server-side, and a failure just means it is not offered later, never that the
  // typed label is lost (onTrade already stored it on the stage).
  const rememberSpecialty = useCallback((raw: string) => {
    const label = raw.trim();
    if (!label) return;
    setSpecialties((prev) => {
      if (prev.some((s) => s.toLowerCase() === label.toLowerCase())) return prev;
      return [...prev, label].sort((a, b) => a.localeCompare(b));
    });
    fetch('/api/v1/specialties', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
    }).catch(() => { /* enhancement-only */ });
  }, []);

  // ── Accordion fold, phases AND tasks (LINA-306) ────────────────────────────
  // Any row that HAS children folds: a phase folds its tasks (and the "+ Add
  // task" row); a task that has grown a 3rd-level sub-task becomes an accordion
  // too — the founder's ask, "the new 3rd level child should trigger the 2nd
  // level to become also an accordion". A folded row keeps its own row AND its
  // timeline bar (a phase its derived envelope, a task its own bar), so folding
  // hides the children without hiding the parent's schedule. Session-view state
  // only; it never touches the draft. One `collapsed` set keyed by node key
  // serves both levels, and filtering the row list here keeps the table and the
  // canvas aligned for free — both panes map the same `rows`.
  // First-preview default (founder, LINA-306): only the 1st and 2nd levels are
  // "opened" — phases (L1) show their tasks (L2), but every task that has grown
  // 3rd-level sub-tasks starts FOLDED, so a plan opens as a readable one- or
  // two-level outline rather than every leaf at once. Phases are never seeded
  // here, so they stay open; the author expands a task to see its sub-tasks.
  // Lazy init: it seeds the initial view once, and every later fold/expand is
  // the author's own (adding a sub-task auto-expands its parent via `expand`).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    const seed = new Set<string>();
    phases.forEach((p) => p.tasks.forEach((t) => {
      if ((t.children ?? []).length > 0) seed.add(t.key);
    }));
    return seed;
  });
  const toggleFold = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  // Adding a sub-task must reveal it: a task the author had folded expands so the
  // new child is not hidden the instant it is created.
  const expand = useCallback((key: string) => {
    setCollapsed((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  // ── Filters (LINA-306, pen "Filter bar") ───────────────────────────────────
  // Owner, status, overdue and blocked narrow the visible rows; a search box
  // narrows by name/ID. All presentational — they hide rows, never touch the
  // draft. A stage is OVERDUE when its finish is before today and it is not done
  // (meaningful only on a hydrated live plan; a fresh draft has no dates past due
  // and no reported status, so these filters honestly show nothing there).
  const [search, setSearch] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');            // '' = any owner
  const [statusFilter, setStatusFilter] = useState<'' | StageStatus>('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [blockedOnly, setBlockedOnly] = useState(false);
  const filterActive = !!(search.trim() || ownerFilter || statusFilter || overdueOnly || blockedOnly);
  const clearFilters = useCallback(() => {
    setSearch(''); setOwnerFilter(''); setStatusFilter(''); setOverdueOnly(false); setBlockedOnly(false);
  }, []);

  const isOverdue = useCallback((n: TaskDraft): boolean => {
    if (!n.end) return false;
    const e = parseDay(n.end);
    const t = parseDay(todayIso);
    return e !== null && t !== null && e < t && nodeStatus(n) !== 'done';
  }, [todayIso]);

  // Does one stage clear every ACTIVE filter? (An inactive filter never rejects.)
  const nodePasses = useCallback((n: TaskDraft, id: string): boolean => {
    const q = search.trim().toLowerCase();
    if (q && !`${id} ${n.name}`.toLowerCase().includes(q)) return false;
    if (ownerFilter && n.assigneePartyId !== ownerFilter) return false;
    if (statusFilter && nodeStatus(n) !== statusFilter) return false;
    if (overdueOnly && !isOverdue(n)) return false;
    if (blockedOnly && nodeStatus(n) !== 'blocked') return false;
    return true;
  }, [search, ownerFilter, statusFilter, overdueOnly, blockedOnly, isOverdue]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    phases.forEach((p, pi) => {
      // Gather the phase's visible tasks first, so a phase with no surviving task
      // drops out entirely under a filter (its own row would be an empty header).
      type Vis = { t: TaskDraft; ti: number; subs: Array<{ s: TaskDraft; si: number }> };
      const visTasks: Vis[] = [];
      p.tasks.forEach((t, ti) => {
        const tid = `${pi + 1}.${ti + 1}`;
        const subs = (t.children ?? []).map((s, si) => ({ s, si }))
          .filter(({ s, si }) => !filterActive || nodePasses(s, `${tid}.${si + 1}`));
        const selfPass = !filterActive || nodePasses(t, tid);
        // Keep the task if it matches OR carries a matching sub-task (as context).
        if (selfPass || subs.length > 0) visTasks.push({ t, ti, subs });
      });
      if (filterActive && visTasks.length === 0) return; // whole phase filtered out

      out.push({ kind: 'phase', pi, key: p.key, phase: p });
      // Folding is a reading preference; a live filter overrides it so every match
      // is shown, then folding returns when the filters clear.
      if (!filterActive && collapsed.has(p.key)) return;
      visTasks.forEach(({ t, ti, subs }) => {
        out.push({ kind: 'task', pi, ti, key: t.key, node: t });
        if (filterActive) {
          subs.forEach(({ s, si }) => out.push({ kind: 'task', pi, ti, si, key: s.key, node: s }));
        } else if (!collapsed.has(t.key)) {
          (t.children ?? []).forEach((s, si) =>
            out.push({ kind: 'task', pi, ti, si, key: s.key, node: s }));
        }
      });
      if (!filterActive) out.push({ kind: 'add', pi }); // no "+ add" while filtering
    });
    return out;
  }, [phases, collapsed, filterActive, nodePasses]);

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

  // The grid template, name pinned, then the fixed STATUS column (LINA-306),
  // then the three middle columns in the chosen order — one CSS var the header
  // and every row read. STATUS sits right after the name, as the pen lays it out.
  const colsTemplate = `20px 34px minmax(120px, var(--pgdw-name, 1fr)) 120px ${colOrder.map((c) => COL_TEMPLATE[c]).join(' ')} 92px`;

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

  // ── Grab-and-drag panning (LINA-306, founder): grab the timeline and drag it
  // left/right to travel through time — the ask that a switch to Weeks/Quarters
  // pushes the bars off-screen and there was no way to reach them but the thin
  // scrollbar. Pointer-down anywhere on the canvas that ISN'T an interactive mark
  // (a bar, a resize/link handle, or an undated track waiting for a plant-click)
  // starts a pan; those keep their own gestures untouched. A pan that actually
  // moved swallows the trailing click so it never plants a date or selects a row.
  // Native + non-passive so preventDefault sticks and the drag never text-selects.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return undefined;
    const INTERACTIVE = '.pgt-bar, .pgt-handle, .pgt-linksrc, .pgt-linktgt, .pgt-track.is-clickable';
    let startX = 0;
    let startLeft = 0;
    let pointerId = -1;
    let panning = false;
    let moved = false;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const t = e.target as Element | null;
      if (t && t.closest && t.closest(INTERACTIVE)) return; // leave marks their gestures
      panning = true;
      moved = false;
      startX = e.clientX;
      startLeft = sc.scrollLeft;
      pointerId = e.pointerId;
      try { sc.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
      sc.classList.add('is-panning');
    };
    const onMove = (e: PointerEvent) => {
      if (!panning) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      sc.scrollLeft = startLeft - dx;
      e.preventDefault();
    };
    const onUp = () => {
      if (!panning) return;
      panning = false;
      try { sc.releasePointerCapture(pointerId); } catch { /* already released */ }
      sc.classList.remove('is-panning');
      if (moved) {
        // A real drag ends on a click the browser still fires — swallow that one
        // so a pan across an empty track never plants a date or opens a row.
        const swallow = (ev: Event) => {
          ev.stopPropagation();
          ev.preventDefault();
          sc.removeEventListener('click', swallow, true);
        };
        sc.addEventListener('click', swallow, true);
        window.setTimeout(() => sc.removeEventListener('click', swallow, true), 0);
      }
    };
    sc.addEventListener('pointerdown', onDown);
    sc.addEventListener('pointermove', onMove);
    sc.addEventListener('pointerup', onUp);
    sc.addEventListener('pointercancel', onUp);
    return () => {
      sc.removeEventListener('pointerdown', onDown);
      sc.removeEventListener('pointermove', onMove);
      sc.removeEventListener('pointerup', onUp);
      sc.removeEventListener('pointercancel', onUp);
    };
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

  // ── Draw-a-dependency on the Gantt (LINA-306) ──────────────────────────────
  // The author drags the ＋ handle off one bar's edge onto another bar's edge;
  // the pair of edges names the type AND direction (depFromEdges). All geometry is in
  // canvas px — the same space the bars and connectors live in — so a preview
  // line and the snap ring line up with the bars with no second coordinate
  // system. `linkTargets` is every DATED bar's edge band, rebuilt from the same
  // clip geometry the bars render with, so a drop can only land on a real edge.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [linking, setLinking] = useState<LinkDrag | null>(null);
  const linkingRef = useRef<LinkDrag | null>(null);

  const linkTargets = useMemo(() => {
    const out: Array<{ key: string; xL: number; xR: number; yTop: number; yBot: number }> = [];
    if (!win) return out;
    let top = AXIS_H;
    for (const r of rows) {
      const h = rowH(r);
      let box: { x: number; width: number } | null = null;
      if (r.kind === 'phase') {
        const env = phaseEnvelope(r.phase);
        const bar = env ? clipBarGeom(win, env.start, env.end) : null;
        box = bar ? barRect(bar.offsetDays, bar.spanDays, col) : null;
      } else if (r.kind === 'task') {
        const bar = clipBarGeom(win, r.node.start, r.node.end);
        box = bar ? barRect(bar.offsetDays, bar.spanDays, col) : null;
      }
      if (box && r.kind !== 'add') {
        out.push({ key: r.key, xL: box.x, xR: box.x + box.width, yTop: top, yBot: top + h });
      }
      top += h;
    }
    return out;
  }, [rows, win, col]);
  // Read by the pointer handlers, which must see the LATEST targets (a stale
  // closure would hit-test against the geometry as it was at pointer-down).
  const linkTargetsRef = useRef(linkTargets);
  linkTargetsRef.current = linkTargets;

  const toCanvas = useCallback((e: React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 };
  }, []);

  const onLinkDown = useCallback((
    e: React.PointerEvent, key: string, edge: 'start' | 'end',
  ) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // never let this start a bar move
    const src = linkTargetsRef.current.find((t) => t.key === key);
    if (!src) return;
    const x0 = edge === 'start' ? src.xL : src.xR;
    const y0 = (src.yTop + src.yBot) / 2;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const start: LinkDrag = { fromKey: key, fromEdge: edge, x0, y0, x: x0, y: y0, target: null };
    linkingRef.current = start;
    setLinking(start);
  }, [disabled]);

  const onLinkMove = useCallback((e: React.PointerEvent) => {
    const d = linkingRef.current;
    if (!d) return;
    const { x, y } = toCanvas(e);
    let target: { key: string; edge: 'start' | 'end' } | null = null;
    let best = LINK_SNAP;
    for (const t of linkTargetsRef.current) {
      if (t.key === d.fromKey) continue;            // never link a bar to itself
      if (y < t.yTop - 4 || y > t.yBot + 4) continue; // must be over that row's band
      const dl = Math.abs(x - t.xL);
      const dr = Math.abs(x - t.xR);
      // Every edge pairing now names a link (depFromEdges), so both edges are
      // reachable from either source; the nearer edge simply wins.
      if (dl <= best) { best = dl; target = { key: t.key, edge: 'start' }; }
      if (dr <= best) { best = dr; target = { key: t.key, edge: 'end' }; }
    }
    const next = { ...d, x, y, target };
    linkingRef.current = next;
    setLinking(next);
  }, [toCanvas]);

  const onLinkUp = useCallback((e: React.PointerEvent) => {
    const d = linkingRef.current;
    linkingRef.current = null;
    setLinking(null);
    if (!d) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (!d.target) return;
    const link = depFromEdges(d.fromKey, d.fromEdge, d.target.key, d.target.edge);
    if (!link) return;
    props.onLinkDep(link.dependent, link.predecessor, link.type);
  }, [props]);

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

  // A function declaration, NOT a `const` arrow: it is called from `linkTargets`
  // (LINA-306) whose useMemo factory runs DURING render, ABOVE this line — a
  // `const` there would be in its temporal dead zone and throw "Cannot access
  // 'rowH' before initialization" (the LINA-306 dev crash). Declarations hoist to
  // the top of the component scope, so every caller — early or late — sees it.
  function rowH(r: Row) {
    return r.kind === 'phase' ? H.phase : r.kind === 'add' ? H.add : r.si != null ? H.sub : H.task;
  }

  // ── Dependency connectors (ADR-0020 §6, LINA-253) ──────────────────────────
  // Every typed link the author declared, drawn as an elbow arrow between the
  // two bars it constrains. Two passes, both cheap and both pure:
  //   1. ANCHORS — walk the rows once, accumulating each track's top, and record
  //      the bar box of every DATED stage. The box comes from barRect, the same
  //      helper the bar itself renders with, so an arrow can never land beside
  //      the bar it names. A phase anchors on its derived envelope bar.
  //   2. LINKS — turn each link whose BOTH ends have a box into a path. A link
  //      touching an undated stage is simply not drawn (ADR-0020 §6): there is
  //      no bar to point at, and inventing one would assert a date nobody set.
  //
  // Both memos depend on `phases` through `rows`, so a drag — which writes the
  // dragged row's dates on every pointermove — recomputes the connectors from
  // the very same geometry the bars move with. The arrows track live for free.
  const anchors = useMemo(() => {
    const m = new Map<string, ConnectorEnd>();
    if (!win) return m;
    let top = AXIS_H;
    for (const r of rows) {
      const h = rowH(r);
      if (r.kind === 'phase') {
        const env = phaseEnvelope(r.phase);
        const bar = env ? clipBarGeom(win, env.start, env.end) : null;
        if (bar) m.set(r.key, { ...barRect(bar.offsetDays, bar.spanDays, col), y: top + BAR_MID.phase });
      } else if (r.kind === 'task') {
        const bar = clipBarGeom(win, r.node.start, r.node.end);
        const mid = r.si != null ? BAR_MID.sub : BAR_MID.task;
        if (bar) m.set(r.key, { ...barRect(bar.offsetDays, bar.spanDays, col), y: top + mid });
      }
      top += h;
    }
    return m;
  }, [rows, win, col]);

  // The labels the arrows answer to: a connector is thin and muted by design, so
  // its meaning lives in the title a hover/AT reveals, not in its shape.
  const labels = useMemo(() => nodeIndex(phases), [phases]);

  const connectors = useMemo(() => planLinks(phases).flatMap((l) => {
    const from = anchors.get(l.from);
    const to = anchors.get(l.to);
    if (!from || !to) return [];
    const geom = connectorPath(to, from, l.type); // predecessor → dependent
    const mid = connectorMidpoint(geom.points); // where the unlink control sits
    return [{
      id: `${l.to}->${l.from}`,
      // The link's endpoints, in onLinkDep's direction: `from` is the DEPENDENT
      // (carries the link), `to` the predecessor — what onUnlinkDep clears.
      from: l.from,
      to: l.to,
      d: geom.d,
      mx: mid.x,
      my: mid.y,
      title: `${labels.get(l.from)?.label ?? 'This stage'} ${DEP_LABELS[l.type].toLowerCase()} ${labels.get(l.to)?.label ?? 'another stage'}`,
    }];
  }), [phases, anchors, labels]);

  const canvasHeight = AXIS_H + rows.reduce((h, r) => h + rowH(r), 0) + H.add;

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
      ['is-blocked', counts.blocked, 'blocked'],
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

  // The STATUS column cell (LINA-306, pen STATUS column). A PARENT row (a phase,
  // or a task with sub-tasks) shows the segmented child meter plus its count; a
  // LEAF row shows a single bar of ITS OWN derived status, tinted red-outlined
  // when overdue. `counts` is the parent's child counts (null on a leaf); `node`
  // is the leaf's own node (null on a phase, whose status is only its children's).
  const statusCell = useCallback((counts: StatusCounts | null, node: TaskDraft | null, what: string) => {
    if (counts && counts.total > 0) {
      return (
        <span className="pgd-statuscell">
          {meter(counts, what)}
          <span className="pgd-statuscount" aria-hidden>{counts.total}</span>
        </span>
      );
    }
    if (!node) return null; // a childless phase: nothing to colour
    const s = nodeStatus(node);
    const over = isOverdue(node);
    const meta = STATUS_META[s];
    const word = over ? `${meta.label} · overdue` : meta.label;
    return (
      <span
        className={`pgd-statusbar${over ? ' is-overdue' : ''}`}
        role="img" title={`${what}: ${word}`} aria-label={`${what}: ${word}`}
      >
        <span className={`pgd-statusbar-fill ${meta.cls}`} />
      </span>
    );
  }, [meter, isOverdue]);

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
      {/* Specialty picker options (LINA-306 item 6) — shared by every trade
          input's `list`. Native datalist: a suggestion source, never a gate. */}
      <datalist id="pgd-specialties">
        {specialties.map((s) => <option key={s} value={s} />)}
      </datalist>
      {/* ── The filter bar (LINA-306, pen "Filter bar"): search + owner + status
          + overdue/blocked toggles narrow the visible rows; the legend on the
          right reads the STATUS column's colours. All view state — it hides rows,
          never touches the plan. The timeline reading scale moved to the floating
          nav pinned bottom-right of the canvas. ── */}
      <div className="pgd-filters">
        <div className="pgd-filters-left">
          <label className="pgd-fsearch">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
              strokeWidth={2} strokeLinecap="round" aria-hidden focusable="false">
              <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
            </svg>
            <input
              type="search" className="pgd-fsearch-in" value={search} placeholder="Search tasks"
              aria-label="Search tasks by name or ID"
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="pgd-fsel">
            <span className="pgd-fsel-lbl">Owner</span>
            <select
              className="pgd-fsel-in" value={ownerFilter} aria-label="Filter by owner"
              onChange={(e) => setOwnerFilter(e.target.value)}
            >
              <option value="">All</option>
              {parties.map((m) => (
                <option key={m.partyId} value={m.partyId}>{m.name} · {roleWord(m.role)}</option>
              ))}
            </select>
          </label>
          <label className="pgd-fsel">
            <span className="pgd-fsel-lbl">Status</span>
            <select
              className="pgd-fsel-in" value={statusFilter} aria-label="Filter by status"
              onChange={(e) => setStatusFilter(e.target.value as '' | StageStatus)}
            >
              <option value="">All</option>
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>{STATUS_META[s].label}</option>
              ))}
            </select>
          </label>
          <span className="pgd-fdiv" aria-hidden />
          <button
            type="button"
            className={`pgd-ftoggle is-warning${overdueOnly ? ' is-on' : ''}`}
            aria-pressed={overdueOnly}
            onClick={() => setOverdueOnly((v) => !v)}
          >
            <span className="pgd-ftoggle-dot" aria-hidden />Overdue
          </button>
          <button
            type="button"
            className={`pgd-ftoggle is-danger${blockedOnly ? ' is-on' : ''}`}
            aria-pressed={blockedOnly}
            onClick={() => setBlockedOnly((v) => !v)}
          >
            <span className="pgd-ftoggle-dot" aria-hidden />Blocked
          </button>
          {filterActive ? (
            <button type="button" className="pgd-fclear" onClick={clearFilters}>Clear</button>
          ) : null}
        </div>
        <div className="pgd-legend" aria-hidden>
          <span className="pgd-legend-lbl">Status</span>
          {STATUS_ORDER.map((s) => (
            <span key={s} className="pgd-legend-item">
              <span className={`pgd-legend-sw ${STATUS_META[s].cls}`} />
              {STATUS_META[s].label}
            </span>
          ))}
        </div>
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
            <span className="pgd-hcell pgd-hcell-status" aria-hidden>Status</span>
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
              const isFolded = collapsed.has(r.key);
              const hasChildren = r.phase.tasks.length > 0;
              const cellFor = (c: ColKey) => {
                if (c === 'trade') {
                  return (
                    <span key="trade" className="pgd-trade">
                      <input
                        className="pgd-tradeinput" value={r.phase.trade} placeholder="Specialty"
                        list="pgd-specialties"
                        maxLength={120} aria-label={`Specialty for phase ${r.pi + 1}`}
                        disabled={disabled}
                        onChange={(e) => props.onTrade(r.key, e.target.value)}
                        onBlur={(e) => rememberSpecialty(e.target.value)}
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
                    {/* The accordion caret (LINA-306): folds this phase's tasks
                        away. Disabled on an empty phase — nothing to fold. */}
                    <button
                      type="button"
                      className={`pbx-icon pgd-fold${isFolded ? '' : ' is-open'}`}
                      aria-expanded={!isFolded}
                      aria-label={`${isFolded ? 'Expand' : 'Collapse'} phase ${r.pi + 1}`}
                      title={isFolded ? 'Expand phase' : 'Collapse phase'}
                      disabled={!hasChildren}
                      onClick={(e) => { e.stopPropagation(); toggleFold(r.key); }}
                    >▸</button>
                    {name(r, id)}
                  </span>
                  <span className="pgd-statuscol">{statusCell(counts, null, `Phase ${r.pi + 1}`)}</span>
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
                      list="pgd-specialties"
                      maxLength={120} aria-label={`Specialty for ${what} ${id}`}
                      disabled={disabled}
                      onChange={(e) => props.onTrade(r.key, e.target.value)}
                      onBlur={(e) => rememberSpecialty(e.target.value)}
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
                className={`pgd-row${sub ? ' pgd-row-sub' : ''}${litRows.has(r.key) ? ' is-cycle' : ''}${pendingChange.has(r.key) ? ' is-pending-change' : ''}${(isTaskDrag && dragTask?.ti === r.ti) || (isSubDrag && dragSub?.si === r.si) ? ' is-dragging' : ''}`}
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
                  {/* A task that has grown sub-tasks becomes an accordion too
                      (LINA-306). A leaf task (or any sub-task) gets a spacer of
                      the caret's width instead, so names stay aligned down the
                      column whether or not a row folds. */}
                  {!sub && (r.node.children ?? []).length > 0 ? (
                    <button
                      type="button"
                      className={`pbx-icon pgd-fold${collapsed.has(r.key) ? '' : ' is-open'}`}
                      aria-expanded={!collapsed.has(r.key)}
                      aria-label={`${collapsed.has(r.key) ? 'Expand' : 'Collapse'} ${what} ${id}`}
                      title={collapsed.has(r.key) ? 'Expand task' : 'Collapse task'}
                      onClick={(e) => { e.stopPropagation(); toggleFold(r.key); }}
                    >▸</button>
                  ) : <span className="pgd-fold-spacer" aria-hidden />}
                  {name(r, id)}
                  {/* The clay/amber tint is never the only signal (ADR-0023 §6):
                      the chip says it in words, for colour-blind readers and for
                      the screen reader walking an aria-disabled grid. */}
                  {pendingChange.has(r.key) ? <PendingChangeChip /> : null}
                  {r.node.description.trim() ? <span className="pgt-lbl-dot" aria-hidden /> : null}
                </span>
                {/* A parent task (counts.total > 0) shows its child meter; a leaf
                    (counts null on a sub, or total 0 on a childless task) shows
                    its own derived status. statusCell picks between them. */}
                <span className="pgd-statuscol">{statusCell(counts, r.node, `${what[0].toUpperCase()}${what.slice(1)} ${id}`)}</span>
                {colOrder.map(cellFor)}
                <span className="pgd-ctl">
                  {!sub ? (
                    <button type="button" className="pbx-icon" title="Add sub-task"
                      aria-label={`Add a sub-task under ${what} ${id}`} disabled={disabled}
                      onClick={() => { expand(r.key); setEditing(props.onAddSubtask(r.pi, r.ti)); }}>＋</button>
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
            <div className={`pgt-canvas${linking ? ' is-linking' : ''}`} style={{ width: canvasWidth }} ref={canvasRef}>
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
                  const box = bar ? barRect(bar.offsetDays, bar.spanDays, col) : null;
                  return (
                    <div key={`tp-${r.pi}`} className="pgt-band" style={{ height: H.phase }}>
                      {box ? (
                        <div className="pgd-envbar" aria-hidden
                          style={{ left: box.x, width: box.width }} />
                      ) : null}
                    </div>
                  );
                }
                const bar = clipBarGeom(win, r.node.start, r.node.end);
                const box = bar ? barRect(bar.offsetDays, bar.spanDays, col) : null;
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
                    {bar && box ? (
                      <div
                        className={`pgt-bar${r.si != null ? ' is-sub' : ''}${bar.open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${pendingChange.has(r.key) ? ' is-pending-change' : ''}`}
                        style={{ left: box.x, width: box.width }}
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
                    {/* On hover: the dates on BOTH edges (founder, LINA-306) and,
                        just outside each edge, a ＋ handle the author drags onto
                        another bar to link them. Siblings of the bar (not children
                        of its overflow-hidden box) so the ＋ can sit outside the
                        bar and never be clipped; revealed on track hover in CSS.
                        The old single right-side duration tip is replaced by these
                        two edge labels. */}
                    {box ? (
                      <>
                        {r.node.start ? (
                          <span className="pgt-edgedate pgt-edgedate-l" aria-hidden style={{ left: box.x }}>
                            {dayLabelFull(r.node.start)}
                          </span>
                        ) : null}
                        {r.node.end ? (
                          <span className="pgt-edgedate pgt-edgedate-r" aria-hidden style={{ left: box.x + box.width }}>
                            {dayLabelFull(r.node.end)}
                          </span>
                        ) : null}
                        {!disabled ? (
                          <>
                            <button
                              type="button" className="pgt-linksrc pgt-linksrc-l"
                              style={{ left: box.x }}
                              aria-label={`Link the start of ${r.node.name.trim() || 'this task'} to another task — drag onto its edge`}
                              title="Drag onto another bar's edge to link (start)"
                              onPointerDown={(e) => onLinkDown(e, r.key, 'start')}
                              onPointerMove={onLinkMove} onPointerUp={onLinkUp} onPointerCancel={onLinkUp}
                            ><LinkGlyph /></button>
                            <button
                              type="button" className="pgt-linksrc pgt-linksrc-r"
                              style={{ left: box.x + box.width }}
                              aria-label={`Link the finish of ${r.node.name.trim() || 'this task'} to another task — drag onto its edge`}
                              title="Drag onto another bar's edge to link (finish)"
                              onPointerDown={(e) => onLinkDown(e, r.key, 'end')}
                              onPointerMove={onLinkMove} onPointerUp={onLinkUp} onPointerCancel={onLinkUp}
                            ><LinkGlyph /></button>
                          </>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                );
              })}
              <div className="pgd-track-add" style={{ height: H.add }} />

              {/* The dependency arrows (ADR-0020 §6). ONE overlay above every
                  bar, and inert: `pointer-events: none` so a connector crossing
                  a bar never steals the drag that bar exists for.
                  aria-hidden because the arrows are a PICTURE of links the
                  drawer already lists in words — the accessible surface is that
                  list, not a screen reader walking a bag of paths. The per-path
                  <title> still answers a mouse hover. */}
              {connectors.length > 0 ? (
                <svg
                  className="pgt-links"
                  width={canvasWidth}
                  height={canvasHeight}
                  viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
                  aria-hidden
                  focusable="false"
                >
                  <defs>
                    {/* `orient="auto"` turns the head with the final segment, so
                        an ends_with arrow points back left without a second def. */}
                    <marker
                      id="pgt-arrow" markerWidth="5" markerHeight="5"
                      refX="4.5" refY="2.5" orient="auto" markerUnits="userSpaceOnUse"
                    >
                      <path d="M0 0 L5 2.5 L0 5 z" className="pgt-arrowhead" />
                    </marker>
                  </defs>
                  {connectors.map((c) => (
                    <path key={c.id} className="pgt-link" d={c.d} markerEnd="url(#pgt-arrow)">
                      <title>{c.title}</title>
                    </path>
                  ))}
                </svg>
              ) : null}

              {/* The unlink controls (LINA-306): one ⊘ button in the MIDDLE of each
                  arrow, so the author can clear a starts-with / ends-with / after
                  link straight off the timeline without opening the drawer. A real
                  HTML button layer — not part of the inert connector SVG — so it
                  owns its own pointer events; the arrows underneath stay
                  pointer-events:none. Editor-only: a read-only plan draws the
                  arrows but offers no clear. */}
              {!disabled && connectors.length > 0 ? (
                <div className="pgt-unlinks" aria-hidden={false}>
                  {connectors.map((c) => (
                    <button
                      key={`x-${c.id}`}
                      type="button"
                      className="pgt-unlink"
                      style={{ left: c.mx, top: c.my }}
                      title={`Clear this link — ${c.title}`}
                      aria-label={`Clear dependency: ${c.title}`}
                      onClick={(e) => { e.stopPropagation(); props.onUnlinkDep(c.from, c.to); }}
                    >⊘</button>
                  ))}
                </div>
              ) : null}

              {/* The live link-drag (LINA-306): a rubber-band from the source edge
                  to the pointer, snapping to a target edge with a ring when it is
                  over one. Inert overlay — the ＋ handle owns the pointer via
                  capture, so this only ever draws. */}
              {linking ? (() => {
                const t = linking.target
                  ? linkTargets.find((z) => z.key === linking.target!.key)
                  : null;
                const endX = t ? (linking.target!.edge === 'start' ? t.xL : t.xR) : linking.x;
                const endY = t ? (t.yTop + t.yBot) / 2 : linking.y;
                return (
                  <svg
                    className="pgt-linkdraw" width={canvasWidth} height={canvasHeight}
                    viewBox={`0 0 ${canvasWidth} ${canvasHeight}`} aria-hidden focusable="false"
                  >
                    <line
                      className={`pgt-linkdraw-line${t ? ' is-snapped' : ''}`}
                      x1={linking.x0} y1={linking.y0} x2={endX} y2={endY}
                    />
                    <circle className="pgt-linkdraw-src" cx={linking.x0} cy={linking.y0} r={3.5} />
                    {t ? <circle className="pgt-linkdraw-hit" cx={endX} cy={endY} r={5.5} /> : null}
                  </svg>
                );
              })() : null}
            </div>
          ) : null}
        </div>

        {/* ── The floating timeline nav (LINA-306, pen "Timeline nav"): a compact
            segmented pill pinned to the bottom-right of the canvas. "Today"
            scrolls the timeline to today; the scales pick the reading base. It
            floats over the grid (not inside the scroller) so it stays put while
            the timeline pans. Hidden until there is a window to navigate. ── */}
        {win ? (
          <div className="pgd-timenav" role="group" aria-label="Timeline">
            <button
              type="button"
              className="pgd-timenav-today"
              title="Scroll the timeline to today"
              onClick={() => {
                const sc = scrollRef.current;
                if (!sc) return;
                const ts = parseDay(todayIso);
                const st = parseDay(win.startDay);
                if (ts === null || st === null) return;
                const off = Math.round((ts - st) / 86_400_000) * col;
                sc.scrollTo({ left: Math.max(0, off - sc.clientWidth / 2), behavior: 'smooth' });
              }}
            >Today</button>
            <span className="pgd-timenav-div" aria-hidden />
            <span className="pgd-timenav-scales">
              {NAV_BASES.map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  className={`pgd-timenav-scale${base === v ? ' is-active' : ''}`}
                  aria-pressed={base === v}
                  onClick={() => onPickBase(v)}
                >{l}</button>
              ))}
            </span>
          </div>
        ) : null}
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
