// Quality module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
// Phase 5 surface: the whole Quality tag — verification queue + decisions,
// non-conformity lifecycle, inspections.
import {
  listMyVerifications, acceptVerification, rejectVerification,
  raiseNonConformity, assignNonConformity, fixNonConformity,
  closeNonConformity, rejectFixNonConformity, recordInspection,
} from '../application/use-cases.mjs';

/**
 * @param {{ store: object }} deps
 */
export function registerQuality(router, { store }) {
  router.register('GET', '/me/verifications', 'listMyVerifications', ({ viewer, query }) =>
    listMyVerifications({ viewer, store, query }));

  router.register('POST', '/verifications/{verificationId}:accept', 'acceptVerification', ({ viewer, params }) =>
    acceptVerification({ viewer, store, verificationId: params.verificationId }));

  router.register('POST', '/verifications/{verificationId}:reject', 'rejectVerification', ({ viewer, params, body }) =>
    rejectVerification({ viewer, store, verificationId: params.verificationId, body }));

  router.register('POST', '/projects/{projectId}/nonconformities', 'raiseNonConformity', ({ viewer, params, body }) =>
    raiseNonConformity({ viewer, store, projectId: params.projectId, body }));

  router.register('POST', '/nonconformities/{nonconformityId}:assign', 'assignNonConformity', ({ viewer, params, body }) =>
    assignNonConformity({ viewer, store, nonconformityId: params.nonconformityId, body }));

  router.register('POST', '/nonconformities/{nonconformityId}:fix', 'fixNonConformity', ({ viewer, params, body }) =>
    fixNonConformity({ viewer, store, nonconformityId: params.nonconformityId, body }));

  router.register('POST', '/nonconformities/{nonconformityId}:close', 'closeNonConformity', ({ viewer, params, body }) =>
    closeNonConformity({ viewer, store, nonconformityId: params.nonconformityId, body }));

  router.register('POST', '/nonconformities/{nonconformityId}:reject-fix', 'rejectFixNonConformity', ({ viewer, params, body }) =>
    rejectFixNonConformity({ viewer, store, nonconformityId: params.nonconformityId, body }));

  router.register('POST', '/projects/{projectId}/inspections', 'recordInspection', ({ viewer, params, body }) =>
    recordInspection({ viewer, store, projectId: params.projectId, body }));
}
