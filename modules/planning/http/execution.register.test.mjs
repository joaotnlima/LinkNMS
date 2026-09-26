// Phase-5 planning surface over the /api/v2 router, DB-free: the variations
// engine on the write paths (record / refresh / propagated cause / close /
// reopen), cost lines with V2/V5 visibility and the change-order fence,
// progress reporting ('verified' is Quality's word), acknowledgement rules
// and the question hand-off.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerPlanning } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const GC_ORG = '01920000-0000-7000-8000-0000000000a2';
const SUB_ORG = '01920000-0000-7000-8000-0000000000a3';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const PRIME = '01920000-0000-7000-8000-0000000000c1';   // signed + baselined
const DRAFTK = '01920000-0000-7000-8000-0000000000c3';  // draft sub deal, GC ↔ SUB
const ME = '01920000-0000-7000-8000-0000000000e1';

const GC_ROOT = '01920000-0000-7000-8000-0000000000d1';
const TASK_A = '01920000-0000-7000-8000-0000000000d2';
const TASK_B = '01920000-0000-7000-8000-0000000000d3';
const LINK_AB = '01920000-0000-7000-8000-00000000f001';
const BOQ_PRIME = '01920000-0000-7000-8000-00000000f101';

const uuid = () => randomUUID();

function baseTask(id, over = {}) {
  return {
    id, projectId: PROJECT, parentId: null, depth: 1, position: 'i', kind: 'task',
    name: id, description: null, specialty: null, locationId: null,
    contractId: null, branchContractId: null,
    assigneeOrgId: null, assigneePersonId: null, assigneeInherited: true,
    datingMode: 'undated', start: null, finish: null, durationWd: null,
    actualStart: null, actualFinish: null, acceptanceCriteria: null,
    baselineStart: null, baselineFinish: null, baselineVersion: null,
    scheduleState: 'planned', lastChangedByPersonId: ME, lastChangedByOrgId: GC_ORG,
    lastChangedAt: '2026-09-20T10:00:00Z', lastChangeCause: 'direct', deletedAt: null,
    ...over,
  };
}

// 2026-09-21 is a Monday. The GC branch is baselined on its current dates.
function seedTasks() {
  return [
    baseTask(GC_ROOT, {
      name: 'Empreitada geral', position: 'm',
      contractId: PRIME, branchContractId: PRIME,
      assigneeOrgId: GC_ORG, assigneeInherited: false,
    }),
    baseTask(TASK_A, {
      name: 'Fundações', parentId: GC_ROOT, depth: 2, position: 'ma',
      branchContractId: PRIME, datingMode: 'dated',
      start: '2026-09-21', finish: '2026-09-23', durationWd: 3,
      baselineStart: '2026-09-21', baselineFinish: '2026-09-23',
      description: 'sapatas corridas', acceptanceCriteria: 'betão C25/30',
      scheduleState: 'on_baseline',
    }),
    baseTask(TASK_B, {
      name: 'Estrutura', parentId: GC_ROOT, depth: 2, position: 'mb',
      branchContractId: PRIME, datingMode: 'dated',
      start: '2026-09-24', finish: '2026-09-25', durationWd: 2,
      baselineStart: '2026-09-24', baselineFinish: '2026-09-25',
      scheduleState: 'on_baseline',
    }),
  ];
}

function fakeStore() {
  const state = {
    tasks: new Map(seedTasks().map((t) => [t.id, t])),
    links: [{
      id: LINK_AB, projectId: PROJECT, predecessorId: TASK_A, successorId: TASK_B,
      fromAnchor: 'end', toAnchor: 'start', lagWd: 0, createdByOrgId: GC_ORG, createdByPersonId: ME,
    }],
    boqLines: [{
      id: BOQ_PRIME, projectId: PROJECT, contractId: PRIME, estimateOwnerOrgId: null,
      taskId: TASK_A, code: '1.1', description: 'Fundações', unit: 'm3',
      quantity: '10.000', unitPriceCents: 5000, materialSpec: null,
      introducedByChangeOrderId: null, supersededByChangeOrderId: null,
    }],
    variations: new Map(), // id → row (camelCase)
    acks: [],
    fieldChanges: [],
    progress: [],
    ledger: [],
    events: [],
    changeIds: new Set(),
  };

  const contracts = () => new Map([
    [PRIME, { supplierOrgId: GC_ORG, clientOrgId: OWNER_ORG, parentContractId: null, status: 'signed' }],
    [DRAFTK, { supplierOrgId: SUB_ORG, clientOrgId: GC_ORG, parentContractId: PRIME, status: 'draft' }],
  ]);

  const snapshotState = () => structuredClone({
    tasks: [...state.tasks.entries()],
    links: state.links,
    boqLines: state.boqLines,
    variations: [...state.variations.entries()],
    acks: state.acks,
    fieldChanges: state.fieldChanges,
    progress: state.progress,
    ledger: state.ledger,
    events: state.events,
    changeIds: [...state.changeIds],
  });
  const restore = (snap) => {
    state.tasks = new Map(snap.tasks);
    state.links = snap.links;
    state.boqLines = snap.boqLines;
    state.variations = new Map(snap.variations);
    state.acks = snap.acks;
    state.fieldChanges = snap.fieldChanges;
    state.progress = snap.progress;
    state.ledger = snap.ledger;
    state.events = snap.events;
    state.changeIds = new Set(snap.changeIds);
  };

  const withAcks = (v) => ({ ...v, acks: state.acks.filter((a) => a.variationId === v.id) });

  const loadPlan = () => ({
    tasks: new Map([...state.tasks].filter(([, t]) => !t.deletedAt).map(([id, t]) => [id, { ...t }])),
    links: state.links.map((l) => ({ ...l })),
    calendarRaw: { work_days: [1, 2, 3, 4, 5], holidays: [], closures: [] },
    contracts: contracts(),
    ownerOrgId: OWNER_ORG,
    statuses: new Map(),
    orgNames: new Map([[GC_ORG, 'Douro Construções'], [SUB_ORG, 'Canalizações Norte']]),
    boqLines: state.boqLines.map((l) => ({ ...l })),
    costedTaskIds: new Set(state.boqLines.filter((l) => l.taskId && !l.supersededByChangeOrderId).map((l) => l.taskId)),
    variations: new Map([...state.variations.values()]
      .filter((v) => ['open', 'acknowledged'].includes(v.status))
      .map((v) => [`${v.taskId}|${v.kind}|${v.scopeId}`, { ...v }])),
    baselinedContractIds: new Set([PRIME]),
    baselineText: new Map([
      [GC_ROOT, { scopeText: null, acceptanceCriteria: null }],
      [TASK_A, { scopeText: 'sapatas corridas', acceptanceCriteria: 'betão C25/30' }],
      [TASK_B, { scopeText: null, acceptanceCriteria: null }],
    ]),
  });

  return {
    state,
    async getPersonByClerkId(id) {
      return id === 'user_me' ? { id: ME, clerk_user_id: 'user_me', email: 'me@x.pt' } : null;
    },
    async getProject(id) {
      return id === PROJECT
        ? { id: PROJECT, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG, status: 'in_execution' }
        : null;
    },
    async isParticipant(projectId, orgId) {
      return projectId === PROJECT && [OWNER_ORG, GC_ORG, SUB_ORG].includes(orgId);
    },
    async isStaffed() { return false; },
    async getTask(id) {
      const t = state.tasks.get(id);
      return t ? { ...t } : null;
    },
    async getLink(id) {
      const l = state.links.find((x) => x.id === id);
      return l ? { ...l } : null;
    },
    async loadPlan() { return loadPlan(); },
    async listFieldChanges(taskId) { return state.fieldChanges.filter((f) => f.taskId === taskId); },
    async listProgress(taskId) { return state.progress.filter((p) => p.taskId === taskId); },
    async getCostLine(id) {
      const l = state.boqLines.find((x) => x.id === id);
      return l ? { ...l } : null;
    },
    async listVariations(projectId, { kind, status, taskId } = {}) {
      return [...state.variations.values()]
        .filter((v) => (!kind || v.kind === kind) && (!status || v.status === status) && (!taskId || v.taskId === taskId))
        .map((v) => withAcks({ ...v, taskName: state.tasks.get(v.taskId)?.name }));
    },
    async getVariation(id) {
      const v = state.variations.get(id);
      return v ? withAcks({ ...v, taskName: state.tasks.get(v.taskId)?.name, projectId: PROJECT }) : null;
    },
    async acknowledgeVariation({ variationId, actor }) {
      const v = state.variations.get(variationId);
      state.acks.push({ variationId, orgId: actor.orgId, personId: actor.personId, acknowledgedAt: '2026-09-26T10:00:00Z' });
      if (v.status === 'open') state.variations.set(variationId, { ...v, status: 'acknowledged' });
      state.ledger.push('planning.variation.acknowledged');
      state.events.push({ type: 'planning.variation.acknowledged' });
      return withAcks({ ...state.variations.get(variationId), taskName: state.tasks.get(v.taskId)?.name });
    },
    async questionVariation({ variationId, comment, actor }) {
      void variationId; void comment; void actor;
      state.ledger.push('planning.variation.questioned');
      state.events.push({ type: 'planning.variation.questioned' });
      return { createdAt: '2026-09-26T10:00:00Z' };
    },
    async insertProgress({ taskId, status, percent, note, photoDocumentIds, taskName, criteria, actor }) {
      const seq = state.progress.filter((p) => p.taskId === taskId).length + 1;
      const report = {
        taskId, seq, status, percent, note, photoDocumentIds,
        reportedByOrgId: actor.orgId, reportedByPersonId: actor.personId,
        onBehalfOfOrgId: null, reportedAt: '2026-09-26T10:00:00Z',
      };
      state.progress.push(report);
      state.ledger.push('planning.progress.reported');
      state.events.push({
        type: 'planning.progress.reported',
        data: { task_id: taskId, task_name: taskName, status, reported_by_org_id: actor.orgId, ...(criteria ? { criteria } : {}) },
      });
      return report;
    },
    async idempotent(meta, fn) { return fn(); },
    async withPlanTx(projectId, fn, { dryRun = false } = {}) {
      const snap = snapshotState();
      const plan = {
        ...loadPlan(),
        hasChange: async (id) => state.changeIds.has(id),
        write: {
          insertTask: (t) => state.tasks.set(t.id, { ...t }),
          patchTask: (id, patch) => state.tasks.set(id, { ...state.tasks.get(id), ...patch }),
          softDelete: (id) => state.tasks.set(id, { ...state.tasks.get(id), deletedAt: 'now' }),
          fieldChange: (fc) => {
            state.fieldChanges.push(fc);
            if (fc.clientChangeId) state.changeIds.add(fc.clientChangeId);
          },
          insertLink: (l) => state.links.push({ ...l }),
          patchLink: (id, patch) => {
            state.links = state.links.map((l) => (l.id === id ? { ...l, ...patch } : l));
          },
          removeLink: (id) => { state.links = state.links.filter((l) => l.id !== id); },
          insertVariation: (v) => state.variations.set(v.id, { ...v }),
          patchVariation: (id, patch) => state.variations.set(id, { ...state.variations.get(id), ...patch, lastChangedAt: new Date().toISOString() }),
          insertCostLine: (l) => state.boqLines.push({ ...l }),
          patchCostLine: (id, patch) => {
            state.boqLines = state.boqLines.map((l) => (l.id === id ? { ...l, ...patch } : l));
          },
          deleteCostLine: (id) => { state.boqLines = state.boqLines.filter((l) => l.id !== id); },
          ledger: (entry) => state.ledger.push(entry.type),
          publish: (evt) => state.events.push(evt),
        },
      };
      try {
        const result = await fn(plan);
        if (dryRun) restore(snap);
        return result;
      } catch (err) {
        restore(snap);
        throw err;
      }
    },
  };
}

const PERMS = ['org:plan:edit', 'org:costs:edit', 'org:progress:report', 'org:variations:acknowledge'];

function viewer(orgId, { role = 'manager', perms = PERMS, channel = 'ui' } = {}) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: orgId && `clerk_${orgId}`,
    orgKind: orgId === OWNER_ORG ? 'household' : 'contractor', orgRole: orgId ? role : null,
    permissions: perms, channel,
  });
}

describe('phase-5 planning over the /api/v2 router', () => {
  let router, store;

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerPlanning(router, { store });
  });

  const dispatch = (method, path, viewerCtx, body = null, headers = {}) =>
    router.dispatch({ method, path, viewer: viewerCtx, body, headers });

  const slipTaskA = (finish = '2026-09-25') =>
    dispatch('PATCH', `/tasks/${TASK_A}`, viewer(GC_ORG), {
      client_change_id: uuid(),
      changes: { finish: { value: finish, base: '2026-09-23' } },
    });

  describe('variations engine on the write paths', () => {
    test('a slip on a baselined row records a TIME variation, and propagation records one on the successor with cause=propagated', async () => {
      const res = await slipTaskA();
      assert.equal(res.status, 200);
      const kinds = res.body.variations.map((v) => [v.task_id, v.kind, v.cause]);
      assert.ok(kinds.some(([t, k, c]) => t === TASK_A && k === 'time' && c === 'direct'));
      assert.ok(kinds.some(([t, k, c]) => t === TASK_B && k === 'time' && c === 'propagated'));
      const direct = res.body.variations.find((v) => v.task_id === TASK_A && v.kind === 'time');
      assert.equal(direct.delta.finish_wd, 2);
      assert.equal(direct.status, 'open');
      assert.ok(store.state.events.some((e) => e.type === 'planning.variation.recorded'));
      assert.ok(store.state.ledger.includes('planning.variation.recorded'));
    });

    test('the variation is NET: a second slip refreshes, returning to baseline closes', async () => {
      await slipTaskA('2026-09-25');
      const again = await slipTaskA('2026-09-28');
      const v = again.body.variations.find((x) => x.task_id === TASK_A && x.kind === 'time');
      assert.equal(v.delta.finish_wd, 3);
      assert.ok(store.state.events.some((e) => e.type === 'planning.variation.updated'));
      assert.equal([...store.state.variations.values()].filter((x) => x.taskId === TASK_A && x.kind === 'time').length, 1);

      const back = await dispatch('PATCH', `/tasks/${TASK_A}`, viewer(GC_ORG), {
        client_change_id: uuid(), changes: { finish: { value: '2026-09-23' } },
      });
      const closed = back.body.variations.find((x) => x.task_id === TASK_A && x.kind === 'time');
      assert.equal(closed.status, 'closed');
      assert.ok(store.state.events.some((e) => e.type === 'planning.variation.closed'));
    });

    test('a new change on an ACKNOWLEDGED variation reopens it', async () => {
      await slipTaskA();
      const id = [...store.state.variations.values()].find((v) => v.taskId === TASK_A && v.kind === 'time').id;
      const ack = await dispatch('POST', `/variations/${id}:acknowledge`, viewer(OWNER_ORG));
      assert.equal(ack.status, 200);
      assert.equal(ack.body.status, 'acknowledged');
      assert.equal(ack.body.acknowledged_by.length, 1);

      await slipTaskA('2026-09-29');
      assert.equal(store.state.variations.get(id).status, 'open'); // reopened
    });

    test('scope-text drift records a SCOPE variation', async () => {
      const res = await dispatch('PATCH', `/tasks/${TASK_A}`, viewer(GC_ORG), {
        client_change_id: uuid(),
        changes: { description: { value: 'sapatas isoladas' } },
      });
      const v = res.body.variations.find((x) => x.kind === 'scope');
      assert.equal(v.delta.scope_text_changed, true);
      assert.equal(v.delta.acceptance_criteria_changed, false);
    });

    test('a row created inside the baselined branch → scope variation {added}', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/tasks`, viewer(GC_ORG), {
        id: uuid(), parent_id: GC_ROOT, name: 'Muro extra', start: '2026-10-05', duration_wd: 2,
      });
      assert.equal(res.status, 201);
      const v = res.body.variations.find((x) => x.kind === 'scope');
      assert.deepEqual(v.delta, { added: true });
    });

    test('deleting a baselined row → scope variation {removed}', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/schedule:apply`, viewer(GC_ORG), {
        operations: [{ op: 'delete_subtree', task_id: TASK_B }],
      });
      assert.equal(res.status, 200);
      const v = [...store.state.variations.values()].find((x) => x.taskId === TASK_B && x.kind === 'scope');
      assert.deepEqual(v.delta, { removed: true });
    });
  });

  describe('variations read side', () => {
    test('list + get, with time history derived from the delta ledger', async () => {
      await slipTaskA();
      const list = await dispatch('GET', `/projects/${PROJECT}/variations`, viewer(OWNER_ORG));
      assert.equal(list.status, 200);
      assert.ok(list.body.items.length >= 1);
      assert.equal(list.body.items[0].task_name, 'Fundações');

      const one = await dispatch('GET', `/variations/${list.body.items[0].id}`, viewer(SUB_ORG));
      assert.equal(one.status, 200);
      assert.ok(one.body.history.length >= 1); // from task_field_change
      assert.equal('finish' in one.body.history.at(-1).value, true);
    });

    test('cost variations follow V2/V5: the non-party participant never sees them', async () => {
      // the GC prices TASK_A on the DRAFT sub deal → cost variation on a controlled row
      const created = await dispatch('POST', `/tasks/${TASK_A}/cost-lines`, viewer(GC_ORG), {
        id: uuid(), contract_id: DRAFTK, code: 'd.1', description: 'Prumadas',
        unit: 'un', quantity: '2.000', unit_price: { amount_cents: 10000, currency: 'EUR' },
      });
      assert.equal(created.status, 201);
      const costVar = [...store.state.variations.values()].find((v) => v.kind === 'cost');
      assert.equal(costVar.delta.amount_cents, 20000);
      assert.equal(costVar.scopeId, DRAFTK);

      const asOwner = await dispatch('GET', `/projects/${PROJECT}/variations`, viewer(OWNER_ORG), null);
      assert.ok(asOwner.body.items.every((v) => v.kind !== 'cost')); // owner is no party of DRAFTK
      const asSub = await dispatch('GET', `/projects/${PROJECT}/variations`, viewer(SUB_ORG));
      assert.ok(asSub.body.items.some((v) => v.kind === 'cost'));
      // and getVariation answers 404, not 403 — it does not exist for the owner
      assert.equal((await dispatch('GET', `/variations/${costVar.id}`, viewer(OWNER_ORG))).status, 404);
    });

    test('acknowledge: owner or scope-contract client only', async () => {
      await slipTaskA();
      const timeVar = [...store.state.variations.values()].find((v) => v.taskId === TASK_A && v.kind === 'time');
      assert.equal((await dispatch('POST', `/variations/${timeVar.id}:acknowledge`, viewer(SUB_ORG))).status, 403);
      assert.equal((await dispatch('POST', `/variations/${timeVar.id}:acknowledge`,
        viewer(OWNER_ORG, { perms: [] }))).status, 403);
      assert.equal((await dispatch('POST', `/variations/${timeVar.id}:acknowledge`, viewer(OWNER_ORG))).status, 200);
    });

    test('question: any participant who may see it → 201 Comment + event', async () => {
      await slipTaskA();
      const timeVar = [...store.state.variations.values()].find((v) => v.kind === 'time');
      const res = await dispatch('POST', `/variations/${timeVar.id}:question`, viewer(SUB_ORG), {
        id: uuid(), kind: 'question', body: 'porquê o atraso?',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.kind, 'question');
      assert.equal(res.body.question_status, 'open');
      assert.equal(res.body.object_type, 'variation');
      assert.ok(store.state.events.some((e) => e.type === 'planning.variation.questioned'));
    });
  });

  describe('cost lines', () => {
    test('an owner estimate needs no contract; visibility is per party', async () => {
      const res = await dispatch('POST', `/tasks/${TASK_A}/cost-lines`, viewer(OWNER_ORG), {
        id: uuid(), code: 'est.1', description: 'Estimativa fundações', unit: 'vg',
        quantity: '1.000', unit_price: { amount_cents: 123456, currency: 'EUR' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.contract_id, null);
      assert.deepEqual(res.body.line_total, { amount_cents: 123456, currency: 'EUR' });

      const asOwner = await dispatch('GET', `/tasks/${TASK_A}/cost-lines`, viewer(OWNER_ORG));
      // the PRIME line (owner is client) + the estimate
      assert.equal(asOwner.body.items.length, 2);
      const asSub = await dispatch('GET', `/tasks/${TASK_A}/cost-lines`, viewer(SUB_ORG));
      assert.equal(asSub.body.items.length, 0); // neither PRIME party nor estimate owner
    });

    test('a SIGNED contract line never changes in place → 409 pointing to change orders', async () => {
      const patch = await dispatch('PATCH', `/cost-lines/${BOQ_PRIME}`, viewer(GC_ORG), {
        quantity: '11.000',
      });
      assert.equal(patch.status, 409);
      assert.match(patch.body.detail, /change order/);
      const del = await dispatch('DELETE', `/cost-lines/${BOQ_PRIME}`, viewer(GC_ORG));
      assert.equal(del.status, 409);
      const add = await dispatch('POST', `/tasks/${TASK_A}/cost-lines`, viewer(GC_ORG), {
        id: uuid(), contract_id: PRIME, code: '1.9', description: 'x', unit: 'un',
        quantity: '1.000', unit_price: { amount_cents: 1, currency: 'EUR' },
      });
      assert.equal(add.status, 409);
    });

    test('a non-party neither creates nor sees another deal’s line', async () => {
      const res = await dispatch('POST', `/tasks/${TASK_A}/cost-lines`, viewer(OWNER_ORG), {
        id: uuid(), contract_id: DRAFTK, code: 'd.9', description: 'x', unit: 'un',
        quantity: '1.000', unit_price: { amount_cents: 1, currency: 'EUR' },
      });
      assert.equal(res.status, 403);
      // a DRAFTK line by its supplier, then the owner PATCHes it → 404
      const line = await dispatch('POST', `/tasks/${TASK_A}/cost-lines`, viewer(SUB_ORG), {
        id: uuid(), contract_id: DRAFTK, code: 'd.2', description: 'y', unit: 'un',
        quantity: '1.000', unit_price: { amount_cents: 1, currency: 'EUR' },
      });
      assert.equal(line.status, 201);
      assert.equal((await dispatch('PATCH', `/cost-lines/${line.body.id}`, viewer(OWNER_ORG), { quantity: '2.000' })).status, 404);
    });

    test('updating a draft-deal line on a controlled row refreshes the cost variation; material spec makes a MATERIAL one', async () => {
      const line = await dispatch('POST', `/tasks/${TASK_A}/cost-lines`, viewer(GC_ORG), {
        id: uuid(), contract_id: DRAFTK, code: 'd.3', description: 'Tubagem', unit: 'm',
        quantity: '10.000', unit_price: { amount_cents: 100, currency: 'EUR' },
      });
      const patched = await dispatch('PATCH', `/cost-lines/${line.body.id}`, viewer(GC_ORG), {
        quantity: '12.000', material_spec: 'PEX classe A',
      });
      assert.equal(patched.status, 200);
      const kinds = [...store.state.variations.values()].map((v) => v.kind).sort();
      assert.deepEqual(kinds, ['cost', 'material']);
      const cost = [...store.state.variations.values()].find((v) => v.kind === 'cost');
      assert.equal(cost.delta.amount_cents, 1200); // 12×1€ vs the 10×1€ reference
    });

    test('missing org:costs:edit → 403', async () => {
      const res = await dispatch('POST', `/tasks/${TASK_A}/cost-lines`, viewer(GC_ORG, { perms: [] }), {
        id: uuid(), code: 'x', description: 'x', unit: 'un', quantity: '1.000',
      });
      assert.equal(res.status, 403);
    });
  });

  describe('progress', () => {
    test('the branch holder reports; the event feeds quality and contracting', async () => {
      const res = await dispatch('POST', `/tasks/${TASK_A}/progress`, viewer(GC_ORG), {
        status: 'done', note: 'betonagem concluída',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.seq, 1);
      assert.equal(res.body.status, 'done');
      const evt = store.state.events.find((e) => e.type === 'planning.progress.reported');
      assert.equal(evt.data.task_id, TASK_A);
      assert.equal(evt.data.task_name, 'Fundações');
      assert.equal(evt.data.reported_by_org_id, GC_ORG);
      assert.equal(evt.data.criteria, 'betão C25/30'); // snapshot for quality
      assert.ok(store.state.ledger.includes('planning.progress.reported'));
    });

    test("'verified' is never reported → 422; percent only with in_progress", async () => {
      const verified = await dispatch('POST', `/tasks/${TASK_A}/progress`, viewer(GC_ORG), { status: 'verified' });
      assert.equal(verified.status, 422);
      assert.match(verified.body.errors.status, /Quality/);
      const pct = await dispatch('POST', `/tasks/${TASK_A}/progress`, viewer(GC_ORG), { status: 'done', percent: 80 });
      assert.equal(pct.status, 422);
      const ok = await dispatch('POST', `/tasks/${TASK_A}/progress`, viewer(GC_ORG), { status: 'in_progress', percent: 40 });
      assert.equal(ok.status, 201);
    });

    test('outside the edit scope or without the permission → 403', async () => {
      assert.equal((await dispatch('POST', `/tasks/${TASK_A}/progress`, viewer(SUB_ORG), { status: 'in_progress' })).status, 403);
      assert.equal((await dispatch('POST', `/tasks/${TASK_A}/progress`,
        viewer(GC_ORG, { perms: ['org:plan:edit'] }), { status: 'in_progress' })).status, 403);
    });

    test('listProgress pages the history', async () => {
      await dispatch('POST', `/tasks/${TASK_A}/progress`, viewer(GC_ORG), { status: 'in_progress', percent: 10 });
      await dispatch('POST', `/tasks/${TASK_A}/progress`, viewer(GC_ORG), { status: 'blocked', note: 'sem betão' });
      const res = await dispatch('GET', `/tasks/${TASK_A}/progress`, viewer(SUB_ORG));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.items.map((i) => i.status), ['in_progress', 'blocked']);
    });
  });
});
