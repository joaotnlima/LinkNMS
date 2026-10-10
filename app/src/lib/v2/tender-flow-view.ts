// Pure view model of the tender FLOW — compose (3 steps), follow, compare &
// award — shared by its two containers: the docked task panel and the full
// tender workspace (PRD-02, D-42). Split from the I/O (`tender-flow.ts`,
// `server-only`) so every phrase and every state is unit-testable.
//
// What this file does NOT do (guardrail: no business rules in the app):
//   - it never computes a calendar, a critical path or an award-by date — those
//     come from planning's `getTenderWindow` and are only put into words here;
//   - it never ranks or averages bids (T-14): columns are laid side by side in
//     the order the bids arrived, figures exactly as quoted.

import { formatMoney } from './tendering-view.ts';
import type {
  RfpMode, RfpStatus, RfpVisibility, V2ProposalLane, V2Recipient, V2Rfp,
} from './tendering-view.ts';

// ── Wire: #/components/schemas/TenderWindow (planning) ──────────────────────

export interface V2LeftOut {
  task_id: string;
  name: string;
  reason: 'assigned' | string;
  assignee?: { org_id: string; name: string | null };
}

export interface V2TenderWindow {
  project_id: string;
  root_task_ids: string[];
  covered_task_ids: string[];
  left_out: V2LeftOut[];
  work_window: { start: string; finish: string; duration_wd: number } | null;
  on_critical_path: boolean;
  critical_task_ids: string[];
  project_finish?: string | null;
  mobilisation_lead_wd: number;
  award_by: string | null;
  bids_due?: string | null;
  wd_bids_due_to_start?: number | null;
  wd_bids_due_to_award_by?: number | null;
}

// ── Dates ────────────────────────────────────────────────────────────────────

function asDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "20 Jan 2027", or "—". */
export function fmtDay(value: string | null | undefined): string {
  const d = asDate(value);
  return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}

/** "20 Jan", or "—". */
export function fmtShort(value: string | null | undefined): string {
  const d = asDate(value);
  return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';
}

/** "20 Jan 2027, 18:00" — a bids-due instant in the viewer's clock. */
export function fmtDeadline(value: string | null | undefined): string {
  const d = asDate(value);
  if (!d) return '—';
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${fmtDay(value)}, ${time}`;
}

/** Whole calendar days from `todayIso` to the instant's day (negative = past). */
export function daysUntil(value: string | null | undefined, todayIso: string): number | null {
  const d = asDate(value?.slice(0, 10));
  const t = asDate(todayIso);
  if (!d || !t) return null;
  return Math.round((d.getTime() - t.getTime()) / 86_400_000);
}

/** "in 6 days" / "today" / "2 days ago". */
export function duePhrase(n: number | null): string {
  if (n == null) return '';
  if (n === 0) return 'today';
  if (n > 0) return `in ${n} ${n === 1 ? 'day' : 'days'}`;
  return `${-n} ${n === -1 ? 'day' : 'days'} ago`;
}

/** A `date` + `time` input pair → ISO instant (local clock), or '' when incomplete. */
export function deadlineFromInputs(day: string, time: string): string {
  if (!day) return '';
  const d = new Date(`${day}T${time || '18:00'}`);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** An ISO instant → the `date` and `time` inputs, in the viewer's clock. */
export function inputsFromDeadline(value: string | null | undefined): { day: string; time: string } {
  const d = asDate(value);
  if (!d) return { day: '', time: '18:00' };
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString();
  return { day: local.slice(0, 10), time: local.slice(11, 16) };
}

// ── Step 1 · Scope ───────────────────────────────────────────────────────────

export function modeLabel(mode: RfpMode): string {
  return mode === 'light' ? 'Light (design)' : 'Detailed (build)';
}

export function visibilityLabel(v: RfpVisibility): string {
  return v === 'open' ? 'open to the marketplace' : 'invite only';
}

/** "Roofing + 9 sub-tasks" from the covered rows (roots + kept descendants). */
export function coversLabel(taskName: string, coveredCount: number, rootCount = 1): string {
  const extra = Math.max(0, coveredCount - rootCount);
  if (extra === 0) return taskName;
  return `${taskName} + ${extra} ${extra === 1 ? 'sub-task' : 'sub-tasks'}`;
}

/** "Gutters & skylight — already assigned to Nuno Ferreira." (T-3) */
export function leftOutLine(row: V2LeftOut): string {
  if (row.reason === 'assigned') {
    return `${row.name} — already assigned to ${row.assignee?.name ?? 'another party'}.`;
  }
  return `${row.name} — ${row.reason}.`;
}

/** T-4: the plan's work window and what sending does to it. */
export function workWindowLine(w: V2TenderWindow | null): string {
  if (!w?.work_window) {
    return 'This task has no dates yet. Set them on the Plan tab so bidders know when the work is.';
  }
  return `Work window from the plan: ${fmtShort(w.work_window.start)} → ${fmtDay(w.work_window.finish)}. These dates lock while the tender is out.`;
}

/** One-line summary of a completed Scope step (T-8). */
export function scopeSummary(input: {
  mode: RfpMode; taskName: string; deadline: string | null | undefined; visibility: RfpVisibility;
}): string {
  return [
    modeLabel(input.mode), input.taskName, `bids due ${fmtDeadline(input.deadline)}`,
    visibilityLabel(input.visibility),
  ].join(' · ');
}

/**
 * T-5 / T-13: the critical-path alert, in the words of the step it sits in.
 * Null when no covered row is critical (or the plan has no dates to judge by).
 * Every number is planning's (`getTenderWindow`); this only phrases them.
 */
export function criticalNote(
  w: V2TenderWindow | null, taskName: string, phase: 'compose' | 'follow' | 'award',
): string | null {
  if (!w?.on_critical_path || !w.work_window || !w.award_by) return null;
  const start = fmtShort(w.work_window.start);
  const awardBy = fmtShort(w.award_by);
  const finish = w.project_finish ? ` (${fmtDay(w.project_finish)})` : '';
  if (phase === 'compose') {
    const toAwardBy = w.wd_bids_due_to_award_by;
    if (toAwardBy != null && w.bids_due && toAwardBy < 0) {
      return `${taskName} is on the critical path. Bids due ${fmtShort(w.bids_due)} come in after the award-by date (${awardBy}) — bring the deadline forward or the build's finish date${finish} moves.`;
    }
    if (toAwardBy != null && w.bids_due) {
      return `${taskName} is on the critical path. Bids due ${fmtShort(w.bids_due)} leaves ${toAwardBy} working ${toAwardBy === 1 ? 'day' : 'days'} to award before ${awardBy} (${w.mobilisation_lead_wd} working days ahead of the ${start} start) — any slip moves the build's finish date.`;
    }
    return `${taskName} is on the critical path. Award by ${awardBy} to start on ${start} — any slip moves the build's finish date.`;
  }
  if (phase === 'follow') return `On the critical path. Award by ${awardBy} or the build's finish date${finish} moves.`;
  return `Award by ${awardBy} keeps the finish date${finish}.`;
}

// ── Steps: which is open, which are done, which are locked (T-8) ─────────────

export type StepState = 'done' | 'open' | 'locked';
export type ComposeStep = 1 | 2 | 3;

/**
 * The three composer steps' states (T-8). The current step is open; a step is
 * COMPLETE when its facts hold — Scope: a saved draft; Bidders: at least one
 * bidder, or the RFP is open to the marketplace (publish's own rule); Review is
 * never "complete" (sending ends the composer). A step other than the current
 * one shows as done (collapsed, with Edit) when it and every step before it is
 * complete; otherwise it is locked and cannot be opened yet.
 */
export function composeSteps(
  current: ComposeStep, facts: { hasDraft: boolean; bidders: number; visibility: RfpVisibility },
): Record<ComposeStep, StepState> {
  const complete: Record<ComposeStep, boolean> = {
    1: facts.hasDraft,
    2: facts.hasDraft && (facts.bidders > 0 || facts.visibility === 'open'),
    3: false,
  };
  const at = (n: ComposeStep): StepState => {
    if (n === current) return 'open';
    const before = ([1, 2, 3] as ComposeStep[]).filter((k) => k < n).every((k) => complete[k]);
    return complete[n] && before ? 'done' : 'locked';
  };
  return { 1: at(1), 2: at(2), 3: at(3) };
}

/** Can the composer move past `step`? Null when yes, else the reason. */
export function continueBlocked(
  step: ComposeStep, facts: { hasDraft: boolean; bidders: number; visibility: RfpVisibility },
): string | null {
  if (step === 1 && !facts.hasDraft) return 'Save the scope first.';
  if (step === 2 && facts.bidders === 0 && facts.visibility !== 'open') return 'Add at least one contractor.';
  return null;
}

/** "3 added" — the Bidders step's caption. */
export function biddersCaption(recipients: readonly Pick<V2Recipient, 'id'>[]): string {
  return recipients.length === 0 ? 'none yet' : `${recipients.length} added`;
}

/** T-7: the one confirmation that says what sending does. */
export function sendConfirmation(input: { bidders: number; taskName: string; visibility: RfpVisibility }): string {
  const who = input.bidders === 1 ? '1 bidder' : `${input.bidders} bidders`;
  const listing = input.visibility === 'open'
    ? ' It is also listed on the marketplace for matching companies.' : '';
  return `This sends a personal link to ${who} and locks the dates of ${input.taskName} until you award.${listing}`;
}

export function sendLabel(bidders: number): string {
  return bidders === 0 ? 'Send' : `Send to ${bidders === 1 ? '1 bidder' : `${bidders} bidders`}`;
}

// ── Follow: the lifecycle stepper with dates (T-10) ──────────────────────────

export type LifecycleState = 'done' | 'now' | 'won' | 'todo';
export interface LifecycleStep { label: string; sub: string; state: LifecycleState }

/**
 * Draft → Out for bids → Comparing → Awarded, each with the date it happened.
 * Blue (done) is how far the tender got; amber (now) is "your move"; green
 * (won) is the outcome. A cancelled tender keeps the steps it reached.
 */
export function lifecycleSteps(
  rfp: Pick<V2Rfp, 'status' | 'created_at' | 'published_at' | 'closed_at' | 'awarded_at' | 'submission_deadline'>,
  facts: { proposalsIn: number; winnerName?: string | null },
): LifecycleStep[] {
  const s: RfpStatus = rfp.status;
  const sent = Boolean(rfp.published_at) || ['published', 'closed', 'awarded'].includes(s);
  const closed = Boolean(rfp.closed_at) || s === 'closed' || s === 'awarded';
  const n = facts.proposalsIn;
  const draft: LifecycleStep = {
    label: 'Draft', sub: fmtShort(rfp.created_at), state: s === 'draft' ? 'now' : 'done',
  };
  const out: LifecycleStep = {
    label: 'Out for bids',
    sub: !sent ? '—'
      : closed ? `${fmtShort(rfp.published_at)} → ${fmtShort(rfp.closed_at ?? rfp.submission_deadline)}`
        : `sent ${fmtShort(rfp.published_at)}`,
    state: sent ? 'done' : 'todo',
  };
  const comparing: LifecycleStep = {
    label: 'Comparing',
    sub: closed ? `${n} ${n === 1 ? 'proposal' : 'proposals'}` : `from ${fmtShort(rfp.submission_deadline)}`,
    state: s === 'closed' ? 'now' : s === 'awarded' || (s === 'cancelled' && closed) ? 'done' : 'todo',
  };
  const awarded: LifecycleStep = {
    label: 'Awarded',
    sub: s === 'awarded' ? (facts.winnerName ?? fmtShort(rfp.awarded_at)) : '—',
    state: s === 'awarded' ? 'won' : 'todo',
  };
  return [draft, out, comparing, awarded];
}

/** T-19: the reason line under a cancelled tender. */
export function cancelledLine(rfp: Pick<V2Rfp, 'cancelled_at' | 'cancel_reason'>): string {
  const when = rfp.cancelled_at ? ` on ${fmtDay(rfp.cancelled_at)}` : '';
  return rfp.cancel_reason
    ? `Tender cancelled${when}: ${rfp.cancel_reason}`
    : `Tender cancelled${when}. No reason was given.`;
}

// ── Compare & award, side by side (T-14, T-15, T-16, T-17) ───────────────────

/** A bid whose answer has landed (what the side-by-side compares — T-17). */
export function isLanded(lane: Pick<V2ProposalLane, 'status'>): boolean {
  return lane.status === 'submitted' || lane.status === 'shortlisted' || lane.status === 'awarded';
}

export interface CompareColumn {
  proposalId: string;
  name: string;
  total: string;
  duration: string;
  canStart: string;
  validUntil: string;
  linesUnpriced: number;
  files: number;
  byEmail: boolean;
  /** T-15: false when the bid's duration is longer than the plan window. Null: unknown. */
  durationFits: boolean | null;
  /** T-15: false when the bid can only start after the planned start. Null: unknown. */
  startFits: boolean | null;
  /** Still pickable (submitted / shortlisted). */
  live: boolean;
  awarded: boolean;
}

/**
 * Every landed bid as a column, in the order the bids are listed (no ranking,
 * no averages — T-14). Amounts only with the money permission (absent → "—").
 */
export function compareColumns(
  lanes: readonly V2ProposalLane[], window: V2TenderWindow | null,
): CompareColumn[] {
  const ww = window?.work_window ?? null;
  return lanes.filter(isLanded).map((l) => ({
    proposalId: l.proposal_id,
    name: l.bidder.name ?? l.bidder.email,
    total: formatMoney(l.total),
    duration: l.duration_wd != null ? `${l.duration_wd} working days` : '—',
    canStart: fmtDay(l.start),
    validUntil: fmtDay(l.validity_until),
    linesUnpriced: l.missing_lines,
    files: l.document_count,
    byEmail: l.channel === 'email',
    durationFits: ww && l.duration_wd != null ? l.duration_wd <= ww.duration_wd : null,
    startFits: ww && l.start ? l.start <= ww.start : null,
    live: l.status === 'submitted' || l.status === 'shortlisted',
    awarded: l.status === 'awarded',
  }));
}

/** T-15: "Plan window for this task: 1 Feb → 26 Feb 2027 (20 working days)." */
export function planWindowNote(w: V2TenderWindow | null, taskName: string): string {
  if (!w?.work_window) return `${taskName} has no planned dates to compare the bids against.`;
  return `Plan window for this task: ${fmtShort(w.work_window.start)} → ${fmtDay(w.work_window.finish)} (${w.work_window.duration_wd} working days).`;
}

/** T-16: what awarding does, said before the click. */
export function awardConsequences(input: { winnerName: string; otherBids: number; taskName: string }): string {
  const others = input.otherBids === 0 ? ''
    : `, declines the other ${input.otherBids === 1 ? 'bid' : `${input.otherBids} bids`}`;
  return `This closes the tender${others} and drafts their contract. ${input.taskName}'s dates unlock so you can set them to the agreed start. Every proposal stays on the record.`;
}

// ── Which face the panel shows ───────────────────────────────────────────────

export type PanelFace = 'none' | 'compose' | 'follow' | 'compare' | 'cancelled';

export function panelFace(rfp: Pick<V2Rfp, 'status'> | null): PanelFace {
  if (!rfp) return 'none';
  switch (rfp.status) {
    case 'draft': return 'compose';
    case 'published': return 'follow';
    case 'closed':
    case 'awarded': return 'compare';
    case 'cancelled': return 'cancelled';
    default: return 'follow';
  }
}

/** Bidders not yet engaged with their link — the ones offered "Copy link" (T-11). */
export function offersCopyLink(r: Pick<V2Recipient, 'status'>): boolean {
  return r.status === 'queued' || r.status === 'sent' || r.status === 'bounced';
}

/**
 * The plan's `ProcurementRfp` for an RFP the panel just changed, so the grid
 * chip, the Gantt band and the tab label follow a write without a reload.
 * Pure renaming of the RFP's own fields; the server's task-procurement read
 * replaces it on the next page load.
 */
export function procurementFromRfp(
  rfp: Pick<V2Rfp, 'id' | 'status' | 'title' | 'created_at' | 'submission_deadline' | 'excluded_task_ids' | 'cancel_reason'>,
  counts: { invited?: number; submitted?: number; awardedTo?: string | null } = {},
): {
  status: RfpStatus; openedDay: string; bidsDueDay: string; submittedCount: number; invitedCount?: number;
  title: string; rfpId: string; excludedTaskIds?: string[]; cancelReason?: string; awardedTo?: string;
} {
  return {
    status: rfp.status,
    openedDay: (rfp.created_at ?? new Date().toISOString()).slice(0, 10),
    bidsDueDay: (rfp.submission_deadline ?? '').slice(0, 10),
    submittedCount: counts.submitted ?? 0,
    ...(counts.invited != null ? { invitedCount: counts.invited } : {}),
    title: rfp.title,
    rfpId: rfp.id,
    ...(rfp.excluded_task_ids?.length ? { excludedTaskIds: [...rfp.excluded_task_ids] } : {}),
    ...(rfp.cancel_reason ? { cancelReason: rfp.cancel_reason } : {}),
    ...(counts.awardedTo ? { awardedTo: counts.awardedTo } : {}),
  };
}

/**
 * The RFP that governs a task in the plan: the one the server's task-procurement
 * read named, else the newest live one rooted there, else the newest at all.
 * (`rfps` arrive newest-first from /me/rfps.)
 */
export function governingRfp<T extends Pick<V2Rfp, 'id' | 'status' | 'root_task_ids'>>(
  rfps: readonly T[], taskId: string, named?: string | null,
): T | null {
  const mine = rfps.filter((r) => r.root_task_ids.includes(taskId));
  if (named) {
    const hit = mine.find((r) => r.id === named);
    if (hit) return hit;
  }
  return mine.find((r) => r.status !== 'cancelled') ?? mine[0] ?? null;
}
