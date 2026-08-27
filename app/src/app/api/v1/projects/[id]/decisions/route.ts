// GET  /api/v1/projects/:id/decisions — full history, chronological (FR7).
// POST /api/v1/projects/:id/decisions — record a decision, revision 1 (FR2).
//
// The Decision service names the path param `projectId`; the Next segment is
// `[id]` to match the sibling project routes, so it is renamed here rather than
// duplicating the segment name across the tree.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

const withProjectId = (c: { params: Record<string, string> }) => ({
  ...c,
  params: { projectId: c.params.id },
});

export function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.decision.listDecisions(withProjectId(c)));
}

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.decision.recordDecision(withProjectId(c)));
}
