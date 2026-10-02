// Full client→server regression for the plan write path (LINA-404). Drives the
// REAL client seams (`diffPlanTrees` → `planEditRequests`) into the REAL v2 router
// (DB-free fake store), proving a SINGLE debounced save that mixes a structural op
// with a field edit persists BOTH — the audit-surface silent-write-drop the
// per-request `client_change_id` derivation fixes. Before the fix (one shared id),
// the `schedule:apply` anchor field-change deduped the follow-up PATCH away and the
// edit was lost on refresh.
//
// Run: node --test src/lib/v2/plan-roundtrip.test.mjs
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createRouter } from '../../../../platform/router.mjs';
import { createViewerContext } from '../../../../platform/viewer-context.mjs';
import { registerPlanning } from '../../../../modules/planning/http/register.mjs';
import { diffPlanTrees } from './plan-diff.ts';
import { planEditRequests } from './plan-edit-ops.ts';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const ME = '01920000-0000-7000-8000-0000000000e1';

function emptyStore() {
  const state = { tasks: new Map(), links: [], fieldChanges: [], progress: [], ledger: [], events: [], changeIds: new Set() };
  const snap = () => structuredClone({
    tasks: [...state.tasks.entries()], links: state.links, fieldChanges: state.fieldChanges,
    ledger: state.ledger, events: state.events, changeIds: [...state.changeIds],
  });
  const restore = (s) => {
    state.tasks = new Map(s.tasks); state.links = s.links; state.fieldChanges = s.fieldChanges;
    state.ledger = s.ledger; state.events = s.events; state.changeIds = new Set(s.changeIds);
  };
  const loadPlan = () => ({
    tasks: new Map([...state.tasks].filter(([, t]) => !t.deletedAt).map(([id, t]) => [id, { ...t }])),
    links: state.links.map((l) => ({ ...l })),
    calendarRaw: { work_days: [1, 2, 3, 4, 5], holidays: [], closures: [] },
    contracts: new Map(), ownerOrgId: OWNER_ORG, statuses: new Map(), orgNames: new Map(), costedTaskIds: new Set(),
  });
  return {
    async getPersonByClerkId(id) { return id === 'user_me' ? { id: ME, clerk_user_id: 'user_me', email: 'm@x.pt' } : null; },
    async getProject(id) { return id === PROJECT ? { id: PROJECT, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG, status: 'active' } : null; },
    async isParticipant(p, o) { return p === PROJECT && o === OWNER_ORG; },
    async isStaffed() { return false; },
    async getTask(id) { const t = state.tasks.get(id); return t ? { ...t } : null; },
    async getLink(id) { const l = state.links.find((x) => x.id === id); return l ? { ...l } : null; },
    async loadPlan() { return loadPlan(); },
    async listFieldChanges(id) { return state.fieldChanges.filter((f) => f.taskId === id); },
    async listProgress(id) { return state.progress.filter((p) => p.taskId === id); },
    async listVariations() { return []; },
    async idempotent(meta, fn) { return fn(); },
    async withPlanTx(projectId, fn, { dryRun = false } = {}) {
      const s = snap();
      const plan = {
        ...loadPlan(),
        hasChange: async (id) => state.changeIds.has(id),
        write: {
          insertTask: (t) => state.tasks.set(t.id, { ...t }),
          patchTask: (id, patch) => state.tasks.set(id, { ...state.tasks.get(id), ...patch }),
          softDelete: (id) => state.tasks.set(id, { ...state.tasks.get(id), deletedAt: 'now' }),
          fieldChange: (fc) => { state.fieldChanges.push(fc); if (fc.clientChangeId) state.changeIds.add(fc.clientChangeId); },
          insertLink: (l) => state.links.push({ ...l }),
          patchLink: (id, patch) => { state.links = state.links.map((l) => (l.id === id ? { ...l, ...patch } : l)); },
          removeLink: (id) => { state.links = state.links.filter((l) => l.id !== id); },
          ledger: (e) => state.ledger.push(e.type),
          publish: (e) => state.events.push(e),
        },
      };
      try { const r = await fn(plan); if (dryRun) restore(s); return r; } catch (e) { restore(s); throw e; }
    },
  };
}

const viewer = () => createViewerContext({
  clerkUserId: 'user_me', personId: ME, orgId: OWNER_ORG, clerkOrgId: `clerk_${OWNER_ORG}`,
  orgKind: 'household', orgRole: 'manager', permissions: ['org:plan:edit', 'org:progress:report'], channel: 'ui',
});

const node = (over = {}) => ({
  name: 'Node', key: over.key ?? randomUUID(), dependsOn: [],
  description: null, assigneePartyId: null, trade: null,
  plannedStartDate: null, plannedEndDate: null, ...over,
});

describe('plan write round-trip (LINA-404 silent-write-drop fix)', () => {
  let router, V;
  beforeEach(() => { router = createRouter(); registerPlanning(router, { store: emptyStore() }); V = viewer(); });

  const dispatch = (method, path, body = null) => router.dispatch({ method, path, viewer: V, body, headers: {} });

  // Mirror applyPlanEdits (planning.ts): one base id, scheduleApply → patches →
  // links, each PATCH carrying its own derived id (the fix under test).
  async function save(prev, next) {
    const base = randomUUID();
    const diff = diffPlanTrees(prev ?? [], next, () => randomUUID());
    const sched = await dispatch('GET', `/projects/${PROJECT}/schedule`);
    const plan = planEditRequests(diff, (sched.body.links ?? []).map((l) => ({
      id: l.id, predecessor_id: l.predecessor_id, successor_id: l.successor_id,
      from_anchor: l.from_anchor, to_anchor: l.to_anchor,
    })), () => randomUUID(), base);
    if (plan.scheduleApply) {
      const r = await dispatch('POST', `/projects/${PROJECT}/schedule:apply`, plan.scheduleApply);
      assert.equal(r.status, 200, `apply failed: ${JSON.stringify(r.body)}`);
    }
    for (const p of plan.patches) {
      const r = await dispatch('PATCH', `/tasks/${p.taskId}`, { changes: p.changes, client_change_id: p.client_change_id });
      assert.equal(r.status, 200, `patch ${p.taskId} failed: ${JSON.stringify(r.body)}`);
    }
    return plan.idByKey;
  }
  const rekey = (nodes, idByKey) => nodes.map((n) => ({
    ...n, key: idByKey[n.key] ?? n.key, children: n.children ? rekey(n.children, idByKey) : n.children,
  }));
  const read = async () => Object.fromEntries(
    (await dispatch('GET', `/projects/${PROJECT}/schedule`)).body.tasks.map((t) => [t.name, t]),
  );

  test('one save that CREATES a row AND edits an existing leaf date persists BOTH', async () => {
    const t1 = [node({ key: 'kp', name: 'P', children: [node({ key: 'ka', name: 'A' })] })];
    const saved = rekey(t1, await save(null, t1));
    // Same debounced save: add leaf B under P, AND date the existing leaf A.
    const next = structuredClone(saved);
    next[0].children.push(node({ key: 'kb', name: 'B' }));
    next[0].children[0].plannedStartDate = '2026-10-05';
    next[0].children[0].plannedEndDate = '2026-10-06';
    await save(saved, next);
    const after = await read();
    assert.ok(after['B'], 'new row B lost');
    assert.equal(after['A'].start, '2026-10-05', "existing leaf A's date was DROPPED (the bug)");
    assert.equal(after['A'].finish, '2026-10-06');
  });

  test('one save that REPARENTS a row AND renames another existing leaf persists BOTH', async () => {
    const t1 = [node({ key: 'kp', name: 'P', children: [
      node({ key: 'ka', name: 'A', plannedStartDate: '2026-10-05', plannedEndDate: '2026-10-06' }),
      node({ key: 'kb', name: 'B', plannedStartDate: '2026-10-07', plannedEndDate: '2026-10-08' }),
      node({ key: 'kc', name: 'C' }),
    ] })];
    const saved = rekey(t1, await save(null, t1));
    // Same save: demote C under B (move_subtree) AND rename A.
    const next = structuredClone(saved);
    const C = next[0].children[2];
    next[0].children = [next[0].children[0], next[0].children[1]];
    next[0].children[1].children = [C];
    next[0].children[0].name = 'A renamed';
    await save(saved, next);
    const body = (await dispatch('GET', `/projects/${PROJECT}/schedule`)).body;
    const byName = Object.fromEntries(body.tasks.map((t) => [t.name, t]));
    const bId = byName['B'].id;
    assert.equal(byName['C'].parent_id, bId, 'reparent of C did not persist');
    assert.ok(byName['A renamed'], "existing leaf A's rename was DROPPED (the bug)");
    assert.equal(byName['A renamed'].start, '2026-10-05'); // its date untouched
  });
});
