// POST   /api/v1/sessions — establish a session (who is acting).
// DELETE /api/v1/sessions — sign out.
// GET    /api/v1/sessions — who am I? (the frontend's cheap auth probe)
//
// ⚠️ SECURITY SCOPE — READ BEFORE ENABLING IN PRODUCTION.
//
// ADR-0001 specifies magic-link/invite-token sessions: a party proves control of
// an email address, then gets a cookie. The *cookie* half is real and
// production-grade (services/identity/session.mjs: HMAC-signed, httpOnly, signed
// expiry). The *proof* half — sending and consuming a magic link — needs an email
// delivery integration that does not exist yet and is not in LINA-56's scope.
//
// Rather than pretend, POST here trades an email for a session with NO proof, and
// is therefore refused with 404 unless `LINKNMS_OPEN_SIGNIN=1` is explicitly set.
// It is off by default, so a deploy that forgets to configure it fails closed:
// no sign-in rather than an open one. Enable it only on preview/demo
// environments. Real magic-link sign-in is tracked as a follow-up.
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { container, currentSession } from '@/server/gateway';

// @ts-expect-error — .mjs service module
import { mintSession, sessionCookie, clearSessionCookie, SESSION_TTL_SECONDS } from '@services/identity/session.mjs';

export const dynamic = 'force-dynamic';

const openSignInEnabled = () => process.env.LINKNMS_OPEN_SIGNIN === '1';
// Cookies must not carry `Secure` over plain http, or local dev can never hold a
// session. Everything deployed is https.
const secureCookies = () => process.env.NODE_ENV === 'production';

export async function GET() {
  const session = await currentSession();
  if (!session) {
    return NextResponse.json(
      { error: { code: 'unauthenticated', message: 'no acting party in session' } },
      { status: 401 },
    );
  }
  const party = await container().parties.getById(session.partyId);
  return NextResponse.json({ partyId: session.partyId, party: party ?? null });
}

export async function POST(req: Request) {
  if (!openSignInEnabled()) {
    // 404, not 403: an endpoint that is not enabled should not advertise itself.
    return NextResponse.json(
      { error: { code: 'not_found', message: 'not found' } },
      { status: 404 },
    );
  }
  let body: { email?: string; displayName?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'a JSON body with an email is required' } },
      { status: 400 },
    );
  }

  try {
    const party = await container().parties.findOrCreateByEmail({
      email: body?.email,
      displayName: body?.displayName,
      role: body?.role ?? 'contractor',
    });
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
    console.error('[api] sign-in failed', err);
    return NextResponse.json(
      { error: { code: 'internal', message: 'internal error' } },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  // Clearing is unconditional and idempotent — signing out without a session is
  // a success, not an error.
  await cookies();
  const res = new NextResponse(null, { status: 204 });
  res.headers.set('set-cookie', clearSessionCookie({ secure: secureCookies() }));
  return res;
}
