// Regression for the session fail-closed seam (LINA-231 reopen / LINA-57).
//
// The bug this guards: a transient throw in the auth/seat/party chain crashed
// the render into the "record could not be loaded" boundary on a wizard page
// that reads no record. `failClosed` is the seam that turns such a throw into
// the most restrictive session answer instead of a crash.
//
// Run: node --test src/server/  (Node's native TS type-stripping imports the .ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { failClosed } from './fail-closed.ts';

// Silence the intentional error log the helper emits on the throwing path so the
// test output stays clean; assert it is actually called.
function withSilencedError(run) {
  const original = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  return Promise.resolve(run(calls)).finally(() => {
    console.error = original;
  });
}

test('returns the resolved value when the resolver succeeds', async () => {
  const value = await failClosed(async () => ({ kind: 'party' }), { kind: 'anonymous' }, 'test');
  assert.deepEqual(value, { kind: 'party' });
});

test('fails closed to the fallback when the resolver throws', async () => {
  await withSilencedError(async (calls) => {
    const value = await failClosed(
      async () => {
        throw new Error('clerk backend unreachable');
      },
      { kind: 'anonymous' },
      'session',
    );
    assert.deepEqual(value, { kind: 'anonymous' }, 'a throw must not propagate — it fails closed');
    assert.equal(calls.length, 1, 'the failure is logged, never swallowed silently');
    assert.match(String(calls[0][0]), /\[session\] resolution failed/);
  });
});

test('fails closed on a synchronous throw inside the resolver too', async () => {
  await withSilencedError(async () => {
    const value = await failClosed(
      () => {
        throw new Error('getContainer blew up before any await');
      },
      { kind: 'anonymous' },
      'session',
    );
    assert.deepEqual(value, { kind: 'anonymous' });
  });
});
