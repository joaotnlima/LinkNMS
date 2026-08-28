// Identity & Membership — HTTP route handlers for the four openapi.yaml
// endpoints (create project / get project / invite / accept), LINA-56 / ADR-0004.
//
// Framework-agnostic, same shape as services/change_order/http.mjs and
// services/decision/http.mjs: `{ session, params, body }` in, `{ status, body }`
// out, plus an optional `headers` for the one response that needs them. Making
// FR1 reachable is the point of this module — without it a user cannot create a
// project or invite the GC at all, and nothing downstream is demonstrable.
//
// THE security property (ADR-0004): the acting party is ALWAYS `session.partyId`.
// `createProject` takes only name + baseline from the body; `ownerPartyId` is the
// session's, so a body claiming to create a project owned by someone else is
// inert. `acceptInvitation` takes the token from the PATH and the joining party
// from the SESSION — the token proves the invitation, the session says who joins.
//
// The raw invitation token is returned exactly once, in the 201 body of
// inviteCounterparty. It is never persisted (only its SHA-256 is) and must never
// be logged — hence `cache-control: no-store` on that response.
import { IdentityError } from './errors.mjs';

function errorBody(err) {
  if (err instanceof IdentityError || (err && typeof err.status === 'number' && typeof err.code === 'string')) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } };
}

const actorOf = (session) => session?.partyId ?? null;

/**
 * @param {Object} deps
 * @param {ReturnType<import('./identity.mjs').createIdentityService>} deps.service
 */
export function createIdentityHttp({ service }) {
  if (!service) throw new Error('createIdentityHttp requires { service }');

  // POST /projects — FR1, first half: a shared record with a baseline budget.
  async function createProject({ session, body }) {
    try {
      const project = await service.createProject({
        actorPartyId: actorOf(session),
        name: body?.name,
        baselineBudgetCents: body?.baselineBudgetCents,
      });
      return { status: 201, body: project };
    } catch (err) { return errorBody(err); }
  }

  // GET /projects/:id — members only; carries the ledger-derived budget summary.
  async function getProject({ session, params }) {
    try {
      const project = await service.getProject({
        actorPartyId: actorOf(session),
        projectId: params.id,
      });
      return { status: 200, body: project };
    } catch (err) { return errorBody(err); }
  }

  // POST /projects/:id/invitations — FR1, second half: invite the one GC.
  // Owner-only. The 201 body carries the raw token ONCE; it is not stored.
  async function inviteCounterparty({ session, params, body }) {
    try {
      const result = await service.inviteCounterparty({
        actorPartyId: actorOf(session),
        projectId: params.id,
        role: body?.role ?? 'counterparty',
      });
      return {
        status: 201,
        body: result,
        // The single-use token must never land in a shared or browser cache.
        headers: { 'cache-control': 'no-store' },
      };
    } catch (err) { return errorBody(err); }
  }

  // POST /invitations/:token/accept — the invited GC joins as counterparty.
  async function acceptInvitation({ session, params }) {
    try {
      const result = await service.acceptInvitation({
        actorPartyId: actorOf(session),
        token: params.token,
      });
      return { status: 200, body: result, headers: { 'cache-control': 'no-store' } };
    } catch (err) { return errorBody(err); }
  }

  return { createProject, getProject, inviteCounterparty, acceptInvitation };
}
