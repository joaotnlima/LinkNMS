// Schedule & Progress — the Postgres adapter for the ScheduleStore port
// (ADR-0006 §1; LINA-69). Same surface as ports.mjs's `createInMemoryStore`,
// backed by schema `schedule`. It enforces in the DATABASE exactly the invariants
// the in-memory reference enforces in code, so the contract tests and the
// production path agree:
//   - stage_progress is append-only (INSERT/SELECT only — no UPDATE/DELETE grant);
//   - "latest" is a total order over (reported_at, seq);
//   - percent is only storable while in_progress (CHECK percent_only_in_progress).
//
// The trust-critical part is `transaction(fn)`: it opens ONE Postgres transaction
// and hands the raw pooled client to `fn`, which passes that SAME client to both
// this store's write AND the Ledger port's `append`. The projection write and the
// ledger append therefore COMMIT together (ADR-0006 §1, spec §8.2) — if the audit
// event doesn't land, the status change didn't happen.
//
// bigint columns (seq, planned_cost_cents) arrive as strings from pg; normalised
// here so the shape matches the in-memory store. Timestamps → ISO strings so they
// byte-match the occurredAt the service hands the ledger and the openapi contract.
import { withTransaction, getPool } from '../ledger/db.mjs';

const toIso = (v) => (v instanceof Date ? v.toISOString() : v);
const toNum = (v) => (v == null ? null : Number(v));

// A date column comes back as a Date (or 'YYYY-MM-DD'); the plan surface wants a
// plain date string, never a timestamp — take the first 10 chars of the ISO form.
function toDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function mapStage(r) {
  if (!r) return null;
  return {
    id: r.id,
    seq: toNum(r.seq),
    project_id: r.project_id,
    name: r.name,
    position: r.position,
    parent_id: r.parent_id,
    trade: r.trade,
    import_id: r.import_id,
    plan_version_id: r.plan_version_id,
    source_row_ref: r.source_row_ref,
    scope_note: r.scope_note,
    description: r.description ?? null,
    planned_start_date: toDate(r.planned_start_date),
    planned_end_date: toDate(r.planned_end_date),
    planned_cost_cents: toNum(r.planned_cost_cents),
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
  };
}

function mapProgress(r) {
  if (!r) return null;
  return {
    id: r.id,
    seq: toNum(r.seq),
    stage_id: r.stage_id,
    project_id: r.project_id,
    status: r.status,
    percent: r.percent == null ? null : Number(r.percent),
    note: r.note,
    reported_by_party_id: r.reported_by_party_id,
    reported_at: toIso(r.reported_at),
  };
}

// Slice B2 plan versioning (LINA-200, contract §3) shapers. plan_version /
// plan_acceptance / project_baseline rows are snake_case in the DB; these map
// them to the same camelCase-less snake_case shape the in-memory store returns,
// normalising num/date/timestamp columns so both adapters agree.
function mapPlanVersion(r) {
  if (!r) return null;
  return {
    id: r.id,
    project_id: r.project_id,
    // NULL while drafting (version_no is assigned at :propose); Number() only
    // once there is a number, never Number(null) → 0 (LINA-230).
    version_no: r.version_no == null ? null : Number(r.version_no),
    status: r.status,
    source_import_id: r.source_import_id,
    supersedes_version_id: r.supersedes_version_id,
    proposed_by_party_id: r.proposed_by_party_id,
    created_at: toIso(r.created_at),
    frozen_at: r.frozen_at == null ? null : toIso(r.frozen_at),
  };
}

function mapAcceptance(r) {
  if (!r) return null;
  return {
    id: r.id,
    plan_version_id: r.plan_version_id,
    project_id: r.project_id,
    party_id: r.party_id,
    kind: r.kind,
    stamped_at: toIso(r.stamped_at),
    audit_event_id: r.audit_event_id,
  };
}

function mapBaseline(r) {
  if (!r) return null;
  return {
    project_id: r.project_id,
    plan_version_id: r.plan_version_id,
    version_no: Number(r.version_no),
    frozen_at: toIso(r.frozen_at),
    baseline_audit_event_id: r.baseline_audit_event_id,
  };
}

// Slice B3 materials & movement (LINA-217, contract §1) shapers.
function mapLineMaterial(r) {
  if (!r) return null;
  return {
    id: r.id,
    stage_id: r.stage_id,
    project_id: r.project_id,
    plan_version_id: r.plan_version_id,
    kind: r.kind,
    name: r.name,
    unit: r.unit,
    quantity: r.quantity == null ? null : Number(r.quantity),
    unit_price_cents: r.unit_price_cents == null ? null : Number(r.unit_price_cents),
    position: r.position,
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
  };
}

function mapMovement(r) {
  if (!r) return null;
  return {
    id: r.id,
    seq: toNum(r.seq),
    project_id: r.project_id,
    line_material_id: r.line_material_id,
    stage_id: r.stage_id,
    movement_kind: r.movement_kind,
    price_cause: r.price_cause,
    new_quantity: r.new_quantity == null ? null : Number(r.new_quantity),
    new_unit_price_cents: r.new_unit_price_cents == null ? null : Number(r.new_unit_price_cents),
    value_delta_cents: Number(r.value_delta_cents),
    source: r.source,
    change_order_id: r.change_order_id,
    moved_by_party_id: r.moved_by_party_id,
    occurred_at: toIso(r.occurred_at),
    audit_event_id: r.audit_event_id,
    created_at: toIso(r.created_at),
  };
}

// A plan_template row (LINA-241). jsonb `body` returns already parsed from pg;
// snake_case matches the in-memory store, and the domain layer shapes the API.
function mapTemplate(r) {
  if (!r) return null;
  return {
    id: r.id,
    owner_scope: r.owner_scope,
    owner_id: r.owner_id,
    name: r.name,
    is_default: r.is_default,
    body: r.body,
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
  };
}

// Whitelisted updatable columns (edit / reorder — FR-P1). `set` keys already come
// from the service's own whitelist; this second gate means a stray key can never
// reach the SQL string.
const UPDATABLE = new Set([
  'name', 'position', 'scope_note', 'description',
  'planned_start_date', 'planned_end_date', 'planned_cost_cents', 'updated_at',
]);

export function createPgStore({ pool = getPool() } = {}) {
  function transaction(fn) {
    return withTransaction((client) => fn(client), pool);
  }

  // INSERT a stage. `seq` is GENERATED ALWAYS AS IDENTITY — never supplied.
  // parent_id/trade/import_id/source_row_ref are the Slice B1 WBS/import columns
  // (nullable; null for hand-added stages).
  async function insertStage(client, row) {
    const { rows } = await client.query(
      `insert into schedule.stage
         (id, project_id, name, position, parent_id, trade, import_id, source_row_ref,
          scope_note, description, planned_start_date, planned_end_date, planned_cost_cents,
          plan_version_id, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       returning *`,
      [
        row.id, row.project_id, row.name, row.position, row.parent_id ?? null,
        row.trade ?? null, row.import_id ?? null, row.source_row_ref ?? null,
        row.scope_note, row.description ?? null,
        row.planned_start_date, row.planned_end_date, row.planned_cost_cents,
        row.plan_version_id ?? null, row.created_at, row.updated_at,
      ],
    );
    return mapStage(rows[0]);
  }

  async function getStage(id) {
    const { rows } = await pool.query('select * from schedule.stage where id = $1', [id]);
    return mapStage(rows[0] ?? null);
  }

  // In-place edit / reorder. Builds a parameterised SET from the whitelisted
  // patch; 0 rows updated ⇒ the stage is gone ⇒ null (the service maps to 404).
  async function updateStage(client, id, patch) {
    const cols = Object.keys(patch).filter((k) => UPDATABLE.has(k));
    if (cols.length === 0) return getStage(id);
    const assignments = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const values = cols.map((c) => patch[c]);
    const { rows } = await client.query(
      `update schedule.stage set ${assignments} where id = $1 returning *`,
      [id, ...values],
    );
    return rows.length ? mapStage(rows[0]) : null;
  }

  // Timeline order (FR-P4, §8.3): plan order, tie-broken on seq.
  async function listStages(projectId) {
    const { rows } = await pool.query(
      `select * from schedule.stage
        where project_id = $1
        order by position, seq`,
      [projectId],
    );
    return rows.map(mapStage);
  }

  // Append-only INSERT. `seq` is DB-assigned; the CHECK constraints
  // (percent_only_in_progress, status enum) are the backstop the service can't be
  // tricked past.
  async function insertProgress(client, row) {
    const { rows } = await client.query(
      `insert into schedule.stage_progress
         (id, stage_id, project_id, status, percent, note, reported_by_party_id, reported_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning *`,
      [
        row.id, row.stage_id, row.project_id, row.status, row.percent,
        row.note, row.reported_by_party_id, row.reported_at,
      ],
    );
    return mapProgress(rows[0]);
  }

  // Full attributed history for one stage, oldest→newest (AC-P3, AC-P8). The
  // (reported_at, seq) order is total, so the last element is the current report.
  async function listProgressByStage(stageId) {
    const { rows } = await pool.query(
      `select * from schedule.stage_progress
        where stage_id = $1
        order by reported_at, seq`,
      [stageId],
    );
    return rows.map(mapProgress);
  }

  // The single latest progress row per stage in a project — the derivation input
  // for current status and the rollup. DISTINCT ON with a matching ORDER BY picks
  // the latest deterministically under (reported_at, seq) (spec §8.1, AC-P9).
  async function latestProgressByProject(projectId) {
    const { rows } = await pool.query(
      `select distinct on (stage_id) *
         from schedule.stage_progress
        where project_id = $1
        order by stage_id, reported_at desc, seq desc`,
      [projectId],
    );
    const out = new Map();
    for (const r of rows) out.set(r.stage_id, mapProgress(r));
    return out;
  }

  // ── Slice B1 plan import (LINA-199; contract §3) ────────────────────────────

  // Append-only import header INSERT. audit_event_id is known before this runs
  // because the Confirm transaction appends the ledger event FIRST (the header
  // row is INSERT+SELECT only — no UPDATE backfill exists, mirroring the grant).
  async function insertPlanImport(client, row) {
    const { rows } = await client.query(
      `insert into schedule.plan_import
         (id, project_id, filename, sheet_name, column_mapping, row_count,
          idempotency_key, imported_by_party_id, imported_at, audit_event_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       returning *`,
      [
        row.id, row.project_id, row.filename, row.sheet_name,
        JSON.stringify(row.column_mapping), row.row_count,
        row.idempotency_key, row.imported_by_party_id, row.imported_at, row.audit_event_id,
      ],
    );
    return rows[0];
  }

  // The idempotent-confirm lookup: a retried confirm with a used key returns the
  // ORIGINAL import, writes nothing (contract §2).
  async function getPlanImportByIdempotencyKey(idempotencyKey) {
    const { rows } = await pool.query(
      `select * from schedule.plan_import where idempotency_key = $1`,
      [idempotencyKey],
    );
    return rows[0] ?? null;
  }

  async function insertStageDependency(client, stageId, dependsOnStageId) {
    const { rows } = await client.query(
      `insert into schedule.stage_dependency (stage_id, depends_on_stage_id)
       values ($1,$2)
       returning *`,
      [stageId, dependsOnStageId],
    );
    return rows[0];
  }

  // Every predecessor link whose either endpoint is a stage of this version
  // (LINA-233). Runs BEFORE deleteStagesByPlanVersion on a draft re-save — the
  // stage DELETE would otherwise fail on the FK `stage_dependency.stage_id →
  // stage.id`. The stage_dependency_freeze_delete_guard trigger refuses this for
  // a frozen/terminal version, mirroring the stage guard (0005).
  async function deleteStageDependenciesByPlanVersion(client, planVersionId) {
    await client.query(
      `delete from schedule.stage_dependency
        where stage_id in (select id from schedule.stage where plan_version_id = $1)
           or depends_on_stage_id in (select id from schedule.stage where plan_version_id = $1)`,
      [planVersionId],
    );
  }

  // The resolved predecessor graph of a version: { stage_id, depends_on_stage_id }
  // rows so `getPlan` can attach each stage's `dependsOn` (stage ids) in one read.
  async function listStageDependenciesByPlanVersion(planVersionId) {
    const { rows } = await pool.query(
      `select d.stage_id, d.depends_on_stage_id
         from schedule.stage_dependency d
         join schedule.stage s on s.id = d.stage_id
        where s.plan_version_id = $1
        order by d.stage_id, d.depends_on_stage_id`,
      [planVersionId],
    );
    return rows;
  }

  // The highest plan position in a project — imported stages append after it so
  // hand-added and imported stages never collide on position.
  async function maxStagePosition(projectId) {
    const { rows } = await pool.query(
      'select coalesce(max(position), 0) as m from schedule.stage where project_id = $1',
      [projectId],
    );
    return Number(rows[0].m ?? 0);
  }

  // The idempotent-confirm summary for a prior import (root = top-level Action,
  // parent_id IS NULL).
  async function importStageCounts(importId) {
    const { rows } = await pool.query(
      `select count(*)::int as stage_count,
              count(*) filter (where parent_id is null)::int as root_count
         from schedule.stage where import_id = $1`,
      [importId],
    );
    return { stageCount: rows[0].stage_count, rootCount: rows[0].root_count };
  }

  // ── Slice B2 plan versioning (LINA-200, contract §3) ──────────────────────

  async function insertPlanVersion(client, row) {
    const { rows } = await client.query(
      `insert into schedule.plan_version
         (id, project_id, version_no, status, source_import_id, supersedes_version_id,
          proposed_by_party_id, created_at, frozen_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning *`,
      [
        row.id, row.project_id, row.version_no, row.status,
        row.source_import_id ?? null, row.supersedes_version_id ?? null,
        row.proposed_by_party_id, row.created_at, row.frozen_at ?? null,
      ],
    );
    return mapPlanVersion(rows[0]);
  }

  async function getPlanVersion(id) {
    const { rows } = await pool.query(
      'select * from schedule.plan_version where id = $1', [id]);
    return mapPlanVersion(rows[0] ?? null);
  }

  // The single open (proposed) version for a project — the negotiation thread.
  async function getOpenPlanVersion(projectId) {
    const { rows } = await pool.query(
      `select * from schedule.plan_version
        where project_id = $1 and status = 'proposed'
        limit 1`, [projectId]);
    return mapPlanVersion(rows[0] ?? null);
  }

  // The single draft (the author's private workspace) for a project, or null.
  // At most one exists (plan_version_one_draft_per_project; LINA-230).
  async function getDraftPlanVersion(projectId) {
    const { rows } = await pool.query(
      `select * from schedule.plan_version
        where project_id = $1 and status = 'draft'
        limit 1`, [projectId]);
    return mapPlanVersion(rows[0] ?? null);
  }

  // Replace a draft's stages in place (LINA-230): delete every stage bound to the
  // version so `:author` can re-write the tree on each save. The DB
  // stage_freeze_delete_guard trigger refuses this for a frozen/terminal version,
  // so the service's "only a draft" check is mirrored in the database.
  async function deleteStagesByPlanVersion(client, planVersionId) {
    await client.query(
      'delete from schedule.stage where plan_version_id = $1', [planVersionId]);
  }

  // Assign the next version_no server-side, inside the append transaction. Reads
  // the max existing number; the per-project advisory lock the ledger takes on
  // append serialises concurrent forks/creations, so no gap-free race here.
  async function nextPlanVersionNo(projectId) {
    const { rows } = await pool.query(
      `select coalesce(max(version_no), 0)::int as n
         from schedule.plan_version where project_id = $1`, [projectId]);
    return Number(rows[0].n ?? 0) + 1;
  }

  // The only envelope mutation: status + (on freeze) frozen_at + (on propose)
  // version_no. Mirrored by a ledger event in the same transaction. Returns the
  // updated row or null. The DB CHECK plan_version_frozen_iff_accepted keeps
  // `accepted` ⟺ `frozen_at` consistent and plan_version_draft_has_no_number
  // keeps `draft` ⟺ NULL version_no; the service supplies frozenAt when freezing
  // and versionNo when proposing a draft (LINA-230). `versionNo` omitted leaves
  // the number untouched (COALESCE), so every existing caller is unchanged.
  async function updatePlanVersionStatus(client, id, { status, frozenAt, versionNo }) {
    const { rows } = await client.query(
      `update schedule.plan_version
          set status = $2,
              frozen_at = $3,
              version_no = coalesce($4, version_no)
        where id = $1
        returning *`,
      [id, status, frozenAt ?? null, versionNo ?? null],
    );
    return rows.length ? mapPlanVersion(rows[0]) : null;
  }

  async function listPlanVersions(projectId) {
    const { rows } = await pool.query(
      `select * from schedule.plan_version
        where project_id = $1
        order by version_no`, [projectId]);
    return rows.map(mapPlanVersion);
  }

  async function insertPlanAcceptance(client, row) {
    const { rows } = await client.query(
      `insert into schedule.plan_acceptance
         (id, plan_version_id, project_id, party_id, kind, stamped_at, audit_event_id)
       values ($1,$2,$3,$4,$5,$6,$7)
       returning *`,
      [row.id, row.plan_version_id, row.project_id, row.party_id, row.kind,
        row.stamped_at, row.audit_event_id],
    );
    return mapAcceptance(rows[0]);
  }

  async function listPlanAcceptances(planVersionId) {
    const { rows } = await pool.query(
      `select * from schedule.plan_acceptance
        where plan_version_id = $1
        order by stamped_at, id`, [planVersionId]);
    return rows.map(mapAcceptance);
  }

  async function getPlanAcceptance(planVersionId, partyId) {
    const { rows } = await pool.query(
      `select * from schedule.plan_acceptance
        where plan_version_id = $1 and party_id = $2`, [planVersionId, partyId]);
    return mapAcceptance(rows[0] ?? null);
  }

  async function upsertProjectBaseline(client, row) {
    const { rows } = await client.query(
      `insert into schedule.project_baseline
         (project_id, plan_version_id, version_no, frozen_at, baseline_audit_event_id)
       values ($1,$2,$3,$4,$5)
       on conflict (project_id) do update
         set plan_version_id = excluded.plan_version_id,
             version_no = excluded.version_no,
             frozen_at = excluded.frozen_at,
             baseline_audit_event_id = excluded.baseline_audit_event_id
       returning *`,
      [row.project_id, row.plan_version_id, row.version_no, row.frozen_at,
        row.baseline_audit_event_id],
    );
    return mapBaseline(rows[0]);
  }

  async function getProjectBaseline(projectId) {
    const { rows } = await pool.query(
      'select * from schedule.project_baseline where project_id = $1', [projectId]);
    return mapBaseline(rows[0] ?? null);
  }

  // The WBS stage rows bound to a version, in plan order. Parent forks remap
  // parent_id to the new stage ids in the service.
  async function listStagesByPlanVersion(planVersionId) {
    const { rows } = await pool.query(
      `select * from schedule.stage
        where plan_version_id = $1
        order by position, seq`, [planVersionId]);
    return rows.map(mapStage);
  }

  async function stageCountByPlanVersion(planVersionId) {
    const { rows } = await pool.query(
      'select count(*)::int as n from schedule.stage where plan_version_id = $1',
      [planVersionId]);
    return Number(rows[0].n ?? 0);
  }

  // ── Slice B3 materials & movement (LINA-217, contract §1) ────────────────

  async function insertLineMaterial(client, row) {
    const { rows } = await client.query(
      `insert into schedule.line_material
         (id, stage_id, project_id, plan_version_id, kind, name, unit,
          quantity, unit_price_cents, position, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       returning *`,
      [row.id, row.stage_id, row.project_id, row.plan_version_id, row.kind,
        row.name, row.unit, row.quantity, row.unit_price_cents, row.position,
        row.created_at, row.updated_at],
    );
    return mapLineMaterial(rows[0]);
  }

  async function getLineMaterial(id) {
    const { rows } = await pool.query(
      'select * from schedule.line_material where id = $1', [id]);
    return mapLineMaterial(rows[0] ?? null);
  }

  const MATERIAL_UPDATABLE = new Set([
    'name', 'unit', 'quantity', 'unit_price_cents', 'position', 'updated_at',
  ]);

  async function updateLineMaterial(client, id, patch) {
    const cols = Object.keys(patch).filter((k) => MATERIAL_UPDATABLE.has(k));
    if (cols.length === 0) return getLineMaterial(id);
    const assignments = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const values = cols.map((c) => patch[c]);
    const { rows } = await client.query(
      `update schedule.line_material set ${assignments} where id = $1 returning *`,
      [id, ...values],
    );
    return rows.length ? mapLineMaterial(rows[0]) : null;
  }

  async function listLineMaterialsByStage(stageId) {
    const { rows } = await pool.query(
      `select * from schedule.line_material
        where stage_id = $1
        order by position, created_at`,
      [stageId],
    );
    return rows.map(mapLineMaterial);
  }

  async function listLineMaterialsByVersion(planVersionId) {
    const { rows } = await pool.query(
      `select * from schedule.line_material where plan_version_id = $1`,
      [planVersionId],
    );
    return rows.map(mapLineMaterial);
  }

  // Append-only INSERT. `seq` is DB-assigned (GENERATED ALWAYS AS IDENTITY).
  async function insertMaterialMovement(client, row) {
    const { rows } = await client.query(
      `insert into schedule.material_movement
         (id, project_id, line_material_id, stage_id, movement_kind, price_cause,
          new_quantity, new_unit_price_cents, value_delta_cents, source,
          change_order_id, moved_by_party_id, occurred_at, audit_event_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       returning *`,
      [row.id, row.project_id, row.line_material_id, row.stage_id, row.movement_kind,
        row.price_cause ?? null, row.new_quantity ?? null, row.new_unit_price_cents ?? null,
        row.value_delta_cents, row.source ?? null, row.change_order_id ?? null,
        row.moved_by_party_id, row.occurred_at, row.audit_event_id],
    );
    return mapMovement(rows[0]);
  }

  async function listMovementsByProject(projectId) {
    const { rows } = await pool.query(
      `select * from schedule.material_movement
        where project_id = $1
        order by occurred_at, seq`,
      [projectId],
    );
    return rows.map(mapMovement);
  }

  async function listMovementsByLine(lineMaterialId) {
    const { rows } = await pool.query(
      `select * from schedule.material_movement
        where line_material_id = $1
        order by occurred_at, seq`,
      [lineMaterialId],
    );
    return rows.map(mapMovement);
  }

  // ── Plan templates (LINA-241, ADR-0018) — mutable CRUD, no ledger seam ──────
  // Each is a single statement (no audit append to co-commit), so none takes a tx.

  async function getSystemDefaultTemplate() {
    const { rows } = await pool.query(
      `select * from schedule.plan_template
        where owner_scope = 'system' and is_default
        limit 1`);
    return mapTemplate(rows[0] ?? null);
  }

  async function getUserDefaultTemplate(ownerId) {
    const { rows } = await pool.query(
      `select * from schedule.plan_template
        where owner_scope = 'user' and owner_id = $1 and is_default
        limit 1`, [ownerId]);
    return mapTemplate(rows[0] ?? null);
  }

  // Upsert the caller's single user default. ON CONFLICT infers the partial
  // unique index plan_template_one_default_per_owner (its WHERE predicate is
  // supplied so postgres matches that exact index), so a second save REPLACES the
  // first — it can never create a 2nd default.
  async function upsertUserDefaultTemplate({ ownerId, name, body }) {
    const { rows } = await pool.query(
      `insert into schedule.plan_template (owner_scope, owner_id, name, is_default, body)
       values ('user', $1, $2, true, $3::jsonb)
       on conflict (owner_scope, owner_id) where is_default
         do update set name = excluded.name,
                       body = excluded.body,
                       updated_at = now()
       returning *`,
      [ownerId, name, JSON.stringify(body)]);
    return mapTemplate(rows[0]);
  }

  return {
    transaction,
    insertStage, getStage, updateStage, listStages, maxStagePosition,
    insertPlanImport, getPlanImportByIdempotencyKey, insertStageDependency,
    deleteStageDependenciesByPlanVersion, listStageDependenciesByPlanVersion,
    importStageCounts,
    insertProgress, listProgressByStage, latestProgressByProject,
    insertPlanVersion, getPlanVersion, getOpenPlanVersion, getDraftPlanVersion,
    deleteStagesByPlanVersion, nextPlanVersionNo,
    updatePlanVersionStatus, listPlanVersions,
    insertPlanAcceptance, listPlanAcceptances, getPlanAcceptance,
    upsertProjectBaseline, getProjectBaseline,
    listStagesByPlanVersion, stageCountByPlanVersion,
    insertLineMaterial, getLineMaterial, updateLineMaterial,
    listLineMaterialsByStage, listLineMaterialsByVersion,
    insertMaterialMovement, listMovementsByProject, listMovementsByLine,
    getSystemDefaultTemplate, getUserDefaultTemplate, upsertUserDefaultTemplate,
  };
}
