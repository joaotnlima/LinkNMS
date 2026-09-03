// The auth-service composition root for the Fastify apps/api server (LINA-136).
//
// Builds the auth services (Clerk verifier, sync, request path, webhook handler)
// against Postgres and the real Clerk SDK. A thin adapter layer between the
// framework-agnostic services/auth/* modules and Fastify's plugin system.
//
// This mirrors services/gateway/container.mjs but for the auth layer only —
// the rest of the service graph continues to compose through the existing
// Next.js gateway container until the full Fastify migration lands.
import { createPool } from '../../services/ledger/db.mjs';
import { createPgAuthStore } from '../../services/auth/pg-store.mjs';
import { createAuthSyncService } from '../../services/auth/sync.mjs';
import { createClerkVerifier } from '../../services/auth/clerk.mjs';
import { createAuthRequestPath } from '../../services/auth/require-auth.mjs';
import { createClerkWebhookHttp } from '../../services/auth/webhook.mjs';
import { can } from '../../services/auth/can.mjs';

function urlFor(varName) {
  const url = process.env[varName] || process.env.DATABASE_URL;
  if (!url) throw new Error(`${varName} (or DATABASE_URL) is required for apps/api`);
  return url;
}

const roleFor = (varName) => process.env[varName] || undefined;

/**
 * Create a Svix verifier backed by the official svix SDK.
 * Falls back to the zero-dep custom implementation in services/auth/svix.mjs.
 */
async function createSvixVerifier() {
  try {
    const { Webhook } = await import('svix');
    return {
      verify({ 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig }, rawBody, secret) {
        const wh = new Webhook(secret);
        try {
          wh.verify(rawBody, { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig });
          return true;
        } catch {
          // svix throws WebhookVerificationError on failure; the webhook
          // handler expects a boolean (false → 401).
          return false;
        }
      },
    };
  } catch {
    const { verifySvixSignature } = await import('../../services/auth/svix.mjs');
    return { verify: verifySvixSignature };
  }
}

/**
 * Build the auth service graph against Postgres + Clerk SDK.
 * Returns the auth request path (JWT verify → authorize) and the webhook handler.
 *
 * @returns {Promise<{ authRequestPath: object, webhookHandler: object, pool: import('pg').Pool }>}
 */
export async function createAuthContainer() {
  const pool = createPool(urlFor('AUTHZ_DATABASE_URL'), {
    role: roleFor('AUTHZ_DATABASE_ROLE'),
  });

  const store = createPgAuthStore({ pool });
  const sync = createAuthSyncService({ store });

  // Lazy-import @clerk/backend so the module graph loads even when the SDK
  // is not installed (e.g. tests). The deployed server always has it.
  let clerkBackend;
  try {
    clerkBackend = await import('@clerk/backend');
  } catch {
    throw new Error(
      '@clerk/backend is required for JWT verification — install it in apps/api/',
    );
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is required');

  const verifyToken = createClerkVerifier({ secretKey }, clerkBackend);

  const authRequestPath = createAuthRequestPath({ store, sync, verifyToken, can });

  const webhookHandler = createClerkWebhookHttp({ sync, verifier: await createSvixVerifier() });

  return { authRequestPath, webhookHandler, pool };
}
