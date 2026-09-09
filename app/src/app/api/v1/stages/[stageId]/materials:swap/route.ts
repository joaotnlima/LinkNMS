// POST /api/v1/stages/:stageId/materials:swap — record a post-baseline movement
// (D15/D16, Slice B3 contract §3b route 4): scope_change opens a change order
// (costDelta = valueDelta, server-derived) + linked movement + ledger event;
// price_movement writes the movement + ledger event only. GC/counterparty.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ stageId: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.swapMaterial(c));
}