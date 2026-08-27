// Identity & Membership — adversarial + flow tests (design §9: "non-members get
// 403; only owner invites/creates", plus the create/invite/accept happy path and
// the authorizer's purity). Zero-dependency, in-memory: always runs in CI.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMemoryLedger } from './ledger-port.mjs';
import { createMemoryStore } from './store.mjs';
import { createIdentityService } from './identity.mjs';
import { can, ACTION } from './authz.mjs';

function setup() {
  const ledger = createMemoryLedger();
  const store = createMemoryStore({ ledger });
  const svc = createIdentityService({ store, ledger });
  return { ledger, store, svc };
}

// Assert a call rejects with a specific typed status/code.
async function expectError(promise, status, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, status, `expected HTTP ${status}, got ${err.status} (${err.message})`);
    if (code) assert.equal(err.code, code);
    return true;
  });
}

const owner = () => randomUUID();

describe('createProject (FR1)', () => {
  let svc, ledger;
  beforeEach(() => ({ svc, ledger } = setup()));

  test('creator becomes owner; baseline rides the genesis event; budget = baseline', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: '  Maple Street  ', baselineBudgetCents: 450_000_00 });
    assert.equal(p.name, 'Maple Street'); // trimmed
    assert.equal(p.ownerPartyId, o);
    assert.equal(p.actingRole, 'owner');
    assert.equal(p.baselineBudgetCents, 450_000_00);
    assert.equal(p.currentBudgetCents, 450_000_00);
    assert.deepEqual(p.members.map((m) => m.role), ['owner']);

    const chain = ledger._chain(p.id);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].type, 'project_created');
    assert.equal(chain[0].actorPartyId, o);
    assert.equal(chain[0].payload.baselineBudgetCents, 450_000_00);
    assert.equal(ledger._verify(p.id).verified, true);
  });

  test('requires an authenticated party (401), not from the body', async () => {
    await expectError(svc.createProject({ name: 'x', baselineBudgetCents: 0 }), 401, 'unauthenticated');
  });

  test('rejects empty name and non-integer / negative baseline (400)', async () => {
    const o = owner();
    await expectError(svc.createProject({ actorPartyId: o, name: '   ', baselineBudgetCents: 0 }), 400);
    await expectError(svc.createProject({ actorPartyId: o, name: 'x', baselineBudgetCents: 1.5 }), 400);
    await expectError(svc.createProject({ actorPartyId: o, name: 'x', baselineBudgetCents: -1 }), 400);
    await expectError(svc.createProject({ actorPartyId: o, name: 'x', baselineBudgetCents: '100' }), 400);
  });
});

describe('getProject authorization (non-members get 403)', () => {
  let svc;
  beforeEach(() => ({ svc } = setup()));

  test('owner sees the project; a non-member gets 403 and cannot tell it exists', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100 });

    const seen = await svc.getProject({ actorPartyId: o, projectId: p.id });
    assert.equal(seen.id, p.id);
    assert.equal(seen.actingRole, 'owner');

    const stranger = owner();
    await expectError(svc.getProject({ actorPartyId: stranger, projectId: p.id }), 403, 'forbidden');
    // Same 403 for a project that doesn't exist — existence is not leaked.
    await expectError(svc.getProject({ actorPartyId: stranger, projectId: randomUUID() }), 403);
    // No session ⇒ 401.
    await expectError(svc.getProject({ projectId: p.id }), 401);
  });
});

describe('inviteCounterparty (only the owner invites)', () => {
  let svc;
  beforeEach(() => ({ svc } = setup()));

  test('owner mints a single-use invite; token returned once, never the hash', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100 });
    const { invitation, token } = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id });
    assert.equal(invitation.status, 'pending');
    assert.equal(invitation.role, 'counterparty');
    assert.ok(token && token.length > 10);
    assert.equal(invitation.tokenHash, undefined, 'never expose the token hash');
    assert.equal(invitation.token, undefined);
  });

  test('a non-member cannot invite (403), and a joined counterparty cannot invite (403)', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100 });
    await expectError(svc.inviteCounterparty({ actorPartyId: owner(), projectId: p.id }), 403);

    const { token } = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id });
    const gc = owner();
    await svc.acceptInvitation({ actorPartyId: gc, token });
    // The counterparty is a member but not the owner ⇒ cannot invite.
    await expectError(svc.inviteCounterparty({ actorPartyId: gc, projectId: p.id }), 403);
  });

  test('rejects a second pending invite (409) and inviting when a GC already joined (409)', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100 });
    await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id });
    await expectError(svc.inviteCounterparty({ actorPartyId: o, projectId: p.id }), 409);
  });

  test('rejects a non-counterparty role (400)', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100 });
    await expectError(svc.inviteCounterparty({ actorPartyId: o, projectId: p.id, role: 'owner' }), 400);
  });
});

describe('acceptInvitation', () => {
  let svc, ledger;
  beforeEach(() => ({ svc, ledger } = setup()));

  test('the GC joins as counterparty; member_joined chains after project_created', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100 });
    const { token } = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id });
    const gc = owner();
    const { membership } = await svc.acceptInvitation({ actorPartyId: gc, token });
    assert.equal(membership.role, 'counterparty');
    assert.equal(membership.partyId, gc);
    assert.equal(membership.projectId, p.id);

    // Now both parties are members and both can view.
    const view = await svc.getProject({ actorPartyId: gc, projectId: p.id });
    assert.equal(view.actingRole, 'counterparty');
    assert.deepEqual(view.members.map((m) => m.role).sort(), ['counterparty', 'owner']);

    const chain = ledger._chain(p.id);
    assert.deepEqual(chain.map((e) => e.type), ['project_created', 'member_joined']);
    assert.equal(ledger._verify(p.id).verified, true);
  });

  test('unknown token ⇒ 404; replayed (spent) token ⇒ 409; no session ⇒ 401', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100 });
    const { token } = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id });

    await expectError(svc.acceptInvitation({ actorPartyId: owner(), token: 'not-a-real-token' }), 404);
    await expectError(svc.acceptInvitation({ token }), 401);

    await svc.acceptInvitation({ actorPartyId: owner(), token });
    // Second use of the same token is rejected — single-use.
    await expectError(svc.acceptInvitation({ actorPartyId: owner(), token }), 409);
  });

  test('membership UNIQUE(project, role) blocks a second counterparty', async () => {
    // Two invites can't be pending at once, so drive the collision through the DB
    // invariant the memory store mirrors: after one GC joins, the owner cannot
    // invite again (409) — the only path to a 2nd counterparty is closed.
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100 });
    const { token } = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id });
    await svc.acceptInvitation({ actorPartyId: owner(), token });
    await expectError(svc.inviteCounterparty({ actorPartyId: o, projectId: p.id }), 409);
  });
});

describe('the pure authorizer can() (ADR-0004)', () => {
  test('create_project needs no membership; unknown action and non-member deny', () => {
    assert.equal(can({ action: ACTION.CREATE_PROJECT, role: null }).allow, true);
    assert.equal(can({ action: 'no_such_action', role: 'owner' }).allow, false);
    assert.equal(can({ action: ACTION.VIEW_PROJECT, role: null }).allow, false);
  });

  test('two-sided rule: the proposer cannot decide their own change order', () => {
    const a = randomUUID();
    const b = randomUUID();
    assert.equal(
      can({ action: ACTION.DECIDE_CHANGE_ORDER, role: 'owner', actorPartyId: a, proposedByPartyId: a }).allow,
      false,
    );
    assert.equal(
      can({ action: ACTION.DECIDE_CHANGE_ORDER, role: 'owner', actorPartyId: a, proposedByPartyId: b }).allow,
      true,
    );
    // A missing proposer is a fail-closed deny, not a silent allow.
    assert.equal(can({ action: ACTION.DECIDE_CHANGE_ORDER, role: 'owner', actorPartyId: a }).allow, false);
  });

  test('only the owner may invite; the counterparty may not', () => {
    assert.equal(can({ action: ACTION.INVITE_COUNTERPARTY, role: 'owner' }).allow, true);
    assert.equal(can({ action: ACTION.INVITE_COUNTERPARTY, role: 'counterparty' }).allow, false);
  });
});

describe('cross-service port (requireMember / roleOf)', () => {
  test('matches the shape sibling services consume', async () => {
    const { svc } = setup();
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100 });
    assert.deepEqual(await svc.requireMember(o, p.id), { partyId: o, projectId: p.id, role: 'owner' });
    assert.equal(await svc.roleOf(p.id, o), 'owner');
    assert.equal(await svc.roleOf(p.id, owner()), null);
    await expectError(svc.requireMember(owner(), p.id), 403);
    await expectError(svc.requireMember(null, p.id), 401);
  });
});
