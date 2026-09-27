// The change-order surface's data layer on `/api/v2` (LINA-321, S4 of the UI
// cutover, doc 22 §3). This is the v2 twin of the CO reads/writes that live in
// `lib/api.ts` (`getChangeOrder`, `proposeChangeOrder`, `decideChangeOrder`). It
// talks to the pivot API through the shared client (`./client.ts`, LINA-309) and
// nowhere else — there is no second transport minted here.
//
// ── WHAT CARRIES OVER, AND WHAT DOES NOT (see ./change-orders-view.ts header) ─
// v2 change orders are CONTRACT-scoped, not project-scoped, and the decision flow
// is a two-step lifecycle (draft → :submit → :approve/:reject, or :withdraw by the
// proposer) rather than v1's single "proposed → decided" step. Money is never
// posted from the UI: `amount_delta` is derived server-side from BoQ line ops
// against a signed contract. So this module exposes the reads + the decision
// verbs that v2 states authoritatively; it deliberately does NOT expose a v1-style
// free-cost "propose" (that needs a contract + BoQ context surface, S2) and there
// is no list read to mirror `getChangeOrders(projectId)` — the Contracting module
// exposes no change-order collection endpoint yet (tracked as a BE follow-up).
//
// Every read is org-scoped and members-only; a viewer with no active org or no
// mirror row is a first-class empty/again-403 state, never a crash — the surface
// handles `null`/`V2Error` the way S1's `profile.ts` does.
import 'server-only';

import { v2, V2Error } from './client';
import {
  toChangeOrderView,
  decideBlock,
  type V2ChangeOrder,
  type ChangeOrderV2View,
  type DecideBlock,
} from './change-orders-view';
import type { V2Me } from './profile-view';

/** A CO detail plus the viewer's decision eligibility, resolved together. */
export interface ChangeOrderDetailV2 {
  co: ChangeOrderV2View;
  decide: DecideBlock;
}

/**
 * GET /api/v2/change-orders/{id} → the CO for a contract party, paired with the
 * decide gate computed against the viewer's active org. Returns null on a
 * V2Error (not found / not a party / not signed in): the detail page renders
 * `notFound()` rather than leaking which change orders exist.
 */
export async function getChangeOrderDetail(id: string): Promise<ChangeOrderDetailV2 | null> {
  let me: V2Me | null = null;
  try {
    me = await v2<V2Me>({ method: 'GET', path: '/me' });
  } catch (err) {
    if (!(err instanceof V2Error)) throw err; // not mirrored / no org → me stays null, gate falls closed
  }
  try {
    const co = await v2<V2ChangeOrder>({ method: 'GET', path: `/change-orders/${encodeURIComponent(id)}` });
    return { co: toChangeOrderView(co), decide: decideBlock(co, me) };
  } catch (err) {
    if (err instanceof V2Error) return null; // fail-closed: not a party / absent → notFound, never a leak
    throw err;
  }
}

// ── Decision verbs (colon-actions; the handler enforces two_sided_rule) ──────
// These are thin passes to the v2 handler. The handler is the authority on the
// two-sided rule (a proposer's org gets a 403 `two_sided_rule`); the UI gate in
// `decideBlock` only mirrors it so the button is never shown, it does not replace
// it. Callers surface `V2Error.code` ('two_sided_rule' | 'forbidden' |
// 'invalid_transition') to the user rather than a bare status.

async function act(id: string, action: 'submit' | 'approve' | 'reject' | 'withdraw', note?: string, idempotencyKey?: string): Promise<ChangeOrderV2View> {
  const co = await v2<V2ChangeOrder>({
    method: 'POST',
    path: `/change-orders/${encodeURIComponent(id)}:${action}`,
    body: note ? { note } : undefined,
    idempotencyKey,
  });
  return toChangeOrderView(co);
}

export const submitChangeOrder = (id: string, note?: string, idempotencyKey?: string) =>
  act(id, 'submit', note, idempotencyKey);

export const approveChangeOrder = (id: string, note?: string, idempotencyKey?: string) =>
  act(id, 'approve', note, idempotencyKey);

export const rejectChangeOrder = (id: string, note?: string, idempotencyKey?: string) =>
  act(id, 'reject', note, idempotencyKey);

export const withdrawChangeOrder = (id: string, note?: string, idempotencyKey?: string) =>
  act(id, 'withdraw', note, idempotencyKey);
