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
import { createRateLimiter } from './rate-limit.mjs';

function makeHttp() {
  const ledger = createMemoryLedger();
  const store = createMemoryStore({ ledger });
  const service = createIdentityService({ store, ledger });
  return { http: createIdentityHttp({ service }), ledger, store, service };
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

// ── Invite-by-email: where the emailed link's origin comes from (LINA-84) ─────
//
// THE property: the origin is taken from the forwarded request headers (or the
// APP_BASE_URL override), NEVER from the request body. A body-supplied origin
// would let any authenticated owner have LinkNMS send mail, from our domain,
// whose "Accept" button points at a host of their choosing — a phishing
// primitive wearing our brand.
test('the emailed invite link uses the forwarded origin, never a body-supplied one', async () => {
  const sent = [];
  const ledger = createMemoryLedger();
  const store = createMemoryStore({ ledger });
  const service = createIdentityService({
    store,
    ledger,
    sender: { isConfigured: () => true, send: async (m) => { sent.push(m); } },
    env: {}, // no APP_BASE_URL, so the headers decide
  });
  const http = createIdentityHttp({ service });

  const homeowner = party();
  const created = await http.createProject({
    session: session(homeowner), body: { name: 'Maple Street', baselineBudgetCents: 100 },
  });

  const invited = await http.inviteCounterparty({
    session: session(homeowner),
    params: { id: created.body.id },
    body: {
      email: 'gc@example.com',
      // Both of these are forgeries and must be ignored.
      baseUrl: 'https://evil.example',
      origin: 'https://evil.example',
    },
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.linknms.com' },
  });

  assert.equal(invited.status, 201);
  assert.equal(invited.body.emailed, true);
  assert.equal(sent.length, 1);
  assert.ok(
    sent[0].html.includes('https://app.linknms.com/invitations/accept?token='),
    'the link is built from the forwarded host',
  );
  assert.ok(!sent[0].html.includes('evil.example'), 'a body-supplied origin is inert');
  // The token still rides the 201 body, so the owner is never left with nothing.
  assert.ok(invited.body.token);
  assert.equal(invited.headers['cache-control'], 'no-store');
});

test('invite without an email is unchanged: 201, a token, and nothing sent', async () => {
  const sent = [];
  const ledger = createMemoryLedger();
  const store = createMemoryStore({ ledger });
  const service = createIdentityService({
    store, ledger,
    sender: { isConfigured: () => true, send: async (m) => { sent.push(m); } },
    env: {},
  });
  const http = createIdentityHttp({ service });

  const homeowner = party();
  const created = await http.createProject({
    session: session(homeowner), body: { name: 'Maple Street', baselineBudgetCents: 100 },
  });
  const invited = await http.inviteCounterparty({
    session: session(homeowner), params: { id: created.body.id }, body: {}, headers: {},
  });

  assert.equal(invited.status, 201);
  assert.ok(invited.body.token);
  assert.equal(invited.body.emailed, false);
  assert.equal(invited.body.invitation.email, null);
  assert.equal(sent.length, 0);
});

// ── GET /me (LINA-154) ───────────────────────────────────────────────────────
test('getMe returns the acting party’s profile, never cached', async () => {
  const { http, store } = makeHttp();
  const me = party();
  store.upsertParty({ id: me, displayName: 'Marta' });

  const res = await http.getMe({ session: session(me), params: {}, body: undefined, headers: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.partyId, me);
  assert.equal(res.body.displayName, 'Marta');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('getMe anonymous is a 401 in the uniform envelope', async () => {
  const { http } = makeHttp();
  const res = await http.getMe({ session: null, params: {}, body: undefined, headers: {} });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'unauthenticated');
});

// ── GET /invitations/:token preview (LINA-182) ───────────────────────────────
test('previewInvitation serves a signed-out visitor: build name, inviter, email', async () => {
  // makeHttp() uses the default (unconfigured) sender; an email invite needs a
  // configured one, so build the graph here with a stub.
  const ledger = createMemoryLedger();
  const store = createMemoryStore({ ledger });
  const service = createIdentityService({
    store, ledger,
    sender: { isConfigured: () => true, send: async () => {} },
    env: {},
  });
  const http = createIdentityHttp({ service });
  const o = party();
  store.upsertParty({ id: o, displayName: 'Marta' });
  const created = await http.createProject({
    session: session(o), body: { name: 'Maple Street', baselineBudgetCents: 100 },
  });
  const invited = await http.inviteCounterparty({
    session: session(o), params: { id: created.body.id }, body: { email: 'gc@example.com' },
  });

  const res = await http.previewInvitation({
    session: null, params: { token: invited.body.token }, headers: {},
  });
  assert.equal(res.status, 200);
  // A personal address rides the payload; a shared cache must never serve it.
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.body, {
    projectName: 'Maple Street',
    invitedByName: 'Marta',
    role: 'counterparty',
    email: 'gc@example.com',
    status: 'pending',
  });
  // Only the landing-screen fields — never the token hash, party ids, or ids.
  assert.equal(res.body.tokenHash, undefined);
  assert.equal(res.body.invitedByPartyId, undefined);
});

test('previewInvitation: unknown and spent tokens are an indistinguishable 404', async () => {
  const { http, store } = makeHttp();
  const o = party();
  store.upsertParty({ id: o, displayName: 'Marta' });
  const created = await http.createProject({
    session: session(o), body: { name: 'Maple Street', baselineBudgetCents: 100 },
  });
  const invited = await http.inviteCounterparty({
    session: session(o), params: { id: created.body.id }, body: {},
  });

  const unknown = await http.previewInvitation({ session: null, params: { token: 'no-such-token' }, headers: {} });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'not_found');

  await http.acceptInvitation({ session: session(party()), params: { token: invited.body.token } });
  const spent = await http.previewInvitation({ session: null, params: { token: invited.body.token }, headers: {} });
  assert.equal(spent.status, 404);
  assert.deepEqual(spent.body, unknown.body, 'spent must be byte-identical to unknown — no oracle');
});

test('previewInvitation: a missing token is a 400', async () => {
  const { http } = makeHttp();
  const res = await http.previewInvitation({ session: null, params: {}, headers: {} });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'bad_request');
});

test('previewInvitation is rate-limited per token and per client IP (429)', async () => {
  const ledger = createMemoryLedger();
  const store = createMemoryStore({ ledger });
  const service = createIdentityService({ store, ledger });
  const o = party();
  // One pending invite per project, so a distinct token needs a distinct build.
  const mint = async () => {
    const created = await http.createProject({
      session: session(o), body: { name: `Build ${Math.random()}`, baselineBudgetCents: 100 },
    });
    return (await http.inviteCounterparty({
      session: session(o), params: { id: created.body.id }, body: {},
    })).body.token;
  };

  // A frozen clock keeps the fixed window from ever rolling over mid-test.
  const http = createIdentityHttp({
    service,
    rateLimiter: createRateLimiter({ windowMs: 60_000, max: 2, clock: () => 0 }),
  });

  const show = (token, ip) =>
    http.previewInvitation({ session: null, params: { token }, headers: { 'x-real-ip': ip } });

  // One leaked token, hammered from many IPs: the token bucket trips on the
  // 3rd attempt whatever the IP.
  const t = await mint();
  assert.equal((await show(t, '1.1.1.1')).status, 200);
  assert.equal((await show(t, '2.2.2.2')).status, 200);
  const tripped = await show(t, '3.3.3.3');
  assert.equal(tripped.status, 429);
  assert.equal(tripped.body.error.code, 'rate_limited');

  // A fresh limiter, one IP, rotating tokens: the per-IP bucket trips in
  // aggregate even though each token was only tried once.
  const http2 = createIdentityHttp({
    service,
    rateLimiter: createRateLimiter({ windowMs: 60_000, max: 3, clock: () => 0 }),
  });
  const show2 = (token) =>
    http2.previewInvitation({ session: null, params: { token }, headers: { 'x-real-ip': '9.9.9.9' } });
  assert.equal((await show2(await mint())).status, 200);
  assert.equal((await show2(await mint())).status, 200);
  assert.equal((await show2(await mint())).status, 200);
  assert.equal((await show2(await mint())).status, 429);
});

// GET /projects — the portfolio handler (LINA-197 / ADR-0012 §A1). The service
// returns cards without `counts` (Identity never reads a sibling schema); the
// handler composes the two batched folds here at the seam. These tests prove the
// composition: decisions/changeOrders ride their own per-card keys, zero counts
// are never invented by an absent provider, and the payload is session-only.
test('listProjects: counts are composed from injected batched providers, per card', async () => {
  const ledger = createMemoryLedger();
  const store = createMemoryStore({ ledger });
  const service = createIdentityService({ store, ledger });
  const ownerA = party();
  const ownerB = party();

  const mine = await service.createProject({ actorPartyId: ownerA, name: 'Maple', baselineBudgetCents: 100 });
  const theirs = await service.createProject({ actorPartyId: ownerB, name: 'Their Build', baselineBudgetCents: 900 });

  // Stub batched folds — the real store.countProjects returns Map<projectId, n>.
  const counts = {
    decisions: async (ids) => new Map(ids.map((id, i) => [id, 10 + i])),
    changeOrders: async (ids) => new Map([[mine.id, 4], [theirs.id, 2]]),
  };
  const http = createIdentityHttp({ service, counts });

  const res = await http.listProjects({ session: session(ownerA) });
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store', 'a personal payload must never be shared-cached');
  assert.equal(res.body.projects.length, 1, 'owner A sees only their own build');
  const card = res.body.projects[0];
  assert.equal(card.id, mine.id);
  assert.equal(card.role, 'owner');
  assert.equal(card.counts.decisions, 10, 'decisions fold keyed to this card');
  assert.equal(card.counts.changeOrders, 4, 'change-orders fold keyed to this card');
  // The service-level fields flow through untouched.
  assert.equal(card.name, 'Maple');
  assert.equal(card.baselineBudgetCents, 100);
  assert.equal(card.currentBudgetCents, 100);
  // The other party's card is not in owner A's payload at all.
  assert.ok(!res.body.projects.some((p) => p.id === theirs.id));
});

test('listProjects: absent providers yield zero counts (identity-only wiring)', async () => {
  const ledger = createMemoryLedger();
  const store = createMemoryStore({ ledger });
  const service = createIdentityService({ store, ledger });
  const o = party();
  await service.createProject({ actorPartyId: o, name: 'Maple', baselineBudgetCents: 100 });

  const http = createIdentityHttp({ service }); // no `counts` injected
  const res = await http.listProjects({ session: session(o) });
  assert.equal(res.status, 200);
  assert.equal(res.body.projects[0].counts.decisions, 0);
  assert.equal(res.body.projects[0].counts.changeOrders, 0);
});

test('listProjects without a session is a 401 in the uniform envelope', async () => {
  const { http } = makeHttp();
  const res = await http.listProjects({ session: null });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'unauthenticated');
});
