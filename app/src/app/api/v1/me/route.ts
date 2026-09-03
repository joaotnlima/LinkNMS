// GET /api/v1/me — the authenticated party's own profile.
//
// Resolves session.partyId → identity.party { displayName, email, role }.
// The portal uses displayName to greet the user by name (LINA-133/LINA-154).
// Per-user, session-scoped — cache-control: no-store prevents a shared cache
// from handing one party's identity to another.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  return handle(req, undefined, (c) => container().http.identity.getMe(c));
}
