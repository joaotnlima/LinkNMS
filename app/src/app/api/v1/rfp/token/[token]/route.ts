// GET /api/v1/rfp/token/:token — the unauthenticated RFP preview behind the
// proposal form deep link (LINA-279, ADR-0023 §5). No session: the visitor is
// signed out, the token IS the credential. Ratified LINA-294 semantics: unknown
// / revoked (declined) tokens are a uniform 404 (no oracle); a submitted token
// returns 200 WITH the proposal (the confirmation page re-reads this endpoint);
// a valid token on a closed phase is 410 rfp_closed. The raw token is never
// echoed.
// NOTE: a recipient clicking /rfp/[token] in the email reaches the FE page under
// /rfp/ — this API backs that page's data fetch.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.previewRfpToken(c));
}