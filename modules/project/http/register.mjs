// Project module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
import {
  createProject, listProjects, getProject, updateProject,
  claimProject, cancelProject, closeProject, getProjectOverview,
  listLocations, createLocation, updateLocation, deleteLocation,
  listParticipants, inviteToProject, previewProjectInvitation, acceptProjectInvitation,
  getCalendar, putCalendar, createShareLink,
} from '../application/use-cases.mjs';
import {
  listPhases, requestSignOff, approveSignOff, rejectSignOff,
} from '../application/phases.mjs';

/**
 * @param {{ store: object, shareBaseUrl: () => string }} deps
 */
export function registerProject(router, { store, shareBaseUrl }) {
  router.register('POST', '/projects', 'createProject', ({ viewer, body, headers }) =>
    createProject({ viewer, store, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('GET', '/projects', 'listProjects', ({ viewer, query }) =>
    listProjects({ viewer, store, query }));

  router.register('GET', '/projects/{projectId}', 'getProject', ({ viewer, params }) =>
    getProject({ viewer, store, projectId: params.projectId }));

  router.register('PATCH', '/projects/{projectId}', 'updateProject', ({ viewer, params, body, headers }) =>
    updateProject({ viewer, store, projectId: params.projectId, body, ifMatch: headers['if-match'] }));

  router.register('POST', '/projects/{projectId}:claim', 'claimProject', ({ viewer, params }) =>
    claimProject({ viewer, store, projectId: params.projectId }));

  router.register('POST', '/projects/{projectId}:cancel', 'cancelProject', ({ viewer, params }) =>
    cancelProject({ viewer, store, projectId: params.projectId }));

  router.register('POST', '/projects/{projectId}:close', 'closeProject', ({ viewer, params }) =>
    closeProject({ viewer, store, projectId: params.projectId }));

  router.register('GET', '/projects/{projectId}/overview', 'getProjectOverview', ({ viewer, params }) =>
    getProjectOverview({ viewer, store, projectId: params.projectId }));

  router.register('GET', '/projects/{projectId}/locations', 'listLocations', ({ viewer, params, query }) =>
    listLocations({ viewer, store, projectId: params.projectId, query }));

  router.register('POST', '/projects/{projectId}/locations', 'createLocation', ({ viewer, params, body }) =>
    createLocation({ viewer, store, projectId: params.projectId, body }));

  router.register('PATCH', '/locations/{locationId}', 'updateLocation', ({ viewer, params, body }) =>
    updateLocation({ viewer, store, locationId: params.locationId, body }));

  router.register('DELETE', '/locations/{locationId}', 'deleteLocation', ({ viewer, params }) =>
    deleteLocation({ viewer, store, locationId: params.locationId }));

  router.register('GET', '/projects/{projectId}/participants', 'listParticipants', ({ viewer, params, query }) =>
    listParticipants({ viewer, store, projectId: params.projectId, query }));

  router.register('POST', '/projects/{projectId}/invitations', 'inviteToProject', ({ viewer, params, body }) =>
    inviteToProject({ viewer, store, projectId: params.projectId, body }));

  // Unauthenticated preview (security: [], LINA-398): the token in the path IS
  // the credential, exactly like the RFP personal link. The /api/v2 edge lets a
  // GET on this prefix through with a null viewer; the handler takes no viewer
  // and the store read is anti-oracle. The :accept POST below still requires a
  // session.
  router.register('GET', '/project-invitations/{token}', 'previewProjectInvitation', ({ params }) =>
    previewProjectInvitation({ store, token: params.token }));

  router.register('POST', '/project-invitations/{token}:accept', 'acceptProjectInvitation', ({ viewer, params }) =>
    acceptProjectInvitation({ viewer, store, token: params.token }));

  router.register('GET', '/projects/{projectId}/calendar', 'getCalendar', ({ viewer, params }) =>
    getCalendar({ viewer, store, projectId: params.projectId }));

  router.register('PUT', '/projects/{projectId}/calendar', 'putCalendar', ({ viewer, params, body }) =>
    putCalendar({ viewer, store, projectId: params.projectId, body }));

  router.register('POST', '/projects/{projectId}/share-links', 'createShareLink', ({ viewer, params, body }) =>
    createShareLink({ viewer, store, projectId: params.projectId, body, shareBaseUrl: shareBaseUrl() }));

  // ── phases + execution sign-off (LINA-356; ADR-0024) ─────────────────────
  router.register('GET', '/projects/{projectId}/phases', 'listPhases', ({ viewer, params }) =>
    listPhases({ viewer, store, projectId: params.projectId }));

  router.register('POST', '/projects/{projectId}/phases/{phaseId}/sign-off', 'requestSignOff', ({ viewer, params }) =>
    requestSignOff({ viewer, store, projectId: params.projectId, phaseId: params.phaseId }));

  router.register('POST', '/projects/{projectId}/phases/{phaseId}/sign-off/{requestId}/approve', 'approveSignOff', ({ viewer, params, body }) =>
    approveSignOff({ viewer, store, projectId: params.projectId, phaseId: params.phaseId, requestId: params.requestId, body }));

  router.register('POST', '/projects/{projectId}/phases/{phaseId}/sign-off/{requestId}/reject', 'rejectSignOff', ({ viewer, params, body }) =>
    rejectSignOff({ viewer, store, projectId: params.projectId, phaseId: params.phaseId, requestId: params.requestId, body }));
}
