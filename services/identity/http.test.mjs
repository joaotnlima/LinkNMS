// HTTP handler tests for the Identity routes (LINA-56 / ADR-0004) — FR1 end to
// end over the handler layer: create a project with a baseline, invite the one
// GC, the GC accepts and joins.
//
// The property these pin: the acting party is the SESSION's, never the body's.
// A body that names a different owner, or a different joining party, is inert.
//   node --test services/identity/http.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMemoryLedger } from './ledger-port.mjs';
import { createMemoryStore } from './store.mjs';
import { createIdentityService } from './identity.mjs';
import { createIdentityHttp } from './http.mjs';

function makeHttp() {
  const ledger = createMemoryLedger();
  const store = createMemoryStore({ ledger });
  const service = createIdentityService({ store, ledger });
  return { http: createIdentityHttp({ service }), ledger, service };
}

const session = (partyId) => ({ partyId });
const party = () => randomUUID();

test('createProject: the owner is the session, not the body (FR1)', async () => {
  const { http } = makeHttp();
  const homeowner = party();
  const impostor = party();

  const res = await http.createProject({
    session: session(homeowner),
    body: {
      name: '  Maple Street  ',
      baselineBudgetCents: 450_000_00,
      // A forged owner must not be honoured.
      ownerPartyId: impostor,
      actorPartyId: impostor,
      actingRole: 'owner',
    },
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.ownerPartyId, homeowner);
  assert.equal(res.body.name, 'Maple Street');
  assert.equal(res.body.baselineBudgetCents, 450_000_00);
  assert.equal(res.body.currentBudgetCents, 450_000_00);
  assert.equal(res.body.actingRole, 'owner');
});

test('createProject without a session is a 401 in the uniform envelope', async () => {
  const { http } = makeHttp();
  const res = await http.createProject({ session: null, body: { name: 'x', baselineBudgetCents: 1 } });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'unauthenticated');
});

test('createProject validates name and baseline as a 400', async () => {
  const { http } = makeHttp();
  const p = session(party());
  const noName = await http.createProject({ session: p, body: { baselineBudgetCents: 1 } });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.error.code, 'bad_request');

  const fractional = await http.createProject({ session: p, body: { name: 'x', baselineBudgetCents: 10.5 } });
  assert.equal(fractional.status, 400);

  const negative = await http.createProject({ session: p, body: { name: 'x', baselineBudgetCents: -1 } });
  assert.equal(negative.status, 400);
});

test('FR1 end to end: create → invite → accept, over the handlers', async () => {
  const { http } = makeHttp();
  const homeowner = party();
  const gc = party();

  const created = await http.createProject({
    session: session(homeowner),
    body: { name: 'Maple Street', baselineBudgetCents: 450_000_00 },
  });
  const projectId = created.body.id;

  const invited = await http.inviteCounterparty({
    session: session(homeowner), params: { id: projectId }, body: {},
  });
  assert.equal(invited.status, 201);
  assert.equal(invited.body.invitation.status, 'pending');
  assert.ok(invited.body.token, 'the raw token is returned exactly once');
  // The single-use token must never be cacheable.
  assert.equal(invited.headers['cache-control'], 'no-store');
  // …and the stored hash is never echoed back.
  assert.equal(invited.body.invitation.tokenHash, undefined);

  const accepted = await http.acceptInvitation({
    session: session(gc), params: { token: invited.body.token },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.membership.partyId, gc, 'the joining party is the session');
  assert.equal(accepted.body.membership.role, 'counterparty');

  // Both parties now see the project; the GC's acting role is derived server-side.
  const asGc = await http.getProject({ session: session(gc), params: { id: projectId } });
  assert.equal(asGc.status, 200);
  assert.equal(asGc.body.actingRole, 'counterparty');
  assert.deepEqual(asGc.body.members.map((m) => m.role).sort(), ['counterparty', 'owner']);
});

test('only the owner may invite; a non-member sees a 403', async () => {
  const { http } = makeHttp();
  const homeowner = party();
  const outsider = party();
  const created = await http.createProject({
    session: session(homeowner), body: { name: 'Maple Street', baselineBudgetCents: 1 },
  });
  const projectId = created.body.id;

  const denied = await http.inviteCounterparty({
    session: session(outsider), params: { id: projectId }, body: {},
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'forbidden');

  const peeking = await http.getProject({ session: session(outsider), params: { id: projectId } });
  assert.equal(peeking.status, 403);
});

test('a spent invitation token cannot be replayed by a second party', async () => {
  const { http } = makeHttp();
  const homeowner = party();
  const gc = party();
  const interloper = party();
  const created = await http.createProject({
    session: session(homeowner), body: { name: 'Maple Street', baselineBudgetCents: 1 },
  });
  const invited = await http.inviteCounterparty({
    session: session(homeowner), params: { id: created.body.id }, body: {},
  });

  const first = await http.acceptInvitation({ session: session(gc), params: { token: invited.body.token } });
  assert.equal(first.status, 200);

  const replay = await http.acceptInvitation({
    session: session(interloper), params: { token: invited.body.token },
  });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error.code, 'conflict');
});

test('accepting with an unknown token is a 404, and anonymously a 401', async () => {
  const { http } = makeHttp();
  const unknown = await http.acceptInvitation({ session: session(party()), params: { token: 'nope' } });
  assert.equal(unknown.status, 404);

  const anon = await http.acceptInvitation({ session: null, params: { token: 'nope' } });
  assert.equal(anon.status, 401);
});
