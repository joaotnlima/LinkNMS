// POST /api/v1/projects/:id/procurement/proposals/:proposalId:select — choose
// the constructor (LINA-280; slice-procurement-contract §1 route 7). Returns the
// full `ProcurementView` (§2): execution activates, procurement closes, every
// outstanding RFP token dies via the dynamic join (ADR-0023 §5, Option A).
//
// ONE ROUTE FILE, ONE ACTION — the same split seam as `plan-versions/[versionAction]`:
// a Next dynamic segment must be the whole segment, so `[proposalId]:select` is
// not a thing that can exist. `[proposalRef]` captures the whole `{id}:select`
// segment and the LAST colon (a UUID contains none) splits it here.
//
// The split is also the validation seam: `proposalId` is a UUID path param the
// gateway's params allowlist does not know about (its allowlist is deliberate —
// a param opts in), so the shape check happens here, before the id becomes a
// Postgres parameter (the LINA-79 finding).
//
// Nothing about WHO may select is decided here: the phase service authorises the
// session against ACTION.SELECT_CONSTRUCTOR. This file only names the handler.
import { handle, container } from '@/server/gateway';
import { isUuid } from '@services/gateway/params.mjs';

export const dynamic = 'force-dynamic';

const ACTIONS = { select: 'selectProposal' } as const;

type Action = keyof typeof ACTIONS;

export function POST(req: Request, ctx: { params: Promise<{ id: string; proposalRef: string }> }) {
  return handle(req, ctx, async (c) => {
    const raw = c.params.proposalRef ?? '';
    const cut = raw.lastIndexOf(':');
    const proposalId = cut === -1 ? raw : raw.slice(0, cut);
    const action = (cut === -1 ? '' : raw.slice(cut + 1)) as Action;

    if (!isUuid(proposalId)) {
      return { status: 400, body: { error: { code: 'bad_request', message: 'proposalId must be a UUID' } } };
    }
    if (!(action in ACTIONS)) {
      // 404, not 400: the URL names no route. The single `:select` verb is
      // already documented in the slice contract.
      return { status: 404, body: { error: { code: 'not_found', message: 'no such proposal action' } } };
    }

    const handler = container().http.schedule[ACTIONS[action]];
    return handler({ ...c, params: { ...c.params, proposalId } });
  });
}