// Identity & Access on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
//
// The router hands us the raw ViewerContext (Clerk ids only). Identity is the
// module that OWNS the mirror, so this is where the local person/org ids get
// resolved — every other module will receive them already resolved once the
// registry wires this module's resolver in front (phase 2+).
import { getMe, createOrganization, listMembers, staffPerson, unstaffPerson, clerkWebhook } from '../application/use-cases.mjs';

/**
 * @param {{ store: object, clerk: { createOrganization: Function },
 *           webhookSecret: () => string|undefined }} deps
 */
export function registerIdentity(router, { store, clerk, webhookSecret }) {
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

  router.register('POST', '/organizations', 'createOrganization', async ({ viewer, body, headers }) =>
    createOrganization({
      viewer, store, clerk, body,
      idempotencyKey: headers['idempotency-key'] ?? null,
    }));

  router.register('GET', '/organizations/{orgId}/members', 'listMembers', async ({ viewer, params, query }) =>
    listMembers({ viewer: await resolved(viewer), store, orgId: params.orgId, query }));

  router.register('PUT', '/projects/{projectId}/staffing/{personId}', 'staffPerson', async ({ viewer, params }) =>
    staffPerson({ viewer: await resolved(viewer), store, projectId: params.projectId, personId: params.personId }));

  router.register('DELETE', '/projects/{projectId}/staffing/{personId}', 'unstaffPerson', async ({ viewer, params }) =>
    unstaffPerson({ viewer: await resolved(viewer), store, projectId: params.projectId, personId: params.personId }));

  // Machine caller (security: [] in the contract) — authenticated by the svix
  // signature over the RAW body, never by a session.
  router.register('POST', '/webhooks/clerk', 'clerkWebhook', async ({ headers, rawBody }) =>
    clerkWebhook({ store, headers, rawBody: rawBody ?? '', secret: webhookSecret() }));
}
