// The task workspace client (LINA-250; BE half LINA-249).
//
// Contract: docs/architecture/slice-task-workspace-contract.md §4. Three calls,
// all project-scoped and anchored on the stage's stable `key` rather than its
// row id — a draft re-save re-mints stage ids, and a comment thread that moved
// with the row id would detach from its task on the next save.
//
// THE RULES THIS FILE KEEPS (contract §0):
//   1. THE ACTOR IS NEVER IN THE BODY. A comment sends `{ body }` and an
//      attachment sends bytes; the author/uploader is the session party,
//      stamped server-side. A client that could name itself could put words in
//      another party's mouth on the shared record.
//   2. APPEND-ONLY. There is no edit and no delete here because there is none in
//      the API — v1 has no UPDATE/DELETE grant at all. A typo earns a new
//      comment.
//   3. NOTHING IS DERIVED FROM A FILE'S DECLARED TYPE. The browser's
//      `file.type` is not sent as truth and not used for gating; the server
//      sniffs magic bytes and answers 415. We show ITS answer.
//
// Everything above `fetch` is pure and unit-tested (task-workspace.test.mjs):
// relative time, byte sizes, and the stage lookup the permalink route resolves
// a URL against.

import type { PlanStageNode } from './plan-baseline';

// ── Wire shapes (contract §4) ────────────────────────────────────────────────
// Restated locally, the same discipline as lib/plan-baseline.ts: a drift in the
// schedule service's projection lands as a type error here rather than as
// `undefined` under a comment.

export interface CommentView {
  id: string;
  body: string;
  authorPartyId: string;
  createdAt: string;
}

export interface AttachmentView {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploaderPartyId: string;
  blobUrl: string;
  createdAt: string;
}

/** One fetch for the drawer — both rails, oldest → newest. */
export interface WorkspaceView {
  stageKey: string;
  comments: CommentView[];
  attachments: AttachmentView[];
}

/** A typed refusal, so a screen can react to the KIND rather than to prose. */
export class WorkspaceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.status = status;
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Every persisted stage key in a saved version's tree.
 *
 * The workspace rails only exist for stages the server holds: a task the author
 * just added in the editor has a local key and no row behind it, so its section
 * says "save the plan first" rather than opening a thread that would 404 on the
 * first comment. Import-seeded and legacy stages carry no key at all (§1) and
 * are simply absent from the set.
 */
export function stageKeysOf(stages: PlanStageNode[] | null | undefined): Set<string> {
  const keys = new Set<string>();
  const walk = (nodes: PlanStageNode[]) => {
    for (const n of nodes) {
      if (typeof n.key === 'string' && n.key.length > 0) keys.add(n.key);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(stages ?? []);
  return keys;
}

/** A stage found by key, with the names above it — the permalink's heading. */
export interface StageHit {
  node: PlanStageNode;
  /** Ancestor names, outermost first (phase → task), excluding the node itself. */
  trail: string[];
  /** 0 = phase, 1 = task, 2 = sub-task. */
  depth: number;
}

/**
 * Resolve a URL's stage key against a saved version's tree, or null.
 *
 * Null is what the permalink route turns into `notFound()`: a key that names no
 * stage on this project's current plan is a dead address, and rendering an
 * empty drawer for it would invent a task that does not exist.
 */
export function findStageByKey(
  stages: PlanStageNode[] | null | undefined, key: string,
): StageHit | null {
  const walk = (nodes: PlanStageNode[], trail: string[]): StageHit | null => {
    for (const n of nodes) {
      if (n.key === key) {
        return { node: n, trail, depth: trail.length };
      }
      const hit = n.children?.length ? walk(n.children, [...trail, n.name]) : null;
      if (hit) return hit;
    }
    return null;
  };
  return key ? walk(stages ?? [], []) : null;
}

/**
 * A file size as a person reads one — "8 KB", "1.4 MB".
 *
 * Decimal units, one decimal place above a kilobyte and none below: the number
 * beside a file name is orientation ("is this the photo or the survey?"), not an
 * accounting figure, and "1,433,600 bytes" answers the question worse.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * "just now" / "4 min ago" / "3 h ago" / "2 days ago", and a plain date past a
 * week.
 *
 * `now` is a parameter, never `Date.now()` inside: that is what makes this
 * testable, and what keeps a server-rendered string from disagreeing with the
 * client's first paint. A future timestamp (clock skew) reads "just now" rather
 * than "in 3 minutes" — the record never promises the future.
 */
export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.floor((nowMs - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(then).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

/** The permalink for one task — the address the drawer copies and the URL bar shows. */
export function taskPath(projectId: string, stageKey: string): string {
  return `/projects/${encodeURIComponent(projectId)}/plan/tasks/${encodeURIComponent(stageKey)}`;
}

// ── The three calls (contract §4) ────────────────────────────────────────────

function base(projectId: string, stageKey: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/plan/stages/${encodeURIComponent(stageKey)}`;
}

/**
 * Turn a refusal into the typed error, with the wording a party should read.
 *
 * The server's codes are the authority on WHAT happened; the sentences here are
 * this surface's job (the API's messages are written for an API client). Only
 * the codes this screen can actually provoke are named — anything else falls
 * back to the server's own message rather than to a guess.
 */
async function refuse(res: Response): Promise<WorkspaceError> {
  let payload: unknown = null;
  try { payload = await res.json(); } catch { /* proxy error page */ }
  const err = (payload as { error?: { code?: string; message?: string } } | null)?.error;
  const code = err?.code ?? 'internal';
  const said: Record<string, string> = {
    not_found: 'This task is no longer on the plan, so its workspace is gone too.',
    not_member: 'You are not on this build, so you cannot read or add to this task.',
    unauthenticated: 'Your session has expired. Sign in again to continue.',
    invalid_comment: 'A comment has to say something, and stay under 4000 characters.',
    empty_file: 'That file is empty.',
    attachment_too_large: 'That file is over the 10 MB limit.',
    unsupported_content_type: 'That file type is not accepted — images, PDFs and office documents are.',
    invalid_filename: 'That file name will not do — rename it and try again.',
  };
  return new WorkspaceError(code, said[code] ?? err?.message ?? 'That did not go through. Try again.', res.status);
}

/** GET …/workspace — both rails in one read (contract §4 route 1). */
export async function fetchWorkspace(projectId: string, stageKey: string): Promise<WorkspaceView> {
  const res = await fetch(`${base(projectId, stageKey)}/workspace`, { cache: 'no-store' });
  if (!res.ok) throw await refuse(res);
  return (await res.json()) as WorkspaceView;
}

/** POST …/comments — append one comment (§4 route 2). The author is the session. */
export async function addComment(
  projectId: string, stageKey: string, body: string,
): Promise<CommentView> {
  const res = await fetch(`${base(projectId, stageKey)}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw await refuse(res);
  return ((await res.json()) as { comment: CommentView }).comment;
}

/**
 * POST …/attachments — upload one file (§4 route 3).
 *
 * Multipart with a single `file` part and nothing else: no declared type, no
 * uploader, no size. All three are re-derived server-side, and sending our copy
 * of them would only create something for the two to disagree about.
 */
export async function uploadAttachment(
  projectId: string, stageKey: string, file: File,
): Promise<AttachmentView> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${base(projectId, stageKey)}/attachments`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw await refuse(res);
  return ((await res.json()) as { attachment: AttachmentView }).attachment;
}
