'use server';

// The session-bound door the CLIENT task-workspace drawer reaches the v2 data
// layer through (LINA-399, Phase 12b.9 of the UI cutover, doc 22 §3).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// `./task-workspace.ts` is `server-only`: it resolves the viewer from the Clerk
// session and dispatches `/api/v2` in process, so a browser cannot import it and
// a client cannot name a party it is not. `TaskWorkspace.tsx` is a `'use client'`
// component (it owns the composer and the `<input type=file>`). This module is the
// thin server-action layer between them — exactly the `plan-write.ts` pattern the
// v2 plan editor already uses (`saveV2`/`reportProgressV2`): the authored intent
// crosses the boundary, the privilege does not.
//
// ── EVERY ANSWER IS SERIALIZABLE ─────────────────────────────────────────────
// A `WorkspaceError` is a class; it would not survive the RSC boundary as itself
// (a thrown error from a server action is opaque in production). So a typed
// refusal — no active org, out-of-scope, a validation failure — comes back as a
// plain `{ ok: false, code, message }`, the same discriminated shape `savePlanV2`
// returns, and the drawer renders the sentence beside the thread. Only an
// unexpected throw (not a `WorkspaceError`) collapses to the generic `internal`
// result rather than leaking a stack to the client.
import {
  fetchTaskWorkspace, postTaskComment, reserveTaskDocument, completeTaskDocument,
  type UploadReservation,
} from './task-workspace';
import {
  WorkspaceError,
  type CommentView, type DocumentView, type WorkspaceView,
} from './task-workspace-view';

/** A server-action answer: the value, or a typed refusal the drawer can read. */
export type WorkspaceActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

/** Map any failure to the serializable refusal shape — never rethrow to the client. */
function fail(err: unknown): { ok: false; code: string; message: string } {
  if (err instanceof WorkspaceError) {
    return { ok: false, code: err.code, message: err.message };
  }
  return { ok: false, code: 'internal', message: 'Something went wrong. Try again.' };
}

/** GET the whole workspace (thread + files) for one v2 task. */
export async function loadWorkspaceAction(
  taskId: string,
): Promise<WorkspaceActionResult<WorkspaceView>> {
  try {
    return { ok: true, value: await fetchTaskWorkspace(taskId) };
  } catch (err) {
    return fail(err);
  }
}

/** Append one note to the task thread. The author is the session, never the body. */
export async function postCommentAction(
  taskId: string, body: string,
): Promise<WorkspaceActionResult<CommentView>> {
  try {
    return { ok: true, value: await postTaskComment(taskId, body) };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Step 1 of the upload: reserve a document version and get the presigned PUT the
 * browser uploads the bytes to (step 2 is a client PUT, `putToTicket`). The
 * declared sha256 is pinned into the signature, so the browser cannot upload
 * other bytes than the ones it declared.
 */
export async function reserveDocumentAction(
  taskId: string,
  file: { name: string; mime: string; sizeBytes: number; sha256: string },
): Promise<WorkspaceActionResult<UploadReservation>> {
  try {
    return { ok: true, value: await reserveTaskDocument(taskId, file) };
  } catch (err) {
    return fail(err);
  }
}

/** Step 3 of the upload: prove the bytes landed and advance the document version. */
export async function completeDocumentAction(
  versionRef: string,
): Promise<WorkspaceActionResult<DocumentView>> {
  try {
    return { ok: true, value: await completeTaskDocument(versionRef) };
  } catch (err) {
    return fail(err);
  }
}
