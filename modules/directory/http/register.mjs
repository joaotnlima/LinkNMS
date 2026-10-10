// Directory module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
// PRD-03: taxonomy, public search and profiles (security: [] — the viewer may
// be null), the company-side editor, claim path and the owner's consent.
import {
  listSpecialties, searchOrganizations, getDirectoryOrganization, getDirectoryProfileBySlug,
} from '../application/search.mjs';
import {
  getMyProfile, putProfile, getCompleteness, getListingStats, listMyPortfolio, addPortfolioEntry, deletePortfolioEntry,
  getPortfolioConsent, putPortfolioConsent,
} from '../application/profiles.mjs';
import { claimProfile, acceptProfileClaim } from '../application/claims.mjs';

/**
 * @param {{
 *   store: object,
 *   builds: { locationFor: Function, ownedBuild: Function },  // project module's build port
 *   mail: { sender: { send: Function }, baseUrl: string|(() => string) },
 * }} deps
 */
export function registerDirectory(router, { store, builds, mail }) {
  // ── public reads (anonymous allowed) ──────────────────────────────────
  router.register('GET', '/specialties', 'listSpecialties', ({ query }) =>
    listSpecialties({ store, query }));

  router.register('GET', '/directory/organizations', 'searchOrganizations', ({ viewer, query }) =>
    searchOrganizations({ viewer, store, builds, query }));

  router.register('GET', '/directory/organizations/{orgId}', 'getDirectoryOrganization', ({ viewer, params }) =>
    getDirectoryOrganization({ viewer, store, orgId: params.orgId }));

  router.register('GET', '/directory/organizations/by-slug/{slug}', 'getDirectoryProfileBySlug', ({ viewer, params }) =>
    getDirectoryProfileBySlug({ viewer, store, slug: params.slug }));

  // ── company side ──────────────────────────────────────────────────────
  router.register('GET', '/organizations/{orgId}/profile', 'getMyProfile', ({ viewer, params }) =>
    getMyProfile({ viewer, store, orgId: params.orgId }));

  router.register('PUT', '/organizations/{orgId}/profile', 'putProfile', ({ viewer, params, body, headers }) =>
    putProfile({ viewer, store, orgId: params.orgId, body, ifMatch: headers['if-match'] }));

  router.register('GET', '/organizations/{orgId}/profile/completeness', 'getCompleteness', ({ viewer, params }) =>
    getCompleteness({ viewer, store, orgId: params.orgId }));

  router.register('GET', '/organizations/{orgId}/listing-stats', 'getListingStats', ({ viewer, params }) =>
    getListingStats({ viewer, store, orgId: params.orgId }));

  router.register('GET', '/organizations/{orgId}/portfolio', 'listMyPortfolio', ({ viewer, params }) =>
    listMyPortfolio({ viewer, store, orgId: params.orgId }));

  router.register('POST', '/organizations/{orgId}/portfolio', 'addPortfolioEntry', ({ viewer, params, body, headers }) =>
    addPortfolioEntry({ viewer, store, orgId: params.orgId, body, idempotencyKey: headers['idempotency-key'] }));

  router.register('DELETE', '/organizations/{orgId}/portfolio/{entryId}', 'deletePortfolioEntry', ({ viewer, params }) =>
    deletePortfolioEntry({ viewer, store, orgId: params.orgId, entryId: params.entryId }));

  router.register('POST', '/directory/organizations/{orgId}:claim', 'claimProfile', ({ viewer, params }) =>
    claimProfile({ viewer, store, mail, orgId: params.orgId }));

  router.register('POST', '/directory/claims/{token}:accept', 'acceptProfileClaim', ({ viewer, params }) =>
    acceptProfileClaim({ viewer, store, token: params.token }));

  // ── the owner's consent to show a build's name (R-12) ─────────────────
  router.register('GET', '/projects/{projectId}/portfolio-consent', 'getPortfolioConsent', ({ viewer, params }) =>
    getPortfolioConsent({ viewer, store, builds, projectId: params.projectId }));

  router.register('PUT', '/projects/{projectId}/portfolio-consent', 'putPortfolioConsent', ({ viewer, params, body }) =>
    putPortfolioConsent({ viewer, store, builds, projectId: params.projectId, body }));
}
