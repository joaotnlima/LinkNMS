// Unit tests for the v2 project-record wire→view transforms (LINA-326, S2).
//
// The rules worth pinning for the record — the product's core promise:
//  • the empty / new-work record has NO baseline (the header states "nothing is
//    agreed yet" off that, never a green badge over an unagreed plan),
//  • every tab is empty and the Money tab's two sums are separate zeros (a price
//    movement is never summed into the contract total — record.ts rule 3),
//  • the actor directory is empty and never invents a name from a participant
//    org id (a participant org id is not a ledger actor id — view.ts rule 2).
//
// Run: node --experimental-strip-types --test src/lib/v2/record-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emptyRecordView, emptyDirectory } from './record-view.ts';

test('emptyRecordView: no baseline — the header, not a badge, says "nothing agreed"', () => {
  const v = emptyRecordView();
  assert.equal(v.baseline, null);
  // state is neutral ("As agreed"); the baseline-null branch is what states the
  // record has no agreement yet, so this never claims an unmade agreement.
  assert.equal(v.state, 'accepted');
});

test('emptyRecordView: every tab is empty', () => {
  const v = emptyRecordView();
  assert.deepEqual(v.tabs.plan.lines, []);
  assert.deepEqual(v.tabs.schedule.lines, []);
  assert.deepEqual(v.tabs.history.events, []);
  assert.deepEqual(v.tabs.money.scopeChanges, []);
  assert.deepEqual(v.tabs.money.priceMovements, []);
});

test('emptyRecordView: Money tab holds two separate zero sums, never a blended total', () => {
  const { money } = emptyRecordView().tabs;
  assert.equal(money.baselineBudgetCents, 0);
  assert.equal(money.currentBudgetCents, 0);
  // The shape carries scope changes and price movements apart — there is no
  // field that adds them, so nothing here can blur the D16 distinction.
  assert.ok(!('total' in money));
  assert.ok(Array.isArray(money.scopeChanges) && Array.isArray(money.priceMovements));
});

test('emptyRecordView: returns a fresh object each call (no shared mutable state)', () => {
  const a = emptyRecordView();
  const b = emptyRecordView();
  assert.notEqual(a, b);
  assert.notEqual(a.tabs.plan.lines, b.tabs.plan.lines);
  a.tabs.plan.lines.push({});
  assert.deepEqual(b.tabs.plan.lines, [], 'one call must not leak into the next');
});

test('emptyDirectory: an empty, independent map — never an invented attribution', () => {
  const d = emptyDirectory();
  assert.ok(d instanceof Map);
  assert.equal(d.size, 0);
  assert.notEqual(emptyDirectory(), emptyDirectory());
  // An unresolved actor id yields undefined here; the page renders it as
  // "Unknown party", never a plausible-looking name (view.ts rule 2).
  assert.equal(d.get('some-actor-id'), undefined);
});
