// Decision Log — the Postgres adapter for the store port
// (ADR-0006 §1, design §3, §4.1; FR2, FR7; LINA-56).
//
// Same surface as memory-adapters.mjs's `createMemoryStore`, backed by schema
// `decision`. It mirrors, in the DATABASE, the two rules the in-memory reference
// enforces in code, so the contract tests and the production path agree:
//   - UNIQUE(decision_id, rev)      → a revision can only ever APPEND; rev 1 is
//                                     never replaced and no past row is mutated
//                                     (reinforced by the GRANT: decision_app has
//                                     no UPDATE/DELETE on decision_revision)
//   - listDecisions ordered by (created_at, seq) → deterministic FR7 order
//
// The trust-critical part is `transaction(work)`: it opens ONE Postgres
// transaction and hands `work` a tx object that is BOTH the store's unit-of-work
// AND a pg client (it proxies `query` to the pooled connection). The decision
// service passes that same tx to `ledger.append(tx, …)`, so the projection write
// and `ledger.append_event(...)` COMMIT together (ADR-0006 §1) — exactly as
// LINA-51 did for change orders. A ledger failure mid-record rolls the whole
// write back, so a projection can never sit ahead of the chain.
//
// Timestamps are normalised to ISO strings so the API shape matches the
// openapi.yaml date-time contract and the in-memory adapter byte-for-byte.
import { withTransaction, getPool } from '../ledger/db.mjs';
import { DecisionError } from './decision-log.mjs';

const PG_UNIQUE_VIOLATION = '23505';

const toIso = (v) => (v instanceof Date ? v.toISOString() : v);

// decision.decision row → the shape the service/`toView` consume.
const mapDecision = (r) => r && {
  id: r.id,
  projectId: r.project_id,
  createdByPartyId: r.created_by_party_id,
  createdAt: toIso(r.created_at),
  currentRev: Number(r.current_rev),
};

// decision.decision_revision row → the service's revision shape.
const mapRevision = (r) => r && {
  id: r.id,
  decisionId: r.decision_id,
  rev: Number(r.rev),
  title: r.title,
  body: r.body,
  revisedByPartyId: r.revised_by_party_id,
  revisedAt: toIso(r.revised_at),
  auditEventId: r.audit_event_id,
};

/**
 * @param {Object} deps
 * @param {import('pg').Pool} [deps.pool]  decision_app connection pool
 */
export function createPgStore({ pool = getPool() } = {}) {
  // ── Reads (no transaction) ──────────────────────────────────────────────────
  async function getDecisionById(id) {
    const { rows } = await pool.query('select * from decision.decision where id = $1', [id]);
    return mapDecision(rows[0] ?? null);
  }

  async function getDecision(projectId, id) {
    const { rows } = await pool.query(
      'select * from decision.decision where id = $1 and project_id = $2', [id, projectId],
    );
    return mapDecision(rows[0] ?? null);
  }

  async function listRevisions(decisionId) {
    const { rows } = await pool.query(
      'select * from decision.decision_revision where decision_id = $1 order by rev',
      [decisionId],
    );
    return rows.map(mapRevision);
  }

  // FR7 — chronological per project. Wall-clock first, the monotonic `seq` as the
  // deterministic tie-break (created_at alone is not a total order). Matches the
  // decision_project_created_idx index (project_id, created_at, seq).
  async function listDecisions(projectId) {
    const { rows } = await pool.query(
      `select * from decision.decision
        where project_id = $1
        order by created_at, seq`,
      [projectId],
    );
    return rows.map(mapDecision);
  }

  // Portfolio card counts (GET /projects, ADR-0012 §A1): how many decisions each
  // of a batch of projects has, in ONE grouped query (no per-card list fold).
  // Returns projectId → count; projects with zero are simply absent from the map.
  async function countProjects(projectIds) {
    if (projectIds.length === 0) return new Map();
    const { rows } = await pool.query(
      `select project_id::text as project_id, count(*)::int as n
         from decision.decision
        where project_id = any($1)
        group by project_id`,
      [projectIds],
    );
    return new Map(rows.map((r) => [r.project_id, r.n]));
  }

  // ── Unit of work ────────────────────────────────────────────────────────────
  // `work` receives a tx that is simultaneously:
  //   * the store's mutation surface (insertDecision / insertRevision / …), and
  //   * a pg client proxy (`query`), which is what the pg ledger's
  //     `append(client, …)` needs.
  // One connection, one BEGIN/COMMIT — projection and ledger append are atomic.
  function transaction(work) {
    return withTransaction(async (client) => {
      const tx = {
        // Ledger port compatibility: pg-ledger.append() only ever calls
        // `client.query(...)`, so proxying it is enough to put the hash-chain
        // append on this exact transaction.
        query: (...args) => client.query(...args),

        async insertDecision(row) {
          const { rows } = await client.query(
            `insert into decision.decision
               (id, project_id, created_by_party_id, created_at, current_rev)
             values ($1, $2, $3, $4, $5)
             returning *`,
            [row.id, row.projectId, row.createdByPartyId, row.createdAt, row.currentRev],
          );
          return mapDecision(rows[0]);
        },

        // Append-only. UNIQUE(decision_id, rev) is the backstop the service
        // cannot be tricked past: two writers racing on the same next rev — one
        // commits, the other gets 23505 and is surfaced as a clean 409 rather
        // than silently clobbering a revision.
        async insertRevision(row) {
          try {
            const { rows } = await client.query(
              `insert into decision.decision_revision
                 (id, decision_id, rev, title, body, revised_by_party_id, revised_at, audit_event_id)
               values ($1, $2, $3, $4, $5, $6, $7, $8)
               returning *`,
              [
                row.id, row.decisionId, row.rev, row.title, row.body,
                row.revisedByPartyId, row.revisedAt, row.auditEventId,
              ],
            );
            return mapRevision(rows[0]);
          } catch (err) {
            if (err.code === PG_UNIQUE_VIOLATION
                && String(err.constraint || '').includes('decision_rev')) {
              throw new DecisionError(
                409, 'revision_conflict',
                'another revision was written concurrently — retry',
              );
            }
            throw err;
          }
        },

        // Pointer only — the prior revision rows are left untouched (FR2).
        async setCurrentRev(id, rev) {
          await client.query(
            'update decision.decision set current_rev = $2 where id = $1', [id, rev],
          );
        },

        // Row lock: serialises concurrent revisions of the SAME decision, so
        // `maxRev + 1` below is computed against a stable head.
        async getDecisionForUpdate(id) {
          const { rows } = await client.query(
            'select * from decision.decision where id = $1 for update', [id],
          );
          return mapDecision(rows[0] ?? null);
        },

        async maxRev(decisionId) {
          const { rows } = await client.query(
            'select coalesce(max(rev), 0) as max from decision.decision_revision where decision_id = $1',
            [decisionId],
          );
          return Number(rows[0].max);
        },
      };
      return work(tx);
    }, pool);
  }

  return {
    transaction,
    getDecision,
    getDecisionById,
    listRevisions,
    listDecisions,
    countProjects,
  };
}
