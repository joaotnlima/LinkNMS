'use client';

// PRD-10 — the task panel's "Run" block on a leaf task:
//   E-5  what the task waits on, each predecessor with its state; starting
//        ahead of them asks for a reason, which goes on the record (D-48:
//        warn and record — the server asks, this only words it);
//   E-6  the acceptance checklist; closing records which criteria were met
//        (design tasks keep their deliverables gate in the Files tab, PRD-05);
//   E-9  what the daily log says about this task (work, issues, photos).
// Every rule is the planning module's: this renders its answers and posts the
// person's choice.
import { useCallback, useEffect, useState } from 'react';

import { closeTaskAction, loadTaskRunAction, startTaskAction } from '@/lib/v2/execution-actions';
import {
  dayWords, entryLine, startNeedsReason, statusWord, toWaitingLines,
} from '@/lib/v2/execution-view';
import { taskDocumentDownloadPath, versionRefOf } from '@/lib/v2/task-workspace-view';
import type { TaskRun } from '@/lib/v2/execution';
import './site.css';

export function TaskRunSection({ taskId, onChanged }: { taskId: string; onChanged: () => void }) {
  const [view, setView] = useState<TaskRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [askReason, setAskReason] = useState(false);
  const [met, setMet] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await loadTaskRunAction(taskId);
    if (res.ok) { setView(res.value); setError(null); } else setError(res.message);
  }, [taskId]);
  useEffect(() => { setView(null); setReason(''); setAskReason(false); setMet(new Set()); void load(); }, [load]);

  if (error && !view) return <p className="ste-quiet" role="alert">{error}</p>;
  if (!view) return <p className="ste-quiet" role="status">Loading what this task waits on…</p>;

  const waiting = toWaitingLines(view.waitingOn);
  const needsReason = startNeedsReason(view.waitingOn, view.status);
  const closed = view.status === 'done' || view.status === 'verified';

  const act = async (fn: () => Promise<{ ok: boolean; reason?: string | null; message?: string }>) => {
    setBusy(true);
    setError(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) { onChanged(); void load(); return; }
    if (res.reason === 'predecessors_open') setAskReason(true);
    setError(res.message ?? 'That did not go through.');
  };
  const start = () => act(() => startTaskAction(taskId, reason.trim() || null));
  const close = () => act(() => closeTaskAction(taskId, [...met], reason.trim() || null));

  return (
    <section className="ste-run" aria-label="Running this task">
      {waiting.length ? (
        <>
          <span className="pbx-drawer-label">Waits on</span>
          <ul className="ste-wait">
            {waiting.map((w) => (
              <li key={w.taskId} className={w.met ? 'is-met' : 'is-open'}>
                <span aria-hidden>{w.met ? '✓' : '○'}</span> {w.name} — {w.state}
                <span className="ste-quiet"> ({w.needs})</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {!closed && view.status === 'not_started' ? (
        <div className="ste-actions">
          {needsReason || askReason ? (
            <>
              <label className="pbx-drawer-label" htmlFor={`ste-reason-${taskId}`}>
                Starting before what it waits on — why? (goes on the record)
              </label>
              <textarea
                id={`ste-reason-${taskId}`} className="pbx-drawer-desc" maxLength={500} value={reason}
                placeholder="e.g. Conduits go in before the roof closes"
                onChange={(e) => setReason(e.target.value)}
              />
            </>
          ) : null}
          <button
            type="button" className="btn" disabled={busy || ((needsReason || askReason) && !reason.trim())}
            onClick={() => void start()}
          >
            {needsReason ? 'Start anyway' : 'Start'}
          </button>
        </div>
      ) : (
        <p className="ste-quiet">Status: {statusWord(view.status)}</p>
      )}

      {view.checklist.length ? (
        <>
          <span className="pbx-drawer-label">Acceptance criteria</span>
          <ul className="ste-check">
            {view.checklist.map((c) => (
              <li key={c}>
                <label>
                  <input
                    type="checkbox" disabled={closed || busy} checked={met.has(c)}
                    onChange={(e) => setMet((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(c); else next.delete(c);
                      return next;
                    })}
                  />
                  {' '}{c}
                </label>
              </li>
            ))}
          </ul>
          {!closed ? (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void close()}>
              Mark done · {met.size} of {view.checklist.length} met
            </button>
          ) : null}
        </>
      ) : null}

      {error ? <p className="ste-error" role="alert">{error}</p> : null}

      {view.log.length ? (
        <>
          <span className="pbx-drawer-label">From the daily log</span>
          <ul className="ste-log">
            {view.log.slice(0, 20).map((e) => (
              <li key={e.id}>
                <time dateTime={e.date}>{dayWords(e.date)}</time> · {entryLine(e)}
                {e.kind === 'photo' && e.document_id && e.version_no ? (
                  <> · <a href={taskDocumentDownloadPath(versionRefOf(e.document_id, e.version_no))} target="_blank" rel="noreferrer">open photo</a></>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
