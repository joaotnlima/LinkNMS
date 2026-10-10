'use client';

// The task drawer's "Tender" tab (LINA-420) — the compact tender summary the
// owner reads without leaving the plan. The design (ticket mockup, Roofing task
// out for bids) is a SUMMARY, not the full inbox: a lifecycle wizard, the key
// dates, a critical-path warning when the task drives the finish, the bidders
// with their engagement state, and the submitted proposals. Every deep action
// (invite, compare, award) opens the in-place tender modal (ProcurementSection)
// which owns those writes — this tab never forks that logic. The one write it
// does own is "Close bidding now": a single, reversible-by-support state move
// that reads naturally here and updates optimistically in place (no navigation,
// so the plan editor's unsaved draft is never blown away — LINA-404).
//
// Data: the summary (lifecycle/dates/counts) is already on the plan page's
// `procurement` + `tenderInitialRfps` props — zero fetch. The bidders and
// proposals need the per-RFP read, so they load on mount via the same server
// actions the modal uses (loadComposerAction → recipients, loadInboxAction →
// lanes). A viewer without `org:money:view` simply sees "—" for every figure
// (the money gate doing its job), never a fabricated zero.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { closeRfpAction, loadComposerAction, loadInboxAction } from './procurement-actions';
import {
  formatMoney, leadTimeWeeks, proposalStatusBadge, recipientStatusBadge,
  type V2ProposalLane, type V2Recipient, type V2Rfp,
} from '@/lib/v2/tendering-view';
import type { ProcurementRfp } from '@/lib/plan-gantt';
// Reuse the tender badge vocabulary (prc-badge tones) so a bidder's state reads
// identically here and in the full inbox. The pbx-tw-* layout lives in
// plan-build.css, which the drawer's host already loads.
import './procurement.css';

// ── Pure date helpers (the plan speaks 'YYYY-MM-DD' calendar days) ───────────

/** "20 Jan 2027" from a 'YYYY-MM-DD' day, or "—" when absent/unparseable. */
function fmtDay(day: string | null | undefined): string {
  if (!day) return '—';
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Whole days from today to `day` (negative = past). Null when unparseable. */
function daysUntil(day: string | null | undefined, todayIso: string): number | null {
  if (!day) return null;
  const a = new Date(`${day}T00:00:00`).getTime();
  const b = new Date(`${todayIso}T00:00:00`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86_400_000);
}

/** "in 6 days" / "today" / "2 days ago" — the deadline said relative to now. */
function duePhrase(n: number | null): string {
  if (n == null) return '';
  if (n === 0) return 'today';
  if (n > 0) return `in ${n} ${n === 1 ? 'day' : 'days'}`;
  const past = -n;
  return `${past} ${past === 1 ? 'day' : 'days'} ago`;
}

// ── The lifecycle wizard ──────────────────────────────────────────────────────

const STEPS = ['Draft', 'Out for bids', 'Comparing', 'Awarded'] as const;

/** Which wizard step a tender sits on, from its status and whether a bid landed. */
function stepIndex(status: V2Rfp['status'], submitted: number): number {
  switch (status) {
    case 'draft': return 0;
    case 'published': return submitted > 0 ? 2 : 1;
    case 'closed': return 2;
    case 'awarded': return 3;
    default: return 0;
  }
}

interface TenderData {
  recipients: V2Recipient[];
  lanes: V2ProposalLane[];
  seesMoney: boolean;
}

export interface TenderDrawerTabProps {
  taskName: string;
  /** The row's plan dates, 'YYYY-MM-DD' — for the "Plan dates" line. */
  taskStart?: string;
  taskEnd?: string;
  /** The live tender rooted on this task, or null when none has been raised. */
  rfp: V2Rfp | null;
  /** The plan-page summary for this task's window (status/opened/due/count). */
  proc?: ProcurementRfp;
  /** Whether this task drives the build's finish (CPM) — gates the warning. */
  onCriticalPath: boolean;
  /** Whether the viewer may issue tenders (`org:tendering:issue`). */
  canStartTender: boolean;
  /** Whether the plan already holds this row (a real task id to tender over). */
  saved: boolean;
  /** Open the in-place tender modal — fresh composer when no tender exists. */
  onStart: () => void;
  /** Open the in-place tender modal on the existing tender (inbox + compare). */
  onOpenFull: () => void;
  /** Today as 'YYYY-MM-DD', captured once by the parent (stable canvas). */
  todayIso: string;
}

export function TenderDrawerTab({
  taskName, taskStart, taskEnd, rfp, proc, onCriticalPath,
  canStartTender, saved, onStart, onOpenFull, todayIso,
}: TenderDrawerTabProps) {
  // The RFP status is held locally so "Close bidding now" reflects instantly
  // without a navigation (which would discard the editor's unsaved draft).
  const [status, setStatus] = useState<V2Rfp['status'] | null>(rfp?.status ?? null);
  const [data, setData] = useState<TenderData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setStatus(rfp?.status ?? null); }, [rfp?.id, rfp?.status]);

  // Load the bidders + proposals for the existing tender. The summary (dates,
  // step) needs no fetch; this read only fills the Bidders/Proposals sections.
  useEffect(() => {
    if (!rfp) { setData(null); return; }
    let live = true;
    setLoading(true);
    setErr(null);
    void (async () => {
      try {
        const [composer, inbox] = await Promise.all([
          loadComposerAction(rfp.id),
          loadInboxAction({ id: rfp.id, root_task_ids: rfp.root_task_ids }),
        ]);
        if (!live) return;
        setData({
          recipients: composer?.recipients ?? [],
          lanes: inbox.lanes,
          seesMoney: inbox.seesMoney,
        });
      } catch {
        if (live) setErr('Could not load the bidders. Open the full tender to retry.');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [rfp]);

  const closeBidding = useCallback(async () => {
    if (!rfp) return;
    setBusy(true);
    setErr(null);
    const res = await closeRfpAction(rfp.id);
    setBusy(false);
    if (res.ok) setStatus(res.data.status);
    else setErr(res.message);
  }, [rfp]);

  // Derived bidder views — computed before any early return so the hook order is
  // stable whether or not this task has a tender (rules of hooks).
  const laneByEmail = useMemo(() => {
    const m = new Map<string, V2ProposalLane>();
    for (const l of data?.lanes ?? []) {
      const e = l.bidder.email?.toLowerCase();
      if (e && !m.has(e)) m.set(e, l);
    }
    return m;
  }, [data]);
  const proposalsIn = useMemo(
    () => (data?.lanes ?? []).filter((l) => l.status === 'submitted' || l.status === 'shortlisted' || l.status === 'awarded'),
    [data],
  );

  // ── No tender yet: the first-class "Start tendering" entry ────────────────
  if (!rfp) {
    if (!canStartTender) {
      return (
        <p className="pbx-status-hint">
          No tender on this task. Only a team member who can issue tenders can start one.
        </p>
      );
    }
    return saved ? (
      <div className="pbx-drawer-actions-block" aria-label="Actions">
        <button type="button" className="pbx-tender-cta" onClick={onStart}>
          <span className="pbx-tender-cta-icon" aria-hidden="true">⤴</span>
          <span className="pbx-tender-cta-text">
            <span className="pbx-tender-cta-title">Start tendering</span>
            <span className="pbx-tender-cta-sub">
              Request proposals from external companies — opens right here, over the plan.
            </span>
          </span>
          <span className="pbx-tender-cta-go" aria-hidden="true">›</span>
        </button>
      </div>
    ) : (
      <p className="pbx-tender-cta is-waiting">
        <span className="pbx-tender-cta-icon" aria-hidden="true">⤴</span>
        <span className="pbx-tender-cta-text">
          <span className="pbx-tender-cta-title">Start tendering</span>
          <span className="pbx-tender-cta-sub">
            Save the plan first — this task needs an id before it can go out to tender.
          </span>
        </span>
      </p>
    );
  }

  // ── An existing tender: the summary ───────────────────────────────────────
  const liveStatus = status ?? rfp.status;
  const submitted = proc?.submittedCount ?? data?.lanes.filter((l) => l.status !== 'invited' && l.status !== 'declined' && l.status !== 'withdrawn').length ?? 0;
  const step = stepIndex(liveStatus, submitted);
  const dueDay = proc?.bidsDueDay ?? (rfp.submission_deadline ? rfp.submission_deadline.slice(0, 10) : undefined);
  const dueN = daysUntil(dueDay, todayIso);
  const covers = rfp.root_task_ids.length;
  const locked = liveStatus === 'published' && submitted === 0; // the schedule-lock window

  // Bidders = the invited recipients, each tagged with its engagement state and
  // (where a bid is in) the amount off the matching lane. Falls back to the
  // lanes themselves when a tender was seeded without a recipient row.
  const recipients = data?.recipients ?? [];

  return (
    <div className="pbx-tender-tab" aria-label="Tender summary">
      {/* Lifecycle wizard — where this tender is in Draft → Awarded. */}
      <ol className="pbx-tw-steps" aria-label="Tender lifecycle">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={`pbx-tw-step${i < step ? ' is-done' : ''}${i === step ? ' is-now' : ''}`}
            aria-current={i === step ? 'step' : undefined}
          >
            <span className="pbx-tw-step-bar" aria-hidden="true" />
            <span className="pbx-tw-step-label">{label}</span>
          </li>
        ))}
      </ol>

      {/* Key dates + scope. */}
      <dl className="pbx-tw-meta">
        <dt>Bids due</dt>
        <dd>
          {fmtDay(dueDay)}
          {dueN != null ? <span className="pbx-tw-due"> · {duePhrase(dueN)}</span> : null}
        </dd>
        <dt>Covers</dt>
        <dd>
          {covers <= 1 ? taskName : `${taskName} + ${covers - 1} ${covers - 1 === 1 ? 'sub-task' : 'sub-tasks'}`}
        </dd>
        <dt>Plan dates</dt>
        <dd>
          {taskStart || taskEnd ? `${fmtDay(taskStart)} → ${fmtDay(taskEnd)}` : '—'}
          {locked ? <span className="pbx-tw-due"> · locked until a bid is chosen</span> : null}
        </dd>
      </dl>

      {/* Critical-path warning — this task drives the build's finish (CPM). */}
      {onCriticalPath ? (
        <div className="pbx-tw-crit" role="note">
          <span className="pbx-tw-crit-dot" aria-hidden="true">◆</span>
          <span>
            On the critical path. Awarding late pushes the build’s finish date — decide as
            soon as you have enough bids.
          </span>
        </div>
      ) : null}

      {/* Bidders — the invited contacts and where each stands. */}
      <div className="pbx-tw-sect">
        <div className="pbx-tw-sect-hd">
          <p className="pbx-drawer-sectlabel">Bidders{recipients.length ? ` (${recipients.length})` : ''}</p>
          {canStartTender ? (
            <button type="button" className="pbx-tw-link" onClick={onOpenFull}>+ Invite more</button>
          ) : null}
        </div>
        {loading ? (
          <p className="pbx-status-hint" role="status">Loading bidders…</p>
        ) : recipients.length === 0 ? (
          <p className="pbx-status-hint">
            No one invited yet. Open the full tender to invite companies or record a bid that came in by email.
          </p>
        ) : (
          <ul className="pbx-tw-bidders">
            {recipients.map((r) => {
              const b = recipientStatusBadge(r.status);
              const lane = laneByEmail.get(r.email.toLowerCase());
              return (
                <li key={r.id} className="pbx-tw-bidder">
                  <span className="pbx-tw-bidder-email">{r.email}</span>
                  {lane?.total ? <span className="pbx-tw-bidder-amt">{formatMoney(lane.total)}</span> : null}
                  <span className={`prc-badge ${b.tone}`}>{b.label}</span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="pbx-status-hint">
          Got a bid by email or over the phone? Open the full tender to record it so it sits beside the online ones.
        </p>
      </div>

      {/* Proposals in — the bids that have actually landed. */}
      {proposalsIn.length > 0 ? (
        <div className="pbx-tw-sect">
          <p className="pbx-drawer-sectlabel">Proposals in</p>
          <ul className="pbx-tw-proposals">
            {proposalsIn.map((l) => {
              const pb = proposalStatusBadge(l.status);
              return (
                <li key={l.proposal_id} className="pbx-tw-proposal">
                  <div className="pbx-tw-proposal-top">
                    <span className="pbx-tw-proposal-name">{l.bidder.name || l.bidder.email}</span>
                    <span className="pbx-tw-proposal-amt">{formatMoney(l.total)}</span>
                  </div>
                  <div className="pbx-tw-proposal-sub">
                    <span>{leadTimeWeeks(l.duration_wd)}</span>
                    {l.document_count > 0 ? <span>· {l.document_count} {l.document_count === 1 ? 'file' : 'files'}</span> : null}
                    <span className={`prc-badge ${pb.tone}`}>{pb.label}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {err ? <p className="pbx-tw-err" role="alert">{err}</p> : null}

      {/* Footer — drop into the full compare/award surface, or close bidding. */}
      <div className="pbx-tw-foot">
        <button type="button" className="pbx-tw-link" onClick={onOpenFull}>
          {step >= 2 ? 'Compare & award →' : 'Open in all tenders →'}
        </button>
        {canStartTender && liveStatus === 'published' ? (
          <button type="button" className="btn primary" disabled={busy} onClick={() => void closeBidding()}>
            {busy ? 'Closing…' : 'Close bidding now'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
