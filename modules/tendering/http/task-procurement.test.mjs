// GET /projects/{projectId}/task-procurement (listTaskProcurement, PRD-01
// G-2/G-3) through the /api/v2 router, DB-free. The fake store answers what
// pg-store's taskProcurementOfProject does — including its issuer clause — so
// this proves the request flow: active org → project relationship (404 for a
// stranger) → staffing → issuer-scoped items, folded by the domain (governing
// RFP, landed-bid count, winner), with no money anywhere on the wire.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerTendering } from './register.mjs';

const OWNER_ORG = '01940000-0000-7000-8000-0000000000a1';
const GC_ORG = '01940000-0000-7000-8000-0000000000a2'; // participant, issued nothing
const BIDDER_ORG = '01940000-0000-7000-8000-0000000000a3';
const STRANGER_ORG = '01940000-0000-7000-8000-0000000000a5';
const PROJECT = '01940000-0000-7000-8000-0000000000b1';
const OTHER_PROJECT = '01940000-0000-7000-8000-0000000000b2';
const T_PLUMB = '01940000-0000-7000-8000-0000000000d1';
const T_ELEC = '01940000-0000-7000-8000-0000000000d2';
const T_ROOF = '01940000-0000-7000-8000-0000000000d3';
const RFP_OLD = '01940000-0000-7000-8000-0000000000e1'; // cancelled, plumbing
const RFP_PLUMB = '01940000-0000-7000-8000-0000000000e2'; // published, plumbing + electrics
const RFP_ROOF = '01940000-0000-7000-8000-0000000000e3'; // awarded
const RFP_GC = '01940000-0000-7000-8000-0000000000e4'; // issued by the GC
const ME = '01940000-0000-7000-8000-0000000000e9';

/** RFPs as pg-store would read them, each with its lane histogram. */
const RFPS = [
  { id: RFP_OLD, project_id: PROJECT, issuer_org_id: OWNER_ORG, title: 'Canalização (1.ª)', status: 'cancelled',
    created_at: '2026-10-01T09:00:00Z', submission_deadline: '2026-10-20T17:00:00Z',
    root_task_ids: [T_PLUMB], lane_counts: { invited: 2 }, awarded_org_id: null, awarded_name: null },
  { id: RFP_PLUMB, project_id: PROJECT, issuer_org_id: OWNER_ORG, title: 'Canalização + Eletricidade', status: 'published',
    created_at: '2026-11-01T09:00:00Z', submission_deadline: '2027-01-15T17:00:00Z',
    root_task_ids: [T_PLUMB, T_ELEC], lane_counts: { invited: 1, submitted: 1, shortlisted: 1, withdrawn: 1 },
    awarded_org_id: null, awarded_name: null },
  { id: RFP_ROOF, project_id: PROJECT, issuer_org_id: OWNER_ORG, title: 'Cobertura', status: 'awarded',
    created_at: '2026-09-01T09:00:00Z', submission_deadline: '2026-09-30T17:00:00Z',
    root_task_ids: [T_ROOF], lane_counts: { awarded: 1, declined: 2 },
    awarded_org_id: BIDDER_ORG, awarded_name: 'Telhados do Norte' },
  { id: RFP_GC, project_id: PROJECT, issuer_org_id: GC_ORG, title: 'Sub — pladur', status: 'draft',
    created_at: '2026-11-05T09:00:00Z', submission_deadline: '2027-02-01T17:00:00Z',
    root_task_ids: [T_ELEC], lane_counts: {}, awarded_org_id: null, awarded_name: null },
];

function fakeStore({ staffed = false } = {}) {
  const participants = new Set([OWNER_ORG, GC_ORG, BIDDER_ORG].map((o) => `${PROJECT}:${o}`));
  const calls = [];
  return {
    calls,
    async getPersonByClerkId(id) { return id === 'user_me' ? { id: ME, clerk_user_id: 'user_me' } : null; },
    async getProject(id) {
      if (id === PROJECT) return { id, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG };
      if (id === OTHER_PROJECT) return { id, owner_org_id: STRANGER_ORG, created_by_org_id: STRANGER_ORG };
      return null;
    },
    async isParticipant(projectId, orgId) { return participants.has(`${projectId}:${orgId}`); },
    async isStaffed() { return staffed; },
    // The issuer clause EXACTLY as pg-store's SQL applies it: one row per
    // (root task, RFP) pair of the RFPs this org issued on the project.
    async taskProcurementOfProject(projectId, issuerOrgId) {
      calls.push([projectId, issuerOrgId]);
      return RFPS
        .filter((r) => r.project_id === projectId && r.issuer_org_id === issuerOrgId)
        .flatMap((r) => r.root_task_ids.map((taskId) => ({ ...r, task_id: taskId })));
    },
  };
}

function viewer(orgId, { role = 'manager', perms = [] } = {}) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: orgId && `clerk_${orgId}`,
    orgKind: 'contractor', orgRole: orgId ? role : null, permissions: perms, channel: 'ui',
  });
}

describe('GET /projects/{projectId}/task-procurement', () => {
  let router, store;
  const dispatch = (v, projectId = PROJECT) =>
    router.dispatch({ method: 'GET', path: `/projects/${projectId}/task-procurement`, viewer: v, body: null, headers: {}, query: {} });

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerTendering(router, { store });
  });

  test('the issuer gets one item per tendered root task, in one store read', async () => {
    const res = await dispatch(viewer(OWNER_ORG));
    assert.equal(res.status, 200);
    assert.equal(store.calls.length, 1);
    const byTask = Object.fromEntries(res.body.items.map((i) => [i.task_id, i]));
    assert.deepEqual(Object.keys(byTask).sort(), [T_PLUMB, T_ELEC, T_ROOF].sort());

    // The live re-tender governs over the cancelled first attempt.
    assert.deepEqual(byTask[T_PLUMB], {
      task_id: T_PLUMB, rfp_id: RFP_PLUMB, title: 'Canalização + Eletricidade', status: 'published',
      opened_at: '2026-11-01T09:00:00Z', submission_deadline: '2027-01-15T17:00:00Z',
      root_task_ids: [T_PLUMB, T_ELEC], invited_count: 4, submitted_count: 2, awarded_to: null,
    });
    // A co-root of the same RFP carries the same tender.
    assert.equal(byTask[T_ELEC].rfp_id, RFP_PLUMB);
    // The awarded tender names its winner.
    assert.deepEqual(byTask[T_ROOF].awarded_to, { org_id: BIDDER_ORG, name: 'Telhados do Norte' });
    assert.equal(byTask[T_ROOF].submitted_count, 1);
    assert.equal(byTask[T_ROOF].invited_count, 3);
  });

  test('no money on the wire (D-06/D-07)', async () => {
    const res = await dispatch(viewer(OWNER_ORG, { perms: ['org:money:view'] }));
    const json = JSON.stringify(res.body);
    assert.ok(!/total|price|amount_cents|median/.test(json));
  });

  test('a participant sees only the tenders IT issued; one that issued none gets []', async () => {
    const gc = await dispatch(viewer(GC_ORG));
    assert.equal(gc.status, 200);
    assert.deepEqual(gc.body.items.map((i) => i.rfp_id), [RFP_GC]);
    const bidder = await dispatch(viewer(BIDDER_ORG));
    assert.equal(bidder.status, 200);
    assert.deepEqual(bidder.body.items, []);
  });

  test('a non-party → 404 (existence hidden); unknown project → 404', async () => {
    assert.equal((await dispatch(viewer(STRANGER_ORG))).status, 404);
    assert.equal((await dispatch(viewer(OWNER_ORG), OTHER_PROJECT)).status, 404);
    assert.equal((await dispatch(viewer(OWNER_ORG), '01940000-0000-7000-8000-0000000000ff')).status, 404);
    assert.equal(store.calls.length, 0, 'the read never runs for a non-party');
  });

  test('no active org → 403 no_active_org', async () => {
    const res = await dispatch(viewer(null));
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'forbidden');
  });

  test('an unstaffed member of the issuer org → 403 not_a_participant; staffed → 200', async () => {
    const unstaffed = await dispatch(viewer(OWNER_ORG, { role: 'member' }));
    assert.equal(unstaffed.status, 403);
    assert.equal(unstaffed.body.code, 'not_a_participant');

    router = createRouter();
    store = fakeStore({ staffed: true });
    registerTendering(router, { store });
    const staffed = await dispatch(viewer(OWNER_ORG, { role: 'member' }));
    assert.equal(staffed.status, 200);
    assert.equal(staffed.body.items.length, 3);
  });
});
