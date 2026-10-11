// Requests to bid on a listed RFP (PRD-04 X-5, X-13; D-47) — one function per
// operationId: applyToOpenRfp (now "ask to bid"), listBidRequests,
// approveBidRequest, declineBidRequest.
//
// D-47 amends D-40 Slice 1: a company that finds a listed RFP never claims a
// lane by itself. It asks; the issuer approves (the lane and the personal link
// exist from that moment, adopting a prior e-mail invite to the org's address)
// or declines. Both decisions are events the notification centre turns into a
// notice for the company; the ask is one for the issuer.
//
// Authorization (doc 16 conjunction): ask = org:tendering:bid on a listed,
// published RFP (404 otherwise — V8); list/decide = the issuer gate
// (org:tendering:issue ∧ issuer ∧ staffing). The company's proof lines come
// from the directory's published port, the build's point from the project's —
// tendering reads neither table.
import { randomUUID } from 'node:crypto';

import { ProblemError } from '../../../platform/errors.mjs';
import { askable, bidRequestBody, decidable } from '../domain/bid-requests.mjs';
import { requireIssuer, requireActor, actorOf, dispatchInvite } from './use-cases.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * operationId: applyToOpenRfp — ask to bid (D-47). 201 a new pending request;
 * 200 the existing one (idempotent per RFP and organisation).
 */
export async function applyToOpenRfp({ viewer, store, rfpId, idempotencyKey = null, now = new Date() }) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
  if (!viewer.has('org:tendering:bid')) throw new ProblemError('forbidden', null, { reason: 'role' });
  if (!UUID.test(rfpId ?? '')) throw new ProblemError('not_found');
  // A replay answers the original result even after the RFP moved on.
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'applyToOpenRfp', body: { rfp_id: rfpId, org_id: viewer.orgId } },
    () => askToBid({ viewer, store, rfpId, now }),
  );
}

async function askToBid({ viewer, store, rfpId, now }) {
  const rfp = await store.getRfp(rfpId);
  const can = askable(rfp, { orgId: viewer.orgId, now });
  if (!can.ok) {
    if (can.code === 'validation_failed') throw new ProblemError('validation_failed', null, { errors: { rfp: can.reason } });
    throw new ProblemError(can.code, can.reason ?? null);
  }
  if (await store.isRecipient(rfpId, viewer.orgId)) {
    throw new ProblemError('invalid_transition', 'your organisation is already invited to this RFP — price it from your requests');
  }
  const actor = await requireActor(store, viewer);
  const { request, created } = await store.createBidRequest({
    id: randomUUID(), rfpId, projectId: rfp.project_id, orgId: viewer.orgId, actor: actorOf(actor, viewer),
  });
  return { status: created ? 201 : 200, body: bidRequestBody(request) };
}

/** operationId: listBidRequests — the issuer's "Asking to bid", with proof lines. */
export async function listBidRequests({ viewer, store, directory, builds, rfpId }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  const rows = await store.listBidRequests(rfpId);
  const proofs = await proofsFor({ directory, builds, rfp, orgIds: rows.map((r) => r.org_id) });
  return {
    status: 200,
    body: { items: rows.map((r) => bidRequestBody(r, { issuer: true, company: proofs.get(r.org_id) ?? null })) },
  };
}

/**
 * operationId: approveBidRequest — the lane and the personal link exist from
 * here; the link is e-mailed to the organisation's address. A prior e-mail
 * invite to that address is adopted (no second link is minted or sent).
 */
export async function approveBidRequest({
  viewer, store, directory, builds, mailSender, linkBaseUrl, bidRequestId, idempotencyKey = null,
}) {
  const { request, rfp } = await requireDecider({ viewer, store, bidRequestId });
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'approveBidRequest', body: { bid_request_id: request.id } },
    () => approve({ viewer, store, directory, builds, mailSender, linkBaseUrl, request, rfp }),
  );
}

async function approve({ viewer, store, directory, builds, mailSender, linkBaseUrl, request, rfp }) {
  const ok = decidable(request, rfp, 'approve');
  if (!ok.ok) throw new ProblemError('invalid_transition', ok.reason);
  const org = await store.getOrganization(request.org_id);
  const email = org?.billing_email ?? org?.contact_email ?? null;
  if (!email) {
    throw new ProblemError('validation_failed', null, { errors: { org: 'the company has no contact e-mail to send its link to' } });
  }
  const actor = await requireActor(store, viewer);
  const approved = await store.approveBidRequest({
    requestId: request.id, rfpId: rfp.id, projectId: rfp.project_id, orgId: request.org_id,
    email: email.toLowerCase(), actor: actorOf(actor, viewer),
  });
  if (!approved) throw new ProblemError('invalid_transition', 'this request was decided meanwhile — reload');
  if (approved.token) {
    await dispatchInvite({ store, mailSender, linkBaseUrl, rfp, recipient: approved.recipient, token: approved.token });
  }
  const proofs = await proofsFor({ directory, builds, rfp, orgIds: [request.org_id] });
  return {
    status: 200,
    body: bidRequestBody(approved.request, { issuer: true, company: proofs.get(request.org_id) ?? null }),
  };
}

/** operationId: declineBidRequest — no lane, no link; the company is told. */
export async function declineBidRequest({ viewer, store, bidRequestId, idempotencyKey = null }) {
  const { request, rfp } = await requireDecider({ viewer, store, bidRequestId });
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'declineBidRequest', body: { bid_request_id: request.id } },
    () => decline({ viewer, store, request, rfp }),
  );
}

async function decline({ viewer, store, request, rfp }) {
  const ok = decidable(request, rfp, 'decline');
  if (!ok.ok) throw new ProblemError('invalid_transition', ok.reason);
  const actor = await requireActor(store, viewer);
  const declined = await store.declineBidRequest({
    requestId: request.id, projectId: rfp.project_id, actor: actorOf(actor, viewer),
  });
  if (!declined) throw new ProblemError('invalid_transition', 'this request was decided meanwhile — reload');
  return { status: 200, body: bidRequestBody(declined, { issuer: true }) };
}

/** The request and its RFP, behind the issuer gate (404 for anyone else, V8). */
async function requireDecider({ viewer, store, bidRequestId }) {
  if (!UUID.test(bidRequestId ?? '')) throw new ProblemError('not_found');
  const request = await store.getBidRequest(bidRequestId);
  if (!request) throw new ProblemError('not_found');
  const { rfp } = await requireIssuer({ viewer, store, rfpId: request.rfp_id });
  return { request, rfp };
}

/** Company proof lines by org id, measured from the RFP's build when it has a point. */
export async function proofsFor({ directory, builds, rfp, orgIds }) {
  if (!directory || !orgIds.length) return new Map();
  const [build] = builds ? await builds.factsOf([rfp.project_id]) : [];
  const near = build?.lat != null ? { lat: build.lat, lng: build.lng } : null;
  const list = await directory.proofsOf([...new Set(orgIds)], { near });
  return new Map(list.map((p) => [p.org_id, p]));
}
