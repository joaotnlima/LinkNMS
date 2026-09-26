// Documents module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
// Phase 7 surface: the whole Documents tag — upload tickets, completion,
// listing by scope, presigned downloads.
import {
  createDocument, createDocumentVersion, completeUpload,
  listDocuments, downloadDocument,
} from '../application/use-cases.mjs';

/**
 * @param {{ store: object, storage: object }} deps
 */
export function registerDocuments(router, { store, storage }) {
  router.register('POST', '/documents', 'createDocument', ({ viewer, body }) =>
    createDocument({ viewer, store, storage, body }));

  router.register('GET', '/documents', 'listDocuments', ({ viewer, query }) =>
    listDocuments({ viewer, store, query }));

  router.register('POST', '/documents/{documentId}/versions', 'createDocumentVersion', ({ viewer, params, body }) =>
    createDocumentVersion({ viewer, store, storage, documentId: params.documentId, body }));

  router.register('POST', '/document-versions/{versionId}:complete', 'completeUpload', ({ viewer, params }) =>
    completeUpload({ viewer, store, storage, versionId: params.versionId }));

  router.register('GET', '/document-versions/{versionId}:download', 'downloadDocument', ({ viewer, params }) =>
    downloadDocument({ viewer, store, storage, versionId: params.versionId }));
}
