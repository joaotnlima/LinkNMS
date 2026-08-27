// POST /api/v1/change-orders/:changeOrderId/decision — approve or reject (FR4,
// FR5). The two-sided rule (decider ≠ proposer) is enforced by the service AND
// by a DB CHECK; an approval moves the budget exactly once.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ changeOrderId: string }> }) {
  return handle(req, ctx, (c) => container().http.changeOrder.decideChangeOrder(c));
}
