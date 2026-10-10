// Pure view model of the tendering home and of clarifications (PRD-08). Split
// from the I/O (`tendering-home.ts`, server-only) so every phrase is testable.
//
// The server owns every rule: which RFPs the viewer may see, the n/m counts
// (issuer only — absent for a bidder, V8), whether questions are still open,
// which questions a bidder may read and whether one is theirs. This file only
// groups and words what it is handed; it never computes a deadline or decides
// who may ask.

import { fmtDay, fmtDeadline } from './tender-flow-view.ts';
import type { RfpStatus, V2Clarification, V2Rfp } from './tendering-view.ts';

export type { V2Clarification } from './tendering-view.ts';

// ── Wire: #/components/schemas/ProjectRfp ───────────────────────────────────

export interface V2ProjectRfp extends V2Rfp {
  viewer_role: 'issuer' | 'bidder';
  covers: Array<{ task_id: string; name: string }>;
  covered_task_count: number;
  questions_open: boolean;
  /** Issuer only (absent for a bidder). */
  invited_count?: number;
  submitted_count?: number;
  open_question_count?: number;
  awarded_to?: { org_id: string | null; name: string } | null;
  /** Bidder only. */
  my_proposal?: { id: string; status: string } | null;
}

// ── Paths (to-be/20 §3) ──────────────────────────────────────────────────────

export function tenderingPath(projectId: string): string {
  return `/projects/${projectId}/tendering`;
}

export function rfpPath(projectId: string, rfpId: string): string {
  return `${tenderingPath(projectId)}/rfps/${rfpId}`;
}

export function proposalsPath(projectId: string, rfpId: string, compare?: string | null): string {
  const base = `${rfpPath(projectId, rfpId)}/proposals`;
  return compare ? `${base}?compare=${encodeURIComponent(compare)}` : base;
}

export function newRfpPath(projectId: string, opts: { task?: string | null; mode?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (opts.task) q.set('task', opts.task);
  if (opts.mode === 'light') q.set('mode', 'light');
  const qs = q.toString();
  return `${tenderingPath(projectId)}/rfps/new${qs ? `?${qs}` : ''}`;
}

/**
 * H-4: where an old `/plan/procurement?…` link lands. `?rfp=` opens the RFP
 * (its proposals when `?compare=` names bids); `?task=` starts a new one on
 * that task; bare → the tendering home.
 */
export function legacyProcurementTarget(
  projectId: string,
  q: { rfp?: string | null; compare?: string | null; task?: string | null; mode?: string | null },
): string {
  if (q.rfp) return q.compare ? proposalsPath(projectId, q.rfp, q.compare) : rfpPath(projectId, q.rfp);
  if (q.task) return newRfpPath(projectId, { task: q.task, mode: q.mode });
  return tenderingPath(projectId);
}

// ── Home grouping (H-1) ──────────────────────────────────────────────────────

const GROUPS: Array<{ status: RfpStatus; label: string }> = [
  { status: 'draft', label: 'Drafts — not sent' },
  { status: 'published', label: 'Out for bids' },
  { status: 'closed', label: 'Comparing' },
  { status: 'awarded', label: 'Awarded' },
  { status: 'cancelled', label: 'Cancelled' },
];

export interface HomeGroup {
  status: RfpStatus;
  label: string;
  items: V2ProjectRfp[];
}

/** RFPs grouped by lifecycle state, in lifecycle order; empty groups dropped. */
export function groupByLifecycle(items: readonly V2ProjectRfp[]): HomeGroup[] {
  const known = new Set(GROUPS.map((g) => g.status));
  const groups = GROUPS.map((g) => ({ ...g, items: items.filter((i) => i.status === g.status) }));
  const other = items.filter((i) => !known.has(i.status));
  if (other.length) groups.push({ status: 'draft', label: 'Other', items: other });
  return groups.filter((g) => g.items.length > 0);
}

/** "Roofing + 9 sub-tasks", or the title when the package names no root. */
export function coversText(item: Pick<V2ProjectRfp, 'covers' | 'covered_task_count' | 'title'>): string {
  const names = item.covers.map((c) => c.name.trim()).filter(Boolean);
  if (names.length === 0) return item.title;
  const head = names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
  const extra = Math.max(0, item.covered_task_count - item.covers.length);
  return extra ? `${head} + ${extra} ${extra === 1 ? 'sub-task' : 'sub-tasks'}` : head;
}

/** "2/5 in" for the issuer; null for a bidder (the counts are not theirs to see). */
export function inLabel(item: Pick<V2ProjectRfp, 'viewer_role' | 'invited_count' | 'submitted_count'>): string | null {
  if (item.viewer_role !== 'issuer' || item.invited_count == null) return null;
  return `${item.submitted_count ?? 0}/${item.invited_count} in`;
}

/** "Bids due 20 Jan 2027, 18:00" / "Bids were due …" against `nowIso`. */
export function bidsDueLabel(item: Pick<V2ProjectRfp, 'submission_deadline' | 'status'>, nowIso: string): string {
  if (!item.submission_deadline) return 'No bids-due date';
  const past = new Date(item.submission_deadline).getTime() < new Date(nowIso).getTime();
  return `${past || item.status !== 'published' ? 'Bids were due' : 'Bids due'} ${fmtDeadline(item.submission_deadline)}`;
}

/** "3 questions to answer" for the issuer, or null. */
export function openQuestionsLabel(item: Pick<V2ProjectRfp, 'viewer_role' | 'open_question_count'>): string | null {
  const n = item.viewer_role === 'issuer' ? item.open_question_count ?? 0 : 0;
  if (n <= 0) return null;
  return `${n} ${n === 1 ? 'question' : 'questions'} to answer`;
}

/** The bidder's own lane in words. */
export function myLaneLabel(item: Pick<V2ProjectRfp, 'viewer_role' | 'my_proposal'>): string | null {
  if (item.viewer_role !== 'bidder') return null;
  const s = item.my_proposal?.status;
  if (!s) return 'Invited';
  if (s === 'invited' || s === 'draft') return 'Your bid: not sent yet';
  if (s === 'submitted' || s === 'shortlisted') return 'Your bid is in';
  if (s === 'awarded') return 'You were awarded this';
  return `Your bid: ${s}`;
}

// ── Clarifications (H-6..H-9) ────────────────────────────────────────────────

/** The issuer's order: open questions first (oldest first), then answered. */
export function issuerOrder(list: readonly V2Clarification[]): V2Clarification[] {
  const t = (c: V2Clarification) => new Date(c.asked_at ?? 0).getTime() || 0;
  return [...list].sort((a, b) => (a.status === b.status ? t(a) - t(b) : a.status === 'open' ? -1 : 1));
}

export function openCount(list: readonly V2Clarification[] | null | undefined): number {
  return (list ?? []).filter((c) => c.status === 'open').length;
}

/** The line under a question: who may see it (never who asked). */
export function clarificationMeta(c: V2Clarification, role: 'issuer' | 'bidder'): string {
  if (c.status === 'answered') {
    return `Answered ${fmtDay(c.answered_at)} · sent to every bidder`;
  }
  if (role === 'issuer') return `Asked ${fmtDay(c.asked_at)} · waiting for your answer`;
  return c.mine ? 'Your question · waiting for an answer. Only you and the issuer see it until it is answered.' : 'Waiting for an answer';
}

/**
 * What the ask box says (H-9). The server decides `questionsOpen`; this only
 * words it, with the deadline when there is one.
 */
export function askState(
  questionsOpen: boolean,
  rfp: { questions_deadline?: string | null; status?: string },
): { canAsk: boolean; note: string } {
  if (questionsOpen) {
    return {
      canAsk: true,
      note: rfp.questions_deadline
        ? `You can ask until ${fmtDeadline(rfp.questions_deadline)}. Answers go to every bidder; your name is never shown.`
        : 'Answers go to every bidder; your name is never shown.',
    };
  }
  if (rfp.status && rfp.status !== 'published') return { canAsk: false, note: 'Questions are closed: this request is no longer out for bids.' };
  return {
    canAsk: false,
    note: rfp.questions_deadline
      ? `Questions closed on ${fmtDeadline(rfp.questions_deadline)}.`
      : 'Questions are closed.',
  };
}

/** Client-side courtesy check; the server is the authority. */
export function questionProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return 'Write your question first.';
  if (t.length > 4000) return 'Keep it under 4000 characters.';
  return null;
}
