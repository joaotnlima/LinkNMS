// The in-memory idempotency twin used by DB-free module tests: same contract
// as the Postgres reservation (pg-integration.test.mjs proves that one).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryIdempotency } from './idempotency.mjs';

test('no key runs every time; a key replays the first result; another body is a mismatch; a failure leaves no reservation', async () => {
  const idempotent = createInMemoryIdempotency();
  let runs = 0;
  const fn = async () => ({ status: 201, body: { n: ++runs } });
  const meta = { key: 'k', caller: 'u', operationId: 'op', body: { a: 1, b: 2 } };
  await idempotent({ ...meta, key: null }, fn);
  const first = await idempotent(meta, fn);
  const again = await idempotent({ ...meta, body: { b: 2, a: 1 } }, fn);
  assert.deepEqual([first.body, again.body, again.replayed, runs], [{ n: 2 }, { n: 2 }, true, 2]);
  await assert.rejects(idempotent({ ...meta, body: { a: 9 } }, fn), (e) => e.problem?.code === 'idempotency_mismatch');
  await assert.rejects(idempotent({ ...meta, key: 'k2' }, async () => { throw new Error('boom'); }));
  assert.equal((await idempotent({ ...meta, key: 'k2' }, fn)).replayed, false);
});
