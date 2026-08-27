// POST /api/v1/invitations/:token/accept — the invited GC joins (FR1).
// The token proves the invitation; the SESSION says who joins (ADR-0004).
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handle(req, ctx, (c) => container().http.identity.acceptInvitation(c));
}
