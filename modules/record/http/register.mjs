// Record module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
// The Record tag is the ledger projected: "who decided what, when".
// listRecord ships here; verifyRecord + exportRecord follow (LINA-363
// tracked their own increment).
import { listRecord } from '../application/use-cases.mjs';

/**
 * @param {{ store: object }} deps
 */
export function registerRecord(router, { store }) {
  router.register('GET', '/projects/{projectId}/record', 'listRecord', ({ viewer, params, query }) =>
    listRecord({ viewer, store, projectId: params.projectId, query }));
}
