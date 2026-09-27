// The task workspace data layer, on `/api/v2` (LINA-324, S7 of the UI cutover,
// doc 22 §3). Moves the per-task conversation + files off the single v1 route
// (`lib/task-workspace.ts`, LINA-250) onto the two org-centric v2 modules —
// Collaboration (threads) and Documents (versioned files on R2) — through the
// shared v2 client (`./client.ts`, LINA-309). It mints no second client.
//
// ── SHAPE CHANGE (doc 22 header): org-centric, keyed on the v2 TASK id ────────
// v1 keyed the workspace on a stage's client `key`; v2 anchors on the v2 task's
// UUID, and every read/write is scoped by the viewer's ACTIVE ORG server-side
// (never a client-held id). Two states have no v1 analog and are first-class
// here, never a crash (the S1 `profile.ts` pattern):
//   • Signed in, no active org → there is nothing to scope a task to. We return
//     an EMPTY workspace rather than letting the org-required reads 403 into the
//     render.
//   • A task the viewer cannot see → the modules answer 404 (existence hiding).
//     We raise a typed `WorkspaceError('not_found', …)` the screen renders as a
//     sentence, exactly as the v1 surface did.
//
// ── THE RULES THIS FILE KEEPS (unchanged from v1, enforced by the v2 modules) ─
//   1. THE ACTOR IS NEVER IN THE BODY. A comment sends `{ id, kind, body }`; the
//      author `{ person_id, org_id }` is stamped server-side from the session.
//   2. APPEND-ONLY. No edit, no delete — the modules carry no such grant. A
//      correction is a new comment; a new file is a new version.
//   3. NOTHING IS DERIVED FROM A FILE'S DECLARED TYPE FOR TRUST. The declared
//      sha256 is pinned into the presigned PUT, so storage refuses different
//      bytes; `completeUpload` proves the object exists at the declared size.
//   4. DOWNLOADS ARE GATED BY V6. `listDocuments` 404s a whole scope the viewer
//      cannot read, so out-of-scope files never appear; an individual download
//      is a browser navigation to a 302 route (`taskDocumentDownloadPath`), and a
//      forbidden one surfaces the server's problem — not a broken link we drew.
//
// The pure wire→view transforms live in `./task-workspace-view.ts` so they stay
// unit-testable without a session; this module is only the I/O and the mapping
// of a `V2Error` into the typed `WorkspaceError` the screen reacts to.
//
// NOTE (sequencing): the SCREEN that renders this (the plan grid's task drawer)
// is cut over in S3, which owns the v2 task id. Until S3 lands there is no v2
// task id in the UI to call these with; this layer ships ready for it, the same
// way S1 shipped `profile.ts` before the surfaces that lean on it.
import 'server-only';

import { v2, V2Error } from './client';
import {
  TASK_OBJECT_TYPE, TASK_SCOPE_TYPE,
  toCommentView, toDocumentView, versionRefOf, workspaceMessage,
  WorkspaceError,
  type CommentView, type DocumentView, type WorkspaceView,
  type V2Comment, type V2Document, type V2List, type V2UploadTicket, type V2DocumentKind,
} from './task-workspace-view';
import type { V2Me } from './profile-view';

// A thread or a document scope can hold more than one page; the workspace shows
// the whole task, so the reads drain the cursor. The cap is a runaway guard, not
// a product limit — a task with thousands of comments is not a real state, and
// stopping is safer than an unbounded loop.
const PAGE = 200;
const MAX_PAGES = 25;

function enc(id: string): string {
  return encodeURIComponent(id);
}

/** Turn a v2 client failure into the typed refusal the screen reads. */
function asWorkspaceError(err: unknown): WorkspaceError {
  if (err instanceof V2Error) {
    return new WorkspaceError(err.code, workspaceMessage(err.code, err.detail), err.status);
  }
  return new WorkspaceError('internal', 'Something went wrong. Try again.', 500);
}

/** An empty workspace — the no-active-org / nothing-yet answer, not an error. */
function empty(taskId: string): WorkspaceView {
  return { taskId, comments: [], documents: [] };
}

/**
 * GET the whole task workspace: the comment thread + the documents scoped to the
 * task, both cursor-drained, oldest → newest.
 *
 * No active org → an empty workspace (first-class; the org-required reads would
 * only 403). A task the viewer cannot read → a typed `WorkspaceError` the screen
 * renders, never a crash.
 */
export async function fetchTaskWorkspace(taskId: string): Promise<WorkspaceView> {
  // Mirror S1's `listPortfolio`: without an active org there is nothing to scope
  // to, so skip the reads and answer the empty state directly.
  let me: V2Me | null = null;
  try {
    me = await v2<V2Me>({ method: 'GET', path: '/me' });
  } catch (err) {
    if (!(err instanceof V2Error)) throw err; // not a problem+json failure — real
  }
  if (!me?.active_org) return empty(taskId);

  try {
    const [comments, documents] = await Promise.all([
      drainComments(taskId),
      drainDocuments(taskId),
    ]);
    return { taskId, comments, documents };
  } catch (err) {
    throw asWorkspaceError(err);
  }
}

async function drainComments(taskId: string): Promise<CommentView[]> {
  const out: CommentView[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res: V2List<V2Comment> = await v2<V2List<V2Comment>>({
      method: 'GET',
      path: `/threads/${TASK_OBJECT_TYPE}/${enc(taskId)}/comments`,
      query: { limit: PAGE, cursor: cursor ?? undefined },
    });
    out.push(...res.items.map(toCommentView));
    cursor = res.next_cursor;
    if (!cursor) break;
  }
  return out;
}

async function drainDocuments(taskId: string): Promise<DocumentView[]> {
  const out: DocumentView[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res: V2List<V2Document> = await v2<V2List<V2Document>>({
      method: 'GET',
      path: '/documents',
      query: { scope_type: TASK_SCOPE_TYPE, scope_id: taskId, limit: PAGE, cursor: cursor ?? undefined },
    });
    out.push(...res.items.map(toDocumentView));
    cursor = res.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/**
 * POST a note to the task thread. The client id doubles as the idempotency key
 * (the module dedupes on it), so a retried submit is absorbed, not doubled. The
 * author is the session — never in the body.
 */
export async function postTaskComment(
  taskId: string,
  body: string,
  opts: { id?: string; mentions?: string[]; attachmentIds?: string[] } = {},
): Promise<CommentView> {
  const id = opts.id ?? crypto.randomUUID();
  try {
    const comment = await v2<V2Comment>({
      method: 'POST',
      path: `/threads/${TASK_OBJECT_TYPE}/${enc(taskId)}/comments`,
      body: {
        id,
        kind: 'note',
        body,
        mentions: opts.mentions ?? [],
        attachment_ids: opts.attachmentIds ?? [],
      },
      idempotencyKey: id,
    });
    return toCommentView(comment);
  } catch (err) {
    throw asWorkspaceError(err);
  }
}

/** What a screen needs to PUT the bytes to R2, plus the ref to complete with. */
export interface UploadReservation {
  versionRef: string;
  uploadUrl: string;
  expiresAt: string;
}

/**
 * Step 1 of the upload protocol: reserve a document (its first version) scoped
 * to the task and get a presigned PUT ticket. The declared sha256 is pinned into
 * the signature, so the browser cannot upload bytes other than the ones it
 * declared. The client `id` is the idempotency key — a replay re-issues a ticket
 * for the same reserved version.
 *
 * Attaching needs EDIT scope of the task (V6): a reader gets a clean `forbidden`,
 * a non-participant a `not_found`. Both arrive as a typed `WorkspaceError`.
 */
export async function reserveTaskDocument(
  taskId: string,
  file: { name: string; mime: string; sizeBytes: number; sha256: string },
  opts: { id?: string; title?: string; kind?: V2DocumentKind } = {},
): Promise<UploadReservation> {
  const id = opts.id ?? crypto.randomUUID();
  try {
    const ticket = await v2<V2UploadTicket>({
      method: 'POST',
      path: '/documents',
      body: {
        id,
        scope_type: TASK_SCOPE_TYPE,
        scope_id: taskId,
        kind: opts.kind ?? 'other',
        title: opts.title?.trim() || file.name,
        file: {
          name: file.name,
          mime: file.mime,
          size_bytes: file.sizeBytes,
          sha256: file.sha256.toLowerCase(),
        },
      },
      idempotencyKey: id,
    });
    return {
      versionRef: ticket.document_version_id,
      uploadUrl: ticket.upload_url,
      expiresAt: ticket.expires_at,
    };
  } catch (err) {
    throw asWorkspaceError(err);
  }
}

/**
 * Step 3 of the upload protocol (step 2 is the browser PUT to `uploadUrl`, see
 * `sha256HexOfBlob` / `putFileToTicket` below): prove the bytes landed and
 * advance the document's current version. Returns the completed document view.
 */
export async function completeTaskDocument(versionRef: string): Promise<DocumentView> {
  try {
    const doc = await v2<V2Document>({
      method: 'POST',
      path: `/document-versions/${versionRef}:complete`,
    });
    return toDocumentView(doc);
  } catch (err) {
    throw asWorkspaceError(err);
  }
}

/** Re-export the version-ref builder so a caller composing refs uses one source. */
export { versionRefOf };

// ── Browser upload helpers (step 2) ───────────────────────────────────────────
// These run in the client component that owns the <input type=file>, not on the
// server: the whole point of the presigned ticket is a direct browser→R2 PUT
// that never streams the bytes through us. They are plain Web-platform calls
// (SubtleCrypto, fetch) and touch neither the v2 client nor `server-only`.

/**
 * The file's sha256 as 64 lowercase hex chars — what `reserveTaskDocument`
 * declares and what storage pins into the PUT signature. Computed from the exact
 * bytes so the declaration and the upload cannot disagree.
 */
export async function sha256HexOfBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * PUT the bytes to the presigned ticket URL. The `x-amz-checksum-sha256` header
 * (base64 of the same hex) and the content type must match what the ticket was
 * signed for, or storage refuses the object. On failure the caller aborts before
 * `completeTaskDocument` — an unproven version stays invisible everywhere.
 */
export async function putFileToTicket(
  uploadUrl: string, file: Blob, mime: string, sha256Base64: string,
): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': mime, 'x-amz-checksum-sha256': sha256Base64 },
    body: file,
  });
  if (!res.ok) {
    throw new WorkspaceError('upload_failed', 'That file did not upload. Try again.', res.status);
  }
}
