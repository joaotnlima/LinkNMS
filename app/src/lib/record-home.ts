// The M14 record-home derivations that can be wrong in an expensive way, split
// out so they run under `node --test` without a browser (record-home.test.mjs) —
// the same discipline as lib/plan-baseline.ts and lib/record.ts. Everything here
// is pure; the screen stays copy and layout.
//
// ADR-0015 §4/§5. The one rule these functions keep: they invent NO schedule.
// The week line and the stage span are derived only from planned dates the
// baseline plan actually carries, and return null the moment that data is
// absent, so the screen can omit the line rather than draw a made-up one.
import type { ScheduleLine, ProgressStatus } from './record';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A parsed calendar span, or null when no stage carries planned dates. */
export interface ScheduleSpan {
  start: Date;
  end: Date;
}

/**
 * The build's planned span: earliest planned start to latest planned end across
 * every dated stage. `null` when NO stage has both dates — there is then no
 * schedule to measure against, and the caller omits the week line entirely
 * rather than guessing one (ADR-0015 §4).
 */
export function scheduleSpan(lines: ScheduleLine[]): ScheduleSpan | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const l of lines) {
    const s = parseDate(l.plannedStartDate);
    const e = parseDate(l.plannedEndDate);
    if (s != null && (start == null || s < start)) start = s;
    if (e != null && (end == null || e > end)) end = e;
  }
  if (start == null || end == null || end < start) return null;
  return { start: new Date(start), end: new Date(end) };
}

export interface WeekLine {
  /** The current week, 1-based and clamped into [1, total]. */
  week: number;
  /** Total weeks the plan spans, at least 1. */
  total: number;
}

/**
 * "Week X of Y" from the baseline plan's dates against `now` (ADR-0015 §4).
 * Returns null when there is no dated span — the honest omission. `week` is
 * clamped: before the plan starts it reads week 1, after it ends it reads the
 * final week, so the line never shows "week 0" or a week past the end.
 */
export function weekLine(lines: ScheduleLine[], now: Date): WeekLine | null {
  const span = scheduleSpan(lines);
  if (!span) return null;
  const total = Math.max(1, Math.ceil((span.end.getTime() - span.start.getTime()) / (7 * DAY_MS)));
  // Which week the plan is IN: the start day is week 1, day 7 begins week 2, and
  // so on (floor of whole weeks elapsed, +1). Clamped so before-start reads
  // week 1 and after-end reads the final week — never week 0 or past the end.
  const daysElapsed = (now.getTime() - span.start.getTime()) / DAY_MS;
  const week = Math.min(total, Math.max(1, Math.floor(daysElapsed / 7) + 1));
  return { week, total };
}

/** How a timeline row draws (ADR-0015 §5). No executed dates exist, so the bar
 *  is progress-honest: `closed` for done, a percent-filled `progress` overlay
 *  for in-progress, a `blocked` marker, or a muted `plan`-only bar. */
export type TimelineTone = 'closed' | 'progress' | 'blocked' | 'plan';

export function timelineTone(status: ProgressStatus): TimelineTone {
  switch (status) {
    case 'done': return 'closed';
    case 'in_progress': return 'progress';
    case 'blocked': return 'blocked';
    default: return 'plan';
  }
}

/** The stage-state word beside each timeline row — the label half of FR9. */
export function timelineStateLabel(status: ProgressStatus): string {
  switch (status) {
    case 'done': return 'Closed';
    case 'in_progress': return 'In progress';
    case 'blocked': return 'Blocked';
    default: return 'Not started';
  }
}

// `YYYY-MM-DD` (or any Date-parseable string) → epoch ms, or null. A blank or
// unparseable date is "no date", never NaN leaking into the span math.
function parseDate(raw: string | null): number | null {
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}
