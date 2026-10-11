// Slippage against the baseline, as the plan draws it (doc 05 §5, PRD-13,
// D-23, D-44). Pure: the plan in memory + `today` in, render-ready numbers out.
// No client computes any of this — the grid only maps the dates to pixels.
//
//   overrun   — a LEAF not closed (no actual finish, status not done/verified)
//               whose current finish is before today runs on to today. It works
//               WITHOUT a baseline (PRD-13 S-9): it compares with the current
//               finish. It is drawn, never stored (D-44).
//   projected — what an overrun would push down its links (D-22 rigid links),
//               computed with the same engine as a real move but NEVER written
//               (D-44): no row's dates change until someone sets a new finish or
//               closes the task.
//   delta     — working days between the baseline finish and the row's
//               effective finish (actual when closed, else the later of the
//               planned / projected finish and today when overrunning). Summary
//               rows carry their net over the subtree.
import { workingDaysDelta } from './calendar.mjs';
import { propagate, effectiveSpans } from './propagation.mjs';

export const CLOSED_STATUSES = new Set(['done', 'verified']);

/** A row is closed when it carries an actual finish or reports done/verified. */
export function isClosed(task, status) {
  return Boolean(task.actualFinish) || CLOSED_STATUSES.has(status);
}

/**
 * The overrun picture of the whole plan. Returns:
 *   overrunIds — leaves running past their finish (not closed, finish < today);
 *   projected  — Map id → {start, finish, causeTaskId} for rows an overrun
 *                would push (never the overrunning rows themselves);
 *   spans      — effective spans WITH the overruns stretched to today and the
 *                projected pushes applied (the "as things stand today" plan).
 */
export function overrunPicture({ tasks, links, calendar, statuses, counts, today }) {
  const overrunIds = new Set();
  const stretched = new Map(tasks);
  for (const t of tasks.values()) {
    if ((counts.get(t.id) ?? 0) > 0) continue; // summaries derive from leaves
    if (!t.finish || isClosed(t, statuses?.get(t.id))) continue;
    if (today > t.finish) {
      overrunIds.add(t.id);
      stretched.set(t.id, { ...t, finish: today });
    }
  }
  const projected = new Map();
  if (overrunIds.size) {
    const { moves } = propagate({ tasks: stretched, links, calendar, seedIds: [...overrunIds] });
    for (const m of moves) {
      if (overrunIds.has(m.id)) continue;
      const before = tasks.get(m.id);
      if (before && before.start === m.start && before.finish === m.finish) continue;
      projected.set(m.id, { start: m.start, finish: m.finish, causeTaskId: m.causeTaskId });
      stretched.set(m.id, { ...stretched.get(m.id), start: m.start, finish: m.finish });
    }
  }
  return { overrunIds, projected, spans: effectiveSpans(stretched) };
}

/**
 * Baseline finish per row: a leaf's own; a summary's the latest baseline finish
 * in its subtree (its own stored one when the subtree carries none).
 */
export function baselineFinishes(tasks, counts) {
  const kids = new Map();
  for (const t of tasks.values()) {
    if (!t.parentId) continue;
    if (!kids.has(t.parentId)) kids.set(t.parentId, []);
    kids.get(t.parentId).push(t.id);
  }
  const memo = new Map();
  const of = (id) => {
    if (memo.has(id)) return memo.get(id);
    const t = tasks.get(id);
    let finish = null;
    if ((counts.get(id) ?? 0) > 0) {
      for (const c of kids.get(id) ?? []) {
        const f = of(c);
        if (f && (!finish || f > finish)) finish = f;
      }
    }
    if (!finish) finish = t?.baselineFinish ?? null;
    memo.set(id, finish);
    return finish;
  };
  for (const id of tasks.keys()) of(id);
  return memo;
}

/** Why a row's bar grew, from its open time variation (or its last change). */
export function slipCause(task, timeVariation) {
  if (timeVariation) {
    return timeVariation.cause === 'propagated'
      ? { cause: 'pushed', cause_task_id: timeVariation.causeTaskId ?? undefined }
      : { cause: 'moved', by_org_id: timeVariation.lastChangedByOrgId ?? undefined };
  }
  const m = /^propagated from (.+)$/.exec(task.lastChangeCause ?? '');
  return m
    ? { cause: 'pushed', cause_task_id: m[1] }
    : { cause: 'moved', by_org_id: task.lastChangedByOrgId ?? undefined };
}

/**
 * Render-ready segments for one row (openapi Segment). Every clay segment
 * (extension, overrun, projected) carries delta_wd + cause so the label never
 * relies on colour alone (PRD-13 S-4).
 *
 * @param {object} row {task, span, status, isLeaf, overrunning, projected,
 *                      timeVariation, today, calendar}
 */
export function segmentsOf({ task, span, status, isLeaf, overrunning, projected, timeVariation, today, calendar }) {
  const wd = (a, b) => workingDaysDelta(calendar, a, b);
  const closed = isClosed(task, status);
  const hasBaseline = Boolean(task.baselineStart && task.baselineFinish);
  const segments = [];
  if (hasBaseline) {
    const moved = span.start !== task.baselineStart || span.finish !== task.baselineFinish;
    segments.push({ kind: 'baseline', from: task.baselineStart, to: task.baselineFinish, moved });
    if (span.start && span.start > task.baselineStart) {
      segments.push({ kind: 'delay_start', from: task.baselineStart, to: span.start });
    }
  }
  if (span.start && span.finish) {
    segments.push({ kind: 'current', from: span.start, to: span.finish });
  }
  if (hasBaseline && span.finish && span.finish > task.baselineFinish) {
    const cause = !isLeaf
      ? { cause: 'net' }
      : task.actualFinish ? { cause: 'closed_late' } : slipCause(task, timeVariation);
    segments.push({
      kind: 'extension', from: task.baselineFinish, to: span.finish,
      delta_wd: wd(task.baselineFinish, span.finish), ...cause,
    });
  }
  if (isLeaf && overrunning && span.finish) {
    segments.push({
      kind: 'overrun', from: span.finish, to: today,
      delta_wd: wd(span.finish, today), cause: 'not_closed',
    });
  }
  if (isLeaf && projected && span.finish && projected.finish > span.finish) {
    segments.push({
      kind: 'projected', from: span.finish, to: projected.finish,
      delta_wd: wd(span.finish, projected.finish), cause: 'pushed',
      cause_task_id: projected.causeTaskId ?? undefined,
    });
  }
  if (task.actualStart) {
    const actual = { kind: 'actual', from: task.actualStart, to: task.actualFinish ?? today };
    if (closed && hasBaseline && task.actualFinish && task.actualFinish < task.baselineFinish) {
      actual.delta_wd = wd(task.baselineFinish, task.actualFinish);
      actual.cause = 'closed_early';
    }
    segments.push(actual);
  }
  return segments;
}

/**
 * The handover (project finish) picture for the header (PRD-13 S-6):
 *   finish           — the latest planned/actual finish as stored;
 *   projected_finish — the same with today's overruns and their pushes;
 *   baseline_finish  — the latest baseline finish (absent without a baseline);
 *   delta_wd         — baseline → projected, working days (absent without one).
 */
export function handoverOf({ tasks, spans, projectedSpans, baselineFinishById, calendar }) {
  const latest = (values) => {
    let max = null;
    for (const v of values) if (v && (!max || v > max)) max = v;
    return max;
  };
  const roots = [...tasks.values()].filter((t) => !t.parentId || !tasks.has(t.parentId));
  const finish = latest(roots.map((t) => spans.get(t.id)?.finish));
  const projectedFinish = latest(roots.map((t) => projectedSpans.get(t.id)?.finish)) ?? finish;
  const baselineFinish = latest(roots.map((t) => baselineFinishById.get(t.id)));
  const out = {};
  if (finish) out.finish = finish;
  if (projectedFinish) out.projected_finish = projectedFinish;
  if (baselineFinish) {
    out.baseline_finish = baselineFinish;
    if (projectedFinish) out.delta_wd = workingDaysDelta(calendar, baselineFinish, projectedFinish);
  }
  return out;
}
