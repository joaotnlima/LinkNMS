// GET /api/v1/projects/:id/budget-movement — the MoneyView (D16, Slice B3
// contract §3c): two structurally separate arrays scopeChanges vs
// priceMovements; currentBudgetCents read from the ledger, never recomputed.
// Any seated party reads.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.getBudgetMovement(c));
}