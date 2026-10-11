// Pure v2-wire → view transforms for the build home `/projects/{id}` (PRD-09
// O-1, O-2). The numbers are the server's (getProjectOverview composes them
// from the owning modules); this only words them for the four pillars and the
// "What's waiting for you" list. No status math beyond choosing a tint for a
// number the server already computed.
import type { Pillar, Pillars } from '../types';
import { categoryLabel, safeAppPath, type V2Notification } from './notifications-view.ts';

export interface V2Money { amount_cents: number; currency: string }

export interface V2ProjectOverview {
  project: { id: string; name: string; owner_org_id?: string; status: string; operating_model?: string };
  plan?: { rows: number; top_level: number; start: string | null };
  end_date?: { baseline?: string; current?: string; delta_wd?: number };
  cost?: { baseline: V2Money; current: V2Money };
  open_variations: number;
  open_questions: number;
  pending_verifications: number;
  open_nonconformities?: { quality: number; safety: number };
}

export interface V2NotificationSummary {
  project_id: string | null;
  total_unread: number;
  categories: Array<{ category: string; unread_count: number; latest: V2Notification }>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** The four pillars (schedule · budget · scope · safety) from the overview. */
export function pillarsFromOverview(o: V2ProjectOverview): Pillars {
  return { schedule: schedulePillar(o), budget: budgetPillar(o), scope: scopePillar(o), safety: safetyPillar(o) };
}

function schedulePillar(o: V2ProjectOverview): Pillar {
  if (!o.plan?.rows) return { pillar: 'schedule', status: 'none', label: 'No plan yet', icon: 'info' };
  const e = o.end_date ?? {};
  if (!e.current) return { pillar: 'schedule', status: 'none', label: plural(o.plan.rows, 'row') + ', no dates yet', icon: 'info' };
  if (!e.baseline) return { pillar: 'schedule', status: 'none', label: `Ends ${shortDate(e.current)} · no baseline yet`, icon: 'info' };
  const d = e.delta_wd ?? 0;
  if (d <= 0) return { pillar: 'schedule', status: 'green', label: d < 0 ? `${-d} wd ahead of baseline` : 'On baseline', icon: 'check-circle' };
  return {
    pillar: 'schedule', status: d > 10 ? 'red' : 'amber', icon: d > 10 ? 'alert-octagon' : 'alert-triangle',
    label: `+${d} wd vs baseline · ends ${shortDate(e.current)}`, approvedScheduleImpactDays: d,
  };
}

function budgetPillar(o: V2ProjectOverview): Pillar {
  if (!o.cost) return { pillar: 'budget', status: 'none', label: 'No signed contract to show', icon: 'info' };
  const baseline = o.cost.baseline.amount_cents;
  const current = o.cost.current.amount_cents;
  const delta = current - baseline;
  return {
    pillar: 'budget', status: delta > 0 ? 'amber' : 'green', icon: delta > 0 ? 'alert-triangle' : 'check-circle',
    label: delta > 0 ? 'Above the signed value' : 'On the signed value',
    baselineCents: baseline, currentCents: current, deltaCents: delta,
  };
}

function scopePillar(o: V2ProjectOverview): Pillar {
  const v = o.open_variations ?? 0;
  const q = o.open_questions ?? 0;
  if (!v && !q) return { pillar: 'scope', status: 'green', label: 'Nothing open', icon: 'check-circle', openScopeNoteCount: 0 };
  const bits = [v ? plural(v, 'change') : null, q ? plural(q, 'question') : null].filter(Boolean);
  return { pillar: 'scope', status: 'amber', label: `${bits.join(' · ')} open`, icon: 'alert-triangle', openScopeNoteCount: v + q };
}

function safetyPillar(o: V2ProjectOverview): Pillar {
  const n = o.open_nonconformities?.safety ?? 0;
  return n > 0
    ? { pillar: 'safety', status: 'red', label: `${plural(n, 'open safety issue')}`, icon: 'alert-octagon', tracked: true }
    : { pillar: 'safety', status: 'green', label: 'No open safety issues', icon: 'shield', tracked: true };
}

export interface WaitingRow { category: string; label: string; count: number; title: string; url: string }

/** "What's waiting for you": one row per category with unread items, newest first. */
export function waitingRows(s: V2NotificationSummary | null): WaitingRow[] {
  return (s?.categories ?? []).map((c) => ({
    category: c.category,
    label: categoryLabel(c.category),
    count: c.unread_count,
    title: c.latest.title,
    url: safeAppPath(c.latest.object_ref?.url),
  }));
}

/** True when the plan is empty — the home then leads with the import (O-9, O-10). */
export function planIsEmpty(o: V2ProjectOverview | null): boolean {
  return !o?.plan?.rows;
}
