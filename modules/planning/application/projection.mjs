// Wire projections (openapi.yaml Task / Segment / PlanHealth), computed from
// a plan snapshot per viewer. Withheld or unknown fields are ABSENT, never
// null (doc 04). Segments are render-ready (doc 05 §5): no client computes
// baseline/extension geometry.
import { makeCalendar, durationWd } from '../domain/calendar.mjs';
import { inEditScope, effectiveAssignee } from '../domain/scope.mjs';
import { effectiveSpans } from '../domain/propagation.mjs';

/** children index — a row with children renders as a summary (doc 05 §2). */
export function childCounts(tasks) {
  const counts = new Map();
  for (const t of tasks.values()) {
    if (t.parentId) counts.set(t.parentId, (counts.get(t.parentId) ?? 0) + 1);
  }
  return counts;
}

export function segmentsOf(task, span, today) {
  const segments = [];
  if (task.baselineStart && task.baselineFinish) {
    segments.push({ kind: 'baseline', from: task.baselineStart, to: task.baselineFinish });
    if (span.start && span.start > task.baselineStart) {
      segments.push({ kind: 'delay_start', from: task.baselineStart, to: span.start });
    }
  }
  if (span.start && span.finish) {
    segments.push({ kind: 'current', from: span.start, to: span.finish });
    if (task.baselineFinish && span.finish > task.baselineFinish) {
      segments.push({ kind: 'extension', from: task.baselineFinish, to: span.finish });
    }
  }
  if (task.actualStart) {
    segments.push({ kind: 'actual', from: task.actualStart, to: task.actualFinish ?? today });
  }
  return segments;
}

/**
 * One row on the wire.
 * @param {object} ctx {tasks, counts, spans, world, statuses, orgNames, today, viewerOrgId}
 */
export function taskBody(task, ctx) {
  const span = ctx.spans.get(task.id) ?? { start: null, finish: null };
  const assignee = effectiveAssignee(ctx.tasks, task.id);
  const hasKids = (ctx.counts.get(task.id) ?? 0) > 0;
  const canEdit = inEditScope(ctx.world, task, ctx.viewerOrgId);
  return {
    id: task.id,
    project_id: task.projectId,
    parent_id: task.parentId,
    depth: task.depth,
    position: task.position,
    kind: hasKids ? 'summary' : task.kind,
    name: task.name,
    description: task.description ?? undefined,
    specialty: task.specialty ?? undefined,
    location_id: task.locationId ?? undefined,
    assignee: assignee
      ? {
          org_id: assignee.orgId,
          org_name: ctx.orgNames?.get(assignee.orgId) ?? undefined,
          person_id: assignee.personId ?? undefined,
          inherited: assignee.inherited,
        }
      : undefined,
    dating_mode: task.datingMode,
    start: span.start,
    finish: span.finish,
    duration_wd: task.durationWd ?? undefined,
    actual_start: task.actualStart,
    actual_finish: task.actualFinish,
    baseline: task.baselineStart
      ? { start: task.baselineStart, finish: task.baselineFinish, version: task.baselineVersion ?? 1 }
      : null,
    segments: segmentsOf(task, span, ctx.today),
    schedule_state: task.scheduleState,
    status: ctx.statuses?.get(task.id) ?? 'not_started',
    acceptance_criteria: task.acceptanceCriteria ?? undefined,
    can_edit: canEdit,
    editor_is_assignee: assignee ? assignee.orgId === ctx.viewerOrgId : undefined,
    last_change: task.lastChangedAt
      ? {
          by: { person_id: task.lastChangedByPersonId ?? undefined, org_id: task.lastChangedByOrgId ?? undefined },
          at: task.lastChangedAt,
          cause: task.lastChangeCause ?? undefined,
        }
      : undefined,
  };
}

export function linkBody(l) {
  return {
    id: l.id,
    predecessor_id: l.predecessorId,
    successor_id: l.successorId,
    from_anchor: l.fromAnchor,
    to_anchor: l.toAnchor,
    lag_wd: l.lagWd,
    created_by: { org_id: l.createdByOrgId ?? undefined, person_id: l.createdByPersonId ?? undefined },
  };
}

/**
 * Plan health (doc 05 §9) — computed, never blocking.
 * `costedTaskIds` comes from the BoQ (contracting) read port.
 */
export function planHealth({ tasks, links, statuses, costedTaskIds }) {
  const counts = childCounts(tasks);
  const ref = (t, note) => ({ id: t.id, name: t.name, ...(note ? { note } : {}) });
  const leaves = [...tasks.values()].filter((t) => (counts.get(t.id) ?? 0) === 0);
  const undated = leaves.filter((t) => !t.start && !t.actualStart);
  const unassigned = leaves.filter((t) => !effectiveAssignee(tasks, t.id));
  const datedSuccessorsOf = new Set(
    links
      .filter((l) => {
        const s = tasks.get(l.successorId);
        return s && (s.start || s.actualStart);
      })
      .map((l) => l.predecessorId),
  );
  const openExternal = leaves.filter(
    (t) => t.datingMode === 'external' && !t.actualFinish && datedSuccessorsOf.has(t.id),
  );
  const warned = [...tasks.values()].filter((t) => t.scheduleState === 'sequence_warning');
  const uncosted = costedTaskIds
    ? leaves.filter((t) => t.kind === 'task' && !costedTaskIds.has(t.id))
    : [];
  return {
    undated_rows: undated.map((t) => ref(t)),
    unassigned_rows: unassigned.map((t) => ref(t)),
    open_external: openExternal.map((t) => ref(t, 'dated successors wait on its actual date')),
    sequence_warnings: warned.map((t) => ref(t)),
    uncosted_rows: uncosted.map((t) => ref(t)),
    blocking: false,
  };
}

/** Everything taskBody needs, from a snapshot. */
export function projectionCtx(snapshot, viewerOrgId, today) {
  return {
    tasks: snapshot.tasks,
    counts: childCounts(snapshot.tasks),
    spans: effectiveSpans(snapshot.tasks),
    world: { ownerOrgId: snapshot.ownerOrgId, contracts: snapshot.contracts },
    statuses: snapshot.statuses,
    orgNames: snapshot.orgNames,
    viewerOrgId,
    today,
  };
}

/** Planned duration of a row, derived from its span when not stored. */
export function currentDuration(cal, task, span) {
  if (task.durationWd != null) return task.durationWd;
  if (span.start && span.finish) return durationWd(cal, span.start, span.finish);
  return null;
}

export { makeCalendar };
