'use server';

// PRD-13 server actions — the plan's doors to the variation and slip
// endpoints (contract: listVariations, acknowledgeVariation(s),
// questionVariation, previewMove, updateTask with `reason`, reportProgress).
// Session-bound like `plan-write.ts`: the acting org/person come from the
// session in-process, never from the browser. A `V2Error` is a NORMAL outcome
// here (a refusal, a stale row): it returns `{ ok: false }` so the panel says it
// in words; anything else rethrows to the error boundary.
//
// Everything the panel shows comes back from the server already computed
// (`./slip-view.ts` only words it): which changes exist and whether this viewer
// saw / may acknowledge them, what a new finish would push, and who is told.
import { randomUUID } from 'node:crypto';

import { v2, V2Error } from './client';
import { liveChanges, toMoveImpact, type ChangeItem, type MoveImpact, type V2MovePreview, type V2Variation } from './slip-view';

export type ActionResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string; errors?: Record<string, string> };

async function attempt<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof V2Error) {
      return { ok: false, code: err.code, message: err.message, ...(err.errors ? { errors: err.errors } : {}) };
    }
    throw err;
  }
}

/** S-13 / S-15: live changes of the project, or of one task when `taskId` is given. */
export async function listChangesV2(projectId: string, taskId?: string): Promise<ActionResult<ChangeItem[]>> {
  return attempt(async () => {
    const body = await v2<{ items: V2Variation[] }>({
      method: 'GET',
      path: `/projects/${projectId}/variations`,
      query: taskId ? { task: taskId } : undefined,
    });
    return liveChanges(body.items ?? []);
  });
}

/** S-14: "I saw it" — who and when are recorded server-side. */
export async function acknowledgeChangeV2(variationId: string): Promise<ActionResult<true>> {
  return attempt(async () => {
    await v2({ method: 'POST', path: `/variations/${variationId}:acknowledge`, idempotencyKey: randomUUID() });
    return true as const;
  });
}

/** S-15: "Acknowledge all in view" — one command, all or nothing. */
export async function acknowledgeChangesV2(projectId: string, variationIds: string[]): Promise<ActionResult<number>> {
  return attempt(async () => {
    const body = await v2<{ items: unknown[] }>({
      method: 'POST',
      path: `/projects/${projectId}/variations:acknowledge`,
      body: { variation_ids: variationIds },
      idempotencyKey: randomUUID(),
    });
    return body.items?.length ?? 0;
  });
}

/** S-14: "Ask a question" — opens a question on the change, to the responsible party. */
export async function askAboutChangeV2(
  variationId: string,
  text: string,
  addresseeOrgId: string | null,
): Promise<ActionResult<true>> {
  return attempt(async () => {
    await v2({
      method: 'POST',
      path: `/variations/${variationId}:question`,
      body: {
        id: randomUUID(), kind: 'question', body: text,
        ...(addresseeOrgId ? { addressee_org_id: addresseeOrgId } : {}),
      },
      idempotencyKey: randomUUID(),
    });
    return true as const;
  });
}

/** S-10: the impact note before a new finish is saved (dry maths, nothing written). */
export async function previewFinishV2(taskId: string, finish: string, start?: string): Promise<ActionResult<MoveImpact>> {
  return attempt(async () => {
    const body = await v2<V2MovePreview>({
      method: 'POST',
      path: `/tasks/${taskId}:preview-move`,
      body: { finish, ...(start ? { start } : {}) },
    });
    return toMoveImpact(body);
  });
}

/**
 * S-10 / S-11: commit a new finish (and start, when a bar was dragged) as ONE
 * D-26 delta with the optional "why". `base` is what the panel showed, so an
 * overwrite is detected and reported by the server. `confirmNotAssignee` is
 * the explicit "I am not responsible for this row — save anyway" (D-31/D-33).
 */
export async function commitDatesV2(input: {
  taskId: string;
  finish: string;
  baseFinish: string | null;
  start?: string;
  baseStart?: string | null;
  reason?: string;
  confirmNotAssignee?: boolean;
}): Promise<ActionResult<true>> {
  return attempt(async () => {
    const changes: Record<string, { value: string; base: string | null }> = {
      finish: { value: input.finish, base: input.baseFinish },
    };
    if (input.start) changes.start = { value: input.start, base: input.baseStart ?? null };
    await v2({
      method: 'PATCH',
      path: `/tasks/${input.taskId}`,
      body: {
        client_change_id: randomUUID(),
        changes,
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        ...(input.confirmNotAssignee ? { confirm_not_assignee: true } : {}),
      },
    });
    return true as const;
  });
}

/** S-12 "Mark done": one progress report; the server closes the row (actual finish today). */
export async function markDoneV2(taskId: string): Promise<ActionResult<true>> {
  return attempt(async () => {
    await v2({ method: 'POST', path: `/tasks/${taskId}/progress`, body: { status: 'done' } });
    return true as const;
  });
}
