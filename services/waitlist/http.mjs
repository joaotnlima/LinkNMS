// Waitlist — HTTP route handlers for POST /api/waitlist (LINA-127; ADR-0004).
//
// Framework-agnostic: the handler takes a small request context `{ session,
// params, body }` and returns `{ status, body }`. The Next gateway
// (app/src/server/gateway.ts) adapts its runtime request to this shape.
//
// A waitlist signup is UNAUTHENTICATED prospect capture — there is no session,
// and requiring one would block the D-4 landing form. The acting party is
// therefore `null`; there is no actor to forge and no membership to check. The
// only bodies the service accepts are the domain fields; nothing here lets a
// client set status or signup_order (both are server-side).
import { DomainError } from './ports.mjs';

const errorBody = (err) => {
  if (err instanceof DomainError
      || (err && typeof err.status === 'number' && typeof err.code === 'string')) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  // An unmapped throw is a bug or an infrastructure failure (a missing GRANT, a
  // dropped connection), never a client mistake. Nothing leaks; the real error
  // goes to the server log so a 500 is diagnosable.
  console.error('[waitlist] unhandled service error', err);
  return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } };
};

/**
 * @param {Object} deps
 * @param {ReturnType<import('./waitlist.mjs').createWaitlistService>} deps.service
 */
export function createWaitlistHttp({ service }) {
  if (!service) throw new Error('createWaitlistHttp requires { service }');

  // POST /api/waitlist — capture an email (D-4), store waitlisted, trigger D-2.
  async function subscribe({ body }) {
    try {
      const signup = await service.subscribe(body ?? {});
      return { status: 201, body: signup };
    } catch (err) { return errorBody(err); }
  }

  return { subscribe };
}
