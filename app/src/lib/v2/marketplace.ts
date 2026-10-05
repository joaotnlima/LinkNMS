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
import type { V2Me } from './profile-view';
import type { V2Rfp } from './tendering-view';

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

/** The lane an apply claimed — its id, and whether this call created it. */
export interface AppliedLane {
  proposal_id: string;
}

export type ApplyResult =
  | { ok: true; lane: AppliedLane }
  | { ok: false; message: string };

/**
 * POST /rfps/{rfpId}:apply → claim this org's own proposal lane on an open RFP
 * it discovered. Idempotent server-side (first call 201, a repeat 200), so a
 * double-click lands one lane, not two. A refusal (deadline passed, the issuer
 * cannot bid on its own RFP, the RFP is not actually open) comes back as a
 * message for the browser to show — never swallowed into a false success.
 */
export async function applyToOpenRfp(rfpId: string): Promise<ApplyResult> {
  try {
    const lane = await v2<{ id: string }>({
      method: 'POST',
      path: `/rfps/${encodeURIComponent(rfpId)}:apply`,
    });
    return { ok: true, lane: { proposal_id: lane.id } };
  } catch (err) {
    if (err instanceof V2Error) return { ok: false, message: err.message };
    throw err;
  }
}
