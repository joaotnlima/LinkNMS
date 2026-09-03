// apps/api/server.js — Fastify API server (LINA-136).
//
// The Clerk-verified entry point for the LinkNMS backend API. Mounts:
//   1. A preHandler that verifies the Clerk session JWT on every authenticated
//      route, resolving clerk_user_id → Neon RBAC via JIT provisioning.
//   2. POST /api/webhooks/clerk — Svix-verified webhook endpoint that syncs
//      Clerk user/org/membership events into the authz catalog.
//
// Environment variables (per spec §3):
//   CLERK_SECRET_KEY            — Clerk backend secret (JWT verification)
//   CLERK_PUBLISHABLE_KEY       — Clerk publishable key (for frontend)
//   CLERK_WEBHOOK_SECRET        — Svix webhook signing secret
//   DATABASE_URL                — Postgres connection (fallback)
//   AUTHZ_DATABASE_URL          — authz_app Postgres connection (optional, falls back to DATABASE_URL)
//   AUTHZ_DATABASE_ROLE         — Postgres role to SET ROLE (optional; requires direct endpoint)
//   PORT                        — Server port (default: 3001)
//
// NOTE: This server is the LINA-136 scaffold. It does NOT yet proxy the
// existing Next.js service routes — those continue through the Next.js gateway
// (app/src/server/gateway.ts). This server handles auth + webhooks only until
// the full Fastify migration is coordinated by the Architect.
import Fastify from 'fastify';
import { createAuthContainer } from './compose.mjs';
import { AuthError } from '../../services/auth/errors.mjs';

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function main() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      // Redact sensitive headers from request logs.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  // Build the auth service graph once at startup (lazy singleton).
  const { authRequestPath, webhookHandler, pool } = await createAuthContainer();

  // ── Clerk JWT preHandler ────────────────────────────────────────────────
  //
  // Runs on every route that opts in (via `{ preHandler: [requireAuth] }`).
  // Verifies the Clerk session JWT, JIT-provisions the user if needed, and
  // attaches the resolved actor to `request.auth`. Routes that need
  // authorization call `authRequestPath.authorize(request.auth, action, resource)`.
  async function requireAuth(request, reply) {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: { code: 'unauthenticated', message: 'missing or malformed Authorization header' },
      });
    }
    const token = header.slice(7);
    try {
      request.auth = await authRequestPath.requireAuth(token);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.status).send({
          error: { code: err.code, message: err.message },
        });
      }
      request.log.error({ err }, 'unexpected auth failure');
      return reply.code(500).send({
        error: { code: 'internal', message: 'internal error' },
      });
    }
  }

  // ── Health check (unauthenticated) ──────────────────────────────────────

  fastify.get('/api/health', async () => {
    return { status: 'ok', service: '@linknms/api', timestamp: new Date().toISOString() };
  });

  // ── POST /api/webhooks/clerk (unauthenticated, Svix-verified) ───────────
  //
  // Clerk delivers webhook events through Svix. The raw body MUST be verified
  // before any state is touched. The handler in services/auth/webhook.mjs
  // enforces this: unverified → 401, unknown event types → 200 { handled: false }.
  fastify.post('/api/webhooks/clerk', async (request, reply) => {
    // Clerk requires the raw body for Svix signature verification — Fastify
    // parses JSON by default, but the webhook handler needs the exact bytes.
    // We read the raw body from the underlying Node request.
    const rawBody = request.rawBody;
    if (!rawBody) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: 'raw body required for signature verification' },
      });
    }

    // Build a lowercase header map for the Svix verifier.
    const headers = {};
    for (const [key, value] of Object.entries(request.headers)) {
      headers[key.toLowerCase()] = value;
    }

    const result = await webhookHandler.handle({ rawBody, headers });
    return reply.code(result.status).send(result.body);
  });

  // ── Example authenticated route ─────────────────────────────────────────
  //
  // GET /api/me — return the authenticated user's resolved identity.
  // Demonstrates the JWT → RBAC resolution path.
  fastify.get('/api/me', { preHandler: [requireAuth] }, async (request) => {
    return {
      userId: request.auth.userId,
      clerkUserId: request.auth.clerkUserId,
      activeOrgId: request.auth.activeOrgId,
    };
  });

  // ── Error handler ───────────────────────────────────────────────────────
  //
  // Maps AuthError (401/403/409) to structured JSON. Anything else is an
  // infrastructure failure — log it, return a generic 500.
  fastify.setErrorHandler((err, request, reply) => {
    if (err instanceof AuthError) {
      return reply.code(err.status).send({
        error: { code: err.code, message: err.message },
      });
    }
    // Fastify's 400s for malformed requests.
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({
        error: { code: 'bad_request', message: err.message },
      });
    }
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'internal', message: 'internal error' },
    });
  });

  // ── Capture the raw body for the webhook route ──────────────────────────
  //
  // Fastify's JSON parser replaces `request.body` with the parsed object and
  // discards the raw bytes. The Clerk webhook handler needs the EXACT bytes
  // for Svix signature verification. We intercept the raw body before parsing.
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const rawBody = body.toString();
    // Store the raw bytes on the Fastify request so the webhook route can
    // pass them to the Svix verifier. The route handler's `request` is the
    // same object as this parser's `req`.
    req.rawBody = rawBody;
    try {
      done(null, JSON.parse(rawBody));
    } catch (err) {
      done(err);
    }
  });

  // ── Start ───────────────────────────────────────────────────────────────

  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info({ port: PORT }, '@linknms/api server started');

  // Graceful shutdown.
  const shutdown = async (signal) => {
    fastify.log.info({ signal }, 'shutting down');
    await fastify.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[api] fatal startup error', err);
  process.exit(1);
});
