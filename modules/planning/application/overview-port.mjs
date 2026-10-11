// Published query port: the plan's facts for the build home (PRD-09 O-1).
// The project module composes getProjectOverview from these and never reads
// planning.* itself (doc 02 rules 2–3). Time is visible to every participant
// (doc 04 V1), so the port takes no viewer — the caller has already checked
// that the viewer reads the project.
//
//   planFacts(projectId) → {
//     rows, top_level, start,                      // the plan at a glance
//     end_date: {baseline, current, delta_wd},    // working days, + = later
//     open_variations,                            // status open
//     health,                                     // PlanHealth (doc 05 §9)
//   }
import { makeCalendar, workingDaysDelta } from '../domain/calendar.mjs';
import { effectiveSpans } from '../domain/propagation.mjs';
import { planHealth } from './projection.mjs';

/** @param {{ loadPlan: Function }} store planning pg-store */
export function createPlanningOverviewPort(store) {
  return {
    async planFacts(projectId) {
      const plan = await store.loadPlan(projectId);
      const tasks = [...plan.tasks.values()];
      const spans = effectiveSpans(plan.tasks);
      let start = null;
      let current = null;
      let baseline = null;
      for (const t of tasks) {
        const s = spans.get(t.id) ?? {};
        if (s.start && (!start || s.start < start)) start = s.start;
        const f = s.finish ?? s.start;
        if (f && (!current || f > current)) current = f;
        if (t.baselineFinish && (!baseline || t.baselineFinish > baseline)) baseline = t.baselineFinish;
      }
      const cal = makeCalendar(plan.calendarRaw);
      return {
        rows: tasks.length,
        top_level: tasks.filter((t) => !t.parentId).length,
        start,
        end_date: {
          baseline,
          current,
          ...(baseline && current ? { delta_wd: workingDaysDelta(cal, baseline, current) } : {}),
        },
        open_variations: [...(plan.variations?.values() ?? [])].filter((v) => v.status === 'open').length,
        health: planHealth(plan),
      };
    },
  };
}
