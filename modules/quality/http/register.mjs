// Quality module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
// Phase 5 surface: the whole Quality tag — verification queue + decisions,
// non-conformity lifecycle, inspections.
import {
  listMyVerifications, acceptVerification, rejectVerification,
  raiseNonConformity, assignNonConformity, fixNonConformity,
  closeNonConformity, rejectFixNonConformity, recordInspection,
} from '../application/use-cases.mjs';
import { listNonConformities, listInspections } from '../application/queries.mjs';

/**
 * @param {{ store: object,
 *           builds?: { locationsOf: Function },
 *           documents?: { versionFacts: Function } }} deps
 *   `builds` — the project's build port (a non-conformity's or an
 *   inspection's locations, PRD-12 N-3/N-4); `documents` — the documents
 *   query port (photos are build files the raiser reads).
 */
export function registerQuality(router, { store, builds, documents }) {
  const ports = { builds, documents };
  router.register('GET', '/me/verifications', 'listMyVerifications', ({ viewer, query }) =>
    listMyVerifications({ viewer, store, query }));

  router.register('POST', '/verifications/{verificationId}:accept', 'acceptVerification', ({ viewer, params }) =>
    acceptVerification({ viewer, store, verificationId: params.verificationId }));

  router.register('POST', '/verifications/{verificationId}:reject', 'rejectVerification', ({ viewer, params, body }) =>
    rejectVerification({ viewer, store, verificationId: params.verificationId, body }));

  router.register('POST', '/projects/{projectId}/nonconformities', 'raiseNonConformity', ({ viewer, params, body }) =>
    raiseNonConformity({ viewer, store, ports, projectId: params.projectId, body }));

  router.register('GET', '/projects/{projectId}/nonconformities', 'listNonConformities', ({ viewer, params, query }) =>
    listNonConformities({ viewer, store, projectId: params.projectId, query }));

  router.register('POST', '/nonconformities/{nonconformityId}:assign', 'assignNonConformity', ({ viewer, params, body }) =>
    assignNonConformity({ viewer, store, nonconformityId: params.nonconformityId, body }));

  router.register('POST', '/nonconformities/{nonconformityId}:fix', 'fixNonConformity', ({ viewer, params, body }) =>
    fixNonConformity({ viewer, store, nonconformityId: params.nonconformityId, body }));

  router.register('POST', '/nonconformities/{nonconformityId}:close', 'closeNonConformity', ({ viewer, params, body }) =>
    closeNonConformity({ viewer, store, nonconformityId: params.nonconformityId, body }));

  router.register('POST', '/nonconformities/{nonconformityId}:reject-fix', 'rejectFixNonConformity', ({ viewer, params, body }) =>
    rejectFixNonConformity({ viewer, store, nonconformityId: params.nonconformityId, body }));

  router.register('POST', '/projects/{projectId}/inspections', 'recordInspection', ({ viewer, params, body }) =>
    recordInspection({ viewer, store, ports, projectId: params.projectId, body }));

  router.register('GET', '/projects/{projectId}/inspections', 'listInspections', ({ viewer, params, query }) =>
    listInspections({ viewer, store, projectId: params.projectId, query }));
}
