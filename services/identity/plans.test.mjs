// The plan allowance (LINA-189 / ADR-0013) — "up to 1 active project" made real.
//
// The pricing page has printed an active-project allowance per plan since
// LINA-173 and nothing had ever enforced it, so every tier was silently
// unlimited. These tests pin the three things that makes true: the number comes
// from the seat's plan, only builds you OWN count against it, and a seat with no
// plan gets the entry allowance rather than an accidental free-for-all.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMemoryLedger } from './ledger-port.mjs';
import { createMemoryStore } from './store.mjs';
import { createMemorySeatStore } from './seats.mjs';
import { createIdentityService } from './identity.mjs';
import { activeProjectLimit, DEFAULT_ACTIVE_PROJECT_LIMIT } from './plans.mjs';

describe('activeProjectLimit', () => {
  test('the owner ladder matches what the pricing page sells', () => {
    assert.equal(activeProjectLimit('personal'), 1);
    assert.equal(activeProjectLimit('build_plus'), 10);
    assert.equal(activeProjectLimit('real_estate_investor'), null); // unlimited
  });

  test('the builder ladder matches what the pricing page sells', () => {
    assert.equal(activeProjectLimit('independent_builder'), 3);
    assert.equal(activeProjectLimit('growing_builder'), 10);
    assert.equal(activeProjectLimit('construction_business'), null);
  });

  test('the founding seat gets the entry allowance — one build', () => {
    assert.equal(activeProjectLimit('free_founding'), 1);
  });

  // The important one. An unknown plan key means we do not know what this person
  // paid for, and on a metered resource the safe answer is the SMALLEST
  // allowance: guessing high gives the product away, and does it silently.
  test('an absent or unrecognised plan fails CLOSED, never to unlimited', () => {
    for (const bad of [null, undefined, '', 'enterprise', 'PERSONAL', 42, {}]) {
      assert.equal(activeProjectLimit(bad), DEFAULT_ACTIVE_PROJECT_LIMIT, `plan=${String(bad)}`);
      assert.notEqual(activeProjectLimit(bad), null);
    }
  });
});

describe('createProject enforces the plan allowance', () => {
  let store, svc, seats;

  // A composed service WITH the entitlement port, plus a seated party — which is
  // what production always is (services/gateway/container.mjs).
  function seat({ plan }) {
    const partyId = randomUUID();
    const email = `${partyId}@example.com`;
    store.upsertParty({ id: partyId, displayName: 'Ana', email, role: 'owner', setupComplete: true });
    seats.grant(email, { plan, source: 'founding' });
    return partyId;
  }

  const build = (actorPartyId, name) =>
    svc.createProject({ actorPartyId, name, baselineBudgetCents: 100_00 });

  beforeEach(() => {
    const ledger = createMemoryLedger();
    store = createMemoryStore({ ledger });
    seats = createMemorySeatStore();
    svc = createIdentityService({
      store, ledger, seats,
      // Invitations mail; the collaborator test below issues one. A stub sender
      // with an empty env keeps this suite zero-dependency like its siblings.
      sender: { isConfigured: () => true, send: async () => ({ id: 'msg_1' }) },
      env: {},
    });
  });

  test('a one-build plan allows the first build and refuses the second', async () => {
    const ana = seat({ plan: 'personal' });
    await build(ana, 'Maple Street');

    await assert.rejects(build(ana, 'Second Street'), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'plan_limit_reached');
      // The numbers ride on the error so the portal can offer an upgrade rather
      // than render a generic conflict.
      assert.equal(err.limit, 1);
      assert.equal(err.owned, 1);
      assert.equal(err.plan, 'personal');
      return true;
    });

    // And the refusal wrote nothing: still exactly one build.
    assert.equal((await svc.listProjects({ actorPartyId: ana })).length, 1);
  });

  test('a three-build plan allows three and refuses the fourth', async () => {
    const bruno = seat({ plan: 'independent_builder' });
    await build(bruno, 'One');
    await build(bruno, 'Two');
    await build(bruno, 'Three');
    await assert.rejects(build(bruno, 'Four'), (err) => err.code === 'plan_limit_reached');
  });

  test('an unlimited plan is genuinely unlimited', async () => {
    const carla = seat({ plan: 'construction_business' });
    for (let i = 0; i < 12; i += 1) await build(carla, `Build ${i}`);
    assert.equal((await svc.listProjects({ actorPartyId: carla })).length, 12);
  });

  // The product rule, verbatim from the pricing page: "A project counts towards
  // your plan when your organisation is the Managing Organisation. Collaborators
  // are always free." Charging people for records they were invited onto is
  // exactly what stops a shared record from being shared.
  test('builds you were INVITED onto do not consume your allowance', async () => {
    const owner = seat({ plan: 'personal' });
    const sub = seat({ plan: 'personal' });

    const project = await build(owner, 'Maple Street');
    const { token } = await svc.inviteCounterparty({
      actorPartyId: owner,
      projectId: project.id,
      email: `${sub}@example.com`,
    });
    await svc.acceptInvitation({ token, actorPartyId: sub });

    // The sub is now a member of someone else's build...
    assert.equal((await svc.listProjects({ actorPartyId: sub })).length, 1);
    // ...and their own one-build allowance is still entirely unspent.
    await build(sub, 'My Own House');
    assert.equal((await svc.listProjects({ actorPartyId: sub })).length, 2);
  });

  // A draft is a build the wizard started: it holds a name and a baseline and it
  // sits on the portfolio. If drafts were free, the allowance would be avoidable
  // by abandoning at step 1 — forever, for nothing.
  test('a draft consumes the allowance like any other build', async () => {
    const dora = seat({ plan: 'personal' });
    await svc.createProject({
      actorPartyId: dora, name: 'Half-started', baselineBudgetCents: 100_00, draft: true,
    });
    await assert.rejects(build(dora, 'Another'), (err) => err.code === 'plan_limit_reached');
  });

  test('a seat carrying no plan still gets the entry allowance, not unlimited', async () => {
    const eva = seat({ plan: null }); // a hand-granted beta seat
    await build(eva, 'Only One');
    await assert.rejects(build(eva, 'Two'), (err) => err.code === 'plan_limit_reached');
  });

  // Compositions with no seats at all (the in-memory unit fixtures) have no
  // entitlement to read, and this service must not invent one.
  test('with no entitlement port composed, nothing is capped', async () => {
    const ledger = createMemoryLedger();
    const bare = createIdentityService({ store: createMemoryStore({ ledger }), ledger });
    const frank = randomUUID();
    for (let i = 0; i < 5; i += 1) {
      await bare.createProject({ actorPartyId: frank, name: `B${i}`, baselineBudgetCents: 1 });
    }
    assert.equal((await bare.listProjects({ actorPartyId: frank })).length, 5);
  });
});
