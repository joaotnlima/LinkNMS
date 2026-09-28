// Record operations end to end through the /api/v2 router, DB-free: the fake
// store answers what pg-store would. Proves the doc-16 gate (project.participant
// ∧ staffing), the V7 redaction passthrough, and the verify wiring — per op.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerRecord } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const GC_ORG = '01920000-0000-7000-8000-0000000000a2';
const STRANGER_ORG = '01920000-0000-7000-8000-0000000000a3';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const ME = '01920000-0000-7000-8000-0000000000c1';
const OBJ = '01920000-0000-7000-8000-0000000000d1';

// The store's listEvents returns rows already tagged `visible`; the http layer
// only shapes them (redaction lives in domain/redaction.mjs, unit-tested there).
function fakeStore() {
  const participants = new Set([`${PROJECT}:${OWNER_ORG}`, `${PROJECT}:${GC_ORG}`]);
  const staffed = new Set();
  const rows = [
    {
      seq: '2', occurred_at: new Date('2026-09-28T11:00:00Z'), category: 'contracting',
      type: 'contracting.change_order.approved', actor_person_id: ME, actor_org_id: OWNER_ORG,
      actor_org_role: 'manager', object_type: 'change_order', object_id: OBJ,
      payload: { delta_cents: 5000 }, entry_hash: 'aa'.repeat(32), prev_hash: 'bb'.repeat(32),
      visible: false, // GC-only contract scope, redacted for the owner in this fixture
    },
    {
      seq: '1', occurred_at: new Date('2026-09-28T10:00:00Z'), category: 'project',
      type: 'project.created', actor_person_id: ME, actor_org_id: OWNER_ORG,
      actor_org_role: 'manager', object_type: 'project', object_id: PROJECT,
      payload: { name: 'Casa' }, entry_hash: 'cc'.repeat(32), prev_hash: null,
      visible: true,
    },
  ];

  return {
    participants, staffed,
    async getPersonByClerkId(id) { return id === 'user_me' ? { id: ME } : null; },
    async getProject(id) {
      return id === PROJECT
        ? { id: PROJECT, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG }
        : null;
    },
    async isParticipant(projectId, orgId) { return participants.has(`${projectId}:${orgId}`); },
    async isStaffed(projectId, orgId, personId) { return staffed.has(`${projectId}:${orgId}:${personId}`); },
    async listEvents({ objectId, cursorSeq, limit }) {
      let out = rows.slice();
      if (objectId) out = out.filter((r) => r.object_id === objectId);
      if (cursorSeq != null) out = out.filter((r) => Number(r.seq) < Number(cursorSeq));
      const nextCursor = out.length > limit ? String(out[limit - 1].seq) : null;
      return { rows: out.slice(0, limit), nextCursor };
    },
    async verifyChain() { return { valid: true, length: 2, head: 'cc'.repeat(32), first_invalid_seq: null }; },
  };
}

const owner = (over = {}) => createViewerContext({
  clerkUserId: 'user_me', orgId: OWNER_ORG, clerkOrgId: 'org_owner',
  orgKind: 'household', orgRole: 'admin', permissions: [], ...over,
});
const stranger = () => owner({ orgId: STRANGER_ORG, clerkOrgId: 'org_x' });

describe('record over the v2 router', () => {
  let router, store;
  const call = (method, path, { viewer = owner(), query = {} } = {}) =>
    router.dispatch({ method, path, viewer, query });

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerRecord(router, { store });
  });

  describe('listRecord', () => {
    test('200 for a participant: full entry keeps payload, redacted entry is skeletal', async () => {
      const res = await call('GET', `/projects/${PROJECT}/record`);
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 2);
      const full = res.body.items.find((e) => e.seq === 1);
      assert.equal(full.redacted, false);
      assert.deepEqual(full.payload, { name: 'Casa' });
      const redacted = res.body.items.find((e) => e.seq === 2);
      assert.equal(redacted.redacted, true);
      assert.equal(redacted.payload, undefined);
      assert.equal(redacted.type, undefined);
      assert.equal(redacted.entry_hash, 'aa'.repeat(32)); // hash survives for verification
    });

    test('404 for a non-participant: the project is not theirs to learn', async () => {
      assert.equal((await call('GET', `/projects/${PROJECT}/record`, { viewer: stranger() })).status, 404);
    });

    test('403 (no active org) when the viewer has not picked an org', async () => {
      const res = await call('GET', `/projects/${PROJECT}/record`, { viewer: owner({ orgId: null }) });
      assert.equal(res.status, 403);
    });

    test('unstaffed non-manager is 403; managers see the whole org', async () => {
      const member = owner({ orgRole: 'member' });
      assert.equal((await call('GET', `/projects/${PROJECT}/record`, { viewer: member })).status, 403);
      store.staffed.add(`${PROJECT}:${OWNER_ORG}:${ME}`);
      assert.equal((await call('GET', `/projects/${PROJECT}/record`, { viewer: member })).status, 200);
    });

    test('422 on a non-uuid object_id filter', async () => {
      const res = await call('GET', `/projects/${PROJECT}/record`, { query: { object_id: 'not-a-uuid' } });
      assert.equal(res.status, 422);
      assert.ok(res.body.errors.object_id);
    });

    test('object_id filter narrows to that object', async () => {
      const res = await call('GET', `/projects/${PROJECT}/record`, { query: { object_id: OBJ } });
      assert.equal(res.body.items.length, 1);
      assert.equal(res.body.items[0].seq, 2);
    });
  });

  describe('verifyRecord', () => {
    test('200 with the ChainVerification report for a participant', async () => {
      const res = await call('POST', `/projects/${PROJECT}/record:verify`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { valid: true, length: 2, head: 'cc'.repeat(32), first_invalid_seq: null });
    });

    test('404 for a non-participant', async () => {
      assert.equal((await call('POST', `/projects/${PROJECT}/record:verify`, { viewer: stranger() })).status, 404);
    });
  });
});
