// Auth — identity sync + JIT provisioning (LINA-143; Auth Bridge §5).
//
// §5 recommends "A + B together": Clerk webhooks (A) as the authoritative,
// near-real-time sync of users/orgs/memberships, and JIT provisioning (B) as the
// safety net that guarantees a `users` row exists before `can()` runs even if a
// webhook was missed.
//
// BOTH paths are handled here, idempotently (upsert on clerk_user_id /
// clerk_org_id). The webhook handler (`handleWebhookEvent`) is driven by
// Svix-verified events (see ./svix.mjs + ./webhook.mjs); `jitProvisionUser`
// is the requireAuth miss-path that guarantees a local actor before the route's
// `can()` call.
//
// Security properties:
//   * `clerkUserId` always comes from the verified token / verified webhook
//     event — never from a caller-chosen id (ADR-0004).
//   * A disabled local user is a hard stop: `jitProvisionUser` returns the user
//     but requireAuth refuses to mint an actor for a non-active status.
//   * Role keys are validated against the seeded system roles before a
//     membership is written.
import { conflict, forbidden } from './errors.mjs';

const SYSTEM_ROLES = new Set(['owner', 'gc', 'subcontractor']);

/**
 * @param {Object} deps
 * @param {ReturnType<import('./store.mjs').createMemoryAuthStore>} deps.store
 */
export function createAuthSyncService({ store }) {
  if (!store) throw new Error('auth sync service requires a store');

  /**
   * JIT provisioning (Auth Bridge §5 B). Look up the user by Clerk id; if the
   * row is missing (a missed webhook or a first request before user.created),
   * upsert it. Returns the local actor or throws 403 when the user is disabled.
   * @param {{ clerkUserId: string, email?: string, displayName?: string }} input
   */
  async function jitProvisionUser({ clerkUserId, email, displayName }) {
    if (!clerkUserId) throw new Error('jitProvisionUser requires a clerkUserId');
    // Always apply the verified token's claims (idempotent upsert); a disabled
    // status is preserved by the store and enforced below.
    const user = await store.upsertUser({ clerkUserId, email, displayName });
    if (user.status !== 'active') {
      throw forbidden('account is disabled');
    }
    return user;
  }

  /**
   * SV = Svix-verified Clerk webhook event handler. Idempotent; the only
   * un-handled return is an unknown event type (which the caller treats as a
   * benign 200 skip).
   * @param {{ type: string, data: any }} input
   * @returns {Promise<{ handled: boolean, kind?: string }>}
   */
  async function handleWebhookEvent({ type, data = {} }) {
    switch (type) {
      case 'user.created':
      case 'user.updated': {
        await store.upsertUser({
          clerkUserId: data.id,
          email: data.email_addresses?.[0]?.email_address,
          displayName: data.first_name || data.last_name || data.username
            ? [data.first_name, data.last_name].filter(Boolean).join(' ') || data.username
            : undefined,
        });
        return { handled: true, kind: 'user' };
      }
      case 'user.deleted': {
        if (data.id) await store.setUserStatus(data.id, 'disabled');
        return { handled: true, kind: 'user' };
      }
      case 'organization.created':
      case 'organization.updated': {
        await store.upsertOrg({ clerkOrgId: data.id, name: data.name });
        return { handled: true, kind: 'org' };
      }
      case 'organizationMembership.created':
      case 'organizationMembership.updated': {
        const userId = data.public_user_data?.user_id ?? data.user_id;
        const orgId = data.organization?.id ?? data.organization_id;
        if (!userId || !orgId) return { handled: false };
        // Clerk's org role is treated as a HINT only (Auth Bridge §6); the
        // binding role is the Neon `authz.roles` system role. Map common Clerk
        // org roles to our system roles; anything unrecognised maps to the
        // least-privilege subcontractor seat rather than failing the sync.
        const roleKey = mapClerkRole((data.role || '').toLowerCase());
        await store.setMembership({ clerkUserId: userId, clerkOrgId: orgId, roleKey });
        return { handled: true, kind: 'membership' };
      }
      case 'organizationMembership.deleted': {
        const userId = data.public_user_data?.user_id ?? data.user_id;
        const orgId = data.organization?.id ?? data.organization_id;
        if (userId && orgId) await store.removeMembership({ clerkUserId: userId, clerkOrgId: orgId });
        return { handled: true, kind: 'membership' };
      }
      default:
        return { handled: false };
    }
  }

  /**
   * Apply a membership (used by the account-setup endpoint LINA-137 and JIT).
   * Validates the role key against the system roles so a caller can never grant
   * itself an unseeded privilege.
   * @param {{ clerkUserId: string, clerkOrgId: string, roleKey: string }} input
   */
  async function grantMembership({ clerkUserId, clerkOrgId, roleKey }) {
    if (!SYSTEM_ROLES.has(roleKey)) {
      throw conflict(`role "${roleKey}" is not a seated system role`);
    }
    return store.setMembership({ clerkUserId, clerkOrgId, roleKey });
  }

  return { jitProvisionUser, handleWebhookEvent, grantMembership };
}

// Clerk org role → our system role (hint → binding, Auth Bridge §6).
function mapClerkRole(clerkRole) {
  if (clerkRole === 'org:admin' || clerkRole === 'admin') return 'owner';
  if (clerkRole === 'org:member' || clerkRole === 'basic_member' || clerkRole === 'member') return 'gc';
  return 'subcontractor';
}
