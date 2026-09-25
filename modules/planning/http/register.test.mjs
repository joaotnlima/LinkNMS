// Planning operations end to end through the /api/v2 router, DB-free: the
// fake store answers what pg-store would. Proves the doc-16 request flow, the
// D-33 edit-scope fence, the D-26 delta semantics (LWW + base + overwrote +
// client_change_id replay), link rules (D-32, cycles) and propagation on the
// wire.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerPlanning } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const GC_ORG = '01920000-0000-7000-8000-0000000000a2';
const SUB_ORG = '01920000-0000-7000-8000-0000000000a3';
const STRANGER_ORG = '01920000-0000-7000-8000-0000000000a4';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const PRIME = '01920000-0000-7000-8000-0000000000c1';
const SUBK = '01920000-0000-7000-8000-0000000000c2';
const ME = '01920000-0000-7000-8000-0000000000e1';

const GC_ROOT = '01920000-0000-7000-8000-0000000000d1';
const TASK_A = '01920000-0000-7000-8000-0000000000d2';
const TASK_B = '01920000-0000-7000-8000-0000000000d3';
const SUB_ROOT = '01920000-0000-7000-8000-0000000000d4';
const OWNER_ROW = '01920000-0000-7000-8000-0000000000d5';
const EXT_ROW = '01920000-0000-7000-8000-0000000000d6';
const LINK_AB = '01920000-0000-7000-8000-0000000000f1';

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

// 2026-09-21 is a Monday.
function seedTasks() {
  return [
    baseTask(OWNER_ROW, { name: 'Licenciamento', position: 'c' }),
    baseTask(EXT_ROW, {
      name: 'Licença emitida', position: 'd', datingMode: 'external',
      start: '2026-09-21', finish: null,
    }),
    baseTask(GC_ROOT, {
      name: 'Empreitada geral', position: 'm',
      contractId: PRIME, branchContractId: PRIME,
      assigneeOrgId: GC_ORG, assigneeInherited: false,
    }),
    baseTask(TASK_A, {
      name: 'Fundações', parentId: GC_ROOT, depth: 2, position: 'ma',
      branchContractId: PRIME, datingMode: 'dated',
      start: '2026-09-21', finish: '2026-09-23', durationWd: 3,
    }),
    baseTask(TASK_B, {
      name: 'Estrutura', parentId: GC_ROOT, depth: 2, position: 'mb',
      branchContractId: PRIME, datingMode: 'dated',
      start: '2026-09-24', finish: '2026-09-25', durationWd: 2,
    }),
    baseTask(SUB_ROOT, {
      name: 'Canalizações', parentId: GC_ROOT, depth: 2, position: 'mc',
      contractId: SUBK, branchContractId: SUBK,
      assigneeOrgId: SUB_ORG, assigneeInherited: false,
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
    fieldChanges: [],
    progress: [],
    ledger: [],
    events: [],
    changeIds: new Set(),
  };

  const snapshotState = () => structuredClone({
    tasks: [...state.tasks.entries()],
    links: state.links,
    fieldChanges: state.fieldChanges,
    ledger: state.ledger,
    events: state.events,
    changeIds: [...state.changeIds],
  });
  const restore = (snap) => {
    state.tasks = new Map(snap.tasks);
    state.links = snap.links;
    state.fieldChanges = snap.fieldChanges;
    state.ledger = snap.ledger;
    state.events = snap.events;
    state.changeIds = new Set(snap.changeIds);
  };

  const loadPlan = () => ({
    tasks: new Map([...state.tasks].filter(([, t]) => !t.deletedAt).map(([id, t]) => [id, { ...t }])),
    links: state.links.map((l) => ({ ...l })),
    calendarRaw: { work_days: [1, 2, 3, 4, 5], holidays: [], closures: [] },
    contracts: new Map([
      [PRIME, { supplierOrgId: GC_ORG, clientOrgId: OWNER_ORG, parentContractId: null }],
      [SUBK, { supplierOrgId: SUB_ORG, clientOrgId: GC_ORG, parentContractId: PRIME }],
    ]),
    ownerOrgId: OWNER_ORG,
    statuses: new Map(),
    orgNames: new Map([[GC_ORG, 'Douro Construções'], [SUB_ORG, 'Canalizações Norte']]),
    costedTaskIds: new Set([TASK_A]),
  });

  return {
    state,
    async getPersonByClerkId(id) {
      return id === 'user_me' ? { id: ME, clerk_user_id: 'user_me', email: 'me@x.pt' } : null;
    },
    async getProject(id) {
      return id === PROJECT
        ? { id: PROJECT, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG, status: 'active' }
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

function viewer(orgId, { role = 'manager', perms = ['org:plan:edit'], channel = 'ui' } = {}) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: orgId && `clerk_${orgId}`,
    orgKind: orgId === OWNER_ORG ? 'household' : 'contractor', orgRole: orgId ? role : null,
    permissions: perms, channel,
  });
}

describe('planning over the /api/v2 router', () => {
  let router, store;

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerPlanning(router, { store });
  });

  const dispatch = (method, path, viewerCtx, body = null, headers = {}) =>
    router.dispatch({ method, path, viewer: viewerCtx, body, headers });

  describe('getSchedule', () => {
    test('a participant reads the whole plan; rows carry per-viewer can_edit', async () => {
      const res = await dispatch('GET', `/projects/${PROJECT}/schedule`, viewer(SUB_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.tasks.length, 6);
      const byId = Object.fromEntries(res.body.tasks.map((t) => [t.id, t]));
      assert.equal(byId[SUB_ROOT].can_edit, true);   // its own branch
      assert.equal(byId[TASK_A].can_edit, false);    // the GC's branch
      assert.equal(byId[OWNER_ROW].can_edit, false); // the owner's ground
      assert.equal(byId[GC_ROOT].kind, 'summary');   // derived from children
      assert.equal(byId[TASK_B].assignee.org_id, GC_ORG); // inherited from the branch root
      assert.equal(byId[TASK_B].assignee.inherited, true);
      assert.equal(res.body.links.length, 1);
      assert.ok(res.body.health.undated_rows.some((r) => r.id === OWNER_ROW));
    });

    test('the owner edits everywhere', async () => {
      const res = await dispatch('GET', `/projects/${PROJECT}/schedule`, viewer(OWNER_ORG));
      assert.ok(res.body.tasks.every((t) => t.can_edit));
    });

    test('a stranger gets 404, never the plan', async () => {
      const res = await dispatch('GET', `/projects/${PROJECT}/schedule`, viewer(STRANGER_ORG));
      assert.equal(res.status, 404);
    });

    test('?root scopes to a subtree', async () => {
      const res = await router.dispatch({
        method: 'GET', path: `/projects/${PROJECT}/schedule`, viewer: viewer(GC_ORG), query: { root: GC_ROOT },
      });
      assert.deepEqual(res.body.tasks.map((t) => t.id).sort(), [GC_ROOT, TASK_A, TASK_B, SUB_ROOT].sort());
    });
  });

  describe('createTask', () => {
    test('the branch supplier creates a row inside its branch → 201, inherits the branch', async () => {
      const id = uuid();
      const res = await dispatch('POST', `/projects/${PROJECT}/tasks`, viewer(GC_ORG), {
        id, parent_id: GC_ROOT, name: 'Alvenarias', start: '2026-09-28', duration_wd: 5,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.task.finish, '2026-10-02');
      assert.equal(res.body.task.depth, 2);
      assert.equal(res.body.task.assignee.org_id, GC_ORG); // inherited
      assert.ok(store.state.ledger.includes('planning.task.created'));
    });

    test('a milestone with a start has finish = start', async () => {
      const id = uuid();
      const res = await dispatch('POST', `/projects/${PROJECT}/tasks`, viewer(OWNER_ORG), {
        id, name: 'Receção provisória', kind: 'milestone', start: '2026-12-21',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.task.finish, '2026-12-21');
      assert.equal(res.body.task.duration_wd, 0);
    });

    test('outside the branch scope → 403 out_of_scope', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/tasks`, viewer(SUB_ORG), {
        id: uuid(), parent_id: GC_ROOT, name: 'fora do meu ramo',
      });
      assert.equal(res.status, 403);
      assert.match(res.body.type, /out_of_scope/);
    });

    test('an eleventh level → 422 too_deep', async () => {
      let parent = SUB_ROOT; // depth 2
      for (let d = 3; d <= 10; d++) {
        const id = uuid();
        const res = await dispatch('POST', `/projects/${PROJECT}/tasks`, viewer(SUB_ORG), {
          id, parent_id: parent, name: `nível ${d}`,
        });
        assert.equal(res.status, 201);
        parent = id;
      }
      const res = await dispatch('POST', `/projects/${PROJECT}/tasks`, viewer(SUB_ORG), {
        id: uuid(), parent_id: parent, name: 'nível 11',
      });
      assert.equal(res.status, 422);
      assert.match(res.body.type, /too_deep/);
    });

    test('without org:plan:edit → 403', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/tasks`, viewer(GC_ORG, { perms: [] }), {
        id: uuid(), parent_id: GC_ROOT, name: 'x',
      });
      assert.equal(res.status, 403);
    });
  });

  describe('updateTask (D-26 deltas)', () => {
    test('moving a predecessor later pushes its linked successor, keeping duration', async () => {
      const res = await dispatch('PATCH', `/tasks/${TASK_A}`, viewer(GC_ORG), {
        client_change_id: uuid(),
        changes: { finish: { value: '2026-09-25', base: '2026-09-23' } },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.propagated, [
        { id: TASK_B, start: '2026-09-28', finish: '2026-09-29', cause_task_id: TASK_A },
      ]);
      assert.equal(res.body.overwrote.length, 0);
      assert.ok(store.state.events.some((e) => e.type === 'planning.task.propagated'));
    });

    test('a stale base is applied AND reported in overwrote (LWW)', async () => {
      const res = await dispatch('PATCH', `/tasks/${TASK_A}`, viewer(GC_ORG), {
        client_change_id: uuid(),
        changes: { name: { value: 'Fundações profundas', base: 'um nome antigo' } },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.task.name, 'Fundações profundas');
      assert.equal(res.body.overwrote[0].field, 'name');
      assert.ok(store.state.events.some((e) => e.type === 'planning.edit.overwritten'));
    });

    test('the same client_change_id replays without applying twice', async () => {
      const changeId = uuid();
      const delta = { client_change_id: changeId, changes: { name: { value: 'Fundações v2' } } };
      const first = await dispatch('PATCH', `/tasks/${TASK_A}`, viewer(GC_ORG), delta);
      assert.equal(first.status, 200);
      const historyLen = store.state.fieldChanges.length;
      const replay = await dispatch('PATCH', `/tasks/${TASK_A}`, viewer(GC_ORG), delta);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.task.name, 'Fundações v2');
      assert.equal(store.state.fieldChanges.length, historyLen);
    });

    test('editing a row assigned to another org needs confirm_not_assignee', async () => {
      const noConfirm = await dispatch('PATCH', `/tasks/${SUB_ROOT}`, viewer(GC_ORG), {
        client_change_id: uuid(), changes: { name: { value: 'Canalizações e esgotos' } },
      });
      assert.equal(noConfirm.status, 422);
      const confirmed = await dispatch('PATCH', `/tasks/${SUB_ROOT}`, viewer(GC_ORG), {
        client_change_id: uuid(), confirm_not_assignee: true,
        changes: { name: { value: 'Canalizações e esgotos' } },
      });
      assert.equal(confirmed.status, 200);
    });

    test('dragging a linked successor keeps the link and stores the new lag', async () => {
      const res = await dispatch('PATCH', `/tasks/${TASK_B}`, viewer(GC_ORG), {
        client_change_id: uuid(),
        changes: { start: { value: '2026-09-29' } },
      });
      assert.equal(res.status, 200);
      const link = store.state.links.find((l) => l.id === LINK_AB);
      assert.equal(link.lagWd, 3); // Thu 24 → Tue 29 is +3 working days
      assert.equal(res.body.task.start, '2026-09-29');
    });

    test('outside the edit scope → 403 out_of_scope', async () => {
      const res = await dispatch('PATCH', `/tasks/${TASK_A}`, viewer(SUB_ORG), {
        client_change_id: uuid(), changes: { name: { value: 'não é meu' } },
      });
      assert.equal(res.status, 403);
      assert.match(res.body.type, /out_of_scope/);
    });

    test('assignee can only move to the editor org or one of its suppliers', async () => {
      const toStranger = await dispatch('PATCH', `/tasks/${TASK_A}`, viewer(GC_ORG), {
        client_change_id: uuid(), changes: { assignee_org_id: { value: STRANGER_ORG } },
      });
      assert.equal(toStranger.status, 422);
      const toSub = await dispatch('PATCH', `/tasks/${TASK_A}`, viewer(GC_ORG), {
        client_change_id: uuid(), changes: { assignee_org_id: { value: SUB_ORG } },
      });
      assert.equal(toSub.status, 200);
      assert.equal(toSub.body.task.assignee.org_id, SUB_ORG);
    });
  });

  describe('links', () => {
    test('a link that would close a cycle → 409 dependency_cycle with the path', async () => {
      const res = await dispatch('POST', `/tasks/${TASK_A}/links`, viewer(GC_ORG), {
        id: uuid(), predecessor_id: TASK_B, successor_id: TASK_A,
        from_anchor: 'end', to_anchor: 'start',
      });
      assert.equal(res.status, 409);
      assert.match(res.body.type, /dependency_cycle/);
      assert.ok(Array.isArray(res.body.path));
    });

    test('linking moves the successor into place at creation', async () => {
      const ext = await dispatch('POST', `/tasks/${OWNER_ROW}/links`, viewer(OWNER_ORG), {
        id: uuid(), predecessor_id: TASK_B, successor_id: OWNER_ROW,
        from_anchor: 'end', to_anchor: 'start',
      });
      assert.equal(ext.status, 201); // undated successor: link created, inert
      assert.deepEqual(ext.body.propagated, []);

      const res = await dispatch('POST', `/tasks/${SUB_ROOT}/links`, viewer(GC_ORG), {
        id: uuid(), predecessor_id: TASK_A, successor_id: SUB_ROOT,
        from_anchor: 'end', to_anchor: 'start', lag_wd: 2,
      });
      assert.equal(res.status, 201); // summary successor without dates: inert but held
    });

    test('only a scope-holder of the successor links it', async () => {
      const res = await dispatch('POST', `/tasks/${TASK_B}/links`, viewer(SUB_ORG), {
        id: uuid(), predecessor_id: SUB_ROOT, successor_id: TASK_B,
        from_anchor: 'end', to_anchor: 'start',
      });
      assert.equal(res.status, 403);
    });

    test('deleting a link frees the successor → 204', async () => {
      const res = await dispatch('DELETE', `/links/${LINK_AB}`, viewer(GC_ORG));
      assert.equal(res.status, 204);
      assert.equal(store.state.links.length, 0);
    });

    test('changing the lag re-propagates', async () => {
      const res = await dispatch('PATCH', `/links/${LINK_AB}`, viewer(GC_ORG), { lag_wd: 2 });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.propagated, [
        { id: TASK_B, start: '2026-09-28', finish: '2026-09-29', cause_task_id: TASK_A },
      ]);
    });
  });

  describe('previewMove', () => {
    test('returns the would-move set and the resulting lag, without writing', async () => {
      const res = await dispatch('POST', `/tasks/${TASK_A}:preview-move`, viewer(GC_ORG), {
        start: '2026-09-23', finish: '2026-09-25',
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.would_move, [{ id: TASK_B, start: '2026-09-28', finish: '2026-09-29' }]);
      assert.equal(store.state.tasks.get(TASK_A).start, '2026-09-21'); // untouched
    });
  });

  describe('recordActual', () => {
    test('the actual finish of an external row anchors its successors', async () => {
      await dispatch('POST', `/tasks/${EXT_ROW}/links`, viewer(OWNER_ORG), {
        id: uuid(), predecessor_id: EXT_ROW, successor_id: OWNER_ROW,
        from_anchor: 'end', to_anchor: 'start',
      });
      // date the owner row so the link has something to move
      await dispatch('PATCH', `/tasks/${OWNER_ROW}`, viewer(OWNER_ORG), {
        client_change_id: uuid(),
        changes: { dating_mode: { value: 'dated' }, start: { value: '2026-09-21' }, finish: { value: '2026-09-22' } },
      });
      const res = await dispatch('POST', `/tasks/${EXT_ROW}:record-actual`, viewer(OWNER_ORG), {
        finish: '2026-09-24',
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.propagated, [
        { id: OWNER_ROW, start: '2026-09-25', finish: '2026-09-28', cause_task_id: EXT_ROW },
      ]);
    });
  });

  describe('applySchedule', () => {
    test('indent moves a row under its previous sibling', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/schedule:apply`, viewer(GC_ORG), {
        operations: [{ op: 'indent', task_id: TASK_B }],
      });
      assert.equal(res.status, 200);
      assert.equal(store.state.tasks.get(TASK_B).parentId, TASK_A);
      assert.equal(store.state.tasks.get(TASK_B).depth, 3);
    });

    test('dry_run reports the diff and writes nothing', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/schedule:apply`, viewer(GC_ORG), {
        dry_run: true,
        operations: [{ op: 'delete_subtree', task_id: TASK_B }],
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.applied, false);
      assert.deepEqual(res.body.deleted, [TASK_B]);
      assert.equal(store.state.tasks.get(TASK_B).deletedAt, null);
    });

    test('deleting a subtree needs scope on every row', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/schedule:apply`, viewer(SUB_ORG), {
        operations: [{ op: 'delete_subtree', task_id: GC_ROOT }],
      });
      assert.equal(res.status, 403);
    });

    test('create_rows creates rows and links them in one batch', async () => {
      const r1 = uuid(); const r2 = uuid();
      const res = await dispatch('POST', `/projects/${PROJECT}/schedule:apply`, viewer(SUB_ORG), {
        operations: [{
          op: 'create_rows',
          rows: [
            { id: r1, parent_id: SUB_ROOT, name: 'Prumadas', start: '2026-10-05', duration_wd: 3 },
            { id: r2, parent_id: SUB_ROOT, name: 'Ramais', start: '2026-10-08', duration_wd: 2 },
          ],
          links: [{ id: uuid(), predecessor_id: r1, successor_id: r2, from_anchor: 'end', to_anchor: 'start' }],
        }],
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.created.length, 2);
      assert.equal(res.body.links_created.length, 1);
      assert.equal(store.state.tasks.get(r2).start, '2026-10-08');
    });

    test('insert_template is honestly not available yet → 422', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/schedule:apply`, viewer(GC_ORG), {
        operations: [{ op: 'insert_template', template_id: uuid() }],
      });
      assert.equal(res.status, 422);
    });

    test('outdent past the top level → 409', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/schedule:apply`, viewer(GC_ORG), {
        operations: [{ op: 'outdent', task_id: GC_ROOT }],
      });
      assert.equal(res.status, 409);
    });
  });

  describe('getTask', () => {
    test('returns the row with its delta history', async () => {
      await dispatch('PATCH', `/tasks/${TASK_A}`, viewer(GC_ORG), {
        client_change_id: uuid(), changes: { name: { value: 'Fundações e contenções' } },
      });
      const res = await dispatch('GET', `/tasks/${TASK_A}`, viewer(SUB_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.can_edit, false);
      assert.equal(res.body.history.at(-1).field, 'name');
      assert.equal(res.body.history.at(-1).new_value, 'Fundações e contenções');
      assert.deepEqual(res.body.variations, []);
    });
  });

  describe('health', () => {
    test('the plan health names what is missing and never blocks', async () => {
      const res = await dispatch('GET', `/projects/${PROJECT}/schedule/health`, viewer(OWNER_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.blocking, false);
      assert.ok(res.body.undated_rows.some((r) => r.id === OWNER_ROW));
      assert.ok(res.body.uncosted_rows.every((r) => r.id !== TASK_A)); // TASK_A has cost lines
      assert.ok(res.body.unassigned_rows.some((r) => r.id === OWNER_ROW));
    });
  });
});
