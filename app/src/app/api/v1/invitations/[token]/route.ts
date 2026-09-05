// GET /api/v1/invitations/:token — the unauthenticated preview behind the
// Band B accept deep link (M6/D6, LINA-182). Unlike every other route here it
// requires NO session: the visitor is signed out, the token IS the credential
// (ADR-0004 in reverse — the caller is the invitee who has not signed up yet).
// The handler rate-limits this read and the service returns a uniform 404 for
// unknown and spent tokens, so it cannot probe token validity.
// The service handler is reached with whatever session exists (usually none) —
// it simply ignores it.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handle(req, ctx, (c) => container().http.identity.previewInvitation(c));
}