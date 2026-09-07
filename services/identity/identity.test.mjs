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

describe('listProjects (GET /projects — portfolio, ADR-0012 §A1)', () => {
  let svc, ledger, store;
  beforeEach(() => ({ svc, ledger, store } = setup()));

  // A full lifecycle: a second, unrelated build belonging to a different owner,
  // and a shared build with a joined counterparty — the portfolio's two scoping
  // axes (yours vs not-yours; owner vs counterparty role).
  async function fixture() {
    const o = owner();
    const mine = await svc.createProject({ actorPartyId: o, name: 'My House', baselineBudgetCents: 1000 });
    const someoneElses = await svc.createProject({ actorPartyId: owner(), name: 'Their Build', baselineBudgetCents: 999_000 });
    const shared = await svc.createProject({ actorPartyId: owner(), name: 'Shared', baselineBudgetCents: 5000 });
    const { token } = await svc.inviteCounterparty({ actorPartyId: shared.ownerPartyId, projectId: shared.id });
    const gc = owner();
    await svc.acceptInvitation({ actorPartyId: gc, token });
    return { o, mine, someoneElses, shared, gc };
  }

  test('an authenticated member sees ONLY their own builds (never another org\'s)', async () => {
    const { o, mine } = await fixture();
    const list = await svc.listProjects({ actorPartyId: o });
    const ids = list.map((p) => p.id);
    assert.ok(ids.includes(mine.id), 'the acting party must see their own build');
    assert.ok(!ids.some((id) => id === 'their-build'), 'someone else’s build must not leak');
    assert.equal(list.filter((p) => p.name === 'Their Build').length, 0, 'a non-member build never appears');
  });

  test('a party with no memberships sees an empty portfolio, never an error', async () => {
    await fixture();
    const list = await svc.listProjects({ actorPartyId: owner() });
    assert.deepEqual(list, []);
  });

  test('a counterparty member sees the shared build with their own role', async () => {
    const { gc, shared } = await fixture();
    const list = await svc.listProjects({ actorPartyId: gc });
    const card = list.find((p) => p.id === shared.id);
    assert.ok(card, 'the joined counterparty must see the shared build');
    assert.equal(card.role, 'counterparty');
  });

  test('no session (401) — the party is the session, never a query param', async () => {
    await expectError(svc.listProjects({}), 401, 'unauthenticated');
  });

  test('draft builds are included and badged draft (resumable wizard)', async () => {
    const o = owner();
    await svc.createProject({ actorPartyId: o, name: 'In Progress', baselineBudgetCents: 100, draft: true });
    const list = await svc.listProjects({ actorPartyId: o });
    const draft = list.find((p) => p.name === 'In Progress');
    assert.ok(draft, 'draft builds must appear in the portfolio');
    assert.equal(draft.status, 'draft');
    assert.equal(draft.operatingModel, null);
  });

  test('currentBudgetCents = baseline + Σ approved change orders (ledger rollup)', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'Maple', baselineBudgetCents: 500_000_00 });
    // The budget moves are ledger events (what change-order approval appends).
    ledger.appendEvent({ projectId: p.id, type: 'budget_event', actorPartyId: o, occurredAt: new Date().toISOString(), payload: { deltaCents: 25_000_00 } });
    ledger.appendEvent({ projectId: p.id, type: 'budget_event', actorPartyId: o, occurredAt: new Date().toISOString(), payload: { deltaCents: -10_000_00 } });
    const [card] = await svc.listProjects({ actorPartyId: o });
    assert.equal(card.baselineBudgetCents, 500_000_00);
    assert.equal(card.currentBudgetCents, 515_000_00, 'baseline + 250k − 100k');
  });

  test('most-recent-first; updatedAt is the ledger head', async () => {
    const o = owner();
    const first = await svc.createProject({ actorPartyId: o, name: 'First', baselineBudgetCents: 100 });
    const second = await svc.createProject({ actorPartyId: o, name: 'Second', baselineBudgetCents: 200 });
    // A later ledger event on `first` moves it back to the top.
    ledger.appendEvent({ projectId: first.id, type: 'decision_recorded', actorPartyId: o, occurredAt: new Date().toISOString(), payload: {} });
    const list = await svc.listProjects({ actorPartyId: o });
    assert.deepEqual(list.map((p) => p.name), ['First', 'Second'], 'most-recent-first');
    assert.equal(list[0].updatedAt, ledger._chain(first.id).at(-1).occurredAt, 'updatedAt = ledger head');
    assert.equal(list[1].updatedAt, second.createdAt, 'a build with one event falls back to creation');
  });

  test('members carry ({ role, name }) with the store-joined display names', async () => {
    const o = owner();
    store.upsertParty({ id: o, displayName: 'João', email: 'owner@example.com', role: 'owner' });
    const p = await svc.createProject({ actorPartyId: o, name: 'Maple', baselineBudgetCents: 1 });
    const { token } = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id });
    const gc = owner();
    store.upsertParty({ id: gc, displayName: 'The GC', email: 'gc@example.com', role: 'contractor' });
    await svc.acceptInvitation({ actorPartyId: gc, token });
    const [card] = await svc.listProjects({ actorPartyId: o });
    assert.deepEqual(
      card.members.map((m) => ({ role: m.role, name: m.name })).sort((a, b) => a.role.localeCompare(b.role)),
      [{ role: 'counterparty', name: 'The GC' }, { role: 'owner', name: 'João' }],
    );
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

// ── Invite by email (LINA-84, ADR-0008 §4) ───────────────────────────────────
//
// The one rule these tests exist to protect: the token comes back on EVERY
// successful path. Mailing is an addition to the out-of-band flow, never a
// replacement, so no failure mode may leave the owner holding nothing.
describe('inviteCounterparty by email', () => {
  // A recording sender, so nothing here touches the network.
  function withSender({ configured = true, fail = false } = {}) {
    const sent = [];
    const ledger = createMemoryLedger();
    const store = createMemoryStore({ ledger });
    const sender = {
      isConfigured: () => configured,
      send: async (msg) => {
        if (fail) throw new Error('resend exploded');
        sent.push(msg);
        return { id: 'msg_1' };
      },
    };
    return { svc: createIdentityService({ store, ledger, sender, env: {} }), sent };
  }

  const project = async (svc, o) =>
    svc.createProject({ actorPartyId: o, name: 'Maple Street', baselineBudgetCents: 100 });

  test('an email is normalised, stored, and mailed a link to the accept page', async () => {
    const { svc, sent } = withSender();
    const o = owner();
    const p = await project(svc, o);

    const res = await svc.inviteCounterparty({
      actorPartyId: o, projectId: p.id, email: '  GC@Example.COM ', baseUrl: 'https://app.linknms.com/',
    });

    assert.equal(res.emailed, true);
    assert.equal(res.invitation.email, 'gc@example.com', 'lower-cased and trimmed like sign-in');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'gc@example.com');
    assert.match(sent[0].subject, /Maple Street/);
    // The link must carry the RAW token to the accept page, on the given origin.
    assert.ok(
      sent[0].html.includes(`https://app.linknms.com/invitations/accept?token=${encodeURIComponent(res.token)}`),
      'the emailed link points at the accept page with the raw token',
    );
    // The token is still returned, so the owner is never dependent on delivery.
    assert.ok(res.token && res.token.length > 10);
  });

  test('no email → nothing is sent, and the out-of-band token still comes back', async () => {
    const { svc, sent } = withSender();
    const o = owner();
    const p = await project(svc, o);

    const res = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id });

    assert.equal(sent.length, 0, 'the out-of-band path must not mail anybody');
    assert.equal(res.invitation.email, null);
    assert.equal(res.emailed, false);
    assert.ok(res.token && res.token.length > 10);
  });

  test('a malformed address is a 400 to the OWNER, and mints nothing', async () => {
    const { svc, sent } = withSender();
    const o = owner();
    const p = await project(svc, o);

    // Unlike /sessions/request, this is not an enumeration surface — the owner is
    // authenticated on their own project, so a typo must be said out loud rather
    // than silently swallowed into an invite that never arrives.
    await expectError(
      svc.inviteCounterparty({ actorPartyId: o, projectId: p.id, email: 'not-an-address' }),
      400,
    );
    assert.equal(sent.length, 0);
    // Nothing was minted, so a corrected retry is not blocked by a stale pending invite.
    const ok = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id, email: 'gc@example.com' });
    assert.equal(ok.emailed, true);
  });

  test('unconfigured mailer → 503 before minting; the out-of-band path is unaffected', async () => {
    const { svc } = withSender({ configured: false });
    const o = owner();
    const p = await project(svc, o);

    // Fail closed rather than report a success having mailed nothing (ADR-0007 §5).
    await expectError(
      svc.inviteCounterparty({ actorPartyId: o, projectId: p.id, email: 'gc@example.com' }),
      503,
    );
    // No mailer is needed to hand over a code, so this must still work.
    const res = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id });
    assert.ok(res.token);
  });

  test('a send failure does NOT void the invitation — emailed:false, token intact', async () => {
    const { svc } = withSender({ fail: true });
    const o = owner();
    const p = await project(svc, o);

    const res = await svc.inviteCounterparty({
      actorPartyId: o, projectId: p.id, email: 'gc@example.com', baseUrl: 'https://x.test',
    });

    assert.equal(res.emailed, false, 'the UI needs to know delivery did not happen');
    assert.ok(res.token, 'the owner keeps a link to send by hand');
    // And the invitation really is live: the GC can accept with that token.
    const gc = owner();
    const { membership } = await svc.acceptInvitation({ actorPartyId: gc, token: res.token });
    assert.equal(membership.role, 'counterparty');
  });

  test('an emailed invitation is accepted exactly like an out-of-band one', async () => {
    const { svc } = withSender();
    const o = owner();
    const p = await project(svc, o);
    const res = await svc.inviteCounterparty({
      actorPartyId: o, projectId: p.id, email: 'gc@example.com', baseUrl: 'https://x.test',
    });

    const gc = owner();
    const { membership } = await svc.acceptInvitation({ actorPartyId: gc, token: res.token });
    assert.equal(membership.role, 'counterparty');
    assert.equal(membership.partyId, gc);

    // Seating grants sign-in only; project authority is still the membership, and
    // UNIQUE(project_id, role) remains the backstop against a second counterparty.
    await expectError(svc.inviteCounterparty({ actorPartyId: o, projectId: p.id }), 409);
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

describe('previewInvitation (LINA-182)', () => {
  let svc, store;
  beforeEach(() => ({ svc, store } = setup()));

  test('reveals build name, inviter, role and email to a token holder with NO session', async () => {
    // An email on the invite requires a configured sender (fail-closed before
    // minting); stub it so the address is actually stored and echoed back.
    const ledger = createMemoryLedger();
    const store = createMemoryStore({ ledger });
    const svc = createIdentityService({
      store,
      ledger,
      sender: { isConfigured: () => true, send: async () => {} },
      env: {},
    });
    const o = owner();
    store.upsertParty({ id: o, displayName: 'Marta' });
    const p = await svc.createProject({ actorPartyId: o, name: 'Maple Street', baselineBudgetCents: 100 });
    const { token } = await svc.inviteCounterparty({
      actorPartyId: o, projectId: p.id, email: 'gc@example.com',
    });

    const preview = await svc.previewInvitation({ token });
    assert.equal(preview.projectName, 'Maple Street');
    assert.equal(preview.invitedByName, 'Marta');
    assert.equal(preview.role, 'counterparty');
    assert.equal(preview.email, 'gc@example.com');
    assert.equal(preview.status, 'pending');
    // No session, no party ids, no token hash — only the fields the landing
    // screen needs.
    assert.equal(preview.projectId, undefined);
    assert.equal(preview.tokenHash, undefined);
    assert.equal(preview.invitedByPartyId, undefined);
  });

  test('out-of-band invite previews with null email and no invented inviter name', async () => {
    const o = owner();
    store.upsertParty({ id: o, displayName: null });
    const p = await svc.createProject({ actorPartyId: o, name: 'Maple Street', baselineBudgetCents: 100 });
    const { token } = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id });

    const preview = await svc.previewInvitation({ token });
    assert.equal(preview.email, null);
    assert.equal(preview.invitedByName, null);
  });

  test('unknown and spent tokens are an INDISTINGUISHABLE 404 — no validity oracle', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'Maple Street', baselineBudgetCents: 100 });
    const { token } = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id });

    const grab = (err) => ({ status: err?.status, code: err?.code, message: err?.message });
    await expectError(svc.previewInvitation({ token: 'garbage-token' }), 404, 'not_found');

    await svc.acceptInvitation({ actorPartyId: owner(), token });

    // The spent token must produce the byte-identical envelope as the garbage
    // one — a response that differs between the two is a validity oracle.
    const spent = await svc.previewInvitation({ token }).then(() => null, grab);
    assert.deepEqual(spent, {
      status: 404, code: 'not_found', message: 'invitation not found',
    });
  });

  test('a missing token is a 400', async () => {
    await expectError(svc.previewInvitation({ token: '' }), 400);
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

describe('getMe (LINA-154)', () => {
  test('returns the acting party’s own profile from the store', async () => {
    const { svc, store } = setup();
    const me = owner();
    store.upsertParty({ id: me, displayName: 'Marta' });
    const res = await svc.getMe({ actorPartyId: me });
    assert.equal(res.partyId, me);
    assert.equal(res.displayName, 'Marta');
    assert.ok('email' in res && 'role' in res);
  });

  test('anonymous or unknown party is a 401 / 404', async () => {
    const { svc } = setup();
    await expectError(svc.getMe({ actorPartyId: null }), 401, 'unauthenticated');
    await expectError(svc.getMe({ actorPartyId: owner() }), 404, 'not_found');
  });
});

// ── Band B (ADR-0011, LINA-164): draft-first create → model → commit 📐 ──────
// The wizard is three service steps: create(draft:true), setOperatingModel, then
// inviteCounterparty — whose FIRST invite is what commits the build. Every state
// change is a ledger event in the same unit of work as the projection write.
describe('Band B: draft-first createProject', () => {
  let svc, ledger;
  beforeEach(() => ({ svc, ledger } = setup()));

  test('draft:true lands status=draft, operatingModel null, genesis event only', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100, draft: true });
    assert.equal(p.status, 'draft');
    assert.equal(p.operatingModel, null);
    assert.deepEqual(ledger._chain(p.id).map((e) => e.type), ['project_created']);
  });

  test('the legacy one-shot path is unchanged: status=active, operatingModel null', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100 });
    assert.equal(p.status, 'active');
    assert.equal(p.operatingModel, null);
    assert.deepEqual(ledger._chain(p.id).map((e) => e.type), ['project_created']);
  });
});

describe('setOperatingModel (wizard step 2)', () => {
  let svc, ledger;
  beforeEach(() => ({ svc, ledger } = setup()));

  test('owner chooses a model on a draft; operating_model_set chains after genesis, build stays draft', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100, draft: true });
    const after = await svc.setOperatingModel({ actorPartyId: o, projectId: p.id, operatingModel: 'direct' });
    assert.equal(after.operatingModel, 'direct');
    assert.equal(after.status, 'draft', 'choosing a model does NOT commit the build');
    assert.deepEqual(ledger._chain(p.id).map((e) => e.type), ['project_created', 'operating_model_set']);
    assert.equal(ledger._verify(p.id).verified, true);
  });

  test('bad enum 400; not a draft 409; non-owner 403', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100, draft: true });
    await expectError(svc.setOperatingModel({ actorPartyId: o, projectId: p.id, operatingModel: 'oops' }), 400);
    await expectError(svc.setOperatingModel({ actorPartyId: owner(), projectId: p.id, operatingModel: 'turnkey' }), 403);

    const active = await svc.createProject({ actorPartyId: o, name: 'Legacy', baselineBudgetCents: 100 });
    await expectError(svc.setOperatingModel({ actorPartyId: o, projectId: active.id, operatingModel: 'turnkey' }), 409);
  });

  test('an idempotent self-PATCH writes no second event', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100, draft: true });
    await svc.setOperatingModel({ actorPartyId: o, projectId: p.id, operatingModel: 'hybrid' });
    const again = await svc.setOperatingModel({ actorPartyId: o, projectId: p.id, operatingModel: 'hybrid' });
    assert.equal(again.operatingModel, 'hybrid');
    assert.deepEqual(ledger._chain(p.id).map((e) => e.type), ['project_created', 'operating_model_set']);
  });
});

describe('invite roles follow the operating model (decision 4)', () => {
  let svc;
  beforeEach(() => ({ svc } = setup()));

  async function draftWithModel(model) {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100, draft: true });
    await svc.setOperatingModel({ actorPartyId: o, projectId: p.id, operatingModel: model });
    return { o, p };
  }

  test('turnkey admits counterparty; a subcontractor invite is a 400, not a silent downgrade', async () => {
    const { o, p } = await draftWithModel('turnkey');
    const res = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id, role: 'counterparty' });
    assert.equal(res.invitation.role, 'counterparty');
    await expectError(svc.inviteCounterparty({ actorPartyId: o, projectId: p.id, role: 'subcontractor' }), 400);
  });

  test('direct admits subcontractor only', async () => {
    const { o, p } = await draftWithModel('direct');
    const res = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id, role: 'subcontractor' });
    assert.equal(res.invitation.role, 'subcontractor');
    await expectError(svc.inviteCounterparty({ actorPartyId: o, projectId: p.id, role: 'counterparty' }), 400);
  });

  test('hybrid admits both, and accepting one role leaves the other open', async () => {
    const { o, p } = await draftWithModel('hybrid');
    const cp = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id, role: 'counterparty' });
    await svc.acceptInvitation({ actorPartyId: owner(), token: cp.token });

    const sub = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id, role: 'subcontractor' });
    await svc.acceptInvitation({ actorPartyId: owner(), token: sub.token });

    const view = await svc.getProject({ actorPartyId: o, projectId: p.id });
    assert.deepEqual(view.members.map((m) => m.role).sort(), ['counterparty', 'owner', 'subcontractor']);
  });

  test('a legacy (pre-Band-B) project keeps R0: counterparty only, any other role is a 400', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100 });
    await expectError(svc.inviteCounterparty({ actorPartyId: o, projectId: p.id, role: 'subcontractor' }), 400);
    const res = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id });
    assert.equal(res.invitation.role, 'counterparty');
  });
});

describe('a draft commits on its first invite (decision 2)', () => {
  let svc, ledger;
  beforeEach(() => ({ svc, ledger } = setup()));

  test('inviting a model-less draft is a 409 conflict — nothing minted, nothing committed', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100, draft: true });
    await expectError(
      svc.inviteCounterparty({ actorPartyId: o, projectId: p.id, role: 'counterparty' }),
      409,
      'conflict',
    );
    assert.deepEqual(ledger._chain(p.id).map((e) => e.type), ['project_created']);
  });

  test('first invite flips draft→active and appends project_committed in the same unit', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100, draft: true });
    await svc.setOperatingModel({ actorPartyId: o, projectId: p.id, operatingModel: 'direct' });
    assert.equal((await svc.getProject({ actorPartyId: o, projectId: p.id })).status, 'draft');

    const res = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id, role: 'subcontractor' });
    assert.equal(res.invitation.role, 'subcontractor');

    const after = await svc.getProject({ actorPartyId: o, projectId: p.id });
    assert.equal(after.status, 'active', 'the first invite commits the build');
    assert.equal(after.operatingModel, 'direct');

    const chain = ledger._chain(p.id);
    assert.deepEqual(chain.map((e) => e.type), [
      'project_created', 'operating_model_set', 'project_committed']);
    assert.equal(chain[2].payload.invitedRole, 'subcontractor');
    assert.equal(ledger._verify(p.id).verified, true);
  });

  test('a legacy one-shot project never emits project_committed (already active)', async () => {
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100 });
    await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id });
    assert.deepEqual(ledger._chain(p.id).map((e) => e.type), ['project_created']);
  });
});

describe('Band B: subcontractor join + analytics gating (LINA-163 stub)', () => {
  // A recording analytics seam: Band B subcontractor invites/joins must NOT be
  // reported through the GC-session events (gcInvited/gcJoined are counterparty
  // semantics; build_creation is owned by LINA-163, still unmerged).
  function recordingAnalytics() {
    const calls = [];
    const record = (name) => (args) => { calls.push({ name, ...args }); };
    return {
      calls,
      projectCreated: record('project_created'),
      gcInvited: record('gc_invited'),
      gcJoined: record('gc_joined'),
    };
  }

  function setupWithAnalytics() {
    const ledger = createMemoryLedger();
    const store = createMemoryStore({ ledger });
    const analytics = recordingAnalytics();
    const svc = createIdentityService({ store, ledger, analytics });
    return { svc, ledger, analytics };
  }

  test('a subcontractor accepts and joins as subcontractor; gc_joined is suppressed', async () => {
    const { svc, ledger, analytics } = setupWithAnalytics();
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100, draft: true });
    await svc.setOperatingModel({ actorPartyId: o, projectId: p.id, operatingModel: 'direct' });
    const { token } = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id, role: 'subcontractor' });

    const sub = owner();
    const { membership } = await svc.acceptInvitation({ actorPartyId: sub, token });
    assert.equal(membership.role, 'subcontractor');

    const view = await svc.getProject({ actorPartyId: sub, projectId: p.id });
    assert.equal(view.actingRole, 'subcontractor');

    assert.deepEqual(ledger._chain(p.id).map((e) => e.type), [
      'project_created', 'operating_model_set', 'project_committed', 'member_joined']);
    // Neither the subcontractor invite nor the join touched the GC analytics.
    assert.deepEqual(
      analytics.calls.filter((c) => c.name === 'gc_invited' || c.name === 'gc_joined'),
      [],
      'subcontractor invite/join is not reported until LINA-163 (build_creation) lands',
    );
  });

  test('the counterparty path still reports gc_invited + gc_joined (R0 analytics unchanged)', async () => {
    const { svc, analytics } = setupWithAnalytics();
    const o = owner();
    const p = await svc.createProject({ actorPartyId: o, name: 'House', baselineBudgetCents: 100 });
    const { token } = await svc.inviteCounterparty({ actorPartyId: o, projectId: p.id });
    assert.equal(analytics.calls.filter((c) => c.name === 'gc_invited').length, 1);
    await svc.acceptInvitation({ actorPartyId: owner(), token });
    assert.equal(analytics.calls.filter((c) => c.name === 'gc_joined').length, 1);
  });
});
