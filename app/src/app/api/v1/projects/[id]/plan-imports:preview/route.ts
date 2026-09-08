// POST /api/v1/projects/:id/plan-imports:preview — the derived WBS tree,
// warnings and errors for a sheet + mapping (D9→D10, LINA-206; contract §2
// route 3). GC-only; no writes — the client's preview is never the write payload.
import { handleUpload, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleUpload(req, ctx, (c) => container().http.schedule.previewPlanImport(c));
}
