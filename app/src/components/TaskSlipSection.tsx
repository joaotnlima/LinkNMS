'use client';

// PRD-13 B6/B7 — the task panel's Plan-tab block for changes against the baseline:
//   S-13  Baseline vs Now (dates, working days, delta) and "Changes on this task";
//   S-14  Acknowledge / Ask a question on each change (ChangeEntry);
//   S-12  the overdue prompt — "should have finished on {date}" → Mark done /
//         Set a new finish;
//   S-10  moving a finish shows, BEFORE saving, the working days vs baseline,
//         the linked tasks it pushes, the new handover and who is notified
//         (the server's :preview-move — dry maths, nothing written);
//   S-11  an optional "Why?" saved on the variation. No approval step (D-23);
//         the save is one D-26 field delta.
// All numbers come from the server; this component only words them.
import { useCallback, useEffect, useState } from 'react';

import {
  commitDatesV2, listChangesV2, markDoneV2, previewFinishV2,
} from '@/lib/v2/plan-changes';
import {
  baselineOrigin, dayMonth, dayMonthYear, deltaWord,
  type ChangeItem, type MoveImpact, type TaskSlip,
} from '@/lib/v2/slip-view';
import { ChangeEntry } from './ChangesPanel';
import './plan-slip.css';

export interface PendingMove { start: string; end: string }

export function TaskSlipSection({
  projectId, slip, outlineOf, isLeaf, pending, onClearPending, onCommitted, onChanged,
}: {
  projectId: string;
  slip: TaskSlip;
  outlineOf: (taskId: string) => string | null;
  isLeaf: boolean;
  /** Dates proposed by a drag or the panel's date inputs on a baselined row. */
  pending: PendingMove | null;
  onClearPending: () => void;
  /** After a server write that moved dates: the editor reloads the plan. */
  onCommitted: () => void;
  /** After an acknowledgement: refresh the header counts. */
  onChanged: () => void;
}) {
  const [changes, setChanges] = useState<ChangeItem[] | null>(null);
  const load = useCallback(async () => {
    const res = await listChangesV2(projectId, slip.id);
    setChanges(res.ok ? res.value : []);
  }, [projectId, slip.id]);
  useEffect(() => { void load(); }, [load]);

  const [editing, setEditing] = useState(false);
  const [finish, setFinish] = useState(slip.finish ?? '');
  const [start, setStart] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const [impact, setImpact] = useState<MoveImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [confirmNotOwner, setConfirmNotOwner] = useState(false);

  // A drag / date-input proposal opens the editor on those dates.
  useEffect(() => {
    if (!pending) return;
    setEditing(true);
    setFinish(pending.end);
    setStart(pending.start !== slip.start ? pending.start : null);
  }, [pending, slip.start]);
  useEffect(() => { setEditing(false); setImpact(null); setError(null); setWhy(''); }, [slip.id]);

  // S-10: the impact note, recomputed (debounced) as the date changes.
  useEffect(() => {
    if (!editing || !finish || finish === slip.finish && !start) { setImpact(null); return undefined; }
    const t = setTimeout(async () => {
      const res = await previewFinishV2(slip.id, finish, start ?? undefined);
      if (res.ok) { setImpact(res.value); setError(null); } else setError(res.message || 'The impact could not be computed.');
    }, 250);
    return () => clearTimeout(t);
  }, [editing, finish, start, slip.id, slip.finish]);

  const cancel = () => {
    setEditing(false); setImpact(null); setWhy(''); setStart(null); setFinish(slip.finish ?? '');
    setNeedsConfirm(false); setError(null); onClearPending();
  };
  const save = async () => {
    setBusy(true);
    const res = await commitDatesV2({
      taskId: slip.id, finish, baseFinish: slip.finish,
      ...(start ? { start, baseStart: slip.start } : {}),
      reason: why, confirmNotAssignee: confirmNotOwner,
    });
    setBusy(false);
    if (!res.ok) {
      if (res.errors?.confirm_not_assignee) { setNeedsConfirm(true); setError(res.errors.confirm_not_assignee); return; }
      setError(res.message || 'That did not save.');
      return;
    }
    onClearPending();
    onCommitted();
  };
  const markDone = async () => {
    setBusy(true);
    const res = await markDoneV2(slip.id);
    setBusy(false);
    if (!res.ok) { setError(res.message || 'That did not save.'); return; }
    onCommitted();
  };

  const b = slip.baseline;
  const delta = deltaWord(slip.deltaWd);
  const overdue = isLeaf && !slip.closed && (slip.overrunWd ?? 0) > 0;
  const canMove = slip.canEdit && isLeaf && !slip.closed;
  const changedByLabel = impact?.notify.length
    ? impact.notify.map((n) => `${n.name} (${n.role})`).join(', ')
    : null;

  return (
    <section className="slp-task" aria-label="Changes against the baseline">
      {overdue ? (
        <div className="slp-over" role="status">
          <p><strong>This task should have finished on {dayMonth(slip.finish)}.</strong></p>
          <p className="slp-vmeta">
            Until it is closed or given a new finish, the plan shows it running late up to today —
            {' '}{slip.overrunWd} working day{slip.overrunWd === 1 ? '' : 's'} so far — and everything linked after it
            shows as pushed (a projection; no other row is changed).
          </p>
          {canMove ? (
            <div className="slp-vacts">
              <button type="button" className="slp-btn is-primary" disabled={busy} onClick={() => void markDone()}>Mark done</button>
              <button type="button" className="slp-btn" disabled={busy} onClick={() => setEditing(true)}>Set a new finish</button>
            </div>
          ) : null}
        </div>
      ) : null}

      <dl className="slp-bvn">
        {b ? (
          <>
            <dt>Baseline</dt>
            <dd>{dayMonth(b.start)} → {dayMonthYear(b.finish)} <span className="slp-vmeta">· {baselineOrigin(b)}</span></dd>
          </>
        ) : null}
        <dt>Now</dt>
        <dd>
          {dayMonth(slip.start)} → {dayMonthYear(slip.finish)}
          {delta ? <span className={`slp-dlt is-${delta.tone}`}> {delta.text}</span> : null}
          {slip.projected ? (
            <span className="slp-vmeta">
              {' '}· pushed to {dayMonth(slip.projected.finish)} by {outlineOf(slip.projected.causeTaskId ?? '') ?? 'a late task'} (projection)
            </span>
          ) : null}
        </dd>
      </dl>

      {canMove && !editing && !overdue ? (
        <button type="button" className="slp-btn" onClick={() => setEditing(true)}>Change finish</button>
      ) : null}

      {editing ? (
        <div className="slp-edit">
          <label className="slp-label" htmlFor={`slp-fin-${slip.id}`}>New finish</label>
          <input
            id={`slp-fin-${slip.id}`} type="date" className="pbx-date" value={finish} min={start ?? slip.start ?? undefined}
            onChange={(e) => setFinish(e.target.value)}
          />
          {start ? <p className="slp-vmeta">The start moves to {dayMonth(start)} too.</p> : null}
          {impact ? (
            <div className="slp-before" role="status">
              <p className="slp-label">Before you save</p>
              <p>
                {impact.baselineDeltaWd != null
                  ? impact.baselineDeltaWd === 0
                    ? <>Puts the finish back on the baseline. </>
                    : <>Moves the finish {Math.abs(impact.baselineDeltaWd)} working day{Math.abs(impact.baselineDeltaWd) === 1 ? '' : 's'} {impact.baselineDeltaWd > 0 ? 'past' : 'before'} the baseline. </>
                  : null}
                {impact.pushes.length
                  ? <>It pushes {impact.pushes.map((p) => `${outlineOf(p.id) ?? ''} ${p.name}`.trim()).join(' and ')} (linked)</>
                  : <>It pushes no linked task</>}
                {impact.handoverMoves && impact.handoverAfter
                  ? <>, and Handover to <strong>{dayMonth(impact.handoverAfter)}</strong>.</>
                  : <>; Handover stays where it is.</>}
              </p>
              <p className="slp-vmeta">
                {changedByLabel
                  ? `${changedByLabel} ${impact.notify.length === 1 ? 'is' : 'are'} notified with this change. Edits within 15 minutes go out as one notification.`
                  : 'Nobody is notified — this task has no baseline.'}
              </p>
            </div>
          ) : null}
          <label className="slp-label" htmlFor={`slp-why-${slip.id}`}>Why? <span className="slp-vmeta">(optional, goes on the record)</span></label>
          <textarea
            id={`slp-why-${slip.id}`} className="slp-why" rows={2} maxLength={500} value={why}
            onChange={(e) => setWhy(e.target.value)}
          />
          {needsConfirm ? (
            <label className="slp-confirm">
              <input type="checkbox" checked={confirmNotOwner} onChange={(e) => setConfirmNotOwner(e.target.checked)} />
              {' '}I am not responsible for this task — save anyway
            </label>
          ) : null}
          {error ? <p role="alert" className="pbx-open">{error}</p> : null}
          <div className="slp-vacts">
            <button type="button" className="slp-btn" onClick={cancel}>Cancel</button>
            <button
              type="button" className="slp-btn is-primary"
              disabled={busy || !finish || (needsConfirm && !confirmNotOwner)}
              onClick={() => void save()}
            >Save new finish</button>
          </div>
          <p className="slp-note">
            There is no approval step: the plan changes when you save, drawn in clay against the baseline.
          </p>
        </div>
      ) : null}

      {b || (changes && changes.length) ? (
        <>
          <h3 className="slp-h">Changes on this task</h3>
          {changes == null ? <p className="slp-vmeta">Reading…</p> : null}
          {changes && !changes.length ? <p className="slp-vmeta">None — this task is on its baseline.</p> : null}
          <ul className="slp-vlist">
            {(changes ?? []).map((c) => (
              <ChangeEntry
                key={c.id} item={c} outlineOf={outlineOf} addresseeOrgId={slip.ownerOrgId}
                onChanged={() => { void load(); onChanged(); }}
              />
            ))}
          </ul>
          {b ? (
            <p className="slp-note">
              The change is already live in the plan — nothing waits for approval. Acknowledging records that you
              saw it (D-23).
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
