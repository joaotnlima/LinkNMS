// The tender flow's data layer (PRD-02): the reads and writes the panel and the
// workspace need beyond `tendering.ts`. ONLY I/O and fail-closed handling; the
// wire→view phrasing lives in `tender-flow-view.ts`. Every call goes through the
// one shared v2 seam (LINA-309).
//
//   getTenderWindow     — planning's view of tendering some rows (coverage,
//                         window, critical path, award-by). Planning computes it;
//                         the app never touches a calendar.
//   getTenderFollow     — one tender's recipients + its OWN lanes (+ the money
//                         gate), the read behind follow / compare.
//   removeRecipient     — take a queued bidder off a draft (T-6).
//   reissueRecipientLink— mint a fresh personal link and return it once (T-11).
import 'server-only';

import { v2, V2Error } from './client';
import { getInbox, listRecipients } from './tendering';
import type { V2Recipient, V2Rfp } from './tendering-view';
import type { V2TenderWindow } from './tender-flow-view';
import type { Inbox } from './tendering';

/**
 * GET /projects/{projectId}/schedule/tender-window. Null on any refusal — the
 * composer then simply says nothing about dates rather than guessing them.
 */
export async function getTenderWindow(
  projectId: string,
  taskIds: readonly string[],
  opts: { include?: readonly string[]; bidsDue?: string | null } = {},
): Promise<V2TenderWindow | null> {
  if (taskIds.length === 0) return null;
  try {
    return await v2<V2TenderWindow>({
      method: 'GET',
      path: `/projects/${encodeURIComponent(projectId)}/schedule/tender-window`,
      query: {
        task_ids: taskIds.join(','),
        ...(opts.include?.length ? { include: opts.include.join(',') } : {}),
        ...(opts.bidsDue ? { bids_due: opts.bidsDue.slice(0, 10) } : {}),
      },
    });
  } catch (err) {
    if (err instanceof V2Error) return null;
    throw err;
  }
}

export interface TenderFollow extends Inbox {
  recipients: V2Recipient[];
}

/** One tender's bidders and lanes. Lanes of OTHER tenders on the same rows are dropped. */
export async function getTenderFollow(rfp: Pick<V2Rfp, 'id' | 'root_task_ids'>): Promise<TenderFollow> {
  const [recipients, inbox] = await Promise.all([listRecipients(rfp.id), getInbox(rfp)]);
  return { ...inbox, recipients };
}

/** DELETE /rfps/{rfpId}/recipients/{recipientId} — draft only. */
export async function removeRecipient(rfpId: string, recipientId: string): Promise<void> {
  await v2<unknown>({
    method: 'DELETE',
    path: `/rfps/${encodeURIComponent(rfpId)}/recipients/${encodeURIComponent(recipientId)}`,
  });
}

/**
 * POST /rfps/{rfpId}/recipients/{recipientId}:reissue — a fresh link (the old
 * one stops working) and the invite re-sent; the raw token comes back ONCE.
 */
export async function reissueRecipientLink(rfpId: string, recipientId: string): Promise<V2Recipient> {
  return v2<V2Recipient>({
    method: 'POST',
    path: `/rfps/${encodeURIComponent(rfpId)}/recipients/${encodeURIComponent(recipientId)}:reissue`,
  });
}
