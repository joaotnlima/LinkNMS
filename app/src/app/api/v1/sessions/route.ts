// GET /api/v1/sessions — who am I? (the frontend's cheap auth probe)
//
// ── WHAT THIS ROUTE LOST IN LINA-124 (Auth Migration 0B) ─────────────────────
// `POST` (establish a session) and `DELETE` (sign out) are GONE, along with
// their siblings `sessions/request` and `sessions/consume`. Creating and ending
// a session is Clerk's job now: the browser gets one through Clerk's own
// components on /sign-in and /sign-up, and drops it through Clerk's `signOut()`.
// Nothing in this app mints, signs, or clears a session cookie any more, which
// is the point — a second minting path is a second thing to get wrong.
//
// `POST` in particular carried the `LINKNMS_OPEN_SIGNIN=1` no-proof door (trade
// an email for a session). It is deleted rather than defaulted-off: a sign-in
// that needs no proof of anything eventually gets enabled somewhere it matters.
//
// What survives is the read: given the request's Clerk session, which party is
// acting on the record. That answer still comes from `currentSession()` — the
// one authority — so this route stays two lines of its own logic.
import { NextResponse } from 'next/server';
import { container, currentSession } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await currentSession();
  if (!session) {
    return NextResponse.json(
      { error: { code: 'unauthenticated', message: 'no acting party in session' } },
      { status: 401 },
    );
  }
  const party = await container().parties.getById(session.partyId);
  const res = NextResponse.json({ partyId: session.partyId, party: party ?? null });
  // Per-user and session-scoped: never let a shared cache hold one party's
  // identity and hand it to the next caller.
  res.headers.set('cache-control', 'no-store');
  return res;
}
