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
    assignee_party_id: r.assignee_party_id ?? null,
    import_id: r.import_id,
    plan_version_id: r.plan_version_id,
    key: r.key ?? null,
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
    stage_key: r.stage_key ?? null,
    project_id: r.project_id,
    status: r.status,
    percent: r.percent == null ? null : Number(r.percent),
    note: r.note,
    reported_by_party_id: r.reported_by_party_id,
    reported_at: toIso(r.reported_at),
  };
}

// A task-workspace comment row (LINA-249). API shape uses the domain names the
// HTTP layer emits; the store keeps snake_case like every other mapper.
function mapComment(r) {
  if (!r) return null;
  return {
    id: r.id,
    project_id: r.project_id,
    stage_key: r.stage_key,
    author_party_id: r.author_party_id,
    body: r.body,
    created_at: toIso(r.created_at),
  };
}

// A task-workspace attachment row (LINA-249). size_bytes is bigint → string from
// pg; normalised to a number like planned_cost_cents.
function mapAttachment(r) {
  if (!r) return null;
  return {
    id: r.id,
    project_id: r.project_id,
    stage_key: r.stage_key,
    uploader_party_id: r.uploader_party_id,
    file_name: r.file_name,
    content_type: r.content_type,
    size_bytes: toNum(r.size_bytes),
    blob_url: r.blob_url,
    created_at: toIso(r.created_at),
  };
}

// Project phase + sign-off shapers (LINA-278, ADR-0023). responsible_party_ids
// is a uuid[] — pg returns it as a JS array already; default to [] defensively.
function mapPhase(r) {
  if (!r) return null;
  return {
    id: r.id,
    project_id: r.project_id,
    kind: r.kind,
    name: r.name,
    status: r.status,
    sequence: toNum(r.sequence),
    responsible_party_ids: r.responsible_party_ids ?? [],
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
  };
}

function mapSignOff(r) {
  if (!r) return null;
  return {
    id: r.id,
    phase_id: r.phase_id,
    requested_by: r.requested_by,
    requested_at: toIso(r.requested_at),
    status: r.status,
    resolved_at: r.resolved_at ? toIso(r.resolved_at) : null,
    resolution_comment: r.resolution_comment ?? null,
  };
}

// Pre-sign-off plan-edit audit row (LINA-280, ADR-0023 §8). old_value/new_value
// are jsonb; pg returns them already parsed, so no JSON.parse here.
function mapPlanChangeLog(r) {
  if (!r) return null;
  return {
    id: r.id,
    phase_id: r.phase_id,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    field_name: r.field_name,
    old_value: r.old_value ?? null,
    new_value: r.new_value ?? null,
    actor_party_id: r.actor_party_id ?? null,
    occurred_at: toIso(r.occurred_at),
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

// A specialty row (LINA-306). snake_case matches the in-memory store; the domain
// layer shapes the API view.
function mapSpecialty(r) {
  if (!r) return null;
  return {
    id: r.id,
    owner_scope: r.owner_scope,
    owner_id: r.owner_id,
    label: r.label,
    created_at: toIso(r.created_at),
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
  // (nullable; null for hand-added stages). `key` (LINA-249) is the stable
  // client-minted identity the task-workspace tables anchor on — only
  // `:author` supplies it; every other call site passes undefined → NULL.
  async function insertStage(client, row) {
    const { rows } = await client.query(
      `insert into schedule.stage
         (id, project_id, name, position, parent_id, trade, assignee_party_id,
          import_id, source_row_ref, key,
          scope_note, description, planned_start_date, planned_end_date, planned_cost_cents,
          plan_version_id, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       returning *`,
      [
        row.id, row.project_id, row.name, row.position, row.parent_id ?? null,
        row.trade ?? null, row.assignee_party_id ?? null,
        row.import_id ?? null, row.source_row_ref ?? null,
        row.key ?? null,
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

  // Resolve a stage by its STABLE key within a project (LINA-306). A draft
  // re-save re-mints the stage row id (deleteStagesByPlanVersion + re-insert),
  // so a client holding an older id 404s on getStage — but the key never moves.
  // Progress already anchors on (project_id, stage_key), so any surviving row
  // for the key gives us the same project + key + authorization context. Newest
  // by seq wins (the freshest surviving row for that key).
  async function getCurrentStageByKey(projectId, key) {
    const { rows } = await pool.query(
      'select * from schedule.stage where project_id = $1 and key = $2 order by seq desc limit 1',
      [projectId, key]);
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
         (id, stage_id, stage_key, project_id, status, percent, note, reported_by_party_id, reported_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning *`,
      [
        row.id, row.stage_id, row.stage_key ?? null, row.project_id, row.status,
        row.percent, row.note, row.reported_by_party_id, row.reported_at,
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

  // The single latest progress row per STAGE KEY in a project (LINA-307). The
  // key-anchored twin of latestProgressByProject: status survives a draft re-save
  // that re-mints stage row ids, so this is the derivation input for a draft's
  // current status. Rows with a NULL stage_key (legacy, pre-LINA-307) are absent
  // here and fall through to the by-id map in the service's derivation.
  async function latestProgressByProjectKey(projectId) {
    const { rows } = await pool.query(
      `select distinct on (stage_key) *
         from schedule.stage_progress
        where project_id = $1 and stage_key is not null
        order by stage_key, reported_at desc, seq desc`,
      [projectId],
    );
    const out = new Map();
    for (const r of rows) out.set(r.stage_key, mapProgress(r));
    return out;
  }

  // Full attributed history for one stage KEY in a project, oldest→newest
  // (LINA-307). The key-anchored twin of listProgressByStage — used for the
  // note-required state-machine check and the single-stage history read, so a
  // draft re-mint never loses "current".
  async function listProgressByKey(projectId, stageKey) {
    const { rows } = await pool.query(
      `select * from schedule.stage_progress
        where project_id = $1 and stage_key = $2
        order by reported_at, seq`,
      [projectId, stageKey],
    );
    return rows.map(mapProgress);
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

  // dep_type (migration 0010, ADR-0020): starts_after (FS, the default) ·
  // starts_with (SS) · ends_with (FF). Bare-string authoring and the import path
  // land as starts_after via the column default when depType is omitted.
  async function insertStageDependency(client, stageId, dependsOnStageId, depType = 'starts_after') {
    const { rows } = await client.query(
      `insert into schedule.stage_dependency (stage_id, depends_on_stage_id, dep_type)
       values ($1,$2,$3)
       returning *`,
      [stageId, dependsOnStageId, depType],
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

  // The resolved predecessor graph of a version: { stage_id, depends_on_stage_id,
  // dep_type } rows so `getPlan` can attach each stage's `dependsOn` (stage ids)
  // and typed `dependencies` in one read.
  async function listStageDependenciesByPlanVersion(planVersionId) {
    const { rows } = await pool.query(
      `select d.stage_id, d.depends_on_stage_id, d.dep_type
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

  // ── Task workspace (LINA-249) — comments & attachments ─────────────────────
  // Append-only collaboration rows anchored on (project_id, stage_key), NOT
  // stage row ids (a draft re-save churns ids; the key survives). The schema
  // grants are INSERT/SELECT only — no update/delete surface exists here by
  // construction, mirroring stage_progress. No ledger seam: these rows are
  // chatter, not agreement change.

  // Is a stage key LIVE on the project, i.e. does it address a stage on the
  // shared record or its author's open draft? "Current plan or open draft": the
  // OPEN proposal, the draft, the AGREED baseline, or a pre-versioning legacy
  // stage (v.id IS NULL). A key whose only stage sits on a terminal version
  // (withdrawn/rejected/superseded, or an accepted version displaced by a newer
  // baseline) is NOT addressable — the workspace rejects it with a 404. The
  // caller has ALREADY authorized membership before this runs, though the query
  // is project-scoped regardless.
  async function stageLiveByKey(projectId, stageKey) {
    const { rows } = await pool.query(
      `select 1 from schedule.stage s
         left join schedule.plan_version v on v.id = s.plan_version_id
        where s.project_id = $1 and s.key = $2
          and (v.id is null or v.status in ('draft','proposed','accepted'))
        limit 1`,
      [projectId, stageKey],
    );
    return rows.length > 0;
  }

  async function insertStageComment(client, row) {
    const { rows } = await client.query(
      `insert into schedule.stage_comment
         (id, project_id, stage_key, author_party_id, body, created_at)
       values ($1,$2,$3,$4,$5,$6)
       returning *`,
      [row.id, row.project_id, row.stage_key, row.author_party_id, row.body, row.created_at],
    );
    return mapComment(rows[0]);
  }

  // Oldest → newest; (created_at, id) is the deterministic total order (ids are
  // uuids only to break timestamp ties).
  async function listStageCommentsByKey(projectId, stageKey) {
    const { rows } = await pool.query(
      `select * from schedule.stage_comment
        where project_id = $1 and stage_key = $2
        order by created_at, id`,
      [projectId, stageKey],
    );
    return rows.map(mapComment);
  }

  async function insertStageAttachment(client, row) {
    const { rows } = await client.query(
      `insert into schedule.stage_attachment
         (id, project_id, stage_key, uploader_party_id, file_name, content_type,
          size_bytes, blob_url, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning *`,
      [row.id, row.project_id, row.stage_key, row.uploader_party_id,
        row.file_name, row.content_type, row.size_bytes, row.blob_url, row.created_at],
    );
    return mapAttachment(rows[0]);
  }

  async function listStageAttachmentsByKey(projectId, stageKey) {
    const { rows } = await pool.query(
      `select * from schedule.stage_attachment
        where project_id = $1 and stage_key = $2
        order by created_at, id`,
      [projectId, stageKey],
    );
    return rows.map(mapAttachment);
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

  // ── Specialty catalog (LINA-306) — suggest list, no ledger seam ─────────────
  // Single-statement reads/writes (no audit append), so none takes a tx.

  // system rows ∪ this party's own. Ordering is applied in the service (it also
  // de-dupes), so this returns the raw union.
  async function listSpecialties(ownerId) {
    const { rows } = await pool.query(
      `select * from schedule.specialty
        where owner_scope = 'system' or (owner_scope = 'user' and owner_id = $1)`,
      [ownerId]);
    return rows.map(mapSpecialty);
  }

  // Create one owned by the caller. Idempotent by specialty_unique_label_per_owner
  // (the case-insensitive partial index): re-creating a label the caller already
  // owns returns the existing row rather than raising. If the label collides only
  // with a SYSTEM row, ON CONFLICT does not fire (different owner_scope) — so we
  // check for that first and hand the system row back instead of storing a copy.
  async function createUserSpecialty({ ownerId, label }) {
    const existingSystem = await pool.query(
      `select * from schedule.specialty
        where owner_scope = 'system' and lower(btrim(label)) = lower(btrim($1))
        limit 1`, [label]);
    if (existingSystem.rows[0]) return mapSpecialty(existingSystem.rows[0]);

    const { rows } = await pool.query(
      `insert into schedule.specialty (owner_scope, owner_id, label)
       values ('user', $1, $2)
       on conflict (owner_scope, owner_id, lower(btrim(label)))
         do update set label = schedule.specialty.label
       returning *`,
      [ownerId, label]);
    return mapSpecialty(rows[0]);
  }

  // ── Project phases + sign-off (LINA-278, ADR-0023) ──────────────────────────

  // Idempotent seed insert. ON CONFLICT (project_id, kind) DO NOTHING makes a
  // concurrent seed a no-op (returns null) rather than a unique violation that
  // would abort the surrounding transaction — mirrors the in-memory contract.
  async function insertPhase(client, row) {
    const { rows } = await client.query(
      `insert into schedule.project_phase
         (id, project_id, kind, name, status, sequence, responsible_party_ids,
          created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (project_id, kind) do nothing
       returning *`,
      [row.id, row.project_id, row.kind, row.name, row.status, row.sequence,
        row.responsible_party_ids ?? [], row.created_at, row.updated_at],
    );
    return rows.length ? mapPhase(rows[0]) : null;
  }

  async function listPhasesByProject(projectId) {
    const { rows } = await pool.query(
      `select * from schedule.project_phase
        where project_id = $1
        order by sequence`,
      [projectId]);
    return rows.map(mapPhase);
  }

  async function getPhaseById(id) {
    const { rows } = await pool.query(
      'select * from schedule.project_phase where id = $1', [id]);
    return mapPhase(rows[0] ?? null);
  }

  async function getPhaseByKind(projectId, kind) {
    const { rows } = await pool.query(
      'select * from schedule.project_phase where project_id = $1 and kind = $2',
      [projectId, kind]);
    return mapPhase(rows[0] ?? null);
  }

  async function countPhasesByProject(projectId) {
    const { rows } = await pool.query(
      'select count(*)::int as n from schedule.project_phase where project_id = $1',
      [projectId]);
    return rows[0].n;
  }

  // In-place status walk. The DB trigger project_phase_signed_off_one_way rejects
  // any attempt to walk a signed_off phase back out (raised as P0001).
  async function updatePhaseStatus(client, id, status) {
    const { rows } = await client.query(
      `update schedule.project_phase
          set status = $2, updated_at = now()
        where id = $1
       returning *`,
      [id, status]);
    return rows.length ? mapPhase(rows[0]) : null;
  }

  async function insertSignOffRequest(client, row) {
    const { rows } = await client.query(
      `insert into schedule.phase_sign_off_request
         (id, phase_id, requested_by, requested_at, status, resolved_at, resolution_comment)
       values ($1,$2,$3,$4,$5,$6,$7)
       returning *`,
      [row.id, row.phase_id, row.requested_by, row.requested_at, row.status,
        row.resolved_at ?? null, row.resolution_comment ?? null]);
    return mapSignOff(rows[0]);
  }

  async function getSignOffRequest(id) {
    const { rows } = await pool.query(
      'select * from schedule.phase_sign_off_request where id = $1', [id]);
    return mapSignOff(rows[0] ?? null);
  }

  async function listSignOffRequestsByPhase(phaseId) {
    const { rows } = await pool.query(
      `select * from schedule.phase_sign_off_request
        where phase_id = $1
        order by requested_at, id`,
      [phaseId]);
    return rows.map(mapSignOff);
  }

  // Resolve a pending request in place (approve/reject). The WHERE status =
  // 'pending' guard makes this a no-op (null) if the request was already
  // resolved by a concurrent call — the service maps that to a typed 409.
  async function resolveSignOffRequest(client, id, { status, resolvedAt, resolutionComment }) {
    const { rows } = await client.query(
      `update schedule.phase_sign_off_request
          set status = $2, resolved_at = $3, resolution_comment = $4
        where id = $1 and status = 'pending'
       returning *`,
      [id, status, resolvedAt, resolutionComment ?? null]);
    return rows.length ? mapSignOff(rows[0]) : null;
  }

  // ── plan_change_log — append-only pre-sign-off audit (LINA-280, ADR-0023 §8) ──
  // old_value/new_value are jsonb; a JS scalar is serialised with ::jsonb, and an
  // undefined value lands as SQL NULL (no prior value), distinct from a jsonb
  // `null` (a field explicitly cleared). SELECT+INSERT grant only — never updated.
  async function insertPlanChangeLog(client, row) {
    const oldJson = row.old_value === undefined ? null : JSON.stringify(row.old_value);
    const newJson = row.new_value === undefined ? null : JSON.stringify(row.new_value);
    const { rows } = await client.query(
      `insert into schedule.plan_change_log
         (id, phase_id, entity_type, entity_id, field_name,
          old_value, new_value, actor_party_id, occurred_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)
       returning *`,
      [row.id, row.phase_id, row.entity_type, row.entity_id, row.field_name,
        oldJson, newJson, row.actor_party_id ?? null, row.occurred_at]);
    return mapPlanChangeLog(rows[0]);
  }

  async function listPlanChangeLogByPhase(phaseId) {
    const { rows } = await pool.query(
      `select * from schedule.plan_change_log
        where phase_id = $1
        order by occurred_at, id`,
      [phaseId]);
    return rows.map(mapPlanChangeLog);
  }

  return {
    transaction,
    insertPhase, listPhasesByProject, getPhaseById, getPhaseByKind,
    countPhasesByProject, updatePhaseStatus,
    insertSignOffRequest, getSignOffRequest, listSignOffRequestsByPhase, resolveSignOffRequest,
    insertPlanChangeLog, listPlanChangeLogByPhase,
    insertStage, getStage, getCurrentStageByKey, updateStage, listStages, maxStagePosition,
    insertPlanImport, getPlanImportByIdempotencyKey, insertStageDependency,
    deleteStageDependenciesByPlanVersion, listStageDependenciesByPlanVersion,
    importStageCounts,
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
  };
}
