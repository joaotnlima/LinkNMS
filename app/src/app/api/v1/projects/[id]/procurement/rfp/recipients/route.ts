// POST /api/v1/projects/:id/procurement/rfp/recipients — add invitees (LINA-279).
// Body { emails: string[] } is normalised + deduped server-side; the response is
// the FULL recipient list so the page re-renders from one payload. MANAGE_RFP.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.addRfpRecipients(c));
}