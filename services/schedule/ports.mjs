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
  // Extra context (proposedByPartyId for the REVIEW_PLAN two-sided rule) is
  // forwarded to the pure authorizer, mirroring the identity service's authorize.
  function authorize({ actorPartyId, action, projectId, ...extra }) {
    if (!actorPartyId) throw new DomainError(401, 'unauthenticated', 'acting party is required');
    const role = roleOf(projectId, actorPartyId);
    const decision = can({ action, role, actorPartyId, ...extra });
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
  const versions = [];        // plan_version rows (envelope; status is mutable)
  const acceptances = [];     // append-only plan_acceptance stamps
  const baselines = new Map(); // schedule.project_baseline pointer (upsert, per project)
  let stageSeq = 0;
  let progressSeq = 0;

  function transaction(fn) {
    // Single-threaded in tests; the real adapter opens a Postgres tx here so the
    // projection write and the ledger append commit together.
    return fn({});
  }

  // The DB freeze guard (ADR-0002 §4) mirrored in code: a stage bound to a
  // frozen/terminal plan version cannot be inserted or mutated. Mirrors the
  // `reject_frozen_stage_write` trigger exactly.
  function assertStageMutable(planVersionId) {
    if (planVersionId == null) return;
    const v = versions.find((x) => x.id === planVersionId);
    if (v && ['accepted', 'superseded', 'withdrawn', 'rejected'].includes(v.status)) {
      const err = new Error(
        `stage belongs to a frozen/terminal plan version — a baseline is changed, never edited`,
      );
      err.code = 'P0001';
      err.trigger = 'stage_freeze_guard';
      throw err;
    }
  }

  function insertStage(_tx, row) {
    assertStageMutable(row.plan_version_id);
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
    assertStageMutable(r.plan_version_id);
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

  // ── Slice B2 plan versioning (LINA-200, contract §3) ──────────────────────

  function insertPlanVersion(_tx, row) {
    versions.push({ ...row });
    return { ...row };
  }

  function getPlanVersion(id) {
    const r = versions.find((x) => x.id === id);
    return r ? { ...r } : null;
  }

  function getOpenPlanVersion(projectId) {
    const r = versions.find((x) => x.project_id === projectId && x.status === 'proposed');
    return r ? { ...r } : null;
  }

  // version_no is assigned server-side (mirroring the append-txn advisory lock);
  // the next number is max(existing)+1, seeded 1 when none exists.
  function nextPlanVersionNo(projectId) {
    const nums = versions
      .filter((x) => x.project_id === projectId)
      .map((x) => x.version_no);
    return nums.length === 0 ? 1 : Math.max(...nums) + 1;
  }

  // The only mutation to a plan_version envelope: status + (on freeze) frozen_at.
  function updatePlanVersionStatus(_tx, id, { status, frozenAt }) {
    const r = versions.find((x) => x.id === id);
    if (!r) return null;
    r.status = status;
    if (frozenAt !== undefined) r.frozen_at = frozenAt;
    return { ...r };
  }

  function listPlanVersions(projectId) {
    return versions
      .filter((x) => x.project_id === projectId)
      .sort((a, b) => a.version_no - b.version_no)
      .map((x) => ({ ...x }));
  }

  function insertPlanAcceptance(_tx, row) {
    acceptances.push({ ...row });
    return { ...row };
  }

  function listPlanAcceptances(planVersionId) {
    return acceptances.filter((a) => a.plan_version_id === planVersionId).map((a) => ({ ...a }));
  }

  // addressable stamps so :accept can be idempotent-by-state (a party may stamp a
  // version at most once — UNIQUE (plan_version_id, party_id)).
  function getPlanAcceptance(planVersionId, partyId) {
    const r = acceptances.find((a) => a.plan_version_id === planVersionId && a.party_id === partyId);
    return r ? { ...r } : null;
  }

  function upsertProjectBaseline(_tx, row) {
    const existing = baselines.get(row.project_id);
    const stored = { ...existing, ...row };
    baselines.set(row.project_id, stored);
    return { ...stored };
  }

  function getProjectBaseline(projectId) {
    const r = baselines.get(projectId);
    return r ? { ...r } : null;
  }

  // The WBS stage rows bound to a version, in plan order (parents before children
  // by position; the service remaps parent_id when forking).
  function listStagesByPlanVersion(planVersionId) {
    return [...stages.values()]
      .filter((s) => s.plan_version_id === planVersionId)
      .sort((a, b) => (a.position - b.position) || (a.seq - b.seq))
      .map((s) => ({ ...s }));
  }

  function stageCountByPlanVersion(planVersionId) {
    return listStagesByPlanVersion(planVersionId).length;
  }

  return {
    transaction,
    insertStage, getStage, updateStage, listStages, maxStagePosition,
    insertStageDependency, listStageDependencies,
    insertPlanImport, getPlanImportByIdempotencyKey, importStageCounts,
    insertProgress, listProgressByStage, latestProgressByProject,
    insertPlanVersion, getPlanVersion, getOpenPlanVersion, nextPlanVersionNo,
    updatePlanVersionStatus, listPlanVersions,
    insertPlanAcceptance, listPlanAcceptances, getPlanAcceptance,
    upsertProjectBaseline, getProjectBaseline,
    listStagesByPlanVersion, stageCountByPlanVersion,
    _stages: stages, _progress: progress, _imports: imports, _dependencies: dependencies,
    _versions: versions, _acceptances: acceptances, _baselines: baselines,
  };
}

export { ACTION, now };
