// GET /api/v1/projects/:id/procurement — the whole procurement view: phase,
// live RFP (or null), invitees, and the proposals inbox (LINA-279, ADR-0023 §4).
// Reads gate on VIEW_RFP inside the service; the acting party comes from the
// session (ADR-0004). Contract: services/schedule/docs/... (procurement.md).
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.getProcurement(c));
}