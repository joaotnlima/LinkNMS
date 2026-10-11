// Pure v2-wire → view arithmetic for the shared project model (PRD-07, D-45).
// Split from `model.ts` (the I/O, `server-only`) so it is unit-testable without
// a session. Nothing here decides who may do what — the server answers the
// viewer's scope and enforces it on save; this only arranges the answer for the
// screen: colours, legend, isolation, the private draft, history labels, and
// the GlobalId comparison of two IFC files (the server never parses IFC).

import type { V2FileDocument, V2Actor } from './task-files-view.ts';

// ── wire (subset, restated — a drift lands as a type error) ────────────────────

export interface V2ElementLink { global_id: string; task_id: string; added_in_version: number; linked_by: V2Actor; linked_at: string }
export interface V2ElementPin {
  id: string; global_ids: string[]; task_ids: string[]; text: string; state: 'open' | 'closed';
  version_no: number; closed_in_version?: number; author: V2Actor; created_at: string;
}
export interface V2ModelTask {
  id: string; code: string; name: string; parent_id: string | null; status: string;
  assignee_org_id: string | null; assignee_org_name: string | null; element_count: number;
}
export type ScopeKind = 'author' | 'owner' | 'whole' | 'tasks' | 'none';
export interface V2ModelEditor { org_id: string; org_name?: string; role: 'author' | 'owner' | 'branch'; task_ids: string[]; element_count: number | null }
export interface V2ProjectModel {
  project_id: string;
  document: V2FileDocument | null;
  author_org_id?: string;
  viewing_version?: number;
  links: V2ElementLink[];
  pins: V2ElementPin[];
  tasks: V2ModelTask[];
  viewer: {
    scope: {
      kind: ScopeKind; task_ids: string[]; element_count: number | null;
      /** M-8, the server's answer: every element is editable (author, owner). */
      edits_all?: boolean;
      /** M-8, when not `edits_all`: the elements the viewer may edit. */
      editable_global_ids?: string[];
    };
    can_upload: boolean; can_restore: boolean;
  };
  access: { readers: 'participants'; editors: V2ModelEditor[]; unassigned_tasks: Array<{ task_id: string; element_count: number }> };
  /** M-18, computed by the server when the latest .ifc completed. */
  upload_check?: V2ModelUploadCheck | null;
}
/** #/components/schemas/ModelUploadCheck */
export interface V2ModelUploadCheck {
  version_no: number;
  element_count?: number;
  unmatched_global_ids: string[];
  regenerated: boolean;
  shared_count?: number;
  recorded_count?: number;
}
export interface V2RecordDiff {
  from: number; to: number;
  links_added: Array<{ global_id: string; task_id: string }>;
  links_removed: Array<{ global_id: string; task_id: string }>;
  pins_added: V2ElementPin[]; pins_closed: V2ElementPin[];
}
export interface V2Conflict { global_id: string; version: number; by_org_id: string | null }

// ── colour ────────────────────────────────────────────────────────────────────

export type ColourMode = 'task' | 'status' | 'editor';
export const NEUTRAL = '#c9ccd1';
export const FADED = '#eceef1';
export const HIGHLIGHT = '#f2b705';
const PALETTE = ['#3b6fd8', '#d6453d', '#2e9d6a', '#9b59b6', '#e67e22', '#16a2b8', '#b5651d', '#5d6d7e', '#c2185b', '#7cb342'];
export const STATUS_COLOURS: Record<string, string> = {
  not_started: '#9aa1ab', in_progress: '#3b6fd8', blocked: '#d6453d', done: '#2e9d6a', verified: '#1d7a52',
};
export const STATUS_LABELS: Record<string, string> = {
  not_started: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', verified: 'Verified',
};

/** GlobalId → the tasks it is linked to (live record). */
export function linksByElement(links: Array<{ global_id: string; task_id: string }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const l of links) {
    const list = out.get(l.global_id);
    if (list) { if (!list.includes(l.task_id)) list.push(l.task_id); } else out.set(l.global_id, [l.task_id]);
  }
  return out;
}

/** Stable palette per task with elements, in outline order. */
export function taskColours(tasks: V2ModelTask[], links: Array<{ task_id: string }>): Map<string, string> {
  const linked = new Set(links.map((l) => l.task_id));
  const out = new Map<string, string>();
  let i = 0;
  for (const t of tasks) if (linked.has(t.id)) { out.set(t.id, PALETTE[i % PALETTE.length]); i += 1; }
  return out;
}

/** The org that edits a task's elements (M-6 "who edits"): its branch editor with the fewest rows, else the owner. */
export function editorOfTask(taskId: string, editors: V2ModelEditor[]): string | null {
  const branch = editors.filter((e) => e.role === 'branch' && e.task_ids.includes(taskId))
    .sort((a, b) => a.task_ids.length - b.task_ids.length);
  return branch[0]?.org_id ?? editors.find((e) => e.role === 'owner')?.org_id ?? null;
}

export interface ColourContext {
  byElement: Map<string, string[]>;
  tasks: Map<string, V2ModelTask>;
  taskColour: Map<string, string>;
  editors: V2ModelEditor[];
  orgColour: Map<string, string>;
}

export function colourContext(model: Pick<V2ProjectModel, 'tasks' | 'access'>, links: V2ElementLink[] | Array<{ global_id: string; task_id: string }>): ColourContext {
  const orgs = [...new Set(model.access.editors.map((e) => e.org_id))];
  return {
    byElement: linksByElement(links),
    tasks: new Map(model.tasks.map((t) => [t.id, t])),
    taskColour: taskColours(model.tasks, links),
    editors: model.access.editors,
    orgColour: new Map(orgs.map((o, i) => [o, PALETTE[(i + 3) % PALETTE.length]])),
  };
}

/** An element's colour in a mode; null = not linked (drawn neutral). The deepest linked task wins. */
export function colourOf(mode: ColourMode, globalId: string, ctx: ColourContext): string | null {
  const taskIds = ctx.byElement.get(globalId);
  if (!taskIds?.length) return null;
  const task = taskIds.map((id) => ctx.tasks.get(id)).filter((t): t is V2ModelTask => Boolean(t))
    .sort((a, b) => b.code.split('.').length - a.code.split('.').length)[0];
  if (!task) return null;
  if (mode === 'task') return ctx.taskColour.get(task.id) ?? NEUTRAL;
  if (mode === 'status') return STATUS_COLOURS[task.status] ?? NEUTRAL;
  const org = editorOfTask(task.id, ctx.editors);
  return org ? ctx.orgColour.get(org) ?? NEUTRAL : NEUTRAL;
}

export interface LegendRow { key: string; label: string; colour: string; count: number; taskId?: string }

/** M-3 legend: one row per task / status / editor with element counts, plus "not linked". */
export function legendRows(mode: ColourMode, model: Pick<V2ProjectModel, 'tasks' | 'access'>, links: Array<{ global_id: string; task_id: string }>,
  elementTotal: number, orgName: (id: string) => string): LegendRow[] {
  const ctx = colourContext(model, links);
  const linkedCount = ctx.byElement.size;
  const rows: LegendRow[] = [];
  if (mode === 'task') {
    const counts = new Map<string, number>();
    for (const l of links) counts.set(l.task_id, (counts.get(l.task_id) ?? 0) + 1);
    for (const t of model.tasks) {
      const n = counts.get(t.id);
      if (n) rows.push({ key: t.id, label: `${t.code} ${t.name}`, colour: ctx.taskColour.get(t.id) ?? NEUTRAL, count: n, taskId: t.id });
    }
  } else {
    const counts = new Map<string, number>();
    for (const gid of ctx.byElement.keys()) {
      const colour = colourOf(mode, gid, ctx) ?? NEUTRAL;
      counts.set(colour, (counts.get(colour) ?? 0) + 1);
    }
    if (mode === 'status') {
      for (const [status, colour] of Object.entries(STATUS_COLOURS)) {
        const n = counts.get(colour);
        if (n) rows.push({ key: status, label: STATUS_LABELS[status] ?? status, colour, count: n });
      }
    } else {
      for (const [org, colour] of ctx.orgColour) {
        const n = counts.get(colour);
        if (n) rows.push({ key: org, label: orgName(org), colour, count: n });
      }
    }
  }
  rows.push({ key: 'unlinked', label: 'Not linked to any task', colour: NEUTRAL, count: Math.max(0, elementTotal - linkedCount) });
  return rows;
}

/** M-4: a task and its sub-tasks — the rows whose elements `?task=` isolates. */
export function subtreeOf(taskId: string, tasks: V2ModelTask[]): Set<string> {
  const out = new Set([taskId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tasks) if (t.parent_id && out.has(t.parent_id) && !out.has(t.id)) { out.add(t.id); grew = true; }
  }
  return out;
}

export function isolatedElements(taskId: string, tasks: V2ModelTask[], links: Array<{ global_id: string; task_id: string }>): Set<string> {
  const rows = subtreeOf(taskId, tasks);
  return new Set(links.filter((l) => rows.has(l.task_id)).map((l) => l.global_id));
}

/** Resolve `?task=` given either a task id or an outline code ("2.5"). */
export function resolveTaskParam(param: string | null | undefined, tasks: V2ModelTask[]): string | null {
  if (!param) return null;
  return tasks.find((t) => t.id === param)?.id ?? tasks.find((t) => t.code === param)?.id ?? null;
}

// ── scope (the server's answer, read — never re-derived) ─────────────────────

export function editableElements(model: Pick<V2ProjectModel, 'viewer'>): Set<string> | 'all' {
  const s = model.viewer.scope;
  if (s.edits_all) return 'all';
  return new Set(s.editable_global_ids ?? []);
}

export function canEditElement(editable: Set<string> | 'all', gid: string): boolean {
  return editable === 'all' || editable.has(gid);
}

export function editableTasks(model: Pick<V2ProjectModel, 'viewer' | 'tasks'>): V2ModelTask[] {
  const s = model.viewer.scope;
  if (s.edits_all) return model.tasks;
  const rows = new Set(s.task_ids);
  return model.tasks.filter((t) => rows.has(t.id));
}

// ── the private draft (M-11) ──────────────────────────────────────────────────

export type DraftChange =
  | { op: 'link' | 'unlink'; globalId: string; taskId: string }
  | { op: 'pin'; pin: { id: string; globalIds: string[]; taskIds: string[]; text: string } }
  | { op: 'close_pin'; pinId: string };

export interface Draft { baseVersion: number; changes: DraftChange[] }

/** Add a change, folding an exact opposite (link then unlink of the same pair) away. */
export function addChange(draft: Draft, change: DraftChange): Draft {
  if (change.op === 'link' || change.op === 'unlink') {
    const opposite = change.op === 'link' ? 'unlink' : 'link';
    const i = draft.changes.findIndex((c) => c.op === opposite && c.globalId === change.globalId && c.taskId === change.taskId);
    if (i >= 0) return { ...draft, changes: draft.changes.filter((_, j) => j !== i) };
    if (draft.changes.some((c) => c.op === change.op && c.globalId === change.globalId && c.taskId === change.taskId)) return draft;
  }
  return { ...draft, changes: [...draft.changes, change] };
}

/** The record as the draft would leave it — what the viewer shows while editing. */
export function applyDraft(links: V2ElementLink[], pins: V2ElementPin[], draft: Draft | null) {
  if (!draft) return { links: links.map((l) => ({ global_id: l.global_id, task_id: l.task_id })), pins };
  let out = links.map((l) => ({ global_id: l.global_id, task_id: l.task_id }));
  const outPins = pins.map((p) => ({ ...p }));
  for (const c of draft.changes) {
    if (c.op === 'link' && !out.some((l) => l.global_id === c.globalId && l.task_id === c.taskId)) out.push({ global_id: c.globalId, task_id: c.taskId });
    if (c.op === 'unlink') out = out.filter((l) => !(l.global_id === c.globalId && l.task_id === c.taskId));
    if (c.op === 'pin') {
      outPins.push({ id: c.pin.id, global_ids: c.pin.globalIds, task_ids: c.pin.taskIds, text: c.pin.text, state: 'open',
        version_no: draft.baseVersion + 1, author: { org_id: '', person_id: '' }, created_at: '' });
    }
    if (c.op === 'close_pin') { const p = outPins.find((x) => x.id === c.pinId); if (p) p.state = 'closed'; }
  }
  return { links: out, pins: outPins };
}

/** The ModelEditSave body. */
export function draftBody(draft: Draft, note: string, resolutions: Record<string, 'mine' | 'theirs'> = {}) {
  return {
    base_version_no: draft.baseVersion,
    note: note.trim(),
    changes: draft.changes.map((c) => {
      if (c.op === 'link' || c.op === 'unlink') return { op: c.op, global_id: c.globalId, task_id: c.taskId };
      if (c.op === 'pin') return { op: 'pin', pin: { id: c.pin.id, global_ids: c.pin.globalIds, task_ids: c.pin.taskIds, text: c.pin.text } };
      if (c.op === 'close_pin') return { op: 'close_pin', pin_id: c.pinId };
      return null;
    }).filter((c) => c !== null),
    ...(Object.keys(resolutions).length ? { resolutions } : {}),
  };
}

/** One readable line per group of changes (F8 "Unsaved changes", F9 change list). All `Record`. */
export function draftLines(draft: Draft, taskLabel: (id: string) => string, elementLabel: (gid: string) => string): string[] {
  const lines: string[] = [];
  for (const op of ['link', 'unlink'] as const) {
    const byTask = new Map<string, string[]>();
    for (const c of draft.changes) if (c.op === op) byTask.set(c.taskId, [...(byTask.get(c.taskId) ?? []), c.globalId]);
    for (const [taskId, gids] of byTask) {
      const what = gids.length === 1 ? elementLabel(gids[0]) : `${gids.length} elements`;
      lines.push(op === 'link' ? `Linked ${what} to ${taskLabel(taskId)}` : `Unlinked ${what} from ${taskLabel(taskId)}`);
    }
  }
  for (const c of draft.changes) {
    if (c.op === 'pin') lines.push(`Issue pinned on ${c.pin.globalIds.length === 1 ? elementLabel(c.pin.globalIds[0]) : `${c.pin.globalIds.length} elements`}: “${c.pin.text}”`);
    if (c.op === 'close_pin') lines.push('Issue closed');
  }
  return lines;
}

// ── history (M-15) ────────────────────────────────────────────────────────────

export interface HistoryRow {
  versionNo: number; who: string; when: string; note: string | null; kind: 'upload' | 'edit' | 'restore' | 'other';
  label: string; base: number | null; current: boolean; authorReviewPending: boolean; sizeBytes: number;
}

export function historyRows(doc: V2FileDocument, authorOrgId: string | null, orgName: (id: string) => string): HistoryRow[] {
  const vs = [...doc.versions].sort((a, b) => a.version_no - b.version_no);
  return vs.map((v, i) => {
    const kind = (['upload', 'edit', 'restore'].includes(v.change_kind ?? 'upload') ? (v.change_kind ?? 'upload') : 'other') as HistoryRow['kind'];
    const byAuthor = v.uploaded_by.org_id === authorOrgId;
    const later = vs.slice(i + 1);
    const pending = kind !== 'upload' && !byAuthor && !later.some((x) => x.uploaded_by.org_id === authorOrgId);
    const who = orgName(v.uploaded_by.org_id);
    const label = kind === 'upload' ? who
      : kind === 'restore' ? `Restored v${v.base_version_no ?? '?'} — ${who}`
        : byAuthor ? `${who} (record edit)` : `Edited by ${who}`;
    return {
      versionNo: v.version_no, who, when: v.uploaded_at, note: v.note ?? null, kind, label,
      base: v.base_version_no ?? null, current: v.version_no === doc.current_version,
      authorReviewPending: pending, sizeBytes: v.size_bytes,
    };
  }).reverse();
}

// ── IFC comparison by GlobalId (M-16, M-18) ──────────────────────────────────

export interface IfcElementFacts { name: string; cls: string; props: Record<string, string> }
export type IfcIndex = Map<string, IfcElementFacts>;

export interface FileDiff {
  added: Array<{ globalId: string; name: string; cls: string }>;
  removed: Array<{ globalId: string; name: string; cls: string }>;
  changed: Array<{ globalId: string; name: string; changes: Array<{ key: string; from: string | null; to: string | null }> }>;
}

export function compareIndexes(a: IfcIndex, b: IfcIndex): FileDiff {
  const out: FileDiff = { added: [], removed: [], changed: [] };
  for (const [gid, f] of b) if (!a.has(gid)) out.added.push({ globalId: gid, name: f.name, cls: f.cls });
  for (const [gid, f] of a) {
    const g = b.get(gid);
    if (!g) { out.removed.push({ globalId: gid, name: f.name, cls: f.cls }); continue; }
    const changes: FileDiff['changed'][number]['changes'] = [];
    if (f.name !== g.name) changes.push({ key: 'Name', from: f.name, to: g.name });
    if (f.cls !== g.cls) changes.push({ key: 'IFC class', from: f.cls, to: g.cls });
    for (const key of new Set([...Object.keys(f.props), ...Object.keys(g.props)])) {
      const x = f.props[key] ?? null;
      const y = g.props[key] ?? null;
      if (x !== y) changes.push({ key, from: x, to: y });
    }
    if (changes.length) out.changed.push({ globalId: gid, name: g.name, changes });
  }
  return out;
}

export function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** "IFCWALLSTANDARDCASE" → "IfcWallStandardCase"-ish readable class. */
export function prettyClass(raw: string): string {
  const base = raw.replace(/^IFC/i, '').toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
  return `Ifc${base.charAt(0).toUpperCase()}${base.slice(1)}`;
}
