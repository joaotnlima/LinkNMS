// GET /api/v1/projects/:id/status — the four-pillar panel (design §5, FR9),
// derived entirely ledger-side. The frontend renders it; it never recomputes it.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';


export function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.ledger.getStatus(c));
}
