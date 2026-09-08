// POST /api/v1/projects/:id/plan-imports:inspect — list the sheets in an
// uploaded .xlsx so the GC can pick one (D8, LINA-206; contract §2 route 1).
// GC-only; no writes. Multipart upload → the service parses the bytes server-side.
import { handleUpload, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleUpload(req, ctx, (c) => container().http.schedule.inspectPlanImport(c));
}
