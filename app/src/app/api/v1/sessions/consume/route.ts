// POST /api/v1/sessions/consume — the "proof" half of sign-in, step 2
// (LINA-76, ADR-0007). Body `{ token }` → atomically spend the single-use token,
// find-or-create the party, and mint the session cookie. The response shape
// matches POST /api/v1/sessions exactly ({ partyId, party, expiresAt } + cookie),
// so the frontend has one session shape regardless of which door was used.
//
// Every failure mode — expired, already used, unknown, malformed — is the same
// 400 invalid_token (ADR-0007 §4). The atomic single-use guarantee (two
// concurrent consumes → one session) lives in the service's conditional UPDATE.
import { NextResponse } from 'next/server';
import { container } from '@/server/gateway';
import { mintSession, sessionCookie, SESSION_TTL_SECONDS } from '@services/identity/session.mjs';

export const dynamic = 'force-dynamic';

// Cookies must not carry `Secure` over plain http, or local dev can never hold a
// session. Everything deployed is https. (Same rule as sessions/route.ts.)
const secureCookies = () => process.env.NODE_ENV === 'production';

export async function POST(req: Request) {
  let body: { token?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const { party } = await container().signIn.consume({ token: body?.token });
    const { token, expiresAt } = mintSession({ partyId: party.id });
    const res = NextResponse.json({ partyId: party.id, party, expiresAt }, { status: 201 });
    res.headers.set('set-cookie', sessionCookie(token, {
      ttlSeconds: SESSION_TTL_SECONDS,
      secure: secureCookies(),
    }));
    res.headers.set('cache-control', 'no-store');
    return res;
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    if (typeof e.status === 'number' && typeof e.code === 'string') {
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    }
    console.error('[api] sign-in consume failed', err);
    return NextResponse.json({ error: { code: 'internal', message: 'internal error' } }, { status: 500 });
  }
}
