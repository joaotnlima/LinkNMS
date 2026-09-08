// POST /api/v1/projects/:id/plan-imports:columns — headers + sample values for
// the chosen sheet so the GC can map columns (D9, LINA-206; contract §2 route 2).
// GC-only; no writes.
import { handleUpload, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleUpload(req, ctx, (c) => container().http.schedule.columnsPlanImport(c));
}
