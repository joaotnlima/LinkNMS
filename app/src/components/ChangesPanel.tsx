'use client';

// PRD-13 B8 — "Changes since baseline" (S-15) and the shared change line the
// task panel lists too (S-13/S-14). Every entry is a Variation (doc 05 §6) read
// from the server, already projected for this viewer: whether they saw it,
// whether they may acknowledge it. Acknowledging records who/when; asking opens
// a question to the responsible party. Nothing here gates the work (D-23), and
// the change-order link stays hidden while PRD-11 is parked (D-50).
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  acknowledgeChangeV2, acknowledgeChangesV2, askAboutChangeV2, listChangesV2,
} from '@/lib/v2/plan-changes';
import {
  dayMonth, deltaWord, filterChanges, stamp,
  type ChangeFilter, type ChangeItem, type PlanSlipView,
} from '@/lib/v2/slip-view';
import './plan-slip.css';

/** One change, with its two owner actions (S-14). */
export function ChangeEntry({
  item, outlineOf, addresseeOrgId, onChanged, onOpenTask, showTask = false,
}: {
  item: ChangeItem;
  outlineOf: (taskId: string) => string | null;
  /** The responsible party a question is addressed to (the row's owner). */
  addresseeOrgId: string | null;
  onChanged: () => void;
  onOpenTask?: (taskId: string) => void;
  showTask?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const delta = deltaWord(item.deltaWd);

  const acknowledge = async () => {
    setBusy(true);
    const res = await acknowledgeChangeV2(item.id);
    setBusy(false);
    if (!res.ok) { setNote(res.message || 'That did not go through.'); return; }
    onChanged();
  };
  const ask = async () => {
    if (!question.trim()) return;
    setBusy(true);
    const res = await askAboutChangeV2(item.id, question.trim(), addresseeOrgId);
    setBusy(false);
    if (!res.ok) { setNote(res.message || 'The question did not go through.'); return; }
    setAsking(false);
    setQuestion('');
    setNote('Question sent — it opens on the task’s conversation.');
  };

  const outline = outlineOf(item.taskId);
  const cause = item.causeTaskId ? (outlineOf(item.causeTaskId) ?? 'a linked task') : null;
  return (
    <li className="slp-vchg">
      <span className={`slp-vdot${item.seen ? ' is-seen' : ''}`} aria-hidden />
      <div className="slp-vbody">
        <p className="slp-vwhat">
          {showTask ? <strong>{outline ? `${outline} ` : ''}{item.taskName} · </strong> : null}
          {item.what}
          {delta ? <span className={`slp-dlt is-${delta.tone}`}> {delta.text}</span> : null}
          {item.closedLate ? <span className="slp-vmeta"> · closed late</span> : null}
        </p>
        {item.propagated ? (
          <p className="slp-vmeta">Pushed by {cause ?? 'a linked task'}; nobody edited this row.</p>
        ) : (
          <p className="slp-vmeta">
            {item.who ?? 'Someone'} · {stamp(item.at)}
            {item.reason ? <> · <q>{item.reason}</q></> : null}
          </p>
        )}
        <p className="slp-vmeta">
          {item.seen
            ? 'Seen by you'
            : item.canAcknowledge ? 'Not acknowledged by you yet' : `${item.acknowledgements} acknowledgement${item.acknowledgements === 1 ? '' : 's'}`}
        </p>
        <div className="slp-vacts">
          {item.canAcknowledge && !item.seen ? (
            <button type="button" className="slp-btn is-primary" disabled={busy} onClick={() => void acknowledge()}>
              Acknowledge
            </button>
          ) : null}
          <button type="button" className="slp-btn" disabled={busy} onClick={() => setAsking((v) => !v)}>
            Ask a question
          </button>
          {onOpenTask ? (
            <button type="button" className="slp-btn is-link" onClick={() => onOpenTask(item.taskId)}>Open task</button>
          ) : null}
        </div>
        {asking ? (
          <div className="slp-ask">
            <label className="slp-label" htmlFor={`ask-${item.id}`}>Your question to the responsible party</label>
            <textarea
              id={`ask-${item.id}`} className="slp-why" rows={2} maxLength={8000} value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <div className="slp-vacts">
              <button type="button" className="slp-btn" onClick={() => setAsking(false)}>Cancel</button>
              <button type="button" className="slp-btn is-primary" disabled={busy || !question.trim()} onClick={() => void ask()}>
                Send question
              </button>
            </div>
          </div>
        ) : null}
        {note ? <p className="slp-vmeta" role="status">{note}</p> : null}
      </div>
    </li>
  );
}

/** S-15 — every live change since baseline, newest first, with view filters. */
export function ChangesPanel({
  projectId, slip, outlineOf, onClose, onOpenTask, onChanged,
}: {
  projectId: string;
  slip: PlanSlipView;
  outlineOf: (taskId: string) => string | null;
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
  /** After an acknowledgement: the parent re-reads the plan (header counts). */
  onChanged: () => void;
}) {
  const [items, setItems] = useState<ChangeItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ChangeFilter>('all');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await listChangesV2(projectId);
    if (res.ok) { setItems(res.value); setError(null); } else setError(res.message || 'Changes could not be read.');
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const changed = useCallback(() => { void load(); onChanged(); }, [load, onChanged]);
  const shown = useMemo(() => filterChanges(items ?? [], filter), [items, filter]);
  const unseenInView = shown.filter((c) => c.canAcknowledge && !c.seen);
  const count = (f: ChangeFilter) => filterChanges(items ?? [], f).length;
  const h = slip.handover;
  const net = deltaWord(h?.deltaWd ?? null);

  const acknowledgeAll = async () => {
    if (!unseenInView.length) return;
    setBusy(true);
    const res = await acknowledgeChangesV2(projectId, unseenInView.map((c) => c.id));
    setBusy(false);
    if (!res.ok) { setError(res.message || 'Those could not be acknowledged.'); return; }
    changed();
  };

  return (
    <aside className="pbx-drawer pbx-panel slp-panel" role="complementary" aria-label="Changes since baseline">
      <header className="pbx-drawer-hd">
        <div>
          <p className="pbx-drawer-eyebrow">Since baseline</p>
          <h2 className="pbx-drawer-title">Changes since baseline · {items?.length ?? slip.changes.total}</h2>
        </div>
        <div className="pbx-drawer-hdtools">
          <button type="button" className="pbx-icon" aria-label="Close changes" title="Close" onClick={onClose}>✕</button>
        </div>
      </header>

      <div className="slp-filters" role="tablist" aria-label="Filter changes">
        {(['all', 'unseen', 'time'] as ChangeFilter[]).map((f) => (
          <button
            key={f} type="button" role="tab" aria-selected={filter === f}
            className={`slp-chip${filter === f ? ' is-on' : ''}`} onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All' : f === 'unseen' ? 'Not seen' : 'Time'} {count(f)}
          </button>
        ))}
      </div>

      {h?.baselineFinish ? (
        <p className="slp-net">
          Net effect on Handover <strong>{dayMonth(h.baselineFinish)} → {dayMonth(h.projectedFinish)}</strong>
          {net ? <span className={`slp-dlt is-${net.tone}`}> · {net.text}</span> : null}
        </p>
      ) : null}

      {error ? <p role="alert" className="pbx-open">{error}</p> : null}
      {items == null && !error ? <p className="slp-vmeta">Reading the changes…</p> : null}
      {items && !shown.length ? <p className="slp-vmeta">Nothing here — the plan is on its baseline for this view.</p> : null}

      <ul className="slp-vlist">
        {shown.map((c) => (
          <ChangeEntry
            key={c.id} item={c} outlineOf={outlineOf} showTask
            addresseeOrgId={slip.byTask[c.taskId]?.ownerOrgId ?? null}
            onChanged={changed} onOpenTask={onOpenTask}
          />
        ))}
      </ul>

      <p className="slp-note">
        Every entry is a change recorded against the baseline; each opens its task on the plan.
        Acknowledging records that you saw it — nothing waits for approval.
      </p>
      <footer className="slp-foot">
        <span>{unseenInView.length} not seen by you</span>
        <button
          type="button" className="slp-btn is-primary" disabled={busy || unseenInView.length === 0}
          onClick={() => void acknowledgeAll()}
        >Acknowledge all in view</button>
      </footer>
    </aside>
  );
}
