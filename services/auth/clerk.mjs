// Auth — Clerk JWT verification wrapper (LINA-143; Auth Bridge §3 step 1–2).
//
// "Authentication" is delegated to Clerk; we do NOT hand-roll JWT crypto
// (LINA-121 "no shortcuts"; Architect §8.2). This module wraps `@clerk/backend`
// `createClerkClient().authenticateRequest`-style token verification so the rest
// of the auth service is testable without the SDK (a verifier PORT is injected).
//
// When `@clerk/backend` is installed, `createClerkVerifier` builds a real
// verifier from the SDK. The pure `requireAuth` path (./require-auth.mjs) takes
// an injected `verifyToken` so its JIT/actor logic runs zero-dep in tests; the
// deployed container wires the real SDK verifier.
//
// We verify the token and extract ONLY the claims the bridge needs:
//   sub      — the Clerk user id (the join key into authz.users)
//   orgs     — the active org mapping (active_org_id / orgs)
//   email    — used only by the JIT miss-path to seed authz.users.email
// We never trust a Clerk role/claim for a domain decision (boundary rule) —
// the authz verdict always comes from `can()` over the `authz` catalog.

/**
 * The verifier PORT. Returns the verified claims, or null when the token is
 * invalid/expired. Implementations: createClerkVerifier (real SDK) or the test
 * stub (see require-auth.test.mjs).
 * @typedef {(token: string) => Promise<{ sub: string, email?: string, activeOrgId?: string }|null>} VerifyToken
 */

/**
 * Build a real verifier from `@clerk/backend`. Optional dependency: this is
 * only invoked by the deployed composition root, not by the zero-dep tests.
 * @param {{ secretKey: string }} deps
 * @param {Object} [clerkBackend]  the `@clerk/backend` module (default: imported)
 * @returns {VerifyToken}
 */
export function createClerkVerifier({ secretKey }, clerkBackend) {
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is required for the Clerk verifier');
  if (!clerkBackend) {
    // Lazy import so the module graph loads without the SDK (tests, CI).
    // eslint-disable-next-line global-require
    throw new Error('@clerk/backend is required to verify Clerk JWTs (install it in services/)');
  }
  const client = clerkBackend.createClerkClient({ secretKey });
  return async function verifyToken(token) {
    if (!token) return null;
    try {
      const { token: payload } = await client.verifyToken(token);
      const orgId =
        payload?.org_id ??
        payload?.active_org_id ??
        Object.keys(payload?.orgs ?? {})[0];
      return {
        sub: String(payload?.sub ?? ''),
        email: payload?.email ? String(payload.email) : undefined,
        activeOrgId: orgId ? String(orgId) : undefined,
      };
    } catch {
      return null;
    }
  };
}
