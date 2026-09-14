// POST /api/v1/projects/:id/procurement/rfp:send — mail a fresh, single-use link
// to every invited contractor and flip draft→sent (LINA-279, ADR-0023 §7,
// ADR-0007 §5). Fail-closed BEFORE minting: unconfigured email is a loud 503.
// Returns the full procurement view the FE swaps in. MANAGE_RFP.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.sendProcurementRfp(c));
}