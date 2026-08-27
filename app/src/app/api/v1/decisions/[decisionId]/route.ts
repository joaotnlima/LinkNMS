// PATCH /api/v1/decisions/:decisionId — append the next revision (FR2).
// Rev 1 is never overwritten; the author and timestamp are server-side.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function PATCH(req: Request, ctx: { params: Promise<{ decisionId: string }> }) {
  return handle(req, ctx, (c) => container().http.decision.reviseDecision(c));
}
