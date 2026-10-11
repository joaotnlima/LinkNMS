// The planning TASK PORT published for other modules (doc 02 rule 2) — reads
// of the plan's structure that another module needs to decide its own rule,
// without reading planning.*:
//
//   descendantIds(taskId) → string[]   live rows below a task (documents:
//                                      "also on sub-tasks", PRD-05 F-10)
//   taskIdsOf(projectId) → string[]    every live row of a build (quality:
//                                      the build home's pending verifications)
//   tasksOf(projectId) → [{ id, code, name, kind, specialty_code }]
//                                      every live row in outline order (tendering:
//                                      "Ask for a proposal", PRD-04 X-6)
//   modelScopes(projectId) → {          the shared project model (PRD-07):
//     owner_org_id,                     the owner edits the whole model;
//     tasks: [{ id, code, name, parent_id, status,
//               assignee_org_id, assignee_org_name }],   legend + colouring (M-3);
//     editors: [{ org_id, org_name, task_ids[] }]        each org's live D-33
//   }                                    edit scope — M-8, closed on contract end (M-9)
import { modelScopesOf, outlineCodes } from '../domain/model-scope.mjs';

/**
 * @param {{ descendantTaskIds: (id: string) => Promise<string[]>, loadPlan: (projectId: string) => Promise<object> }} store
 *   planning pg-store
 */
export function createPlanningTaskPort(store) {
  return {
    async descendantIds(taskId) {
      return store.descendantTaskIds(taskId);
    },

    async taskIdsOf(projectId) {
      return projectId ? store.liveTaskIds(projectId) : [];
    },

    async tasksOf(projectId) {
      if (!projectId) return [];
      const plan = await store.loadPlan(projectId);
      const codes = outlineCodes(plan.tasks);
      const rows = [...plan.tasks.values()].map((t) => ({
        id: t.id, code: codes.get(t.id) ?? '', name: t.name, kind: t.kind, specialty_code: t.specialtyCode ?? null,
      }));
      const key = (c) => c.split('.').map(Number);
      return rows.sort((a, b) => {
        const x = key(a.code); const y = key(b.code);
        for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
          if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
        }
        return 0;
      });
    },

    async modelScopes(projectId) {
      const plan = await store.loadPlan(projectId);
      return modelScopesOf(plan);
    },
  };
}
