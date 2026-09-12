// GET /api/v1/projects/:id/plan/stages/:stageKey/workspace — the task workspace
// (LINA-249): { comments, attachments } for one stage, oldest → newest, in a
// single fetch for the drawer/page. Project members only. Distinct from a
// private plan draft: comments are shared build context, readable by every
// member. Contract: docs/architecture/slice-task-workspace-contract.md.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function GET(req: Request, ctx: { params: Promise<{ id: string; stageKey: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.getWorkspace(c));
}