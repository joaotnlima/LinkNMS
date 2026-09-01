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
    scope_note: r.scope_note,
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

// Whitelisted updatable columns (edit / reorder — FR-P1). `set` keys already come
// from the service's own whitelist; this second gate means a stray key can never
// reach the SQL string.
const UPDATABLE = new Set([
  'name', 'position', 'scope_note',
  'planned_start_date', 'planned_end_date', 'planned_cost_cents', 'updated_at',
]);

export function createPgStore({ pool = getPool() } = {}) {
  function transaction(fn) {
    return withTransaction((client) => fn(client), pool);
  }

  // INSERT a stage. `seq` is GENERATED ALWAYS AS IDENTITY — never supplied.
  async function insertStage(client, row) {
    const { rows } = await client.query(
      `insert into schedule.stage
         (id, project_id, name, position, scope_note,
          planned_start_date, planned_end_date, planned_cost_cents,
          created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       returning *`,
      [
        row.id, row.project_id, row.name, row.position, row.scope_note,
        row.planned_start_date, row.planned_end_date, row.planned_cost_cents,
        row.created_at, row.updated_at,
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

  return {
    transaction,
    insertStage, getStage, updateStage, listStages,
    insertProgress, listProgressByStage, latestProgressByProject,
  };
}
