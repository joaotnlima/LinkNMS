// Pure v2-wire → view transforms for the task workspace (LINA-324, S7 of the UI
// cutover, doc 22 §3). Split out of `task-workspace.ts` (which does the I/O and
// imports `server-only`) so the mapping is unit-testable without a Clerk session
// or a router — exactly as `profile-view.ts` is the pure counterpart to
// `profile.ts` on the S1 side.
//
// ── WHAT CHANGED FROM v1 ─────────────────────────────────────────────────────
// The v1 task workspace (`lib/task-workspace.ts`, LINA-250) anchored on a stage's
// stable client `key` and hit one v1 route that returned BOTH rails, with authors
// named by `party` id. v2 splits the surface across two org-centric modules and
// keys on the v2 TASK id (a UUID), not a stage key:
//
//  • CONVERSATION → Collaboration (`GET/POST /threads/task/{taskId}/comments`).
//    A comment carries `{ person_id, org_id }`, a `kind` (note | question) and,
//    for questions, an addressee org and a lifecycle status. Append-only stays:
//    the module has no edit/delete grant, only a tombstone (`deleted`), so a
//    correction is a new comment — the same rule v1 kept.
//  • FILES → Documents (`GET /documents?scope_type=task&scope_id={taskId}`,
//    presigned-upload protocol). A document is versioned; downloads are minted
//    per request behind a V6 scope-visibility check (`…:download` → 302), never a
//    public URL. Out-of-scope files are absent from the list (the whole scope
//    404s), and an individual forbidden download surfaces as a typed refusal.
//
// The mapping is product-critical: this is the last place a v2 record becomes the
// shape a screen renders, and a wrong author or an invented version here is a
// wrong answer to the record's only question. Every field is derived, never guessed.

// ── The v2 wire shapes we read (subset) ──────────────────────────────────────
// Restated locally, the same discipline as `profile-view.ts`: a drift in a
// module's projection lands as a type error here rather than as `undefined`
// under a comment. Verbatim against modules/collaboration/domain/lifecycle.mjs
// (commentBody) and modules/documents/domain/model.mjs (documentBody).

/** A person acting inside an org — the v2 attribution pair on every write. */
export interface V2Actor {
  person_id: string;
  org_id: string;
}

export type V2CommentKind = 'note' | 'question';
export type V2QuestionStatus = 'open' | 'answered' | 'resolved';

export interface V2Comment {
  id: string;
  object_type: string;
  object_id: string;
  kind: V2CommentKind;
  body: string;
  author: V2Actor;
  addressee_org_id?: string;
  question_status?: V2QuestionStatus;
  answers_comment_id?: string;
  attachment_ids?: string[];
  created_at: string;
  deleted: boolean;
}

export interface V2DocumentVersion {
  version_no: number;
  mime: string;
  size_bytes: number;
  sha256: string;
  uploaded_by: V2Actor;
  uploaded_at: string;
}

export type V2DocumentKind =
  | 'drawing' | 'bim' | 'photo' | 'spec' | 'contract_doc' | 'invoice' | 'other';

export interface V2Document {
  id: string;
  scope_type: string;
  scope_id: string;
  kind: V2DocumentKind;
  title: string;
  share_with_ancestors: boolean;
  current_version: number;
  versions: V2DocumentVersion[];
}

/** `{ items, next_cursor }` — every v2 list body (platform pagination). */
export interface V2List<T> {
  items: T[];
  next_cursor: string | null;
}

/** `POST /documents` and `/versions` answer this (schema UploadTicket). */
export interface V2UploadTicket {
  document_version_id: string;
  upload_url: string;
  expires_at: string;
}

// ── View shapes the screen renders ───────────────────────────────────────────
// v2-shaped on purpose: the S3 plan grid (which owns the v2 task id) will hand
// this surface a task UUID and render these, resolving `personId`/`orgId` to
// names from the participant list it already holds — the same "names come from
// the project, not the row" rule the v1 `TaskWorkspace` component kept.

export interface CommentView {
  id: string;
  kind: V2CommentKind;
  /** '' when tombstoned — the slot is kept, the words are not. */
  body: string;
  authorPersonId: string;
  authorOrgId: string;
  /** Present only on questions. */
  questionStatus: V2QuestionStatus | null;
  addresseeOrgId: string | null;
  /** Document ids attached to this comment, if any. */
  attachmentIds: string[];
  createdAt: string;
  deleted: boolean;
}

export interface DocumentVersionView {
  versionNo: number;
  mime: string;
  sizeBytes: number;
  sha256: string;
  uploaderPersonId: string;
  uploaderOrgId: string;
  uploadedAt: string;
  /** `<documentId>.<versionNo>` — the id `…:download` resolves against. */
  ref: string;
  /** Where the browser navigates to download this version (302 behind V6). */
  downloadPath: string;
}

export interface DocumentView {
  id: string;
  kind: V2DocumentKind;
  title: string;
  currentVersion: number;
  /** The current version — what the file row shows and links to. */
  latest: DocumentVersionView | null;
  /** All proven versions, oldest → newest, for a version history. */
  versions: DocumentVersionView[];
}

/** One task's workspace: the two rails, oldest → newest. */
export interface WorkspaceView {
  taskId: string;
  comments: CommentView[];
  documents: DocumentView[];
}

/**
 * A typed refusal, so a screen can react to the KIND rather than to prose —
 * exactly as the v1 `WorkspaceError` did. `code` is the stable problem+json
 * discriminator; `message` is this surface's wording for a party to read.
 */
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

// ── Wire → view transforms ────────────────────────────────────────────────────

export const TASK_OBJECT_TYPE = 'task';
export const TASK_SCOPE_TYPE = 'task';

/** The address `…:download` and `…:complete` resolve against (schema versionRef). */
export function versionRefOf(documentId: string, versionNo: number): string {
  return `${documentId}.${versionNo}`;
}

/**
 * Where the browser navigates to download one version. NOT routed through the
 * server-only v2 client: the handler answers a 302 to a short-lived presigned
 * R2 URL after a V6 visibility check, so this is a plain link the browser
 * follows. The colon is a router command — never url-encode the whole segment.
 */
export function taskDocumentDownloadPath(ref: string): string {
  return `/api/v2/document-versions/${ref}:download`;
}

export function toCommentView(c: V2Comment): CommentView {
  return {
    id: c.id,
    kind: c.kind,
    body: c.deleted ? '' : c.body,
    authorPersonId: c.author.person_id,
    authorOrgId: c.author.org_id,
    questionStatus: c.question_status ?? null,
    addresseeOrgId: c.addressee_org_id ?? null,
    attachmentIds: c.attachment_ids ?? [],
    createdAt: c.created_at,
    deleted: c.deleted === true,
  };
}

function toVersionView(documentId: string, v: V2DocumentVersion): DocumentVersionView {
  const ref = versionRefOf(documentId, v.version_no);
  return {
    versionNo: v.version_no,
    mime: v.mime,
    sizeBytes: Number(v.size_bytes),
    sha256: v.sha256,
    uploaderPersonId: v.uploaded_by.person_id,
    uploaderOrgId: v.uploaded_by.org_id,
    uploadedAt: v.uploaded_at,
    ref,
    downloadPath: taskDocumentDownloadPath(ref),
  };
}

/**
 * The version a file row shows: the one whose number matches `current_version`,
 * with a fall-back to the highest number present. Never invents a version —
 * a document with no versions (should not happen for a listed doc) has a null
 * latest rather than a fabricated one.
 */
export function latestVersionOf(d: V2Document): DocumentVersionView | null {
  const current = d.versions.find((v) => v.version_no === d.current_version)
    ?? d.versions.reduce<V2DocumentVersion | null>(
      (best, v) => (best && best.version_no >= v.version_no ? best : v), null);
  return current ? toVersionView(d.id, current) : null;
}

export function toDocumentView(d: V2Document): DocumentView {
  const versions = [...d.versions]
    .sort((a, b) => a.version_no - b.version_no)
    .map((v) => toVersionView(d.id, v));
  return {
    id: d.id,
    kind: d.kind,
    title: d.title,
    currentVersion: d.current_version,
    latest: latestVersionOf(d),
    versions,
  };
}

// ── Formatters (pure, and testable) ───────────────────────────────────────────
// Carried over verbatim from the v1 surface — proven and unit-tested there — so
// the screen reads a file size and a timestamp the same way after the cutover.

/** A file size as a person reads one — "8 KB", "1.4 MB". */
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
 * week. `now` is a parameter, never `Date.now()` inside: that keeps a
 * server-rendered string from disagreeing with the client's first paint, and a
 * future timestamp (clock skew) reads "just now" — the record never promises
 * the future.
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

/**
 * The 64-hex sha256 a screen computes from a file, in the base64 form the
 * presigned PUT pins as its `x-amz-checksum-sha256` header (storage/infra
 * signs `Buffer.from(hex,'hex').toString('base64')`). Pure and testable; the
 * byte-hashing itself is a browser step (see `sha256HexOfBlob`).
 */
export function hexToBase64(hex: string): string {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error('sha256 must be 64 hex characters');
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ── Refusal wording (pure) ────────────────────────────────────────────────────
// The server's codes are the authority on WHAT happened; the sentences here are
// this surface's job (an API message is written for an API client). Only the
// codes this screen can actually provoke are named — anything else falls back to
// the server's own message rather than to a guess.
const SAID: Record<string, string> = {
  not_found: 'This task is no longer on the plan, or it is out of your scope — its workspace is not available.',
  forbidden: 'You can read this task but are not allowed to add to it or download this file.',
  unauthenticated: 'Your session has expired. Sign in again to continue.',
  validation_failed: 'That did not go through — check what you entered and try again.',
  version_conflict: 'Your account is still being set up. Try again in a moment.',
  idempotency_mismatch: 'That action was already taken. Reload to see the latest.',
  invalid_transition: 'That is no longer possible in the current state. Reload to see the latest.',
};

/** The sentence a party should read for a problem code, with a safe fallback. */
export function workspaceMessage(code: string, serverDetail?: string | null): string {
  return SAID[code] ?? serverDetail ?? 'That did not go through. Try again.';
}
