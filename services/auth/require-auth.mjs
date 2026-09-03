// Auth — the request authorization path (LINA-143; Auth Bridge §3).
//
// This is the framework-agnostic `requireAuth` + `authorize` from §3, expressed
// for the actual repo boundary (next/gateway or any Fastify route) rather than
// as a framework plugin. A transport route calls `requireAuth` to turn a raw
// Bearer token into a verified local actor, then `authorize(action, resource)` to
// run the `can()` verdict; the business logic runs only on allow.
//
//   1. verifyToken(verified JWT)  ──────────────────  ✓ / ✗ → 401
//   2. resolve local actor by clerk_user_id         ── miss → JIT provision (§5 B)
//   3. attach actor { userId, activeOrgId }
//   4. authorize(action, resource): can(...)        ── deny → 403
//
// Actor identity is derived ONLY from the verified token (never the body) and
// `can()` is the sole authorizer — both ADR-0004 invariants carried forward.
import { unauthenticated, forbidden, AuthError } from './errors.mjs';

/**
 * @param {Object} deps
 * @param {ReturnType<import('./store.mjs').createMemoryAuthStore>} deps.store
 * @param {ReturnType<import('./sync.mjs').createAuthSyncService>} deps.sync
 * @param {import('./clerk.mjs').VerifyToken} deps.verifyToken
 * @param {(actor, action, ctx) => { allow: boolean, reason?: string }} deps.can
 */
export function createAuthRequestPath({ store, sync, verifyToken, can }) {
  if (!store || !sync || !verifyToken || !can) {
    throw new Error('createAuthRequestPath requires store, sync, verifyToken, and can');
  }

  /**
   * Verify a raw Bearer token and resolve (JIT-provisioning) the local actor.
   * Throws 401 when the token is invalid or the account is disabled; returns
   * `{ userId, clerkUserId, activeOrgId }`.
   * @param {string} token  the raw `Authorization: Bearer …` value
   */
  async function requireAuth(token) {
    if (!token || typeof token !== 'string') throw unauthenticated();
    let claims;
    try {
      claims = await verifyToken(token);
    } catch {
      throw unauthenticated();
    }
    if (!claims?.sub) throw unauthenticated();

    // JIT provisioning (Auth Bridge §5 B): guarantees a users row exists before
    // can(). Throws 403 when the local account is disabled.
    const user = await sync.jitProvisionUser({
      clerkUserId: claims.sub,
      email: claims.email,
    });

    // The token's active org is a CLERK id; the authz verdict needs the LOCAL
    // authz.orgs.id. Translate it here so downstream `authorize` reads the
    // `authz` catalog purely in local id space (never mixing schemas). When the
    // org is not yet mirrored locally, activeOrgId stays null and `authorize`
    // refuses scoped work until the org is provisioned (fails closed).
    let activeOrgId = null;
    if (claims.activeOrgId) {
      const localOrg = await store.getOrgByClerkId(claims.activeOrgId);
      if (localOrg) activeOrgId = localOrg.id;
    }

    return { userId: user.id, clerkUserId: user.clerkUserId, activeOrgId };
  }

  /**
   * Run the can() verdict for an authenticated actor against a permission verb.
   * Resolves the actor's membership + role permissions + resource ACLs from the
   * `authz` catalog server-side, then calls the pure `can()`. Throws 403 on
   * deny. Returns the granted context on allow.
   * @param {Object} actor                from requireAuth
   * @param {string} action               one of PERMISSION.*
   * @param {{ type: string, id?: string, proposedBy?: string }} [resource]
   */
  async function authorize(actor, action, resource) {
    if (!actor?.userId) throw unauthenticated();

    const resourceType = resource?.type;
    const orgId = actor.activeOrgId;

    // Scoped verbs need a resource type to evaluate ACLs; the pure can() will
    // deny-before that if we pass nothing, but we resolve ACLs only when scoped.
    const [membership, rolePermissions, resourceAcls] = await Promise.all([
      orgId ? store.getMembership(actor.userId, orgId) : Promise.resolve(null),
      orgId ? resolveRolePermissions(store, actor, orgId) : Promise.resolve([]),
      resourceType
        ? store.getResourceAcls(actor.userId, resourceType, resource?.id ?? null)
        : Promise.resolve([]),
    ]);

    const decision = can(
      {
        actor: { userId: actor.userId, activeOrgId: orgId },
        action,
        resource,
        membership,
        rolePermissions,
        resourceAcls,
      },
    );

    if (!decision.allow) throw forbidden(decision.reason);
    return { actor, action, resource, membership };
  }

  return { requireAuth, authorize };
}

// Resolve the permission keys the actor's role (on the active org) grants.
async function resolveRolePermissions(store, actor, orgId) {
  const membership = await store.getMembership(actor.userId, orgId);
  if (!membership?.roleId) return [];
  return store.getRolePermissions(membership.roleId);
}

export { AuthError };
