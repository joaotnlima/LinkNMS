// POST /api/v1/projects/:id/invitations — invite the one GC (FR1). Owner only.
// The raw single-use token is in the response body exactly once; the handler
// sets `cache-control: no-store` so it never lands in a shared cache.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.identity.inviteCounterparty(c));
}
