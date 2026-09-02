// Waitlist — the Postgres adapter for the WaitlistStore port (LINA-127; ADR-0006
// §1). Same surface as ports.mjs's `createInMemoryStore`, backed by schema
// `waitlist`. It enforces in the DATABASE exactly the invariants the in-memory
// reference enforces in code, so the contract tests and the production path
// agree:
//   - UNIQUE(email_norm)      → a duplicate signup is rejected (409) at the DB;
//   - status CHECK            → only 'waitlisted' | 'active';
//   - signup_order IDENTITY   → the deterministic "first 10 by signup order".
//
// `transaction(fn)` opens ONE Postgres transaction and hands the raw pooled
// `client` to `fn`, so the signup insert and the welcome-email side effect (if
// any caller chooses to persist one) commit together on one connection.
import { withTransaction, getPool } from '../ledger/db.mjs';
import { DomainError } from './ports.mjs';

const PG_UNIQUE_VIOLATION = '23505';

const toIso = (v) => (v instanceof Date ? v.toISOString() : v);

// Map a waitlist.signup row to the snake_case shape the store returns. bigint
// (signup_order) arrives as a string from pg; normalised to a Number (well within
// JS safe-int range for a waitlist) so the service sees the same shape as the
// in-memory store.
function mapRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    email: r.email,
    email_norm: r.email_norm,
    status: r.status,
    signup_order: Number(r.signup_order),
    created_at: toIso(r.created_at),
    activated_at: r.activated_at == null ? null : toIso(r.activated_at),
  };
}

/**
 * @param {Object} deps
 * @param {import('pg').Pool} [deps.pool]  waitlist_app connection pool
 */
export function createPgStore({ pool = getPool() } = {}) {
  // Unit of work — fn receives the raw pg client as `tx`.
  function transaction(fn) {
    return withTransaction((client) => fn(client), pool);
  }

  // INSERT a new signup. UNIQUE(email_norm) is the dedupe backstop: a duplicate
  // surfaces (23505) which the service translates to a 409 `duplicate`. signup_order
  // is GENERATED ALWAYS AS IDENTITY — never supplied.
  async function insert(client, row) {
    try {
      const { rows } = await client.query(
        `insert into waitlist.signup (id, email, email_norm, status, created_at)
         values ($1,$2,$3,$4,$5)
         returning *`,
        [row.id, row.email, row.email_norm, row.status, row.created_at],
      );
      return { duplicate: false, row: mapRow(rows[0]) };
    } catch (err) {
      if (err.code === PG_UNIQUE_VIOLATION
          && String(err.constraint || '').includes('signup_email_norm_key')) {
        return { duplicate: true, row: null };
      }
      throw err;
    }
  }

  async function getByEmail(emailNorm) {
    const { rows } = await pool.query(
      'select * from waitlist.signup where email_norm = $1', [emailNorm],
    );
    return mapRow(rows[0] ?? null);
  }

  async function get(id) {
    const { rows } = await pool.query(
      'select * from waitlist.signup where id = $1', [id],
    );
    return mapRow(rows[0] ?? null);
  }

  // The plan's "first 10, by signup order" on the go-date (Phase 2). Ordered by
  // the monotonic signup_order — a deterministic total order, never timestamps.
  async function listByStatusOrder(status, limit = Infinity) {
    const { rows } = await pool.query(
      `select * from waitlist.signup
        where status = $1
        order by signup_order
        limit $2`,
      [status, Number.isFinite(limit) ? limit : null],
    );
    return rows.map(mapRow);
  }

  // Mark a signup active on first login (Phase 2 lifecycle: waitlisted → active).
  async function updateStatus(client, emailNorm, status, activatedAt) {
    const { rows } = await client.query(
      `update waitlist.signup
          set status = $2, activated_at = $3
        where email_norm = $1
        returning *`,
      [emailNorm, status, activatedAt ?? null],
    );
    if (rows.length === 0) return { applied: false, row: null };
    return { applied: true, row: mapRow(rows[0]) };
  }

  return { transaction, insert, getByEmail, get, listByStatusOrder, updateStatus };
}

export { DomainError };
