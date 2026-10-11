// PRD-13 / D-43 use cases that sit beside the per-operation ones:
//
//   takeAwardBaseline — consumer of tendering.rfp.awarded (doc 10). D-43: the
//     baseline of the awarded branch is taken AT AWARD, with the winning
//     proposal's start and duration. Everything it needs rides on the event
//     (roots, winner, start, duration_wd) — planning never reads tendering
//     tables. In ONE plan transaction: the winning dates land on the tendered
//     rows (field history cause 'award'), links propagate (D-22), the winner
//     takes the roots (doc 06 §Award), then the branch is bound and baseline v1
//     is taken with the same code the signature consumer uses. Idempotent: a
//     contract that already has a baseline absorbs the replay.
//
//   acknowledgeVariations — "Acknowledge all in view" (PRD-13 S-15): the same
//     guard as acknowledgeVariation for EVERY id, then one transaction.
import { ProblemError } from '../../../platform/errors.mjs';
import { makeCalendar, durationWd, spanFinish, snapForward, workingDaysDelta, shiftWorkingDays } from '../domain/calendar.mjs';
import { descendantIds, effectiveSpans } from '../domain/propagation.mjs';
import { variationVisibleTo } from '../domain/variations.mjs';
import { variationBody } from './projection.mjs';
import {
  actorOf, requireActiveOrg, requireParticipant, propagateAndPersist, fieldChangeOf, viewerWho,
} from './use-cases.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const WIRE_FIELD = { durationWd: 'duration_wd', datingMode: 'dating_mode' };

/** Consumer use case for tendering.rfp.awarded (D-43). */
export async function takeAwardBaseline({ store, evt }) {
  const d = evt?.data ?? {};
  const contractId = d.contract_id;
  const roots = Array.isArray(d.root_task_ids) ? d.root_task_ids : [];
  if (!contractId || !roots.length || !evt.project_id) {
    return { taken: false, reason: 'the award carries no contract or no tendered rows' };
  }
  const actor = {
    personId: evt.actor?.person_id ?? null,
    orgId: evt.actor?.org_id ?? null,
    channel: 'system',
  };
  return store.withPlanTx(evt.project_id, async (plan) => {
    if (plan.baselinedContractIds?.has(contractId)) return { taken: false, reason: 'already baselined' };
    const live = roots.filter((id) => plan.tasks.has(id));
    if (!live.length) return { taken: false, reason: 'the tendered rows are gone' };
    const cal = makeCalendar(plan.calendarRaw);

    const moved = applyAwardDates({
      plan, cal, roots: live, actor,
      start: ISO_DATE.test(d.start ?? '') ? d.start : null,
      duration: Number.isInteger(d.duration_wd) && d.duration_wd > 0 ? d.duration_wd : null,
    });
    if (d.supplier_org_id && UUID.test(d.supplier_org_id)) {
      assignRoots({ plan, roots: live, supplierOrgId: d.supplier_org_id, actor });
    }
    if (moved.length) {
      await propagateAndPersist({ plan, cal, seedIds: moved, actor, clientChangeId: null });
    }
    const taken = await plan.write.takeBaseline({
      contractId, projectId: evt.project_id, roots: live, reason: 'award', actor,
      payload: {
        rfp_id: d.rfp_id ?? null, proposal_id: d.proposal_id ?? null,
        ...(d.start ? { start: d.start } : {}), ...(d.duration_wd ? { duration_wd: d.duration_wd } : {}),
      },
    });
    return taken ? { taken: true, baselineId: taken.baselineId } : { taken: false, reason: 'already baselined' };
  });
}

/**
 * The winning start/duration on the tendered rows. A single LEAF root takes
 * both (finish = start + duration on the project calendar). Otherwise — a
 * summary root, or several roots — the package moves rigidly so it starts on
 * the winning start: every leaf below shifts by the same working-day offset and
 * keeps its duration (a duration cannot be split across rows honestly, so it is
 * not applied). No start on the bid → only a single leaf's duration changes.
 * Returns the ids whose dates changed (the propagation seeds).
 */
function applyAwardDates({ plan, cal, roots, start, duration, actor }) {
  const leafIds = (id) => {
    const below = descendantIds(plan.tasks, id);
    return below.length ? below.filter((x) => descendantIds(plan.tasks, x).length === 0) : [id];
  };
  const singleLeaf = roots.length === 1 && descendantIds(plan.tasks, roots[0]).length === 0;
  const changed = [];
  const write = (id, patch) => {
    const before = plan.tasks.get(id);
    const real = Object.fromEntries(Object.entries(patch).filter(([k, v]) => before[k] !== v));
    if (!Object.keys(real).length) return;
    plan.tasks.set(id, { ...before, ...real });
    plan.write.patchTask(id, {
      ...real,
      lastChangedByPersonId: actor.personId, lastChangedByOrgId: actor.orgId,
      lastChangedAt: new Date().toISOString(), lastChangeCause: 'award',
    });
    for (const [field, value] of Object.entries(real)) {
      if (!actor.personId || !actor.orgId) continue; // history needs an author
      plan.write.fieldChange(fieldChangeOf({
        taskId: id, field: WIRE_FIELD[field] ?? field, oldValue: before[field], newValue: value,
        actor: { id: actor.personId }, viewer: { orgId: actor.orgId, channel: 'system' }, cause: 'award',
      }));
    }
    changed.push(id);
  };

  if (singleLeaf) {
    const t = plan.tasks.get(roots[0]);
    if (t.actualStart || t.actualFinish || t.kind === 'milestone') return changed;
    const s = start ? snapForward(cal, start) : t.start;
    if (!s) return changed;
    const dur = duration ?? t.durationWd ?? (t.finish ? durationWd(cal, s, t.finish) : null);
    if (!dur) return changed;
    write(t.id, { start: s, finish: spanFinish(cal, s, dur), durationWd: dur, datingMode: 'dated' });
    return changed;
  }

  if (!start) return changed;
  const spans = effectiveSpans(plan.tasks);
  const starts = roots.map((id) => spans.get(id)?.start).filter(Boolean).sort();
  if (!starts.length) return changed;
  const offset = workingDaysDelta(cal, snapForward(cal, starts[0]), snapForward(cal, start));
  if (offset === 0) return changed;
  for (const root of roots) {
    for (const id of leafIds(root)) {
      const t = plan.tasks.get(id);
      if (!t?.start || t.actualStart || t.actualFinish) continue; // started rows never move (D-22)
      const s = shiftWorkingDays(cal, t.start, offset);
      const dur = t.durationWd ?? (t.finish ? durationWd(cal, t.start, t.finish) : 1);
      write(id, { start: s, finish: t.kind === 'milestone' ? s : spanFinish(cal, s, dur) });
    }
  }
  return changed;
}

/** doc 06 §Award: the tendered rows are the winner's now. */
function assignRoots({ plan, roots, supplierOrgId, actor }) {
  for (const id of roots) {
    const before = plan.tasks.get(id);
    if (before.assigneeOrgId === supplierOrgId && before.assigneeInherited === false) continue;
    plan.tasks.set(id, { ...before, assigneeOrgId: supplierOrgId, assigneeInherited: false });
    plan.write.patchTask(id, { assigneeOrgId: supplierOrgId, assigneeInherited: false });
    if (actor.personId && actor.orgId) {
      plan.write.fieldChange(fieldChangeOf({
        taskId: id, field: 'assignee_org_id', oldValue: before.assigneeOrgId, newValue: supplierOrgId,
        actor: { id: actor.personId }, viewer: { orgId: actor.orgId, channel: 'system' }, cause: 'award',
      }));
    }
  }
}

/** operationId: acknowledgeVariations — PRD-13 S-15, all or nothing. */
export async function acknowledgeVariations({ viewer, store, projectId, body, idempotencyKey = null }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:variations:acknowledge')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const ids = Array.isArray(body?.variation_ids) ? [...new Set(body.variation_ids)] : null;
  if (!ids || !ids.length || ids.length > 200 || ids.some((id) => !UUID.test(id ?? ''))) {
    throw new ProblemError('validation_failed', null, { errors: { variation_ids: '1 to 200 variation ids' } });
  }
  const { actor } = await requireParticipant({ viewer, store, projectId });
  // Inside the reservation: a replay answers the first result instead of
  // refusing the now-acknowledged variations.
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'acknowledgeVariations', body: { project_id: projectId, ...body } },
    () => acknowledge({ viewer, store, projectId, ids, actor }),
  );
}

async function acknowledge({ viewer, store, projectId, ids, actor }) {
  const snapshot = await store.loadPlan(projectId);
  const who = viewerWho(viewer, snapshot);
  const refused = [];
  for (const id of ids) {
    const v = await store.getVariation(id);
    const ok = v && v.projectId === projectId
      && variationVisibleTo(v, viewer.orgId, { contracts: snapshot.contracts })
      && variationBody(v, { who }).can_acknowledge;
    if (!ok) refused.push(id);
  }
  if (refused.length) {
    throw new ProblemError('validation_failed', 'some of these cannot be acknowledged by you', {
      errors: { variation_ids: `not acknowledgeable: ${refused.join(', ')}` },
    });
  }
  const updated = await store.acknowledgeVariations({ variationIds: ids, actor: actorOf(actor, viewer) });
  return { status: 200, body: { items: updated.map((v) => variationBody(v, { who })) } };
}
