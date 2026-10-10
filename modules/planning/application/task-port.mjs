// The planning TASK PORT published for other modules (doc 02 rule 2) — reads
// of the plan's structure that another module needs to decide its own rule,
// without reading planning.*:
//
//   descendantIds(taskId) → string[]   live rows below a task (documents:
//                                      "also on sub-tasks", PRD-05 F-10)
//   modelScopes(projectId) → {          the shared project model (PRD-07):
//     owner_org_id,                     the owner edits the whole model;
//     tasks: [{ id, code, name, parent_id, status,
//               assignee_org_id, assignee_org_name }],   legend + colouring (M-3);
//     editors: [{ org_id, org_name, task_ids[] }]        each org's live D-33
//   }                                    edit scope — M-8, closed on contract end (M-9)
import { modelScopesOf } from '../domain/model-scope.mjs';

/**
 * @param {{ descendantTaskIds: (id: string) => Promise<string[]>, loadPlan: (projectId: string) => Promise<object> }} store
 *   planning pg-store
 */
export function createPlanningTaskPort(store) {
  return {
    async descendantIds(taskId) {
      return store.descendantTaskIds(taskId);
    },

    async modelScopes(projectId) {
      const plan = await store.loadPlan(projectId);
      return modelScopesOf(plan);
    },
  };
}
