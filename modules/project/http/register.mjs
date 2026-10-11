// Project module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
import {
  createProject, listProjects, getProject, updateProject,
  claimProject, cancelProject, closeProject,
  listLocations, createLocation, updateLocation, deleteLocation,
  getCalendar, putCalendar,
} from '../application/use-cases.mjs';
import {
  createShareLink, listShareLinks, revokeShareLink, listShareLinkAccesses,
  resolveShareLink, downloadSharedDocument,
} from '../application/share-links.mjs';
import { requesterOf } from '../domain/share-link.mjs';
import {
  listParticipants, listProjectInvitations, inviteToProject, previewProjectInvitation, acceptProjectInvitation,
} from '../application/participants.mjs';
import { getProjectOverview } from '../application/overview.mjs';
import {
  listPhases, requestSignOff, approveSignOff, rejectSignOff,
} from '../application/phases.mjs';

/**
 * @param {{ store: object, shareBaseUrl: () => string,
 *           specialties?: { exists: Function, describe: Function },
 *           documents?: { shareableFiles: Function, signSharedDownload: Function },
 *           facts?: { planning?: object, contracting?: object, quality?: object, questions?: object } }} deps
 *   `specialties` — the directory's taxonomy port (an invitation's trade, PRD-09 O-4/O-5).
 *   `facts` — the owning modules' query ports the build home reads (PRD-09 O-1).
 *   `documents` — the Documents share-files port: which files a share link may
 *   name and serve, and their signed downloads (PRD-12 N-12).
 */
// `orgs` — identity's organisation port (staffed people), injected at the composition root.
export function registerProject(router, { store, shareBaseUrl, specialties, facts = {}, documents, orgs = null }) {
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
    getProjectOverview({ viewer, store, facts, projectId: params.projectId }));

  router.register('GET', '/projects/{projectId}/locations', 'listLocations', ({ viewer, params, query }) =>
    listLocations({ viewer, store, projectId: params.projectId, query }));

  router.register('POST', '/projects/{projectId}/locations', 'createLocation', ({ viewer, params, body }) =>
    createLocation({ viewer, store, projectId: params.projectId, body }));

  router.register('PATCH', '/locations/{locationId}', 'updateLocation', ({ viewer, params, body }) =>
    updateLocation({ viewer, store, locationId: params.locationId, body }));

  router.register('DELETE', '/locations/{locationId}', 'deleteLocation', ({ viewer, params }) =>
    deleteLocation({ viewer, store, locationId: params.locationId }));

  router.register('GET', '/projects/{projectId}/participants', 'listParticipants', ({ viewer, params, query }) =>
    listParticipants({ viewer, store, specialties, orgs, projectId: params.projectId, query }));

  router.register('GET', '/projects/{projectId}/invitations', 'listProjectInvitations', ({ viewer, params, query }) =>
    listProjectInvitations({ viewer, store, specialties, projectId: params.projectId, query }));

  router.register('POST', '/projects/{projectId}/invitations', 'inviteToProject', ({ viewer, params, body }) =>
    inviteToProject({ viewer, store, specialties, projectId: params.projectId, body }));

  // Unauthenticated preview (security: [], LINA-398): the token in the path IS
  // the credential, exactly like the RFP personal link. The /api/v2 edge lets a
  // GET on this prefix through with a null viewer; the handler takes no viewer
  // and the store read is anti-oracle. The :accept POST below still requires a
  // session.
  router.register('GET', '/project-invitations/{token}', 'previewProjectInvitation', ({ params }) =>
    previewProjectInvitation({ store, specialties, token: params.token }));

  router.register('POST', '/project-invitations/{token}:accept', 'acceptProjectInvitation', ({ viewer, params }) =>
    acceptProjectInvitation({ viewer, store, specialties, token: params.token }));

  router.register('GET', '/projects/{projectId}/calendar', 'getCalendar', ({ viewer, params }) =>
    getCalendar({ viewer, store, projectId: params.projectId }));

  router.register('PUT', '/projects/{projectId}/calendar', 'putCalendar', ({ viewer, params, body }) =>
    putCalendar({ viewer, store, projectId: params.projectId, body }));

  // ── share links (flow D21, PRD-12 N-12) ───────────────────────────────────
  router.register('POST', '/projects/{projectId}/share-links', 'createShareLink', ({ viewer, params, body }) =>
    createShareLink({ viewer, store, documents, projectId: params.projectId, body, shareBaseUrl: shareBaseUrl() }));

  router.register('GET', '/projects/{projectId}/share-links', 'listShareLinks', ({ viewer, params, query }) =>
    listShareLinks({ viewer, store, projectId: params.projectId, query }));

  router.register('POST', '/share-links/{shareLinkId}:revoke', 'revokeShareLink', ({ viewer, params, headers }) =>
    revokeShareLink({ viewer, store, shareLinkId: params.shareLinkId, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('GET', '/share-links/{shareLinkId}/accesses', 'listShareLinkAccesses', ({ viewer, params, query }) =>
    listShareLinkAccesses({ viewer, store, shareLinkId: params.shareLinkId, query }));

  // Public pair (security: []): the token in the path IS the credential, like
  // the RFP personal link (gap S1) — the /api/v2 edge lets GET /shared/* through
  // with a null viewer and the handlers take none. The public page dispatches
  // in-process, so the token is never a wire URL of the API.
  router.register('GET', '/shared/{token}', 'resolveShareLink', ({ params, headers }) =>
    resolveShareLink({ store, documents, token: params.token, requester: requesterOf(headers) }));

  router.register('GET', '/shared/{token}/documents/{documentId}:download', 'downloadSharedDocument', ({ params, query, headers }) =>
    downloadSharedDocument({
      store, documents, token: params.token, documentId: params.documentId, query, requester: requesterOf(headers),
    }));

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
