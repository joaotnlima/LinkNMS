'use client';

// Small shared pieces of the tender flow (PRD-02): the composer's step card,
// the lifecycle stepper with dates, the critical-path alert and the cancelled
// banner. Used by both containers (panel and workspace) so the vocabulary and
// colours are the same wherever a tender is read (PRD-01 G-8).

import type { ReactNode } from 'react';

import type { LifecycleStep, StepState, V2TenderWindow } from '@/lib/v2/tender-flow-view';
import { cancelledLine, criticalNote, lifecycleSteps } from '@/lib/v2/tender-flow-view';
import type { V2Rfp } from '@/lib/v2/tendering-view';
import './tender.css';

/**
 * One composer step (T-8): open → its body; done → a one-line summary with
 * Edit; locked → greyed with a hint, not openable yet.
 */
export function StepCard({
  n, title, state, summary, caption, lockedHint, onEdit, children,
}: {
  n: number;
  title: string;
  state: StepState;
  summary?: string;
  caption?: string;
  lockedHint?: string;
  onEdit?: () => void;
  children?: ReactNode;
}) {
  return (
    <section className={`tnd-st is-${state}`} aria-label={`Step ${n}: ${title}`}>
      <div className="tnd-st-h">
        <span className="tnd-st-n" aria-hidden="true">{state === 'done' ? '✓' : n}</span>
        <b>{title}</b>
        {caption ? <span className="tnd-cap">{caption}</span> : null}
        {state === 'done' && onEdit ? (
          <button type="button" className="btn sm" onClick={onEdit} aria-label={`Edit ${title}`}>Edit</button>
        ) : null}
      </div>
      {state === 'open' ? <div className="tnd-st-b">{children}</div> : null}
      {state === 'done' && summary ? (
        <div className="tnd-st-b"><span className="tnd-st-sum">{summary}</span></div>
      ) : null}
      {state === 'locked' && lockedHint ? (
        <div className="tnd-st-b"><span className="tnd-st-sum">{lockedHint}</span></div>
      ) : null}
    </section>
  );
}

/** Draft → Out for bids → Comparing → Awarded, with the date of each (T-10). */
export function TenderStepper({ rfp, proposalsIn, winnerName }: {
  rfp: V2Rfp;
  proposalsIn: number;
  winnerName?: string | null;
}) {
  const steps: LifecycleStep[] = lifecycleSteps(rfp, { proposalsIn, winnerName });
  return (
    <ol className="tnd-lc" aria-label="Tender lifecycle">
      {steps.map((s) => (
        <li key={s.label} className={`is-${s.state}`} aria-current={s.state === 'now' ? 'step' : undefined}>
          <b>{s.label}</b>
          <span>{s.sub}</span>
        </li>
      ))}
    </ol>
  );
}

/** The critical-path alert with planning's award-by date (T-5, T-13). */
export function CriticalAlert({ window, taskName, phase }: {
  window: V2TenderWindow | null;
  taskName: string;
  phase: 'compose' | 'follow' | 'award';
}) {
  const text = criticalNote(window, taskName, phase);
  if (!text) return null;
  return (
    <div className="tnd-cp" role="note">
      <span className="tnd-crit" aria-hidden="true">◆</span>
      <span>{text}</span>
    </div>
  );
}

/** T-19: Cancelled, said in words with its reason line. */
export function CancelledBanner({ rfp }: { rfp: V2Rfp }) {
  return (
    <div className="tnd-cancelled" role="status">
      {cancelledLine(rfp)}
    </div>
  );
}
