// The open-marketplace data layer, on `/api/v2` (LINA-406, "#2 open marketplace").
//
// ── WHAT THIS UNLOCKS ─────────────────────────────────────────────────────────
// The tendering backend already published two pieces nothing in the UI could
// reach: `GET /marketplace/rfps` (browse every OPEN, published RFP — D-15) and
// `POST /rfps/{id}:apply` (a bidder claims its own lane on one it found, the
// self-serve hinge, LINA-406 Slice 1). Until now a company could only bid on an
// RFP it was emailed a token for; discovery was impossible. This module is the
// read/write seam the `/marketplace` surface renders from.
//
// Mirrors the house style of `tendering.ts`/`profile.ts`: this file is ONLY the
// I/O and the fail-closed posture — the pure wire→view transforms stay in
// `tendering-view.ts`. Every call goes through the single shared v2 seam
// (`./client.ts::v2`); there is deliberately no second client (LINA-309).
//
// Fail-closed exactly as the other reads: a `V2Error` on a browse/list (no active
// org, not permitted to bid, not mirrored) resolves to an empty list — an honest
// "nothing to discover yet", never a rendered 500 and never a leak of an RFP's
// existence (V8). The one WRITE, `applyToOpenRfp`, surfaces its `V2Error`: a
// refused apply (deadline passed, issuer bidding on itself) is an answer the
// browser must show, not swallow.
import 'server-only';

import { v2, V2Error } from './client';
import { getRfp } from './tendering';
import type { V2Me } from './profile-view';
import type { V2Money, V2Rfp } from './tendering-view';

interface ListBody<T> {
  items: T[];
  next_cursor?: string | null;
}

export interface MarketplaceFilters {
  /** A single specialty to narrow the open listing to (server-side filter). */
  specialty?: string;
  /** A municipality (project location) to narrow by (server-side filter). */
  municipality?: string;
}

/**
 * GET /marketplace/rfps → every OPEN, published RFP a bidder org can discover
 * (D-15). Returns [] for a viewer with no active org or any V2Error — the same
 * fail-closed empty posture the rest of v2 takes, so a viewer who cannot bid (no
 * `org:tendering:bid`) simply sees an empty marketplace, never an error page.
 */
export async function browseOpenMarketplace(filters: MarketplaceFilters = {}): Promise<V2Rfp[]> {
  const me = await v2<V2Me>({ method: 'GET', path: '/me' }).catch(() => null);
  if (!me?.active_org) return []; // no org → nothing to scope a browse to
  try {
    const list = await v2<ListBody<V2Rfp>>({
      method: 'GET',
      path: '/marketplace/rfps',
      query: {
        specialty: filters.specialty || undefined,
        municipality: filters.municipality || undefined,
      },
    });
    return list.items ?? [];
  } catch (err) {
    if (err instanceof V2Error) return [];
    throw err;
  }
}

/**
 * GET /me/rfps → the RFPs this org was invited to OR has applied to. The
 * marketplace uses it to mark a browse card the org has already claimed a lane
 * on, so "Apply" never reads as a second, duplicate action. Fail-closed to [].
 */
export async function listMyApplications(): Promise<V2Rfp[]> {
  const me = await v2<V2Me>({ method: 'GET', path: '/me' }).catch(() => null);
  if (!me?.active_org) return [];
  try {
    const list = await v2<ListBody<V2Rfp>>({ method: 'GET', path: '/me/rfps' });
    return list.items ?? [];
  } catch (err) {
    if (err instanceof V2Error) return [];
    throw err;
  }
}

/**
 * The bidder's OWN proposal lane (a slice of #/components/schemas/Proposal). A
 * bidder always sees its own money, so `summary` is present once the lane has a
 * figure — the editor reads it to prefill a revise, and the card reads `status`.
 */
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

/** The lane an apply (or a reload of it) resolved to — id + current figure. */
export interface AppliedLane {
  proposal_id: string;
  status: string;
  summary?: { total: V2Money; duration_wd?: number };
  conditions?: string;
  validity_until?: string;
}

function toAppliedLane(p: V2OwnProposal): AppliedLane {
  return {
    proposal_id: p.id,
    status: p.status,
    summary: p.summary,
    conditions: p.conditions,
    validity_until: p.validity_until,
  };
}

export type ApplyResult =
  | { ok: true; lane: AppliedLane }
  | { ok: false; message: string };

/**
 * POST /rfps/{rfpId}:apply → claim this org's own proposal lane on an open RFP
 * it discovered. Idempotent server-side (first call 201, a repeat 200), so a
 * double-click lands one lane, not two — and so loading the bid page re-resolves
 * the SAME lane rather than forking one. A refusal (deadline passed, the issuer
 * cannot bid on its own RFP, the RFP is not actually open) comes back as a
 * message for the browser to show — never swallowed into a false success.
 */
export async function applyToOpenRfp(rfpId: string): Promise<ApplyResult> {
  try {
    const lane = await v2<V2OwnProposal>({
      method: 'POST',
      path: `/rfps/${encodeURIComponent(rfpId)}:apply`,
    });
    return { ok: true, lane: toAppliedLane(lane) };
  } catch (err) {
    if (err instanceof V2Error) return { ok: false, message: err.message };
    throw err;
  }
}

/** The summary bid a self-serve applicant prices and sends (wire shape). */
export interface SummaryBidInput {
  total: V2Money;
  duration_wd: number;
  conditions?: string;
  validity_until?: string;
  document_ids?: string[];
}

export type SendBidResult =
  | { ok: true; lane: AppliedLane }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

/**
 * POST /proposals/{proposalId}:submit-bid → price and send (or revise) the
 * bidder's own summary bid. The authenticated twin of the public token submit;
 * the BE re-validates as the authority, so a refusal (bad figure, closed window,
 * a lane this org does not own) comes back as a message — and `validation_failed`
 * carries the per-field errors the editor paints beside the inputs.
 */
export async function sendBid(proposalId: string, bid: SummaryBidInput): Promise<SendBidResult> {
  try {
    const lane = await v2<V2OwnProposal>({
      method: 'POST',
      path: `/proposals/${encodeURIComponent(proposalId)}:submit-bid`,
      body: {
        total: bid.total,
        duration_wd: bid.duration_wd,
        ...(bid.conditions ? { conditions: bid.conditions } : {}),
        ...(bid.validity_until ? { validity_until: bid.validity_until } : {}),
        document_ids: bid.document_ids ?? [],
      },
    });
    return { ok: true, lane: toAppliedLane(lane) };
  } catch (err) {
    if (err instanceof V2Error) {
      return { ok: false, message: err.message, fieldErrors: err.errors ?? undefined };
    }
    throw err;
  }
}

/** The bid page's context: the RFP to price against + this org's lane on it. */
export interface BidContext {
  rfp: V2Rfp;
  lane: AppliedLane;
}

export type BidContextResult =
  | { ok: true; ctx: BidContext }
  | { ok: false; message: string };

/**
 * Everything the bid editor needs for one open RFP: the RFP (readable by any
 * bidder while it is open+published, D-15) and this org's own lane on it. The
 * apply is idempotent, so navigating to the bid page CLAIMS the lane if the org
 * had only browsed so far, or re-resolves the lane it already holds — either way
 * the editor opens on a real proposal id. A refused apply (window closed, the
 * issuer's own RFP) is surfaced, not swallowed.
 */
export async function loadBidContext(rfpId: string): Promise<BidContextResult> {
  const rfp = await getRfp(rfpId).catch(() => null);
  if (!rfp) return { ok: false, message: 'This request is no longer open to the marketplace.' };
  const applied = await applyToOpenRfp(rfpId);
  if (!applied.ok) return { ok: false, message: applied.message };
  return { ok: true, ctx: { rfp, lane: applied.lane } };
}
