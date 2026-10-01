// Record module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
//
// The audit ledger, read side: list the projected (V7-redacted) ledger, verify
// the whole hash chain, and export a self-proving Document artefact (LINA-374).
// The export persists through the documents module (createDocument + R2), so
// this module takes the documents store + object storage as a dependency.
import { listRecord, verifyRecord, exportRecord } from '../application/use-cases.mjs';

/** @param {{ store: object, documents: { store: object, storage: object } }} deps */
export function registerRecord(router, { store, documents }) {
  router.register('GET', '/projects/{projectId}/record', 'listRecord', ({ viewer, params, query }) =>
    listRecord({ viewer, store, projectId: params.projectId, query }));

  router.register('POST', '/projects/{projectId}/record:verify', 'verifyRecord', ({ viewer, params }) =>
    verifyRecord({ viewer, store, projectId: params.projectId }));

  router.register('POST', '/projects/{projectId}/record:export', 'exportRecord', ({ viewer, params }) =>
    exportRecord({ viewer, store, projectId: params.projectId, documents }));
}
