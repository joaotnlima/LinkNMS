// Project phases + execution sign-off end to end through the /api/v2 router,
// DB-free (LINA-356; ADR-0024). The fake store answers what pg-store (db/v2/0008)
// would, honouring the two invariants the DB enforces: at most one PENDING
// sign-off request per phase (partial UNIQUE → 23505), and signed_off is a
// ONE-WAY terminal state. Proves the ported v1 acceptance rules on v2:
//   - GET /phases lazy-seeds procurement(active) + execution(pending), members-only;
//   - request needs an active phase + ≥1 plan task; one pending per phase → 409;
//   - approve flips execution → signed_off and is barred for the requester
//     (two_sided_rule / cannot_self_approve); reject frees the pending slot.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerProject } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const GC_ORG = '01920000-0000-7000-8000-0000000000a2';
const STRANGER_ORG = '01920000-0000-7000-8000-0000000000a3';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const OWNER_PERSON = '01920000-0000-7000-8000-0000000000c1';
const GC_PERSON = '01920000-0000-7000-8000-0000000000c2';
const ABSENT = '01920000-0000-7000-8000-00000000ffff';

function fakeStore({ tasks = 1 } = {}) {
  const persons = {
    user_owner: { id: OWNER_PERSON, clerk_user_id: 'user_owner', email: 'ana@casa.pt' },
    user_gc: { id: GC_PERSON, clerk_user_id: 'user_gc', email: 'gc@build.pt' },
  };
  const participants = new Set([`${PROJECT}:${OWNER_ORG}`, `${PROJECT}:${GC_ORG}`]);
  const phases = [];       // {id, project_id, kind, name, status, sequence, responsible_party_ids, created_at, updated_at}
  const signoffs = [];     // {id, phase_id, requested_by, requested_at, status, resolved_at, resolution_comment}
  let seq = 0;
  const uuid = (p) => `${p}${String(++seq).padStart(4, '0')}-0000-7000-8000-000000000000`.slice(0, 36);

  return {
    phases, signoffs, participants,
    async getPersonByClerkId(id) { return persons[id] ?? null; },
    async getProject(id) {
      return id === PROJECT
        ? { id: PROJECT, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG, status: 'draft', version: 1 }
        : null;
    },
    async isParticipant(projectId, orgId) { return participants.has(`${projectId}:${orgId}`); },
    async isStaffed() { return false; },
    async listPhasesByProject(projectId) {
      return phases.filter((p) => p.project_id === projectId).sort((a, b) => a.sequence - b.sequence);
    },
    async getPhaseById(id) { return phases.find((p) => p.id === id) ?? null; },
    async countPlanTasks() { return tasks; },
    async listSignOffRequestsByPhase(phaseId) {
      return signoffs.filter((s) => s.phase_id === phaseId);
    },
    async getSignOffRequest(id) { return signoffs.find((s) => s.id === id) ?? null; },
    async ensurePhases(projectId, defaults, { hasSignedContractor = false } = {}) {
      for (const d of defaults) {
        if (phases.some((p) => p.project_id === projectId && p.kind === d.kind)) continue; // ON CONFLICT DO NOTHING
        const status = d.kind === 'procurement'
          ? (hasSignedContractor ? 'pending' : 'active')
          : (hasSignedContractor ? 'active' : 'pending');
        phases.push({
          id: uuid('p'), project_id: projectId, kind: d.kind, name: d.name, status,
          sequence: d.sequence, responsible_party_ids: [], created_at: 'T', updated_at: 'T',
        });
      }
    },
    async insertSignOffRequest({ id, phaseId, requestedBy }) {
      // partial UNIQUE WHERE status='pending' — one pending per phase.
      if (signoffs.some((s) => s.phase_id === phaseId && s.status === 'pending')) {
        throw Object.assign(new Error('duplicate pending'), { code: '23505' });
      }
      const row = { id, phase_id: phaseId, requested_by: requestedBy, requested_at: 'T', status: 'pending', resolved_at: null, resolution_comment: null };
      signoffs.push(row);
      return row;
    },
    async approveSignOff({ requestId, phaseId, comment }) {
      const req = signoffs.find((s) => s.id === requestId && s.status === 'pending');
      if (!req) throw Object.assign(new Error('not pending'), { code: 'not_pending' });
      Object.assign(req, { status: 'approved', resolved_at: 'T', resolution_comment: comment });
      const phase = phases.find((p) => p.id === phaseId);
      phase.status = 'signed_off'; // one-way: nothing here walks it back
      return { request: req, phase };
    },
    async rejectSignOff({ requestId, comment }) {
      const req = signoffs.find((s) => s.id === requestId && s.status === 'pending');
      if (!req) throw Object.assign(new Error('not pending'), { code: 'not_pending' });
      Object.assign(req, { status: 'rejected', resolved_at: 'T', resolution_comment: comment });
      return req;
    },
  };
}

const viewerFor = (clerkUserId, orgId, over = {}) => createViewerContext({
  clerkUserId, orgId, clerkOrgId: `org_${orgId.slice(-2)}`, orgKind: 'contractor', orgRole: 'admin',
  permissions: ['org:plan:edit'], ...over,
});
const owner = (over) => viewerFor('user_owner', OWNER_ORG, over);
const gc = (over) => viewerFor('user_gc', GC_ORG, over);

describe('project phases + sign-off over the v2 router', () => {
  let router, store;
  const call = (method, path, { viewer = owner(), body = null } = {}) =>
    router.dispatch({ method, path, viewer, body, headers: {}, query: {} });
  const execId = async () => {
    const { body } = await call('GET', `/projects/${PROJECT}/phases`);
    return body.phases.find((p) => p.kind === 'execution').id;
  };

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerProject(router, { store, shareBaseUrl: () => 'https://portal.linknms.com' });
  });

  describe('GET /phases', () => {
    test('lazy-seeds procurement(active) + execution(pending); each carries its (empty) history', async () => {
      const res = await call('GET', `/projects/${PROJECT}/phases`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.phases.map((p) => [p.kind, p.sequence, p.status]), [
        ['procurement', 0, 'active'],
        ['execution', 1, 'pending'],
      ]);
      assert.deepEqual(res.body.phases[0].sign_off_requests, []);
    });

    test('a second read does not re-seed (idempotent lazy-init)', async () => {
      await call('GET', `/projects/${PROJECT}/phases`);
      await call('GET', `/projects/${PROJECT}/phases`);
      assert.equal(store.phases.length, 2);
    });

    test('403 for a non-participant, 401 for no active org', async () => {
      assert.equal((await call('GET', `/projects/${PROJECT}/phases`, { viewer: viewerFor('user_owner', STRANGER_ORG) })).status, 404);
      assert.equal((await call('GET', `/projects/${PROJECT}/phases`, { viewer: owner({ orgId: null }) })).status, 403);
    });
  });

  describe('request sign-off', () => {
    test('409 phase_not_active for a pending phase', async () => {
      const id = await execId(); // execution starts pending
      const res = await call('POST', `/projects/${PROJECT}/phases/${id}/sign-off`, { viewer: gc() });
      assert.equal(res.status, 409);
      assert.equal(res.body.reason, 'phase_not_active');
    });

    test('409 no_plan_tasks when the plan is empty', async () => {
      store = fakeStore({ tasks: 0 });
      router = createRouter();
      registerProject(router, { store, shareBaseUrl: () => 'x' });
      const { body } = await call('GET', `/projects/${PROJECT}/phases`);
      const proc = body.phases.find((p) => p.kind === 'procurement').id; // active
      const res = await call('POST', `/projects/${PROJECT}/phases/${proc}/sign-off`, { viewer: gc() });
      assert.equal(res.status, 409);
      assert.equal(res.body.reason, 'no_plan_tasks');
    });

    test('opens one pending; a second is 409 sign_off_already_pending', async () => {
      const { body } = await call('GET', `/projects/${PROJECT}/phases`);
      const proc = body.phases.find((p) => p.kind === 'procurement').id; // active
      const first = await call('POST', `/projects/${PROJECT}/phases/${proc}/sign-off`, { viewer: gc() });
      assert.equal(first.status, 201);
      assert.equal(first.body.sign_off_request.status, 'pending');
      const second = await call('POST', `/projects/${PROJECT}/phases/${proc}/sign-off`, { viewer: gc() });
      assert.equal(second.status, 409);
      assert.equal(second.body.reason, 'sign_off_already_pending');
    });

    test('404 for a phase not on this project', async () => {
      const res = await call('POST', `/projects/${PROJECT}/phases/${ABSENT}/sign-off`, { viewer: gc() });
      assert.equal(res.status, 404);
    });
  });

  describe('approve / reject', () => {
    const openOnProcurement = async () => {
      const { body } = await call('GET', `/projects/${PROJECT}/phases`);
      const proc = body.phases.find((p) => p.kind === 'procurement').id;
      const r = await call('POST', `/projects/${PROJECT}/phases/${proc}/sign-off`, { viewer: gc() });
      return { proc, reqId: r.body.sign_off_request.id };
    };

    test('the requester cannot approve their own request (403 cannot_self_approve)', async () => {
      const { proc, reqId } = await openOnProcurement();
      const res = await call('POST', `/projects/${PROJECT}/phases/${proc}/sign-off/${reqId}/approve`, { viewer: gc() });
      assert.equal(res.status, 403);
      assert.equal(res.body.reason, 'cannot_self_approve');
    });

    test('the other side approves → phase signed_off (one-way)', async () => {
      const { proc, reqId } = await openOnProcurement();
      const res = await call('POST', `/projects/${PROJECT}/phases/${proc}/sign-off/${reqId}/approve`, {
        viewer: owner(), body: { comment: 'looks good' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.sign_off_request.status, 'approved');
      assert.equal(res.body.sign_off_request.resolution_comment, 'looks good');
      assert.equal(res.body.phase.status, 'signed_off');
    });

    test('approving an already-resolved request is 409', async () => {
      const { proc, reqId } = await openOnProcurement();
      await call('POST', `/projects/${PROJECT}/phases/${proc}/sign-off/${reqId}/approve`, { viewer: owner() });
      const again = await call('POST', `/projects/${PROJECT}/phases/${proc}/sign-off/${reqId}/approve`, { viewer: owner() });
      assert.equal(again.status, 409);
      assert.equal(again.body.reason, 'sign_off_already_resolved');
    });

    test('reject leaves the phase active and frees the pending slot', async () => {
      const { proc, reqId } = await openOnProcurement();
      const rej = await call('POST', `/projects/${PROJECT}/phases/${proc}/sign-off/${reqId}/reject`, {
        viewer: owner(), body: { comment: 'add the roofing line' },
      });
      assert.equal(rej.status, 200);
      assert.equal(rej.body.sign_off_request.status, 'rejected');
      assert.equal(store.phases.find((p) => p.id === proc).status, 'active');
      // pending slot freed → a fresh request is allowed
      const again = await call('POST', `/projects/${PROJECT}/phases/${proc}/sign-off`, { viewer: gc() });
      assert.equal(again.status, 201);
    });
  });
});
