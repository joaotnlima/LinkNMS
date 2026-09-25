// Working-day arithmetic on the project calendar (doc 05 §4 "Calendar").
// All plan date maths runs here and nowhere else: ISO dates in, ISO dates
// out, durations in working days INCLUSIVE of both ends (a one-day task has
// duration_wd = 1; a milestone has 0 and start = finish).
const DAY = 86_400_000;

export function toDate(s) {
  return new Date(`${s}T00:00:00Z`);
}

export function iso(d) {
  return d.toISOString().slice(0, 10);
}

export function addDays(s, n) {
  return iso(new Date(toDate(s).getTime() + n * DAY));
}

/** ISO weekday 1 (Monday) .. 7 (Sunday). */
export function isoWeekday(s) {
  const d = toDate(s).getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * @param {{work_days?: number[], holidays?: Array<string|{date:string}>,
 *          closures?: Array<{from:string,to:string}>}} raw
 */
export function makeCalendar(raw = {}) {
  const workDays = new Set(raw.work_days?.length ? raw.work_days : [1, 2, 3, 4, 5]);
  if (![...workDays].some((d) => d >= 1 && d <= 7)) throw new Error('calendar: no working days');
  return {
    workDays,
    holidays: new Set((raw.holidays ?? []).map((h) => (typeof h === 'string' ? h : h.date))),
    closures: (raw.closures ?? []).map(({ from, to }) => ({ from, to })),
  };
}

export function isWorkingDay(cal, s) {
  if (!cal.workDays.has(isoWeekday(s))) return false;
  if (cal.holidays.has(s)) return false;
  return !cal.closures.some((c) => c.from <= s && s <= c.to);
}

/** `s` if working, else the first working day after it. */
export function snapForward(cal, s) {
  while (!isWorkingDay(cal, s)) s = addDays(s, 1);
  return s;
}

/** `s` if working, else the last working day before it. */
export function snapBack(cal, s) {
  while (!isWorkingDay(cal, s)) s = addDays(s, -1);
  return s;
}

/** First working day strictly after `s`. */
export function nextWorkingDay(cal, s) {
  return snapForward(cal, addDays(s, 1));
}

/** Last working day strictly before `s`. */
export function prevWorkingDay(cal, s) {
  return snapBack(cal, addDays(s, -1));
}

/**
 * Move `n` working days (negative moves back). A non-working start snaps in
 * the direction of travel first; n = 0 snaps forward.
 */
export function shiftWorkingDays(cal, s, n) {
  let d = n < 0 ? snapBack(cal, s) : snapForward(cal, s);
  for (; n > 0; n--) d = nextWorkingDay(cal, d);
  for (; n < 0; n++) d = prevWorkingDay(cal, d);
  return d;
}

/** Working days in [start..finish], both ends included. 0 when finish < start. */
export function durationWd(cal, start, finish) {
  if (finish < start) return 0;
  let n = 0;
  for (let d = start; d <= finish; d = addDays(d, 1)) if (isWorkingDay(cal, d)) n += 1;
  return n;
}

/** Finish of a span starting at `start` lasting `durationWd` working days. */
export function spanFinish(cal, start, duration) {
  if (duration <= 1) return snapForward(cal, start);
  return shiftWorkingDays(cal, start, duration - 1);
}

/** Start of a span ending at `finish` lasting `durationWd` working days. */
export function spanStart(cal, finish, duration) {
  if (duration <= 1) return snapBack(cal, finish);
  return shiftWorkingDays(cal, finish, -(duration - 1));
}

/**
 * Signed distance in working days from `a` to `b` (0 when the same day,
 * positive when `b` is later). Counts working days in the half-open gap.
 */
export function workingDaysDelta(cal, a, b) {
  if (a === b) return 0;
  let n = 0;
  if (b > a) {
    for (let d = addDays(a, 1); d <= b; d = addDays(d, 1)) if (isWorkingDay(cal, d)) n += 1;
    return n;
  }
  for (let d = addDays(b, 1); d <= a; d = addDays(d, 1)) if (isWorkingDay(cal, d)) n += 1;
  return -n;
}
