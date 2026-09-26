// Svix signature verification for the Clerk webhook (openapi: clerkWebhook).
//
// Implemented on node:crypto instead of pulling the svix SDK: the scheme is
// three headers and one HMAC. Contract (docs.svix.com/receiving):
//   signed_content = `${svix-id}.${svix-timestamp}.${raw body}`
//   expected       = base64(HMAC-SHA256(base64decode(secret after 'whsec_'), signed_content))
//   svix-signature = space-separated list of `v1,<base64>`; any match passes
//   timestamp      = unix seconds, ±5 min tolerance
import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_S = 5 * 60;

/**
 * @param {{ secret: string, headers: Record<string, string|undefined>,
 *           rawBody: string, now?: number }} args  now = unix seconds (tests)
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifySvix({ secret, headers, rawBody, now = Math.floor(Date.now() / 1000) }) {
  if (!secret) return { ok: false, reason: 'no signing secret configured' };
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signatures = headers['svix-signature'];
  if (!id || !timestamp || !signatures) return { ok: false, reason: 'missing svix headers' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(now - ts) > TOLERANCE_S) return { ok: false, reason: 'timestamp outside tolerance' };

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();

  for (const part of signatures.split(' ')) {
    const [version, sig] = part.split(',', 2);
    if (version !== 'v1' || !sig) continue;
    const got = Buffer.from(sig, 'base64');
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: 'no matching v1 signature' };
}
