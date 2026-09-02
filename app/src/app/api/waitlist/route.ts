// POST /api/waitlist — the D-4 email capture (LINA-127, Onboarding Plan v4 Phase 1).
//
// Unauthenticated prospect capture. The waitlist service owns no session, so this
// passes through the shared gateway `handle`, which reads a session only if one
// is present (returns null here) and funnels the PostHog flush. The acting-party
// rule from ADR-0004 does not apply — there is no party to authorize; the service
// validates the email and writes the signup.
import { handle, container } from '@/server/gateway';

// Every API route hits Postgres and the services container.
export const dynamic = 'force-dynamic';

export function POST(req: Request) {
  return handle(req, undefined, (c) => container().http.waitlist.subscribe(c));
}
