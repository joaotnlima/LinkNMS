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

/**
 * The window the ALWAYS-VISIBLE timeline spans (LINA-248). The Gantt is no
 * longer a toggled view, so it needs a canvas even when nothing is dated yet —
 * otherwise there is nowhere to click a first bar into being. Dated plans get
 * the usual envelope (ganttWindow); an undated plan gets `minDays` columns
 * anchored a `pad` before today. A dated window narrower than `minDays` is
 * extended to the right so early one-task plans still leave room to schedule
 * the rest by pointer.
 */
export function scheduleWindow(
  tasks: ReadonlyArray<{ start: string; end: string }>,
  todayIso: string,
  pad = 3,
  minDays = 42,
): GanttWindow | null {
  const dated = ganttWindow(tasks, pad);
  const base = dated ?? (() => {
    const t = parseDay(todayIso);
    if (t === null) return null;
    const start = t - pad * MS_PER_DAY;
    return {
      startDay: formatDay(start),
      endDay: formatDay(start + (minDays - 1) * MS_PER_DAY),
      days: minDays,
    };
  })();
  if (base === null) return null;
  if (base.days >= minDays) return base;
  return {
    startDay: base.startDay,
    endDay: addDays(base.startDay, minDays - 1),
    days: minDays,
  };
}

// ── The time base (LINA-248 follow-up) ───────────────────────────────────────

/**
 * The reading scale of the timeline. 'auto' fits the dated plan
 * (scheduleWindow); the fixed bases show exactly that much calendar anchored on
 * the plan's earliest dated day (or today); 'custom' is an author-typed
 * start/end pair for whatever reading window they want.
 */
export type TimeBase = 'auto' | 'week' | 'month' | 'quarter' | 'half' | 'year' | 'custom';

const BASE_SPAN_DAYS: Record<Exclude<TimeBase, 'auto' | 'custom'>, number> = {
  week: 7, month: 31, quarter: 92, half: 183, year: 365,
};

/**
 * The window a given time base spans. Fixed bases anchor 2 days before the
 * plan's earliest dated day — today when nothing is dated — so the first bar
 * sits near the left edge with a little room to drag it earlier. A 'custom'
 * base uses the author's own start/end when both parse and are ordered;
 * otherwise (and for 'auto') it falls back to the fitted scheduleWindow.
 */
export function baseWindow(
  base: TimeBase,
  tasks: ReadonlyArray<{ start: string; end: string }>,
  todayIso: string,
  custom?: { from: string; to: string },
): GanttWindow | null {
  if (base === 'custom' && custom) {
    const s = parseDay(custom.from);
    const e = parseDay(custom.to);
    if (s !== null && e !== null && e >= s) {
      return { startDay: formatDay(s), endDay: formatDay(e), days: Math.round((e - s) / MS_PER_DAY) + 1 };
    }
  }
  if (base === 'auto' || base === 'custom') return scheduleWindow(tasks, todayIso);

  const dated: number[] = [];
  for (const t of tasks) {
    const s = parseDay(t.start);
    const e = parseDay(t.end);
    if (s !== null) dated.push(s);
    if (e !== null) dated.push(e);
  }
  const anchor = dated.length ? Math.min(...dated) : parseDay(todayIso);
  if (anchor === null) return null;
  const span = BASE_SPAN_DAYS[base];
  const start = anchor - 2 * MS_PER_DAY;
  return {
    startDay: formatDay(start),
    endDay: formatDay(start + (span - 1) * MS_PER_DAY),
    days: span,
  };
}

/**
 * Click-to-schedule (LINA-248): a click on an empty track at day column
 * `dayOffset` plants a bar there — start on the clicked day, finish one week
 * later — which the author then drags wherever they see fit.
 */
export function clickDates(win: GanttWindow, dayOffset: number): Dates {
  const clamped = Math.max(0, Math.min(win.days - 1, Math.floor(dayOffset)));
  const start = addDays(win.startDay, clamped);
  return { start, end: addDays(start, 7) };
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

/**
 * barGeom, but CLIPPED to the window instead of dropped (LINA-248 follow-up):
 * a fixed or custom time base is a reading window the author chose, and a task
 * that overhangs it must stay visible and grabbable, not vanish. The overhang
 * sides are flagged so the component can suppress the resize handle on an edge
 * that isn't really the task's edge. Null only when the task is undated or
 * lies entirely outside the window.
 */
export function clipBarGeom(
  win: GanttWindow, start: string, end: string,
): (BarGeom & { clipStart: boolean; clipEnd: boolean }) | null {
  const s = parseDay(start);
  const e = parseDay(end);
  if (s === null && e === null) return null;
  const winStart = parseDay(win.startDay);
  if (winStart === null) return null;

  const open = s === null || e === null;
  const lo = Math.min(...[s, e].filter((x): x is number => x !== null));
  const hi = Math.max(...[s, e].filter((x): x is number => x !== null));

  const loDays = Math.round((lo - winStart) / MS_PER_DAY);
  const hiDays = Math.round((hi - winStart) / MS_PER_DAY);
  if (hiDays < 0 || loDays > win.days - 1) return null;

  const from = Math.max(0, loDays);
  const to = Math.min(win.days - 1, hiDays);
  return {
    offsetDays: from,
    spanDays: to - from + 1,
    open,
    clipStart: loDays < 0,
    clipEnd: hiDays > win.days - 1,
  };
}

/**
 * A bar's pixel box in the canvas, from its day geometry. ONE definition, used
 * both to position the bar and to anchor the connectors that point at it — if
 * these drifted apart, an arrow would land beside the bar it names.
 *
 * The ±1/−2 is the bar's own hairline inset: a bar sits a pixel inside its day
 * columns so two touching bars read as two, not one.
 */
export function barRect(offsetDays: number, spanDays: number, col: number): { x: number; width: number } {
  return { x: offsetDays * col + 1, width: Math.max(2, spanDays * col - 2) };
}

// ── Dependency connectors (ADR-0020 §6, LINA-253) ────────────────────────────
// The timeline is absolutely-positioned divs; the links between bars are drawn
// in one SVG overlay above them. This is the geometry half: bar boxes in, elbow
// path out. Pure, so every anchor rule and every backward-route case is a unit
// test rather than something only visible by eye on a real plan.
//
// WHY ELBOWS AND NOT STRAIGHT LINES
// A straight line between two bars reads as a slope — a made-up duration. An
// orthogonal elbow says only "this one, then that one", which is exactly what
// the link asserts: an ordering, not a rate.

/** One end of a connector: a bar's box plus the vertical middle of its row. */
export interface ConnectorEnd {
  /** Left edge, px from the canvas's left. */
  x: number;
  /** Bar width in px (≥ 0). */
  width: number;
  /** Vertical centre of the bar, px from the canvas's top. */
  y: number;
}

export interface Point { x: number; y: number }

export interface ConnectorGeom {
  /** The elbow's corners, start → end. Always ≥ 2 points, all orthogonal. */
  points: Point[];
  /** The same as an SVG `d`, so the component renders without its own loop. */
  d: string;
  /** Which way the arrowhead faces, from the final segment. */
  head: 'left' | 'right';
}

/** How far a connector stands off a bar before turning. */
const STUB = 12;

/** Collapse points that repeat (a zero-length segment draws nothing). */
function dedupe(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  return out.length >= 2 ? out : points.slice(0, 2);
}

/**
 * The elbow path for ONE typed link, predecessor → dependent (ADR-0020 §6).
 *
 * Anchors are the ends the type actually constrains, so the arrow shows the
 * rule rather than just the pairing:
 *   • `starts_after` — pred's RIGHT edge → dep's LEFT edge (finish, then start)
 *   • `starts_with`  — pred's LEFT edge  → dep's LEFT edge (both starts)
 *   • `ends_with`    — pred's RIGHT edge → dep's RIGHT edge (both finishes)
 *
 * `starts_after` routes forward when there is room; when the dependent starts
 * at or before the predecessor ends (a schedule the plan is free to hold — the
 * link is an assertion, not an enforcement) it routes AROUND, out right, across
 * the gap between the two rows, and back into the left edge. The same-edge types
 * route outside both bars, so the elbow never crosses the bars it connects.
 */
export function connectorPath(
  pred: ConnectorEnd, dep: ConnectorEnd, type: 'starts_after' | 'starts_with' | 'ends_with',
): ConnectorGeom {
  const predL = pred.x;
  const predR = pred.x + pred.width;
  const depL = dep.x;
  const depR = dep.x + dep.width;
  // Never route off the left of the canvas — a path at x<0 is simply invisible.
  const clamp = (x: number) => Math.max(1, x);

  let points: Point[];
  if (type === 'starts_with') {
    const mx = clamp(Math.min(predL, depL) - STUB);
    points = [{ x: predL, y: pred.y }, { x: mx, y: pred.y }, { x: mx, y: dep.y }, { x: depL, y: dep.y }];
  } else if (type === 'ends_with') {
    const mx = Math.max(predR, depR) + STUB;
    points = [{ x: predR, y: pred.y }, { x: mx, y: pred.y }, { x: mx, y: dep.y }, { x: depR, y: dep.y }];
  } else if (depL >= predR + 2 * STUB) {
    // Forward: turn down one stub short of the dependent, then in.
    const mx = depL - STUB;
    points = [{ x: predR, y: pred.y }, { x: mx, y: pred.y }, { x: mx, y: dep.y }, { x: depL, y: dep.y }];
  } else {
    // Backward: the dependent sits at or before the predecessor's finish, so
    // going straight there would draw back THROUGH the predecessor's bar. Drop
    // into the lane between the rows and come back along it.
    const lane = (pred.y + dep.y) / 2;
    points = [
      { x: predR, y: pred.y }, { x: predR + STUB, y: pred.y }, { x: predR + STUB, y: lane },
      { x: clamp(depL - STUB), y: lane }, { x: clamp(depL - STUB), y: dep.y }, { x: depL, y: dep.y },
    ];
  }

  const pts = dedupe(points);
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  return {
    points: pts,
    d: pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' '),
    // A vertical final segment (both ends at the same x) still has to point
    // somewhere; it arrives from the outside, so it keeps that side's direction.
    head: last.x > prev.x || (last.x === prev.x && type !== 'ends_with') ? 'right' : 'left',
  };
}

/**
 * The arc-length midpoint of a connector polyline (LINA-306) — where the "clear
 * this link" control sits so it reads as sitting in the MIDDLE OF THE ARROW, not
 * on either bar it joins. Walks the segments accumulating length and returns the
 * point at half the total, so an elbow's midpoint lands on the run the eye reads
 * as its middle (the vertical connector for a same-edge link, the lane for a
 * backward route) rather than at the corner a naive index would pick. Pure, in
 * the same canvas px the path is drawn in, so the control tracks the arrow live.
 */
export function connectorMidpoint(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { x: points[0].x, y: points[0].y };
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const len = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    seg.push(len);
    total += len;
  }
  if (total === 0) return { x: points[0].x, y: points[0].y };
  let half = total / 2;
  for (let i = 0; i < seg.length; i += 1) {
    if (half <= seg[i] || i === seg.length - 1) {
      const t = seg[i] === 0 ? 0 : half / seg[i];
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      };
    }
    half -= seg[i];
  }
  return { x: points[points.length - 1].x, y: points[points.length - 1].y };
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
