// What tendering some rows means for the schedule — pure (PRD-02 T-3/T-4/T-5/
// T-13, §5). Planning owns the calendar, the links and therefore the critical
// path; tendering owns only the bids-due date. So the plan facts a tender needs
// are computed here and nowhere else:
//
//   coverage    — the roots and their sub-trees, minus descendants LEFT OUT
//                 because they already have their own owner (another party
//                 than the root's effective assignee). A left-out row takes its
//                 sub-tree with it. `include` puts a row back.
//   work window — the envelope of the covered leaves' effective dates: the
//                 dates that lock while the tender is out.
//   critical    — a covered leaf is critical when a ONE-working-day delay of
//                 its finish moves the project finish (domain/critical-path.mjs,
//                 the same rule the plan's critical-path overlay reads).
//   award-by    — planned start − mobilisation lead, on the project calendar
//                 (the latest award that still lets the winner start on time).
import {
  durationWd, shiftWorkingDays, workingDaysDelta,
} from './calendar.mjs';
import { effectiveSpans } from './propagation.mjs';
import { criticalTaskIds } from './critical-path.mjs';
import { effectiveAssignee } from './scope.mjs';

/** Default mobilisation lead (PRD-02 §5) — an assumption to validate. */
export const DEFAULT_MOBILISATION_LEAD_WD = 5;

function childrenIndex(tasks) {
  const kids = new Map();
  for (const t of tasks.values()) {
    if (!t.parentId) continue;
    if (!kids.has(t.parentId)) kids.set(t.parentId, []);
    kids.get(t.parentId).push(t.id);
  }
  return kids;
}

/**
 * Coverage of a tender over `rootIds`: which rows stay in, which descendants
 * are left out (top-most only — their sub-trees go with them) and why.
 */
export function tenderCoverage({ tasks, rootIds, includeIds = [], orgNames = new Map() }) {
  const kids = childrenIndex(tasks);
  const include = new Set(includeIds);
  const covered = [];
  const leftOut = [];
  for (const rootId of rootIds) {
    const rootOwner = effectiveAssignee(tasks, rootId)?.orgId ?? null;
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop();
      const t = tasks.get(id);
      if (!t) continue;
      const own = id !== rootId && t.assigneeOrgId && t.assigneeOrgId !== rootOwner;
      if (own && !include.has(id)) {
        leftOut.push({
          task_id: id,
          name: t.name,
          reason: 'assigned',
          assignee: { org_id: t.assigneeOrgId, name: orgNames.get(t.assigneeOrgId) ?? null },
        });
        continue;
      }
      covered.push(id);
      // Reverse so the walk reads in position order (siblings are position-sorted).
      const children = [...(kids.get(id) ?? [])]
        .sort((a, b) => (tasks.get(a).position < tasks.get(b).position ? -1 : 1))
        .reverse();
      stack.push(...children);
    }
  }
  return { covered, leftOut };
}

/** Latest finish over every leaf of the plan (the project finish), or null. */
function projectFinishOf(tasks, spans, kids) {
  let finish = null;
  for (const t of tasks.values()) {
    if ((kids.get(t.id) ?? []).length) continue;
    const f = spans.get(t.id)?.finish;
    if (f && (!finish || f > finish)) finish = f;
  }
  return finish;
}

/**
 * Leaves among `candidateIds` whose one-working-day slip moves the project
 * finish — the plan's ONE critical-path rule (domain/critical-path.mjs), asked
 * about the tender's covered leaves.
 */
export function criticalLeaves({ tasks, links, calendar, candidateIds }) {
  const critical = criticalTaskIds({ tasks, links, calendar });
  const kids = childrenIndex(tasks);
  return candidateIds.filter((id) => critical.has(id) && !(kids.get(id) ?? []).length);
}

/**
 * #/components/schemas/TenderWindow (minus project_id, added by the caller).
 *
 * @param {{tasks: Map, links: Array, calendar: object, rootIds: string[],
 *          includeIds?: string[], bidsDue?: string|null, leadWd?: number,
 *          orgNames?: Map}} input
 */
export function tenderWindow({
  tasks, links, calendar, rootIds, includeIds = [], bidsDue = null,
  leadWd = DEFAULT_MOBILISATION_LEAD_WD, orgNames = new Map(),
}) {
  const kids = childrenIndex(tasks);
  const { covered, leftOut } = tenderCoverage({ tasks, rootIds, includeIds, orgNames });
  const spans = effectiveSpans(tasks);
  const coveredLeaves = covered.filter((id) => !(kids.get(id) ?? []).length);

  let start = null;
  let finish = null;
  for (const id of coveredLeaves) {
    const s = spans.get(id);
    if (s?.start && (!start || s.start < start)) start = s.start;
    if (s?.finish && (!finish || s.finish > finish)) finish = s.finish;
  }
  const workWindow = start && finish
    ? { start, finish, duration_wd: durationWd(calendar, start, finish) }
    : null;

  const critical = criticalLeaves({ tasks, links, calendar, candidateIds: coveredLeaves });
  const awardBy = workWindow ? shiftWorkingDays(calendar, workWindow.start, -leadWd) : null;
  const due = bidsDue ?? null;

  return {
    root_task_ids: [...rootIds],
    covered_task_ids: covered,
    left_out: leftOut,
    work_window: workWindow,
    on_critical_path: critical.length > 0,
    critical_task_ids: critical,
    project_finish: projectFinishOf(tasks, spans, kids),
    mobilisation_lead_wd: leadWd,
    award_by: awardBy,
    bids_due: due,
    wd_bids_due_to_start: due && workWindow ? workingDaysDelta(calendar, due, workWindow.start) : null,
    wd_bids_due_to_award_by: due && awardBy ? workingDaysDelta(calendar, due, awardBy) : null,
  };
}
