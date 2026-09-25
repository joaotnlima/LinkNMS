// Phase-0 acceptance (AGENT-INDEX §5): "append_event + outbox in one txn
// tested". Runs against a THROWAWAY database built from the real v2
// migrations; skipped without DATABASE_URL (CI provides one; locally:
//   DATABASE_URL=postgres://you@localhost:5432/postgres npm test
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendAuditEvent } from './ledger.mjs';
import { publishEvent, dispatchPending } from './outbox.mjs';
import { withIdempotency } from './idempotency.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the platform Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB = 'linknms_platform_test';

const PROJECT = '01920000-0000-7000-8000-000000000001';
const entry = (over = {}) => ({
  projectId: PROJECT,
  actor: { personId: null, orgId: null, orgRole: 'admin' },
  category: 'contracting',
  type: 'contracting.contract.signed',
  scope: { type: 'project', id: PROJECT },
  object: { type: 'contract', id: '01920000-0000-7000-8000-00000000000c' },
  payload: { contract_ref: 'C-1' },
  channel: 'api',
  ...over,
});
const evt = (id, over = {}) => ({
  event_id: `01920000-0000-7000-8000-0000000000${id}`,
  type: 'contracting.contract.signed',
  project_id: PROJECT,
  actor: { person_id: null, org_id: null },
  scope: { type: 'project', id: PROJECT },
  data: {},
  ...over,
});

describe('platform over Postgres (v2 migrations)', { skip }, () => {
  let pg, admin, pool;

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 2 });
    for (const f of ['0001_schema.sql', '0002_platform_idempotency.sql']) {
      await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
    }
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  test('INVARIANT §6.4 — ledger entry and outbox row commit in ONE transaction', async () => {
    const client = await pool.connect();
    try {
      // Rollback leg: both writes succeed, then the transaction dies.
      await client.query('BEGIN');
      await appendAuditEvent(client, entry());
      await publishEvent(client, evt('01'));
      await client.query('ROLLBACK');
      let r = await pool.query('SELECT count(*)::int AS n FROM record.audit_event');
      assert.equal(r.rows[0].n, 0, 'rolled-back ledger entry must not exist');
      r = await pool.query('SELECT count(*)::int AS n FROM platform.outbox');
      assert.equal(r.rows[0].n, 0, 'rolled-back outbox row must not exist');

      // Commit leg: the same pair lands atomically.
      await client.query('BEGIN');
      const seq = await appendAuditEvent(client, entry());
      await publishEvent(client, evt('01'));
      await client.query('COMMIT');
      assert.equal(String(seq), '1');
      r = await pool.query('SELECT seq, entry_hash IS NOT NULL AS hashed FROM record.audit_event WHERE project_id = $1', [PROJECT]);
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].hashed, true);
      r = await pool.query('SELECT dispatched_at FROM platform.outbox WHERE event_id = $1', [evt('01').event_id]);
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].dispatched_at, null);
    } finally {
      client.release();
    }
  });

  test('the chain continues and the ledger is append-only (INVARIANT §6.3)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const seq = await appendAuditEvent(client, entry({ type: 'contracting.contract.activated' }));
      await client.query('COMMIT');
      assert.equal(String(seq), '2');
    } finally {
      client.release();
    }
    const { rows } = await pool.query(
      'SELECT prev_hash, entry_hash FROM record.audit_event WHERE project_id = $1 ORDER BY seq', [PROJECT]);
    assert.equal(rows[0].prev_hash, null);
    assert.deepEqual(rows[1].prev_hash, rows[0].entry_hash, 'entry 2 must chain to entry 1');
    await assert.rejects(
      pool.query('UPDATE record.audit_event SET payload = $1 WHERE seq = 1', ['{}']),
      /append-only/,
    );
    await assert.rejects(pool.query('DELETE FROM record.audit_event WHERE seq = 1'), /append-only/);
  });

  test('dispatcher delivers pending events once and marks them', async () => {
    const seen = [];
    let n = await dispatchPending(pool, { contracting: (e) => seen.push(e.type) });
    assert.equal(n, 1);
    assert.deepEqual(seen, ['contracting.contract.signed']);
    n = await dispatchPending(pool, { contracting: (e) => seen.push(e.type) });
    assert.equal(n, 0, 'dispatched rows are never re-delivered');
  });

  test('Idempotency-Key: replay returns the stored result; different body 409s', async () => {
    const client = await pool.connect();
    const req = { key: 'k-1', caller: 'user_1', operationId: 'createProject', body: { name: 'Casa' } };
    try {
      let calls = 0;
      const run = () => withIdempotency(client, req, async () => {
        calls += 1;
        return { status: 201, body: { id: 'p-1' } };
      });
      const first = await run();
      assert.deepEqual([first.status, first.replayed, calls], [201, false, 1]);
      const replay = await run();
      assert.deepEqual([replay.status, replay.replayed, calls], [201, true, 1]);
      assert.deepEqual(replay.body, { id: 'p-1' });
      await assert.rejects(
        withIdempotency(client, { ...req, body: { name: 'Outra' } }, async () => ({ status: 201, body: {} })),
        (err) => err.problem?.code === 'idempotency_mismatch',
      );
    } finally {
      client.release();
    }
  });

  test('a failed command leaves no reservation — the key is retryable', async () => {
    const client = await pool.connect();
    const req = { key: 'k-2', caller: 'user_1', operationId: 'createProject', body: {} };
    try {
      await client.query('BEGIN');
      await assert.rejects(
        withIdempotency(client, req, async () => { throw new Error('domain write failed'); }),
        /domain write failed/,
      );
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      const retry = await withIdempotency(client, req, async () => ({ status: 201, body: { ok: true } }));
      await client.query('COMMIT');
      assert.deepEqual([retry.status, retry.replayed], [201, false]);
    } finally {
      client.release();
    }
  });
});
