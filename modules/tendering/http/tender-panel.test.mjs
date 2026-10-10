// PRD-02 tendering operations through the /api/v2 router, DB-free:
//   T-3  createRfp / updateRfp with excluded_task_ids — the package is pruned
//        (row + its sub-tree + its BoQ items); a bad exclusion is a 422;
//   T-6  removeRecipient — draft only, issuer only (404 for others);
//   T-10 the Rfp body carries the lifecycle stamps;
//   T-19 cancelRfp keeps an optional reason; a bad one is a 422.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerTendering } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const BIDDER_ORG = '01920000-0000-7000-8000-0000000000a3';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const ROOT = '01920000-0000-7000-8000-0000000000d1';
const KEEP = '01920000-0000-7000-8000-0000000000d2';
const LEAVE = '01920000-0000-7000-8000-0000000000d3';
const LEAVE_CHILD = '01920000-0000-7000-8000-0000000000d4';
const RFP = '01920000-0000-7000-8000-0000000000e1';
const REC = '01920000-0000-7000-8000-0000000000c1';
const NEW_ID = '01920000-0000-7000-8000-0000000000ff';
const ME = '01920000-0000-7000-8000-0000000000e9';
const FUTURE = '2027-01-15T17:00:00Z';

function fakeStore() {
  const rfps = new Map();
  const recipients = new Map([[REC, { id: REC, rfp_id: RFP, email: 'a@x.pt', lane_status: 'invited' }]]);
  const created = [];
  const updated = [];
  const ledger = [];
  const rfp = (over = {}) => ({
    id: RFP, project_id: PROJECT, issuer_org_id: OWNER_ORG, level: 'owner', parent_contract_id: null,
    root_task_ids: [ROOT], excluded_task_ids: [], title: 'Cobertura', status: 'draft', version: 1,
    visibility: 'invite_only', submission_deadline: FUTURE, package_version: 1,
    created_at: '2026-12-01T09:00:00Z', ...over,
  });
  rfps.set(RFP, rfp());
  return {
    rfps, recipients, created, updated, ledger, rfp,
    async getPersonByClerkId(id) { return id === 'user_me' ? { id: ME } : null; },
    async getProject(id) { return id === PROJECT ? { id, owner_org_id: OWNER_ORG } : null; },
    async isParticipant(projectId, orgId) { return projectId === PROJECT && orgId === OWNER_ORG; },
    async isStaffed() { return false; },
    async tasksOfProject(projectId, ids) { return new Set(ids.filter((t) => [ROOT, KEEP, LEAVE, LEAVE_CHILD].includes(t))); },
    async snapshotPackage() {
      return {
        rows: [
          { task_id: ROOT, parent_task_id: null, name: 'Cobertura', position: 'a' },
          { task_id: KEEP, parent_task_id: ROOT, name: 'Estrutura', position: 'a' },
          { task_id: LEAVE, parent_task_id: ROOT, name: 'Caleiras', position: 'b' },
          { task_id: LEAVE_CHILD, parent_task_id: LEAVE, name: 'Claraboia', position: 'a' },
        ],
        items: [
          { task_id: KEEP, code: 'E1' },
          { task_id: LEAVE_CHILD, code: 'C1' },
        ],
      };
    },
    async idempotent(_meta, fn) { return fn(); },
    async createRfp(cmd) {
      created.push(cmd);
      const row = rfp({ id: cmd.id, excluded_task_ids: cmd.excludedTaskIds, root_task_ids: cmd.rootTaskIds });
      rfps.set(cmd.id, row);
      return row;
    },
    async getRfp(id) { return rfps.get(id) ?? null; },
    async updateRfp(cmd) {
      updated.push(cmd);
      const cur = rfps.get(cmd.rfpId);
      const next = { ...cur, version: cur.version + 1, excluded_task_ids: cmd.excludedTaskIds ?? cur.excluded_task_ids };
      rfps.set(cmd.rfpId, next);
      return next;
    },
    async getRecipient(rfpId, recipientId) { return rfpId === RFP ? recipients.get(recipientId) ?? null : null; },
    async removeDraftRecipient({ recipientId }) {
      if (rfps.get(RFP).status !== 'draft') return null;
      recipients.delete(recipientId);
      ledger.push('tendering.rfp.recipient_removed');
      return true;
    },
    async transitionRfp({ rfpId, from, to, data }) {
      const cur = rfps.get(rfpId);
      if (cur.status !== from) return null;
      const next = {
        ...cur, status: to, version: cur.version + 1,
        ...(to === 'cancelled' ? { cancelled_at: '2026-12-05T10:00:00Z', cancel_reason: data?.reason ?? null } : {}),
      };
      rfps.set(rfpId, next);
      return next;
    },
  };
}

function viewer(orgId = OWNER_ORG) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: `clerk_${orgId}`,
    orgKind: 'household', orgRole: 'manager',
    permissions: ['org:tendering:issue', 'org:tendering:bid', 'org:money:view'], channel: 'ui',
  });
}

describe('PRD-02 tendering over the /api/v2 router', () => {
  let router, store;
  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerTendering(router, { store, contractingAward: () => {} });
  });
  const dispatch = (method, path, v, body = null) =>
    router.dispatch({ method, path, viewer: v, body, query: {}, headers: {} });

  describe('T-3: rows left out of the package', () => {
    test('createRfp prunes the excluded row, its sub-tree and their BoQ items', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/rfps`, viewer(), {
        id: NEW_ID, title: 'Cobertura', root_task_ids: [ROOT], excluded_task_ids: [LEAVE],
        submission_deadline: FUTURE,
      });
      assert.equal(res.status, 201);
      assert.deepEqual(res.body.excluded_task_ids, [LEAVE]);
      const [cmd] = store.created;
      assert.deepEqual(cmd.packageRows.map((r) => r.task_id), [ROOT, KEEP]);
      assert.deepEqual(cmd.packageItems.map((i) => i.code), ['E1']);
    });

    test('a root, or a row outside the sub-trees, cannot be left out → 422', async () => {
      for (const bad of [ROOT, '01920000-0000-7000-8000-000000000099']) {
        const res = await dispatch('POST', `/projects/${PROJECT}/rfps`, viewer(), {
          id: NEW_ID, title: 'Cobertura', root_task_ids: [ROOT], excluded_task_ids: [bad],
          submission_deadline: FUTURE,
        });
        assert.equal(res.status, 422);
        assert.ok(res.body.errors.excluded_task_ids);
      }
    });

    test('updateRfp: "Include it" re-snapshots the package with the row back in', async () => {
      store.rfps.set(RFP, store.rfp({ excluded_task_ids: [LEAVE] }));
      const res = await dispatch('PATCH', `/rfps/${RFP}`, viewer(), { excluded_task_ids: [] });
      // updateRfp requires If-Match (the RFP is a versioned aggregate).
      assert.equal(res.status, 422);
      const ok = await router.dispatch({
        method: 'PATCH', path: `/rfps/${RFP}`, viewer: viewer(), body: { excluded_task_ids: [] },
        query: {}, headers: { 'if-match': '1' },
      });
      assert.equal(ok.status, 200);
      const cmd = store.updated.at(-1);
      assert.deepEqual(cmd.excludedTaskIds, []);
      assert.deepEqual(cmd.rootTaskIds, [ROOT]);
      assert.deepEqual(cmd.packageRows.map((r) => r.task_id), [ROOT, KEEP, LEAVE, LEAVE_CHILD]);
    });
  });

  describe('T-6: removeRecipient', () => {
    test('a queued bidder leaves a draft → 204, ledgered', async () => {
      const res = await dispatch('DELETE', `/rfps/${RFP}/recipients/${REC}`, viewer());
      assert.equal(res.status, 204);
      assert.equal(store.recipients.has(REC), false);
      assert.deepEqual(store.ledger, ['tendering.rfp.recipient_removed']);
    });

    test('after the RFP is sent → 409', async () => {
      store.rfps.set(RFP, store.rfp({ status: 'published' }));
      const res = await dispatch('DELETE', `/rfps/${RFP}/recipients/${REC}`, viewer());
      assert.equal(res.status, 409);
      assert.equal(store.recipients.has(REC), true);
    });

    test('a non-issuer → 404 (existence hiding); an unknown recipient → 404', async () => {
      assert.equal((await dispatch('DELETE', `/rfps/${RFP}/recipients/${REC}`, viewer(BIDDER_ORG))).status, 404);
      assert.equal((await dispatch('DELETE', `/rfps/${RFP}/recipients/${NEW_ID}`, viewer())).status, 404);
    });
  });

  describe('T-10/T-19: stamps and the cancel reason', () => {
    test('cancel with a reason → the body carries cancelled_at and cancel_reason', async () => {
      const res = await dispatch('POST', `/rfps/${RFP}:cancel`, viewer(), { reason: '  Owner changed the roof design ' });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'cancelled');
      assert.equal(res.body.cancel_reason, 'Owner changed the roof design');
      assert.equal(res.body.cancelled_at, '2026-12-05T10:00:00Z');
      assert.equal(res.body.created_at, '2026-12-01T09:00:00Z');
    });

    test('cancel without a body still works; a blank or too-long reason → 422', async () => {
      assert.equal((await dispatch('POST', `/rfps/${RFP}:cancel`, viewer(), { reason: ' ' })).status, 422);
      assert.equal((await dispatch('POST', `/rfps/${RFP}:cancel`, viewer(), { reason: 'x'.repeat(501) })).status, 422);
      const res = await dispatch('POST', `/rfps/${RFP}:cancel`, viewer());
      assert.equal(res.status, 200);
      assert.equal('cancel_reason' in res.body, false);
    });
  });
});
