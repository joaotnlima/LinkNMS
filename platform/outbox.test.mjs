import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateEnvelope, publishEvent, dispatchPending } from './outbox.mjs';

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
