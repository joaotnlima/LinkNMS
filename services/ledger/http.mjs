// Ledger & Budget — HTTP route handlers for the two read paths the UI needs:
// the full audit trail + chain-verify result (FR9) and the four-pillar status
// (design §5). LINA-56 / ADR-0004.
//
// Framework-agnostic, same shape as the sibling services: `{ session, params,
// headers }` in, `{ status, body, headers }` out.
//
// Both are member-only reads, and the membership check is Identity's — the
// ledger service itself holds no permission model (ADR-0004: one authorizer).
// The audit path forwards `If-None-Match` to the ledger's ETag cache, so an
// unchanged chain is a 304 rather than a full re-verify (ADR-0006 §3); the
// authorization check still runs first, so a 304 can never be used to probe a
// project you are not a member of.
import { IdentityError } from '../identity/errors.mjs';

function errorBody(err) {
  if (err instanceof IdentityError || (err && typeof err.status === 'number' && typeof err.code === 'string')) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  // An unmapped throw is a bug or an infrastructure failure (a missing GRANT, a
  // dropped connection), never a client mistake. The response deliberately says
  // nothing — but a 500 that leaves no trace anywhere is undiagnosable in
  // production, so the real error goes to the server log.
  console.error('[ledger] unhandled service error', err);
  return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } };
}

const actorOf = (session) => session?.partyId ?? null;

/**
 * @param {Object} deps
 * @param {ReturnType<import('./pg-ledger.mjs').createPgLedger>} deps.ledger
 * @param {{ requireMember(partyId, projectId): Promise<any> }} deps.identity
 */
export function createLedgerHttp({ ledger, identity }) {
  if (!ledger) throw new Error('createLedgerHttp requires { ledger }');
  if (!identity) throw new Error('createLedgerHttp requires { identity } for authorization');

  // GET /projects/:projectId/audit — FR9. Events in seq order + the chain-verify
  // result, so "is this record intact?" is answerable from the UI.
  async function getAudit({ session, params, headers }) {
    try {
      await identity.requireMember(actorOf(session), params.projectId);
      const ifNoneMatch = headers?.['if-none-match'] ?? headers?.get?.('if-none-match') ?? undefined;
      const result = await ledger.getAudit(params.projectId, { ifNoneMatch });
      if (result.status === 304) {
        return { status: 304, body: null, headers: { etag: result.etag } };
      }
      return {
        status: 200,
        headers: { etag: result.etag },
        body: {
          events: result.events,
          // design §6: `verified` is `true` or the first broken seq.
          verified: result.verify?.verified === true ? true : result.verify?.firstBrokenSeq,
          headHash: result.etag.replaceAll('"', ''),
        },
      };
    } catch (err) { return errorBody(err); }
  }

  // GET /projects/:projectId/status — the four-pillar panel (design §5, FR9).
  // Derived entirely ledger-side; the frontend never recomputes it.
  async function getStatus({ session, params }) {
    try {
      await identity.requireMember(actorOf(session), params.projectId);
      const status = await ledger.status(params.projectId);
      if (!status) {
        return { status: 404, body: { error: { code: 'not_found', message: 'project not found in the ledger' } } };
      }
      return { status: 200, body: status };
    } catch (err) { return errorBody(err); }
  }

  return { getAudit, getStatus };
}
