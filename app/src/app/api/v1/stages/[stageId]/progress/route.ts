// POST /api/v1/stages/:stageId/progress — append a progress report (FR-P3, spec
// §8.1). Append-only: a new attributed, time-stamped entry; the current status is
// derived from the latest. GC-only (spec §8.2); a homeowner attempt is a 403.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ stageId: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.reportProgress(c));
}
