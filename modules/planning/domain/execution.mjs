// Running a task (PRD-10 E-5, E-6; D-48 "warn and record", D-23). Pure.
//
// What a task waits on to START: the predecessors of the links that land on
// its start anchor. A link from the predecessor's END (classic FS) needs the
// predecessor closed; a link from its START (SS) needs it started. Links into
// the successor's END (FF, SF) hold its finish, not its start — they never
// gate starting. Nothing here blocks: the use case asks for a reason when a
// start would jump the queue and records it (D-48).
//
// Acceptance criteria are the baselined text `task.acceptance_criteria`, one
// criterion per line; closing records which were met.
import { CLOSED_STATUSES } from './slippage.mjs';

const STARTED_STATUSES = new Set(['in_progress', 'blocked', 'done', 'verified']);

export function hasStarted(task, status) {
  return Boolean(task?.actualStart || task?.actualFinish) || STARTED_STATUSES.has(status);
}

export function hasFinished(task, status) {
  return Boolean(task?.actualFinish) || CLOSED_STATUSES.has(status);
}

/**
 * @param {{taskId: string, tasks: Map, links: Array, statuses: Map}} plan
 * @returns {Array<{task_id, name, status, needs: 'finished'|'started', met: boolean, link_id}>}
 */
export function waitingOn({ taskId, tasks, links, statuses }) {
  const out = [];
  for (const l of links) {
    if (l.successorId !== taskId || l.toAnchor !== 'start') continue;
    const pred = tasks.get(l.predecessorId);
    if (!pred || pred.deletedAt) continue;
    const status = statuses?.get(pred.id) ?? 'not_started';
    const needs = l.fromAnchor === 'end' ? 'finished' : 'started';
    const met = needs === 'finished' ? hasFinished(pred, status) : hasStarted(pred, status);
    out.push({ task_id: pred.id, name: pred.name, status, needs, met, link_id: l.id });
  }
  return out.sort((a, b) => Number(a.met) - Number(b.met) || a.name.localeCompare(b.name));
}

/**
 * A report STARTS the task when the task has not started yet and the new
 * status is past not_started.
 */
export function isStart(task, currentStatus, nextStatus) {
  return nextStatus !== 'not_started' && !hasStarted(task, currentStatus);
}

const MARKER = /^\s*(?:[-*•]|\d+[.)]|\[\s?[xX ]?\s?\])\s+/;

/** acceptance_criteria → checklist: one item per non-empty line, markers removed. */
export function acceptanceChecklist(text) {
  if (typeof text !== 'string') return [];
  const seen = new Set();
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const item = raw.replace(MARKER, '').trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item.slice(0, 500));
  }
  return out.slice(0, 50);
}

/**
 * The record of a close against the checklist. `criteriaMet` must name items
 * of the checklist verbatim.
 * @returns {{error: string} | {value: Array<{criterion, met}> | null}}
 */
export function acceptanceRecord(checklist, criteriaMet) {
  if (criteriaMet != null) {
    if (!Array.isArray(criteriaMet) || criteriaMet.some((c) => typeof c !== 'string')) {
      return { error: 'a list of criteria from the task’s checklist' };
    }
    const unknown = criteriaMet.filter((c) => !checklist.includes(c.trim()));
    if (unknown.length) return { error: `not on the task’s checklist: ${unknown.slice(0, 3).join('; ')}` };
  }
  if (!checklist.length) return { value: null };
  const met = new Set((criteriaMet ?? []).map((c) => c.trim()));
  return { value: checklist.map((criterion) => ({ criterion, met: met.has(criterion) })) };
}

/** The predecessors as they stood, for the record (no link ids, no `met`). */
export function waitingSnapshot(waiting) {
  return waiting.filter((w) => !w.met).map(({ task_id, name, status, needs }) => ({ task_id, name, status, needs }));
}
