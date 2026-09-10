// GET  /api/v1/me/plan-template — resolve the caller's default plan scaffold
// PUT  /api/v1/me/plan-template — "save as my default" (upsert the caller's one
//                                 user default from a posted { name?, body })
//
// Plan templates (LINA-241; ADR-0018) are per-USER and project-independent, so
// they live under the `/me` namespace next to /api/v1/me and /api/v1/me/profile —
// NOT under /projects/:id. A template is a names-only scaffold with no audit
// weight: `seedSkeleton()` GETs this to pre-fill a fresh editor draft, and "Save
// as my default" PUTs the current draft back. Nothing here touches a project,
// stage, version, or the ledger.
//
// Like every route under api/v1, this file holds NO domain logic: `handle()`
// resolves the acting party from the verified Clerk session (ADR-0004 — never
// from the body, so a forged owner is inert) and the schedule service owns the
// resolve ladder, validation, and the single-default upsert.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  return handle(req, undefined, (c) => container().http.schedule.resolvePlanTemplate(c));
}

export function PUT(req: Request) {
  return handle(req, undefined, (c) => container().http.schedule.savePlanTemplate(c));
}
