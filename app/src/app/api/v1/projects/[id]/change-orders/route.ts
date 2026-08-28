// GET  /api/v1/projects/:id/change-orders — all COs, chronological (FR7).
// POST /api/v1/projects/:id/change-orders — raise a CO, opens *proposed* (FR3, FR8).
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';


export function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.changeOrder.listChangeOrders(c));
}

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.changeOrder.proposeChangeOrder(c));
}
