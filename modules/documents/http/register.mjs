// Documents module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
// Phase 7 surface: the whole Documents tag — upload tickets, completion,
// listing by scope, presigned downloads — plus PRD-05's task links and the
// task / project file reads.
import {
  createDocument, createDocumentVersion, completeUpload,
  listDocuments, downloadDocument,
} from '../application/use-cases.mjs';
import {
  listTaskDocuments, linkTaskDocuments, unlinkTaskDocument, listProjectDocuments,
} from '../application/task-files.mjs';

/**
 * @param {{ store: object, storage: object, planning?: { descendantIds: Function } }} deps
 *   `planning` — the planning task port, for "also on sub-tasks" (PRD-05 F-10).
 */
export function registerDocuments(router, { store, storage, planning = null }) {
  router.register('POST', '/documents', 'createDocument', ({ viewer, body }) =>
    createDocument({ viewer, store, storage, body, planning }));

  router.register('GET', '/documents', 'listDocuments', ({ viewer, query }) =>
    listDocuments({ viewer, store, query }));

  router.register('POST', '/documents/{documentId}/versions', 'createDocumentVersion', ({ viewer, params, body }) =>
    createDocumentVersion({ viewer, store, storage, documentId: params.documentId, body }));

  router.register('POST', '/document-versions/{versionId}:complete', 'completeUpload', ({ viewer, params }) =>
    completeUpload({ viewer, store, storage, versionId: params.versionId }));

  router.register('GET', '/document-versions/{versionId}:download', 'downloadDocument', ({ viewer, params }) =>
    downloadDocument({ viewer, store, storage, versionId: params.versionId }));

  // ── PRD-05: task files and project files ─────────────────────────────────
  router.register('GET', '/tasks/{taskId}/documents', 'listTaskDocuments', ({ viewer, params }) =>
    listTaskDocuments({ viewer, store, taskId: params.taskId }));

  router.register('POST', '/tasks/{taskId}/document-links', 'linkTaskDocuments', ({ viewer, params, body }) =>
    linkTaskDocuments({ viewer, store, planning, taskId: params.taskId, body }));

  router.register('DELETE', '/tasks/{taskId}/document-links/{documentId}', 'unlinkTaskDocument', ({ viewer, params }) =>
    unlinkTaskDocument({ viewer, store, taskId: params.taskId, documentId: params.documentId }));

  router.register('GET', '/projects/{projectId}/documents', 'listProjectDocuments', ({ viewer, params, query }) =>
    listProjectDocuments({ viewer, store, projectId: params.projectId, query }));
}
