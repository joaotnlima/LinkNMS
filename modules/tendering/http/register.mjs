// Tendering module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
// Phase 6 surface: the whole Tendering tag — RFP lifecycle, recipients,
// clarifications, proposal lanes, comparison, award.
import {
  createRfp, getRfp, updateRfp, addRecipients, listRecipients, previewInviteEmail,
  reissueRecipientLink, publishRfp,
  addAddendum, closeRfp, cancelRfp, browseOpenRfps, applyToOpenRfp, listMyRfps,
  askClarification, askClarificationByToken, answerClarification, listProposalLanes, getProposal,
  putProposal, submitProposal, withdrawProposal, recordOfflineProposal,
  submitOwnBid, getComparison, shortlistProposal, awardRfp,
  getRfpByToken, submitProposalByToken,
  reserveProposalDocumentByToken, completeProposalDocumentByToken, downloadProposalDocument,
  reserveRfpModel, completeRfpModel, removeRfpModel, rfpModelViewUrl, rfpModelViewUrlByToken, attachRfpModel,
} from '../application/use-cases.mjs';
import { listTaskProcurement } from '../application/task-procurement.mjs';
import { listProjectRfps } from '../application/project-rfps.mjs';
import { removeRecipient } from '../application/recipients.mjs';
import { listBidRequests, approveBidRequest, declineBidRequest } from '../application/bid-requests.mjs';
import { listRequestsForMe, listOpenRequests, declineRfpInvitation } from '../application/company-inbox.mjs';

/**
 * @param {{ store: object, storage: object, contractingAward: Function,
 *           mailSender?: object, linkBaseUrl?: string|Function }} deps
 *   storage — the object-store port (documents module's R2 adapter), shared so
 *     token-scoped proposal attachments (LINA-370) live on the same bucket.
 *   contractingAward — the contracting module's award port
 *   (modules/contracting/application/award.mjs), run on the award transaction.
 *   mailSender — the MailSender port (infra/mail-sender.mjs) the invite dispatch
 *     sends each recipient's secure link through (LINA-412). Optional; absent in
 *     DB-free unit tests, which assert dispatch via a capturing double instead.
 *   linkBaseUrl — origin the `/rfp/{token}` link is built on; string or a thunk.
 *   documentsStore — the Documents module's store (LINA-409 / doc 24): the RFP
 *     BIM model is a documents.document; tendering owns the RFP authorization
 *     and delegates the model's persistence to this injected store.
 *   directory — the directory's published company port (PRD-04): a profile's
 *     contact for an invite, proof lines, a company's bidding profile.
 *   builds — the project module's build port (`factsOf`): build name,
 *     municipality and point for the inbox and distances.
 */
export function registerTendering(router, {
  store, storage, documentsStore, contractingAward, mailSender, linkBaseUrl, directory, builds, orgs,
} = {}) {
  // The link origin may be supplied as a thunk (env read deferred to request
  // time, as the project module's shareBaseUrl is); resolve it per call.
  const baseUrl = () => (typeof linkBaseUrl === 'function' ? linkBaseUrl() : linkBaseUrl);
  // Public personal link (gap S1) — security: [], no viewer. The token is the
  // authority; the /api/v2 adapter lets these two through without a session
  // (path[0] === 'rfp-links'), exactly as it does the Clerk webhook.
  router.register('GET', '/rfp-links/{token}', 'getRfpByToken', ({ params }) =>
    getRfpByToken({ store, documentsStore, token: params.token }));

  // Public token-scoped BIM model view-url (security: []) — the token is the
  // authority; a short-TTL presigned INLINE GET is minted server-side and only
  // the URL reaches the browser (doc 24). path[0] === 'rfp-links' → anonymous.
  router.register('GET', '/rfp-links/{token}/model/{documentId}:view-url', 'rfpModelViewUrlByToken', ({ params }) =>
    rfpModelViewUrlByToken({ store, documentsStore, storage, token: params.token, documentId: params.documentId }));

  router.register('POST', '/rfp-links/{token}/proposal', 'submitProposalByToken', ({ params, body }) =>
    submitProposalByToken({ store, token: params.token, body }));

  // A link-only bidder asks a question (PRD-08 H-6) — security: [], the token
  // is the authority; refused after the questions deadline (H-9).
  router.register('POST', '/rfp-links/{token}/clarifications', 'askClarificationByToken', ({ params, body, headers }) =>
    askClarificationByToken({ store, token: params.token, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  // Token-scoped portfolio-image upload (LINA-370) — also security: [], the
  // token is the authority. Reserve a presigned PUT, then prove the bytes.
  router.register('POST', '/rfp-links/{token}/documents', 'reserveProposalDocumentByToken', ({ params, body }) =>
    reserveProposalDocumentByToken({ store, storage, token: params.token, body }));

  router.register('POST', '/rfp-links/{token}/documents/{documentId}:complete', 'completeProposalDocumentByToken', ({ params }) =>
    completeProposalDocumentByToken({ store, storage, token: params.token, documentId: params.documentId }));

  // The authed read side of an attachment: issuer or bidder, 302 to a
  // short-lived presigned GET (viewer required — path[0] !== 'rfp-links').
  router.register('GET', '/proposals/{proposalId}/documents/{documentId}:download', 'downloadProposalDocument', ({ viewer, params }) =>
    downloadProposalDocument({ viewer, store, storage, proposalId: params.proposalId, documentId: params.documentId }));

  router.register('POST', '/projects/{projectId}/rfps', 'createRfp', ({ viewer, params, body, headers }) =>
    createRfp({ viewer, store, projectId: params.projectId, body, idempotencyKey: headers['idempotency-key'] }));

  // The plan's per-task procurement projection (PRD-01 G-2/G-3): one read for
  // the Tender column + Gantt band, issuer-scoped, no money.
  // The tendering home (PRD-08 H-1): every RFP the viewer can see on the
  // project, with covered tasks, bids due, n/m in and open questions — one read.
  router.register('GET', '/projects/{projectId}/rfps', 'listProjectRfps', ({ viewer, params }) =>
    listProjectRfps({ viewer, store, orgs, projectId: params.projectId }));

  router.register('GET', '/projects/{projectId}/task-procurement', 'listTaskProcurement', ({ viewer, params }) =>
    listTaskProcurement({ viewer, store, orgs, projectId: params.projectId }));

  router.register('GET', '/rfps/{rfpId}', 'getRfp', ({ viewer, params }) =>
    getRfp({ viewer, store, documentsStore, rfpId: params.rfpId }));

  // BIM model (LINA-409 / doc 24) — attach/replace/remove are issuer-only on a
  // draft; the authed view-url is any RFP reader. The model is a Documents-
  // module document; tendering owns the gate, documentsStore owns persistence.
  router.register('POST', '/rfps/{rfpId}/model', 'reserveRfpModel', ({ viewer, params, body }) =>
    reserveRfpModel({ viewer, store, documentsStore, storage, rfpId: params.rfpId, body }));

  router.register('PUT', '/rfps/{rfpId}/model', 'attachRfpModel', ({ viewer, params, body }) =>
    attachRfpModel({ viewer, store, documentsStore, rfpId: params.rfpId, body }));

  router.register('POST', '/rfps/{rfpId}/model/{documentId}:complete', 'completeRfpModel', ({ viewer, params }) =>
    completeRfpModel({ viewer, store, documentsStore, storage, rfpId: params.rfpId, documentId: params.documentId }));

  router.register('DELETE', '/rfps/{rfpId}/model/{documentId}', 'removeRfpModel', ({ viewer, params }) =>
    removeRfpModel({ viewer, store, documentsStore, rfpId: params.rfpId, documentId: params.documentId }));

  router.register('GET', '/rfps/{rfpId}/model/{documentId}:view-url', 'rfpModelViewUrl', ({ viewer, params }) =>
    rfpModelViewUrl({ viewer, store, documentsStore, storage, rfpId: params.rfpId, documentId: params.documentId }));

  router.register('PATCH', '/rfps/{rfpId}', 'updateRfp', ({ viewer, params, body, headers }) =>
    updateRfp({ viewer, store, rfpId: params.rfpId, body, ifMatch: headers['if-match'] }));

  router.register('POST', '/rfps/{rfpId}/recipients', 'addRecipients', ({ viewer, params, body }) =>
    addRecipients({ viewer, store, directory, mailSender, linkBaseUrl: baseUrl(), rfpId: params.rfpId, body }));

  router.register('GET', '/rfps/{rfpId}/recipients', 'listRecipients', ({ viewer, params, query }) =>
    listRecipients({ viewer, store, rfpId: params.rfpId, query }));

  // Preview the invite email copy before sending (LINA-412, pen frame 986).
  // Issuer-only; the previewed link is a non-secret placeholder (no live token).
  router.register('GET', '/rfps/{rfpId}/invite-email:preview', 'previewInviteEmail', ({ viewer, params, query }) =>
    previewInviteEmail({ viewer, store, linkBaseUrl: baseUrl(), rfpId: params.rfpId, query }));

  // Take a queued bidder off a DRAFT (PRD-02 T-6) — nothing was sent yet.
  router.register('DELETE', '/rfps/{rfpId}/recipients/{recipientId}', 'removeRecipient', ({ viewer, params }) =>
    removeRecipient({ viewer, store, rfpId: params.rfpId, recipientId: params.recipientId }));

  // Rotate a recipient's leaked/forwarded personal link: mint a fresh token,
  // kill the old (gap S1, LINA-373). Issuer-only; the token is in the response
  // ONCE, never the path.
  router.register('POST', '/rfps/{rfpId}/recipients/{recipientId}:reissue', 'reissueRecipientLink',
    ({ viewer, params }) =>
      reissueRecipientLink({ viewer, store, mailSender, linkBaseUrl: baseUrl(), rfpId: params.rfpId, recipientId: params.recipientId }));

  router.register('POST', '/rfps/{rfpId}:publish', 'publishRfp', ({ viewer, params }) =>
    publishRfp({ viewer, store, builds, mailSender, linkBaseUrl: baseUrl(), rfpId: params.rfpId }));

  router.register('POST', '/rfps/{rfpId}/addenda', 'addAddendum', ({ viewer, params, body }) =>
    addAddendum({ viewer, store, rfpId: params.rfpId, body }));

  router.register('POST', '/rfps/{rfpId}:close', 'closeRfp', ({ viewer, params }) =>
    closeRfp({ viewer, store, rfpId: params.rfpId }));

  router.register('POST', '/rfps/{rfpId}:cancel', 'cancelRfp', ({ viewer, params, body }) =>
    cancelRfp({ viewer, store, rfpId: params.rfpId, body }));

  router.register('GET', '/marketplace/rfps', 'browseOpenRfps', ({ viewer, query }) =>
    browseOpenRfps({ viewer, store, query }));

  // Ask to bid on a listed RFP (D-47, PRD-04 X-13): a PENDING request, never
  // a lane. The issuer approves (lane + link) or declines.
  router.register('POST', '/rfps/{rfpId}:apply', 'applyToOpenRfp', ({ viewer, params, headers }) =>
    applyToOpenRfp({ viewer, store, rfpId: params.rfpId, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('GET', '/rfps/{rfpId}/bid-requests', 'listBidRequests', ({ viewer, params }) =>
    listBidRequests({ viewer, store, directory, builds, rfpId: params.rfpId }));

  router.register('POST', '/bid-requests/{bidRequestId}:approve', 'approveBidRequest', ({ viewer, params, headers }) =>
    approveBidRequest({
      viewer, store, directory, builds, mailSender, linkBaseUrl: baseUrl(), bidRequestId: params.bidRequestId,
      idempotencyKey: headers['idempotency-key'] ?? null,
    }));

  router.register('POST', '/bid-requests/{bidRequestId}:decline', 'declineBidRequest', ({ viewer, params, headers }) =>
    declineBidRequest({ viewer, store, bidRequestId: params.bidRequestId, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('GET', '/me/rfps', 'listMyRfps', ({ viewer, query }) =>
    listMyRfps({ viewer, store, query }));

  // The company inbox (PRD-04 X-9, X-10): requests for you, open requests near
  // you, and declining an invitation.
  router.register('GET', '/me/rfp-requests', 'listRequestsForMe', ({ viewer, query }) =>
    listRequestsForMe({ viewer, store, builds, query }));

  router.register('GET', '/me/open-requests', 'listOpenRequests', ({ viewer, query }) =>
    listOpenRequests({ viewer, store, directory, builds, query }));

  router.register('POST', '/rfps/{rfpId}/invitation:decline', 'declineRfpInvitation', ({ viewer, params, headers }) =>
    declineRfpInvitation({ viewer, store, builds, rfpId: params.rfpId, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('POST', '/rfps/{rfpId}/clarifications', 'askClarification', ({ viewer, params, body }) =>
    askClarification({ viewer, store, rfpId: params.rfpId, body }));

  router.register('POST', '/clarifications/{clarificationId}:answer', 'answerClarification', ({ viewer, params, body }) =>
    answerClarification({ viewer, store, builds, mailSender, clarificationId: params.clarificationId, body }));

  router.register('GET', '/tasks/{taskId}/proposal-lanes', 'listProposalLanes', ({ viewer, params, query }) =>
    listProposalLanes({ viewer, store, taskId: params.taskId, query }));

  router.register('GET', '/proposals/{proposalId}', 'getProposal', ({ viewer, params }) =>
    getProposal({ viewer, store, proposalId: params.proposalId }));

  router.register('PUT', '/proposals/{proposalId}', 'putProposal', ({ viewer, params, body, headers }) =>
    putProposal({ viewer, store, proposalId: params.proposalId, body, ifMatch: headers['if-match'] }));

  router.register('POST', '/proposals/{proposalId}:submit', 'submitProposal', ({ viewer, params }) =>
    submitProposal({ viewer, store, proposalId: params.proposalId }));

  // Self-serve SUMMARY bid (LINA-406): the authenticated twin of the public
  // token submit — the bidder prices + sends a single-total bid in its own lane,
  // actor recorded as the real person+org (not anonymous `public_link`).
  router.register('POST', '/proposals/{proposalId}:submit-bid', 'submitOwnBid', ({ viewer, params, body }) =>
    submitOwnBid({ viewer, store, proposalId: params.proposalId, body }));

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
