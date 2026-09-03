// Auth — POST /api/webhooks/clerk handler (LINA-143; Auth Bridge §5 A).
//
// Framework-agnostic, same shape as the sibling http adapters: `{ body, headers,
// rawBody }` in, `{ status, body }` out. The transport route (Next or Fastify)
// extracts `rawBody` (the EXACT bytes) and the headers, then calls `handle`.
//
// The Svix signature MUST verify (services/auth/svix.mjs) before any state is
// touched — this endpoint is the write path into the `authz` mirror, so an
// unverified POST is a forged identity write. Signature failure → 401, no side
// effects. Unknown-but-verified event types → 200 `{ handled: false }` (a benign
// skip, not an error); verified known events are upserted idempotently.
//
// The secret is read from the environment on demand and never logged.
import { AuthError } from './errors.mjs';
import { verifySvixSignature } from './svix.mjs';

/**
 * @param {Object} deps
 * @param {ReturnType<import('./sync.mjs').createAuthSyncService>} deps.sync
 * @param {{ verify(headers, rawBody, secret): boolean }} [deps.verifier]
 * @param {() => string|undefined} [deps.secret]  provider for CLERK_WEBHOOK_SECRET
 */
export function createClerkWebhookHttp({
  sync,
  verifier = { verify: verifySvixSignature },
  secret = () => process.env.CLERK_WEBHOOK_SECRET,
}) {
  if (!sync) throw new Error('webhook handler requires a sync service');

  /**
   * @param {{ rawBody: string, headers: Record<string,string> }} input
   */
  async function handle({ rawBody, headers }) {
    const h = (k) => headers[k] ?? headers[k.toLowerCase()] ?? null;
    const secretVal = secret();
    if (!secretVal) {
      return { status: 503, body: { error: { code: 'webhook_unconfigured', message: 'webhook secret not configured' } } };
    }
    if (!verifier.verify({ 'svix-id': h('svix-id'), 'svix-timestamp': h('svix-timestamp'), 'svix-signature': h('svix-signature') }, rawBody, secretVal)) {
      return { status: 401, body: { error: { code: 'bad_signature', message: 'invalid webhook signature' } } };
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: { code: 'bad_request', message: 'invalid webhook body' } } };
    }

    try {
      const result = await sync.handleWebhookEvent({ type: event.type, data: event.data });
      return { status: 200, body: { handled: result.handled, type: event.type } };
    } catch (err) {
      // A sync failure is an infrastructure problem, not a client mistake.
      console.error('[auth] webhook sync failed', err?.code ?? err?.message ?? 'unknown');
      return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } };
    }
  }

  return { handle };
}
