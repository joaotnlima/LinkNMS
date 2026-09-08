// POST /api/v1/projects/:id/plan-imports:confirm — the single write: re-parse
// server-side, then ONE transaction (one plan_import ledger event + the stage
// projection), idempotent on idempotencyKey (D10, LINA-206; contract §2 route 4,
// §4). GC-only. Returns 201 with { importId, auditEventId, stageCount, rootCount }.
import { handleUpload, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleUpload(req, ctx, (c) => container().http.schedule.confirmPlanImport(c));
}
