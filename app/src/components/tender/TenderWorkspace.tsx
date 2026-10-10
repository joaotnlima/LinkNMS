'use client';

// The full tender workspace (PRD-02, D-42): the redesigned LINA-420 modal and
// the /plan/procurement detail. The SAME step components as the docked panel —
// composer, follow, side-by-side compare & award — plus the room the panel
// does not have: the proposals inbox with shortlist and the Compare drill-down,
// the line-by-line matrix, every file, the emailed bids still to record, and
// the clarifications placeholder. Sections replace the old single long form.

import { useState } from 'react';

import { loadComposerAction } from '../procurement-actions';
import { CompareSurface } from './CompareViews';
import { ProposalsInbox } from './ProposalsInbox';
import { CancelledBanner, TenderStepper } from './TenderBits';
import { TenderComposer } from './TenderComposer';
import { TenderCompare } from './TenderCompare';
import { TenderFollow } from './TenderFollow';
import { ClarificationsSection, EmailedBidsSection, FilesSection } from './WorkspaceSections';
import { useRfpWindow, useTenderFollow } from './hooks';
import type { WorkspaceSection } from './TenderPanel';
import type { TaskOption } from './types';
import { isLanded } from '@/lib/v2/tender-flow-view';
import { rfpStatusBadge, type RfpMode, type V2Rfp } from '@/lib/v2/tendering-view';
import './tender.css';

const SECTIONS: Array<[WorkspaceSection, string]> = [
  ['overview', 'Overview'], ['proposals', 'Proposals'], ['matrix', 'Line-by-line matrix'],
  ['files', 'Files'], ['emailed', 'Emailed bids'], ['clarifications', 'Clarifications'],
];

export function TenderWorkspace({
  projectId, rfp, seedTaskId = null, tasks, initialSection = 'overview', initialCompare = null,
  initialMode = 'detailed', todayIso, onRfpChanged, onBack = null,
}: {
  projectId: string;
  /** The tender, or null to compose a new one. */
  rfp: V2Rfp | null;
  /** For a new tender: the task it starts from (else the issuer picks one). */
  seedTaskId?: string | null;
  tasks: TaskOption[];
  initialSection?: WorkspaceSection;
  initialCompare?: string | null;
  initialMode?: RfpMode;
  todayIso: string;
  onRfpChanged: (rfp: V2Rfp) => void;
  onBack?: (() => void) | null;
}) {
  const [section, setSection] = useState<WorkspaceSection>(rfp && rfp.status !== 'draft' ? initialSection : 'overview');
  const [rootPick, setRootPick] = useState<string>(seedTaskId ?? '');
  const [error, setError] = useState<string | null>(null);
  const sent = rfp !== null && rfp.status !== 'draft';
  const follow = useTenderFollow(sent ? rfp : null);
  const { window } = useRfpWindow(projectId, sent ? rfp : null);
  const lanes = follow.data?.lanes ?? [];
  const landed = lanes.filter(isLanded);
  const awaiting = lanes.filter((l) => l.status === 'invited' || l.status === 'draft').length;
  const rootId = rfp?.root_task_ids[0] ?? rootPick;
  const taskName = tasks.find((t) => t.id === rootId)?.name?.trim() || rfp?.title || 'this task';
  const badge = rfp ? rfpStatusBadge(rfp.status) : { label: 'New', tone: 'quiet' };
  const count: Partial<Record<WorkspaceSection, number>> = sent
    ? { proposals: landed.length, emailed: awaiting, files: landed.reduce((n, l) => n + l.document_count, 0) } : {};

  return (
    <div className="tnd" aria-label="Tender workspace">
      <header className="tnd-ws-hd">
        {onBack ? <button type="button" className="btn sm" onClick={onBack}>← All tenders</button> : null}
        <h3>{rfp?.title ?? 'New request for proposals'}</h3>
        <span className={`tnd-badge ${badge.tone === 'quiet' ? '' : badge.tone}`}>{badge.label}</span>
      </header>
      {error ? <p className="tnd-err" role="alert">{error}</p> : null}

      <div className="tnd-ws">
        <nav className="tnd-ws-nav" aria-label="Tender sections">
          {SECTIONS.map(([key, label]) => (
            <button key={key} type="button" aria-current={section === key ? 'page' : undefined}
              disabled={!sent && key !== 'overview' && key !== 'files'}
              title={!sent && key !== 'overview' && key !== 'files' ? 'Available once the tender is sent' : undefined}
              onClick={() => setSection(key)}>
              <span>{label}</span>
              {count[key] ? <span className="n">{count[key]}</span> : null}
            </button>
          ))}
        </nav>

        <div className="tnd-ws-main">
          {section === 'overview' && (!rfp || rfp.status === 'draft') ? (
            rootId ? (
              <TenderComposer
                projectId={projectId} taskId={rootId} taskName={taskName} tasks={tasks}
                rfp={rfp} initialMode={initialMode} variant="workspace"
                onChanged={(next) => onRfpChanged(next)} onSent={(next) => onRfpChanged(next)}
                onDiscarded={(gone) => { if (gone) onRfpChanged(gone); else onBack?.(); }}
              />
            ) : (
              <label className="tnd-field">
                <span className="tnd-label">Which task goes out to tender?</span>
                <select className="tnd-input" value={rootPick} onChange={(e) => setRootPick(e.target.value)}>
                  <option value="">Pick a task from the plan…</option>
                  {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                {tasks.length === 0 ? <span className="tnd-note">This plan has no tasks yet — author the plan first.</span> : null}
              </label>
            )
          ) : null}

          {section === 'overview' && rfp && rfp.status === 'published' ? (
            <TenderFollow rfp={rfp} data={follow.data} window={window} taskName={taskName} todayIso={todayIso}
              canIssue onRfpChanged={onRfpChanged} onReload={follow.reload} />
          ) : null}
          {section === 'overview' && rfp && (rfp.status === 'closed' || rfp.status === 'awarded') ? (
            <TenderCompare rfp={rfp} data={follow.data} window={window} taskName={taskName} canIssue
              onAwarded={() => {
                // awardRfp answers with the contract draft: re-read the RFP itself.
                void loadComposerAction(rfp.id).then((d) => { if (d) onRfpChanged(d.rfp); });
                void follow.reload();
              }} />
          ) : null}
          {section === 'overview' && rfp && rfp.status === 'cancelled' ? (
            <>
              <TenderStepper rfp={rfp} proposalsIn={landed.length} />
              <CancelledBanner rfp={rfp} />
            </>
          ) : null}

          {section === 'proposals' && rfp && sent ? (
            <ProposalsInbox key={`${rfp.id}:${rfp.status}`} rfp={rfp} recipients={follow.data?.recipients ?? []}
              initialCompare={initialCompare} onError={setError} onRfpChanged={onRfpChanged} />
          ) : null}

          {section === 'matrix' && rfp && sent ? (
            landed.length === 0 ? <p className="tnd-note">No bid has come in yet.</p> : (
              <CompareSurface rfp={rfp} inbox={follow.data} comparedLanes={landed}
                seesMoney={follow.data?.seesMoney ?? false} decided picked={rfp.awarded_proposal_id ?? null}
                onPick={() => { /* award from Overview or Proposals */ }}
                onBack={() => setSection('proposals')}
                award={<p className="tnd-note">Pick and award from the Overview or Proposals.</p>} />
            )
          ) : null}

          {section === 'files' && rfp ? <FilesSection rfp={rfp} lanes={lanes} /> : null}
          {section === 'files' && !rfp ? <p className="tnd-note">Save the scope first; then attach the model here.</p> : null}
          {section === 'emailed' && rfp ? (
            <EmailedBidsSection rfp={rfp} lanes={lanes} onRecorded={() => { void follow.reload(); }} />
          ) : null}
          {section === 'clarifications' ? <ClarificationsSection /> : null}
        </div>
      </div>
    </div>
  );
}
