'use server';

// The one write the bid editor makes (LINA-406; at /requests/{rfpId} since
// PRD-04 X-11): price and send (or revise) this org's own summary bid. A server action, not a
// browser fetch — the v2 client is server-only (it dispatches the tendering
// module in-process), so the submit crosses to the server here.
//
// The SAME pure `validateBid` the editor runs for instant feedback runs again
// here before the call, so a draft that somehow reaches the action unvalidated is
// still refused with field errors; the BE then re-validates as the final
// authority. On success we revalidate the inbox so the lane's state is fresh
// on the next navigation.
import { revalidatePath } from 'next/cache';

import { sendBid } from '@/lib/v2/company-inbox';
import { validateBid, type BidDraft, type BidErrors } from '@/lib/v2/rfp-link-view';

export type BidActionState =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: BidErrors };

export async function bidAction(
  rfpId: string,
  proposalId: string,
  draft: BidDraft,
): Promise<BidActionState> {
  const checked = validateBid(draft, new Date());
  if (!checked.ok) {
    return { ok: false, error: 'Some answers need a look before this can be sent.', fieldErrors: checked.errors };
  }
  const res = await sendBid(proposalId, checked.body);
  if (!res.ok) {
    return { ok: false, error: res.message, fieldErrors: res.fieldErrors as BidErrors | undefined };
  }
  revalidatePath('/requests');
  revalidatePath(`/requests/${rfpId}`);
  return { ok: true };
}
