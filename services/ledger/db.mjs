// Postgres connection for the Ledger & Budget service.
//
// Serverless × Postgres = connection-storm risk, so we always connect through
// Neon's transaction-mode pooler endpoint (the `-pooler` host in DATABASE_URL)
// and keep a small pool — never raw long-lived connections (ADR-0006 §3).
//
// `withTransaction` is the trust-critical primitive: a projection write and the
// `ledger.append_event(...)` call commit together on ONE connection (ADR-0006
// §1). A throw rolls the whole thing back, so a ledger failure mid-write can
// never leave a projection ahead of the chain.
import pg from 'pg';

const { Pool } = pg;

let sharedPool = null;

// Neon (and any hosted Postgres) requires TLS and its pooler presents a valid
// cert; a local Postgres — the CI service container or a docker throwaway —
// speaks no SSL and drops the connection if we insist on it. Enable TLS unless
// the target is plainly local or has explicitly opted out, so one code path
// serves production, preview, and CI.
export function sslFor(connectionString) {
  const local = !connectionString
    || /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)
    || /[?&]sslmode=disable/.test(connectionString);
  return local ? false : { rejectUnauthorized: false };
}

// A Postgres role name we are willing to interpolate into `SET ROLE`. There is
// no parameter binding for an identifier, so this is an allow-list, not an
// escape: anything that is not a plain lower-snake identifier is refused.
const SAFE_ROLE = /^[a-z_][a-z0-9_]*$/;

/**
 * @param {string} connectionString
 * @param {{ max?: number, role?: string }} [opts]
 * @param opts.role  Run every connection as this role via `SET ROLE`. Neon issues
 *   the `<service>_app` roles as NOLOGIN (they cannot open a connection of their
 *   own), so this is how a service still gets only its own privileges: connect
 *   as the login role, then immediately drop into the service role. Least
 *   privilege is then enforced by Postgres rather than by each service
 *   remembering to behave — which is what the integration tests assert.
 */
export function createPool(connectionString = process.env.DATABASE_URL, { max = 8, role } = {}) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for the ledger service');
  }
  if (role && !SAFE_ROLE.test(role)) {
    throw new Error(`unsafe Postgres role name: ${JSON.stringify(role)}`);
  }
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 10_000,
    ssl: sslFor(connectionString),
  });
  if (role) {
    // node-postgres serialises queries per client in submission order, so this
    // lands before any caller query on the same connection without an await.
    pool.on('connect', (client) => {
      client.query(`SET ROLE ${role}`).catch((err) => {
        // Fail loud and drop the connection: one that silently stayed on the
        // login role would hold MORE privilege than intended.
        console.error(`[db] SET ROLE ${role} failed`, err);
        client.end();
      });
    });
  }
  return pool;
}

export function getPool() {
  if (!sharedPool) sharedPool = createPool();
  return sharedPool;
}

// Run `fn(client)` inside BEGIN/COMMIT on a single pooled connection. Rolls back
// on any throw and always releases the connection.
export async function withTransaction(fn, pool = getPool()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be broken; surface the original error */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = null;
  }
}
