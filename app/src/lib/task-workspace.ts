// Task permalink helper (LINA-250).
//
// The v1 task-workspace client (the drawer's read/comment/attachment calls) was
// cut to v2 in LINA-399 (Phase 12b.9) and removed with the rest of the v1 API in
// LINA-387 (Phase 12c). The one survivor is the pure permalink builder below:
// `PlanBuildEditor` uses it to address a task, and it never touched the network.

/** The permalink for one task — the address the drawer copies and the URL bar shows. */
export function taskPath(projectId: string, stageKey: string): string {
  return `/projects/${encodeURIComponent(projectId)}/plan/tasks/${encodeURIComponent(stageKey)}`;
}
