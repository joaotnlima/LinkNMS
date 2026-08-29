// Establishing a session — the ONE implementation (LINA-57).
//
// Two callers need this: the JSON endpoint POST /api/v1/sessions, and the
// sign-in form the UI cutover needs so a homeowner can actually reach FR1.
// Duplicating it would mean two copies of the `LINKNMS_OPEN_SIGNIN` gate, and a
// gate that exists in two places is a gate that eventually only closes in one.
//
// ⚠️ SECURITY SCOPE — unchanged from LINA-56, restated because this is now the
// only place it is enforced. ADR-0001 specifies magic-link sessions: a party
// proves control of an email address, then gets a cookie. The COOKIE half is
// real and production-grade (HMAC-signed, httpOnly, signed expiry). The PROOF
// half needs an email integration that does not exist yet. So this trades an
// email for a session with NO proof and is refused unless LINKNMS_OPEN_SIGNIN=1
// is explicitly set. Off by default: a deploy that forgets to configure it has
// no sign-in rather than an open one.
import { headers } from 'next/headers';
import { getContainer } from '@services/gateway/container.mjs';
import { mintSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from '@services/identity/session.mjs';

export { SESSION_COOKIE, SESSION_TTL_SECONDS };

export const openSignInEnabled = () => process.env.LINKNMS_OPEN_SIGNIN === '1';

// `Secure` must not be set over plain http or local dev can never hold a
// session. Everything deployed is https.
export const secureCookies = () => process.env.NODE_ENV === 'production';

export interface SignInResult {
  partyId: string;
  party: { id: string; displayName: string; email: string; role: string };
  token: string;
  expiresAt: string | number;
}

export class SignInDisabledError extends Error {
  // 404, not 403: an endpoint that is not enabled should not advertise itself.
  status = 404;
  code = 'not_found';
  constructor() {
    super('not found');
    this.name = 'SignInDisabledError';
  }
}

/**
 * Find-or-create the party for `email` and mint a session token for it.
 * Throws SignInDisabledError when open sign-in is off, and the identity
 * service's own typed errors (400 on a malformed address) otherwise.
 *
 * Returns the raw token; the caller decides how to deliver it as a cookie (a
 * Set-Cookie header in the route, `cookies().set` in a server action).
 */
export async function signIn(input: { email?: string; displayName?: string; role?: string }): Promise<SignInResult> {
  if (!openSignInEnabled()) throw new SignInDisabledError();

  const party = await getContainer().parties.findOrCreateByEmail({
    email: input?.email,
    displayName: input?.displayName,
    role: input?.role ?? 'contractor',
  });
  const { token, expiresAt } = mintSession({ partyId: party.id });
  return { partyId: party.id, party, token, expiresAt };
}

// ── Magic-link sign-in — the PROOF half (LINA-76, ADR-0007) ──────────────────
//
// The real production front door (open sign-in above is the demo one). This is
// the server-action side of POST /api/v1/sessions/request: it derives the public
// origin and client IP from the request headers and hands them to the sign-in
// service, which mints a single-use token and emails it. It resolves the SAME
// way whether or not the email is known (ADR-0007 §4); the only throw is a 503
// when email delivery is unconfigured (fail closed, §5) or a 502 on send failure
// — both of which the action surfaces as a retry message, never as an oracle.
export async function requestSignInLink(input: {
  email?: string;
  displayName?: string;
  next?: string;
}): Promise<void> {
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const baseUrl = (process.env.APP_BASE_URL ?? `${proto}://${host}`).replace(/\/+$/, '');
  const xff = h.get('x-forwarded-for');
  const ip = xff ? xff.split(',')[0].trim() || null : h.get('x-real-ip');

  await getContainer().signIn.request({
    email: input.email,
    displayName: input.displayName,
    next: input.next,
    ip,
    baseUrl,
  });
}

/** Cookie attributes matching services/identity/session.mjs's Set-Cookie flags. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
    secure: secureCookies(),
  };
}
