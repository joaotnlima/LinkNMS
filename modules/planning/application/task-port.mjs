// The planning TASK PORT published for other modules (doc 02 rule 2) — reads
// of the plan's structure that another module needs to decide its own rule,
// without reading planning.*:
//
//   descendantIds(taskId) → string[]   live rows below a task (documents:
//                                      "also on sub-tasks", PRD-05 F-10)

/** @param {{ descendantTaskIds: (id: string) => Promise<string[]> }} store planning pg-store */
export function createPlanningTaskPort(store) {
  return {
    async descendantIds(taskId) {
      return store.descendantTaskIds(taskId);
    },
  };
}
