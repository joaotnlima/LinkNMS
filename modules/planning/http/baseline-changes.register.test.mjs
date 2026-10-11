// PRD-13 over the /api/v2 router, DB-free: overrun + projected push on the
// read (D-44: nothing written), vs-baseline deltas and the handover header,
// the "why" on a variation, seen/acknowledge per viewer, the batch
// acknowledge, the S-10 preview note and `done` closing a row late.
// Dates are relative to the real today, so the overrun is always "now".
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { makeCalendar, shiftWorkingDays, nextWorkingDay, workingDaysDelta, snapBack } from '../domain/calendar.mjs';
import { registerPlanning } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000001a1';
const GC_ORG = '01920000-0000-7000-8000-0000000001a2';
const PROJECT = '01920000-0000-7000-8000-0000000001b1';
const PRIME = '01920000-0000-7000-8000-0000000001c1';
const ME = '01920000-0000-7000-8000-0000000001e1';
const ROOT = '01920000-0000-7000-8000-0000000001d1';
const FRAME = '01920000-0000-7000-8000-0000000001d2';
const COVER = '01920000-0000-7000-8000-0000000001d3';

const cal = makeCalendar({ work_days: [1, 2, 3, 4, 5] });
const TODAY = new Date().toISOString().slice(0, 10);
// FRAME should have finished 3 working days ago; COVER follows it (end→start).
const FRAME_FINISH = shiftWorkingDays(cal, snapBack(cal, TODAY), -3);
const FRAME_START = shiftWorkingDays(cal, FRAME_FINISH, -4);
const COVER_START = nextWorkingDay(cal, FRAME_FINISH);
const COVER_FINISH = shiftWorkingDays(cal, COVER_START, 9);

function task(id, over) {
  return {
    id, projectId: PROJECT, parentId: ROOT, depth: 2, position: 'm', kind: 'task', name: id,
    description: null, specialty: null, locationId: null, contractId: null, branchContractId: PRIME,
    assigneeOrgId: null, assigneePersonId: null, assigneeInherited: true, datingMode: 'dated',
    start: null, finish: null, durationWd: null, actualStart: null, actualFinish: null,
    acceptanceCriteria: null, baselineStart: null, baselineFinish: null, baselineVersion: null,
    scheduleState: 'on_baseline', lastChangedByPersonId: ME, lastChangedByOrgId: GC_ORG,
    lastChangedAt: '2026-09-20T10:00:00Z', lastChangeCause: 'direct', deletedAt: null, ...over,
  };
}

function fakeStore() {
  const state = {
    tasks: new Map([
      [ROOT, task(ROOT, { parentId: null, depth: 1, name: 'Construction', contractId: PRIME,
        assigneeOrgId: GC_ORG, assigneeInherited: false })],
      [FRAME, task(FRAME, { name: 'Frame', position: 'ma', start: FRAME_START, finish: FRAME_FINISH,
        durationWd: 5, baselineStart: FRAME_START, baselineFinish: FRAME_FINISH })],
      [COVER, task(COVER, { name: 'Covering', position: 'mb', start: COVER_START, finish: COVER_FINISH,
        durationWd: 10, baselineStart: COVER_START, baselineFinish: COVER_FINISH })],
    ]),
    links: [{ id: randomUUID(), projectId: PROJECT, predecessorId: FRAME, successorId: COVER,
      fromAnchor: 'end', toAnchor: 'start', lagWd: 0, createdByOrgId: GC_ORG, createdByPersonId: ME }],
    variations: new Map(), acks: [], fieldChanges: [], progress: [], events: [], changeIds: new Set(),
  };
  const contracts = () => new Map([[PRIME, { supplierOrgId: GC_ORG, clientOrgId: OWNER_ORG, parentContractId: null, status: 'draft' }]]);
  const withAcks = (v) => ({ ...v, acks: state.acks.filter((a) => a.variationId === v.id) });
  const loadPlan = () => ({
    tasks: new Map([...state.tasks].map(([id, t]) => [id, { ...t }])),
    links: state.links.map((l) => ({ ...l })),
    calendarRaw: { work_days: [1, 2, 3, 4, 5], holidays: [], closures: [] },
    contracts: contracts(), ownerOrgId: OWNER_ORG,
    statuses: new Map(state.progress.map((p) => [p.taskId, p.status])),
    orgNames: new Map([[OWNER_ORG, 'Família Almeida'], [GC_ORG, 'Obra Nova']]),
    boqLines: [], costedTaskIds: new Set(),
    variations: new Map([...state.variations.values()]
      .filter((v) => ['open', 'acknowledged'].includes(v.status))
      .map((v) => [`${v.taskId}|${v.kind}|${v.scopeId}`, { ...v }])),
    baselinedContractIds: new Set([PRIME]),
    baselineMeta: new Map([[PRIME, { version: 1, reason: 'award', takenAt: '2026-09-01T09:00:00.000Z' }]]),
    baselineText: new Map([...state.tasks.keys()].map((id) => [id, { scopeText: null, acceptanceCriteria: null }])),
  });
  const ack = (variationId, actor) => {
    const v = state.variations.get(variationId);
    state.acks.push({ variationId, orgId: actor.orgId, personId: actor.personId, acknowledgedAt: new Date(Date.now() + 1000).toISOString() });
    if (v.status === 'open') state.variations.set(variationId, { ...v, status: 'acknowledged' });
    return withAcks(state.variations.get(variationId));
  };
  return {
    state,
    async getPersonByClerkId() { return { id: ME }; },
    async getProject(id) { return id === PROJECT ? { id, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG } : null; },
    async isParticipant(p, org) { return p === PROJECT && [OWNER_ORG, GC_ORG].includes(org); },
    async isStaffed() { return false; },
    async getTask(id) { const t = state.tasks.get(id); return t ? { ...t } : null; },
    async loadPlan() { return loadPlan(); },
    async listFieldChanges(taskId) { return state.fieldChanges.filter((f) => f.taskId === taskId); },
    async listProgress(taskId) { return state.progress.filter((p) => p.taskId === taskId); },
    async listVariations(projectId, { taskId } = {}) {
      return [...state.variations.values()].filter((v) => !taskId || v.taskId === taskId).map(withAcks);
    },
    async getVariation(id) { const v = state.variations.get(id); return v ? withAcks({ ...v }) : null; },
    async acknowledgeVariation({ variationId, actor }) { return ack(variationId, actor); },
    async acknowledgeVariations({ variationIds, actor }) { return variationIds.map((id) => ack(id, actor)); },
    async insertProgress(args) {
      const report = { ...args, seq: state.progress.length + 1, reportedByOrgId: args.actor.orgId,
        reportedByPersonId: args.actor.personId, reportedAt: new Date().toISOString() };
      state.progress.push(report);
      return report;
    },
    async idempotent(meta, fn) { return fn(); },
    async withPlanTx(projectId, fn) {
      const plan = {
        ...loadPlan(),
        hasChange: async (id) => state.changeIds.has(id),
        write: {
          patchTask: (id, patch) => state.tasks.set(id, { ...state.tasks.get(id), ...patch }),
          fieldChange: (fc) => { state.fieldChanges.push(fc); if (fc.clientChangeId) state.changeIds.add(fc.clientChangeId); },
          patchLink: () => {},
          insertVariation: (v) => state.variations.set(v.id, { ...v, projectId: PROJECT }),
          patchVariation: (id, patch) => state.variations.set(id, {
            ...state.variations.get(id), ...patch, lastChangedAt: new Date().toISOString(),
          }),
          insertProgress: (args) => this.insertProgress(args),
          ledger: () => {},
          publish: (evt) => state.events.push(evt),
        },
      };
      return fn(plan);
    },
  };
}

const PERMS = ['org:plan:edit', 'org:progress:report', 'org:variations:acknowledge'];
const viewer = (orgId) => createViewerContext({
  clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: `clerk_${orgId}`,
  orgKind: orgId === OWNER_ORG ? 'household' : 'contractor', orgRole: 'manager', permissions: PERMS, channel: 'ui',
});

let store;
let router;
beforeEach(() => {
  store = fakeStore();
  router = createRouter();
  registerPlanning(router, { store });
});
const call = (method, path, who, body = null) => router.dispatch({ method, path, viewer: who, body, headers: {} });
const byId = (body) => Object.fromEntries(body.tasks.map((t) => [t.id, t]));

describe('PRD-13 on the plan read (D-44: drawn, never written)', () => {
  test('overrun to today on the late leaf, projected push on its successor, deltas, handover', async () => {
    const res = await call('GET', `/projects/${PROJECT}/schedule`, viewer(OWNER_ORG));
    assert.equal(res.status, 200);
    const t = byId(res.body);
    const overrun = t[FRAME].segments.find((s) => s.kind === 'overrun');
    assert.deepEqual(overrun, {
      kind: 'overrun', from: FRAME_FINISH, to: TODAY,
      delta_wd: workingDaysDelta(cal, FRAME_FINISH, TODAY), cause: 'not_closed',
    });
    assert.equal(t[FRAME].overrun_wd, workingDaysDelta(cal, FRAME_FINISH, TODAY));
    assert.equal(t[FRAME].baseline_delta_wd, workingDaysDelta(cal, FRAME_FINISH, TODAY));

    const projected = t[COVER].projected;
    assert.equal(projected.cause_task_id, FRAME);
    assert.ok(projected.finish > COVER_FINISH);
    assert.equal(t[COVER].finish, COVER_FINISH); // stored dates untouched
    assert.equal(store.state.tasks.get(COVER).finish, COVER_FINISH);
    assert.equal(t[COVER].baseline_delta_wd, workingDaysDelta(cal, COVER_FINISH, projected.finish));
    assert.ok(t[COVER].segments.some((s) => s.kind === 'projected' && s.cause === 'pushed'));
    // the summary carries the net
    assert.equal(t[ROOT].baseline_delta_wd, t[COVER].baseline_delta_wd);
    // the baseline says when it was taken (D-43)
    assert.equal(t[COVER].baseline.reason, 'award');

    assert.deepEqual(res.body.handover, {
      finish: COVER_FINISH, projected_finish: projected.finish, baseline_finish: COVER_FINISH,
      delta_wd: workingDaysDelta(cal, COVER_FINISH, projected.finish),
    });
    assert.deepEqual(res.body.changes, { total: 0, unseen: 0 });
    assert.equal(store.state.events.length, 0);
  });
});

describe('moving a finish (S-10, S-11)', () => {
  test('the preview names what it pushes, the new handover, the delta and who is told', async () => {
    const newFinish = shiftWorkingDays(cal, FRAME_FINISH, 10);
    const res = await call('POST', `/tasks/${FRAME}:preview-move`, viewer(GC_ORG), { finish: newFinish });
    assert.equal(res.status, 200);
    assert.equal(res.body.baseline_delta_wd, 10);
    assert.equal(res.body.would_move[0].id, COVER);
    assert.equal(res.body.would_move[0].name, 'Covering');
    assert.equal(res.body.project_finish.after, res.body.would_move[0].finish);
    assert.deepEqual(res.body.notify, [{ org_id: OWNER_ORG, org_name: 'Família Almeida', role: 'owner' }]);
    assert.equal(store.state.tasks.get(FRAME).finish, FRAME_FINISH); // nothing written
  });

  test('the "why" lands on the variation; the owner sees it unseen and may acknowledge', async () => {
    const newFinish = shiftWorkingDays(cal, FRAME_FINISH, 10);
    const res = await call('PATCH', `/tasks/${FRAME}`, viewer(GC_ORG), {
      client_change_id: randomUUID(), reason: '  Concrete curing extended after the rain week. ',
      changes: { finish: { value: newFinish, base: FRAME_FINISH } },
    });
    assert.equal(res.status, 200);
    const mine = res.body.variations.find((v) => v.task_id === FRAME && v.kind === 'time');
    assert.equal(mine.reason, 'Concrete curing extended after the rain week.');
    assert.equal(mine.can_acknowledge, false); // the GC is not the owner
    const pushed = res.body.variations.find((v) => v.task_id === COVER && v.kind === 'time');
    assert.equal(pushed.cause, 'propagated');
    assert.equal(pushed.reason, undefined);

    const list = await call('GET', `/projects/${PROJECT}/variations`, viewer(OWNER_ORG));
    const frameVar = list.body.items.find((v) => v.task_id === FRAME && v.kind === 'time');
    assert.equal(frameVar.can_acknowledge, true);
    assert.equal(frameVar.seen_by_viewer, false);
    const owner = await call('GET', `/projects/${PROJECT}/schedule`, viewer(OWNER_ORG));
    assert.deepEqual(owner.body.changes, { total: 2, unseen: 2 });
    const gc = await call('GET', `/projects/${PROJECT}/schedule`, viewer(GC_ORG));
    assert.deepEqual(gc.body.changes, { total: 2, unseen: 0 });

    const ack = await call('POST', `/variations/${frameVar.id}:acknowledge`, viewer(OWNER_ORG));
    assert.equal(ack.status, 200);
    assert.equal(ack.body.seen_by_viewer, true);
    const after = await call('GET', `/projects/${PROJECT}/schedule`, viewer(OWNER_ORG));
    assert.equal(after.body.changes.unseen, 1);
  });

  test('a reason over 500 characters is refused', async () => {
    const res = await call('PATCH', `/tasks/${FRAME}`, viewer(GC_ORG), {
      client_change_id: randomUUID(), reason: 'x'.repeat(501),
      changes: { finish: { value: shiftWorkingDays(cal, FRAME_FINISH, 2) } },
    });
    assert.equal(res.status, 422);
  });
});

describe('acknowledge all in view (S-15)', () => {
  test('all or nothing: the GC is refused, the owner acknowledges every listed change', async () => {
    await call('PATCH', `/tasks/${FRAME}`, viewer(GC_ORG), {
      client_change_id: randomUUID(), changes: { finish: { value: shiftWorkingDays(cal, FRAME_FINISH, 4) } },
    });
    const ids = [...store.state.variations.keys()];
    assert.equal(ids.length, 2);
    const refused = await call('POST', `/projects/${PROJECT}/variations:acknowledge`, viewer(GC_ORG), { variation_ids: ids });
    assert.equal(refused.status, 422);
    assert.equal(store.state.acks.length, 0);
    const bad = await call('POST', `/projects/${PROJECT}/variations:acknowledge`, viewer(OWNER_ORG), { variation_ids: [] });
    assert.equal(bad.status, 422);
    const ok = await call('POST', `/projects/${PROJECT}/variations:acknowledge`, viewer(OWNER_ORG), { variation_ids: ids });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.items.length, 2);
    assert.ok(ok.body.items.every((v) => v.status === 'acknowledged' && v.seen_by_viewer));
  });
});

describe('closing a late task (S-3, S-12)', () => {
  test('done on an overrunning leaf records the actual finish today, closed_late, and pushes', async () => {
    const res = await call('POST', `/tasks/${FRAME}/progress`, viewer(GC_ORG), { status: 'done' });
    assert.equal(res.status, 201);
    const frame = store.state.tasks.get(FRAME);
    assert.equal(frame.actualFinish, TODAY);
    const v = [...store.state.variations.values()].find((x) => x.taskId === FRAME && x.kind === 'time');
    assert.equal(v.cause, TODAY > FRAME_FINISH ? 'closed_late' : 'direct');
    assert.ok(store.state.tasks.get(COVER).start > COVER_START); // a real close does push (D-22)
    const read = byId((await call('GET', `/projects/${PROJECT}/schedule`, viewer(OWNER_ORG))).body);
    assert.ok(!read[FRAME].segments.some((s) => s.kind === 'overrun'));
    assert.equal(read[FRAME].segments.find((s) => s.kind === 'extension').cause, 'closed_late');
  });

  test('an actual finish in the future, or without done, is refused', async () => {
    const future = await call('POST', `/tasks/${FRAME}/progress`, viewer(GC_ORG), { status: 'done', actual_finish: '2999-01-01' });
    assert.equal(future.status, 422);
    const notDone = await call('POST', `/tasks/${FRAME}/progress`, viewer(GC_ORG), { status: 'in_progress', actual_finish: TODAY });
    assert.equal(notDone.status, 422);
  });
});
