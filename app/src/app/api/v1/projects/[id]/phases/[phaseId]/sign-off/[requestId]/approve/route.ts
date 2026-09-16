// POST /api/v1/projects/:id/phases/:phaseId/sign-off/:requestId/approve — sign
// the plan off (LINA-278, ADR-0023). Resolves the request and flips the phase to
// `signed_off` (one-way) in one transaction. May NOT be approved by the party
// who requested it. Optional { comment }. Contract: ADR-0023 §Sign-off.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; phaseId: string; requestId: string }> },
) {
  return handle(req, ctx, (c) => container().http.schedule.approveSignOff(c));
}
