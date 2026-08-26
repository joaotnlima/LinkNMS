// Adversarial tests for the ledger hash chain (design §9 — the trust anchor gets
// adversarial tests, not just happy path). Run: `node --test services/ledger`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJson,
  computeAppend,
  verifyChain,
  headHash,
  GENESIS_HASH,
  payloadHash,
} from './hash-chain.mjs';

// Build a valid chain of N events the way the append path would.
function buildChain(events) {
  const chain = [];
  let prev = null;
  for (const e of events) {
    const appended = computeAppend(prev, e);
    chain.push(appended);
    prev = appended;
  }
  return chain;
}

const sampleEvents = [
  { type: 'project_created', actorPartyId: 'p1', occurredAt: '2026-08-25T10:00:00.000Z', payload: { name: 'House', baselineBudgetCents: 5000000 } },
  { type: 'decision_recorded', actorPartyId: 'p1', occurredAt: '2026-08-25T10:05:00.000Z', payload: { decisionId: 'd1', title: 'Use oak floors' } },
  { type: 'change_order_proposed', actorPartyId: 'p2', occurredAt: '2026-08-25T10:10:00.000Z', payload: { changeOrderId: 'c1', costDeltaCents: 120000 } },
  { type: 'change_order_approved', actorPartyId: 'p1', occurredAt: '2026-08-25T10:15:00.000Z', payload: { changeOrderId: 'c1', costDeltaCents: 120000 } },
];

test('canonical JSON sorts keys recursively and is order-independent', () => {
  const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":3,"d":2},"b":1}');
});

test('canonical JSON refuses floats (money must be integer cents)', () => {
  assert.throws(() => canonicalJson({ amount: 12.34 }), /integer/);
  assert.throws(() => canonicalJson({ x: Infinity }), /non-finite/);
  assert.throws(() => canonicalJson({ x: undefined }), /undefined/);
});

test('canonical JSON is stable for equal integers regardless of literal form', () => {
  assert.equal(payloadHash(sampleEvents[0]), payloadHash({ ...sampleEvents[0], payload: { baselineBudgetCents: 5e6, name: 'House' } }));
});

test('a well-formed chain verifies, seq is monotonic from 1, genesis is anchored', () => {
  const chain = buildChain(sampleEvents);
  assert.deepEqual(chain.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(chain[0].prevHash, GENESIS_HASH);
  assert.deepEqual(verifyChain(chain), { verified: true });
});

test('tampering with a payload is detected at exactly that seq', () => {
  const chain = buildChain(sampleEvents);
  // Silently change an approved cost delta — the classic "who moved the budget" attack.
  chain[3].payload = { changeOrderId: 'c1', costDeltaCents: 999999 };
  const result = verifyChain(chain);
  assert.equal(result.verified, false);
  assert.equal(result.firstBrokenSeq, 4);
  assert.match(result.reason, /payload/);
});

test('deleting a middle event breaks the chain at the gap', () => {
  const chain = buildChain(sampleEvents);
  chain.splice(1, 1); // drop seq 2; now seq jumps 1 -> 3
  const result = verifyChain(chain);
  assert.equal(result.verified, false);
  assert.equal(result.firstBrokenSeq, 3);
});

test('forging entry_hash without a valid prev link is detected', () => {
  const chain = buildChain(sampleEvents);
  chain[2].entryHash = 'f'.repeat(64);
  const result = verifyChain(chain);
  assert.equal(result.verified, false);
  assert.equal(result.firstBrokenSeq, 3);
});

test('reordering two events breaks the prev_hash link', () => {
  const chain = buildChain(sampleEvents);
  const [a, b] = [chain[1], chain[2]];
  chain[1] = { ...b, seq: 2 };
  chain[2] = { ...a, seq: 3 };
  const result = verifyChain(chain);
  assert.equal(result.verified, false);
  assert.equal(result.firstBrokenSeq, 2);
});

test('deleting the first event (seq 1) is detected — genesis is not a free pass', () => {
  const chain = buildChain(sampleEvents);
  chain.shift();
  const result = verifyChain(chain);
  assert.equal(result.verified, false);
  assert.equal(result.firstBrokenSeq, 2); // remaining head now claims seq 2 at position 0
});

test('an empty chain verifies and its head is genesis', () => {
  assert.deepEqual(verifyChain([]), { verified: true });
  assert.equal(headHash([]), GENESIS_HASH);
});

test('head hash equals the last entry_hash and changes on any append', () => {
  const chain = buildChain(sampleEvents);
  assert.equal(headHash(chain), chain[chain.length - 1].entryHash);
  const longer = buildChain([...sampleEvents, { type: 'decision_revised', actorPartyId: 'p2', occurredAt: '2026-08-25T11:00:00.000Z', payload: { decisionId: 'd1', rev: 2 } }]);
  assert.notEqual(headHash(longer), headHash(chain));
});
