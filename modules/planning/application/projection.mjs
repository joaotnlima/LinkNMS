// Wire projections (openapi.yaml Task / Segment / PlanHealth), computed from
// a plan snapshot per viewer. Withheld or unknown fields are ABSENT, never
// null (doc 04). Segments are render-ready (doc 05 §5): no client computes
// baseline/extension geometry.
import { makeCalendar, durationWd } from '../domain/calendar.mjs';
import { inEditScope, effectiveAssignee } from '../domain/scope.mjs';
import { effectiveSpans } from '../domain/propagation.mjs';
import { variationVisibleTo } from '../domain/variations.mjs';
import { lineAmountCents } from '../domain/cost-lines.mjs';

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
    ...costField(task.id, ctx),
    ...openVariationsField(task.id, ctx),
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

/**
 * Task.cost — the D-38 / checks §2 roll-up: over the row's SUBTREE, live
 * (non-superseded) lines only; revenue = Σ where the viewer org is the
 * line-contract's supplier, cost = Σ where it is the client or the estimate
 * owner; margin when both. NOTHING visible → the field is ABSENT, not zero.
 */
function costField(taskId, ctx) {
  const totals = ctx.costRollups?.get(taskId);
  if (!totals || (totals.revenue == null && totals.cost == null)) return {};
  const eur = (cents) => ({ amount_cents: cents, currency: 'EUR' });
  return {
    cost: {
      ...(totals.revenue != null ? { revenue: eur(totals.revenue) } : {}),
      ...(totals.cost != null ? { cost: eur(totals.cost) } : {}),
      ...(totals.revenue != null && totals.cost != null
        ? { margin: eur(totals.revenue - totals.cost) }
        : {}),
    },
  };
}

function openVariationsField(taskId, ctx) {
  if (!ctx.variationsByTask) return {};
  const open = (ctx.variationsByTask.get(taskId) ?? []).filter(
    (v) => ['open', 'acknowledged'].includes(v.status)
      && variationVisibleTo(v, ctx.viewerOrgId, { contracts: ctx.world.contracts }),
  );
  return open.length ? { open_variations: open.length } : {};
}

/** api/v2 Variation — history derived at read time (ruling 12). */
export function variationBody(v, { taskName, history = [] } = {}) {
  return {
    id: v.id,
    task_id: v.taskId,
    task_name: taskName ?? v.taskName ?? undefined,
    kind: v.kind,
    baseline_value: v.baselineValue ?? null,
    current_value: v.currentValue ?? null,
    delta: v.delta,
    cause: v.cause,
    cause_task_id: v.causeTaskId ?? undefined,
    last_changed_by: { org_id: v.lastChangedByOrgId },
    first_changed_at: iso(v.firstChangedAt),
    last_changed_at: iso(v.lastChangedAt),
    status: v.status,
    acknowledged_by: (v.acks ?? []).map((a) => ({ person_id: a.personId, at: iso(a.acknowledgedAt) })),
    change_order_id: v.changeOrderId ?? undefined,
    history,
  };
}

function iso(value) {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Per-viewer subtree cost roll-up for every row, in one bottom-up pass. */
function costRollups(snapshot, viewerOrgId) {
  const lines = snapshot.boqLines ?? [];
  if (!lines.length) return new Map();
  const own = new Map(); // taskId → {revenue, cost} nullable
  const add = (map, id, side, cents) => {
    const t = map.get(id) ?? { revenue: null, cost: null };
    t[side] = (t[side] ?? 0) + cents;
    map.set(id, t);
  };
  for (const l of lines) {
    if (l.supersededByChangeOrderId != null || !l.taskId) continue;
    const amount = lineAmountCents(l.quantity, l.unitPriceCents);
    if (l.contractId) {
      const c = snapshot.contracts.get(l.contractId);
      if (!c) continue;
      if (c.supplierOrgId === viewerOrgId) add(own, l.taskId, 'revenue', amount);
      if (c.clientOrgId === viewerOrgId) add(own, l.taskId, 'cost', amount);
    } else if (l.estimateOwnerOrgId === viewerOrgId) {
      add(own, l.taskId, 'cost', amount);
    }
  }
  if (!own.size) return new Map();
  const rolled = new Map();
  const byDepth = [...snapshot.tasks.values()].sort((a, b) => b.depth - a.depth);
  for (const t of byDepth) {
    const mine = own.get(t.id);
    const sub = rolled.get(t.id) ?? { revenue: null, cost: null };
    const totals = {
      revenue: mine?.revenue != null || sub.revenue != null ? (mine?.revenue ?? 0) + (sub.revenue ?? 0) : null,
      cost: mine?.cost != null || sub.cost != null ? (mine?.cost ?? 0) + (sub.cost ?? 0) : null,
    };
    rolled.set(t.id, totals);
    if (t.parentId && (totals.revenue != null || totals.cost != null)) {
      const p = rolled.get(t.parentId) ?? { revenue: null, cost: null };
      if (totals.revenue != null) p.revenue = (p.revenue ?? 0) + totals.revenue;
      if (totals.cost != null) p.cost = (p.cost ?? 0) + totals.cost;
      rolled.set(t.parentId, p);
    }
  }
  return rolled;
}

/** Everything taskBody needs, from a snapshot. */
export function projectionCtx(snapshot, viewerOrgId, today) {
  const variationsByTask = new Map();
  for (const v of snapshot.variations?.values() ?? []) {
    const list = variationsByTask.get(v.taskId) ?? [];
    list.push(v);
    variationsByTask.set(v.taskId, list);
  }
  return {
    tasks: snapshot.tasks,
    counts: childCounts(snapshot.tasks),
    spans: effectiveSpans(snapshot.tasks),
    world: { ownerOrgId: snapshot.ownerOrgId, contracts: snapshot.contracts },
    statuses: snapshot.statuses,
    orgNames: snapshot.orgNames,
    viewerOrgId,
    today,
    costRollups: costRollups(snapshot, viewerOrgId),
    variationsByTask,
  };
}

/** Planned duration of a row, derived from its span when not stored. */
export function currentDuration(cal, task, span) {
  if (task.durationWd != null) return task.durationWd;
  if (span.start && span.finish) return durationWd(cal, span.start, span.finish);
  return null;
}

export { makeCalendar };
