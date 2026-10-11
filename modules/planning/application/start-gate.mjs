// The start of a task and its close against the acceptance criteria
// (PRD-10 E-5, E-6) — the application half reportProgress and getTask call.
//
// E-5 is D-48's second half, "warn and record" (D-23 — show the change, do not
// gate it): starting a task whose predecessors are not there yet is refused
// only until the reporter gives a reason; with one, the start is accepted and
// the override (reason + the predecessors as they stood) goes on the progress
// report, its ledger entry and the planning.progress.reported event. It is not
// a variation: nothing moved against the baseline, the sequence was jumped —
// and the progress report is already the append-only, ledgered record of the
// start (doc 05 §13, doc 08).
import { ProblemError } from '../../../platform/errors.mjs';
import {
  waitingOn, isStart, acceptanceChecklist, acceptanceRecord, waitingSnapshot,
} from '../domain/execution.mjs';

/** What the task waits on, for the task panel (Task.waiting_on). */
export function waitingOnOf(snapshot, taskId) {
  return waitingOn({ taskId, tasks: snapshot.tasks, links: snapshot.links ?? [], statuses: snapshot.statuses });
}

/** Validation of the two E-5/E-6 fields of a ProgressCreate. Adds to `errors`. */
export function validateRunFields(body, errors) {
  if (body?.override_reason != null) {
    const r = body.override_reason;
    if (typeof r !== 'string' || !r.trim() || r.trim().length > 500) errors.override_reason = '1 to 500 characters';
  }
  if (body?.criteria_met != null) {
    if (body.status !== 'done') errors.criteria_met = 'criteria_met goes with done only';
    else if (!Array.isArray(body.criteria_met) || body.criteria_met.length > 50) errors.criteria_met = 'at most 50 criteria';
  }
}

/**
 * E-5: is this report a start that jumps the queue? Throws 409
 * `predecessors_open` without a reason; with one, answers what to record.
 * @returns {{reason: string, waiting_on: Array<object>} | null}
 */
export function startOverride({ snapshot, task, nextStatus, overrideReason }) {
  const currentStatus = snapshot.statuses?.get(task.id) ?? 'not_started';
  if (!isStart(task, currentStatus, nextStatus)) return null;
  const open = waitingOnOf(snapshot, task.id).filter((w) => !w.met);
  if (!open.length) return null;
  const reason = typeof overrideReason === 'string' ? overrideReason.trim() : '';
  if (!reason) {
    throw new ProblemError('invalid_transition',
      `this task waits on ${open.length} task${open.length === 1 ? '' : 's'} that ${open.length === 1 ? 'is' : 'are'} not there yet — `
      + 'give a reason to start it anyway (D-48)',
      { reason: 'predecessors_open', waiting_on: open });
  }
  return { reason, waiting_on: waitingSnapshot(open) };
}

/** E-6: the checklist record of a `done`, or a 422. */
export function acceptanceOnDone({ task, nextStatus, criteriaMet }) {
  if (nextStatus !== 'done') return null;
  const result = acceptanceRecord(acceptanceChecklist(task.acceptanceCriteria), criteriaMet ?? null);
  if (result.error) throw new ProblemError('validation_failed', null, { errors: { criteria_met: result.error } });
  return result.value;
}

/** Task panel fields of getTask (absent when empty, doc 04). */
export function runFields(snapshot, task) {
  const checklist = acceptanceChecklist(task.acceptanceCriteria);
  const waiting = waitingOnOf(snapshot, task.id);
  return {
    ...(checklist.length ? { acceptance_checklist: checklist } : {}),
    ...(waiting.length ? { waiting_on: waiting } : {}),
  };
}

/** ProgressReport fields recorded by E-5/E-6. */
export function runRecordFields(p) {
  return {
    ...(p.overrideReason ? { out_of_sequence: { reason: p.overrideReason, waiting_on: p.waitingOn ?? [] } } : {}),
    ...(p.acceptance ? { acceptance: p.acceptance } : {}),
  };
}
