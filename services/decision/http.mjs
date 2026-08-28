// Decision Log — HTTP route handlers for the three openapi.yaml endpoints
// (list / record / revise), LINA-56 / ADR-0004.
//
// Framework-agnostic, exactly like services/change_order/http.mjs: each handler
// takes `{ session, params, body }` and returns `{ status, body }`. A thin gateway
// (a Next.js route handler, a test) adapts its runtime request to that shape.
// Keeping the mapping here means the security property below is proven by this
// service's own tests, independent of any web framework.
//
// THE security property (ADR-0004): the acting party is ALWAYS `session.partyId`
// and NEVER read from the request body or query. `record`/`revise` pass only the
// domain fields (title, body) to the service, which reads no actor or timestamp
// field from its input — so a forged `createdByPartyId` / `at` in a body is inert.
// Author and timestamp are server-authoritative on every revision (FR2).
import { DecisionError } from './decision-log.mjs';

// Uniform error envelope shared across the platform (design §6; the frontend
// reads `body.error.message`). A non-DecisionError never leaks its detail.
function errorBody(err) {
  if (err instanceof DecisionError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  // Identity raises IdentityError with the same {code,status} shape; accept any
  // typed error that carries both rather than flattening it to a 500.
  if (err && typeof err.status === 'number' && typeof err.code === 'string') {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  // An unmapped throw is a bug or an infrastructure failure (a missing GRANT, a
  // dropped connection), never a client mistake. The response deliberately says
  // nothing — but a 500 that leaves no trace anywhere is undiagnosable in
  // production, so the real error goes to the server log.
  console.error('[decision] unhandled service error', err);
  return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } };
}

const actorOf = (session) => session?.partyId ?? null;

// Only the two content fields cross the boundary. Anything else in the body —
// including an actor or a timestamp — is dropped here, not merely ignored later.
const contentOf = (body) => ({ title: body?.title, body: body?.body });

/**
 * @param {Object} deps
 * @param {ReturnType<import('./decision-log.mjs').createDecisionLog>} deps.service
 */
export function createDecisionHttp({ service }) {
  if (!service) throw new Error('createDecisionHttp requires { service }');

  // GET /projects/:projectId/decisions — FR7
  async function listDecisions({ session, params }) {
    try {
      const decisions = await service.list(params.projectId, actorOf(session));
      return { status: 200, body: { decisions } };
    } catch (err) { return errorBody(err); }
  }

  // POST /projects/:projectId/decisions — FR2, revision 1
  async function recordDecision({ session, params, body }) {
    try {
      const decision = await service.record(params.projectId, actorOf(session), contentOf(body));
      return { status: 201, body: decision };
    } catch (err) { return errorBody(err); }
  }

  // PATCH /decisions/:decisionId — FR2, appends revision max+1
  async function reviseDecision({ session, params, body }) {
    try {
      const decision = await service.revise(params.decisionId, actorOf(session), contentOf(body));
      return { status: 200, body: decision };
    } catch (err) { return errorBody(err); }
  }

  return { listDecisions, recordDecision, reviseDecision };
}
