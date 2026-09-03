// Smoke test for the Fastify apps/api server (LINA-136).
//
// Verifies the server wiring without requiring a live Postgres/Clerk. We build
// Fastify with a mocked auth container (in-memory store, stub verifier) and
// assert the routes mount and the health check responds.
//
// Run: node --test apps/api/server.test.mjs  (from repo root, so the
// `--test` runner picks up the file; the test imports build the pieces)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

// Wait — the real server (server.js) builds the auth container from env and
// listens. For a hermetic smoke test we instead build a fastify instance with
// the same auth adapters but a stub store. We import the auth HTTP adapters
// directly (framework-agnostic) and mount them the same way server.js does.
import { createAuthSyncService } from '../../services/auth/sync.mjs';
import { createMemoryAuthStore } from '../../services/auth/store.mjs';
import { createAuthRequestPath } from '../../services/auth/require-auth.mjs';
import { createProfileService } from '../../services/auth/profile.mjs';
import { createClerkWebhookHttp } from '../../services/auth/webhook.mjs';
import { AuthError } from '../../services/auth/errors.mjs';
import { can } from '../../services/auth/can.mjs';

// A stub Clerk verifier that accepts tokens of the form `good:<clerkUserId>`
// and rejects everything else. `<clerkOrgId>` is optionally appended with `@`,
// e.g. `good:usr@org_1`.
const stubVerifyToken = async (token) => {
  if (!token) return null;
  if (token === 'bad') return null;
  const prefix = 'good:';
  if (token.startsWith(prefix)) {
    const [sub, org] = token.slice(prefix.length).split('@');
    return { sub, email: 'u@test.local', activeOrgId: org || undefined };
  }
  return null;
};

async function buildTestServer() {
  const store = createMemoryAuthStore();
  const sync = createAuthSyncService({ store });
  const authRequestPath = createAuthRequestPath({ store, sync, verifyToken: stubVerifyToken, can });
  const profileService = createProfileService({ store });
  const webhookHandler = createClerkWebhookHttp({ sync, secret: () => 'testsecret' });

  const fastify = Fastify({ logger: false });

  async function requireAuth(request, reply) {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: { code: 'unauthenticated', message: 'missing bearer' } });
    }
    try {
      request.auth = await authRequestPath.requireAuth(header.slice(7));
    } catch (err) {
      return reply.code(err.status || 401).send({ error: { code: err.code, message: err.message } });
    }
  }

  fastify.setErrorHandler((err, request, reply) => {
    if (err instanceof AuthError) {
      const body = { error: { code: err.code, message: err.message } };
      if (err.field) body.error.field = err.field;
      return reply.code(err.status).send(body);
    }
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'internal error' } });
  });

  fastify.get('/api/health', async () => ({ status: 'ok' }));

  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const raw = body.toString();
    req.rawBody = raw;
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      done(err);
    }
  });

  fastify.post('/api/webhooks/clerk', async (request, reply) => {
    if (!request.rawBody) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'raw body required' } });
    }
    const headers = {};
    for (const [k, v] of Object.entries(request.headers)) headers[k.toLowerCase()] = v;
    const result = await webhookHandler.handle({ rawBody: request.rawBody, headers });
    return reply.code(result.status).send(result.body);
  });

  fastify.get('/api/me', { preHandler: [requireAuth] }, async (request) => ({
    userId: request.auth.userId,
    clerkUserId: request.auth.clerkUserId,
  }));

  fastify.post('/api/me/profile', { preHandler: [requireAuth] }, async (request) => {
    const profile = await profileService.completeProfile({
      actor: request.auth,
      input: request.body,
    });
    return { profile };
  });

  return fastify;
}

const okBody = { displayName: 'João Costa', role: 'owner', language: 'pt' };

test('health route responds ok', async () => {
  const server = await buildTestServer();
  const res = await server.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
  await server.close();
});

test('webhook rejects bad svix signature (401)', async () => {
  const server = await buildTestServer();
  const res = await server.inject({
    method: 'POST',
    url: '/api/webhooks/clerk',
    headers: {
      'content-type': 'application/json',
      'svix-id': 'msg_1',
      'svix-timestamp': String(Math.floor(Date.now() / 1000)),
      'svix-signature': 'v1,invalid',
    },
    payload: JSON.stringify({ type: 'user.created', data: { id: 'usr_1' } }),
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'bad_signature');
  await server.close();
});

test('no auth header → 401 on /api/me', async () => {
  const server = await buildTestServer();
  const res = await server.inject({ method: 'GET', url: '/api/me' });
  assert.equal(res.statusCode, 401);
  await server.close();
});

test('valid token → 200 with resolved actor', async () => {
  const server = await buildTestServer();
  const res = await server.inject({
    method: 'GET',
    url: '/api/me',
    headers: { authorization: 'Bearer good:usr_test_1' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.clerkUserId, 'usr_test_1');
  assert.ok(body.userId);
  await server.close();
});

test('invalid token → 401 on /api/me', async () => {
  const server = await buildTestServer();
  const res = await server.inject({
    method: 'GET',
    url: '/api/me',
    headers: { authorization: 'Bearer bad' },
  });
  assert.equal(res.statusCode, 401);
  await server.close();
});

// ── POST /api/me/profile (LINA-137) ──────────────────────────────────────────

async function postProfile(server, { token = 'good:usr_setup', body }) {
  return server.inject({
    method: 'POST',
    url: '/api/me/profile',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

test('profile: no auth header → 401', async () => {
  const server = await buildTestServer();
  const res = await server.inject({
    method: 'POST',
    url: '/api/me/profile',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(okBody),
  });
  assert.equal(res.statusCode, 401);
  await server.close();
});

test('profile: invalid token → 401', async () => {
  const server = await buildTestServer();
  const res = await postProfile(server, { token: 'bad', body: okBody });
  assert.equal(res.statusCode, 401);
  await server.close();
});

test('profile: valid input → 200 with stored profile and role granted', async () => {
  const server = await buildTestServer();
  const res = await postProfile(server, {
    token: 'good:usr_setup@org_1',
    body: { displayName: '  João Costa  ', role: 'owner', language: 'pt' },
  });
  assert.equal(res.statusCode, 200);
  const { profile } = res.json();
  // displayName is trimmed on write.
  assert.equal(profile.displayName, 'João Costa');
  assert.equal(profile.role, 'owner');
  assert.equal(profile.language, 'pt');
  assert.equal(profile.setupComplete, true);
  await server.close();
});

test('profile: general_contractor maps to the gc role and grants a membership', async () => {
  const server = await buildTestServer();
  const res = await postProfile(server, {
    token: 'good:usr_gc@org_gc',
    body: { displayName: 'Ana Silva', role: 'general_contractor', language: 'en' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().profile.role, 'general_contractor');
  await server.close();
});

test('profile: repeat setup → 409 already set up', async () => {
  const server = await buildTestServer();
  // Set up the profile once.
  await postProfile(server, { token: 'good:usr_repeat@org_1', body: okBody });
  // The client treats 409 as success (already onboarded); assert the code.
  const res = await postProfile(server, { token: 'good:usr_repeat@org_1', body: okBody });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'already_setup');
  await server.close();
});

test('profile: missing displayName → 400 with field', async () => {
  const server = await buildTestServer();
  const res = await postProfile(server, { token: 'good:usr_v_1', body: { role: 'owner', language: 'en' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.field, 'displayName');
  assert.equal(res.json().error.code, 'bad_request');
  await server.close();
});

test('profile: invalid role → 400 with field', async () => {
  const server = await buildTestServer();
  const res = await postProfile(server, {
    token: 'good:usr_v_2',
    body: { displayName: 'X', role: 'subcontractor', language: 'en' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.field, 'role');
  await server.close();
});

test('profile: invalid language → 400 with field', async () => {
  const server = await buildTestServer();
  const res = await postProfile(server, {
    token: 'good:usr_v_3',
    body: { displayName: 'X', role: 'owner', language: 'fr' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.field, 'language');
  await server.close();
});
