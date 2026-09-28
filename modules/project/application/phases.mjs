// Project phase lifecycle + execution sign-off on /api/v2 (LINA-356; ADR-0024).
// Ported from the v1 createPhaseService (services/schedule/phases.mjs), re-homed
// in the project module and adapted to the v2 org-centric identity space.
//
// THE audit invariant this surface owns: the `signed_off` transition is ONE-WAY
// (mirrored in the DB trigger, db/v2/0008). Once the execution plan is signed
// off it is locked, and every later structural edit routes through the change-
// order ledger (ADR-0014). `assertPlanEditable` (in the planning store) is the
// guard the plan-mutation handlers call before writing — the single point where
// writes flip from the freely-editable surface to the change-order surface.
//
// AUTHORIZATION (doc 16, org-centric). Both parties on a project READ phases
// (like getSchedule). Requesting sign-off requires project participation.
// Approving a request — the act of signing off — may NOT be done by the person
// who requested it: a plan is signed off BY THE OTHER SIDE, never self-approved
// (`two_sided_rule`, the integrity floor). Finer role rules land when PRD Q1 is
// answered; the self-approval bar holds regardless.
//
// V1 → V2 ERROR VOCABULARY. v2 has a fixed problem+json vocabulary
// (platform/errors.mjs); a handler names a code, the code carries the status.
// The v1 domain codes map to it, preserving the machine-readable sub-case in the
// `reason` extension member (ADR-0024 §Errors):
//   phase_not_active / no_plan_tasks / sign_off_already_pending /
//   sign_off_already_resolved / plan_locked → invalid_transition (409)
//   cannot_self_approve                     → two_sided_rule (403)
import { randomUUID } from 'node:crypto';

import { ProblemError } from '../../../platform/errors.mjs';
import { requireParticipant, requireActor } from './use-cases.mjs';

// The two phases every build gets. `procurement` runs the RFP loop; `execution`
// carries the plan grid and is the phase that gets signed off.
const PHASE_DEFAULTS = Object.freeze([
  { kind: 'procurement', sequence: 0, name: 'Procurement' },
  { kind: 'execution', sequence: 1, name: 'Execution' },
]);

// Store rows are snake_case; the v2 contract is snake_case too (unlike v1's
// camelCase view) — so the body is a straight pass-through of the columns the
// contract exposes.
function phaseBody(p) {
  return {
    id: p.id,
    project_id: p.project_id,
    kind: p.kind,
    name: p.name,
    status: p.status,
    sequence: p.sequence,
    responsible_party_ids: p.responsible_party_ids ?? [],
    created_at: iso(p.created_at),
    updated_at: iso(p.updated_at),
  };
}

function signOffBody(s) {
  return {
    id: s.id,
    phase_id: s.phase_id,
    requested_by: s.requested_by,
    requested_at: iso(s.requested_at),
    status: s.status,
    resolved_at: s.resolved_at ? iso(s.resolved_at) : null,
    resolution_comment: s.resolution_comment ?? null,
  };
}

function iso(v) {
  return v == null ? v : (v.toISOString?.() ?? v);
}

// Resolve a phase that must exist and belong to the project — 404 otherwise.
// (404, not 403, once participation is proven: the resource does not exist for a
// participant, the posture requireParticipant uses for an absent project.)
async function requirePhase(store, projectId, phaseId) {
  const phase = await store.getPhaseById(phaseId);
  if (!phase || phase.project_id !== projectId) {
    throw new ProblemError('not_found', 'no such phase on this project');
  }
  return phase;
}

/** operationId: listPhases — both participants read; lazy-seed on first read. */
export async function listPhases({ viewer, store, projectId }) {
  await requireParticipant({ viewer, store, projectId });
  let rows = await store.listPhasesByProject(projectId);
  if (rows.length === 0) {
    // Legacy/unseeded project: lazy-init the two default phases. Default
    // hasSignedContractor=false → procurement active (run an RFP first) — the
    // safest assumption (ADR-0023 §3 Option B, carried to ADR-0024).
    await store.ensurePhases(projectId, PHASE_DEFAULTS, { hasSignedContractor: false });
    rows = await store.listPhasesByProject(projectId);
  }
  // Each phase carries its sign-off request history so the accordion renders in
  // one round-trip.
  const phases = await Promise.all(rows.map(async (p) => ({
    ...phaseBody(p),
    sign_off_requests: (await store.listSignOffRequestsByPhase(p.id)).map(signOffBody),
  })));
  return { status: 200, body: { phases } };
}

/**
 * operationId: requestSignOff — open a sign-off request. Valid only when the
 * phase is `active` and the plan has ≥1 task (you cannot sign off an empty
 * plan). One pending request per phase (the partial unique index → typed 409).
 */
export async function requestSignOff({ viewer, store, projectId, phaseId }) {
  await requireParticipant({ viewer, store, projectId });
  const actor = await requireActor(store, viewer);
  const phase = await requirePhase(store, projectId, phaseId);

  if (phase.status !== 'active') {
    throw new ProblemError('invalid_transition',
      `sign-off can only be requested for an active phase (this phase is ${phase.status})`,
      { reason: 'phase_not_active' });
  }
  if ((await store.countPlanTasks(projectId)) < 1) {
    throw new ProblemError('invalid_transition', 'sign-off requires at least one plan task',
      { reason: 'no_plan_tasks' });
  }

  let created;
  try {
    created = await store.insertSignOffRequest({
      id: randomUUID(),
      phaseId,
      requestedBy: actor.id,
    });
  } catch (e) {
    if (e?.code === '23505') {
      throw new ProblemError('invalid_transition',
        'a sign-off request is already pending for this phase',
        { reason: 'sign_off_already_pending' });
    }
    throw e;
  }
  return { status: 201, body: { sign_off_request: signOffBody(created) } };
}

/**
 * operationId: approveSignOff — sign the plan off. Resolves the request AND
 * flips the phase to `signed_off` in ONE transaction: the decision and the lock
 * commit together (the audit invariant). The requester may not approve their own
 * request (`two_sided_rule`, the integrity floor). One-way: the DB trigger
 * forbids ever reopening a signed_off phase.
 */
export async function approveSignOff({ viewer, store, projectId, phaseId, requestId, body }) {
  await requireParticipant({ viewer, store, projectId });
  const actor = await requireActor(store, viewer);
  await requirePhase(store, projectId, phaseId);
  const req = await store.getSignOffRequest(requestId);
  if (!req || req.phase_id !== phaseId) {
    throw new ProblemError('not_found', 'no such sign-off request on this phase');
  }
  if (req.status !== 'pending') {
    throw new ProblemError('invalid_transition', `this request is already ${req.status}`,
      { reason: 'sign_off_already_resolved' });
  }
  if (req.requested_by === actor.id) {
    throw new ProblemError('two_sided_rule',
      'a sign-off request cannot be approved by the person who requested it',
      { reason: 'cannot_self_approve' });
  }

  const comment = typeof body?.comment === 'string' ? (body.comment.trim() || null) : null;
  const { request: resolved, phase } = await store.approveSignOff({ requestId, phaseId, comment });
  return { status: 200, body: { sign_off_request: signOffBody(resolved), phase: phaseBody(phase) } };
}

/**
 * operationId: rejectSignOff — decline the request. The phase stays `active`
 * (still editable); rejecting frees the pending slot so a fresh request can
 * follow.
 */
export async function rejectSignOff({ viewer, store, projectId, phaseId, requestId, body }) {
  await requireParticipant({ viewer, store, projectId });
  await requireActor(store, viewer);
  await requirePhase(store, projectId, phaseId);
  const req = await store.getSignOffRequest(requestId);
  if (!req || req.phase_id !== phaseId) {
    throw new ProblemError('not_found', 'no such sign-off request on this phase');
  }
  if (req.status !== 'pending') {
    throw new ProblemError('invalid_transition', `this request is already ${req.status}`,
      { reason: 'sign_off_already_resolved' });
  }

  const comment = typeof body?.comment === 'string' ? (body.comment.trim() || null) : null;
  const resolved = await store.rejectSignOff({ requestId, comment });
  return { status: 200, body: { sign_off_request: signOffBody(resolved) } };
}
