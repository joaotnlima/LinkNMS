// PRD-13 — changes against the baseline, as the plan shows them. Pure
// wire → view transforms (no session, unit-tested under node --test).
//
// Every number here is the SERVER's (modules/planning domain/slippage.mjs):
// segments, working-day deltas, overruns, projected pushes, the handover and
// the unseen count. This module only renames fields, words the labels (S-4:
// "+5 wd · moved by TN") and formats dates — no schedule maths, no geometry
// beyond what the grid does with dates → pixels.

// ── wire shapes (openapi Segment / Task / Schedule / Variation) ──────────────

export type V2SegmentKind =
  | 'baseline' | 'current' | 'extension' | 'delay_start' | 'actual' | 'overrun' | 'projected';
export type V2SlipCause = 'moved' | 'pushed' | 'not_closed' | 'closed_late' | 'closed_early' | 'net';

export interface V2Segment {
  kind: V2SegmentKind;
  from: string;
  to: string;
  moved?: boolean;
  delta_wd?: number;
  cause?: V2SlipCause;
  cause_task_id?: string;
  by_org_id?: string;
}

export interface V2TaskSlipWire {
  id: string;
  name: string;
  start: string | null;
  finish: string | null;
  status?: string;
  actual_finish?: string | null;
  can_edit?: boolean;
  editor_is_assignee?: boolean;
  assignee?: { org_id: string; org_name?: string };
  baseline?: { start: string | null; finish: string | null; version?: number; reason?: string; taken_at?: string } | null;
  segments?: V2Segment[];
  baseline_delta_wd?: number;
  overrun_wd?: number;
  projected?: { start: string; finish: string; cause_task_id?: string };
}

export interface V2Handover {
  finish?: string;
  projected_finish?: string;
  baseline_finish?: string;
  delta_wd?: number;
}

export interface V2ScheduleSlipWire {
  tasks?: V2TaskSlipWire[];
  handover?: V2Handover;
  changes?: { total: number; unseen: number };
}

export interface V2Variation {
  id: string;
  task_id: string;
  task_name?: string;
  kind: 'time' | 'cost' | 'material' | 'scope';
  baseline_value?: unknown;
  current_value?: unknown;
  delta?: unknown;
  cause: 'direct' | 'propagated' | 'closed_late';
  cause_task_id?: string;
  reason?: string;
  last_changed_by?: { org_id?: string };
  changed_by_org_name?: string;
  first_changed_at?: string;
  last_changed_at?: string;
  status: 'open' | 'acknowledged' | 'formalised' | 'closed';
  acknowledged_by?: Array<{ person_id: string; at: string }>;
  seen_by_viewer?: boolean;
  can_acknowledge?: boolean;
}

// ── view shapes ──────────────────────────────────────────────────────────────

export interface SlipSegment {
  kind: V2SegmentKind;
  from: string;
  to: string;
  moved: boolean;
  deltaWd: number | null;
  cause: V2SlipCause | null;
  causeTaskId: string | null;
  byOrgId: string | null;
}

export interface TaskSlip {
  id: string;
  name: string;
  start: string | null;
  finish: string | null;
  closed: boolean;
  canEdit: boolean;
  isAssignee: boolean;
  ownerOrgId: string | null;
  ownerName: string | null;
  baseline: { start: string; finish: string; version: number; reason: string | null; takenAt: string | null } | null;
  segments: SlipSegment[];
  /** working days vs baseline (S-5); null without a baseline. */
  deltaWd: number | null;
  /** working days run past the current finish (S-2/S-9); null when not overrunning. */
  overrunWd: number | null;
  projected: { start: string; finish: string; causeTaskId: string | null } | null;
}

export interface PlanSlipView {
  byTask: Record<string, TaskSlip>;
  /** True when any row carries a baseline — the vs-baseline column shows. */
  baselined: boolean;
  handover: { finish: string | null; projectedFinish: string | null; baselineFinish: string | null; deltaWd: number | null } | null;
  changes: { total: number; unseen: number };
  /** Organisation names the read carries (row owners), for "moved by TN". */
  orgNames: Record<string, string>;
}

export const EMPTY_SLIP: PlanSlipView = {
  byTask: {}, baselined: false, handover: null, changes: { total: 0, unseen: 0 }, orgNames: {},
};

const CLOSED = new Set(['done', 'verified']);

export function toSlipSegment(s: V2Segment): SlipSegment {
  return {
    kind: s.kind,
    from: s.from,
    to: s.to,
    moved: s.moved === true,
    deltaWd: typeof s.delta_wd === 'number' ? s.delta_wd : null,
    cause: s.cause ?? null,
    causeTaskId: s.cause_task_id ?? null,
    byOrgId: s.by_org_id ?? null,
  };
}

export function toTaskSlip(t: V2TaskSlipWire): TaskSlip {
  const b = t.baseline;
  return {
    id: t.id,
    name: t.name,
    start: t.start ?? null,
    finish: t.finish ?? null,
    closed: Boolean(t.actual_finish) || CLOSED.has(t.status ?? ''),
    canEdit: t.can_edit === true,
    isAssignee: t.editor_is_assignee === true,
    ownerOrgId: t.assignee?.org_id ?? null,
    ownerName: t.assignee?.org_name ?? null,
    baseline: b && b.start && b.finish
      ? { start: b.start, finish: b.finish, version: b.version ?? 1, reason: b.reason ?? null, takenAt: b.taken_at ?? null }
      : null,
    segments: (t.segments ?? []).map(toSlipSegment),
    deltaWd: typeof t.baseline_delta_wd === 'number' ? t.baseline_delta_wd : null,
    overrunWd: typeof t.overrun_wd === 'number' ? t.overrun_wd : null,
    projected: t.projected
      ? { start: t.projected.start, finish: t.projected.finish, causeTaskId: t.projected.cause_task_id ?? null }
      : null,
  };
}

/** The whole schedule read → the plan's slip view. */
export function toPlanSlipView(view: V2ScheduleSlipWire): PlanSlipView {
  const byTask: Record<string, TaskSlip> = {};
  const orgNames: Record<string, string> = {};
  let baselined = false;
  for (const t of view.tasks ?? []) {
    const slip = toTaskSlip(t);
    byTask[t.id] = slip;
    if (slip.baseline) baselined = true;
    if (t.assignee?.org_id && t.assignee.org_name) orgNames[t.assignee.org_id] = t.assignee.org_name;
  }
  const h = view.handover;
  return {
    byTask,
    baselined,
    handover: h && (h.finish || h.projected_finish)
      ? {
          finish: h.finish ?? null,
          projectedFinish: h.projected_finish ?? h.finish ?? null,
          baselineFinish: h.baseline_finish ?? null,
          deltaWd: typeof h.delta_wd === 'number' ? h.delta_wd : null,
        }
      : null,
    changes: { total: view.changes?.total ?? 0, unseen: view.changes?.unseen ?? 0 },
    orgNames,
  };
}

// ── words ────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2027-03-05' → '5 Mar'. */
export function dayMonth(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '—';
  const [, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** '2027-03-05' → '5 Mar 2027'. */
export function dayMonthYear(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '—';
  return `${dayMonth(iso)} ${iso.slice(0, 4)}`;
}

/** An RFC 3339 timestamp → '3 Feb, 14:10' (UTC, the server's clock). */
export function stamp(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hh}:${mm}`;
}

export type DeltaTone = 'up' | 'down' | 'zero';

/** S-5: '+5 wd' (clay) · 'on plan' (muted) · '−3 wd' (green). */
export function deltaWord(deltaWd: number | null | undefined): { text: string; tone: DeltaTone } | null {
  if (deltaWd == null) return null;
  if (deltaWd > 0) return { text: `+${deltaWd} wd`, tone: 'up' };
  if (deltaWd < 0) return { text: `−${Math.abs(deltaWd)} wd`, tone: 'down' };
  return { text: 'on plan', tone: 'zero' };
}

/** A signed working-day count for a label ('+5 wd' / '−3 wd' / '0 wd'). */
export function signedWd(n: number): string {
  if (n > 0) return `+${n} wd`;
  if (n < 0) return `−${Math.abs(n)} wd`;
  return '0 wd';
}

/** Two-letter initials of an organisation name ('Telhados do Norte' → 'TN'). */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').split(/\s+/).filter((w) => w && /^[A-Za-zÀ-ÿ]/.test(w) && w.length > 2);
  const pick = words.length >= 2 ? [words[0], words[words.length - 1]] : words.slice(0, 1);
  return pick.map((w) => w[0].toUpperCase()).join('') || '?';
}

export interface LabelContext {
  /** outline id ('2.3') of a task, for "pushed by 2.3". */
  outlineOf: (taskId: string) => string | null;
  /** display name of an organisation, for "moved by TN". */
  orgNameOf: (orgId: string) => string | null;
}

/** S-4: every clay segment carries words, never colour alone. */
export function segmentLabel(seg: SlipSegment, ctx: LabelContext): string | null {
  if (seg.deltaWd == null || !seg.cause) return null;
  const wd = signedWd(seg.deltaWd);
  switch (seg.cause) {
    case 'moved': {
      const who = seg.byOrgId ? ctx.orgNameOf(seg.byOrgId) : null;
      return who ? `${wd} · moved by ${initials(who)}` : `${wd} · moved`;
    }
    case 'pushed': {
      const by = seg.causeTaskId ? ctx.outlineOf(seg.causeTaskId) : null;
      return by ? `${wd} · pushed by ${by}` : `${wd} · pushed`;
    }
    case 'not_closed': return `${wd} · not closed`;
    case 'closed_late': return `${wd} · closed late`;
    case 'closed_early': return `${wd} · closed early`;
    case 'net': return wd;
    default: return wd;
  }
}

/** The one label a bar shows: overrun first, then projection, extension, early close. */
export function barLabel(slip: TaskSlip, ctx: LabelContext): { text: string; tone: 'clay' | 'ok' } | null {
  const order: V2SegmentKind[] = ['overrun', 'projected', 'extension', 'actual'];
  for (const kind of order) {
    const seg = slip.segments.find((s) => s.kind === kind && s.cause);
    if (!seg) continue;
    const text = segmentLabel(seg, ctx);
    if (text) return { text, tone: seg.cause === 'closed_early' ? 'ok' : 'clay' };
  }
  return null;
}

/** S-7: late or extended = past its baseline, overrunning, or pushed by an overrun. */
export function isLateOrExtended(slip: TaskSlip | undefined): boolean {
  if (!slip) return false;
  return (slip.deltaWd ?? 0) > 0 || (slip.overrunWd ?? 0) > 0 || slip.projected != null;
}

/** S-6 header: '◆ Handover 7 May · +5 wd'. */
export function handoverWords(h: PlanSlipView['handover']): { date: string; delta: string | null; tone: DeltaTone } | null {
  if (!h?.projectedFinish) return null;
  const d = deltaWord(h.deltaWd);
  return { date: dayMonth(h.projectedFinish), delta: d && d.tone !== 'zero' ? d.text : d ? 'on plan' : null, tone: d?.tone ?? 'zero' };
}

/** Where the baseline came from, in words (S-13). */
export function baselineOrigin(b: TaskSlip['baseline']): string | null {
  if (!b) return null;
  const when = b.takenAt ? ` · ${dayMonth(b.takenAt.slice(0, 10))}` : '';
  const why = b.reason === 'award'
    ? 'taken at award'
    : b.reason === 'contract_signed'
      ? 'taken when the contract was signed'
      : b.reason === 'change_order' ? 'from an approved change order' : 'taken';
  return `v${b.version}, ${why}${when}`;
}

// ── changes (variations) ─────────────────────────────────────────────────────

export interface ChangeItem {
  id: string;
  taskId: string;
  taskName: string;
  kind: V2Variation['kind'];
  /** 'Finish 26 Feb → 5 Mar' / 'Scope text changed' … */
  what: string;
  deltaWd: number | null;
  propagated: boolean;
  closedLate: boolean;
  causeTaskId: string | null;
  who: string | null;
  at: string | null;
  reason: string | null;
  status: V2Variation['status'];
  seen: boolean;
  canAcknowledge: boolean;
  acknowledgements: number;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** One variation → one line of "Changes on this task" / "Changes since baseline". */
export function toChangeItem(v: V2Variation): ChangeItem {
  const base = asRecord(v.baseline_value);
  const cur = asRecord(v.current_value);
  const delta = asRecord(v.delta);
  let what: string;
  let deltaWd: number | null = null;
  if (v.kind === 'time') {
    const bf = typeof base.finish === 'string' ? base.finish : null;
    const cf = typeof cur.finish === 'string' ? cur.finish : null;
    const bs = typeof base.start === 'string' ? base.start : null;
    const cs = typeof cur.start === 'string' ? cur.start : null;
    deltaWd = typeof delta.finish_wd === 'number' ? delta.finish_wd : null;
    if (bf !== cf) what = `Finish ${dayMonth(bf)} → ${dayMonth(cf)}`;
    else if (bs !== cs) {
      what = `Start ${dayMonth(bs)} → ${dayMonth(cs)}`;
      deltaWd = typeof delta.start_wd === 'number' ? delta.start_wd : deltaWd;
    } else what = 'Dates back on the baseline';
  } else if (v.kind === 'scope') {
    if (delta.added) what = 'Added after the baseline';
    else if (delta.removed) what = 'Removed after the baseline';
    else if (delta.acceptance_criteria_changed && delta.scope_text_changed) what = 'Scope and acceptance criteria changed';
    else if (delta.acceptance_criteria_changed) what = 'Acceptance criteria changed';
    else what = 'Scope text changed';
  } else if (v.kind === 'cost') {
    what = 'Cost changed';
  } else {
    what = 'Material changed';
  }
  return {
    id: v.id,
    taskId: v.task_id,
    taskName: v.task_name ?? 'A task',
    kind: v.kind,
    what,
    deltaWd,
    propagated: v.cause === 'propagated',
    closedLate: v.cause === 'closed_late',
    causeTaskId: v.cause_task_id ?? null,
    who: v.changed_by_org_name ?? null,
    at: v.last_changed_at ?? null,
    reason: v.reason ?? null,
    status: v.status,
    seen: v.seen_by_viewer === true,
    canAcknowledge: v.can_acknowledge === true,
    acknowledgements: v.acknowledged_by?.length ?? 0,
  };
}

/** Live changes (open / acknowledged), newest first — the server already sorts. */
export function liveChanges(items: V2Variation[]): ChangeItem[] {
  return items
    .filter((v) => v.status === 'open' || v.status === 'acknowledged')
    .map(toChangeItem);
}

export type ChangeFilter = 'all' | 'unseen' | 'time';

/** S-15 view filters over what the server returned (no domain rule here). */
export function filterChanges(items: ChangeItem[], f: ChangeFilter): ChangeItem[] {
  if (f === 'unseen') return items.filter((c) => c.canAcknowledge && !c.seen);
  if (f === 'time') return items.filter((c) => c.kind === 'time');
  return items;
}

// ── the S-10 impact note ─────────────────────────────────────────────────────

export interface V2MovePreview {
  would_move?: Array<{ id: string; name?: string; start: string; finish: string }>;
  project_end_delta_wd?: number;
  project_finish?: { before?: string; after?: string };
  baseline_delta_wd?: number;
  notify?: Array<{ org_id: string; org_name?: string; role: 'owner' | 'client' }>;
}

export interface MoveImpact {
  baselineDeltaWd: number | null;
  pushes: Array<{ id: string; name: string }>;
  handoverAfter: string | null;
  handoverMoves: boolean;
  notify: Array<{ name: string; role: 'owner' | 'client' }>;
}

export function toMoveImpact(p: V2MovePreview): MoveImpact {
  return {
    baselineDeltaWd: typeof p.baseline_delta_wd === 'number' ? p.baseline_delta_wd : null,
    pushes: (p.would_move ?? []).map((m) => ({ id: m.id, name: m.name ?? 'a linked task' })),
    handoverAfter: p.project_finish?.after ?? null,
    handoverMoves: (p.project_end_delta_wd ?? 0) !== 0,
    notify: (p.notify ?? []).map((n) => ({ name: n.org_name ?? 'The project owner', role: n.role })),
  };
}
