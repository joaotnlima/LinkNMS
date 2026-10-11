// Who is on site when (PRD-10 E-10, E-11; flows C14, E23). Pure, derived from
// the plan — never stored.
//
// Presence: every dated LEAF task (milestones are moments, not presence) puts
// its effective assignee organisation (D-33 inheritance) on site on each
// working day of its span (actuals first, as the plan draws it) at its
// location — its own, else its nearest ancestor's. Rows without an assignee
// are counted, not shown.
//
// Overlap: two rows of DIFFERENT organisations at the same location on the
// same working day. Consecutive working days of the same pair are one overlap.
// A row without a location never overlaps (we cannot say where it is).
import { addDays, isWorkingDay, nextWorkingDay } from './calendar.mjs';
import { effectiveAssignee } from './scope.mjs';

export const MAX_WINDOW_DAYS = 366;

/** Nearest location up the tree (own first). */
export function effectiveLocation(tasks, taskId) {
  let t = tasks.get(taskId);
  while (t) {
    if (t.locationId) return t.locationId;
    t = t.parentId ? tasks.get(t.parentId) : null;
  }
  return null;
}

function workingDaysIn(cal, from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkingDay(cal, d)) out.push(d);
  return out;
}

/**
 * @param {{tasks: Map, counts: Map, spans: Map, calendar: object, from: string, to: string,
 *          orgNames?: Map, locationNames?: Map}} plan
 */
export function siteCalendar({ tasks, counts, spans, calendar, from, to, orgNames, locationNames }) {
  const presence = [];
  let unassigned = 0;
  for (const t of tasks.values()) {
    if ((counts.get(t.id) ?? 0) > 0 || t.kind === 'milestone') continue;
    const span = spans.get(t.id);
    if (!span?.start || !span?.finish || span.finish < from || span.start > to) continue;
    const assignee = effectiveAssignee(tasks, t.id);
    if (!assignee) { unassigned += 1; continue; }
    const days = workingDaysIn(calendar, span.start < from ? from : span.start, span.finish > to ? to : span.finish);
    if (!days.length) continue;
    const locationId = effectiveLocation(tasks, t.id);
    presence.push({
      task_id: t.id,
      task_name: t.name,
      org_id: assignee.orgId,
      ...(orgNames?.get(assignee.orgId) ? { org_name: orgNames.get(assignee.orgId) } : {}),
      location_id: locationId,
      ...(locationId && locationNames?.get(locationId) ? { location_name: locationNames.get(locationId) } : {}),
      from: span.start,
      to: span.finish,
      days,
    });
  }
  presence.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.task_name.localeCompare(b.task_name)));
  return { presence, overlaps: overlapsOf(presence, calendar, locationNames), unassigned_count: unassigned };
}

/** Pairs of different organisations sharing a location on a working day, as day ranges. */
export function overlapsOf(presence, calendar, locationNames) {
  const byPlaceDay = new Map();
  for (const p of presence) {
    if (!p.location_id) continue;
    for (const d of p.days) {
      const key = `${p.location_id}|${d}`;
      if (!byPlaceDay.has(key)) byPlaceDay.set(key, []);
      byPlaceDay.get(key).push(p);
    }
  }
  const pairs = new Map(); // pairKey → {a, b, location_id, days: []}
  for (const [key, here] of byPlaceDay) {
    if (here.length < 2) continue;
    const day = key.slice(key.indexOf('|') + 1);
    for (let i = 0; i < here.length; i++) {
      for (let j = i + 1; j < here.length; j++) {
        const [a, b] = here[i].task_id < here[j].task_id ? [here[i], here[j]] : [here[j], here[i]];
        if (a.org_id === b.org_id) continue;
        const pk = `${a.location_id}|${a.task_id}|${b.task_id}`;
        if (!pairs.has(pk)) pairs.set(pk, { a, b, location_id: a.location_id, days: [] });
        pairs.get(pk).days.push(day);
      }
    }
  }
  const out = [];
  for (const { a, b, location_id: locationId, days } of pairs.values()) {
    days.sort();
    let start = days[0];
    let prev = days[0];
    let n = 1;
    const flush = () => out.push({
      location_id: locationId,
      ...(locationNames?.get(locationId) ? { location_name: locationNames.get(locationId) } : {}),
      from: start, to: prev, days: n,
      tasks: [a, b].map((p) => ({
        task_id: p.task_id, task_name: p.task_name, org_id: p.org_id,
        ...(p.org_name ? { org_name: p.org_name } : {}),
      })),
    });
    for (const d of days.slice(1)) {
      if (d === nextWorkingDay(calendar, prev)) { prev = d; n += 1; continue; }
      flush();
      start = d; prev = d; n = 1;
    }
    flush();
  }
  return out.sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0));
}

/**
 * The window: defaults today .. today + 90; both YYYY-MM-DD, from ≤ to, at most
 * MAX_WINDOW_DAYS. @returns {{errors?: object, from?: string, to?: string}}
 */
export function calendarWindow(query, today, { back = 0, ahead = 90 } = {}) {
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const errors = {};
  const from = query?.from ?? addDays(today, -back);
  if (!ISO.test(from) || Number.isNaN(Date.parse(from))) return { errors: { from: 'a date YYYY-MM-DD' } };
  const to = query?.to ?? addDays(from, ahead);
  if (!ISO.test(to) || Number.isNaN(Date.parse(to))) errors.to = 'a date YYYY-MM-DD';
  if (!Object.keys(errors).length) {
    if (to < from) errors.to = 'on or after from';
    else if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_WINDOW_DAYS) errors.to = `at most ${MAX_WINDOW_DAYS} days after from`;
  }
  return Object.keys(errors).length ? { errors } : { from, to };
}
