// Schedule & Progress — HTTP route handlers for the plan/progress endpoints
// (LINA-69; ADR-0004). Framework-agnostic: each handler takes a small request
// context `{ session, params, body }` and returns `{ status, body }`. The Next
// gateway (app/src/server/gateway.ts) adapts its runtime request to this shape.
//
// THE security property (ADR-0004): the acting party is ALWAYS derived from the
// authenticated session (`session.partyId`) and NEVER from the request body or
// query — a forged `reportedBy` in a body is inert. Authorization (GC-only writes,
// homeowner read-only) is the service's / Identity's job; this layer only wires
// session→actor and maps typed errors to the uniform envelope.
//
// EVERY denial here is an authorization denial, not a 500 (LINA-56 finding, spec
// §8.2): a homeowner attempting a write arrives as a typed 403 and is rendered as
// one. The error mapper below matches BOTH this service's DomainError and the
// structural {status,code} shape of an IdentityError, so a denial from the sole
// authorizer maps correctly and can never silently regress to a 500.
import { DomainError } from './ports.mjs';

function errorBody(err) {
  if (err instanceof DomainError
      || (err && typeof err.status === 'number' && typeof err.code === 'string')) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.details !== undefined) body.error.details = err.details;
    return { status: err.status, body };
  }
  // An unmapped throw is a bug or an infrastructure failure (a missing GRANT, a
  // dropped connection), never a client mistake. Nothing leaks to the client; the
  // real error goes to the server log so a 500 is diagnosable.
  console.error('[schedule] unhandled service error', err);
  return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } };
}

const actorOf = (session) => session?.partyId ?? null;

/**
 * @param {Object} deps
 * @param {ReturnType<import('./schedule.mjs').createScheduleService>} deps.service
 * @param {import('./plan-import.mjs').createPlanImportService} [deps.planImport]
 */
export function createScheduleHttp({ service, planImport = null }) {
  if (!service) throw new Error('createScheduleHttp requires { service }');

  // GET /projects/:projectId/plan — the timeline + rollup (FR-P4, FR-P6, §8.3)
  async function getPlan({ session, params }) {
    try {
      const plan = await service.getPlan(params.projectId, actorOf(session));
      return { status: 200, body: plan };
    } catch (err) { return errorBody(err); }
  }

  // POST /projects/:projectId/stages — add a stage (FR-P1, GC-only)
  async function addStage({ session, params, body }) {
    try {
      const stage = await service.addStage(params.projectId, actorOf(session), body ?? {});
      return { status: 201, body: stage };
    } catch (err) { return errorBody(err); }
  }

  // GET /stages/:stageId — one stage + its full attributed history (FR-P3, AC-P3)
  async function getStage({ session, params }) {
    try {
      const stage = await service.viewStage(params.stageId, actorOf(session));
      return { status: 200, body: stage };
    } catch (err) { return errorBody(err); }
  }

  // PATCH /stages/:stageId — edit / reorder a stage (FR-P1, GC-only)
  async function updateStage({ session, params, body }) {
    try {
      const stage = await service.updateStage(params.stageId, actorOf(session), body ?? {});
      return { status: 200, body: stage };
    } catch (err) { return errorBody(err); }
  }

  // POST /stages/:stageId/progress — append a progress report (FR-P3, GC-only)
  async function reportProgress({ session, params, body }) {
    try {
      const stage = await service.reportProgress(params.stageId, actorOf(session), body ?? {});
      return { status: 201, body: stage };
    } catch (err) { return errorBody(err); }
  }

  // ── Slice B1 plan import (LINA-199) — GC-only, no writes until confirm ──────

  // POST /projects/:projectId/plan-imports:inspect
  async function inspectPlanImport({ session, params, file }) {
    try {
      const out = await planImport.inspect(params.projectId, actorOf(session), file ?? {});
      return { status: 200, body: out };
    } catch (err) { return errorBody(err); }
  }

  // POST /projects/:projectId/plan-imports:columns
  async function columnsPlanImport({ session, params, file }) {
    try {
      const out = await planImport.columns(params.projectId, actorOf(session), file ?? {});
      return { status: 200, body: out };
    } catch (err) { return errorBody(err); }
  }

  // POST /projects/:projectId/plan-imports:preview
  async function previewPlanImport({ session, params, file }) {
    try {
      const out = await planImport.preview(params.projectId, actorOf(session), file ?? {});
      return { status: 200, body: out };
    } catch (err) { return errorBody(err); }
  }

  // POST /projects/:projectId/plan-imports:confirm — the single write txn
  async function confirmPlanImport({ session, params, file }) {
    try {
      const out = await planImport.confirm(params.projectId, actorOf(session), file ?? {});
      return { status: 201, body: out };
    } catch (err) { return errorBody(err); }
  }

  return { getPlan, addStage, getStage, updateStage, reportProgress,
    inspectPlanImport, columnsPlanImport, previewPlanImport, confirmPlanImport };
}
