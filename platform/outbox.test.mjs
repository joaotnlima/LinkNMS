import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateEnvelope, publishEvent, dispatchPending, combineConsumers, runDispatchTick,
} from './outbox.mjs';

const EVT = Object.freeze({
  event_id: '0192aaaa-bbbb-7ccc-8ddd-eeeeffff0001',
  type: 'contracting.contract.signed',
  actor: { person_id: 'p1', org_id: 'o1' },
  scope: { type: 'contract', id: 'c1' },
  data: {},
});

describe('envelope validation (doc 10)', () => {
  test('accepts the doc-10 envelope', () => {
    assert.deepEqual(validateEnvelope({ ...EVT }), EVT);
  });

  for (const [why, patch] of [
    ['missing event_id', { event_id: undefined }],
    ['type without module.aggregate.event shape', { type: 'signed' }],
    ['unknown scope type', { scope: { type: 'everyone', id: 'x' } }],
    ['missing data', { data: undefined }],
    ['missing actor', { actor: undefined }],
  ]) {
    test(`rejects ${why}`, () => {
      assert.throws(() => validateEnvelope({ ...EVT, ...patch }), /invalid event envelope/);
    });
  }
});

describe('publishEvent', () => {
  test('inserts on the CALLER’S client — same transaction as the domain write', async () => {
    const calls = [];
    const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
    await publishEvent(client, { ...EVT });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO platform\.outbox/);
    assert.equal(calls[0].params[0], EVT.event_id);
    assert.equal(calls[0].params[2], 1); // default version
  });

  test('refuses an invalid envelope before touching the database', async () => {
    const client = { query: async () => { throw new Error('must not be called'); } };
    await assert.rejects(publishEvent(client, { ...EVT, type: 'bad' }), /invalid event envelope/);
  });
});

describe('dispatchPending', () => {
  function fakePool(rows) {
    const marked = [];
    return {
      marked,
      query: async (sql, params) => {
        if (/SELECT/.test(sql)) return { rows };
        if (/UPDATE platform\.outbox/.test(sql)) { marked.push(params[0]); return { rows: [] }; }
        throw new Error(`unexpected sql: ${sql}`);
      },
    };
  }

  test('delivers to prefix-matched handlers, then marks dispatched', async () => {
    const rows = [
      { ...EVT, event_id: 'e1' },
      { ...EVT, event_id: 'e2', type: 'planning.task.updated' },
    ];
    const pool = fakePool(rows);
    const seen = [];
    const n = await dispatchPending(pool, { 'planning.task': (e) => seen.push(e.event_id) });
    assert.equal(n, 2);
    assert.deepEqual(seen, ['e2']);
    assert.deepEqual(pool.marked, ['e1', 'e2']); // unmatched rows still complete
  });

  test('a throwing handler stops the batch and leaves the row undispatched (retry keeps order)', async () => {
    const rows = [{ ...EVT, event_id: 'e1' }, { ...EVT, event_id: 'e2' }];
    const pool = fakePool(rows);
    await assert.rejects(
      dispatchPending(pool, { contracting: () => { throw new Error('consumer down'); } }),
      /consumer down/,
    );
    assert.deepEqual(pool.marked, []);
  });
});

describe('combineConsumers', () => {
  test('two modules on the SAME type both fire (no map clobbering)', async () => {
    const seen = [];
    const handlers = combineConsumers(
      { 'planning.progress.reported': () => seen.push('quality') },
      { 'planning.progress.reported': () => seen.push('contracting') },
    );
    const rows = [{ ...EVT, event_id: 'e1', type: 'planning.progress.reported' }];
    const marked = [];
    const pool = {
      query: async (sql, params) => {
        if (/SELECT/.test(sql)) return { rows };
        marked.push(params[0]);
        return { rows: [] };
      },
    };
    await dispatchPending(pool, handlers);
    assert.deepEqual(seen, ['quality', 'contracting']);
    assert.deepEqual(marked, ['e1']);
  });
});

describe('runDispatchTick', () => {
  function tickPool({ locked = true, batches = [[]] } = {}) {
    const log = [];
    let batch = 0;
    // The whole tick — lock, drain, unlock — runs on ONE client (a small
    // pool must never deadlock between the lock holder and the drain).
    const client = {
      query: async (sql) => {
        if (/pg_try_advisory_lock/.test(sql)) { log.push('lock'); return { rows: [{ locked }] }; }
        if (/pg_advisory_unlock/.test(sql)) { log.push('unlock'); return { rows: [] }; }
        if (/SELECT/.test(sql)) return { rows: batches[Math.min(batch++, batches.length - 1)] };
        if (/UPDATE platform\.outbox/.test(sql)) return { rows: [] };
        throw new Error(`unexpected client sql: ${sql}`);
      },
      release: () => log.push('release'),
    };
    return {
      log,
      connect: async () => client,
      query: async (sql) => { throw new Error(`tick must not query the pool directly: ${sql}`); },
    };
  }

  test('skips the tick when another instance holds the lock', async () => {
    const pool = tickPool({ locked: false });
    const n = await runDispatchTick(pool, { contracting: () => { throw new Error('must not run'); } });
    assert.equal(n, 0);
    assert.deepEqual(pool.log, ['lock', 'release']); // no unlock we never held
  });

  test('drains batch by batch until short, then unlocks and releases', async () => {
    const full = Array.from({ length: 2 }, (_, i) => ({ ...EVT, event_id: `f${i}` }));
    const pool = tickPool({ batches: [full, [{ ...EVT, event_id: 'last' }]] });
    const seen = [];
    const n = await runDispatchTick(pool, { contracting: (e) => seen.push(e.event_id) }, { limit: 2 });
    assert.equal(n, 3);
    assert.deepEqual(seen, ['f0', 'f1', 'last']);
    assert.deepEqual(pool.log, ['lock', 'unlock', 'release']);
  });

  test('unlocks even when a consumer throws', async () => {
    const pool = tickPool({ batches: [[{ ...EVT, event_id: 'e1' }]] });
    await assert.rejects(
      runDispatchTick(pool, { contracting: () => { throw new Error('consumer down'); } }),
      /consumer down/,
    );
    assert.deepEqual(pool.log, ['lock', 'unlock', 'release']);
  });
});
