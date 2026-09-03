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
import { createClerkWebhookHttp } from '../../services/auth/webhook.mjs';
import { can } from '../../services/auth/can.mjs';

// A stub Clerk verifier that accepts tokens of the form `good:<clerkUserId>`
// and rejects everything else.
const stubVerifyToken = async (token) => {
  if (!token) return null;
  if (token === 'bad') return null;
  const prefix = 'good:';
  if (token.startsWith(prefix)) {
    return { sub: token.slice(prefix.length), email: 'u@test.local' };
  }
  return null;
};

async function buildTestServer() {
  const store = createMemoryAuthStore();
  const sync = createAuthSyncService({ store });
  const authRequestPath = createAuthRequestPath({ store, sync, verifyToken: stubVerifyToken, can });
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

  return fastify;
}

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
