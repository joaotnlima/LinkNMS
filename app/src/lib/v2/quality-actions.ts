'use server';

// The session-bound doors the quality page's client components reach the
// server-only data layer (`./quality.ts`) through (PRD-12 N-3, N-4). Every
// answer is a serializable `{ ok, … }`; a refusal carries the server's code
// and sentence (e.g. "only the raising organisation closes its
// non-conformity"). The server decides every transition.
import { revalidatePath } from 'next/cache';

import { V2Error } from './client';
import {
  decideVerificationV2, moveNonConformityV2, raiseNonConformityV2, recordInspectionV2,
} from './quality';
import type { NcAction } from './quality-view';

export type QualityResult = { ok: true } | { ok: false; code: string; message: string };

async function run(projectId: string, fn: () => Promise<unknown>): Promise<QualityResult> {
  try {
    await fn();
    revalidatePath(`/projects/${projectId}/quality`);
    return { ok: true };
  } catch (err) {
    if (err instanceof V2Error) {
      const field = err.errors ? Object.values(err.errors)[0] : null;
      return { ok: false, code: err.code, message: field ?? err.detail ?? err.message };
    }
    return { ok: false, code: 'internal', message: 'Something went wrong. Try again.' };
  }
}

export async function raiseNcAction(projectId: string, body: Record<string, unknown>): Promise<QualityResult> {
  return run(projectId, () => raiseNonConformityV2(projectId, body));
}

export async function moveNcAction(
  projectId: string, ncId: string, action: NcAction, input: { note?: string; assignedToOrgId?: string },
): Promise<QualityResult> {
  const body = {
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    ...(action === 'assign' && input.assignedToOrgId ? { assigned_to_org_id: input.assignedToOrgId } : {}),
  };
  return run(projectId, () => moveNonConformityV2(ncId, action, body));
}

export async function recordInspectionAction(projectId: string, body: Record<string, unknown>): Promise<QualityResult> {
  return run(projectId, () => recordInspectionV2(projectId, body));
}

export async function decideVerificationAction(
  projectId: string, verificationId: string, accept: boolean, note: string,
): Promise<QualityResult> {
  return run(projectId, () => decideVerificationV2(verificationId, accept, accept ? null : note.trim()));
}
