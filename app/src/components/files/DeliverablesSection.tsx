'use client';

// The Deliverables section of a task's Files tab (PRD-05 F-2, F-12..F-16; boards
// F1 TaskModel, F2 DocTask). What the task must hand over, each with its review
// state; "x of n approved"; the assignee submits a file version with a note; the
// client side approves or requests changes. Every "may I" comes from the server
// (`can_edit`, `can_submit`, `can_decide`); a refusal is shown as a sentence.
import { useState } from 'react';

import {
  addDeliverableAction, decideDeliverableAction, removeDeliverableAction,
} from '@/lib/v2/task-files-actions';
import type { DeliverableView, DeliverablesView } from '@/lib/v2/task-files-view';
import { Badge, FileTypeTag, shortDate } from './FileBits';

export function DeliverablesSection({
  taskId, view, orgName, onChanged, onSubmitFile,
}: {
  taskId: string;
  view: DeliverablesView;
  orgName: (id: string | null) => string | null;
  onChanged: () => void;
  /** Open the add-files dialog to hand a file in against this deliverable. */
  onSubmitFile: (deliverable: DeliverableView) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');

  async function act(fn: () => Promise<{ ok: boolean; message?: string }>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(res.message ?? 'That did not go through.');
      else { setComment(''); onChanged(); }
    } finally {
      setBusy(false);
    }
  }

  const hasAny = view.items.length > 0;
  if (!hasAny && !view.canEdit) {
    return (
      <section className="tfl-sec" aria-label="Deliverables">
        <h4 className="tfl-h">Deliverables <span className="tfl-note">· what this task must hand over</span></h4>
        <p className="tfl-note">Nothing to hand over is set on this task.</p>
      </section>
    );
  }

  return (
    <section className="tfl-sec" aria-label="Deliverables">
      {view.requiredCount > 0 ? (
        <div className="tfl-info" role="note">
          <span aria-hidden="true">ⓘ</span>
          <span>This task can only be marked done when every required deliverable is approved.</span>
        </div>
      ) : null}
      <div className="tfl-hd">
        <h4 className="tfl-h">
          Deliverables{view.progressLabel ? ` · ${view.progressLabel}` : ''}{' '}
          <span className="tfl-note">· what this task must hand over</span>
        </h4>
        {view.toReview > 0 ? <Badge tone="pending">{view.toReview} to review</Badge> : null}
      </div>
      {view.requiredCount > 0 ? (
        <div className="tfl-bar" role="progressbar" aria-valuenow={view.progressPct} aria-valuemin={0} aria-valuemax={100}
          aria-label={view.progressLabel ?? undefined}>
          <i style={{ width: `${view.progressPct}%` }} />
        </div>
      ) : null}
      {error ? <p role="alert" className="tfl-err">{error}</p> : null}

      {hasAny ? (
        <div className="tfl-card">
          {view.items.map((d) => {
            const open = openId === d.id && d.current != null;
            const cur = d.current;
            const meta = cur
              ? [cur.versionLabel, orgName(cur.submitterOrgId), shortDate(cur.submittedAt),
                d.status === 'approved' && cur.deciderOrgId ? `approved by ${orgName(cur.deciderOrgId) ?? 'the client'} ${shortDate(cur.decidedAt)}` : null,
                d.fromRfp ? 'required by the RFP scope' : null].filter(Boolean).join(' · ')
              : [d.required ? 'Required' : 'Optional', d.due ? `due ${shortDate(d.due)}` : null, d.fromRfp ? 'from the RFP scope' : null]
                .filter(Boolean).join(' · ');
            return (
              <div key={d.id} className={`frow${open ? ' is-open' : ''}`}>
                <FileTypeTag type={cur ? cur.fileType : 'other'} tag={cur ? cur.tag : '—'} />
                <button type="button" className="tfl-linkbtn frow-name" aria-expanded={open}
                  onClick={() => setOpenId(open ? null : d.id)} disabled={!cur}>
                  {d.title}
                </button>
                <Badge tone={d.tone}>{d.stateLabel}</Badge>
                {open && cur ? (
                  <span className="frow-body">
                    <span className="tfl-note">
                      Submitted {shortDate(cur.submittedAt)} by {orgName(cur.submitterOrgId) ?? 'the assignee'}
                      {cur.note ? ` · “${cur.note}”` : ''}
                      {d.earlier.find((e) => e.status === 'changes_requested')
                        ? ` · ${d.earlier.find((e) => e.status === 'changes_requested')!.versionLabel} sent back` : ''}
                    </span>
                    {cur.decisionComment ? <span className="tfl-note">Review: “{cur.decisionComment}”</span> : null}
                    <span className="tfl-note" title={cur.sha256}>File hash {cur.sha256.slice(0, 12)}…</span>
                    <span className="frow-actions">
                      <a className="btn sm" href={cur.downloadPath} target="_blank" rel="noreferrer">Open</a>
                      {d.canDecide ? (
                        <>
                          <input className="tfl-input" placeholder="Comment (required to send back)" value={comment}
                            maxLength={2000} onChange={(e) => setComment(e.target.value)} aria-label="Review comment" />
                          <span className="grow" />
                          <button type="button" className="btn sm reject" disabled={busy || !comment.trim()}
                            onClick={() => act(() => decideDeliverableAction(d.id, 'request-changes', comment))}>
                            Request changes
                          </button>
                          <button type="button" className="btn sm approve" disabled={busy}
                            onClick={() => act(() => decideDeliverableAction(d.id, 'approve', comment || null))}>
                            Approve {cur.versionLabel}
                          </button>
                        </>
                      ) : null}
                    </span>
                  </span>
                ) : (
                  <span className="meta">
                    {meta}
                    {view.canSubmit && d.status !== 'approved' ? (
                      <>{' · '}<button type="button" className="tfl-linkbtn" onClick={() => onSubmitFile(d)}>
                        {d.status === 'not_yet' ? 'Submit a file' : 'Submit a new file'}
                      </button></>
                    ) : null}
                    {view.canEdit && d.status === 'not_yet' ? (
                      <>{' · '}<button type="button" className="tfl-linkbtn" disabled={busy}
                        onClick={() => act(() => removeDeliverableAction(d.id))}>Remove</button></>
                    ) : null}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {view.canEdit ? (adding ? (
        <form className="tfl-inline" onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          void act(async () => {
            const res = await addDeliverableAction(taskId, title.trim(), true);
            if (res.ok) { setTitle(''); setAdding(false); }
            return res;
          });
        }}>
          <input className="tfl-input" autoFocus value={title} maxLength={300} placeholder="e.g. As-built gutter layout"
            aria-label="Deliverable title" onChange={(e) => setTitle(e.target.value)} />
          <button type="submit" className="btn sm primary" disabled={busy || !title.trim()}>Add</button>
          <button type="button" className="btn sm" onClick={() => setAdding(false)}>Cancel</button>
        </form>
      ) : (
        <button type="button" className="btn sm" style={{ alignSelf: 'flex-start', borderStyle: 'dashed' }}
          onClick={() => setAdding(true)}>＋ Required deliverable</button>
      )) : null}
      <p className="tfl-note">
        Approving signs off that version on the record — who, when, which file hash. A new version after approval goes back to review.
      </p>
    </section>
  );
}
