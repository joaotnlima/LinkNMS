// The quality page's data layer on `/api/v2` (PRD-12 N-3, N-4). I/O only; the
// naming lives in `./quality-view.ts`. Reads fail closed (an empty list): a
// viewer without the verify permission simply has no verification queue.
// Writes rethrow so the action can say why.
import 'server-only';

import { v2, V2Error } from './client';
import type { V2Inspection, V2NonConformity, V2Verification } from './quality-view';

const enc = encodeURIComponent;

async function itemsOrEmpty<T>(p: Promise<{ items: T[] }>): Promise<T[]> {
  try {
    return (await p).items ?? [];
  } catch (err) {
    if (err instanceof V2Error) return [];
    throw err;
  }
}

export function listNonConformitiesV2(projectId: string, status = 'active'): Promise<V2NonConformity[]> {
  return itemsOrEmpty(v2<{ items: V2NonConformity[] }>({
    method: 'GET', path: `/projects/${enc(projectId)}/nonconformities`, query: { status, limit: 200 },
  }));
}

export function listInspectionsV2(projectId: string): Promise<V2Inspection[]> {
  return itemsOrEmpty(v2<{ items: V2Inspection[] }>({
    method: 'GET', path: `/projects/${enc(projectId)}/inspections`, query: { limit: 100 },
  }));
}

/** The verification queue of my organisation on this build (pending by default). */
export function listMyVerificationsV2(projectId: string): Promise<V2Verification[]> {
  return itemsOrEmpty(v2<{ items: V2Verification[] }>({
    method: 'GET', path: '/me/verifications', query: { project: projectId, limit: 100 },
  }));
}

export function raiseNonConformityV2(projectId: string, body: Record<string, unknown>): Promise<V2NonConformity> {
  return v2<V2NonConformity>({ method: 'POST', path: `/projects/${enc(projectId)}/nonconformities`, body });
}

const NC_COMMAND = { assign: 'assign', fix: 'fix', close: 'close', reject_fix: 'reject-fix' } as const;

export function moveNonConformityV2(
  ncId: string, action: keyof typeof NC_COMMAND, body: { note?: string; assigned_to_org_id?: string },
): Promise<V2NonConformity> {
  return v2<V2NonConformity>({ method: 'POST', path: `/nonconformities/${enc(ncId)}:${NC_COMMAND[action]}`, body });
}

export function recordInspectionV2(projectId: string, body: Record<string, unknown>): Promise<V2Inspection> {
  return v2<V2Inspection>({ method: 'POST', path: `/projects/${enc(projectId)}/inspections`, body });
}

export function decideVerificationV2(id: string, accept: boolean, note: string | null): Promise<V2Verification> {
  return v2<V2Verification>({
    method: 'POST', path: `/verifications/${enc(id)}:${accept ? 'accept' : 'reject'}`, body: accept ? {} : { note },
  });
}
