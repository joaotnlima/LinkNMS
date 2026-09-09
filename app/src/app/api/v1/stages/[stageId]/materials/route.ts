// GET    /api/v1/stages/:stageId/materials — the materials + movements behind a
//        line (D15, Slice B3 contract §3b route 2). Any seated party reads.
// POST   /api/v1/stages/:stageId/materials — author materials (D15 route 3):
//        proposer-only, and only while the plan version is proposed.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function GET(req: Request, ctx: { params: Promise<{ stageId: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.getStageMaterials(c));
}

export function POST(req: Request, ctx: { params: Promise<{ stageId: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.authorMaterials(c));
}