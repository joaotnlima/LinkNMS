// POST /api/v1/projects — start a shared record with a baseline budget (FR1).
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function POST(req: Request) {
  return handle(req, undefined, (ctx) => container().http.identity.createProject(ctx));
}
