// Contracting module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
// Phase 3: create / list / get / update / sign. Phase 5 (money flow):
// sponsor, receive-provisionally, close, terminate, financials, change
// orders, measurements, payments, owner cash-flow.
import {
  createContract, listContracts, getContract, updateContract, signContract,
  sponsorContract, receiveProvisionally, closeContract, terminateContract, getFinancials,
  createChangeOrder, getChangeOrder, submitChangeOrder, approveChangeOrder, rejectChangeOrder, withdrawChangeOrder,
  suggestMeasurement, createMeasurement, approveMeasurement, disputeMeasurement,
  declarePaid, confirmPayment, disputePayment, getCashFlow,
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

  // ── phase 5: lifecycle tail + money view ──────────────────────────────────
  router.register('POST', '/contracts/{contractId}:sponsor', 'sponsorContract', ({ viewer, params }) =>
    sponsorContract({ viewer, store, contractId: params.contractId }));

  router.register('POST', '/contracts/{contractId}:receive-provisionally', 'receiveProvisionally', ({ viewer, params }) =>
    receiveProvisionally({ viewer, store, contractId: params.contractId }));

  router.register('POST', '/contracts/{contractId}:close', 'closeContract', ({ viewer, params }) =>
    closeContract({ viewer, store, contractId: params.contractId }));

  router.register('POST', '/contracts/{contractId}:terminate', 'terminateContract', ({ viewer, params, body }) =>
    terminateContract({ viewer, store, contractId: params.contractId, body }));

  router.register('GET', '/contracts/{contractId}/financials', 'getFinancials', ({ viewer, params }) =>
    getFinancials({ viewer, store, contractId: params.contractId }));

  // ── phase 5: change orders ────────────────────────────────────────────────
  router.register('POST', '/contracts/{contractId}/change-orders', 'createChangeOrder', ({ viewer, params, body, headers }) =>
    createChangeOrder({ viewer, store, contractId: params.contractId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('GET', '/change-orders/{changeOrderId}', 'getChangeOrder', ({ viewer, params }) =>
    getChangeOrder({ viewer, store, changeOrderId: params.changeOrderId }));

  router.register('POST', '/change-orders/{changeOrderId}:submit', 'submitChangeOrder', ({ viewer, params, body, headers }) =>
    submitChangeOrder({ viewer, store, changeOrderId: params.changeOrderId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('POST', '/change-orders/{changeOrderId}:approve', 'approveChangeOrder', ({ viewer, params, body, headers }) =>
    approveChangeOrder({ viewer, store, changeOrderId: params.changeOrderId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('POST', '/change-orders/{changeOrderId}:reject', 'rejectChangeOrder', ({ viewer, params, body, headers }) =>
    rejectChangeOrder({ viewer, store, changeOrderId: params.changeOrderId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('POST', '/change-orders/{changeOrderId}:withdraw', 'withdrawChangeOrder', ({ viewer, params, body, headers }) =>
    withdrawChangeOrder({ viewer, store, changeOrderId: params.changeOrderId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  // ── phase 5: measurements ─────────────────────────────────────────────────
  router.register('GET', '/contracts/{contractId}/measurements:suggest', 'suggestMeasurement', ({ viewer, params, query }) =>
    suggestMeasurement({ viewer, store, contractId: params.contractId, query }));

  router.register('POST', '/contracts/{contractId}/measurements', 'createMeasurement', ({ viewer, params, body }) =>
    createMeasurement({ viewer, store, contractId: params.contractId, body }));

  router.register('POST', '/measurements/{measurementId}:approve', 'approveMeasurement', ({ viewer, params }) =>
    approveMeasurement({ viewer, store, measurementId: params.measurementId }));

  router.register('POST', '/measurements/{measurementId}:dispute', 'disputeMeasurement', ({ viewer, params, body }) =>
    disputeMeasurement({ viewer, store, measurementId: params.measurementId, body }));

  // ── phase 5: payments + owner cash-flow ───────────────────────────────────
  router.register('POST', '/payments/{paymentId}:declare-paid', 'declarePaid', ({ viewer, params }) =>
    declarePaid({ viewer, store, paymentId: params.paymentId }));

  router.register('POST', '/payments/{paymentId}:confirm', 'confirmPayment', ({ viewer, params }) =>
    confirmPayment({ viewer, store, paymentId: params.paymentId }));

  router.register('POST', '/payments/{paymentId}:dispute', 'disputePayment', ({ viewer, params, body }) =>
    disputePayment({ viewer, store, paymentId: params.paymentId, body }));

  router.register('GET', '/projects/{projectId}/cash-flow', 'getCashFlow', ({ viewer, params, query }) =>
    getCashFlow({ viewer, store, projectId: params.projectId, query }));
}
