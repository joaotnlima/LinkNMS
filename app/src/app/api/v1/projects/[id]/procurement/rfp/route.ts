// PUT /api/v1/projects/:id/procurement/rfp — the draft upsert (LINA-279).
// Body { description, specialties }. Creates the live draft on first save and
// updates it on every keystroke; refused with 409 rfp_already_sent once the RFP
// has gone out. MANAGE_RFP from the session (ADR-0004).
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.saveRfpDraft(c));
}