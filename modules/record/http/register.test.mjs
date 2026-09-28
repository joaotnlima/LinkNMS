// listRecord end to end through the /api/v2 router, DB-free: the fake store
// answers what pg-store would. Proves the doc-16 gate (active org →
// relationship → staffing) and the page shaping. The V7 redaction PREDICATE
// (which entry is in scope) is SQL and is proven in infra/pg-store.test.mjs;
// here the fake store returns already-projected rows and we prove the use case
// shapes and paginates them.
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
const TASK = '01920000-0000-7000-8000-0000000000d1';
const CHANGE_ORDER = '01920000-0000-7000-8000-0000000000d2';

function row(seq, over = {}) {
  return {
    seq: String(seq), occurred_at: '2026-09-20T10:00:00.000Z',
    category: 'planning', type: 'planning.progress.reported',
    actor_person_id: ME, actor_org_id: GC_ORG, actor_org_role: 'site_lead',
    object_type: 'task', object_id: TASK,
    entry_hash: `h${seq}`, prev_hash: seq === 1 ? null : `h${seq - 1}`,
    payload: { percent: seq * 10 }, redacted: false, ...over,
  };
}

function fakeStore() {
  const participants = new Set([`${PROJECT}:${OWNER_ORG}`, `${PROJECT}:${GC_ORG}`]);
  const staffed = new Set(); // nobody staffed by default
  // newest first, as the store returns them
  const entries = [
    row(3),
    row(2, { redacted: true, payload: null, category: 'contracting', type: 'contracting.change_order.decided', object_type: 'change_order', object_id: CHANGE_ORDER }),
    row(1),
  ];
  return {
    participants, staffed, entries,
    async getProject(id) {
      return id === PROJECT
        ? { id: PROJECT, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG }
        : null;
    },
    async isParticipant(projectId, orgId) { return participants.has(`${projectId}:${orgId}`); },
    async isStaffed(projectId, orgId, personId) { return staffed.has(`${projectId}:${orgId}:${personId}`); },
    async getPersonByClerkId(clerkId) { return clerkId === 'user_me' ? { id: ME } : null; },
    async listAuditEntries(_projectId, _orgId, { objectType, objectId, cursor, limit }) {
      let rows = entries;
      if (objectType) rows = rows.filter((r) => r.object_type === objectType);
      if (objectId) rows = rows.filter((r) => r.object_id === objectId);
      if (cursor != null) rows = rows.filter((r) => Number(r.seq) < cursor);
      const items = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? String(items[items.length - 1].seq) : null;
      return { items, nextCursor };
    },
  };
}

const owner = (over = {}) => createViewerContext({
  clerkUserId: 'user_me', orgId: OWNER_ORG, clerkOrgId: 'org_owner',
  orgKind: 'household', orgRole: 'admin', permissions: [], ...over,
});
const gc = (over = {}) => owner({ orgId: GC_ORG, clerkOrgId: 'org_gc', orgKind: 'contractor', ...over });
const stranger = () => owner({ orgId: STRANGER_ORG, clerkOrgId: 'org_x' });
const noOrg = () => createViewerContext({ clerkUserId: 'user_me', permissions: [] });

describe('listRecord over the v2 router', () => {
  let router, store;
  const call = (path, { viewer = owner(), query = {} } = {}) =>
    router.dispatch({ method: 'GET', path, viewer, body: null, headers: {}, query });

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerRecord(router, { store });
  });

  test('a manager/admin participant reads the whole ledger, newest first', async () => {
    const res = await call(`/projects/${PROJECT}/record`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((e) => e.seq), [3, 2, 1]);
    assert.equal(res.body.next_cursor, null);
  });

  test('a redacted entry keeps hashes + type but withholds the payload', async () => {
    const { body } = await call(`/projects/${PROJECT}/record`);
    const redacted = body.items.find((e) => e.seq === 2);
    assert.equal(redacted.redacted, true);
    assert.equal('payload' in redacted, false);
    assert.equal(redacted.type, 'contracting.change_order.decided');
    assert.equal(redacted.entry_hash, 'h2');
    assert.equal(redacted.prev_hash, 'h1');
    const shown = body.items.find((e) => e.seq === 3);
    assert.deepEqual(shown.payload, { percent: 30 });
  });

  test('no active org → 403', async () => {
    assert.equal((await call(`/projects/${PROJECT}/record`, { viewer: noOrg() })).status, 403);
  });

  test('a non-participant gets 404, not 403 (does not learn the project exists)', async () => {
    assert.equal((await call(`/projects/${PROJECT}/record`, { viewer: stranger() })).status, 404);
  });

  test('an unknown project is 404', async () => {
    assert.equal((await call(`/projects/${STRANGER_ORG}/record`)).status, 404);
  });

  test('a non-manager participant must be staffed', async () => {
    // gc is a participant but a site_lead (not admin/manager) and not staffed
    assert.equal((await call(`/projects/${PROJECT}/record`, { viewer: gc({ orgRole: 'site_lead' }) })).status, 403);
    // once staffed, they read
    store.staffed.add(`${PROJECT}:${GC_ORG}:${ME}`);
    assert.equal((await call(`/projects/${PROJECT}/record`, { viewer: gc({ orgRole: 'site_lead' }) })).status, 200);
  });

  test('filters by object_type and object_id', async () => {
    const res = await call(`/projects/${PROJECT}/record`, { query: { object_type: 'change_order' } });
    assert.deepEqual(res.body.items.map((e) => e.seq), [2]);
    const byId = await call(`/projects/${PROJECT}/record`, { query: { object_id: TASK } });
    assert.deepEqual(byId.body.items.map((e) => e.seq), [3, 1]);
  });

  test('a malformed object_id is 422, not an empty page', async () => {
    assert.equal((await call(`/projects/${PROJECT}/record`, { query: { object_id: 'not-a-uuid' } })).status, 422);
  });

  test('paginates: limit yields a next_cursor, which fetches the tail', async () => {
    const first = await call(`/projects/${PROJECT}/record`, { query: { limit: '2' } });
    assert.deepEqual(first.body.items.map((e) => e.seq), [3, 2]);
    assert.equal(first.body.next_cursor, '2');
    const second = await call(`/projects/${PROJECT}/record`, { query: { limit: '2', cursor: first.body.next_cursor } });
    assert.deepEqual(second.body.items.map((e) => e.seq), [1]);
    assert.equal(second.body.next_cursor, null);
  });
});
