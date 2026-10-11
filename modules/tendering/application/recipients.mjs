// Draft recipient list — operationId removeRecipient (PRD-02 T-6).
//
// While an RFP is a draft nothing has left the server: addRecipients only
// queued the recipient (no email, no token), so taking one off the list is a
// plain removal of the recipient and the empty lane it opened. After publish a
// bidder holds a live personal link and has been emailed — removal is refused;
// the lane stays as evidence and lapses (declined) at award.
//
// Authorization: the issuer gate (permission org:tendering:issue ∧ issuer ∧
// staffing), with 404 existence hiding for everyone else (V8).
import { ProblemError } from '../../../platform/errors.mjs';
import { requireIssuer, requireActor, actorOf } from './use-cases.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** operationId: removeRecipient — DELETE /rfps/{rfpId}/recipients/{recipientId}. */
export async function removeRecipient({ viewer, store, rfpId, recipientId }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  if (!UUID.test(recipientId ?? '')) throw new ProblemError('not_found', 'no such recipient');
  if (rfp.status !== 'draft') {
    throw new ProblemError('invalid_transition', 'a bidder who has been sent the RFP cannot be removed');
  }
  const rec = await store.getRecipient(rfpId, recipientId);
  if (!rec) throw new ProblemError('not_found', 'no such recipient');
  const actor = await requireActor(store, viewer);
  const removed = await store.removeDraftRecipient({
    rfpId, recipientId, projectId: rfp.project_id, actor: actorOf(actor, viewer),
  });
  // Null: the RFP left draft between the read and the delete.
  if (!removed) throw new ProblemError('invalid_transition', 'a bidder who has been sent the RFP cannot be removed');
  return { status: 204, body: null };
}
