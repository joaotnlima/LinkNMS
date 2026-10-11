// PRD-04 issuer-side data layer on `/api/v2`: suggested companies for a task
// (the directory search on the task's specialty near its build), adding
// directory companies to an RFP, the requests to bid on a listed RFP and the
// issuer's decision, and the reads behind "Ask for a proposal" on a profile.
// I/O only — the wording and ordering are `./rfp-directory-view.ts`.
//
// Reads fail closed to their empty shape (a viewer who may not see them gets
// nothing, never a leak); writes rethrow the V2Error so the action can show
// the server's reason.
import 'server-only';

import { allPages } from './pages';
import { v2, V2Error } from './client';
import { searchCompanies } from './directory';
import type { V2DirectoryCard } from './directory-view';
import type { AskTask, V2BidRequest } from './rfp-directory-view';
import type { V2Recipient } from './tendering-view';

async function orEmpty<T>(p: Promise<T>, empty: T): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof V2Error) return empty;
    throw err;
  }
}

/**
 * X-1: companies matched on the task's specialty and the build's location —
 * the directory's own search and ranking (D-46), first page only.
 */
export async function suggestCompanies(projectId: string, specialtyCode: string, limit = 5): Promise<V2DirectoryCard[]> {
  const res = await orEmpty(
    searchCompanies({ specialty: specialtyCode, near_project: projectId, radius_km: '50' }, limit),
    null,
  );
  return res?.items ?? [];
}

/** POST /rfps/{id}/recipients with directory companies (source `directory`). */
export async function addCompanies(rfpId: string, companyIds: string[]): Promise<V2Recipient[]> {
  const res = await v2<{ items?: V2Recipient[] }>({
    method: 'POST',
    path: `/rfps/${encodeURIComponent(rfpId)}/recipients`,
    body: { recipients: companyIds.map((company_id) => ({ company_id })) },
  });
  return res.items ?? [];
}

/** GET /rfps/{id}/bid-requests — the issuer's "Asking to bid" (X-5). */
export async function listBidRequests(rfpId: string): Promise<V2BidRequest[]> {
  return orEmpty(allPages<V2BidRequest>({ path: `/rfps/${encodeURIComponent(rfpId)}/bid-requests` }), []);
}

export function approveBidRequest(id: string): Promise<V2BidRequest> {
  return v2<V2BidRequest>({ method: 'POST', path: `/bid-requests/${encodeURIComponent(id)}:approve`, idempotencyKey: `approve-${id}` });
}

export function declineBidRequest(id: string): Promise<V2BidRequest> {
  return v2<V2BidRequest>({ method: 'POST', path: `/bid-requests/${encodeURIComponent(id)}:decline` });
}

/**
 * X-6: a build's tasks as "Ask for a proposal" offers them to one company —
 * ONE server read (listAskCandidates): ranked on the company's specialties,
 * each with the RFP that governs it and where the company would land.
 */
export async function tasksForAsk(projectId: string, companyId: string): Promise<AskTask[]> {
  const res = await orEmpty(
    v2<{ items?: AskTask[] }>({
      method: 'GET', path: `/projects/${encodeURIComponent(projectId)}/ask-candidates`, query: { company_id: companyId },
    }),
    { items: [] },
  );
  return res.items ?? [];
}
