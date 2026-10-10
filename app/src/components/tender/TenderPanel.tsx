'use client';

// The Tender tab of the docked task panel (PRD-02, D-42): compose → review &
// send → follow → compare & award, all beside the plan (no modal, no dimmed
// grid). One container over the shared step components; the full workspace
// (TenderWorkspace) is the other. Writes go through the same server actions as
// the workspace, so an award here produces the same events and records.

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { loadComposerAction } from '../procurement-actions';
import { isLanded, panelFace, type PanelFace } from '@/lib/v2/tender-flow-view';
import type { V2Rfp } from '@/lib/v2/tendering-view';
import { rfpPath, tenderingPath } from '@/lib/v2/tendering-home-view';
import { CancelledBanner, TenderStepper } from './TenderBits';
import { TenderComposer } from './TenderComposer';
import { TenderCompare } from './TenderCompare';
import { TenderFollow } from './TenderFollow';
import { useRfpWindow, useTenderFollow } from './hooks';
import type { TaskOption } from './types';
import './tender.css';

export type WorkspaceSection = 'overview' | 'proposals' | 'matrix' | 'files' | 'emailed' | 'clarifications';
export type PanelCounts = { invited?: number; submitted?: number; awardedTo?: string | null; openQuestions?: number };

export function TenderPanel({
  projectId, taskId, taskName, rfp, tasks, canIssue, saved, todayIso,
  onRfpChanged, onOpenWorkspace, onFaceChange, openQuestions = 0,
}: {
  projectId: string;
  taskId: string;
  taskName: string;
  /** The tender that governs this task, or null. */
  rfp: V2Rfp | null;
  tasks: TaskOption[];
  canIssue: boolean;
  /** Whether the plan already holds this row (a real task id to tender over). */
  saved: boolean;
  todayIso: string;
  onRfpChanged: (rfp: V2Rfp, counts: PanelCounts) => void;
  onOpenWorkspace: (section?: WorkspaceSection) => void;
  /** The panel widens to 640px to compose and to compare (B2/B4). */
  onFaceChange?: (face: PanelFace) => void;
  /** Bidders' questions waiting for an answer (task-procurement, PRD-08 H-7). */
  openQuestions?: number;
}) {
  const [composing, setComposing] = useState(false);
  // A fresh composer per attempt; a save that turns "new" into a draft keeps it mounted.
  const [attempt, setAttempt] = useState(0);
  const live = rfp && !(composing && rfp.status === 'cancelled') ? rfp : null;
  const face: PanelFace = composing && (!rfp || rfp.status === 'cancelled') ? 'compose' : panelFace(live);
  useEffect(() => { onFaceChange?.(face); }, [face, onFaceChange]);
  useEffect(() => { setComposing(false); }, [taskId]);

  const following = face === 'follow' || face === 'compare' || face === 'cancelled' ? live : null;
  const follow = useTenderFollow(following);
  const { window } = useRfpWindow(projectId, following);

  // Keep the grid chip's counts in step with what the panel just read.
  const lanes = follow.data?.lanes ?? [];
  const invited = follow.data?.recipients.length;
  const submitted = lanes.filter(isLanded).length;
  const winner = lanes.find((l) => l.status === 'awarded');
  useEffect(() => {
    if (following && follow.data) {
      onRfpChanged(following, { invited, submitted, awardedTo: winner ? winner.bidder.name ?? winner.bidder.email : null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow.data]);

  if (face === 'none') {
    if (!canIssue) {
      return (
        <div className="tnd">
          <p className="tnd-note">No tender on this task. Only a team member who can issue tenders can start one.</p>
          <Link className="tnd-link" href={tenderingPath(projectId)}>Open in all tenders →</Link>
        </div>
      );
    }
    return (
      <div className="tnd">
        <button type="button" className="tnd-cta" disabled={!saved} onClick={() => setComposing(true)}>
          <span className="tnd-cta-icon" aria-hidden="true">⤴</span>
          <span>
            <b>Request proposals</b>
            <span>{saved
              ? 'Prepare an RFP here, prefilled from this task. Private until you send it.'
              : 'Save the plan first — this task needs an id before it can go out to tender.'}</span>
          </span>
        </button>
      </div>
    );
  }

  if (face === 'compose') {
    return (
      <TenderComposer
        key={`${taskId}:${attempt}`}
        projectId={projectId} taskId={taskId} taskName={taskName} tasks={tasks}
        rfp={live && live.status === 'draft' ? live : null} variant="panel"
        onChanged={(next, c) => onRfpChanged(next, { invited: c.invited })}
        onSent={(next, c) => { setComposing(false); onRfpChanged(next, { invited: c.invited, submitted: 0 }); }}
        onDiscarded={(gone) => { setComposing(false); setAttempt((n) => n + 1); if (gone) onRfpChanged(gone, {}); }}
      />
    );
  }

  if (!live) return null;
  const reread = async () => {
    const d = await loadComposerAction(live.id);
    if (d) onRfpChanged(d.rfp, {});
    await follow.reload();
  };

  if (face === 'cancelled') {
    return (
      <div className="tnd">
        <TenderStepper rfp={live} proposalsIn={submitted} />
        <CancelledBanner rfp={live} />
        {canIssue ? (
          <button type="button" className="tnd-cta" onClick={() => { setAttempt((n) => n + 1); setComposing(true); }}>
            <span className="tnd-cta-icon" aria-hidden="true">⤴</span>
            <span><b>Request proposals again</b><span>Start a new tender for this task. The cancelled one stays on the record.</span></span>
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="tnd">
      {follow.error ? <p className="tnd-err" role="alert">{follow.error}</p> : null}
      {canIssue && openQuestions > 0 ? (
        <Link className="tnd-link" href={`${rfpPath(projectId, live.id)}?tab=clarifications`}>
          {openQuestions} {openQuestions === 1 ? 'question' : 'questions'} from bidders to answer →
        </Link>
      ) : null}
      {face === 'follow' ? (
        <TenderFollow
          rfp={live} data={follow.data} window={window} taskName={taskName} todayIso={todayIso}
          canIssue={canIssue} onRfpChanged={(next) => onRfpChanged(next, {})} onReload={follow.reload}
        />
      ) : (
        <TenderCompare
          rfp={live} data={follow.data} window={window} taskName={taskName} canIssue={canIssue}
          onAwarded={() => void reread()}
        />
      )}
      <div className="tnd-foot">
        {face === 'compare' ? (
          <>
            <button type="button" className="tnd-link" onClick={() => onOpenWorkspace('matrix')}>Line-by-line matrix →</button>
            {follow.data && !follow.data.seesMoney ? <span className="tnd-note">Amounts need the money permission.</span> : null}
          </>
        ) : (
          <button type="button" className="tnd-link" onClick={() => onOpenWorkspace('overview')}>Open the full tender →</button>
        )}
        {/* PRD-08 H-4: the tender at its own, shareable address. */}
        <Link className="tnd-link" href={rfpPath(projectId, live.id)}>Open in all tenders →</Link>
      </div>
    </div>
  );
}
