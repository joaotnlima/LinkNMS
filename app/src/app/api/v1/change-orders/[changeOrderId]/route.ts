// GET /api/v1/change-orders/:changeOrderId — the "one screen" answer (FR6):
// who decided, when, the cost delta, and budget before → after.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function GET(req: Request, ctx: { params: Promise<{ changeOrderId: string }> }) {
  return handle(req, ctx, (c) => container().http.changeOrder.getChangeOrder(c));
}
