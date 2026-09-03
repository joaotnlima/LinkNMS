// Svix signature verification for the Clerk webhook endpoint (LINA-143; §5 A).
//
// Clerk delivers webhooks through Svix and signs each request with a per-endpoint
// webhook secret. This module verifies that signature so a forged POST to
// /api/webhooks/clerk (one that carries a body an attacker chose, without the
// secret) is rejected. It is a faithful, zero-dependency implementation of the
// same algorithm the `svix` SDK's `Webhook.verify` runs:
//
//   1. Read `svix-id`, `svix-timestamp`, `svix-signature` headers.
//   2. Reject when `svix-timestamp` is outside the replay window
//      (tolerance in seconds) — signature mimicry cannot feign freshness.
//   3. Build the signed content = `${id}.${timestamp}.${rawBody}`.
//   4. HMAC-SHA256 the content with the webhook secret; the signature header
//      carries one-or-more base64 `v1,<mac>` entries — ANY must match
//      (timing-safe) for the request to be authentic.
//
// Swapping to the official `svix` SDK later (once it is a dependency) is a like-
// for-like replacement of `verify`; the contract here (return boolean) stays.
import { createHmac, timingSafeEqual } from 'node:crypto';

// Default replay tolerance: +5s (clock skew) / -5min (a delayed legitimate
// event can turn up late; Svix defaults to 5 minutes).
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

/** @typedef {{ 'svix-id': string, 'svix-timestamp': string, 'svix-signature': string }} SvixHeaders */

/**
 * Verify a Svix-signed webhook delivery.
 * @param {SvixHeaders} headers       lowercase header name → value map
 * @param {string} rawBody            the EXACT raw request body (string)
 * @param {string} secret             the endpoint's webhook signing secret (CLERK_WEBHOOK_SECRET)
 * @param {{ toleranceSeconds?: number, nowMs?: number }} [opts]
 * @returns {boolean} true when the signature is valid and fresh
 */
export function verifySvixSignature(
  headers,
  rawBody,
  secret,
  { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, nowMs = Date.now() } = {},
) {
  const id = headers?.['svix-id'];
  const ts = headers?.['svix-timestamp'];
  const sigHeader = headers?.['svix-signature'];
  if (!id || !ts || !sigHeader || !secret) return false;

  // Freshness guard before any crypto: an old (replayed) delivery is refused
  // even with a valid MAC, bounding the window an attacker can reuse a capture.
  const tsNum = Number(ts);
  if (!Number.isInteger(tsNum)) return false;
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - tsNum) > toleranceSeconds) return false;

  const content = `${id}.${ts}.${rawBody}`;
  const expected = createHmac('sha256', String(secret)).update(content).digest();

  // The signature header is `v1,<mac1> v1,<mac2>…` (rotating keys). Any entry
  // that matches is authentic; each is compared timing-safe.
  return sigHeader.split(' ').some((entry) => {
    const [version, macB64] = entry.split(',', 2);
    if (version !== 'v1' || !macB64) return false;
    let given;
    try { given = Buffer.from(macB64, 'base64'); } catch { return false; }
    if (given.length !== expected.length) return false;
    return timingSafeEqual(given, expected);
  });
}

/** Build the Svix headers a TEST vendor would send (self-test / validation). */
export function signForTest({ id = 'msg_test', timestamp = Math.floor(Date.now() / 1000), secret }) {
  const body = JSON.stringify({ data: { id: 'usr_test' }, type: 'user.created' });
  const content = `${id}.${timestamp}.${body}`;
  const mac = createHmac('sha256', secret).update(content).digest('base64');
  return { body, headers: { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${mac}` } };
}
