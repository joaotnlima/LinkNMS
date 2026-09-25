// Contracting module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
// Phase 3 surface: create / list / get / update / sign. The rest of the tag
// (sponsor, receive-provisionally, close, terminate, change orders,
// measurements, payments) lands with phase 5.
import {
  createContract, listContracts, getContract, updateContract, signContract,
} from '../application/use-cases.mjs';

/**
 * @param {{ store: object }} deps
 */
export function registerContracting(router, { store }) {
  router.register('POST', '/projects/{projectId}/contracts', 'createContract', ({ viewer, params, body, headers }) =>
    createContract({ viewer, store, projectId: params.projectId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('GET', '/projects/{projectId}/contracts', 'listContracts', ({ viewer, params, query }) =>
    listContracts({ viewer, store, projectId: params.projectId, query }));

  router.register('GET', '/contracts/{contractId}', 'getContract', ({ viewer, params }) =>
    getContract({ viewer, store, contractId: params.contractId }));

  router.register('PATCH', '/contracts/{contractId}', 'updateContract', ({ viewer, params, body, headers }) =>
    updateContract({ viewer, store, contractId: params.contractId, body, ifMatch: headers['if-match'] }));

  router.register('POST', '/contracts/{contractId}:sign', 'signContract', ({ viewer, params }) =>
    signContract({ viewer, store, contractId: params.contractId }));
}
