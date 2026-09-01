// GET   /api/v1/stages/:stageId — one stage + its full attributed progress
//        history (FR-P3, AC-P3): the whole progression, no earlier report lost.
//        Both parties read.
// PATCH /api/v1/stages/:stageId — edit or reorder a stage (FR-P1). GC-only.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function GET(req: Request, ctx: { params: Promise<{ stageId: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.getStage(c));
}

export function PATCH(req: Request, ctx: { params: Promise<{ stageId: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.updateStage(c));
}
