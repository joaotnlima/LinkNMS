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

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for the ledger service');
  }
  return new Pool({
    connectionString,
    max: 8,
    idleTimeoutMillis: 10_000,
    // Neon requires TLS; the pooler presents a valid cert.
    ssl: { rejectUnauthorized: false },
  });
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
