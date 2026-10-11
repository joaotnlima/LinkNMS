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
import {
  listDocumentMarkups, saveDocumentMarkups, closeMarkup, reopenMarkup, linkMarkup,
} from '../application/markups.mjs';
import { getDocumentViewUrl, getDocumentPreview } from '../application/viewing.mjs';
import {
  getProjectModel, reserveProjectModelVersion, saveModelEdits, restoreProjectModel, compareModelRecord, getTaskModel,
} from '../application/project-model.mjs';

/**
 * @param {{ store: object, storage: object, planning?: { descendantIds: Function, modelScopes?: Function },
 *   questions?: { questionFacts: Function }, nonconformities?: { nonconformityFacts: Function } }} deps
 *   `planning` — the planning task port, for "also on sub-tasks" (PRD-05 F-10)
 *   and the model edit scope (PRD-07 M-8);
 *   `questions` / `nonconformities` — the Collaboration and Quality ports a
 *   markup link is checked through (PRD-06 V-8).
 */
export function registerDocuments(router, { store, storage, planning, questions, nonconformities }) {
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

  router.register('POST', '/tasks/{taskId}/document-links', 'linkTaskDocuments', ({ viewer, params, body, headers }) =>
    linkTaskDocuments({ viewer, store, planning, taskId: params.taskId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('DELETE', '/tasks/{taskId}/document-links/{documentId}', 'unlinkTaskDocument', ({ viewer, params }) =>
    unlinkTaskDocument({ viewer, store, taskId: params.taskId, documentId: params.documentId }));

  router.register('GET', '/projects/{projectId}/documents', 'listProjectDocuments', ({ viewer, params, query }) =>
    listProjectDocuments({ viewer, store, projectId: params.projectId, query }));

  // ── PRD-06: the markup layer of drawings ─────────────────────────────────
  router.register('GET', '/documents/{documentId}/markups', 'listDocumentMarkups', ({ viewer, params, query }) =>
    listDocumentMarkups({ viewer, store, documentId: params.documentId, query }));

  router.register('POST', '/documents/{documentId}/markups:save', 'saveDocumentMarkups', ({ viewer, params, body, headers }) =>
    saveDocumentMarkups({ viewer, store, documentId: params.documentId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('POST', '/markups/{markupId}:close', 'closeMarkup', ({ viewer, params, headers }) =>
    closeMarkup({ viewer, store, markupId: params.markupId, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('POST', '/markups/{markupId}:reopen', 'reopenMarkup', ({ viewer, params, headers }) =>
    reopenMarkup({ viewer, store, markupId: params.markupId, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('POST', '/markups/{markupId}:link', 'linkMarkup', ({ viewer, params, body, headers }) =>
    linkMarkup({ viewer, store, questions, nonconformities, markupId: params.markupId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  // ── PRD-06: viewing a version in the browser (PDF bytes, DWG/DXF preview) ─
  router.register('GET', '/document-versions/{versionId}:view-url', 'getDocumentViewUrl', ({ viewer, params }) =>
    getDocumentViewUrl({ viewer, store, storage, versionId: params.versionId }));

  router.register('GET', '/document-versions/{versionId}/preview', 'getDocumentPreview', ({ viewer, params }) =>
    getDocumentPreview({ viewer, store, storage, versionId: params.versionId }));

  // ── PRD-07: the shared project model, record-side edits only (D-45) ──────
  router.register('GET', '/projects/{projectId}/model', 'getProjectModel', ({ viewer, params, query }) =>
    getProjectModel({ viewer, store, planning, projectId: params.projectId, query }));

  router.register('POST', '/projects/{projectId}/model/versions', 'reserveProjectModelVersion', ({ viewer, params, body, headers }) =>
    reserveProjectModelVersion({ viewer, store, storage, projectId: params.projectId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('POST', '/projects/{projectId}/model:save', 'saveModelEdits', ({ viewer, params, body, headers }) =>
    saveModelEdits({ viewer, store, planning, projectId: params.projectId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('POST', '/projects/{projectId}/model:restore', 'restoreProjectModel', ({ viewer, params, body, headers }) =>
    restoreProjectModel({ viewer, store, planning, projectId: params.projectId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('GET', '/projects/{projectId}/model/record-diff', 'compareModelRecord', ({ viewer, params, query }) =>
    compareModelRecord({ viewer, store, projectId: params.projectId, query }));

  router.register('GET', '/tasks/{taskId}/model', 'getTaskModel', ({ viewer, params }) =>
    getTaskModel({ viewer, store, planning, taskId: params.taskId }));
}
