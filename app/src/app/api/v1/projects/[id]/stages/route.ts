// POST /api/v1/projects/:id/stages — add a construction stage to the plan (FR-P1).
// GC-only (spec §8.2): a homeowner attempt is a typed 403, never a 500.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.addStage(c));
}
