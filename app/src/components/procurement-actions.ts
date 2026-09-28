'use server';

// The server-action bridge between the (client) procurement surface and the v2
// tendering data layer (LINA-361, S5). The composer/inbox is a client component;
// `lib/v2/client.ts` is `server-only`, so every v2 read and write it needs is
// funnelled through these actions — which call `lib/v2/tendering.ts`, which calls
// the ONE shared `v2()` seam. No second client is minted (LINA-309): the browser
// never talks to `/api/v2` directly, it invokes these actions and the actions
// dispatch in-process with the viewer resolved from the session, exactly as
// `app/actions.ts` bridges the invite/build writes.
//
// Every action returns a discriminated `Result` rather than throwing across the
// server/client boundary: a refusal is data the surface renders (a field error
// under the composer, a reason beside a greyed Award), never an unhandled
// rejection. Reads fail CLOSED to their empty shape (the data layer already does
// this); writes surface their `V2Error` code + message + field errors.

import { revalidatePath } from 'next/cache';

import { V2Error } from '@/lib/v2/client';
import {
  getMyRfps, getRfp, listRecipients, getInbox,
  createRfp, updateRfp, addRecipients, publishRfp, closeRfp, cancelRfp,
  shortlistProposal, awardRfp, recordOfflineProposal,
  reserveProposalDocument, completeProposalDocument,
  type Inbox, type RfpPatch, type OfflineProposalInput, type ProposalUploadTicket,
} from '@/lib/v2/tendering';
import type { V2Rfp, V2Recipient, RfpDraftInput } from '@/lib/v2/tendering-view';

// ── Result ───────────────────────────────────────────────────────────────────

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; fieldErrors?: Record<string, string> };

/** Wrap a write so its `V2Error` becomes a rendered refusal, never a throw. */
async function guard<T>(fallback: string, call: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await call() };
  } catch (err) {
    if (err instanceof V2Error) {
      return { ok: false, code: err.code, message: err.detail || err.message, fieldErrors: err.errors ?? undefined };
    }
    return { ok: false, code: 'internal', message: fallback };
  }
}

// ── Reads (fail-closed in the data layer; exposed for the client to refresh) ──

export async function loadMyRfpsAction(): Promise<V2Rfp[]> {
  return getMyRfps();
}

export interface ComposerData {
  rfp: V2Rfp;
  recipients: V2Recipient[];
}

/** The composer's read: an RFP plus its recipient list, or null when unseeable. */
export async function loadComposerAction(rfpId: string): Promise<ComposerData | null> {
  const rfp = await getRfp(rfpId);
  if (!rfp) return null;
  return { rfp, recipients: await listRecipients(rfpId) };
}

export async function loadInboxAction(rfp: Pick<V2Rfp, 'id' | 'root_task_ids'>): Promise<Inbox> {
  return getInbox(rfp);
}

// ── Composer writes ───────────────────────────────────────────────────────────

export async function createRfpAction(projectId: string, draft: RfpDraftInput): Promise<Result<V2Rfp>> {
  const res = await guard('That RFP did not save. Try again.', () => createRfp(projectId, draft));
  if (res.ok) revalidatePath(`/projects/${projectId}/plan`);
  return res;
}

export async function updateRfpAction(rfpId: string, patch: RfpPatch, version: number): Promise<Result<V2Rfp>> {
  return guard('That change did not save. Try again.', () => updateRfp(rfpId, patch, version));
}

export async function addRecipientsAction(rfpId: string, emails: string[]): Promise<Result<V2Recipient[]>> {
  return guard('Those addresses did not save. Try again.', () => addRecipients(rfpId, emails));
}

export async function publishRfpAction(rfpId: string): Promise<Result<V2Rfp>> {
  return guard('The RFP did not go out. Try again.', () => publishRfp(rfpId));
}

export async function closeRfpAction(rfpId: string): Promise<Result<V2Rfp>> {
  return guard('The RFP did not close. Try again.', () => closeRfp(rfpId));
}

export async function cancelRfpAction(rfpId: string): Promise<Result<V2Rfp>> {
  return guard('The RFP did not cancel. Try again.', () => cancelRfp(rfpId));
}

// ── Inbox / evaluation writes ──────────────────────────────────────────────────

export async function shortlistAction(proposalId: string): Promise<Result<null>> {
  return guard('That did not shortlist. Try again.', async () => { await shortlistProposal(proposalId); return null; });
}

export async function awardAction(rfpId: string, proposalId: string): Promise<Result<V2Rfp>> {
  return guard('That award did not go through. Try again.', () => awardRfp(rfpId, proposalId));
}

export async function recordOfflineAction(proposalId: string, offline: OfflineProposalInput): Promise<Result<null>> {
  return guard('That offline bid did not record. Try again.', async () => { await recordOfflineProposal(proposalId, offline); return null; });
}

// ── Recorded-offline document uploads (reserve/complete; the PUT is browser-side) ─

export async function reserveProposalDocumentAction(
  proposalId: string,
  file: { name: string; mime: string; sizeBytes: number; sha256: string },
): Promise<Result<ProposalUploadTicket>> {
  return guard('Could not start that upload. Try again.', () => reserveProposalDocument(proposalId, file));
}

export async function completeProposalDocumentAction(versionRef: string): Promise<Result<null>> {
  return guard('That file did not finish uploading. Try again.', async () => {
    await completeProposalDocument(versionRef);
    return null;
  });
}
