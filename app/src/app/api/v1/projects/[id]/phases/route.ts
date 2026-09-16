// GET /api/v1/projects/:id/phases — the project's phase list (procurement,
// execution) with each phase's sign-off request history (LINA-278, ADR-0023).
// Both parties read. Legacy projects are lazily seeded their two default phases
// on first read. Contract: ADR-0023 §Phase lifecycle.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.listPhases(c));
}
