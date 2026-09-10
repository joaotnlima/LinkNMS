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
 * @param {import('./plan-version.mjs').createPlanVersionService} [deps.planVersion]
 * @param {import('./materials.mjs').createMaterialsService} [deps.materials]
 */
export function createScheduleHttp({ service, planImport = null, planVersion = null, materials = null }) {
  if (!service) throw new Error('createScheduleHttp requires { service }');

  // GET /projects/:projectId/plan — the plan-baseline D11–D13 view (B2 contract
  // §5 route 1): { baseline, current, history }. Both parties read.
  async function getPlan({ session, params }) {
    try {
      const view = planVersion
        ? await planVersion.getPlan(params.projectId, actorOf(session))
        : await service.getPlan(params.projectId, actorOf(session));
      return { status: 200, body: view };
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

  // POST /projects/:projectId/plan-versions:confirm — the single write txn
  async function confirmPlanImport({ session, params, file }) {
    try {
      const out = await planImport.confirm(params.projectId, actorOf(session), file ?? {});
      return { status: 201, body: out };
    } catch (err) { return errorBody(err); }
  }

  // ── Slice B2 plan baseline (LINA-200) — D11–D13 lifecycle ────────────────────

  // POST …/plan-versions/:versionId:withdraw — proposer only; terminal
  async function withdrawPlan({ session, params }) {
    try {
      const out = await planVersion.withdraw(params.versionId, actorOf(session));
      return { status: 200, body: out };
    } catch (err) { return errorBody(err); }
  }

  // POST …/plan-versions/:versionId:accept — reviewer; idempotent-by-state; the
  // second stamp freezes → baseline.
  async function acceptPlan({ session, params }) {
    try {
      const out = await planVersion.accept(params.versionId, actorOf(session));
      return { status: 200, body: out };
    } catch (err) { return errorBody(err); }
  }

  // POST …/plan-versions/:versionId:reject — reviewer; terminal
  async function rejectPlan({ session, params, body }) {
    try {
      const out = await planVersion.reject(params.versionId, actorOf(session), body ?? {});
      return { status: 200, body: out };
    } catch (err) { return errorBody(err); }
  }

  // POST …/plan-versions/:versionId:request-changes — reviewer forks a new version
  async function requestChangesPlan({ session, params, body }) {
    try {
      const out = await planVersion.requestChanges(params.versionId, actorOf(session), body ?? {});
      return { status: 201, body: out };
    } catch (err) { return errorBody(err); }
  }

  // POST …/plan-versions/:versionId:propose — drafter sends their draft for
  // approval (LINA-230). draft → proposed; the first moment the other party sees
  // it. No body; the acting party is the session.
  async function proposePlan({ session, params }) {
    try {
      const out = await planVersion.proposePlan(params.versionId, actorOf(session));
      return { status: 200, body: out };
    } catch (err) { return errorBody(err); }
  }

  // POST /projects/:projectId/plan-versions:author — direct plan authoring, the
  // "build it here" route (LINA-228, ADR-0017). Either party; JSON body { stages }.
  async function authorPlan({ session, params, body }) {
    try {
      const out = await planVersion.authorPlan(params.projectId, actorOf(session), body ?? {});
      return { status: 201, body: out };
    } catch (err) { return errorBody(err); }
  }

  // ── Slice B3 materials & budget movement (LINA-217) — D14–D16 ───────────────

  // GET /projects/:projectId/record (D14) — the 4-tab live record projection
  async function getRecord({ session, params }) {
    try {
      const view = materials
        ? await materials.getRecord(params.projectId, actorOf(session))
        : await service.getPlan(params.projectId, actorOf(session));
      return { status: 200, body: view };
    } catch (err) { return errorBody(err); }
  }

  // GET /stages/:stageId/materials (D15) — the materials + movements behind a line
  async function getStageMaterials({ session, params }) {
    try {
      const out = await materials.getLineMaterials(params.stageId, actorOf(session));
      return { status: 200, body: out };
    } catch (err) { return errorBody(err); }
  }

  // POST /stages/:stageId/materials (D15) — author materials (proposed, proposer only)
  async function authorMaterials({ session, params, body }) {
    try {
      const out = await materials.authorMaterials(params.stageId, actorOf(session), body ?? {});
      return { status: 201, body: out };
    } catch (err) { return errorBody(err); }
  }

  // POST /stages/:stageId/materials:swap (D15/D16) — record a post-baseline movement
  async function swapMaterial({ session, params, body }) {
    try {
      const out = await materials.swapMaterial(params.stageId, actorOf(session), body ?? {});
      return { status: 201, body: out };
    } catch (err) { return errorBody(err); }
  }

  // GET /projects/:projectId/budget-movement (D16) — MoneyView (scope vs price)
  async function getBudgetMovement({ session, params }) {
    try {
      const out = await materials.getBudgetMovement(params.projectId, actorOf(session));
      return { status: 200, body: out };
    } catch (err) { return errorBody(err); }
  }

  return { getPlan, addStage, getStage, updateStage, reportProgress,
    inspectPlanImport, columnsPlanImport, previewPlanImport, confirmPlanImport,
    withdrawPlan, acceptPlan, rejectPlan, requestChangesPlan, authorPlan, proposePlan,
    getRecord, getStageMaterials, authorMaterials, swapMaterial, getBudgetMovement };
}
