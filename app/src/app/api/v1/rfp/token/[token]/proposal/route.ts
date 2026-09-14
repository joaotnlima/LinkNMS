// POST /api/v1/rfp/token/:token/proposal — submit a proposal as an external,
// unauthenticated contractor (LINA-279, ADR-0023 §5). No session. The service
// re-validates per request (LINA-294 order): unknown/declined → 404,
// already submitted → 409, closed phase → 410 rfp_closed, malformed body → 400
// invalid_proposal. The proposal INSERT and the recipient submitted-stamp
// commit in ONE transaction; a second submit of the same token is a 409.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.submitRfpProposal(c));
}