// Record module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
//
// The audit ledger, read side: list the projected (V7-redacted) ledger and
// verify the whole hash chain. `record:export` (a Document artefact) is a
// separate, heavier slice — tracked, not registered here.
import { listRecord, verifyRecord } from '../application/use-cases.mjs';

/** @param {{ store: object }} deps */
export function registerRecord(router, { store }) {
  router.register('GET', '/projects/{projectId}/record', 'listRecord', ({ viewer, params, query }) =>
    listRecord({ viewer, store, projectId: params.projectId, query }));

  router.register('POST', '/projects/{projectId}/record:verify', 'verifyRecord', ({ viewer, params }) =>
    verifyRecord({ viewer, store, projectId: params.projectId }));
}
