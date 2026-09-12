// POST /api/v1/projects/:id/plan/stages/:stageKey/comments — append a task
// comment (LINA-249), body { body }. The author is stamped server-side from the
// session party (ADR-0004) — the client never names the actor. Append-only:
// comments are not editable or deletable in v1. Project members only.
// Contract: docs/architecture/slice-task-workspace-contract.md.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ id: string; stageKey: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.addStageComment(c));
}