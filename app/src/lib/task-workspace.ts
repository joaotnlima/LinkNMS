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

// ── In-place drawer addresses (LINA-404) ─────────────────────────────────────
// The address the LIVE editor puts in the bar must stay on the mounted `/plan`
// route. In Next 15 `history.replaceState` syncs the App Router's canonical URL,
// and every server action (autosave, status, workspace load) implicitly
// revalidates THAT url. Pointing it at a sibling page (`/plan/tasks/:key`) or a
// redirect (`/plan/build`) turned each save into a navigation — a full remount
// that blanked the page and threw the in-memory draft away (the founder's "this
// page should never refresh"). Expressing the open task as a query on `/plan`
// keeps the route put, so the revalidation refreshes RSC in place and preserves
// client state. `taskPath` above is kept for the standalone shareable permalink
// page, which is a real navigation and so is unaffected.

/** The drawer-open address on the plan route itself — never a sibling route. */
export function taskHref(projectId: string, stageKey: string): string {
  return `/projects/${encodeURIComponent(projectId)}/plan?task=${encodeURIComponent(stageKey)}`;
}

/** The drawer-closed address — the bare plan route. */
export function planHref(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/plan`;
}
