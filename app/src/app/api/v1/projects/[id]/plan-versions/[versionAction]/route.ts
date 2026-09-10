// The four Slice B2 plan-version transitions (LINA-212; contract §5 routes 2–5):
//
//   POST /api/v1/projects/:id/plan-versions/:versionId:withdraw
//   POST /api/v1/projects/:id/plan-versions/:versionId:accept
//   POST /api/v1/projects/:id/plan-versions/:versionId:reject
//   POST /api/v1/projects/:id/plan-versions/:versionId:request-changes
//
// ONE ROUTE FILE, FOUR ACTIONS. The contract's URL puts the action AFTER the
// version id in the same path segment (`{versionId}:accept`), the same
// colon-action style as B1's `plan-imports:confirm`. A Next dynamic segment must
// be the whole segment, so `[versionId]:accept` is not a thing that can exist —
// the segment is captured whole and split here. The alternative was to move the
// action into its own segment (`/plan-versions/:id/accept`) and deviate from a
// contract that is frozen and that the BE already serves; a five-line split is
// the cheaper of the two.
//
// The split is also the validation seam: `versionId` is a UUID path param that
// services/gateway/params.mjs does not know about (its allowlist is deliberate —
// a param opts in), so the shape check happens here, before the id becomes a
// Postgres parameter and a malformed one becomes a 500 for what is a client
// mistake (the LINA-79 finding).
//
// Nothing about WHO may run these is decided here: the schedule service resolves
// proposer-vs-reviewer from the version row and authorises against the session
// (contract §6, ADR-0004). This file only names the handler.
import { handle, container } from '@/server/gateway';
import { isUuid } from '@services/gateway/params.mjs';

export const dynamic = 'force-dynamic';

const ACTIONS = {
  withdraw: 'withdrawPlan',
  accept: 'acceptPlan',
  reject: 'rejectPlan',
  'request-changes': 'requestChangesPlan',
  propose: 'proposePlan',
} as const;

type Action = keyof typeof ACTIONS;

export function POST(req: Request, ctx: { params: Promise<{ id: string; versionAction: string }> }) {
  return handle(req, ctx, async (c) => {
    // The LAST colon separates the id from the action: a UUID contains none, so
    // this is unambiguous, and `request-changes` keeps its hyphen.
    const raw = c.params.versionAction ?? '';
    const cut = raw.lastIndexOf(':');
    const versionId = cut === -1 ? raw : raw.slice(0, cut);
    const action = (cut === -1 ? '' : raw.slice(cut + 1)) as Action;

    if (!isUuid(versionId)) {
      return { status: 400, body: { error: { code: 'bad_request', message: 'versionId must be a UUID' } } };
    }
    if (!(action in ACTIONS)) {
      // 404, not 400: the URL names no route. Listing the four verbs would be a
      // discovery surface for something the contract already documents.
      return { status: 404, body: { error: { code: 'not_found', message: 'no such plan-version action' } } };
    }

    const handler = container().http.schedule[ACTIONS[action]];
    return handler({ ...c, params: { ...c.params, versionId } });
  });
}
