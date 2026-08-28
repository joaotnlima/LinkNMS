// GET  /api/v1/projects/:id/decisions — full history, chronological (FR7).
// POST /api/v1/projects/:id/decisions — record a decision, revision 1 (FR2).
//
// The Decision service names the path param `projectId` and the Next segment is
// `[id]`; `handle` exposes both, so no per-route rename is needed.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.decision.listDecisions(c));
}

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.decision.recordDecision(c));
}
