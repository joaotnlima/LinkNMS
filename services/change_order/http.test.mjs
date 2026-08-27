// HTTP handler tests for the Change Order routes (LINA-51 / ADR-0004).
//
// These pin the security-critical wiring the openapi.yaml promises: the acting
// party is taken from the SESSION, never the body; a forged actor in the body is
// inert; and typed domain errors map to the uniform `{ error: { code, message } }`
// envelope with the right HTTP status. Run:
//   node --test services/change_order/http.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChangeOrderService } from './change-order.mjs';
import { createChangeOrderHttp } from './http.mjs';
import {
  createInMemoryLedger,
  createInMemoryIdentity,
  createInMemoryStore,
} from './ports.mjs';

const PROJECT = 'proj-1';
const HOMEOWNER = 'party-homeowner';
const GC = 'party-gc';
const OUTSIDER = 'party-outsider';
const BASELINE = 5_000_000;

function makeHttp() {
  const ledger = createInMemoryLedger({ baselines: new Map([[PROJECT, BASELINE]]) });
  const identity = createInMemoryIdentity({
    memberships: [
      { projectId: PROJECT, partyId: HOMEOWNER, role: 'homeowner' },
      { projectId: PROJECT, partyId: GC, role: 'general_contractor' },
    ],
  });
  const store = createInMemoryStore();
  const service = createChangeOrderService({ store, ledger, identity });
  const http = createChangeOrderHttp({ service, identity });
  return { http, ledger };
}

const session = (partyId) => ({ partyId });

test('propose derives the actor from the session and returns 201', async () => {
  const { http } = makeHttp();
  const res = await http.proposeChangeOrder({
    session: session(GC),
    params: { projectId: PROJECT },
    body: { title: 'Oak floors', costDeltaCents: 120_000 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.proposedBy, GC);
  assert.equal(res.body.status, 'proposed');
});

test('a forged actor in the body is IGNORED — the session party is authoritative', async () => {
  const { http } = makeHttp();
  // Body tries to impersonate the homeowner and pre-decide; none of it is read.
  const res = await http.proposeChangeOrder({
    session: session(GC),
    params: { projectId: PROJECT },
    body: {
      title: 'Oak floors',
      costDeltaCents: 120_000,
      proposedBy: HOMEOWNER,
      proposedByPartyId: HOMEOWNER,
      actorPartyId: HOMEOWNER,
      status: 'approved',
      decidedBy: OUTSIDER,
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.proposedBy, GC);   // session, not body
  assert.equal(res.body.status, 'proposed'); // body's forged status is inert
  assert.equal(res.body.decidedBy, null);
});

test('no session → 401 unauthenticated on propose', async () => {
  const { http } = makeHttp();
  const res = await http.proposeChangeOrder({
    session: null,
    params: { projectId: PROJECT },
    body: { title: 'x', costDeltaCents: 1 },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'unauthenticated');
});

test('a non-member proposing → 403 not_a_member, in the uniform envelope', async () => {
  const { http } = makeHttp();
  const res = await http.proposeChangeOrder({
    session: session(OUTSIDER),
    params: { projectId: PROJECT },
    body: { title: 'x', costDeltaCents: 1 },
  });
  assert.equal(res.status, 403);
  assert.deepEqual(Object.keys(res.body), ['error']);
  assert.equal(res.body.error.code, 'not_a_member');
});

test('decide takes the decider from the session; the proposer cannot self-decide (403)', async () => {
  const { http } = makeHttp();
  const proposed = await http.proposeChangeOrder({
    session: session(GC), params: { projectId: PROJECT },
    body: { title: 'x', costDeltaCents: 1000 },
  });
  const id = proposed.body.id;

  // GC (the proposer) tries to decide, even planting decidedBy=HOMEOWNER in body.
  const self = await http.decideChangeOrder({
    session: session(GC), params: { changeOrderId: id },
    body: { decision: 'approve', decidedBy: HOMEOWNER },
  });
  assert.equal(self.status, 403);
  assert.equal(self.body.error.code, 'self_decision');

  // HOMEOWNER (from session) may decide.
  const ok = await http.decideChangeOrder({
    session: session(HOMEOWNER), params: { changeOrderId: id },
    body: { decision: 'approve' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'approved');
  assert.equal(ok.body.decidedBy, HOMEOWNER);
});

test('list returns the { changeOrders } envelope for a member', async () => {
  const { http } = makeHttp();
  await http.proposeChangeOrder({
    session: session(GC), params: { projectId: PROJECT },
    body: { title: 'A', costDeltaCents: 1 },
  });
  const res = await http.listChangeOrders({ session: session(HOMEOWNER), params: { projectId: PROJECT } });
  assert.equal(res.status, 200);
  assert.equal(Array.isArray(res.body.changeOrders), true);
  assert.equal(res.body.changeOrders.length, 1);
});

test('list by a non-member → 403', async () => {
  const { http } = makeHttp();
  const res = await http.listChangeOrders({ session: session(OUTSIDER), params: { projectId: PROJECT } });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'not_a_member');
});

test('GET one-screen view: member 200, non-member 403, missing 404', async () => {
  const { http } = makeHttp();
  const proposed = await http.proposeChangeOrder({
    session: session(GC), params: { projectId: PROJECT },
    body: { title: 'x', costDeltaCents: 1 },
  });
  const id = proposed.body.id;

  const member = await http.getChangeOrder({ session: session(HOMEOWNER), params: { changeOrderId: id } });
  assert.equal(member.status, 200);
  assert.equal(member.body.id, id);

  const nonMember = await http.getChangeOrder({ session: session(OUTSIDER), params: { changeOrderId: id } });
  assert.equal(nonMember.status, 403);

  const missing = await http.getChangeOrder({ session: session(HOMEOWNER), params: { changeOrderId: 'nope' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');
});

test('an invalid decision verb → 400 invalid_decision', async () => {
  const { http } = makeHttp();
  const proposed = await http.proposeChangeOrder({
    session: session(GC), params: { projectId: PROJECT },
    body: { title: 'x', costDeltaCents: 1 },
  });
  const res = await http.decideChangeOrder({
    session: session(HOMEOWNER), params: { changeOrderId: proposed.body.id },
    body: { decision: 'maybe' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_decision');
});
