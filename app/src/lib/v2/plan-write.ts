'use server';

// The server action the v2 plan editor autosaves through (LINA-369, S3b).
//
// The write seams (`applyPlanDraft` / `applyPlanEdits`, `./planning.ts`) are
// `server-only`: they resolve the acting party from the session and speak to the
// v2 API in-process, so a browser cannot call them and a client cannot name a
// party it is not. This action is the thin, session-bound door the client editor
// reaches them through — projectId is bound server-side by the page, so the
// browser never supplies it.
//
// DISPATCH: `prev == null` is the FRESH-authoring case (a build with no plan yet)
// → `applyPlanDraft`, one `create_rows` batch. Otherwise it is an EDIT of the
// tree the editor last saved → `applyPlanEdits`, which diffs `prev` against `next`
// and fires the ordered request set. Both mint one `client_change_id`, so a
// retried autosave dedupes on the ledger rather than doubling an event — the audit
// trail is the product.
//
// A `V2Error` (no active org, not a participant, a validation refusal) is a NORMAL
// outcome for this surface, not a crash: it comes back as `{ ok: false }` so the
// editor renders the sentence beside the plan and keeps the author's edits, the
// same shape `app/actions.ts` uses. Anything else rethrows to the error boundary.
import { applyPlanDraft, applyPlanEdits, reportTaskProgress } from './planning';
import { V2Error } from './client';
import type { AuthoredNode, StageStatus } from '@/lib/plan-authoring';

/** author-local key → the stable v2 row id the save minted, for rows it created. */
export type SavePlanV2Result =
  | { ok: true; stageIds: Record<string, string>; needsReload: boolean }
  | { ok: false; code: string; message: string };

export async function savePlanV2(
  projectId: string,
  prev: AuthoredNode[] | null,
  next: AuthoredNode[],
): Promise<SavePlanV2Result> {
  try {
    if (prev == null) {
      const { idByKey } = await applyPlanDraft(projectId, next);
      // A fresh author never reparents anything — there is no prior tree to move
      // within — so a reload is never needed here.
      return { ok: true, stageIds: idByKey, needsReload: false };
    }
    const { idByKey, needsReload } = await applyPlanEdits(projectId, prev, next);
    return { ok: true, stageIds: idByKey, needsReload };
  } catch (err) {
    if (err instanceof V2Error) {
      return { ok: false, code: err.code, message: err.message };
    }
    throw err;
  }
}

/** The editor's status-picker outcome: `ok` on an appended report, or a typed
 *  refusal the picker rolls back on and shows inline (never a thrown crash). */
export type ReportProgressV2Result =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * The v2 progress-write door (LINA-384, Phase 12b.5): the plan editor's status
 * picker POSTs an append-only progress report through `/api/v2` instead of the
 * retired v1 `reportProgress` fetch. `taskId` is the stable v2 row id (for a
 * hydrated row that is the editor's node key itself; for a session-created row
 * it is the id the save minted). A `V2Error` — a role refusal, no active org,
 * an out-of-scope row — is a NORMAL outcome for this surface, returned as
 * `{ ok: false }` so the picker rolls back to the last recorded status and shows
 * the reason inline. Anything else rethrows to the error boundary.
 */
export async function reportProgressV2(
  taskId: string,
  status: StageStatus,
): Promise<ReportProgressV2Result> {
  try {
    await reportTaskProgress(taskId, status);
    return { ok: true };
  } catch (err) {
    if (err instanceof V2Error) {
      return { ok: false, code: err.code, message: err.message };
    }
    throw err;
  }
}
