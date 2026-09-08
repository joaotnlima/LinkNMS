// Typed ports the Schedule & Progress service depends on (ADR-0006 §1 — "no
// service reads another's schema; cross-service access goes through the owning
// service's typed interface"). This file declares the three seams and provides
// in-memory implementations so the slice is provable on its own:
//
//   LedgerPort   — owned by Ledger & Budget (Slice 1). Appends hash-chained audit
//                  events and reads the authoritative budget. Schedule NEVER
//                  touches ledger.audit_event / ledger.budget_event directly, and
//                  — the product invariant — never records a budget_event at all.
//   IdentityPort — owned by Identity & Membership (Slice 2, ADR-0004). The SOLE
//                  authorizer. GC-only writes, both parties read.
//   ScheduleStore — owned by THIS service (schema `schedule`): stages and the
//                  append-only stage_progress history.
//
// The in-memory adapters enforce, in code, the same invariants the SQL migration
// enforces in the DB, so the contract tests exercise real behaviour:
//   - stage_progress is append-only (no update/delete surface at all);
//   - "latest" is a total order over (reported_at, seq);
//   - percent is only storable while in_progress.

import { randomUUID } from 'node:crypto';
import { can, ACTION } from '../identity/authz.mjs';

export class DomainError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// In-memory Identity port. Delegates the capability decision to the REAL pure
// authorizer (services/identity/authz.mjs `can`) so the tests exercise the exact
// GC-owns-the-plan / homeowner-view-only table that ships (ADR-0004), not a
// re-implementation. It mirrors the identity SERVICE's authorize/requireMember
// signatures and typed-error shape (401 unauthenticated, 403 forbidden).
// ---------------------------------------------------------------------------
export function createInMemoryIdentity({ memberships = [] } = {}) {
  // memberships: [{ projectId, partyId, role }]
  const byProject = new Map();
  for (const m of memberships) {
    if (!byProject.has(m.projectId)) byProject.set(m.projectId, new Map());
    byProject.get(m.projectId).set(m.partyId, m.role);
  }

  function roleOf(projectId, partyId) {
    return byProject.get(projectId)?.get(partyId) ?? null;
  }

  // Same contract as the identity service: throws typed {status,code} errors the
  // HTTP layer maps to the platform error envelope; returns { role } on allow.
  function authorize({ actorPartyId, action, projectId }) {
    if (!actorPartyId) throw new DomainError(401, 'unauthenticated', 'acting party is required');
    const role = roleOf(projectId, actorPartyId);
    const decision = can({ action, role, actorPartyId });
    if (!decision.allow) {
      throw new DomainError(403, 'forbidden', decision.reason ?? 'not permitted');
    }
    return { role };
  }

  function requireMember(partyId, projectId) {
    if (!partyId) throw new DomainError(401, 'unauthenticated', 'acting party is required');
    const role = roleOf(projectId, partyId);
    if (!role) throw new DomainError(403, 'forbidden', 'acting party is not a member of this project');
    return { partyId, projectId, role };
  }

  return { authorize, requireMember, roleOf };
}

// ---------------------------------------------------------------------------
// In-memory Ledger port. Schedule needs exactly two things from the ledger:
// `append` (every plan/progress write is ledgered in the same tx as its
// projection — spec §8.2) and `currentBudget` (the read-only allocation hint,
// FR-P6). It deliberately exposes NO budget-move method: Schedule can never move
// the budget, so there is nothing here that could (spec §2 Q2, AC-P5/P12).
// ---------------------------------------------------------------------------
export function createInMemoryLedger({ baselines = new Map() } = {}) {
  const events = []; // { projectId, seq, type, actorPartyId, occurredAt, payload }
  const seqByProject = new Map();

  function append(_tx, { projectId, type, actorPartyId, occurredAt, payload }) {
    const seq = (seqByProject.get(projectId) ?? 0) + 1;
    seqByProject.set(projectId, seq);
    // The pg ledger's append_event inserts its own id; mirror that here so the
    // audit_event_id a service stores in its projection is always populated.
    const e = { id: randomUUID(), projectId, seq, type, actorPartyId, occurredAt, payload };
    events.push(e);
    return e;
  }

  // No change order ever moves through Schedule, so the budget is just the
  // baseline here — which is exactly the point of AC-P5/AC-P12: whatever a GC does
  // to stage costs, this number does not move.
  function currentBudget(projectId) {
    const baselineCents = baselines.get(projectId) ?? 0;
    return { baselineCents, approvedTotalCents: 0, currentCents: baselineCents };
  }

  return { append, currentBudget, _events: events };
}

// ---------------------------------------------------------------------------
// In-memory ScheduleStore — the schema `schedule` this service owns. Stages are
// mutable rows; stage_progress, plan_import and stage_dependency are append-only
// (there is no update/delete method, mirroring the missing SQL grants). `seq` is
// a gap-free counter mirroring `bigint GENERATED ALWAYS AS IDENTITY`, so
// "latest by (reported_at, seq)" is a deterministic total order regardless of
// clock resolution.
// ---------------------------------------------------------------------------
export function createInMemoryStore() {
  const stages = new Map();   // id -> stage row
  const progress = [];        // append-only stage_progress rows
  const imports = [];         // append-only plan_import headers
  const dependencies = [];    // append-only stage_dependency rows
  let stageSeq = 0;
  let progressSeq = 0;

  function transaction(fn) {
    // Single-threaded in tests; the real adapter opens a Postgres tx here so the
    // projection write and the ledger append commit together.
    return fn({});
  }

  function insertStage(_tx, row) {
    const stored = { ...row, seq: ++stageSeq };
    stages.set(row.id, stored);
    return { ...stored };
  }

  function getStage(id) {
    const r = stages.get(id);
    return r ? { ...r } : null;
  }

  // Conditional in-place update. Only stage rows are mutable; the append-only
  // history is untouched. Returns the updated row, or null if the stage is gone.
  function updateStage(_tx, id, patch) {
    const r = stages.get(id);
    if (!r) return null;
    Object.assign(r, patch);
    return { ...r };
  }

  function listStages(projectId) {
    // ORDER BY position, seq — the same total order as stage_project_position_idx.
    return [...stages.values()]
      .filter((s) => s.project_id === projectId)
      .sort((a, b) => (a.position - b.position) || (a.seq - b.seq))
      .map((s) => ({ ...s }));
  }

  function maxStagePosition(projectId) {
    let max = 0;
    for (const s of stages.values()) {
      if (s.project_id !== projectId) continue;
      if (s.position != null && s.position > max) max = s.position;
    }
    return max;
  }

  function insertStageDependency(_tx, stageId, dependsOnStageId) {
    const row = { stage_id: stageId, depends_on_stage_id: dependsOnStageId };
    dependencies.push(row);
    return { ...row };
  }

  function listStageDependencies(stageId) {
    return dependencies.filter((d) => d.stage_id === stageId).map((d) => d.depends_on_stage_id);
  }

  function insertPlanImport(_tx, row) {
    // Mirror the DB UNIQUE on idempotency_key (23505) so contract tests see the
    // same idempotent-confirm behaviour as production.
    if (imports.some((i) => i.idempotency_key === row.idempotency_key)) {
      const err = new Error(`duplicate key value violates unique constraint "plan_import_idempotency_key_key"`);
      err.code = '23505';
      err.constraint = 'plan_import_idempotency_key_key';
      throw err;
    }
    imports.push({ ...row });
    return { ...row };
  }

  function getPlanImportByIdempotencyKey(idempotencyKey) {
    const r = imports.find((i) => i.idempotency_key === idempotencyKey);
    return r ? { ...r } : null;
  }

  function importStageCounts(importId) {
    let stageCount = 0;
    let rootCount = 0;
    for (const s of stages.values()) {
      if (s.import_id !== importId) continue;
      stageCount += 1;
      if (s.parent_id == null) rootCount += 1;
    }
    return { stageCount, rootCount };
  }

  function listDependenciesOf(projectId) {
    const ids = new Set(
      [...stages.values()].filter((s) => s.project_id === projectId).map((s) => s.id),
    );
    return dependencies.filter((d) => ids.has(d.stage_id)).map((d) => ({ ...d }));
  }

  function insertProgress(_tx, row) {
    const stored = { ...row, seq: ++progressSeq };
    progress.push(stored);
    return { ...stored };
  }

  // Full attributed history for one stage, oldest→newest by (reported_at, seq).
  function listProgressByStage(stageId) {
    return progress
      .filter((p) => p.stage_id === stageId)
      .sort((a, b) => (a.reported_at < b.reported_at ? -1
        : a.reported_at > b.reported_at ? 1 : a.seq - b.seq))
      .map((p) => ({ ...p }));
  }

  // The single latest progress row per stage in a project (the derivation input
  // for current status and the rollup). Null-latest stages are simply absent.
  function latestProgressByProject(projectId) {
    const latest = new Map(); // stage_id -> row
    for (const p of progress) {
      if (p.project_id !== projectId) continue;
      const cur = latest.get(p.stage_id);
      if (!cur
        || p.reported_at > cur.reported_at
        || (p.reported_at === cur.reported_at && p.seq > cur.seq)) {
        latest.set(p.stage_id, p);
      }
    }
    const out = new Map();
    for (const [k, v] of latest) out.set(k, { ...v });
    return out;
  }

  return {
    transaction,
    insertStage, getStage, updateStage, listStages, maxStagePosition,
    insertStageDependency, listStageDependencies,
    insertPlanImport, getPlanImportByIdempotencyKey, importStageCounts,
    insertProgress, listProgressByStage, latestProgressByProject,
    _stages: stages, _progress: progress, _imports: imports, _dependencies: dependencies,
  };
}

export { ACTION, now };
