// POST /api/v1/projects/:id/phases/:phaseId/sign-off — open a sign-off request
// for a phase (LINA-278, ADR-0023). Valid only when the phase is `active` and
// the plan has ≥1 task; one pending request per phase. The requester is the
// session party (ADR-0004) — never the body. Contract: ADR-0023 §Sign-off.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ id: string; phaseId: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.requestSignOff(c));
}
