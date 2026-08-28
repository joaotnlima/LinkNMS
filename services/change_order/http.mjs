// Change Order — HTTP route handlers for the four openapi.yaml endpoints
// (propose / list / decide / get), LINA-51 / ADR-0004.
//
// These are deliberately framework-agnostic: each handler takes a small request
// context `{ session, params, body }` and returns `{ status, body }`. A thin
// gateway (a Next.js route handler, a Node http server, a test) adapts its
// runtime request to this shape and serialises the result. Keeping the mapping
// here — not in the gateway — means the security property below is proven by
// this service's own tests, independent of any web framework.
//
// THE security property (ADR-0004): the acting party is ALWAYS derived from the
// authenticated session (`session.partyId`) and NEVER read from the request body
// or query. `propose`/`decide` pass only the domain fields to the service, which
// itself reads no actor field from its input — so a forged `proposedBy` in a body
// is inert. Authorization (membership, the two-sided rule) is the service's /
// Identity's job; this layer only wires session→actor and maps typed errors to
// the uniform `{ error: { code, message } }` envelope (design §6).
import { DomainError } from './ports.mjs';

// Uniform error envelope shared across the platform (design §6; the frontend
// reads `body.error.message`). An untyped error never leaks its detail.
//
// Both typed families must be mapped, not just this service's own. Authorization
// here is Identity's (ADR-0004: one authorizer), so EVERY denial on these
// endpoints — a non-member proposing, deciding, or reading a change order —
// arrives as an `IdentityError`, not a `DomainError`. Matching only DomainError
// turned all of them into a 500: the caller could not tell "you may not do this"
// from "the server is broken", the frontend had no 403 to render, and a wall of
// ordinary authorization denials looked like an outage. Matched structurally
// (`status` + `code`) rather than by class, so a typed error from any service
// maps correctly and this cannot silently regress.
function errorBody(err) {
  if (err instanceof DomainError
      || (err && typeof err.status === 'number' && typeof err.code === 'string')) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } };
}

const actorOf = (session) => session?.partyId ?? null;

/**
 * @param {Object} deps
 * @param {ReturnType<import('./change-order.mjs').createChangeOrderService>} deps.service
 * @param {{ requireMember(partyId, projectId): Promise<any>|any }} deps.identity
 *   the same Identity port the service consumes — used to authorize the read-only
 *   GET, whose membership check has no natural home inside a mutation.
 */
export function createChangeOrderHttp({ service, identity }) {
  if (!service) throw new Error('createChangeOrderHttp requires { service }');
  if (!identity) throw new Error('createChangeOrderHttp requires { identity } for GET authorization');

  // GET /projects/:projectId/change-orders — FR7
  async function listChangeOrders({ session, params }) {
    try {
      const changeOrders = await service.list(params.projectId, actorOf(session));
      return { status: 200, body: { changeOrders } };
    } catch (err) { return errorBody(err); }
  }

  // POST /projects/:projectId/change-orders — FR3, FR8
  async function proposeChangeOrder({ session, params, body }) {
    try {
      // Only domain fields reach the service; the actor is the session's, never
      // the body's. A `proposedBy`/`actorPartyId` planted in `body` is ignored.
      const co = await service.propose(params.projectId, actorOf(session), body ?? {});
      return { status: 201, body: co };
    } catch (err) { return errorBody(err); }
  }

  // GET /change-orders/:changeOrderId — FR6, the "one screen" answer
  async function getChangeOrder({ session, params }) {
    try {
      // 404 first if it does not exist; then a membership check on its project so a
      // non-member is a 403 (both are documented responses). Existence of a CO by
      // its unguessable UUID is the only thing distinguishable to a non-member.
      const co = await service.view(params.changeOrderId);
      await identity.requireMember(actorOf(session), co.projectId);
      return { status: 200, body: co };
    } catch (err) { return errorBody(err); }
  }

  // POST /change-orders/:changeOrderId/decision — FR4, FR5
  async function decideChangeOrder({ session, params, body }) {
    try {
      const { decision, idempotencyKey } = body ?? {};
      const co = await service.decide(params.changeOrderId, actorOf(session), { decision, idempotencyKey });
      return { status: 200, body: co };
    } catch (err) { return errorBody(err); }
  }

  return { listChangeOrders, proposeChangeOrder, getChangeOrder, decideChangeOrder };
}
