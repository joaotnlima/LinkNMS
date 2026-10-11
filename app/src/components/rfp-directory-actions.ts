'use server';

// Server actions for PRD-04 — the RFP and the directory, issuer side (D-47).
// The client components (Bidders step suggestions, the listing toggle, the
// "Asking to bid" section, "Ask for a proposal" on a profile) cannot reach the
// server-only v2 client; they invoke these, which call `lib/v2/rfp-directory.ts`
// / `lib/v2/tendering.ts`, which call the ONE shared `v2()` seam. Refusals come
// back as data (`Result`), never as a throw across the boundary.

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { V2Error } from '@/lib/v2/client';
import type { V2DirectoryCard } from '@/lib/v2/directory-view';
import { listPortfolio } from '@/lib/v2/profile';
import {
  addCompanies, approveBidRequest, declineBidRequest, listBidRequests, suggestCompanies, tasksForAsk,
} from '@/lib/v2/rfp-directory';
import {
  defaultBidsDue, safeReturnTo, tenderPanelHref, type AskTask, type V2BidRequest,
} from '@/lib/v2/rfp-directory-view';
import { createRfp, getRfp, updateRfp } from '@/lib/v2/tendering';
import type { V2Recipient, V2Rfp } from '@/lib/v2/tendering-view';

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

async function guard<T>(fallback: string, call: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await call() };
  } catch (err) {
    if (err instanceof V2Error) return { ok: false, code: err.code, message: err.detail || err.message };
    return { ok: false, code: 'internal', message: fallback };
  }
}

// ── Bidders step (X-1, X-3) ──────────────────────────────────────────────────

export async function loadSuggestionsAction(projectId: string, specialtyCode: string): Promise<V2DirectoryCard[]> {
  if (!specialtyCode) return [];
  return suggestCompanies(projectId, specialtyCode);
}

export async function addCompanyAction(rfpId: string, companyId: string): Promise<Result<V2Recipient[]>> {
  return guard('That company could not be added. Try again.', () => addCompanies(rfpId, [companyId]));
}

/** "Also list it as an open request" — a draft-only edit under If-Match. */
export async function setListedAction(rfpId: string, listed: boolean, version: number): Promise<Result<V2Rfp>> {
  return guard('The listing did not save. Try again.', () => updateRfp(rfpId, { listed }, version));
}

// ── Out for bids: asking to bid (X-5) ────────────────────────────────────────

export async function loadBidRequestsAction(rfpId: string): Promise<V2BidRequest[]> {
  return listBidRequests(rfpId);
}

export async function approveBidRequestAction(id: string): Promise<Result<V2BidRequest>> {
  return guard('The approval did not go through. Try again.', () => approveBidRequest(id));
}

export async function declineBidRequestAction(id: string): Promise<Result<V2BidRequest>> {
  return guard('The decline did not go through. Try again.', () => declineBidRequest(id));
}

// ── /companies opened from a task: "＋ Add to the request" (X-1) ──────────────

export async function addCompanyFromSearchAction(form: FormData): Promise<void> {
  const rfpId = String(form.get('rfp_id') ?? '');
  const companyId = String(form.get('company_id') ?? '');
  const back = safeReturnTo(String(form.get('return_to') ?? ''));
  const res = await guard('That company could not be added.', () => addCompanies(rfpId, [companyId]));
  if (back) {
    revalidatePath(back.split('?')[0]);
    const sep = back.includes('?') ? '&' : '?';
    redirect(res.ok ? back : `${back}${sep}error=${encodeURIComponent(res.message)}`);
  }
  if (!res.ok) throw new Error(res.message);
}

// ── Ask for a proposal, from a profile (X-6, X-7) ────────────────────────────

export async function loadAskBuildsAction(): Promise<{ id: string; name: string }[]> {
  return (await listPortfolio()).map((p) => ({ id: p.id, name: p.name }));
}

export async function loadAskTasksAction(projectId: string, companyId: string): Promise<AskTask[]> {
  return tasksForAsk(projectId, companyId);
}

/**
 * Add the company to the task's draft, or create a draft prefilled from the
 * task and add it there. Nothing is sent (X-7): only a DRAFT is ever touched —
 * a tender already out for bids is refused here, as the dialog says.
 */
export async function askForProposalAction(input: {
  projectId: string; task: AskTask; companyId: string;
}): Promise<Result<{ rfpId: string; href: string; created: boolean }>> {
  // The server's answer for this task (listAskCandidates); the draft is re-read below.
  const target = input.task.target;
  if (target.kind === 'locked') return { ok: false, code: 'invalid_transition', message: target.reason };
  return guard('The company could not be added to a draft. Try again.', async () => {
    let rfpId: string;
    let created = false;
    if (target.kind === 'draft') {
      const rfp = await getRfp(target.rfp_id);
      if (!rfp || rfp.status !== 'draft') {
        const why = 'That tender is no longer a draft — add bidders from the task panel.';
        throw new V2Error(409, 'invalid_transition', why, why);
      }
      rfpId = rfp.id;
    } else {
      const rfp = await createRfp(input.projectId, {
        title: input.task.name, scopeText: '', rootTaskIds: [input.task.task_id],
        submissionDeadline: defaultBidsDue(), listed: false,
      });
      rfpId = rfp.id;
      created = true;
    }
    await addCompanies(rfpId, [input.companyId]);
    revalidatePath(`/projects/${input.projectId}/plan`);
    return { rfpId, href: tenderPanelHref(input.projectId, input.task.task_id), created };
  });
}
