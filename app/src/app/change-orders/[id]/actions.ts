'use server';

// The change-order decision verbs as server actions on `/api/v2` (LINA-321, S4).
// The client decide buttons call these — they never fetch a route directly — so
// the whole write goes through the server-only v2 client (`lib/v2/change-orders`)
// and the browser holds no API surface. Each verb catches `V2Error` and returns a
// SENTENCE, not a status code: the handler is the authority on the two-sided rule
// (a proposer's org gets 403 `two_sided_rule`), and this surfaces that cleanly so
// a race — the button was shown, then the CO changed under it — reads as an
// explanation, not a stack trace.
import { revalidatePath } from 'next/cache';

import { V2Error } from '@/lib/v2/client';
import {
  approveChangeOrder,
  rejectChangeOrder,
  withdrawChangeOrder,
} from '@/lib/v2/change-orders';
import { TWO_SIDED_MESSAGE } from '@/lib/v2/change-orders-view';

export type DecideResult = { ok: true } | { ok: false; message: string };

const verbs = {
  approve: approveChangeOrder,
  reject: rejectChangeOrder,
  withdraw: withdrawChangeOrder,
} as const;

export type DecideAction = keyof typeof verbs;

/** Map a v2 problem code to human copy — nothing about a decision is left blurry
 *  (the ledger either moved or it did not). */
function messageFor(err: V2Error): string {
  switch (err.code) {
    case 'two_sided_rule':
      return TWO_SIDED_MESSAGE;
    case 'invalid_transition':
      return 'This change order is no longer awaiting that action. Nothing has changed.';
    case 'forbidden':
      return 'You are not permitted to act on this change order. Nothing has changed.';
    default:
      return err.message || 'The decision was not recorded. Nothing has changed.';
  }
}

export async function decideChangeOrderV2(
  id: string,
  action: DecideAction,
  note?: string,
): Promise<DecideResult> {
  try {
    await verbs[action](id, note?.trim() || undefined);
  } catch (err) {
    if (err instanceof V2Error) return { ok: false, message: messageFor(err) };
    throw err;
  }
  revalidatePath(`/change-orders/${id}`);
  return { ok: true };
}
