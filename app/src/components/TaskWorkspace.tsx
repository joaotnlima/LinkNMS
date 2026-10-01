'use client';

// The task workspace — the conversation and the files on one plan task, on
// `/api/v2` (LINA-399, Phase 12b.9 of the UI cutover; data layer LINA-324; the v1
// surface was LINA-250). It reaches the server-only v2 data layer through the
// `task-workspace-actions.ts` server actions and does the direct browser → R2
// upload PUT itself (`upload-client.ts`), the same split `plan-write.ts` uses.
//
// ── KEYING (the shape change, doc 22 header) ──────────────────────────────────
// v1 anchored on a stage's client `key` scoped to a project; v2 anchors on the v2
// TASK id (a UUID — in v2 a row's id IS its key, LINA-396), and every read/write
// is scoped by the viewer's active org server-side. The caller plumbs that task
// id in; `null` is the unsaved-task state, which has no address to hang a thread
// off and says so.
//
// ── WHAT THIS SURFACE PROMISES (unchanged from v1) ───────────────────────────
// 1. APPEND-ONLY, AND IT LOOKS IT. No edit pencil, no delete — the v2 modules
//    carry no such grant (only a tombstone). A correction is a new comment; a new
//    file is a new version. Drawing an affordance that would 403 would misdescribe
//    the record.
// 2. NAMES COME FROM THE PROJECT, NOT THE ROW. A comment carries an author
//    person/org id; the name is resolved here from the members the screen holds
//    (empty on v2 plan surfaces today, D-33), so a renamed party is renamed on
//    every comment they left rather than frozen into the row.
// 3. NO LOCAL FAKES. A task not saved yet has no address, so the section says so
//    instead of collecting comments in React state the next reload would swallow.
// 4. THE SERVER IS THE AUTHORITY ON A FILE. The declared sha256 is pinned into the
//    presigned PUT, so storage refuses different bytes; the server answers
//    415/413 and its answer is what is shown. Downloads are a 302 behind a V6
//    scope check (`downloadPath`), never a public URL we draw.

import { useCallback, useEffect, useRef, useState } from 'react';

import { PartyAvatar } from '@/components/PartyAvatar';
import { partyIndex, roleWord, UNKNOWN_PARTY, type PartyRef } from '@/lib/party-display';
import {
  completeDocumentAction, loadWorkspaceAction, postCommentAction, reserveDocumentAction,
} from '@/lib/v2/task-workspace-actions';
import { digestSha256, putToTicket } from '@/lib/v2/upload-client';
import {
  formatBytes, relativeTime,
  type CommentView, type DocumentView, type WorkspaceView,
} from '@/lib/v2/task-workspace-view';
import './task-workspace.css';

export function TaskWorkspace({
  taskId, parties = [], heading = 'Conversation & files',
}: {
  /**
   * The v2 TASK id (a UUID), or null when the task exists only in the unsaved
   * editor. Null is a real state with its own copy — not an empty thread.
   */
  taskId: string | null;
  /** The build's members, for naming an author. */
  parties?: PartyRef[];
  heading?: string;
}) {
  const [view, setView] = useState<WorkspaceView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Captured per mount rather than read per render: "4 min ago" must not change
  // under a keystroke, and a value read during render would differ between the
  // server pass and the first client paint.
  const [nowMs] = useState(() => Date.now());

  const dir = partyIndex(parties);

  // One read per task. The id IS the identity of the thread, so switching tasks in
  // the drawer re-reads rather than reconciling — and a stale response from the
  // task you just left is dropped (`live`), not painted over the new one.
  useEffect(() => {
    if (!taskId) { setView(null); setError(null); return; }
    let live = true;
    setLoading(true);
    setError(null);
    setView(null);
    loadWorkspaceAction(taskId)
      .then((res) => {
        if (!live) return;
        if (res.ok) setView(res.value);
        else setError(res.message);
      })
      .catch(() => { if (live) setError('Could not load this task’s workspace.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [taskId]);

  const send = useCallback(async () => {
    if (!taskId) return;
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      const res = await postCommentAction(taskId, body);
      if (res.ok) {
        // Append the server's row, never our draft: `createdAt` and the author are
        // ITS answer, and echoing our own copy would show a comment that differs
        // from the one everyone else will read.
        setView((prev) => (prev ? { ...prev, comments: [...prev.comments, res.value] } : prev));
        setDraft('');
      } else {
        setError(res.message);
      }
    } catch {
      setError('That comment did not go through. Try again.');
    } finally {
      setSending(false);
    }
  }, [draft, taskId]);

  const upload = useCallback(async (file: File) => {
    if (!taskId) return;
    setUploading(true);
    setError(null);
    const mime = file.type || 'application/octet-stream';
    try {
      // The three-step v2 upload: reserve a presigned PUT (sha256 pinned into the
      // signature), PUT the bytes straight to R2 (never through us), then prove
      // they landed. An error at any step aborts before `complete`, so an unproven
      // version stays invisible everywhere.
      const { hex, base64 } = await digestSha256(file);
      const reserved = await reserveDocumentAction(taskId, {
        name: file.name, mime, sizeBytes: file.size, sha256: hex,
      });
      if (!reserved.ok) { setError(reserved.message); return; }

      await putToTicket(reserved.value.uploadUrl, file, mime, base64);

      const completed = await completeDocumentAction(reserved.value.versionRef);
      if (!completed.ok) { setError(completed.message); return; }
      setView((prev) => (prev ? { ...prev, documents: [...prev.documents, completed.value] } : prev));
    } catch {
      setError('That file did not upload. Try again.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = ''; // same file twice must still fire
    }
  }, [taskId]);

  // ── The unsaved state (the rails anchor on a PERSISTED task id) ────────────
  if (!taskId) {
    return (
      <section className="tws" aria-label={heading}>
        <h3 className="tws-h">{heading}</h3>
        <p className="tws-quiet">
          Save the plan to start the conversation. Comments and files live on the task once it is
          saved — until then there is nothing for them to hang on.
        </p>
      </section>
    );
  }

  return (
    <section className="tws" aria-label={heading}>
      <h3 className="tws-h">{heading}</h3>

      {error ? <p role="alert" className="tws-error">{error}</p> : null}

      {loading ? (
        <p className="tws-quiet" role="status">Loading the conversation…</p>
      ) : view ? (
        <>
          <ol className="tws-thread">
            {view.comments.length === 0 ? (
              <li className="tws-quiet">
                No comments yet. Anything written here is visible to everyone on the build.
              </li>
            ) : view.comments.map((c) => (
              <CommentRow key={c.id} comment={c} dir={dir} nowMs={nowMs} />
            ))}
          </ol>

          {/* Append-only: one box, one button, no edit anywhere. Cmd/Ctrl+Enter
              sends — the shortcut people already use in every thread. */}
          <div className="tws-composer">
            <label className="tws-label" htmlFor="tws-comment">Add a comment</label>
            <textarea
              id="tws-comment"
              className="tws-input"
              value={draft}
              maxLength={4000}
              placeholder="Ask a question, note what changed on site, flag what you need."
              disabled={sending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send(); }
              }}
            />
            <div className="tws-composer-foot">
              <span className="tws-hint">
                Comments cannot be edited or deleted — a correction is a new comment.
              </span>
              <button
                type="button"
                className="btn primary"
                disabled={sending || draft.trim().length === 0}
                onClick={() => void send()}
              >
                {sending ? 'Posting…' : 'Comment'}
              </button>
            </div>
          </div>

          <div className="tws-files">
            <div className="tws-files-hd">
              <h4 className="tws-sub">Files</h4>
              <button
                type="button"
                className="pbx-icon tws-upload"
                disabled={uploading}
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? 'Uploading…' : 'Attach a file'}
              </button>
              <input
                ref={fileInput}
                type="file"
                className="tws-fileinput"
                aria-label="Attach a file to this task"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
            </div>

            {view.documents.length === 0 ? (
              <p className="tws-quiet">
                No files yet. Images, PDFs and office documents up to 10 MB.
              </p>
            ) : (
              <ul className="tws-filelist">
                {view.documents.map((d) => (
                  <FileRow key={d.id} document={d} dir={dir} nowMs={nowMs} />
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

function CommentRow({
  comment, dir, nowMs,
}: {
  comment: CommentView;
  dir: Map<string, PartyRef>;
  nowMs: number;
}) {
  const author = dir.get(comment.authorPersonId)
    ?? { partyId: comment.authorPersonId, name: UNKNOWN_PARTY, role: null };
  return (
    <li className="tws-comment">
      <PartyAvatar party={author} size="sm" />
      <div className="tws-comment-body">
        <p className="tws-comment-hd">
          <span className="tws-who">{author.name}</span>
          <span className="tws-role">{roleWord(author.role)}</span>
          {/* The absolute time is the title, the relative one is the label:
              "3 h ago" orients, the timestamp is what the record holds. */}
          <time className="tws-when" dateTime={comment.createdAt} title={comment.createdAt}>
            {relativeTime(comment.createdAt, nowMs)}
          </time>
        </p>
        {/* A tombstoned comment keeps its slot but not its words — the record shows
            that something was there, append-only, never a silent gap. */}
        {comment.deleted ? (
          <p className="tws-comment-text tws-quiet">This comment was removed.</p>
        ) : (
          <p className="tws-comment-text">{comment.body}</p>
        )}
      </div>
    </li>
  );
}

function FileRow({
  document, dir, nowMs,
}: {
  document: DocumentView;
  dir: Map<string, PartyRef>;
  nowMs: number;
}) {
  const { latest } = document;
  const uploader = latest
    ? dir.get(latest.uploaderPersonId)
      ?? { partyId: latest.uploaderPersonId, name: UNKNOWN_PARTY, role: null }
    : null;
  return (
    <li className="tws-file">
      {/* The download is a 302 behind a V6 scope check (`downloadPath`), not a
          public URL — a plain navigation the browser follows. */}
      {latest ? (
        <a className="tws-filename" href={latest.downloadPath} target="_blank" rel="noreferrer">
          {document.title}
        </a>
      ) : (
        <span className="tws-filename">{document.title}</span>
      )}
      {latest ? (
        <span className="tws-filemeta">
          {formatBytes(latest.sizeBytes)} · {uploader?.name ?? UNKNOWN_PARTY} ·{' '}
          <time dateTime={latest.uploadedAt} title={latest.uploadedAt}>
            {relativeTime(latest.uploadedAt, nowMs)}
          </time>
        </span>
      ) : null}
    </li>
  );
}
