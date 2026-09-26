// Planning module use cases (phase 4) — one function per operationId.
//
// Authorization is the doc-16 conjunction: permission (token) ∧ relationship ∧
// staffing. Relationships here:
//   project.participant — read the plan (doc 04 V1: time is visible to all);
//   edit scope ∋ row    — D-33: the branch supplier, every client above it in
//                         the contract chain, the owner everywhere.
// Concurrency is D-26: field-level deltas with last-write-wins, `base` values
// detect overwrites (applied AND reported), `client_change_id` makes retries
// idempotent. Every write runs in ONE plan transaction (per-project advisory
// lock in the store): apply → re-run links (domain/propagation) → persist the
// moved rows → ledger + outbox on the same client.
//
// Store contract (infra/pg-store.mjs or a test fake):
//   getPersonByClerkId, getProject, isParticipant, isStaffed,
//   getTask, getLink, loadPlan(projectId) → snapshot,
//   listFieldChanges(taskId), listProgress(taskId),
//   idempotent({key, caller, operationId, body}, fn),
//   withPlanTx(projectId, fn, {dryRun}) → fn(plan) where plan is the snapshot
//     plus hasChange(clientChangeId) and write.{insertTask, patchTask,
//     softDelete, fieldChange, insertLink, patchLink, removeLink, ledger,
//     publish}.
// Snapshot: {tasks: Map, links: [], calendarRaw, contracts: Map, ownerOrgId,
//   statuses: Map, orgNames: Map, costedTaskIds: Set}.
import { randomUUID } from 'node:crypto';

import { ProblemError } from '../../../platform/errors.mjs';
import { makeCalendar, durationWd, spanFinish, workingDaysDelta } from '../domain/calendar.mjs';
import { propagate, cyclePath, descendantIds, effectiveSpans, lagFor } from '../domain/propagation.mjs';
import { inEditScope, effectiveAssignee } from '../domain/scope.mjs';
import { keyBetween, keysBetween } from '../domain/position.mjs';
import {
  VARIATION_KEY, isControlled, timePosition, scopeTextPosition, costPosition,
  variationAction, variationVisibleTo,
} from '../domain/variations.mjs';
import { costLineVisibleTo, costLineBody, taskContractTotalCents } from '../domain/cost-lines.mjs';
import { taskBody, linkBody, planHealth, projectionCtx, variationBody } from './projection.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATING_MODES = new Set(['dated', 'undated', 'external']);
const ANCHORS = new Set(['start', 'end']);
const DELTA_FIELDS = new Set([
  'name', 'description', 'kind', 'specialty', 'location_id', 'dating_mode',
  'start', 'finish', 'duration_wd', 'assignee_org_id', 'assignee_person_id',
  'acceptance_criteria',
]);

// ── reads ──────────────────────────────────────────────────────────────────

/** operationId: getSchedule */
export async function getSchedule({ viewer, store, projectId, query }) {
  await requireParticipant({ viewer, store, projectId });
  const snapshot = await store.loadPlan(projectId);
  const ctx = projectionCtx(snapshot, viewer.orgId, today());
  let tasks = [...snapshot.tasks.values()];
  if (query?.root) {
    const keep = new Set([query.root, ...descendantIds(snapshot.tasks, query.root)]);
    tasks = tasks.filter((t) => keep.has(t.id));
  }
  if (query?.depth) {
    const max = Number(query.depth);
    if (Number.isInteger(max) && max >= 1) tasks = tasks.filter((t) => t.depth <= max);
  }
  if (query?.assignee) {
    tasks = tasks.filter((t) => effectiveAssignee(snapshot.tasks, t.id)?.orgId === query.assignee);
  }
  if (query?.location) tasks = tasks.filter((t) => t.locationId === query.location);
  if (query?.status) tasks = tasks.filter((t) => (snapshot.statuses.get(t.id) ?? 'not_started') === query.status);
  if (query?.state) tasks = tasks.filter((t) => t.scheduleState === query.state);
  return {
    status: 200,
    body: {
      project_id: projectId,
      tasks: tasks
        .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
        .map((t) => taskBody(t, ctx)),
      links: snapshot.links.map(linkBody),
      calendar: snapshot.calendarRaw,
      health: planHealth(snapshot),
    },
  };
}

/** operationId: getTask */
export async function getTask({ viewer, store, taskId }) {
  const task = await store.getTask(taskId);
  if (!task || task.deletedAt) throw new ProblemError(task?.deletedAt ? 'gone' : 'not_found');
  await requireParticipant({ viewer, store, projectId: task.projectId });
  const snapshot = await store.loadPlan(task.projectId);
  const ctx = projectionCtx(snapshot, viewer.orgId, today());
  const history = await store.listFieldChanges(taskId);
  const progress = await store.listProgress(taskId);
  const variations = await store.listVariations(task.projectId, { taskId });
  return {
    status: 200,
    body: {
      ...taskBody(snapshot.tasks.get(taskId), ctx),
      history: history.map((h) => ({
        field: h.field,
        old_value: h.oldValue,
        new_value: h.newValue,
        by: { person_id: h.changedByPersonId, org_id: h.changedByOrgId },
        at: h.changedAt,
        cause: h.cause,
        cause_task_id: h.causeTaskId ?? undefined,
      })),
      progress: progress.map((p) => ({
        seq: p.seq,
        status: p.status,
        percent: p.percent ?? undefined,
        note: p.note ?? undefined,
        by: { person_id: p.reportedByPersonId, org_id: p.reportedByOrgId },
        at: p.reportedAt,
      })),
      variations: variations
        .filter((v) => variationVisibleTo(v, viewer.orgId, { contracts: snapshot.contracts }))
        .map((v) => variationBody(v)),
    },
  };
}

/** operationId: getScheduleHealth */
export async function getScheduleHealth({ viewer, store, projectId, query }) {
  await requireParticipant({ viewer, store, projectId });
  const snapshot = await store.loadPlan(projectId);
  let scoped = snapshot;
  if (query?.root) {
    const keep = new Set([query.root, ...descendantIds(snapshot.tasks, query.root)]);
    scoped = {
      ...snapshot,
      tasks: new Map([...snapshot.tasks].filter(([id]) => keep.has(id))),
      links: snapshot.links.filter((l) => keep.has(l.successorId) || keep.has(l.predecessorId)),
    };
  }
  return { status: 200, body: planHealth(scoped) };
}

// ── row writes ─────────────────────────────────────────────────────────────

/** operationId: createTask */
export async function createTask({ viewer, store, projectId, body, idempotencyKey }) {
  const { actor } = await requireEditor({ viewer, store, projectId });
  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (!body?.name?.trim()) errors.name = 'required';
  if (body?.kind && !['task', 'milestone'].includes(body.kind)) errors.kind = 'task or milestone (summary is derived)';
  if (body?.dating_mode && !DATING_MODES.has(body.dating_mode)) errors.dating_mode = 'dated, undated or external';
  for (const f of ['start', 'finish']) {
    if (body?.[f] != null && !ISO_DATE.test(body[f])) errors[f] = 'an ISO date';
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'createTask', body },
    () => store.withPlanTx(projectId, async (plan) => {
      const cal = makeCalendar(plan.calendarRaw);
      const row = buildRow({ plan, cal, projectId, spec: body, actor: actorOf(actor, viewer) });
      if (!inEditScope(world(plan), row, viewer.orgId)) {
        throw new ProblemError('out_of_scope', 'the parent row is outside your branch scope');
      }
      plan.write.insertTask(row);
      plan.tasks.set(row.id, row);
      const variations = await recordAddedRowVariation({
        plan, projectId, task: row, actor: actorOf(actor, viewer),
      });
      await commitPlanEvent(plan, {
        projectId, actor: actorOf(actor, viewer), type: 'planning.task.created',
        objectId: row.id, payload: { name: row.name, parent_id: row.parentId },
        data: { task_id: row.id, parent_id: row.parentId, name: row.name },
      });
      return { status: 201, body: deltaResult({ plan, viewer, task: row, variations }) };
    }),
  );
}

/** operationId: updateTask — D-26 field-level delta, LWW, propagation. */
export async function updateTask({ viewer, store, taskId, body }) {
  const existing = await store.getTask(taskId);
  if (!existing) throw new ProblemError('not_found');
  if (existing.deletedAt) throw new ProblemError('gone', 'this row was deleted meanwhile');
  const { actor } = await requireEditor({ viewer, store, projectId: existing.projectId, task: existing });

  if (!UUID.test(body?.client_change_id ?? '')) {
    throw new ProblemError('validation_failed', null, { errors: { client_change_id: 'required (uuid)' } });
  }
  const changes = body?.changes ?? {};
  const unknown = Object.keys(changes).filter((f) => !DELTA_FIELDS.has(f));
  if (!Object.keys(changes).length || unknown.length) {
    throw new ProblemError('validation_failed', null, {
      errors: { changes: unknown.length ? `unknown fields: ${unknown.join(', ')}` : 'at least one field' },
    });
  }

  return store.withPlanTx(existing.projectId, async (plan) => {
    const task = plan.tasks.get(taskId);
    if (!task || task.deletedAt) throw new ProblemError('gone', 'this row was deleted meanwhile');
    if (await plan.hasChange(body.client_change_id)) {
      return { status: 200, body: deltaResult({ plan, viewer, task }) }; // idempotent replay
    }
    const cal = makeCalendar(plan.calendarRaw);

    // D-31/D-33: editing someone else's row needs the confirmed intent.
    const assignee = effectiveAssignee(plan.tasks, taskId);
    if (assignee && assignee.orgId !== viewer.orgId && !body.confirm_not_assignee) {
      throw new ProblemError('validation_failed', null, {
        errors: { confirm_not_assignee: 'you are not responsible for this row — confirm to edit it anyway' },
      });
    }

    const { patch, overwrote, fieldChanges } = applyDelta({
      plan, task, cal, changes, viewer, actor,
      clientChangeId: body.client_change_id,
    });

    const updated = { ...task, ...patch };
    plan.tasks.set(taskId, updated);
    plan.write.patchTask(taskId, { ...patch, ...changeStamp(actor, viewer, 'direct') });
    for (const fc of fieldChanges) plan.write.fieldChange(fc);

    // A dragged linked successor keeps its link: the lag absorbs the offset.
    const lagChanges = retuneIncomingLags({ plan, cal, task: updated, changedFields: Object.keys(patch) });

    const propagated = await propagateAndPersist({
      plan, cal, seedIds: [taskId], actor: actorOf(actor, viewer),
      clientChangeId: body.client_change_id,
    });
    const variations = await runScheduleVariations({
      plan, cal, projectId: existing.projectId, seeds: [taskId], propagated,
      actor: actorOf(actor, viewer),
    });

    await commitPlanEvent(plan, {
      projectId: existing.projectId, actor: actorOf(actor, viewer), type: 'planning.task.updated',
      objectId: taskId,
      payload: { changes: Object.keys(changes), overwrote: overwrote.map((o) => o.field), lag_changes: lagChanges },
      data: { task_id: taskId, fields: Object.keys(changes) },
    });
    if (overwrote.length) {
      plan.write.publish(envelope({
        projectId: existing.projectId, actor: actorOf(actor, viewer),
        type: 'planning.edit.overwritten',
        data: { task_id: taskId, fields: overwrote.map((o) => o.field), overwritten: overwrote },
      }));
    }
    return { status: 200, body: deltaResult({ plan, viewer, task: updated, propagated, overwrote, variations }) };
  });
}

/** operationId: recordActual — the actual date of an external row. */
export async function recordActual({ viewer, store, taskId, body }) {
  const existing = await store.getTask(taskId);
  if (!existing || existing.deletedAt) throw new ProblemError('not_found');
  const { actor } = await requireEditor({ viewer, store, projectId: existing.projectId, task: existing });
  const errors = {};
  for (const f of ['start', 'finish']) {
    if (body?.[f] != null && !ISO_DATE.test(body[f])) errors[f] = 'an ISO date';
  }
  if (body?.start == null && body?.finish == null) errors.finish = 'start or finish required';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  return store.withPlanTx(existing.projectId, async (plan) => {
    const task = plan.tasks.get(taskId);
    if (!task || task.deletedAt) throw new ProblemError('gone');
    const cal = makeCalendar(plan.calendarRaw);
    const patch = {};
    if (body.start != null) patch.actualStart = body.start;
    if (body.finish != null) {
      patch.actualFinish = body.finish;
      if (!task.actualStart && body.start == null) patch.actualStart = body.finish;
    }
    const updated = { ...task, ...patch };
    plan.tasks.set(taskId, updated);
    plan.write.patchTask(taskId, { ...patch, ...changeStamp(actor, viewer, 'direct') });
    for (const [field, value] of Object.entries(patch)) {
      plan.write.fieldChange(fieldChangeOf({
        taskId, field, oldValue: task[field], newValue: value,
        actor, viewer, cause: 'direct', clientChangeId: null,
      }));
    }
    const propagated = await propagateAndPersist({
      plan, cal, seedIds: [taskId], actor: actorOf(actor, viewer), clientChangeId: null,
    });
    const variations = await runScheduleVariations({
      plan, cal, projectId: existing.projectId, seeds: [taskId], propagated,
      actor: actorOf(actor, viewer),
    });
    await commitPlanEvent(plan, {
      projectId: existing.projectId, actor: actorOf(actor, viewer), type: 'planning.task.updated',
      objectId: taskId, payload: { actual: patch },
      data: { task_id: taskId, fields: Object.keys(patch) },
    });
    return { status: 200, body: deltaResult({ plan, viewer, task: updated, propagated, variations }) };
  });
}

/** operationId: previewMove — dry maths, no writes. */
export async function previewMove({ viewer, store, taskId, body }) {
  const existing = await store.getTask(taskId);
  if (!existing || existing.deletedAt) throw new ProblemError('not_found');
  await requireEditor({ viewer, store, projectId: existing.projectId, task: existing });
  const snapshot = await store.loadPlan(existing.projectId);
  const cal = makeCalendar(snapshot.calendarRaw);
  const task = snapshot.tasks.get(taskId);
  const spans = effectiveSpans(snapshot.tasks);
  const before = projectFinish(spans);

  const start = body?.start ?? task.start;
  const finish = body?.finish ?? task.finish;
  const moved = new Map(snapshot.tasks);
  moved.set(taskId, { ...task, start, finish });
  const { moves } = propagate({ tasks: moved, links: snapshot.links, calendar: cal, seedIds: [taskId] });

  const after = new Map(moved);
  for (const m of moves) after.set(m.id, { ...after.get(m.id), start: m.start, finish: m.finish });
  const incoming = snapshot.links.filter((l) => l.successorId === taskId);
  const lag = incoming.length
    ? lagFor({
        link: incoming[0], predSpan: spans.get(incoming[0].predecessorId),
        succStart: start, succFinish: finish, calendar: cal,
      })
    : undefined;
  return {
    status: 200,
    body: {
      resulting_lag_wd: lag,
      would_move: moves.map((m) => ({ id: m.id, start: m.start, finish: m.finish })),
      project_end_delta_wd: finishDelta(cal, before, projectFinish(effectiveSpans(after))),
    },
  };
}

// ── structural batch ───────────────────────────────────────────────────────

/** operationId: applySchedule */
export async function applySchedule({ viewer, store, projectId, body, idempotencyKey }) {
  const { actor } = await requireEditor({ viewer, store, projectId });
  const ops = body?.operations;
  if (!Array.isArray(ops) || !ops.length) {
    throw new ProblemError('validation_failed', null, { errors: { operations: 'a non-empty list' } });
  }
  const dryRun = body?.dry_run === true;

  const run = () => store.withPlanTx(projectId, async (plan) => {
    if (body?.client_change_id && (await plan.hasChange(body.client_change_id))) {
      return {
        status: 200,
        body: { applied: true, dry_run: false, created: [], changed: [], deleted: [], links_created: [], health: planHealth(plan) },
      };
    }
    const cal = makeCalendar(plan.calendarRaw);
    const out = { created: [], changed: [], deleted: [], links_created: [] };
    const removedRows = [];
    const me = actorOf(actor, viewer);

    for (const op of ops) {
      switch (op?.op) {
        case 'create_rows':
        case 'paste_rows': {
          for (const spec of op.rows ?? []) {
            const row = buildRow({
              plan, cal, projectId,
              spec: { ...spec, parent_id: spec.parent_id ?? op.parent_id ?? null },
              actor: me,
            });
            if (!inEditScope(world(plan), row, viewer.orgId)) {
              throw new ProblemError('out_of_scope', `row ${row.name}: parent outside your branch scope`);
            }
            plan.write.insertTask(row);
            plan.tasks.set(row.id, row);
            out.created.push(row);
          }
          for (const spec of op.links ?? []) {
            out.links_created.push(addLink({ plan, spec, viewer, actor }));
          }
          break;
        }
        case 'move_subtree':
        case 'indent':
        case 'outdent': {
          const moved = moveSubtree({ plan, op, viewer });
          out.changed.push(...moved);
          break;
        }
        case 'delete_subtree': {
          const task = mustTask(plan, op.task_id);
          const ids = [op.task_id, ...descendantIds(plan.tasks, op.task_id)];
          for (const id of ids) {
            if (!inEditScope(world(plan), plan.tasks.get(id), viewer.orgId)) {
              throw new ProblemError('out_of_scope', 'the subtree crosses out of your branch scope', {
                blocked_rows: ids.filter((x) => !inEditScope(world(plan), plan.tasks.get(x), viewer.orgId)),
              });
            }
          }
          for (const id of ids) {
            removedRows.push(plan.tasks.get(id));
            plan.write.softDelete(id);
            plan.tasks.delete(id);
            out.deleted.push(id);
          }
          for (const l of plan.links.filter((l) => ids.includes(l.successorId) || ids.includes(l.predecessorId))) {
            plan.write.removeLink(l.id);
          }
          plan.links = plan.links.filter((l) => !ids.includes(l.successorId) && !ids.includes(l.predecessorId));
          void task;
          break;
        }
        case 'insert_template':
          throw new ProblemError('validation_failed', null, {
            errors: { operations: 'insert_template is not available yet — plan templates land with the tendering phase' },
          });
        default:
          throw new ProblemError('validation_failed', null, { errors: { operations: `unknown op ${JSON.stringify(op?.op)}` } });
      }
    }

    const propagated = await propagateAndPersist({
      plan, cal, seedIds: [...out.created.map((t) => t.id), ...out.changed.map((t) => t.id)],
      actor: me, clientChangeId: body?.client_change_id ?? null,
    });
    for (const row of out.created) await recordAddedRowVariation({ plan, projectId, task: row, actor: me });
    for (const row of removedRows) await recordRemovedRowVariation({ plan, projectId, task: row, actor: me });
    await runScheduleVariations({
      plan, cal, projectId, seeds: out.changed.map((t) => t.id), propagated, actor: me,
    });
    if (body?.client_change_id && !dryRun) {
      // Anchor the batch's idempotency on the first row it touched.
      const anchorId = out.created[0]?.id ?? out.changed[0]?.id ?? out.deleted[0];
      if (anchorId) {
        plan.write.fieldChange(fieldChangeOf({
          taskId: anchorId, field: 'batch', oldValue: null, newValue: ops.map((o) => o.op),
          actor, viewer, cause: 'direct', clientChangeId: body.client_change_id,
        }));
      }
    }
    await commitPlanEvent(plan, {
      projectId, actor: me, type: 'planning.task.moved',
      objectId: out.changed[0]?.id ?? out.created[0]?.id ?? out.deleted[0] ?? projectId,
      payload: {
        ops: ops.map((o) => o.op),
        created: out.created.length, changed: out.changed.length, deleted: out.deleted.length,
      },
      data: {
        created: out.created.map((t) => t.id), changed: out.changed.map((t) => t.id), deleted: out.deleted,
      },
    });

    const ctx = projectionCtx(plan, viewer.orgId, today());
    return {
      status: 200,
      body: {
        applied: !dryRun,
        dry_run: dryRun,
        created: out.created.map((t) => taskBody(t, ctx)),
        changed: dedupeById([
          ...out.changed.map((t) => taskBody(plan.tasks.get(t.id) ?? t, ctx)),
          ...propagated.map((m) => taskBody(plan.tasks.get(m.id), ctx)),
        ]),
        deleted: out.deleted,
        links_created: out.links_created.map(linkBody),
        health: planHealth(plan),
      },
    };
  }, { dryRun });

  if (dryRun || !idempotencyKey) return run();
  return store.idempotent({ key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'applySchedule', body }, run);
}

// ── links ──────────────────────────────────────────────────────────────────

/** operationId: createLink */
export async function createLink({ viewer, store, taskId, body }) {
  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (!ANCHORS.has(body?.from_anchor)) errors.from_anchor = 'start or end';
  if (!ANCHORS.has(body?.to_anchor)) errors.to_anchor = 'start or end';
  if (body?.lag_wd != null && !Number.isInteger(body.lag_wd)) errors.lag_wd = 'an integer (working days)';
  if (![body?.predecessor_id, body?.successor_id].includes(taskId)) {
    errors.successor_id = 'the link must involve the task in the path';
  }
  if (body?.predecessor_id === body?.successor_id) errors.successor_id = 'a row cannot depend on itself';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const successor = await store.getTask(body.successor_id);
  if (!successor || successor.deletedAt) throw new ProblemError('not_found', 'successor not found');
  const { actor } = await requireEditor({ viewer, store, projectId: successor.projectId, task: successor });

  return store.withPlanTx(successor.projectId, async (plan) => {
    const link = addLink({ plan, spec: body, viewer, actor });
    const cal = makeCalendar(plan.calendarRaw);
    const propagated = await propagateAndPersist({
      plan, cal, seedIds: [link.predecessorId], actor: actorOf(actor, viewer), clientChangeId: null,
    });
    const variations = await runScheduleVariations({
      plan, cal, projectId: successor.projectId, seeds: [], propagated, actor: actorOf(actor, viewer),
    });
    await commitPlanEvent(plan, {
      projectId: successor.projectId, actor: actorOf(actor, viewer), type: 'planning.link.added',
      objectId: link.id, objectType: 'link',
      payload: { predecessor_id: link.predecessorId, successor_id: link.successorId, from_anchor: link.fromAnchor, to_anchor: link.toAnchor, lag_wd: link.lagWd },
      data: { link_id: link.id, predecessor_id: link.predecessorId, successor_id: link.successorId },
    });
    return {
      status: 201,
      body: deltaResult({ plan, viewer, task: plan.tasks.get(successor.id), propagated, link, variations }),
    };
  });
}

/** operationId: updateLink */
export async function updateLink({ viewer, store, linkId, body }) {
  const link = await store.getLink(linkId);
  if (!link) throw new ProblemError('not_found');
  const successor = await store.getTask(link.successorId);
  const { actor } = await requireEditor({ viewer, store, projectId: successor.projectId, task: successor });
  const errors = {};
  if (body?.from_anchor && !ANCHORS.has(body.from_anchor)) errors.from_anchor = 'start or end';
  if (body?.to_anchor && !ANCHORS.has(body.to_anchor)) errors.to_anchor = 'start or end';
  if (body?.lag_wd != null && !Number.isInteger(body.lag_wd)) errors.lag_wd = 'an integer (working days)';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  return store.withPlanTx(successor.projectId, async (plan) => {
    const patch = {};
    for (const [k, key] of [['from_anchor', 'fromAnchor'], ['to_anchor', 'toAnchor'], ['lag_wd', 'lagWd']]) {
      if (body?.[k] !== undefined) patch[key] = body[k];
    }
    plan.write.patchLink(linkId, patch);
    plan.links = plan.links.map((l) => (l.id === linkId ? { ...l, ...patch } : l));
    const cal = makeCalendar(plan.calendarRaw);
    const propagated = await propagateAndPersist({
      plan, cal, seedIds: [link.predecessorId], actor: actorOf(actor, viewer), clientChangeId: null,
    });
    const variations = await runScheduleVariations({
      plan, cal, projectId: successor.projectId, seeds: [], propagated, actor: actorOf(actor, viewer),
    });
    await commitPlanEvent(plan, {
      projectId: successor.projectId, actor: actorOf(actor, viewer), type: 'planning.link.changed',
      objectId: linkId, objectType: 'link', payload: patch,
      data: { link_id: linkId },
    });
    return { status: 200, body: deltaResult({ plan, viewer, task: plan.tasks.get(successor.id), propagated, variations }) };
  });
}

/** operationId: deleteLink — frees the successor. */
export async function deleteLink({ viewer, store, linkId }) {
  const link = await store.getLink(linkId);
  if (!link) throw new ProblemError('not_found');
  const successor = await store.getTask(link.successorId);
  const { actor } = await requireEditor({ viewer, store, projectId: successor.projectId, task: successor });
  return store.withPlanTx(successor.projectId, async (plan) => {
    plan.write.removeLink(linkId);
    plan.links = plan.links.filter((l) => l.id !== linkId);
    await commitPlanEvent(plan, {
      projectId: successor.projectId, actor: actorOf(actor, viewer), type: 'planning.link.removed',
      objectId: linkId, objectType: 'link',
      payload: { predecessor_id: link.predecessorId, successor_id: link.successorId },
      data: { link_id: linkId },
    });
    return { status: 204, body: null };
  });
}

// ── cost lines (doc 05 §8, D-27; rows live in contracting.boq_item) ─────────

const QUANTITY = /^\d+(\.\d{1,3})?$/;

/** operationId: listCostLines — lines the viewer may see are the ONLY lines. */
export async function listCostLines({ viewer, store, taskId }) {
  const task = await store.getTask(taskId);
  if (!task || task.deletedAt) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: task.projectId });
  const snapshot = await store.loadPlan(task.projectId);
  const items = (snapshot.boqLines ?? [])
    .filter((l) => l.taskId === taskId)
    .filter((l) => costLineVisibleTo(l, viewer.orgId, snapshot.contracts))
    .map(costLineBody);
  return { status: 200, body: { items, next_cursor: null } };
}

/** operationId: createCostLine — contract party, or an owner estimate. */
export async function createCostLine({ viewer, store, taskId, body }) {
  const task = await store.getTask(taskId);
  if (!task || task.deletedAt) throw new ProblemError('not_found');
  const { actor } = await requireParticipant({ viewer, store, projectId: task.projectId });
  if (!viewer.has('org:costs:edit')) throw new ProblemError('forbidden', null, { reason: 'role' });

  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  for (const f of ['code', 'description', 'unit']) {
    if (!body?.[f]?.trim()) errors[f] = 'required';
  }
  if (!QUANTITY.test(body?.quantity ?? '')) errors.quantity = 'a decimal with up to 3 places';
  const cents = body?.unit_price?.amount_cents ?? 0;
  if (!Number.isInteger(cents) || cents < 0) errors.unit_price = 'Money {amount_cents ≥ 0, EUR}';
  if (body?.contract_id != null && !UUID.test(body.contract_id)) errors.contract_id = 'a contract id';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  return mapBoqTriggerErrors(() => store.withPlanTx(task.projectId, async (plan) => {
    const contractId = body.contract_id ?? null;
    if (contractId) {
      const contract = plan.contracts.get(contractId);
      if (!contract) {
        throw new ProblemError('validation_failed', null, { errors: { contract_id: 'not a contract of this project' } });
      }
      if (![contract.clientOrgId, contract.supplierOrgId].includes(viewer.orgId)) {
        throw new ProblemError('forbidden', 'only a party of the line’s contract prices it', { reason: 'relationship' });
      }
      if (contract.status && contract.status !== 'draft') {
        throw new ProblemError('invalid_transition',
          'the lines of a signed contract change only via a change order (supersede + add)');
      }
    }
    const line = {
      id: body.id,
      projectId: task.projectId,
      contractId,
      estimateOwnerOrgId: contractId ? null : viewer.orgId,
      taskId,
      code: body.code.trim(),
      description: body.description.trim(),
      unit: body.unit.trim(),
      quantity: body.quantity,
      unitPriceCents: cents,
      materialSpec: body.material_spec ?? null,
      introducedByChangeOrderId: null,
      supersededByChangeOrderId: null,
    };
    const prior = taskContractTotalCents(plan.boqLines ?? [], taskId, contractId);
    plan.write.insertCostLine(line);
    plan.boqLines = [...(plan.boqLines ?? []), line];
    await ledgerCostLine(plan, { type: 'contracting.boq_line.created', line, actor: actorOf(actor, viewer) });
    await runCostVariation({
      plan, projectId: task.projectId, task: plan.tasks.get(taskId), contractId, kind: 'cost',
      priorValue: prior, currentValue: taskContractTotalCents(plan.boqLines, taskId, contractId),
      actor: actorOf(actor, viewer),
    });
    return { status: 201, body: costLineBody(line) };
  }));
}

/** operationId: updateCostLine — post-baseline changes refresh the variation. */
export async function updateCostLine({ viewer, store, costLineId, body }) {
  const { line, task, actor } = await requireCostLine({ viewer, store, costLineId });
  const errors = {};
  for (const f of ['code', 'description', 'unit']) {
    if (body?.[f] !== undefined && !body[f]?.trim()) errors[f] = 'must not be blank';
  }
  if (body?.quantity !== undefined && !QUANTITY.test(body.quantity ?? '')) errors.quantity = 'a decimal with up to 3 places';
  if (body?.unit_price !== undefined
      && (!Number.isInteger(body.unit_price?.amount_cents) || body.unit_price.amount_cents < 0)) {
    errors.unit_price = 'Money {amount_cents ≥ 0, EUR}';
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  return mapBoqTriggerErrors(() => store.withPlanTx(task.projectId, async (plan) => {
    const current = (plan.boqLines ?? []).find((l) => l.id === costLineId);
    if (!current) throw new ProblemError('not_found');
    guardLineWritable(plan, current);
    const patch = {};
    if (body?.code !== undefined) patch.code = body.code.trim();
    if (body?.description !== undefined) patch.description = body.description.trim();
    if (body?.unit !== undefined) patch.unit = body.unit.trim();
    if (body?.quantity !== undefined) patch.quantity = body.quantity;
    if (body?.unit_price !== undefined) patch.unitPriceCents = body.unit_price.amount_cents;
    if (body?.material_spec !== undefined) patch.materialSpec = body.material_spec ?? null;

    const priorTotal = taskContractTotalCents(plan.boqLines, current.taskId, current.contractId);
    const priorSpec = current.materialSpec ?? null;
    plan.write.patchCostLine(costLineId, patch);
    const updated = { ...current, ...patch };
    plan.boqLines = plan.boqLines.map((l) => (l.id === costLineId ? updated : l));
    await ledgerCostLine(plan, {
      type: 'contracting.boq_line.updated', line: updated, actor: actorOf(actor, viewer),
      payload: { changed: Object.keys(patch) },
    });
    const me = actorOf(actor, viewer);
    const row = plan.tasks.get(current.taskId);
    if ('quantity' in patch || 'unitPriceCents' in patch || 'code' in patch || 'description' in patch) {
      await runCostVariation({
        plan, projectId: task.projectId, task: row, contractId: current.contractId, kind: 'cost',
        priorValue: priorTotal,
        currentValue: taskContractTotalCents(plan.boqLines, current.taskId, current.contractId),
        actor: me,
      });
    }
    if ('materialSpec' in patch) {
      await runCostVariation({
        plan, projectId: task.projectId, task: row, contractId: current.contractId, kind: 'material',
        priorValue: priorSpec, currentValue: updated.materialSpec, actor: me,
      });
    }
    return { status: 200, body: costLineBody(updated) };
  }));
}

/** operationId: deleteCostLine */
export async function deleteCostLine({ viewer, store, costLineId }) {
  const { line, task, actor } = await requireCostLine({ viewer, store, costLineId });
  void line;
  return mapBoqTriggerErrors(() => store.withPlanTx(task.projectId, async (plan) => {
    const current = (plan.boqLines ?? []).find((l) => l.id === costLineId);
    if (!current) throw new ProblemError('not_found');
    guardLineWritable(plan, current);
    const priorTotal = taskContractTotalCents(plan.boqLines, current.taskId, current.contractId);
    plan.write.deleteCostLine(costLineId);
    plan.boqLines = plan.boqLines.filter((l) => l.id !== costLineId);
    await ledgerCostLine(plan, { type: 'contracting.boq_line.deleted', line: current, actor: actorOf(actor, viewer) });
    await runCostVariation({
      plan, projectId: task.projectId, task: plan.tasks.get(current.taskId),
      contractId: current.contractId, kind: 'cost',
      priorValue: priorTotal,
      currentValue: taskContractTotalCents(plan.boqLines, current.taskId, current.contractId),
      actor: actorOf(actor, viewer),
    });
    return { status: 204, body: null };
  }));
}

// ── variations (the change view) ─────────────────────────────────────────────

const VARIATION_KINDS = new Set(['time', 'cost', 'material', 'scope']);
const VARIATION_STATUSES = new Set(['open', 'acknowledged', 'formalised', 'closed']);

/** operationId: listVariations — cost/material per V2/V5, time/scope for all. */
export async function listVariations({ viewer, store, projectId, query }) {
  await requireParticipant({ viewer, store, projectId });
  const errors = {};
  if (query?.kind && !VARIATION_KINDS.has(query.kind)) errors.kind = 'time, cost, material or scope';
  if (query?.status && !VARIATION_STATUSES.has(query.status)) errors.status = 'open, acknowledged, formalised or closed';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  const snapshot = await store.loadPlan(projectId);
  const rows = await store.listVariations(projectId, {
    kind: query?.kind ?? null,
    status: query?.status ?? null,
    since: query?.since ?? null,
    taskId: query?.task ?? null,
  });
  const items = rows
    .filter((v) => variationVisibleTo(v, viewer.orgId, { contracts: snapshot.contracts }))
    .map((v) => variationBody(v));
  return { status: 200, body: { items, next_cursor: null } };
}

/** operationId: getVariation — history derived at read time (ruling 12). */
export async function getVariation({ viewer, store, variationId }) {
  const v = await store.getVariation(variationId);
  if (!v) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: v.projectId });
  const snapshot = await store.loadPlan(v.projectId);
  if (!variationVisibleTo(v, viewer.orgId, { contracts: snapshot.contracts })) {
    throw new ProblemError('not_found'); // a commercial variation does not exist for non-parties
  }
  // Time history reconstructs from the delta ledger; cost/material history is
  // in the contract-scoped boq ledger — empty here (documented limitation).
  let history = [];
  if (v.kind === 'time') {
    const changes = await store.listFieldChanges(v.taskId);
    history = changes
      .filter((h) => ['start', 'finish'].includes(h.field))
      .map((h) => ({
        at: h.changedAt,
        by: { person_id: h.changedByPersonId, org_id: h.changedByOrgId },
        value: { [h.field]: h.newValue },
      }));
  }
  return { status: 200, body: variationBody(v, { history }) };
}

/** operationId: acknowledgeVariation — "I saw it", who/when recorded. */
export async function acknowledgeVariation({ viewer, store, variationId }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:variations:acknowledge')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const v = await store.getVariation(variationId);
  if (!v) throw new ProblemError('not_found');
  const { actor } = await requireParticipant({ viewer, store, projectId: v.projectId });
  const snapshot = await store.loadPlan(v.projectId);
  if (!variationVisibleTo(v, viewer.orgId, { contracts: snapshot.contracts })) {
    throw new ProblemError('not_found');
  }
  const isOwner = viewer.orgId === snapshot.ownerOrgId;
  const isScopeClient = v.scopeType === 'contract'
    && snapshot.contracts.get(v.scopeId)?.clientOrgId === viewer.orgId;
  if (!isOwner && !isScopeClient) {
    throw new ProblemError('forbidden', 'the project owner or the scope-contract client acknowledges', { reason: 'relationship' });
  }
  if (['formalised', 'closed'].includes(v.status)) {
    throw new ProblemError('invalid_transition', `a ${v.status} variation is settled`);
  }
  const updated = await store.acknowledgeVariation({ variationId, actor: actorOf(actor, viewer) });
  return { status: 200, body: variationBody(updated) };
}

/** operationId: questionVariation — opens a question on the row (doc 08). */
export async function questionVariation({ viewer, store, variationId, body }) {
  const v = await store.getVariation(variationId);
  if (!v) throw new ProblemError('not_found');
  const { actor } = await requireParticipant({ viewer, store, projectId: v.projectId });
  const snapshot = await store.loadPlan(v.projectId);
  if (!variationVisibleTo(v, viewer.orgId, { contracts: snapshot.contracts })) {
    throw new ProblemError('not_found');
  }
  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (!['note', 'question'].includes(body?.kind)) errors.kind = 'note or question';
  if (!body?.body?.trim() || body.body.length > 8000) errors.body = '1 to 8000 characters';
  if (body?.addressee_org_id != null && !UUID.test(body.addressee_org_id)) errors.addressee_org_id = 'an organisation id';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const { createdAt } = await store.questionVariation({
    variationId,
    comment: {
      id: body.id, kind: body.kind, body: body.body.trim(),
      addresseeOrgId: body.addressee_org_id ?? null,
    },
    actor: actorOf(actor, viewer),
  });
  return {
    status: 201,
    body: {
      id: body.id,
      object_type: 'variation',
      object_id: variationId,
      kind: body.kind,
      body: body.body.trim(),
      author: { person_id: actor.id, org_id: viewer.orgId },
      addressee_org_id: body.addressee_org_id ?? undefined,
      ...(body.kind === 'question' ? { question_status: 'open' } : {}),
      created_at: createdAt,
    },
  };
}

// ── progress (append-only; 'verified' is Quality's word, never reported) ─────

const REPORTABLE_STATUSES = new Set(['not_started', 'in_progress', 'blocked', 'done']);

/** operationId: reportProgress */
export async function reportProgress({ viewer, store, taskId, body }) {
  const task = await store.getTask(taskId);
  if (!task || task.deletedAt) throw new ProblemError('not_found');
  const { actor } = await requireParticipant({ viewer, store, projectId: task.projectId });
  if (!viewer.has('org:progress:report')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const snapshot = await store.loadPlan(task.projectId);
  if (!inEditScope(world(snapshot), snapshot.tasks.get(taskId) ?? task, viewer.orgId)) {
    throw new ProblemError('out_of_scope');
  }
  const errors = {};
  if (!REPORTABLE_STATUSES.has(body?.status)) {
    errors.status = body?.status === 'verified'
      ? "'verified' is written by Quality, never reported"
      : 'not_started, in_progress, blocked or done';
  }
  if (body?.percent != null) {
    if (!Number.isInteger(body.percent) || body.percent < 0 || body.percent > 100) errors.percent = '0..100';
    else if (body?.status !== 'in_progress') errors.percent = 'percent goes with in_progress only';
  }
  const photos = body?.photo_document_ids ?? [];
  if (!Array.isArray(photos) || photos.some((p) => !UUID.test(p ?? ''))) {
    errors.photo_document_ids = 'a list of document ids';
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const report = await store.insertProgress({
    taskId,
    projectId: task.projectId,
    status: body.status,
    percent: body.percent ?? null,
    note: body.note?.trim() || null,
    photoDocumentIds: photos,
    taskName: task.name,
    // quality opens the verification request from this snapshot on `done`
    criteria: body.status === 'done' ? (task.acceptanceCriteria ?? task.description ?? null) : null,
    actor: actorOf(actor, viewer),
  });
  return { status: 201, body: progressBody(report) };
}

/** operationId: listProgress */
export async function listProgress({ viewer, store, taskId }) {
  const task = await store.getTask(taskId);
  if (!task || task.deletedAt) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: task.projectId });
  const reports = await store.listProgress(taskId);
  return { status: 200, body: { items: reports.map(progressBody), next_cursor: null } };
}

// ── internals ──────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** authz opener for PATCH/DELETE /cost-lines/{id} — party or estimate owner. */
async function requireCostLine({ viewer, store, costLineId }) {
  const line = await store.getCostLine(costLineId);
  if (!line) throw new ProblemError('not_found');
  const task = await store.getTask(line.taskId);
  if (!task) throw new ProblemError('not_found');
  const { actor } = await requireParticipant({ viewer, store, projectId: task.projectId });
  if (!viewer.has('org:costs:edit')) throw new ProblemError('forbidden', null, { reason: 'role' });
  if (line.contractId) {
    const snapshot = await store.loadPlan(task.projectId);
    const contract = snapshot.contracts.get(line.contractId);
    if (!contract || ![contract.clientOrgId, contract.supplierOrgId].includes(viewer.orgId)) {
      // not the viewer's line: it does not exist for them (V2/V5)
      throw new ProblemError('not_found');
    }
  } else if (line.estimateOwnerOrgId !== viewer.orgId) {
    throw new ProblemError('not_found');
  }
  return { line, task, actor };
}

/** Signed-contract lines never change in place — change orders do (C4). */
function guardLineWritable(plan, line) {
  if (line.supersededByChangeOrderId) {
    throw new ProblemError('invalid_transition', 'this line was superseded by a change order');
  }
  if (!line.contractId) return;
  const contract = plan.contracts.get(line.contractId);
  if (contract?.status && contract.status !== 'draft') {
    throw new ProblemError('invalid_transition',
      'the lines of a signed contract change only via a change order (supersede + add)');
  }
}

/** The DB trigger (boq_freeze_guard) is the last word → 409, ruling 15. */
async function mapBoqTriggerErrors(fn) {
  try {
    return await fn();
  } catch (err) {
    if (typeof err?.message === 'string'
        && (err.message.includes('changes only via change order') || err.message.includes('cannot be deleted'))) {
      throw new ProblemError('invalid_transition',
        'the lines of a signed contract change only via a change order (supersede + add)');
    }
    throw err;
  }
}

/** ledger + event for a cost-line write, on the plan transaction. */
async function ledgerCostLine(plan, { type, line, actor, payload = {} }) {
  const scope = line.contractId
    ? { type: 'contract', id: line.contractId }
    : { type: 'org_private', id: line.estimateOwnerOrgId };
  await plan.write.ledger({
    projectId: line.projectId,
    actor: { personId: actor.personId, orgId: actor.orgId, orgRole: actor.orgRole },
    category: 'contracting',
    type,
    scope,
    object: { type: 'boq_item', id: line.id },
    payload: { task_id: line.taskId, code: line.code, ...payload },
    channel: actor.channel ?? 'ui',
  });
  plan.write.publish({
    event_id: randomUUID(),
    type,
    version: 1,
    project_id: line.projectId,
    actor: { person_id: actor.personId ?? null, org_id: actor.orgId ?? null },
    scope,
    data: { boq_item_id: line.id, task_id: line.taskId, contract_id: line.contractId ?? null },
  });
}

/** api/v2 ProgressReport. */
function progressBody(p) {
  return {
    seq: p.seq,
    status: p.status,
    percent: p.percent ?? undefined,
    note: p.note ?? undefined,
    photo_document_ids: p.photoDocumentIds ?? [],
    reported_by: { person_id: p.reportedByPersonId, org_id: p.reportedByOrgId },
    on_behalf_of_org_id: p.onBehalfOfOrgId ?? undefined,
    reported_at: p.reportedAt,
  };
}

function world(plan) {
  return { ownerOrgId: plan.ownerOrgId, contracts: plan.contracts };
}

function actorOf(person, viewer) {
  return { personId: person.id, orgId: viewer.orgId, orgRole: viewer.orgRole, channel: viewer.channel };
}

function changeStamp(actor, viewer, cause) {
  return {
    lastChangedByPersonId: actor.id,
    lastChangedByOrgId: viewer.orgId,
    lastChangedAt: new Date().toISOString(),
    lastChangeCause: cause,
  };
}

function requireActiveOrg(viewer) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
}

function seesWholeOrg(viewer) {
  return viewer.orgRole === 'admin' || viewer.orgRole === 'manager';
}

async function requireActor(store, viewer) {
  const person = await store.getPersonByClerkId(viewer.clerkUserId);
  if (!person) throw new ProblemError('version_conflict', 'your identity mirror has not caught up yet — retry');
  return person;
}

/** relationship: project.participant (∧ staffing for non-managers). */
async function requireParticipant({ viewer, store, projectId }) {
  requireActiveOrg(viewer);
  const project = await store.getProject(projectId);
  if (!project) throw new ProblemError('not_found');
  const related = project.owner_org_id === viewer.orgId
    || project.created_by_org_id === viewer.orgId
    || (await store.isParticipant(projectId, viewer.orgId));
  if (!related) throw new ProblemError('not_found'); // non-participants learn nothing
  const actor = await requireActor(store, viewer);
  if (!seesWholeOrg(viewer)) {
    if (!(await store.isStaffed(projectId, viewer.orgId, actor.id))) {
      throw new ProblemError('not_a_participant', 'you are not staffed on this project');
    }
  }
  return { project, actor };
}

/** permission org:plan:edit ∧ participant; per-row scope is checked in-tx. */
async function requireEditor({ viewer, store, projectId, task = null }) {
  const { project, actor } = await requireParticipant({ viewer, store, projectId });
  if (!viewer.has('org:plan:edit')) throw new ProblemError('forbidden', null, { reason: 'role' });
  if (task) {
    const snapshot = await store.loadPlan(projectId);
    if (!inEditScope(world(snapshot), snapshot.tasks.get(task.id) ?? task, viewer.orgId)) {
      throw new ProblemError('out_of_scope');
    }
  }
  return { project, actor };
}

/** Normalize + place a TaskCreate under its parent. */
function buildRow({ plan, cal, projectId, spec, actor }) {
  if (plan.tasks.has(spec.id)) throw new ProblemError('version_conflict', 'a row with this id already exists');
  const parent = spec.parent_id ? plan.tasks.get(spec.parent_id) : null;
  if (spec.parent_id && !parent) {
    throw new ProblemError('validation_failed', null, { errors: { parent_id: 'not a row of this plan' } });
  }
  const depth = (parent?.depth ?? 0) + 1;
  if (depth > 10) throw new ProblemError('too_deep', 'the plan supports up to 10 levels (D-25)');

  const siblings = [...plan.tasks.values()]
    .filter((t) => (t.parentId ?? null) === (parent?.id ?? null) && !t.deletedAt)
    .sort((a, b) => (a.position < b.position ? -1 : 1));
  let position;
  if (spec.after_position) {
    const next = siblings.find((s) => s.position > spec.after_position);
    position = keyBetween(spec.after_position, next?.position ?? null);
  } else {
    position = keyBetween(siblings.at(-1)?.position ?? null, null);
  }

  const kind = spec.kind ?? 'task';
  let { start = null, finish = null } = spec;
  let duration = spec.duration_wd ?? null;
  const datingMode = spec.dating_mode ?? (start ? 'dated' : 'undated');
  if (datingMode === 'undated') { start = null; finish = null; duration = null; }
  if (kind === 'milestone' && start) { finish = start; duration = 0; }
  if (start && !finish && duration != null && duration > 0) finish = spanFinish(cal, start, duration);
  if (start && finish && kind !== 'milestone') duration = durationWd(cal, start, finish);
  if (datingMode === 'dated' && !start) {
    throw new ProblemError('validation_failed', null, { errors: { start: 'a dated row needs a start' } });
  }
  if (start && finish && finish < start) {
    throw new ProblemError('validation_failed', null, { errors: { finish: 'before start' } });
  }

  return {
    id: spec.id,
    projectId,
    parentId: parent?.id ?? null,
    depth,
    position,
    kind,
    name: spec.name.trim(),
    description: spec.description ?? null,
    specialty: spec.specialty ?? null,
    locationId: spec.location_id ?? null,
    contractId: null,
    branchContractId: parent ? (parent.contractId ?? parent.branchContractId ?? null) : null,
    assigneeOrgId: null, // inherited from the branch (D-33), resolved on read
    assigneePersonId: null,
    assigneeInherited: true,
    datingMode,
    start,
    finish,
    durationWd: duration,
    actualStart: null,
    actualFinish: null,
    acceptanceCriteria: null,
    baselineStart: null,
    baselineFinish: null,
    scheduleState: 'planned',
    lastChangedByPersonId: actor.personId,
    lastChangedByOrgId: actor.orgId,
    lastChangedAt: new Date().toISOString(),
    lastChangeCause: 'direct',
    deletedAt: null,
  };
}

/** D-26: apply a field delta with LWW + overwrite detection. */
function applyDelta({ plan, task, cal, changes, viewer, actor, clientChangeId }) {
  const patch = {};
  const overwrote = [];
  const fieldChanges = [];
  const FIELD_KEYS = {
    name: 'name', description: 'description', kind: 'kind', specialty: 'specialty',
    location_id: 'locationId', dating_mode: 'datingMode', start: 'start', finish: 'finish',
    duration_wd: 'durationWd', assignee_org_id: 'assigneeOrgId', assignee_person_id: 'assigneePersonId',
    acceptance_criteria: 'acceptanceCriteria',
  };
  const errors = {};

  for (const [field, change] of Object.entries(changes)) {
    const key = FIELD_KEYS[field];
    const current = task[key] ?? null;
    const value = change?.value ?? null;
    if (change && 'base' in change && JSON.stringify(change.base ?? null) !== JSON.stringify(current)) {
      overwrote.push({
        field,
        by: { person_id: task.lastChangedByPersonId ?? undefined, org_id: task.lastChangedByOrgId ?? undefined },
        at: task.lastChangedAt ?? undefined,
      });
    }
    if (field === 'name' && !String(value ?? '').trim()) errors.name = 'must not be blank';
    if (field === 'kind') {
      if (!['task', 'milestone'].includes(value)) errors.kind = 'task or milestone (summary is derived from children)';
      else if (descendantIds(plan.tasks, task.id).length) errors.kind = 'a row with children is a summary; move the children first';
    }
    if (field === 'dating_mode' && !DATING_MODES.has(value)) errors.dating_mode = 'dated, undated or external';
    if (['start', 'finish'].includes(field) && value != null && !ISO_DATE.test(value)) errors[field] = 'an ISO date';
    if (field === 'duration_wd' && value != null && (!Number.isInteger(value) || value < 0)) errors.duration_wd = 'a non-negative integer';
    if (field === 'assignee_org_id' && value != null) {
      const parentTask = task.parentId ? plan.tasks.get(task.parentId) : null;
      const parentScope = parentTask
        ? inEditScope(world(plan), parentTask, viewer.orgId)
        : viewer.orgId === plan.ownerOrgId;
      if (!parentScope) {
        errors.assignee_org_id = 'only a scope-holder of the parent row reassigns it (D-33)';
      } else if (value !== viewer.orgId && !isMySupplier(plan, viewer.orgId, value)) {
        errors.assignee_org_id = 'assign to your own organisation or one of your suppliers';
      }
    }
    if (field === 'assignee_person_id' && value != null) {
      const org = changes.assignee_org_id?.value ?? effectiveAssignee(plan.tasks, task.id)?.orgId ?? null;
      if (org !== viewer.orgId) errors.assignee_person_id = 'the assignee organisation picks its own person';
    }
    patch[key] = value;
    fieldChanges.push(fieldChangeOf({
      taskId: task.id, field, oldValue: current, newValue: value, actor, viewer, cause: 'direct', clientChangeId,
    }));
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  // Date coherence: keep the duration unless the delta changed it (doc 05 §4).
  const next = { ...task, ...patch };
  if (next.kind === 'milestone') {
    if (next.start) { patch.finish = next.start; patch.durationWd = 0; }
  } else if ((next.datingMode ?? 'undated') === 'undated') {
    patch.start = null; patch.finish = null; patch.durationWd = null;
  } else if (next.start) {
    if ('durationWd' in patch && next.durationWd != null && !('finish' in patch)) {
      patch.finish = spanFinish(cal, next.start, next.durationWd);
    } else if ('start' in patch && !('finish' in patch) && task.durationWd != null && task.finish) {
      patch.finish = spanFinish(cal, next.start, task.durationWd);
    }
    const finalFinish = patch.finish ?? next.finish;
    if (finalFinish) {
      if (finalFinish < next.start) {
        throw new ProblemError('validation_failed', null, { errors: { finish: 'before start' } });
      }
      patch.durationWd = durationWd(cal, next.start, finalFinish);
    }
  } else if (next.datingMode === 'dated') {
    throw new ProblemError('validation_failed', null, { errors: { start: 'a dated row needs a start' } });
  }
  return { patch, overwrote, fieldChanges };
}

/** A dragged linked successor keeps its links — their lags absorb the move. */
function retuneIncomingLags({ plan, cal, task, changedFields }) {
  if (!changedFields.includes('start') && !changedFields.includes('finish')) return [];
  const spans = effectiveSpans(plan.tasks);
  const changed = [];
  for (const link of plan.links.filter((l) => l.successorId === task.id)) {
    const lag = lagFor({
      link, predSpan: spans.get(link.predecessorId),
      succStart: task.actualStart ?? task.start, succFinish: task.actualFinish ?? task.finish, calendar: cal,
    });
    if (lag !== link.lagWd) {
      plan.write.patchLink(link.id, { lagWd: lag });
      plan.links = plan.links.map((l) => (l.id === link.id ? { ...l, lagWd: lag } : l));
      changed.push({ link_id: link.id, lag_wd: lag });
    }
  }
  return changed;
}

/** Run the engine, persist the moves and the warnings, return the moves. */
async function propagateAndPersist({ plan, cal, seedIds, actor, clientChangeId }) {
  const { moves, warnings } = propagate({ tasks: plan.tasks, links: plan.links, calendar: cal, seedIds });
  for (const m of moves) {
    const before = plan.tasks.get(m.id);
    const patch = {
      start: m.start,
      finish: m.finish,
      lastChangedByPersonId: actor.personId,
      lastChangedByOrgId: actor.orgId,
      lastChangedAt: new Date().toISOString(),
      lastChangeCause: `propagated from ${m.causeTaskId}`,
    };
    plan.write.patchTask(m.id, patch);
    plan.tasks.set(m.id, { ...before, start: m.start, finish: m.finish });
    for (const field of ['start', 'finish']) {
      if (before[field] !== m[field]) {
        plan.write.fieldChange(fieldChangeOf({
          taskId: m.id, field, oldValue: before[field], newValue: m[field],
          actor: { id: actor.personId }, viewer: { orgId: actor.orgId, channel: actor.channel },
          cause: 'propagated', causeTaskId: m.causeTaskId, clientChangeId,
        }));
      }
    }
  }
  const warned = new Set(warnings.map((w) => w.id));
  for (const id of warned) {
    plan.write.patchTask(id, { scheduleState: 'sequence_warning' });
    plan.tasks.set(id, { ...plan.tasks.get(id), scheduleState: 'sequence_warning' });
  }
  if (moves.length) {
    plan.write.publish(envelope({
      projectId: [...plan.tasks.values()][0]?.projectId, actor,
      type: 'planning.task.propagated',
      data: { moved: moves.map((m) => ({ task_id: m.id, start: m.start, finish: m.finish, cause_task_id: m.causeTaskId })) },
    }));
  }
  return moves;
}

// ── variations engine (doc 05 §6, doc 09 §Variation) ───────────────────────
// Every write that changes a CONTROLLED row records/refreshes its net
// variation in the SAME plan transaction — ledger and event ride along.

function wasBaselined(plan, taskId) {
  return plan.baselineText?.has(taskId) ?? false;
}

function variationScopeOf(kind, scopeId, projectId) {
  return ['cost', 'material'].includes(kind)
    ? { type: 'contract', id: scopeId }
    : { type: 'project', id: projectId };
}

/** Record / refresh / reopen / close ONE (task, kind, scope) slot. */
async function applyVariationSlot({ plan, projectId, taskId, kind, scopeType, scopeId, position, cause, causeTaskId, actor }) {
  const key = VARIATION_KEY(taskId, kind, scopeId);
  const existing = plan.variations?.get(key) ?? null;
  const action = variationAction({ existing, changed: position.changed });
  if (!action) return [];
  const stamp = { cause, causeTaskId: causeTaskId ?? null, lastChangedByOrgId: actor.orgId };
  const now = new Date().toISOString();
  let v;
  let eventType;
  if (action === 'record') {
    v = {
      id: randomUUID(), projectId, taskId, kind, scopeType, scopeId,
      baselineValue: position.baseline_value, currentValue: position.current_value,
      delta: position.delta, status: 'open', firstChangedAt: now, lastChangedAt: now,
      changeOrderId: null, ...stamp,
    };
    plan.write.insertVariation(v);
    plan.variations.set(key, v);
    eventType = 'planning.variation.recorded';
  } else if (action === 'close') {
    v = { ...existing, currentValue: position.current_value, delta: position.delta, status: 'closed', lastChangedAt: now, ...stamp };
    plan.write.patchVariation(existing.id, { currentValue: v.currentValue, delta: v.delta, status: 'closed', ...stamp });
    plan.variations.delete(key);
    eventType = 'planning.variation.closed';
  } else { // update — and reopen: an acknowledged slot goes back to open
    v = { ...existing, currentValue: position.current_value, delta: position.delta, status: 'open', lastChangedAt: now, ...stamp };
    plan.write.patchVariation(existing.id, { currentValue: v.currentValue, delta: v.delta, status: 'open', ...stamp });
    plan.variations.set(key, v);
    eventType = 'planning.variation.updated';
  }
  const scope = variationScopeOf(kind, scopeId, projectId);
  await plan.write.ledger({
    projectId,
    actor: { personId: actor.personId, orgId: actor.orgId, orgRole: actor.orgRole },
    category: 'planning',
    type: eventType,
    scope,
    object: { type: 'variation', id: v.id },
    payload: { task_id: taskId, kind, status: v.status, delta: v.delta, cause },
    channel: actor.channel ?? 'ui',
  });
  plan.write.publish({
    event_id: randomUUID(),
    type: eventType,
    version: 1,
    project_id: projectId,
    actor: { person_id: actor.personId ?? null, org_id: actor.orgId ?? null },
    scope,
    data: {
      variation_id: v.id, task_id: taskId, kind,
      scope_type: scopeType, scope_id: scopeId, status: v.status, delta: v.delta,
    },
  });
  return [v];
}

/** Time + scope-text slots for every changed row (direct AND propagated). */
async function runScheduleVariations({ plan, cal, projectId, seeds, propagated = [], actor }) {
  const targets = new Map();
  for (const id of seeds) targets.set(id, { cause: 'direct', causeTaskId: null });
  for (const m of propagated) {
    if (!targets.has(m.id)) targets.set(m.id, { cause: 'propagated', causeTaskId: m.causeTaskId });
  }
  const out = [];
  for (const [taskId, info] of targets) {
    const task = plan.tasks.get(taskId);
    if (!task || !isControlled(task, plan.baselinedContractIds ?? new Set())) continue;
    // rows born after the baseline carry their 'added' scope variation instead
    if (!wasBaselined(plan, taskId)) continue;
    out.push(...(await applyVariationSlot({
      plan, projectId, taskId, kind: 'time', scopeType: 'project', scopeId: projectId,
      position: timePosition(task, cal), ...info, actor,
    })));
    out.push(...(await applyVariationSlot({
      plan, projectId, taskId, kind: 'scope', scopeType: 'project', scopeId: projectId,
      position: scopeTextPosition(task, plan.baselineText.get(taskId)), ...info, actor,
    })));
  }
  return out;
}

/** A row ADDED inside a baselined branch → scope variation (doc 05 §5). */
async function recordAddedRowVariation({ plan, projectId, task, actor }) {
  if (!isControlled(task, plan.baselinedContractIds ?? new Set())) return [];
  return applyVariationSlot({
    plan, projectId, taskId: task.id, kind: 'scope', scopeType: 'project', scopeId: projectId,
    position: {
      changed: true,
      baseline_value: null,
      current_value: { added: true, name: task.name },
      delta: { added: true },
    },
    cause: 'direct', causeTaskId: null, actor,
  });
}

/** A controlled row REMOVED: baselined → 'removed'; added-then-removed → net zero (closes). */
async function recordRemovedRowVariation({ plan, projectId, task, actor }) {
  if (!isControlled(task, plan.baselinedContractIds ?? new Set())) return [];
  const baselined = wasBaselined(plan, task.id);
  return applyVariationSlot({
    plan, projectId, taskId: task.id, kind: 'scope', scopeType: 'project', scopeId: projectId,
    position: {
      changed: baselined,
      baseline_value: baselined ? { name: task.name } : null,
      current_value: { removed: true, name: task.name },
      delta: { removed: true },
    },
    cause: 'direct', causeTaskId: null, actor,
  });
}

/**
 * Cost / material slot for one (task, contract) after a cost-line write.
 * There is no baseline_cost_line for an unsigned contract, so the reference
 * is the total BEFORE the first divergence, held in the open variation.
 */
async function runCostVariation({ plan, projectId, task, contractId, kind, priorValue, currentValue, actor }) {
  if (!contractId) return []; // owner estimates are nobody's controlled cost
  if (!task || !isControlled(task, plan.baselinedContractIds ?? new Set())) return [];
  const key = VARIATION_KEY(task.id, kind, contractId);
  const existing = plan.variations?.get(key) ?? null;
  let position;
  if (kind === 'cost') {
    const baselineTotal = existing ? Number(existing.baselineValue?.total_cents ?? priorValue) : priorValue;
    position = costPosition({ baselineTotalCents: baselineTotal, currentTotalCents: currentValue });
  } else {
    const baselineSpec = existing ? (existing.baselineValue?.material_spec ?? null) : (priorValue ?? null);
    position = {
      changed: baselineSpec !== (currentValue ?? null),
      baseline_value: { material_spec: baselineSpec },
      current_value: { material_spec: currentValue ?? null },
      delta: { from: baselineSpec, to: currentValue ?? null },
    };
  }
  return applyVariationSlot({
    plan, projectId, taskId: task.id, kind, scopeType: 'contract', scopeId: contractId,
    position, cause: 'direct', causeTaskId: null, actor,
  });
}

/** Engine results → wire bodies the VIEWER may see (V2/V5). */
function visibleVariationBodies(results, plan, viewerOrgId) {
  return results
    .filter((v) => variationVisibleTo(v, viewerOrgId, { contracts: plan.contracts }))
    .map((v) => variationBody(v, { taskName: plan.tasks.get(v.taskId)?.name }));
}

function addLink({ plan, spec, viewer, actor }) {
  const pred = plan.tasks.get(spec.predecessor_id);
  const succ = plan.tasks.get(spec.successor_id);
  if (!pred || !succ) {
    throw new ProblemError('validation_failed', null, { errors: { predecessor_id: 'both rows must be rows of this plan' } });
  }
  if (plan.links.some((l) => l.predecessorId === spec.predecessor_id && l.successorId === spec.successor_id)) {
    throw new ProblemError('version_conflict', 'these rows are already linked');
  }
  if (!inEditScope(world(plan), succ, viewer.orgId)) {
    throw new ProblemError('out_of_scope', 'the successor is outside your branch scope — the link moves it');
  }
  const cycle = cyclePath(plan.links, { predecessorId: spec.predecessor_id, successorId: spec.successor_id });
  if (cycle) throw new ProblemError('dependency_cycle', null, { path: cycle });
  const link = {
    id: spec.id ?? randomUUID(),
    projectId: succ.projectId,
    predecessorId: spec.predecessor_id,
    successorId: spec.successor_id,
    fromAnchor: spec.from_anchor,
    toAnchor: spec.to_anchor,
    lagWd: spec.lag_wd ?? 0,
    createdByOrgId: viewer.orgId,
    createdByPersonId: actor.id,
  };
  plan.write.insertLink(link);
  plan.links = [...plan.links, link];
  return link;
}

function moveSubtree({ plan, op, viewer }) {
  const task = mustTask(plan, op.task_id);
  const siblings = (parentId) => [...plan.tasks.values()]
    .filter((t) => (t.parentId ?? null) === (parentId ?? null) && !t.deletedAt && t.id !== task.id)
    .sort((a, b) => (a.position < b.position ? -1 : 1));

  let newParentId;
  let afterPosition = op.after_position ?? null;
  if (op.op === 'indent') {
    const prev = siblings(task.parentId).filter((s) => s.position < task.position).at(-1);
    if (!prev) throw new ProblemError('invalid_transition', 'no previous sibling to indent under');
    newParentId = prev.id;
  } else if (op.op === 'outdent') {
    const parent = task.parentId ? plan.tasks.get(task.parentId) : null;
    if (!parent) throw new ProblemError('invalid_transition', 'already at the top level');
    newParentId = parent.parentId ?? null;
    afterPosition = parent.position;
  } else {
    newParentId = op.new_parent_id ?? null;
  }
  const newParent = newParentId ? plan.tasks.get(newParentId) : null;
  if (newParentId && !newParent) {
    throw new ProblemError('validation_failed', null, { errors: { new_parent_id: 'not a row of this plan' } });
  }
  if (newParentId === task.id || descendantIds(plan.tasks, task.id).includes(newParentId)) {
    throw new ProblemError('invalid_transition', 'cannot move a row under itself');
  }

  const subtree = [task.id, ...descendantIds(plan.tasks, task.id)];
  for (const id of subtree) {
    if (!inEditScope(world(plan), plan.tasks.get(id), viewer.orgId)) {
      throw new ProblemError('out_of_scope', 'the subtree crosses out of your branch scope');
    }
  }
  if (newParent && !inEditScope(world(plan), newParent, viewer.orgId)) {
    throw new ProblemError('out_of_scope', 'the target parent is outside your branch scope');
  }

  const height = Math.max(...subtree.map((id) => plan.tasks.get(id).depth)) - task.depth;
  const newDepth = (newParent?.depth ?? 0) + 1;
  if (newDepth + height > 10) throw new ProblemError('too_deep', 'the plan supports up to 10 levels (D-25)');

  const sibs = siblings(newParentId);
  let position;
  if (afterPosition) {
    const next = sibs.find((s) => s.position > afterPosition);
    position = keyBetween(afterPosition, next?.position ?? null);
  } else {
    position = keyBetween(sibs.at(-1)?.position ?? null, null);
  }

  const depthShift = newDepth - task.depth;
  const newBranch = task.contractId ?? (newParent ? (newParent.contractId ?? newParent.branchContractId) : null);
  const changed = [];
  for (const id of subtree) {
    const t = plan.tasks.get(id);
    const patch = {
      depth: t.depth + depthShift,
      ...(id === task.id
        ? { parentId: newParentId, position }
        : {}),
      ...(t.contractId || (id !== task.id && t.branchContractId !== task.branchContractId)
        ? {}
        : { branchContractId: newBranch }),
    };
    plan.write.patchTask(id, patch);
    const next = { ...t, ...patch };
    plan.tasks.set(id, next);
    changed.push(next);
  }
  return changed;
}

function mustTask(plan, id) {
  const t = id ? plan.tasks.get(id) : null;
  if (!t || t.deletedAt) throw new ProblemError('not_found', 'row not found in this plan');
  return t;
}

function isMySupplier(plan, clientOrgId, supplierOrgId) {
  return [...plan.contracts.values()].some(
    (c) => c.clientOrgId === clientOrgId && c.supplierOrgId === supplierOrgId,
  );
}

function fieldChangeOf({ taskId, field, oldValue, newValue, actor, viewer, cause, causeTaskId = null, clientChangeId = null }) {
  return {
    taskId,
    field,
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
    baseValue: null,
    changedByPersonId: actor.id,
    changedByOrgId: viewer.orgId,
    cause,
    channel: viewer.channel ?? 'ui',
    causeTaskId,
    clientChangeId,
  };
}

async function commitPlanEvent(plan, { projectId, actor, type, objectId, objectType = 'task', payload, data }) {
  await plan.write.ledger({
    projectId,
    actor: { personId: actor.personId, orgId: actor.orgId, orgRole: actor.orgRole },
    category: 'planning',
    type,
    scope: { type: 'project', id: projectId },
    object: { type: objectType, id: objectId },
    payload,
    channel: actor.channel ?? 'ui',
  });
  plan.write.publish(envelope({ projectId, actor, type, data }));
}

function envelope({ projectId, actor, type, data }) {
  return {
    event_id: randomUUID(),
    type,
    version: 1,
    project_id: projectId,
    actor: { person_id: actor.personId ?? null, org_id: actor.orgId ?? null },
    scope: { type: 'project', id: projectId },
    data,
  };
}

function projectFinish(spans) {
  let max = null;
  for (const s of spans.values()) if (s.finish && (!max || s.finish > max)) max = s.finish;
  return max;
}

function finishDelta(cal, before, after) {
  if (!before || !after) return 0;
  return workingDaysDelta(cal, before, after);
}

function deltaResult({ plan, viewer, task, propagated = [], overwrote = [], link = null, variations = [] }) {
  const ctx = projectionCtx(plan, viewer.orgId, today());
  return {
    task: taskBody(plan.tasks.get(task.id) ?? task, ctx),
    propagated: propagated.map((m) => ({ id: m.id, start: m.start, finish: m.finish, cause_task_id: m.causeTaskId })),
    variations: visibleVariationBodies(variations, plan, viewer.orgId),
    overwrote,
    ...(link ? { link: linkBody(link) } : {}),
    health: planHealth(plan),
  };
}

function dedupeById(bodies) {
  const seen = new Set();
  return bodies.filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)));
}
