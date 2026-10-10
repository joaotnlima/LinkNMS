// The company inbox data layer on `/api/v2` (PRD-04 X-9..X-12, D-47). It
// replaces the inverted marketplace (LINA-406): a company no longer browses
// and claims a lane — it reads the requests made to it, the listed requests
// that match its profile, ASKS to bid on one (a pending request the owner
// approves) and prices the requests it holds a lane on (X-11).
//
// I/O only — the wording is `./rfp-directory-view.ts`. Reads fail closed to
// their empty shape (no active org, no bid permission → nothing, never a
// leak); writes return the server's refusal as a message to show.
import 'server-only';

import { v2, V2Error } from './client';
import { getRfp } from './tendering';
import type { V2BidRequest, V2CompanyRequest, V2OpenRequest } from './rfp-directory-view';
import type { V2Money, V2Rfp } from './tendering-view';

export type WriteResult<T> = { ok: true; data: T } | { ok: false; message: string; fieldErrors?: Record<string, string> };

async function write<T>(call: () => Promise<T>): Promise<WriteResult<T>> {
  try {
    return { ok: true, data: await call() };
  } catch (err) {
    if (err instanceof V2Error) return { ok: false, message: err.detail || err.message, fieldErrors: err.errors ?? undefined };
    throw err;
  }
}

/** GET /me/rfp-requests — "Requests for you" (X-9). */
export async function listRequestsForMe(): Promise<V2CompanyRequest[]> {
  try {
    const res = await v2<{ items: V2CompanyRequest[] }>({ method: 'GET', path: '/me/rfp-requests', query: { limit: 100 } });
    return res.items ?? [];
  } catch (err) {
    if (err instanceof V2Error) return [];
    throw err;
  }
}

/** GET /me/open-requests — "Open requests near you" (X-10). */
export async function listOpenRequests(): Promise<{ items: V2OpenRequest[]; profileMissing: boolean }> {
  try {
    const res = await v2<{ items: V2OpenRequest[]; profile_missing: boolean }>({ method: 'GET', path: '/me/open-requests' });
    return { items: res.items ?? [], profileMissing: Boolean(res.profile_missing) };
  } catch (err) {
    if (err instanceof V2Error) return { items: [], profileMissing: false };
    throw err;
  }
}

/** POST /rfps/{id}:apply — ask to bid (D-47): a pending request, never a lane. */
export function askToBid(rfpId: string): Promise<WriteResult<V2BidRequest>> {
  return write(() => v2<V2BidRequest>({ method: 'POST', path: `/rfps/${encodeURIComponent(rfpId)}:apply`, idempotencyKey: `ask-${rfpId}` }));
}

/** POST /rfps/{id}/invitation:decline — the company will not bid (X-9). */
export function declineInvitation(rfpId: string): Promise<WriteResult<V2CompanyRequest>> {
  return write(() => v2<V2CompanyRequest>({ method: 'POST', path: `/rfps/${encodeURIComponent(rfpId)}/invitation:decline` }));
}

// ── pricing in-app (X-11) ────────────────────────────────────────────────────

/** The bidder's OWN proposal lane (a slice of #/components/schemas/Proposal). */
export interface V2OwnProposal {
  id: string;
  rfp_id: string;
  status: string;
  summary?: { total: V2Money; duration_wd?: number; start?: string };
  conditions?: string;
  validity_until?: string;
  document_ids?: string[];
  version: number;
}

/** The lane the bid editor prices — id + current figure. */
export interface AppliedLane {
  proposal_id: string;
  status: string;
  summary?: { total: V2Money; duration_wd?: number };
  conditions?: string;
  validity_until?: string;
}

function toLane(p: V2OwnProposal): AppliedLane {
  return { proposal_id: p.id, status: p.status, summary: p.summary, conditions: p.conditions, validity_until: p.validity_until };
}

/** The summary bid a bidder prices and sends (wire shape). */
export interface SummaryBidInput {
  total: V2Money;
  duration_wd: number;
  conditions?: string;
  validity_until?: string;
  document_ids?: string[];
}

/** POST /proposals/{id}:submit-bid — price and send (or revise) the bidder's own summary bid. */
export function sendBid(proposalId: string, bid: SummaryBidInput): Promise<WriteResult<AppliedLane>> {
  return write(async () => toLane(await v2<V2OwnProposal>({
    method: 'POST',
    path: `/proposals/${encodeURIComponent(proposalId)}:submit-bid`,
    body: {
      total: bid.total,
      duration_wd: bid.duration_wd,
      ...(bid.conditions ? { conditions: bid.conditions } : {}),
      ...(bid.validity_until ? { validity_until: bid.validity_until } : {}),
      document_ids: bid.document_ids ?? [],
    },
  })));
}

export interface BidContext {
  rfp: V2Rfp;
  request: V2CompanyRequest;
  lane: AppliedLane;
}

/**
 * Everything `/requests/{rfpId}` needs: the RFP as this bidder may read it,
 * the org's invite to it (from the inbox) and its OWN lane. Since D-47 this
 * never claims a lane: a company without an invite is told to ask to bid.
 */
export async function loadBidContext(rfpId: string): Promise<{ ok: true; ctx: BidContext } | { ok: false; message: string }> {
  const requests = await listRequestsForMe();
  const request = requests.find((r) => r.rfp_id === rfpId) ?? null;
  if (!request?.proposal_id) {
    return { ok: false, message: 'You have no invitation to this request. Ask to bid from your open requests — the owner approves each company.' };
  }
  const [rfp, proposal] = await Promise.all([
    getRfp(rfpId),
    v2<V2OwnProposal>({ method: 'GET', path: `/proposals/${encodeURIComponent(request.proposal_id)}` }).catch((err) => {
      if (err instanceof V2Error) return null;
      throw err;
    }),
  ]);
  if (!rfp || !proposal) return { ok: false, message: 'This request is no longer available to you.' };
  return { ok: true, ctx: { rfp, request, lane: toLane(proposal) } };
}
