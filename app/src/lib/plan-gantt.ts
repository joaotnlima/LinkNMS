// Gantt drag-to-schedule / resize math (LINA-236).
//
// The screen the pen names "Build the plan — schedule (Gantt)" already lets the
// author type each task's start/finish as `<input type="date">` strings. This
// module is the *timeline* half: turn those date strings into bar geometry, and
// turn a pixel drag back into new date strings. It is pure and browser-free so
// every edge (day snapping, clamping, timezone) is unit-tested under `node
// --test` (plan-gantt.test.mjs) — the component stays layout + pointer plumbing.
//
// WHY THE MATH LIVES HERE, NOT IN THE COMPONENT
// A Gantt bar that silently drifts a task by a day (a timezone off-by-one, a
// rounding error at a DST boundary) corrupts the very thing LinkNMS exists to
// keep honest: what was scheduled, and when it moved. Dates are handled as pure
// 'YYYY-MM-DD' calendar days in UTC — never local time — so a drag of N columns
// moves a task exactly N calendar days regardless of the author's timezone.

const MS_PER_DAY = 86_400_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a 'YYYY-MM-DD' calendar day to UTC-midnight epoch ms, or null if it is
 * blank or not a real date. Round-trips the components so an impossible day
 * (2026-02-30) is rejected rather than silently rolled over by Date.
 */
export function parseDay(iso: string): number | null {
  if (!iso || !ISO_RE.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

/** Format UTC-midnight epoch ms back to a 'YYYY-MM-DD' calendar day. */
export function formatDay(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Add (or subtract) whole calendar days to a day string; blanks pass through. */
export function addDays(iso: string, n: number): string {
  const ms = parseDay(iso);
  if (ms === null) return iso;
  return formatDay(ms + n * MS_PER_DAY);
}

/**
 * Whole calendar days from `a` to `b` (b − a), or null if either is unset.
 * Positive when b is later. Inclusive span of [a, b] is diffDays(a, b) + 1.
 */
export function diffDays(a: string, b: string): number | null {
  const ta = parseDay(a);
  const tb = parseDay(b);
  if (ta === null || tb === null) return null;
  return Math.round((tb - ta) / MS_PER_DAY);
}

// ── The timeline window ──────────────────────────────────────────────────────

export interface GanttWindow {
  /** First day column (inclusive), 'YYYY-MM-DD'. */
  startDay: string;
  /** Last day column (inclusive), 'YYYY-MM-DD'. */
  endDay: string;
  /** Number of day columns, i.e. inclusive span. Always ≥ 1 when non-null. */
  days: number;
}

/**
 * The day window the timeline spans: the earliest start to the latest finish
 * across every dated task, padded by `pad` days on each side so there is room to
 * drag a bar earlier or later. Returns null when nothing is dated (the timeline
 * has nothing to show — the caller falls back to a hint).
 */
export function ganttWindow(
  tasks: ReadonlyArray<{ start: string; end: string }>,
  pad = 3,
): GanttWindow | null {
  const days: number[] = [];
  for (const t of tasks) {
    const s = parseDay(t.start);
    const e = parseDay(t.end);
    if (s !== null) days.push(s);
    if (e !== null) days.push(e);
  }
  if (days.length === 0) return null;
  const min = Math.min(...days) - pad * MS_PER_DAY;
  const max = Math.max(...days) + pad * MS_PER_DAY;
  return {
    startDay: formatDay(min),
    endDay: formatDay(max),
    days: Math.round((max - min) / MS_PER_DAY) + 1,
  };
}

// ── Bar geometry ─────────────────────────────────────────────────────────────

export interface BarGeom {
  /** Day columns from the window start to the bar's first day (≥ 0). */
  offsetDays: number;
  /** Bar width in day columns, inclusive (≥ 1). */
  spanDays: number;
  /** True when only one end is dated — the bar is a 1-day placeholder. */
  open: boolean;
}

/**
 * Where a task's bar sits in the window. A task with both dates spans them
 * inclusively (a same-day task is 1 column). A task with only one date renders
 * as a 1-day `open` bar at that date, so a half-scheduled task is still grabbable
 * on the timeline. Returns null when the task is undated or falls outside the
 * window (the caller renders no bar). If the dates are inverted (end before
 * start) the bar is drawn across the range anyway — the author can see and fix it.
 */
export function barGeom(win: GanttWindow, start: string, end: string): BarGeom | null {
  const s = parseDay(start);
  const e = parseDay(end);
  if (s === null && e === null) return null;
  const winStart = parseDay(win.startDay);
  if (winStart === null) return null;

  const open = s === null || e === null;
  const lo = Math.min(...[s, e].filter((x): x is number => x !== null));
  const hi = Math.max(...[s, e].filter((x): x is number => x !== null));

  const offsetDays = Math.round((lo - winStart) / MS_PER_DAY);
  const spanDays = Math.round((hi - lo) / MS_PER_DAY) + 1;
  if (offsetDays < 0 || offsetDays + spanDays > win.days) return null;
  return { offsetDays, spanDays, open };
}

// ── Turning a drag into new dates ────────────────────────────────────────────

/** How many whole day columns a pixel delta represents, snapped to the day. */
export function daysFromPixels(dx: number, colWidth: number): number {
  if (!colWidth || colWidth <= 0) return 0;
  return Math.round(dx / colWidth);
}

export interface Dates {
  start: string;
  end: string;
}

/**
 * MOVE — drag the bar body: shift both ends by the same number of days, so the
 * task keeps its duration. A blank end (open bar) stays blank; only the dated
 * end moves. Moving is duration-preserving by construction, so no clamp needed.
 */
export function moveBar(start: string, end: string, deltaDays: number): Dates {
  return { start: addDays(start, deltaDays), end: addDays(end, deltaDays) };
}

/**
 * RESIZE START — drag the left edge: move the start only, clamped so it can never
 * pass the end (a task cannot finish before it begins). With no end set, the
 * start moves freely.
 */
export function resizeStart(start: string, end: string, deltaDays: number): Dates {
  if (parseDay(start) === null) return { start, end };
  let next = addDays(start, deltaDays);
  const gap = diffDays(next, end); // end − next; negative means next passed end
  if (gap !== null && gap < 0) next = end;
  return { start: next, end };
}

/**
 * RESIZE END — drag the right edge: move the finish only, clamped so it can never
 * fall before the start. With no start set, the end moves freely.
 */
export function resizeEnd(start: string, end: string, deltaDays: number): Dates {
  if (parseDay(end) === null) return { start, end };
  let next = addDays(end, deltaDays);
  const gap = diffDays(start, next); // next − start; negative means next before start
  if (gap !== null && gap < 0) next = start;
  return { start, end: next };
}

export type DragMode = 'move' | 'resize-start' | 'resize-end';

/** Apply a drag of `dx` pixels in `mode` to a task's dates, snapped to the day. */
export function applyDrag(
  mode: DragMode,
  start: string,
  end: string,
  dx: number,
  colWidth: number,
): Dates {
  const delta = daysFromPixels(dx, colWidth);
  if (delta === 0) return { start, end };
  if (mode === 'move') return moveBar(start, end, delta);
  if (mode === 'resize-start') return resizeStart(start, end, delta);
  return resizeEnd(start, end, delta);
}
