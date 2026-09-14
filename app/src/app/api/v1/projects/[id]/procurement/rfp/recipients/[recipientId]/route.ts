// DELETE /api/v1/projects/:id/procurement/rfp/recipients/:recipientId — remove
// an invitee from the DRAFT (LINA-279). The one DELETE the RFP corpus delegates
// (migration 0013): once the RFP is sent, recipients hold live tokens and the
// invite list is sealed → 409 rfp_already_sent. → 204 on success. MANAGE_RFP.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function DELETE(req: Request, ctx: { params: Promise<{ id: string; recipientId: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.removeRfpRecipient(c));
}