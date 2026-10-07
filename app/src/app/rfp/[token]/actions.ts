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

import {
  completeProposalDocument,
  modelViewUrlByToken,
  reserveProposalDocument,
  submitBid,
  type ProposalUploadTicket,
} from '@/lib/v2/rfp-link';
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

// ── Portfolio-attachment upload steps (LINA-375) ─────────────────────────────
// Steps 1 and 3 of reserve → PUT → complete. The browser owns step 2 (the
// presigned PUT, via upload-client.ts): these JSON steps cross to the server so
// the anonymous v2 surface is dispatched in-process, never from the browser.

export type ReserveState =
  | { ticket: ProposalUploadTicket }
  | { error: string };

/** Step 1 — reserve one attachment; the widget then PUTs the bytes to the ticket. */
export async function reserveDocumentAction(
  token: string,
  file: { name: string; mime: string; sizeBytes: number; sha256: string },
): Promise<ReserveState> {
  const res = await reserveProposalDocument(token, file);
  return res.ok ? { ticket: res.ticket } : { error: res.message };
}

/** Step 3 — prove the bytes landed and mark the attachment `stored`. */
export async function completeDocumentAction(
  token: string,
  documentId: string,
): Promise<{ error?: string }> {
  const res = await completeProposalDocument(token, documentId);
  return res.ok ? {} : { error: res.message };
}

// ── BIM model view-url (LINA-409 / doc 24) ───────────────────────────────────
// Mint a fresh short-TTL presigned INLINE GET for the attached 3D model. Called
// lazily by the viewer island on "Load 3D model" — the token is the authority
// (re-supplied here, server-to-server), the URL is all that reaches the browser.
export async function resolveModelUrlAction(
  token: string,
  documentId: string,
): Promise<{ url: string } | { error: string }> {
  const res = await modelViewUrlByToken(token, documentId);
  return res.ok ? { url: res.url } : { error: res.message };
}

export async function submitBidAction(
  token: string,
  draft: BidDraft,
  documentIds: string[] = [],
): Promise<SubmitState> {
  const checked = validateBid(draft, new Date(), documentIds);
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
