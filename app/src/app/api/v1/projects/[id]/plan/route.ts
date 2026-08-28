// GET /api/v1/projects/:id/plan — the plan timeline + derived rollup (FR-P4,
// FR-P6, spec §8.3): ordered stages with current status, the headline / percent /
// current-stage pointer, and the read-only allocated-vs-baseline hint. Both
// parties read; the homeowner is a member, so this succeeds for owner and GC.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.getPlan(c));
}
