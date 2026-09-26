// Variations engine + digest windowing — pure (no I/O), doc 05 §6, doc 09.
//
// A CONTROLLED row is a row inside a baselined branch (its contract has at
// least one planning.baseline). Every write touching a controlled row records
// or refreshes ONE net variation per (task, kind, scope) — the one_open_variation
// unique index is the DB shape of that sentence:
//   time  — effective start/finish vs the baseline dates (direct edits AND
//           link propagation, cause carried through);
//   scope — row added/removed after baseline, scope/acceptance text changed
//           (scope_type = 'project');
//   cost / material — cost-line totals / material spec on the row, per
//           contract (scope_type = 'contract'; the DB CHECK ties them).
// Back to baseline → the open variation CLOSES. A new change on an
// ACKNOWLEDGED row+kind reopens it (doc 09 §Variation).
import { workingDaysDelta } from './calendar.mjs';

export const VARIATION_KEY = (taskId, kind, scopeId) => `${taskId}|${kind}|${scopeId}`;

/** A row is controlled when its branch contract has a baseline. */
export function isControlled(task, baselinedContractIds) {
  const contractId = task?.contractId ?? task?.branchContractId ?? null;
  return contractId != null && baselinedContractIds.has(contractId);
}

/**
 * Net TIME position of a controlled row vs its baseline (effective dates:
 * actuals win over plan). Returns {changed, baseline_value, current_value,
 * delta} — delta in working days, null when a side is undated.
 */
export function timePosition(task, calendar) {
  const baseline = { start: task.baselineStart ?? null, finish: task.baselineFinish ?? null };
  const current = {
    start: task.actualStart ?? task.start ?? null,
    finish: task.actualFinish ?? task.finish ?? null,
  };
  const wd = (a, b) => (a && b ? workingDaysDelta(calendar, a, b) : null);
  return {
    changed: baseline.start !== current.start || baseline.finish !== current.finish,
    baseline_value: baseline,
    current_value: current,
    delta: {
      start_wd: wd(baseline.start, current.start),
      finish_wd: wd(baseline.finish, current.finish),
    },
  };
}

/** Net SCOPE-TEXT position vs the baseline snapshot (baseline_task row). */
export function scopeTextPosition(task, baselineText) {
  const baseline = {
    scope_text: baselineText?.scopeText ?? null,
    acceptance_criteria: baselineText?.acceptanceCriteria ?? null,
  };
  const current = {
    scope_text: task.description ?? null,
    acceptance_criteria: task.acceptanceCriteria ?? null,
  };
  return {
    changed: baseline.scope_text !== current.scope_text
      || baseline.acceptance_criteria !== current.acceptance_criteria,
    baseline_value: baseline,
    current_value: current,
    delta: {
      scope_text_changed: baseline.scope_text !== current.scope_text,
      acceptance_criteria_changed: baseline.acceptance_criteria !== current.acceptance_criteria,
    },
  };
}

/** Net COST position: the row's line total for one contract, in cents. */
export function costPosition({ baselineTotalCents, currentTotalCents }) {
  return {
    changed: baselineTotalCents !== currentTotalCents,
    baseline_value: { total_cents: baselineTotalCents },
    current_value: { total_cents: currentTotalCents },
    delta: { amount_cents: currentTotalCents - baselineTotalCents },
  };
}

/**
 * What to do with the (task, kind, scope) slot given the net position:
 *   record — changed, no open variation;
 *   update — changed, open variation (reopen when it was acknowledged);
 *   close  — back to baseline while a variation is open;
 *   null   — nothing to say.
 */
export function variationAction({ existing, changed }) {
  if (changed) {
    if (!existing) return 'record';
    return existing.status === 'acknowledged' ? 'reopen' : 'update';
  }
  return existing ? 'close' : null;
}

/**
 * Doc 04 V2/V5: time and scope variations are visible to every participant;
 * cost and material only to parties of the scope contract (and the owner
 * never sees sub-level numbers this way — it is simply not a party).
 */
export function variationVisibleTo(variation, viewerOrgId, { contracts }) {
  if (!['cost', 'material'].includes(variation.kind)) return true;
  const contract = contracts.get(variation.scopeId ?? variation.scope_id);
  if (!contract) return false;
  return viewerOrgId === contract.clientOrgId || viewerOrgId === contract.supplierOrgId;
}

// ── digest windowing (doc 05 §6: one notification per project per 15 min) ──

export const DIGEST_WINDOW_MS = 15 * 60 * 1000;

/** The window an instant falls into: [start, end), aligned to the epoch. */
export function windowOf(at, windowMs = DIGEST_WINDOW_MS) {
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  const start = Math.floor(t / windowMs) * windowMs;
  return { start: new Date(start), end: new Date(start + windowMs) };
}

/**
 * Group variation events into digest windows per project — the pure heart of
 * the outbox consumer. `events`: [{project_id, variation_id, occurred_at}].
 * Returns [{project_id, window_start, window_end, variation_ids}] ordered.
 */
export function digestWindows(events, windowMs = DIGEST_WINDOW_MS) {
  const groups = new Map();
  for (const evt of events) {
    const { start, end } = windowOf(evt.occurred_at, windowMs);
    const key = `${evt.project_id}|${start.getTime()}`;
    let group = groups.get(key);
    if (!group) {
      group = { project_id: evt.project_id, window_start: start, window_end: end, variation_ids: [] };
      groups.set(key, group);
    }
    if (!group.variation_ids.includes(evt.variation_id)) group.variation_ids.push(evt.variation_id);
  }
  return [...groups.values()].sort(
    (a, b) => a.window_start - b.window_start || (a.project_id < b.project_id ? -1 : 1),
  );
}

/**
 * The net numbers of one digest, per recipient org (visibility applied):
 * finish delta from TIME variations; cost delta only from cost/material
 * variations of contracts the org is party to — none visible → null (absent
 * beats zero, §6.5).
 */
export function digestNet(variations, orgId, { contracts }) {
  let finishWd = 0;
  let cost = null;
  for (const v of variations) {
    if (v.status === 'closed') continue;
    if (v.kind === 'time') finishWd += Number(v.delta?.finish_wd ?? 0);
    if (['cost', 'material'].includes(v.kind) && variationVisibleTo(v, orgId, { contracts })) {
      cost = (cost ?? 0) + Number(v.delta?.amount_cents ?? 0);
    }
  }
  return { net_project_finish_delta_wd: finishWd, net_cost_delta_cents: cost };
}
