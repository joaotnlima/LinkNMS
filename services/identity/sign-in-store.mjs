// Sign-in token persistence port + an in-memory reference and a Postgres adapter
// (LINA-76; ADR-0007). Same discipline as ./store.mjs: the sign-in SERVICE
// (./sign-in.mjs) is written against this port, not against Postgres, so it runs
// and is adversarially tested with zero dependencies, and the pg adapter
// re-implements storage only — never the logic.
//
// PORT:
//   countRecentByEmail(email, sinceIso) -> number   (per-email rate limit)
//   countRecentByIp(ip, sinceIso)       -> number   (per-IP rate limit)
//   insertToken(row)                    -> void      (mint; stores token_hash only)
//   consumeToken(tokenHash, nowIso)     -> { email, displayName } | null
//   hasActiveSeat(email)                -> boolean   (the ADR-0008 seat gate)
//
// consumeToken is THE trust-critical operation: it must be a single atomic
// conditional update — "flip consumed_at to now WHERE it is still null AND not
// expired, RETURNING the row" — never a SELECT-then-UPDATE. Two concurrent
// consumes of one link must yield exactly one session (ADR-0007 §1). In Postgres
// that is one UPDATE statement. In memory it is a single synchronous check-and-set
// with no await between the read and the write, which is atomic under Node's
// single-threaded model — so the double-consume test proves the same invariant
// against both adapters.

import { getPool } from '../ledger/db.mjs';

// ── In-memory reference ────────────────────────────────────────────────────────
export function createMemorySignInStore({ seats = [] } = {}) {
  /** @type {Map<string, any>} tokenHash -> row */
  const tokens = new Map();
  // The in-memory seat allowlist mirrors `identity.seat WHERE status='active'`:
  // tests seed it with the addresses that hold a seat and nothing else.
  const seated = new Set(seats.map((e) => String(e).trim().toLowerCase()));

  function countRecentByEmail(email, sinceIso) {
    let n = 0;
    for (const t of tokens.values()) {
      if (t.email === email && t.createdAt >= sinceIso) n += 1;
    }
    return n;
  }

  function countRecentByIp(ip, sinceIso) {
    if (!ip) return 0;
    let n = 0;
    for (const t of tokens.values()) {
      if (t.requestIp === ip && t.createdAt >= sinceIso) n += 1;
    }
    return n;
  }

  function insertToken(row) {
    if (tokens.has(row.tokenHash)) throw new Error('sign-in token hash collision');
    tokens.set(row.tokenHash, { ...row, consumedAt: null });
  }

  // Atomic single-use consume: one synchronous pass, no await between the guard
  // and the mutation, so two concurrent callers cannot both win (ADR-0007 §1).
  function consumeToken(tokenHash, nowIso) {
    const t = tokens.get(tokenHash);
    if (!t) return null;
    if (t.consumedAt !== null) return null; // already used
    if (t.expiresAt <= nowIso) return null; // expired
    t.consumedAt = nowIso;
    return { email: t.email, displayName: t.displayName ?? null };
  }

  function hasActiveSeat(email) {
    return seated.has(email);
  }

  // Test affordance only — production seats are granted out of band, and
  // identity_app holds no INSERT on identity.seat precisely so the request path
  // cannot seat anybody (0004_identity.sql).
  function grantSeat(email) {
    seated.add(String(email).trim().toLowerCase());
  }

  return { countRecentByEmail, countRecentByIp, insertToken, consumeToken, hasActiveSeat, grantSeat };
}

// ── Postgres adapter (schema `identity`, migrations/0003_identity.sql) ──────────
export function createPgSignInStore({ pool = getPool() } = {}) {
  async function countRecentByEmail(email, sinceIso) {
    const { rows } = await pool.query(
      'select count(*)::int as n from identity.sign_in_token where email = $1 and created_at >= $2',
      [email, sinceIso],
    );
    return rows[0].n;
  }

  async function countRecentByIp(ip, sinceIso) {
    if (!ip) return 0;
    const { rows } = await pool.query(
      'select count(*)::int as n from identity.sign_in_token where request_ip = $1 and created_at >= $2',
      [ip, sinceIso],
    );
    return rows[0].n;
  }

  async function insertToken(row) {
    await pool.query(
      `insert into identity.sign_in_token
         (id, email, display_name, token_hash, request_ip, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [row.id, row.email, row.displayName ?? null, row.tokenHash, row.requestIp ?? null, row.createdAt, row.expiresAt],
    );
  }

  // ONE statement: the WHERE clause is the guard and the RETURNING is the proof
  // of who won. A replayed/expired/unknown token touches zero rows and returns
  // null — the service maps all three to the same 400 invalid_token (ADR-0007 §4).
  async function consumeToken(tokenHash, nowIso) {
    const { rows } = await pool.query(
      `update identity.sign_in_token
          set consumed_at = $2
        where token_hash = $1
          and consumed_at is null
          and expires_at > $2
      returning email, display_name`,
      [tokenHash, nowIso],
    );
    if (rows.length === 0) return null;
    return { email: rows[0].email, displayName: rows[0].display_name ?? null };
  }

  // The gate (ADR-0008). A point lookup against the partial index; SELECT is the
  // only grant identity_app holds on this table, so the request path can read
  // who is allowed in but can never add somebody.
  async function hasActiveSeat(email) {
    const { rows } = await pool.query(
      "select 1 from identity.seat where email = $1 and status = 'active' limit 1",
      [email],
    );
    return rows.length > 0;
  }

  return { countRecentByEmail, countRecentByIp, insertToken, consumeToken, hasActiveSeat };
}
