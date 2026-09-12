'use client';

// The task workspace — the conversation and the files on one plan task
// (LINA-250; API LINA-249, contract slice-task-workspace-contract.md).
//
// Brand-book: brand-book/src/components/TaskWorkspace.stories.js — the comment
// row, the composer, the file row and the three quiet states have one home
// there, as every plan primitive does.
//
// ── WHAT THIS SURFACE PROMISES ───────────────────────────────────────────────
// 1. APPEND-ONLY, AND IT LOOKS IT. There is no edit pencil and no delete on a
//    comment or a file, because there is neither in the API — the tables carry
//    no UPDATE/DELETE grant at all. Drawing an affordance that would 403 (or
//    worse, look like it worked) would misdescribe the record.
// 2. NAMES COME FROM THE PROJECT, NOT FROM THE ROW. A comment carries a party
//    id; the name and the avatar are resolved here from the members the screen
//    already holds (ADR-0006 §1), so a renamed party is renamed on every comment
//    they ever left rather than leaving a frozen copy behind.
// 3. NO LOCAL FAKES. A task that is not saved yet has no address to hang a
//    thread off, so the section says so plainly instead of collecting comments
//    in React state that the next reload would swallow.
// 4. THE SERVER IS THE AUTHORITY ON A FILE. We do not gate on `file.type` or
//    pre-check the size beyond telling the party what the limit is: the server
//    sniffs magic bytes and answers 415/413, and its answer is what is shown.

import { useCallback, useEffect, useRef, useState } from 'react';

import { PartyAvatar } from '@/components/PartyAvatar';
import { partyIndex, roleWord, UNKNOWN_PARTY, type PartyRef } from '@/lib/party-display';
import {
  addComment, fetchWorkspace, formatBytes, relativeTime, uploadAttachment,
  WorkspaceError,
  type AttachmentView, type CommentView, type WorkspaceView,
} from '@/lib/task-workspace';
import './task-workspace.css';

export function TaskWorkspace({
  projectId, stageKey, parties = [], heading = 'Conversation & files',
}: {
  projectId: string;
  /**
   * The task's PERSISTED key, or null when the task exists only in the unsaved
   * editor. Null is a real state with its own copy — not an empty thread.
   */
  stageKey: string | null;
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

  // One read per task. The key IS the identity of the thread, so switching
  // tasks in the drawer re-reads rather than reconciling — and a stale response
  // from the task you just left is dropped (`live`), not painted over the new one.
  useEffect(() => {
    if (!stageKey) { setView(null); setError(null); return; }
    let live = true;
    setLoading(true);
    setError(null);
    setView(null);
    fetchWorkspace(projectId, stageKey)
      .then((w) => { if (live) setView(w); })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof WorkspaceError ? e.message : 'Could not load this task’s workspace.');
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectId, stageKey]);

  const send = useCallback(async () => {
    if (!stageKey) return;
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      const comment = await addComment(projectId, stageKey, body);
      // Append the server's row, never our draft: `createdAt` and the author are
      // ITS answer, and echoing our own copy would show a comment that differs
      // from the one everyone else will read.
      setView((prev) => (prev ? { ...prev, comments: [...prev.comments, comment] } : prev));
      setDraft('');
    } catch (e) {
      setError(e instanceof WorkspaceError ? e.message : 'That comment did not go through. Try again.');
    } finally {
      setSending(false);
    }
  }, [draft, projectId, stageKey]);

  const upload = useCallback(async (file: File) => {
    if (!stageKey) return;
    setUploading(true);
    setError(null);
    try {
      const attachment = await uploadAttachment(projectId, stageKey, file);
      setView((prev) => (prev ? { ...prev, attachments: [...prev.attachments, attachment] } : prev));
    } catch (e) {
      setError(e instanceof WorkspaceError ? e.message : 'That file did not upload. Try again.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = ''; // same file twice must still fire
    }
  }, [projectId, stageKey]);

  // ── The unsaved state (contract: the rails anchor on a PERSISTED key) ──────
  if (!stageKey) {
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

            {view.attachments.length === 0 ? (
              <p className="tws-quiet">
                No files yet. Images, PDFs and office documents up to 10 MB.
              </p>
            ) : (
              <ul className="tws-filelist">
                {view.attachments.map((a) => (
                  <FileRow key={a.id} attachment={a} dir={dir} nowMs={nowMs} />
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
  const author = dir.get(comment.authorPartyId)
    ?? { partyId: comment.authorPartyId, name: UNKNOWN_PARTY, role: null };
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
        <p className="tws-comment-text">{comment.body}</p>
      </div>
    </li>
  );
}

function FileRow({
  attachment, dir, nowMs,
}: {
  attachment: AttachmentView;
  dir: Map<string, PartyRef>;
  nowMs: number;
}) {
  const uploader = dir.get(attachment.uploaderPartyId)
    ?? { partyId: attachment.uploaderPartyId, name: UNKNOWN_PARTY, role: null };
  return (
    <li className="tws-file">
      <a className="tws-filename" href={attachment.blobUrl} target="_blank" rel="noreferrer">
        {attachment.fileName}
      </a>
      <span className="tws-filemeta">
        {formatBytes(attachment.sizeBytes)} · {uploader.name} ·{' '}
        <time dateTime={attachment.createdAt} title={attachment.createdAt}>
          {relativeTime(attachment.createdAt, nowMs)}
        </time>
      </span>
    </li>
  );
}
