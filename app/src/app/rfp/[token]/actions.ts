'use server';

// The one write the public RFP form makes (LINA-360, S5). A server action, not a
// browser fetch: the v2 client is server-only (it dispatches the tendering
// module in-process), so the submit crosses to the server here. The token is an
// argument, not a hidden field — it is already in the URL, and an action arg
// travels server-to-server, never widening where the credential is exposed.
//
// The action RE-VALIDATES with the same pure `validateBid` the client runs for
// instant feedback: the client check is a courtesy, this one is the authority,
// exactly as every other write in this app re-derives its guards server-side.
import { redirect } from 'next/navigation';

import { submitBid } from '@/lib/v2/rfp-link';
import {
  submittedPath,
  validateBid,
  type BidDraft,
  type BidErrors,
} from '@/lib/v2/rfp-link-view';

export interface SubmitState {
  /** A whole-form banner: a validation summary, or the backend's refusal. */
  error?: string;
  /** Field-keyed notes when the draft failed validation. */
  fieldErrors?: BidErrors;
}

export async function submitBidAction(token: string, draft: BidDraft): Promise<SubmitState> {
  const checked = validateBid(draft, new Date());
  if (!checked.ok) {
    return {
      error: 'Some answers need a look before this can be sent.',
      fieldErrors: checked.errors,
    };
  }

  const result = await submitBid(token, checked.body);
  if (!result.ok) return { error: result.message };

  // The confirmation reads the record back (the GET now echoes the proposal), so
  // a reload or a forwarded link still shows the truth — the read-back IS the
  // record, not a souvenir of this submission. `redirect` throws, so nothing
  // after it runs.
  redirect(submittedPath(token));
}
