// Project phase lifecycle — auto-creation, listing, and execution sign-off
// (LINA-278; ADR-0023 §3, §8, §10). A phase is a lightweight sequencing layer on
// the project record: `procurement` (seq 0) and `execution` (seq 1) are seeded at
// project creation and lazily on first read for legacy projects.
//
// THE audit invariant this service owns: the `signed_off` transition is ONE-WAY
// (mirrored in the DB trigger, migration 0012). Once the owner signs off the
// execution plan it is locked, and every later edit must route through the
// change-order ledger (ADR-0014). `assertPlanEditable` is the guard the plan
// mutation handlers call before writing; it is the single point where writes flip
// from the freely-editable surface to the change-order surface.
//
// AUTHORIZATION (ADR-0004 — Identity is the sole authorizer). Both parties READ
// phases (like getPlan). Requesting sign-off requires membership. Approving a
// request — the act of signing off — may NOT be done by the party who requested
// it: a plan is signed off BY THE OTHER PARTY, never self-approved. Finer role
// rules (GC-requests / owner-approves) land when PRD Q1 is answered; the
// self-approval bar is the integrity floor that holds regardless.
import { randomUUID } from 'node:crypto';
import { DomainError } from './ports.mjs';

const now = () => new Date().toISOString();

// The two phases every build gets. `procurement` runs the RFP loop; `execution`
// carries the plan grid and is the phase that gets signed off.
const PHASE_DEFAULTS = Object.freeze([
  { kind: 'procurement', sequence: 0, name: 'Procurement' },
  { kind: 'execution', sequence: 1, name: 'Execution' },
]);

export function createPhaseService({ store, identity }) {
  if (!store || !identity) {
    throw new Error('createPhaseService requires { store, identity } ports');
  }

  // Store rows are snake_case; the contract (and the FE) sees camelCase — the
  // same convention getPlan/getStage/task-workspace use.
  const phaseView = (p) => ({
    id: p.id,
    projectId: p.project_id,
    kind: p.kind,
    name: p.name,
    status: p.status,
    sequence: p.sequence,
    responsiblePartyIds: p.responsible_party_ids ?? [],
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  });

  const signOffView = (s) => ({
    id: s.id,
    phaseId: s.phase_id,
    requestedBy: s.requested_by,
    requestedAt: s.requested_at,
    status: s.status,
    resolvedAt: s.resolved_at ?? null,
    resolutionComment: s.resolution_comment ?? null,
  });

  // Seed the two default phases inside one transaction, idempotently. Which phase
  // starts `active` is the seed-time decision (ADR-0023 §3):
  //   - hasSignedContractor=false → procurement active (run an RFP first),
  //     execution pending;
  //   - hasSignedContractor=true  → procurement pending (skipped),
  //     execution active.
  // A concurrent seed or a re-run is a safe no-op: the (project_id, kind) unique
  // (23505) is swallowed so lazy-init and seed-at-create can race harmlessly.
  async function ensurePhases(projectId, { hasSignedContractor = false } = {}) {
    return store.transaction(async (tx) => {
      if ((await store.countPhasesByProject(projectId)) > 0) {
        return (await store.listPhasesByProject(projectId)).map(phaseView);
      }
      const seededAt = now();
      for (const d of PHASE_DEFAULTS) {
        const status = d.kind === 'procurement'
          ? (hasSignedContractor ? 'pending' : 'active')
          : (hasSignedContractor ? 'active' : 'pending');
        // Idempotent: insertPhase returns null (never throws) when a phase of this
        // kind already exists, so a concurrent seed does not poison the tx.
        await store.insertPhase(tx, {
          id: randomUUID(),
          project_id: projectId,
          kind: d.kind,
          name: d.name,
          status,
          sequence: d.sequence,
          responsible_party_ids: [],
          created_at: seededAt,
          updated_at: seededAt,
        });
      }
      return (await store.listPhasesByProject(projectId)).map(phaseView);
    });
  }

  // GET /projects/:id/phases — both parties read. Lazy-init for legacy projects
  // (default: no signed contractor → procurement active — the safest assumption,
  // ADR-0023 §3 Option B). Each phase carries its sign-off request history so the
  // FE renders the accordion badge without a second round-trip.
  async function listPhases(projectId, actorPartyId) {
    await identity.requireMember(actorPartyId, projectId);
    let rows = await store.listPhasesByProject(projectId);
    if (rows.length === 0) {
      await ensurePhases(projectId, { hasSignedContractor: false });
      rows = await store.listPhasesByProject(projectId);
    }
    const phases = await Promise.all(rows.map(async (p) => ({
      ...phaseView(p),
      signOffRequests: (await store.listSignOffRequestsByPhase(p.id)).map(signOffView),
    })));
    return { phases };
  }

  // Resolve a phase that must exist and belong to the project — 404 otherwise.
  // (404, not 403, once membership is proven: the resource does not exist for a
  // member, the same posture task-workspace uses for a stale stage key.)
  async function requirePhase(projectId, phaseId) {
    const phase = await store.getPhaseById(phaseId);
    if (!phase || phase.project_id !== projectId) {
      throw new DomainError(404, 'not_found', 'no such phase on this project');
    }
    return phase;
  }

  // POST /projects/:id/phases/:phaseId/sign-off — open a sign-off request.
  // Valid only when the phase is `active` and the plan has ≥1 task (ADR-0023:
  // you cannot sign off an empty plan). One pending request per phase (the
  // partial unique index → typed 409, never a raw pg error).
  async function requestSignOff(projectId, phaseId, actorPartyId) {
    await identity.requireMember(actorPartyId, projectId);
    const phase = await requirePhase(projectId, phaseId);

    if (phase.status !== 'active') {
      throw new DomainError(409, 'phase_not_active',
        `sign-off can only be requested for an active phase (this phase is ${phase.status})`);
    }
    const taskCount = (await store.listStages(projectId)).length;
    if (taskCount < 1) {
      throw new DomainError(409, 'no_plan_tasks',
        'sign-off requires at least one plan task');
    }

    let created;
    try {
      created = await store.transaction(async (tx) => store.insertSignOffRequest(tx, {
        id: randomUUID(),
        phase_id: phaseId,
        requested_by: actorPartyId,
        requested_at: now(),
        status: 'pending',
        resolved_at: null,
        resolution_comment: null,
      }));
    } catch (e) {
      if (e?.code === '23505') {
        throw new DomainError(409, 'sign_off_already_pending',
          'a sign-off request is already pending for this phase');
      }
      throw e;
    }
    return { signOffRequest: signOffView(created) };
  }

  // POST …/sign-off/:requestId/approve — sign the plan off. Resolves the request
  // and flips the phase to `signed_off` in ONE transaction: the decision and the
  // lock commit together. The requester may not approve their own request
  // (integrity floor). One-way: the DB trigger + in-memory guard forbid ever
  // reopening a signed_off phase.
  async function approveSignOff(projectId, phaseId, requestId, actorPartyId, input = {}) {
    await identity.requireMember(actorPartyId, projectId);
    await requirePhase(projectId, phaseId);
    const req = await store.getSignOffRequest(requestId);
    if (!req || req.phase_id !== phaseId) {
      throw new DomainError(404, 'not_found', 'no such sign-off request on this phase');
    }
    if (req.status !== 'pending') {
      throw new DomainError(409, 'sign_off_already_resolved',
        `this request is already ${req.status}`);
    }
    if (req.requested_by === actorPartyId) {
      throw new DomainError(403, 'cannot_self_approve',
        'a sign-off request cannot be approved by the party who requested it');
    }

    const comment = typeof input?.comment === 'string' ? input.comment.trim() || null : null;
    const resolved = await store.transaction(async (tx) => {
      const r = await store.resolveSignOffRequest(tx, requestId,
        { status: 'approved', resolvedAt: now(), resolutionComment: comment });
      await store.updatePhaseStatus(tx, phaseId, 'signed_off');
      return r;
    });
    const phase = await store.getPhaseById(phaseId);
    return { signOffRequest: signOffView(resolved), phase: phaseView(phase) };
  }

  // POST …/sign-off/:requestId/reject — decline the request. The phase stays
  // `active` (still editable); the resolution_comment is returned to the
  // requester. Rejecting frees the pending slot so a fresh request can follow.
  async function rejectSignOff(projectId, phaseId, requestId, actorPartyId, input = {}) {
    await identity.requireMember(actorPartyId, projectId);
    await requirePhase(projectId, phaseId);
    const req = await store.getSignOffRequest(requestId);
    if (!req || req.phase_id !== phaseId) {
      throw new DomainError(404, 'not_found', 'no such sign-off request on this phase');
    }
    if (req.status !== 'pending') {
      throw new DomainError(409, 'sign_off_already_resolved',
        `this request is already ${req.status}`);
    }

    const comment = typeof input?.comment === 'string' ? input.comment.trim() || null : null;
    const resolved = await store.transaction(async (tx) => store.resolveSignOffRequest(
      tx, requestId, { status: 'rejected', resolvedAt: now(), resolutionComment: comment }));
    return { signOffRequest: signOffView(resolved) };
  }

  // The change-order guard (ADR-0023 §8). Plan mutation handlers call this before
  // writing: once the execution phase is signed_off the plan is immutable and the
  // edit must be raised as a change order (ADR-0014). Safe to call for a project
  // with no phases yet (lazy-init has not run) — an absent execution phase is
  // treated as unlocked.
  async function assertPlanEditable(projectId) {
    const exec = await store.getPhaseByKind(projectId, 'execution');
    if (exec?.status === 'signed_off') {
      throw new DomainError(409, 'plan_locked',
        'the execution plan is signed off — changes must be raised as a change order (ADR-0014)');
    }
    // Returned so the mutation handler can reuse it for the pre-sign-off audit
    // (LINA-297) without a second read — the guard already resolved it.
    return exec;
  }

  // The pre-sign-off audit sink (LINA-297; ADR-0023 §8). A plan mutation handler
  // passes the execution `phase` it just guard-checked and the field-level diff
  // it is about to write, inside its OWN transaction — the audit row lands iff
  // the mutation does. Rows are written ONLY while the execution phase is
  // `active`: an absent phase (legacy project, lazy-init not run) or a `pending`
  // execution phase (procurement still running, plan not yet under execution)
  // logs nothing; a `signed_off` phase never reaches here (the guard 409s first).
  // Writes therefore STOP exactly at sign-off — from there the change-order
  // ledger (ADR-0014) is the sole record, and the two surfaces never overlap.
  //
  // `changes` is a list of { entityType, entityId, fieldName, oldValue, newValue }.
  // `actorPartyId` is stamped on every row (NULL would mean a system change).
  async function recordPlanChanges(tx, phase, changes, actorPartyId) {
    if (!phase || phase.status !== 'active' || !changes?.length) return;
    for (const c of changes) {
      await store.insertPlanChangeLog(tx, {
        id: randomUUID(),
        phase_id: phase.id,
        entity_type: c.entityType,
        entity_id: c.entityId,
        field_name: c.fieldName,
        old_value: c.oldValue ?? null,
        new_value: c.newValue ?? null,
        actor_party_id: actorPartyId ?? null,
        occurred_at: now(),
      });
    }
  }

  return {
    ensurePhases,
    listPhases,
    requestSignOff,
    approveSignOff,
    rejectSignOff,
    assertPlanEditable,
    recordPlanChanges,
  };
}
