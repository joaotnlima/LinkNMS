// Change Order — the Postgres adapter for the ChangeOrderStore port
// (ADR-0006 §1, design §4.2, §6; FR3–FR8, LINA-51).
//
// Same surface as ports.mjs's `createInMemoryStore`, backed by schema
// `change_order`. It enforces in the DATABASE exactly the invariants the
// in-memory reference enforces in code, so the contract tests and the production
// path agree:
//   - CHECK (decided_by <> proposed_by)            → FR4 two-sided approval
//   - the proposed→decided one-way transition      → atomic conditional UPDATE
//   - UNIQUE(decision_idempotency_key)             → a key is spent exactly once
//   - listByProject ordered by (created_at, seq)   → deterministic FR7 order
//
// The trust-critical part is `transaction(fn)`: it opens ONE Postgres transaction
// and hands the raw pooled `client` to `fn`, which passes that SAME client to both
// this store's writes AND the Ledger port's `append` / `recordBudgetEvent`. The
// change_order projection write and the ledger append therefore COMMIT together
// (ADR-0006 §1) — a ledger failure mid-decide rolls the whole decision back, so a
// projection can never sit ahead of the chain, and the budget can never move
// without its audit event.
//
// Money (cost_delta_cents) is a bigint; `seq`, `schedule_impact_days` come back
// as strings/nums from pg — normalised here so `view()` sees the same shape the
// in-memory store returns. Timestamps are normalised to ISO strings so the
// one-screen view's createdAt/decidedAt match the openapi date-time contract.
import { withTransaction, getPool } from '../ledger/db.mjs';
import { DomainError } from './ports.mjs';

const PG_UNIQUE_VIOLATION = '23505';
const PG_CHECK_VIOLATION = '23514';

const toIso = (v) => (v instanceof Date ? v.toISOString() : v);

// Map a change_order.change_order row to the snake_case shape `view()` consumes.
// bigint columns arrive as strings; cents/seq fit in JS safe-int range for R0.
function mapRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    project_id: r.project_id,
    decision_id: r.decision_id,
    title: r.title,
    cost_delta_cents: Number(r.cost_delta_cents),
    status: r.status,
    proposed_by_party_id: r.proposed_by_party_id,
    decided_by_party_id: r.decided_by_party_id,
    created_at: toIso(r.created_at),
    decided_at: toIso(r.decided_at),
    scope_impact_note: r.scope_impact_note,
    schedule_impact_days: r.schedule_impact_days == null ? null : Number(r.schedule_impact_days),
    schedule_impact_note: r.schedule_impact_note,
    quality_flag: r.quality_flag,
    quality_note: r.quality_note,
    decision_idempotency_key: r.decision_idempotency_key,
  };
}

/**
 * @param {Object} deps
 * @param {import('pg').Pool} [deps.pool]  change_order_app connection pool
 */
export function createPgStore({ pool = getPool() } = {}) {
  // ── Unit of work ────────────────────────────────────────────────────────────
  // fn receives the raw pg client as `tx`; the service passes it to store.insert /
  // store.decide AND ledger.append / ledger.recordBudgetEvent, so all writes
  // commit on one connection (ADR-0006 §1). A throw rolls everything back.
  function transaction(fn) {
    return withTransaction((client) => fn(client), pool);
  }

  // INSERT the proposal. `seq` is GENERATED ALWAYS AS IDENTITY — never supplied.
  // created_at is written explicitly (not defaulted) so it byte-matches the
  // occurredAt the service hands the ledger event.
  async function insert(client, row) {
    const { rows } = await client.query(
      `insert into change_order.change_order
         (id, project_id, decision_id, title, cost_delta_cents, status,
          proposed_by_party_id, decided_by_party_id, created_at, decided_at,
          scope_impact_note, schedule_impact_days, schedule_impact_note,
          quality_flag, quality_note, decision_idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       returning *`,
      [
        row.id, row.project_id, row.decision_id, row.title, row.cost_delta_cents,
        row.status, row.proposed_by_party_id, row.decided_by_party_id,
        row.created_at, row.decided_at, row.scope_impact_note,
        row.schedule_impact_days, row.schedule_impact_note, row.quality_flag,
        row.quality_note, row.decision_idempotency_key,
      ],
    );
    return mapRow(rows[0]);
  }

  async function get(id) {
    const { rows } = await pool.query(
      'select * from change_order.change_order where id = $1', [id],
    );
    return mapRow(rows[0] ?? null);
  }

  // FR7 — chronological per project. Wall-clock first, monotonic `seq` as the
  // deterministic tie-break (created_at alone is not a total order). Matches the
  // change_order_project_created_idx index (project_id, created_at, seq).
  async function listByProject(projectId) {
    const { rows } = await pool.query(
      `select * from change_order.change_order
        where project_id = $1
        order by created_at, seq`,
      [projectId],
    );
    return rows.map(mapRow);
  }

  // Atomic conditional decision write — the proposed→decided one-way transition.
  //   UPDATE … SET status,decided_by,decided_at,idem WHERE id=? AND status='proposed'
  // 0 rows updated ⇒ another writer already decided (lost race) ⇒ {applied:false};
  // the service re-reads and returns the idempotent replay or a 409. The DB's own
  // guards are the backstop the service can't be tricked past:
  //   - CHECK decided_by<>proposed_by (23514) → 403 self_decision
  //   - UNIQUE(decision_idempotency_key) (23505) → 409 idempotency_key_reused
  async function decide(client, { id, status, decidedByPartyId, decidedAt, idempotencyKey }) {
    let rows;
    try {
      ({ rows } = await client.query(
        `update change_order.change_order
            set status = $2,
                decided_by_party_id = $3,
                decided_at = $4,
                decision_idempotency_key = $5
          where id = $1 and status = 'proposed'
          returning *`,
        [id, status, decidedByPartyId, decidedAt, idempotencyKey ?? null],
      ));
    } catch (err) {
      if (err.code === PG_CHECK_VIOLATION
          && String(err.constraint || '').includes('decided_by_is_not_proposer')) {
        throw new DomainError(403, 'self_decision', 'a change order cannot be decided by its proposer');
      }
      if (err.code === PG_UNIQUE_VIOLATION
          && String(err.constraint || '').includes('decision_idempotency_key')) {
        throw new DomainError(409, 'idempotency_key_reused', 'idempotency key already used for another change order');
      }
      throw err;
    }

    if (rows.length === 0) return { applied: false, reason: 'already_decided', row: null };
    return { applied: true, row: mapRow(rows[0]) };
  }

  return { transaction, insert, get, listByProject, decide };
}
