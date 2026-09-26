// Tendering module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
// Phase 6 surface: the whole Tendering tag — RFP lifecycle, recipients,
// clarifications, proposal lanes, comparison, award.
import {
  createRfp, getRfp, updateRfp, addRecipients, listRecipients, publishRfp,
  addAddendum, closeRfp, cancelRfp, browseOpenRfps, listMyRfps,
  askClarification, answerClarification, listProposalLanes, getProposal,
  putProposal, submitProposal, withdrawProposal, recordOfflineProposal,
  getComparison, shortlistProposal, awardRfp,
} from '../application/use-cases.mjs';

/**
 * @param {{ store: object, contractingAward: Function }} deps
 *   contractingAward — the contracting module's award port
 *   (modules/contracting/application/award.mjs), run on the award transaction.
 */
export function registerTendering(router, { store, contractingAward }) {
  router.register('POST', '/projects/{projectId}/rfps', 'createRfp', ({ viewer, params, body, headers }) =>
    createRfp({ viewer, store, projectId: params.projectId, body, idempotencyKey: headers['idempotency-key'] }));

  router.register('GET', '/rfps/{rfpId}', 'getRfp', ({ viewer, params }) =>
    getRfp({ viewer, store, rfpId: params.rfpId }));

  router.register('PATCH', '/rfps/{rfpId}', 'updateRfp', ({ viewer, params, body, headers }) =>
    updateRfp({ viewer, store, rfpId: params.rfpId, body, ifMatch: headers['if-match'] }));

  router.register('POST', '/rfps/{rfpId}/recipients', 'addRecipients', ({ viewer, params, body }) =>
    addRecipients({ viewer, store, rfpId: params.rfpId, body }));

  router.register('GET', '/rfps/{rfpId}/recipients', 'listRecipients', ({ viewer, params, query }) =>
    listRecipients({ viewer, store, rfpId: params.rfpId, query }));

  router.register('POST', '/rfps/{rfpId}:publish', 'publishRfp', ({ viewer, params }) =>
    publishRfp({ viewer, store, rfpId: params.rfpId }));

  router.register('POST', '/rfps/{rfpId}/addenda', 'addAddendum', ({ viewer, params, body }) =>
    addAddendum({ viewer, store, rfpId: params.rfpId, body }));

  router.register('POST', '/rfps/{rfpId}:close', 'closeRfp', ({ viewer, params }) =>
    closeRfp({ viewer, store, rfpId: params.rfpId }));

  router.register('POST', '/rfps/{rfpId}:cancel', 'cancelRfp', ({ viewer, params }) =>
    cancelRfp({ viewer, store, rfpId: params.rfpId }));

  router.register('GET', '/marketplace/rfps', 'browseOpenRfps', ({ viewer, query }) =>
    browseOpenRfps({ viewer, store, query }));

  router.register('GET', '/me/rfps', 'listMyRfps', ({ viewer, query }) =>
    listMyRfps({ viewer, store, query }));

  router.register('POST', '/rfps/{rfpId}/clarifications', 'askClarification', ({ viewer, params, body }) =>
    askClarification({ viewer, store, rfpId: params.rfpId, body }));

  router.register('POST', '/clarifications/{clarificationId}:answer', 'answerClarification', ({ viewer, params, body }) =>
    answerClarification({ viewer, store, clarificationId: params.clarificationId, body }));

  router.register('GET', '/tasks/{taskId}/proposal-lanes', 'listProposalLanes', ({ viewer, params, query }) =>
    listProposalLanes({ viewer, store, taskId: params.taskId, query }));

  router.register('GET', '/proposals/{proposalId}', 'getProposal', ({ viewer, params }) =>
    getProposal({ viewer, store, proposalId: params.proposalId }));

  router.register('PUT', '/proposals/{proposalId}', 'putProposal', ({ viewer, params, body, headers }) =>
    putProposal({ viewer, store, proposalId: params.proposalId, body, ifMatch: headers['if-match'] }));

  router.register('POST', '/proposals/{proposalId}:submit', 'submitProposal', ({ viewer, params }) =>
    submitProposal({ viewer, store, proposalId: params.proposalId }));

  router.register('POST', '/proposals/{proposalId}:withdraw', 'withdrawProposal', ({ viewer, params }) =>
    withdrawProposal({ viewer, store, proposalId: params.proposalId }));

  router.register('POST', '/proposals/{proposalId}:record-offline', 'recordOfflineProposal', ({ viewer, params, body }) =>
    recordOfflineProposal({ viewer, store, proposalId: params.proposalId, body }));

  router.register('GET', '/rfps/{rfpId}/comparison', 'getComparison', ({ viewer, params }) =>
    getComparison({ viewer, store, rfpId: params.rfpId }));

  router.register('POST', '/proposals/{proposalId}:shortlist', 'shortlistProposal', ({ viewer, params }) =>
    shortlistProposal({ viewer, store, proposalId: params.proposalId }));

  router.register('POST', '/rfps/{rfpId}:award', 'awardRfp', ({ viewer, params, body }) =>
    awardRfp({ viewer, store, rfpId: params.rfpId, body, contractingAward }));
}
