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
import { PLAN_SKELETON_BODY, SYSTEM_TEMPLATE_NAME } from './plan-skeleton.mjs';
import { SYSTEM_SPECIALTIES } from './specialty-seed.mjs';

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

  // Mirrors the pg ledger's audit read (the record's History tab reuses it).
  function getAudit(projectId) {
    return {
      status: 200,
      etag: null,
      events: events.filter((e) => e.projectId === projectId).map((e) => ({ ...e })),
      verify: { ok: true },
    };
  }

  return { append, currentBudget, getAudit, _events: events };
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
  const lineMaterials = [];    // schedule.line_material rows
  const movements = [];        // schedule.material_movement rows (append-only)
  const comments = [];         // schedule.stage_comment rows (append-only, LINA-249)
  const attachments = [];      // schedule.stage_attachment rows (append-only, LINA-249)
  const phases = [];           // schedule.project_phase rows (mutable status walk, LINA-278)
  const signOffs = [];         // schedule.phase_sign_off_request rows (in-place resolve, LINA-278)
  const planChangeLog = [];    // schedule.plan_change_log rows (append-only, LINA-280)
  // schedule.plan_template rows (mutable CRUD; NO audit weight — outside the
  // tamper-evident record, ADR-0018). Seeded with the single system default so
  // the resolve ladder (user → system) has the same source of truth the DB
  // migration seeds. Body is the canonical PLAN_SKELETON_BODY.
  const planTemplates = [{
    id: randomUUID(),
    owner_scope: 'system',
    owner_id: null,
    name: SYSTEM_TEMPLATE_NAME,
    is_default: true,
    body: PLAN_SKELETON_BODY,
    created_at: now(),
    updated_at: now(),
  }];
  // schedule.specialty rows (suggest catalog; NO audit weight, LINA-306). Seeded
  // with the same system set the migration seeds, from the one canonical source.
  const specialties = SYSTEM_SPECIALTIES.map((label) => ({
    id: randomUUID(),
    owner_scope: 'system',
    owner_id: null,
    label,
    created_at: now(),
  }));
  let stageSeq = 0;
  let progressSeq = 0;
  let movementSeq = 0;

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

  // Mirrors the DB stage_freeze_delete_guard (LINA-230): a stage on a
  // frozen/terminal version can never be deleted; a draft's (or open proposal's)
  // stages may. Same terminal set as assertStageMutable.
  function deleteStagesByPlanVersion(_tx, planVersionId) {
    const removed = [];
    for (const s of [...stages.values()]) {
      if (s.plan_version_id !== planVersionId) continue;
      assertStageMutable(s.plan_version_id);
      stages.delete(s.id);
      removed.push(s.id);
    }
    // Mirror the DB FK `stage_progress.stage_id → stage.id ON DELETE SET NULL`
    // (migration 0015, LINA-307): a draft re-save deletes the stage rows, so any
    // progress row that referenced them keeps its `stage_key` but loses its
    // `stage_id`. The append-only history survives; only the (now-dangling) id is
    // nulled — the exact behaviour the key-anchored derivation relies on.
    if (removed.length) {
      const gone = new Set(removed);
      for (const p of progress) {
        if (p.stage_id != null && gone.has(p.stage_id)) p.stage_id = null;
      }
    }
  }

  function getStage(id) {
    const r = stages.get(id);
    return r ? { ...r } : null;
  }

  // Resolve a stage by its stable key within a project (LINA-306). Mirrors the
  // pg-store: a draft re-save re-mints ids but not keys, so the newest surviving
  // row for (project_id, key) recovers the project + key context progress needs.
  function getCurrentStageByKey(projectId, key) {
    const hits = [...stages.values()]
      .filter((s) => s.project_id === projectId && s.key === key)
      .sort((a, b) => b.seq - a.seq);
    return hits.length ? { ...hits[0] } : null;
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

  function insertStageDependency(_tx, stageId, dependsOnStageId, depType = 'starts_after') {
    const row = { stage_id: stageId, depends_on_stage_id: dependsOnStageId, dep_type: depType };
    dependencies.push(row);
    return { ...row };
  }

  function listStageDependencies(stageId) {
    return dependencies.filter((d) => d.stage_id === stageId).map((d) => d.depends_on_stage_id);
  }

  // Mirrors the DB stage_dependency_freeze_delete_guard (LINA-233): a dependency
  // whose OWNING stage sits on a frozen/terminal version can never be deleted; a
  // draft's may. Same terminal set and error shape as assertStageMutable. The SQL
  // fires the trigger per row, so if ANY candidate row is guarded the whole
  // delete raises — mirrored here by checking candidates before removing any.
  function deleteStageDependenciesByPlanVersion(_tx, planVersionId) {
    const versionStageIds = new Set(
      [...stages.values()].filter((s) => s.plan_version_id === planVersionId).map((s) => s.id),
    );
    const candidates = dependencies.filter((d) => versionStageIds.has(d.stage_id)
      || versionStageIds.has(d.depends_on_stage_id));
    for (const d of candidates) assertDependencyMutable(d.stage_id);
    for (const d of candidates) {
      const i = dependencies.indexOf(d);
      if (i >= 0) dependencies.splice(i, 1);
    }
  }

  // The DB trigger guards on the OWNING stage (stage_id), not the predecessor.
  function assertDependencyMutable(stageId) {
    const s = stages.get(stageId);
    if (!s || s.plan_version_id == null) return;
    const v = versions.find((x) => x.id === s.plan_version_id);
    if (v && ['accepted', 'superseded', 'withdrawn', 'rejected'].includes(v.status)) {
      const err = new Error(
        `stage dependency belongs to a frozen/terminal plan version — a baseline is changed, never deleted`,
      );
      err.code = 'P0001';
      err.trigger = 'stage_dependency_freeze_delete_guard';
      throw err;
    }
  }

  // The resolved predecessor graph of a version: { stage_id, depends_on_stage_id,
  // dep_type } rows, matching the pg adapter so `getPlan` reads deps the same way
  // on both.
  function listStageDependenciesByPlanVersion(planVersionId) {
    const versionStageIds = new Set(
      [...stages.values()].filter((s) => s.plan_version_id === planVersionId).map((s) => s.id),
    );
    return dependencies
      .filter((d) => versionStageIds.has(d.stage_id))
      .sort((a, b) => (a.stage_id < b.stage_id ? -1 : a.stage_id > b.stage_id ? 1 : 0))
      .map((d) => ({ ...d }));
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

  // The single latest progress row per STAGE KEY in a project (LINA-307) — the
  // key-anchored twin of latestProgressByProject. Survives a draft re-save that
  // re-mints stage ids. NULL-key rows (legacy) are absent and fall through to the
  // by-id map in the service's derivation.
  function latestProgressByProjectKey(projectId) {
    const latest = new Map(); // stage_key -> row
    for (const p of progress) {
      if (p.project_id !== projectId || p.stage_key == null) continue;
      const cur = latest.get(p.stage_key);
      if (!cur
        || p.reported_at > cur.reported_at
        || (p.reported_at === cur.reported_at && p.seq > cur.seq)) {
        latest.set(p.stage_key, p);
      }
    }
    const out = new Map();
    for (const [k, v] of latest) out.set(k, { ...v });
    return out;
  }

  // Full attributed history for one stage KEY in a project, oldest→newest
  // (LINA-307) — the key-anchored twin of listProgressByStage.
  function listProgressByKey(projectId, stageKey) {
    return progress
      .filter((p) => p.project_id === projectId && p.stage_key === stageKey)
      .sort((a, b) => (a.reported_at < b.reported_at ? -1
        : a.reported_at > b.reported_at ? 1 : a.seq - b.seq))
      .map((p) => ({ ...p }));
  }

  // ── Slice B2 plan versioning (LINA-200, contract §3) ──────────────────────

  // Mirrors the DB plan_version_one_open_per_project partial unique index: at most
  // ONE 'proposed' version may exist per project (a single negotiation thread, B2
  // contract §1). The real adapter's unique index enforces it; mirroring it here
  // keeps contract tests honest about the same invariant. The caller keeps the
  // ONE-open invariant by superseding/withdrawing the open version before
  // inserting the next (see plan-version.mjs requestChanges).
  function assertOneOpenPerProject(row) {
    if (row.status !== 'proposed') return;
    if (versions.some((v) => v.project_id === row.project_id && v.status === 'proposed')) {
      const err = new Error(
        `duplicate key value violates unique constraint "plan_version_one_open_per_project"`,
      );
      err.code = '23505';
      err.constraint = 'plan_version_one_open_per_project';
      throw err;
    }
  }

  // Mirrors plan_version_one_draft_per_project: at most ONE 'draft' per project
  // (the single resumable workspace, LINA-230). The caller keeps the invariant by
  // replacing the draft's stages in place rather than inserting a second draft.
  function assertOneDraftPerProject(row) {
    if (row.status !== 'draft') return;
    if (versions.some((v) => v.project_id === row.project_id && v.status === 'draft')) {
      const err = new Error(
        `duplicate key value violates unique constraint "plan_version_one_draft_per_project"`,
      );
      err.code = '23505';
      err.constraint = 'plan_version_one_draft_per_project';
      throw err;
    }
  }

  function insertPlanVersion(_tx, row) {
    assertOneOpenPerProject(row);
    assertOneDraftPerProject(row);
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

  // The single draft (private workspace) for a project, or null (LINA-230).
  function getDraftPlanVersion(projectId) {
    const r = versions.find((x) => x.project_id === projectId && x.status === 'draft');
    return r ? { ...r } : null;
  }

  // version_no is assigned server-side (mirroring the append-txn advisory lock);
  // the next number is max(existing)+1, seeded 1 when none exists. Drafts carry a
  // NULL version_no (assigned at :propose) and are skipped (LINA-230).
  function nextPlanVersionNo(projectId) {
    const nums = versions
      .filter((x) => x.project_id === projectId && x.version_no != null)
      .map((x) => x.version_no);
    return nums.length === 0 ? 1 : Math.max(...nums) + 1;
  }

  // The only mutation to a plan_version envelope: status + (on freeze) frozen_at +
  // (on propose) version_no. versionNo omitted leaves the number untouched.
  function updatePlanVersionStatus(_tx, id, { status, frozenAt, versionNo }) {
    const r = versions.find((x) => x.id === id);
    if (!r) return null;
    r.status = status;
    if (frozenAt !== undefined) r.frozen_at = frozenAt;
    if (versionNo !== undefined && versionNo !== null) r.version_no = versionNo;
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

  // ── Slice B3 materials & movement (LINA-217, contract §1) ────────────────

  // Mirrors the DB line_material_freeze_guard trigger: a line_material bound to a
  // frozen/terminal plan version cannot be inserted or updated.
  function assertMaterialMutable(planVersionId) {
    if (planVersionId == null) return;
    const v = versions.find((x) => x.id === planVersionId);
    if (v && ['accepted', 'superseded', 'withdrawn', 'rejected'].includes(v.status)) {
      const err = new Error(
        'line_material belongs to a frozen/terminal plan version — a baseline material is moved, never edited',
      );
      err.code = 'P0001';
      err.trigger = 'line_material_freeze_guard';
      throw err;
    }
  }

  function insertLineMaterial(_tx, row) {
    assertMaterialMutable(row.plan_version_id);
    lineMaterials.push({ ...row });
    return { ...row };
  }

  function getLineMaterial(id) {
    const r = lineMaterials.find((x) => x.id === id);
    return r ? { ...r } : null;
  }

  function updateLineMaterial(_tx, id, patch) {
    const r = lineMaterials.find((x) => x.id === id);
    if (!r) return null;
    assertMaterialMutable(r.plan_version_id);
    Object.assign(r, patch);
    return { ...r };
  }

  function listLineMaterialsByStage(stageId) {
    return lineMaterials
      .filter((m) => m.stage_id === stageId)
      .sort((a, b) => (a.position - b.position) || (a.created_at < b.created_at ? -1 : 1))
      .map((m) => ({ ...m }));
  }

  function listLineMaterialsByVersion(planVersionId) {
    return lineMaterials
      .filter((m) => m.plan_version_id === planVersionId)
      .map((m) => ({ ...m }));
  }

  // Append-only INSERT (no update/delete surface — mirrors the missing grants).
  function insertMaterialMovement(_tx, row) {
    const stored = { ...row, seq: ++movementSeq };
    movements.push(stored);
    return { ...stored };
  }

  function listMovementsByProject(projectId) {
    return movements
      .filter((m) => m.project_id === projectId)
      .sort((a, b) => (a.occurred_at < b.occurred_at ? -1
        : a.occurred_at > b.occurred_at ? 1 : a.seq - b.seq))
      .map((m) => ({ ...m }));
  }

  function listMovementsByLine(lineMaterialId) {
    return movements
      .filter((m) => m.line_material_id === lineMaterialId)
      .sort((a, b) => (a.occurred_at < b.occurred_at ? -1
        : a.occurred_at > b.occurred_at ? 1 : a.seq - b.seq))
      .map((m) => ({ ...m }));
  }

  // ── Task workspace (LINA-249) — comments & attachments ─────────────────────
  // Append-only rows anchored on (project_id, stage_key), mirroring the pg
  // adapter. No update/delete surface exists here at all (the interface has no
  // such methods), which is what makes append-only a property of the contract.

  // Is a stage key LIVE — a stage with that key exists on a draft, an open
  // proposal, the agreed baseline, or a pre-versioning legacy stage? Mirrors
  // the pg query (LINA-249).
  function stageLiveByKey(projectId, stageKey) {
    return [...stages.values()].some((s) => {
      if (s.project_id !== projectId || s.key !== stageKey) return false;
      if (s.plan_version_id == null) return true;
      const v = versions.find((x) => x.id === s.plan_version_id);
      return !v || ['draft', 'proposed', 'accepted'].includes(v.status);
    });
  }

  // Append-only INSERT; returns a copy so a caller can never mutate history.
  function insertStageComment(_tx, row) {
    const stored = { ...row };
    comments.push(stored);
    return { ...stored };
  }

  function listStageCommentsByKey(projectId, stageKey) {
    return comments
      .filter((c) => c.project_id === projectId && c.stage_key === stageKey)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
      .map((c) => ({ ...c }));
  }

  function insertStageAttachment(_tx, row) {
    const stored = { ...row };
    attachments.push(stored);
    return { ...stored };
  }

  function listStageAttachmentsByKey(projectId, stageKey) {
    return attachments
      .filter((a) => a.project_id === projectId && a.stage_key === stageKey)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
      .map((a) => ({ ...a }));
  }

  // ── Plan templates (LINA-241, ADR-0018) — mutable CRUD, no audit weight ─────

  function getSystemDefaultTemplate() {
    const r = planTemplates.find((t) => t.owner_scope === 'system' && t.is_default);
    return r ? { ...r } : null;
  }

  function getUserDefaultTemplate(ownerId) {
    const r = planTemplates.find(
      (t) => t.owner_scope === 'user' && t.owner_id === ownerId && t.is_default);
    return r ? { ...r } : null;
  }

  // Upsert the caller's single user default. Mirrors the DB partial unique index
  // (one default per owner): a second save REPLACES the first in place, never
  // inserts a 2nd default row.
  function upsertUserDefaultTemplate({ ownerId, name, body }) {
    const existing = planTemplates.find(
      (t) => t.owner_scope === 'user' && t.owner_id === ownerId && t.is_default);
    if (existing) {
      existing.name = name;
      existing.body = body;
      existing.updated_at = now();
      return { ...existing };
    }
    const row = {
      id: randomUUID(),
      owner_scope: 'user',
      owner_id: ownerId,
      name,
      is_default: true,
      body,
      created_at: now(),
      updated_at: now(),
    };
    planTemplates.push(row);
    return { ...row };
  }

  // ── Specialty catalog (LINA-306) — suggest list, no audit weight ────────────

  function listSpecialties(ownerId) {
    return specialties
      .filter((s) => s.owner_scope === 'system' || s.owner_id === ownerId)
      .map((s) => ({ ...s }));
  }

  // Create one owned by the caller. Mirrors the DB behaviour: a label that only
  // exists as a system row is handed back rather than copied; a label the caller
  // already owns (case-insensitively) returns the existing row (idempotent).
  function createUserSpecialty({ ownerId, label }) {
    const norm = label.trim().toLowerCase();
    const sys = specialties.find(
      (s) => s.owner_scope === 'system' && s.label.trim().toLowerCase() === norm);
    if (sys) return { ...sys };
    const own = specialties.find(
      (s) => s.owner_scope === 'user' && s.owner_id === ownerId
        && s.label.trim().toLowerCase() === norm);
    if (own) return { ...own };
    const row = {
      id: randomUUID(),
      owner_scope: 'user',
      owner_id: ownerId,
      label,
      created_at: now(),
    };
    specialties.push(row);
    return { ...row };
  }

  // ── Project phases + sign-off (LINA-278, ADR-0023) ──────────────────────────
  // The in-memory reference enforces the same invariants the SQL migration does:
  //   - one row per (project_id, kind) and per (project_id, sequence);
  //   - signed_off is a one-way terminal state (mirrors the DB trigger);
  //   - at most one pending sign-off request per phase (mirrors the partial index);
  //   - a sign-off request is resolved IN PLACE (status + resolved_at + comment).

  // Idempotent INSERT (mirrors `ON CONFLICT (project_id, kind) DO NOTHING`):
  // returns the stored row, or null when a phase of that kind already exists.
  // The no-throw contract matters for ensurePhases' seed loop — a concurrent
  // seed must not poison a shared transaction (as a raised unique violation
  // would on postgres).
  function insertPhase(_tx, row) {
    if (phases.some((p) => p.project_id === row.project_id && p.kind === row.kind)) {
      return null;
    }
    const stored = { responsible_party_ids: [], ...row };
    phases.push(stored);
    return { ...stored };
  }

  function listPhasesByProject(projectId) {
    return phases
      .filter((p) => p.project_id === projectId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((p) => ({ ...p }));
  }

  function getPhaseById(id) {
    const r = phases.find((p) => p.id === id);
    return r ? { ...r } : null;
  }

  function getPhaseByKind(projectId, kind) {
    const r = phases.find((p) => p.project_id === projectId && p.kind === kind);
    return r ? { ...r } : null;
  }

  function countPhasesByProject(projectId) {
    return phases.filter((p) => p.project_id === projectId).length;
  }

  // In-place status walk. Mirrors schedule.reject_phase_signed_off_reopen: a
  // signed_off phase can never be walked back out (one-way terminal state).
  function updatePhaseStatus(_tx, id, status) {
    const r = phases.find((p) => p.id === id);
    if (!r) return null;
    if (r.status === 'signed_off' && status !== 'signed_off') {
      const err = new Error(
        `project_phase ${id} is signed_off — a one-way terminal state; edits route through change orders (ADR-0014)`);
      err.code = 'P0001';
      err.trigger = 'project_phase_signed_off_one_way';
      throw err;
    }
    r.status = status;
    r.updated_at = now();
    return { ...r };
  }

  function insertSignOffRequest(_tx, row) {
    if (signOffs.some((s) => s.phase_id === row.phase_id && s.status === 'pending')) {
      const err = new Error(`a sign-off request is already pending for phase ${row.phase_id}`);
      err.code = '23505'; // unique_violation — mirror the partial pending index
      err.constraint = 'phase_sign_off_one_pending_per_phase';
      throw err;
    }
    const stored = { resolved_at: null, resolution_comment: null, ...row };
    signOffs.push(stored);
    return { ...stored };
  }

  function getSignOffRequest(id) {
    const r = signOffs.find((s) => s.id === id);
    return r ? { ...r } : null;
  }

  function listSignOffRequestsByPhase(phaseId) {
    return signOffs
      .filter((s) => s.phase_id === phaseId)
      .sort((a, b) => (a.requested_at < b.requested_at ? -1 : a.requested_at > b.requested_at ? 1 : 0))
      .map((s) => ({ ...s }));
  }

  // Resolve a pending request in place (approve/reject). Returns the resolved row
  // or null when the id is unknown / already resolved (a no-op, not a crash).
  function resolveSignOffRequest(_tx, id, { status, resolvedAt, resolutionComment }) {
    const r = signOffs.find((s) => s.id === id && s.status === 'pending');
    if (!r) return null;
    r.status = status;
    r.resolved_at = resolvedAt;
    r.resolution_comment = resolutionComment ?? null;
    return { ...r };
  }

  // ── plan_change_log — append-only pre-sign-off audit (LINA-280, ADR-0023 §8) ──
  // The reference mirrors the SQL grant: SELECT+INSERT only, never updated. Values
  // are stored as the raw JS scalar (the jsonb column round-trips the same shape).
  function insertPlanChangeLog(_tx, row) {
    // Coerce undefined → null so the reference matches how pg maps the jsonb
    // columns back (an omitted oldValue on a creation reads as null, never
    // undefined). `?? null` leaves a legitimate 0 / false / '' intact.
    const stored = {
      ...row,
      old_value: row.old_value ?? null,
      new_value: row.new_value ?? null,
      actor_party_id: row.actor_party_id ?? null,
    };
    planChangeLog.push(stored);
    return { ...stored };
  }

  function listPlanChangeLogByPhase(phaseId) {
    return planChangeLog
      .filter((r) => r.phase_id === phaseId)
      .sort((a, b) => (a.occurred_at < b.occurred_at ? -1
        : a.occurred_at > b.occurred_at ? 1 : 0))
      .map((r) => ({ ...r }));
  }

  return {
    transaction,
    insertPhase, listPhasesByProject, getPhaseById, getPhaseByKind,
    countPhasesByProject, updatePhaseStatus,
    insertSignOffRequest, getSignOffRequest, listSignOffRequestsByPhase, resolveSignOffRequest,
    insertPlanChangeLog, listPlanChangeLogByPhase,
    insertStage, getStage, getCurrentStageByKey, updateStage, listStages, maxStagePosition,
    insertStageDependency, listStageDependencies, deleteStageDependenciesByPlanVersion,
    listStageDependenciesByPlanVersion,
    insertPlanImport, getPlanImportByIdempotencyKey, importStageCounts,
    insertProgress, listProgressByStage, latestProgressByProject,
    latestProgressByProjectKey, listProgressByKey,
    insertPlanVersion, getPlanVersion, getOpenPlanVersion, getDraftPlanVersion,
    deleteStagesByPlanVersion, nextPlanVersionNo,
    updatePlanVersionStatus, listPlanVersions,
    insertPlanAcceptance, listPlanAcceptances, getPlanAcceptance,
    upsertProjectBaseline, getProjectBaseline,
    listStagesByPlanVersion, stageCountByPlanVersion,
    insertLineMaterial, getLineMaterial, updateLineMaterial,
    listLineMaterialsByStage, listLineMaterialsByVersion,
    insertMaterialMovement, listMovementsByProject, listMovementsByLine,
    stageLiveByKey, insertStageComment, listStageCommentsByKey,
    insertStageAttachment, listStageAttachmentsByKey,
    getSystemDefaultTemplate, getUserDefaultTemplate, upsertUserDefaultTemplate,
    listSpecialties, createUserSpecialty,
    _stages: stages, _progress: progress, _imports: imports, _dependencies: dependencies,
    _versions: versions, _acceptances: acceptances, _baselines: baselines,
    _lineMaterials: lineMaterials, _movements: movements, _planTemplates: planTemplates,
    _comments: comments, _attachments: attachments,
    _phases: phases, _signOffs: signOffs,
  };
}

export { ACTION, now };
