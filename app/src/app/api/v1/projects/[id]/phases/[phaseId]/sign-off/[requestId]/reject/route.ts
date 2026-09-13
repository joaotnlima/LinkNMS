// POST /api/v1/projects/:id/phases/:phaseId/sign-off/:requestId/reject — decline
// a sign-off request (LINA-278, ADR-0023). The phase stays `active` (still
// editable); the optional { comment } is returned to the requester as the
// resolution_comment. Contract: ADR-0023 §Sign-off.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; phaseId: string; requestId: string }> },
) {
  return handle(req, ctx, (c) => container().http.schedule.rejectSignOff(c));
}
