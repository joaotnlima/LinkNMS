// /api/v1/projects — POST starts a shared record with a baseline budget (FR1);
// GET lists the acting party's own builds (portfolio, LINA-197 / ADR-0012 §A1).
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function POST(req: Request) {
  return handle(req, undefined, (ctx) => container().http.identity.createProject(ctx));
}

export function GET(req: Request) {
  return handle(req, undefined, (ctx) => container().http.identity.listProjects(ctx));
}
