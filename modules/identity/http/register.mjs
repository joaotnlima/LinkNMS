// Identity & Access on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
//
// The router hands us the raw ViewerContext (Clerk ids only). Identity is the
// module that OWNS the mirror, so this is where the local person/org ids get
// resolved — every other module will receive them already resolved once the
// registry wires this module's resolver in front (phase 2+).
import { getMe, updateMyProfile, createOrganization, listMembers, staffPerson, unstaffPerson, clerkWebhook } from '../application/use-cases.mjs';
import { inviteMember, updateMemberRole, removeMember } from '../application/members.mjs';

/**
 * Fail closed when the composition root forgot billing's port: no seat is free.
 * @type {{ entitled: (orgId: string, key: string, context?: object) => Promise<{ allowed: boolean, limit: number|null, used: number }> }}
 */
const NO_ENTITLEMENTS = Object.freeze({ entitled: async () => ({ allowed: false, limit: null, used: 0 }) });

/**
 * @param {{ store: object,
 *           clerk: { createOrganization: Function, createOrganizationInvitation?: Function,
 *                    updateMembership?: Function, deleteMembership?: Function },
 *           entitlements?: { entitled: Function },
 *           webhookSecret: () => string|undefined }} deps
 *   entitlements — billing's published port (createEntitlements), for the
 *   `seats` check on inviteMember (doc 16 conjunction, D-05).
 */
export function registerIdentity(router, { store, clerk, entitlements = NO_ENTITLEMENTS, webhookSecret }) {
  // Resolve the mirror ids for the active org once per request; handlers
  // receive a viewer whose orgId/orgKind are LOCAL ids (identity.organization).
  const resolved = async (viewer) => {
    if (viewer.orgId || !viewer.clerkOrgId) return viewer;
    const org = await store.getOrgByClerkId(viewer.clerkOrgId);
    if (!org) return viewer;
    return Object.freeze({ ...viewer, orgId: org.id, orgKind: org.kind });
  };

  router.register('GET', '/me', 'getMe', async ({ viewer }) =>
    getMe({ viewer: await resolved(viewer), store }));

  // Self-service: a person editing their own display name + language on first
  // login. No org resolution needed — the write is keyed on the viewer's clerk
  // user id (identity.person), not on any active org.
  router.register('PUT', '/me/profile', 'updateMyProfile', async ({ viewer, body }) =>
    updateMyProfile({ viewer, store, body }));

  router.register('POST', '/organizations', 'createOrganization', async ({ viewer, body, headers }) =>
    createOrganization({
      viewer, store, clerk, body,
      idempotencyKey: headers['idempotency-key'] ?? null,
    }));

  router.register('GET', '/organizations/{orgId}/members', 'listMembers', async ({ viewer, params, query }) =>
    listMembers({ viewer: await resolved(viewer), store, orgId: params.orgId, query }));

  // PRD-12 N-9 — member management through the Clerk gateway (human-only).
  router.register('POST', '/organizations/{orgId}/invitations', 'inviteMember', async ({ viewer, params, body, headers }) =>
    inviteMember({
      viewer: await resolved(viewer), store, clerk, entitlements, orgId: params.orgId, body,
      idempotencyKey: headers['idempotency-key'] ?? null,
    }));

  router.register('PATCH', '/organizations/{orgId}/members/{personId}', 'updateMemberRole', async ({ viewer, params, body }) =>
    updateMemberRole({ viewer: await resolved(viewer), store, clerk, orgId: params.orgId, personId: params.personId, body }));

  router.register('DELETE', '/organizations/{orgId}/members/{personId}', 'removeMember', async ({ viewer, params }) =>
    removeMember({ viewer: await resolved(viewer), store, clerk, orgId: params.orgId, personId: params.personId }));

  router.register('PUT', '/projects/{projectId}/staffing/{personId}', 'staffPerson', async ({ viewer, params }) =>
    staffPerson({ viewer: await resolved(viewer), store, projectId: params.projectId, personId: params.personId }));

  router.register('DELETE', '/projects/{projectId}/staffing/{personId}', 'unstaffPerson', async ({ viewer, params }) =>
    unstaffPerson({ viewer: await resolved(viewer), store, projectId: params.projectId, personId: params.personId }));

  // Machine caller (security: [] in the contract) — authenticated by the svix
  // signature over the RAW body, never by a session.
  router.register('POST', '/webhooks/clerk', 'clerkWebhook', async ({ headers, rawBody }) =>
    clerkWebhook({ store, headers, rawBody: rawBody ?? '', secret: webhookSecret() }));
}
