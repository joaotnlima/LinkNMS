// Session cookies — how the API layer learns WHO is acting (ADR-0001 "auth",
// ADR-0004 "never from the body"; design §6; LINA-56).
//
// R0 has no IdP. What every handler actually needs is one thing: a trustworthy
// `partyId` that the client cannot forge. That is exactly what this module
// provides — a compact HMAC-SHA256-signed token carried in an httpOnly cookie:
//
//     v1.<base64url(payload json)>.<base64url(hmac-sha256(secret, payload))>
//
// Properties that matter:
//   * SIGNED, not encrypted — the payload is only a party UUID and timestamps,
//     no secret. Tampering with it invalidates the signature.
//   * Compared with `timingSafeEqual`, so signature checking leaks no timing.
//   * `exp` is inside the signed payload, so an expired cookie cannot be revived
//     by editing the browser's cookie expiry.
//   * httpOnly + secure + sameSite=lax — not readable by scripts, not sent
//     cross-site on state-changing requests.
//
// SCOPE NOTE (raised deliberately, not buried): this module verifies a session,
// it does not ESTABLISH identity. Minting one still needs a proof-of-identity
// step — the magic-link email of ADR-0001. That delivery path does not exist
// yet, so the sign-in route that calls `mintSession` is gated behind an explicit
// environment flag and is off by default. See app/src/app/api/v1/sessions/route.ts.
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export const SESSION_COOKIE = 'lnms_session';

// 30 days: long enough that a homeowner checking in weekly stays signed in,
// short enough that a leaked cookie is not indefinite.
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function secretOf(secret) {
  const s = secret ?? process.env.SESSION_SECRET;
  // Fail closed and loudly. A default/empty secret would make every session
  // forgeable — that is a silent authentication bypass, never a convenience.
  if (!s || String(s).length < 32) {
    throw new Error('SESSION_SECRET is required and must be at least 32 characters');
  }
  return String(s);
}

function sign(payloadB64, secret) {
  return createHmac('sha256', secret).update(payloadB64).digest();
}

/**
 * Mint a signed session token for a party.
 * @param {{ partyId: string }} claims
 * @param {{ secret?: string, ttlSeconds?: number, now?: number }} [opts]
 * @returns {{ token: string, expiresAt: string }}
 */
export function mintSession({ partyId }, { secret, ttlSeconds = SESSION_TTL_SECONDS, now = Date.now() } = {}) {
  if (!partyId) throw new Error('mintSession requires a partyId');
  const key = secretOf(secret);
  const iat = Math.floor(now / 1000);
  const payload = { sub: partyId, iat, exp: iat + ttlSeconds, jti: randomUUID() };
  const payloadB64 = b64url(JSON.stringify(payload));
  const token = `v1.${payloadB64}.${b64url(sign(payloadB64, key))}`;
  return { token, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

/**
 * Verify a session token. Returns `{ partyId, expiresAt }` or null — never
 * throws on a bad token, because a malformed cookie is an ordinary anonymous
 * request, not a server error. (A missing SESSION_SECRET DOES throw: that is a
 * misconfiguration, and treating it as "anonymous" would hide it.)
 * @returns {{ partyId: string, expiresAt: string } | null}
 */
export function verifySession(token, { secret, now = Date.now() } = {}) {
  const key = secretOf(secret);
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payloadB64, sigB64] = parts;

  const expected = sign(payloadB64, key);
  let given;
  try { given = Buffer.from(sigB64, 'base64url'); } catch { return null; }
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload?.sub || typeof payload.exp !== 'number') return null;
  if (payload.exp * 1000 <= now) return null; // expiry is signed, so not forgeable

  return { partyId: payload.sub, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

/**
 * The `Set-Cookie` value for a minted session. Kept here (not in the Next route)
 * so the flags are defined once and cannot drift between routes.
 * @param {string} token
 * @param {{ ttlSeconds?: number, secure?: boolean }} [opts]
 */
export function sessionCookie(token, { ttlSeconds = SESSION_TTL_SECONDS, secure = true } = {}) {
  const flags = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ttlSeconds}`,
  ];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

/** The `Set-Cookie` value that clears a session (sign-out). */
export function clearSessionCookie({ secure = true } = {}) {
  const flags = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}
